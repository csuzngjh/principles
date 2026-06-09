import type { InternalizationChannel } from '../internalization/peer-runner-contracts.js';
import type {
  ActivationArtifactReadModel,
  ActivationDecision,
  ActivationStateReadModel,
  ApprovalQueueStore,
  CanActivateResult,
  ChannelWriter,
  DispatchInput,
  PIArtifactSnapshot,
  ActivationRiskLevel,
  ApprovalEnqueueInput,
  WriterInput,
  WriterResult,
} from './activation-types.js';
import {
  isLowRiskChannel,
  getChannelRiskLevel,
  makeIdempotencyKey,
} from './activation-types.js';
import { decideAutoPromotion } from './approval-queue.js';
import { extractPrincipleId } from './low-risk-writers.js';

async function checkCanActivate(writer: ChannelWriter, artifact: PIArtifactSnapshot): Promise<{ decision: ActivationDecision | null; result?: CanActivateResult }> {
  try {
    const result = await writer.canActivate(artifact);
    if (!result.ok) {
      return {
        decision: {
          decision: 'refused',
          reason: result.reason ?? 'can_activate_refused',
          riskLevel: result.riskLevel,
          channel: writer.channel,
        },
      };
    }
    return { decision: null, result };
  } catch {
    return { decision: { decision: 'refused', reason: 'can_activate_check_failed', channel: writer.channel } };
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function buildApprovalContext(
  artifact: PIArtifactSnapshot,
  channel: InternalizationChannel,
  riskLevel: ActivationRiskLevel,
  confidence: number | undefined,
): Pick<ApprovalEnqueueInput, 'summary' | 'triggerReason' | 'confidenceExplanation' | 'effectDescription' | 'rejectionEffect'> {
  let principleText = '';
  try {
    const parsed = JSON.parse(artifact.contentJson) as Record<string, unknown>;
    principleText = String(parsed.text ?? parsed.description ?? '');
  } catch { /* best-effort */ }

  const kindLabel = artifact.artifactKind ?? 'artifact';
  const confidencePct = confidence !== undefined ? Math.round(confidence * 100) + '%' : 'unknown';

  const CHANNEL_EFFECTS: Record<string, string> = {
    skill: 'This principle will be activated as a skill that monitors and influences agent behavior in real-time.',
    code_tool_hook: 'This principle will be injected as a code tool hook that intercepts and validates tool calls before execution.',
    model_training: 'This principle will be used as training data for model fine-tuning, affecting future model responses.',
  };

  return {
    summary: principleText
      ? `Activate ${kindLabel}: "${principleText.slice(0, 200)}"`
      : `Activate ${kindLabel} artifact ${artifact.artifactId}`,
    triggerReason: `Rollout reviewer recommended activation via ${channel} channel (risk: ${riskLevel}).`,
    confidenceExplanation: confidence !== undefined
      ? `Confidence score: ${confidencePct}. ` + (confidence >= 0.8 ? 'High confidence based on multiple validations.' : confidence >= 0.5 ? 'Moderate confidence, additional review recommended.' : 'Low confidence, manual review strongly recommended.')
      : 'Confidence score not available.',
    effectDescription: CHANNEL_EFFECTS[channel] ?? `This artifact will be activated via the ${channel} channel.`,
    rejectionEffect: `The artifact will remain inactive and will not be deployed to the ${channel} channel. You can request activation again later.`,
  };
}

export interface DispatcherConfig {
  writers: Iterable<ChannelWriter>;
  approvalQueueStore?: ApprovalQueueStore;
}

export class ActivationDispatcher {
  private readonly writers: Map<InternalizationChannel, ChannelWriter>;
  private readonly approvalQueueStore?: ApprovalQueueStore;

  constructor(
    private readonly artifactReadModel: ActivationArtifactReadModel,
    private readonly stateReadModel: ActivationStateReadModel,
    config: DispatcherConfig,
  ) {
    this.approvalQueueStore = config.approvalQueueStore;
    this.writers = new Map<InternalizationChannel, ChannelWriter>();
    for (const writer of config.writers) {
      this.writers.set(writer.channel, writer);
    }
  }

  async dispatch(input: DispatchInput): Promise<ActivationDecision> {
    const artifactResult = await this.readArtifact(input.artifactId);
    if (artifactResult.decision) return artifactResult.decision;
    const { artifact } = artifactResult;

    if (!artifact.artifactId || typeof artifact.artifactKind !== 'string') {
      return { decision: 'invalid_artifact', reason: 'malformed_artifact' };
    }

    const idempotencyKey = input.idempotencyKey ?? makeIdempotencyKey(input.artifactId, input.channel);

    const existingResult = await this.checkIdempotency(idempotencyKey);
    if (existingResult.decision) return existingResult.decision;

    if (input.rolloutDecision === 'reject') {
      return { decision: 'refused', reason: 'rollout_rejected', channel: input.channel };
    }

    // Auto-promotion bypasses both channel-risk gating AND explicit require_approval from the rollout gate.
    // This is intentional: high-confidence skill artifacts are safe enough to activate without human review.
    const needsApproval = input.rolloutDecision === 'require_approval' || !isLowRiskChannel(input.channel);
    if (needsApproval) {
      if (decideAutoPromotion(input.channel, input.confidence)) {
        return this.activateArtifact(input, artifact, idempotencyKey);
      }
      return this.enqueueForApproval(input, artifact, idempotencyKey);
    }

    return this.activateArtifact(input, artifact, idempotencyKey);
  }

  private async enqueueForApproval(input: DispatchInput, artifact: PIArtifactSnapshot, idempotencyKey: string): Promise<ActivationDecision> {
    const riskLevel = getChannelRiskLevel(input.channel);

    if (!this.approvalQueueStore) {
      return {
        decision: 'refused',
        reason: 'requires_approval',
        channel: input.channel,
        riskLevel,
      };
    }

    const writer = this.writers.get(input.channel);
    if (writer) {
      const canActivateResult = await checkCanActivate(writer, artifact);
      if (canActivateResult.decision) return canActivateResult.decision;
    }

    // Dry-run: preview what would be queued without persisting
    if (!input.confirm) {
      return {
        decision: 'queued_for_approval',
        approvalId: 'apr_' + input.channel + '_' + input.artifactId,
        queuedAt: input.now,
        channel: input.channel,
        riskLevel,
      };
    }

    try {
      const writerContext = writer?.buildApprovalContext?.(
        {
          artifactId: input.artifactId,
          channel: input.channel,
          principleId: extractPrincipleId(artifact) ?? '',
          idempotencyKey: idempotencyKey,
          now: input.now,
        },
        artifact,
        input.confidence,
      );

      const record = await this.approvalQueueStore.enqueue(
        {
          artifactId: input.artifactId,
          channel: input.channel,
          riskLevel,
          confidence: input.confidence,
          ...(writerContext ?? buildApprovalContext(artifact, input.channel, riskLevel, input.confidence)),
        },
        input.now,
      );
      return {
        decision: 'queued_for_approval',
        approvalId: record.approvalId,
        queuedAt: record.requestedAt,
        channel: input.channel,
        riskLevel,
      };
    } catch {
      return { decision: 'refused', reason: 'approval_enqueue_failed', channel: input.channel, riskLevel };
    }
  }

  private async activateArtifact(input: DispatchInput, artifact: PIArtifactSnapshot, idempotencyKey: string): Promise<ActivationDecision> {
    const principleId = extractPrincipleId(artifact);
    if (!principleId) {
      return { decision: 'invalid_artifact', reason: 'no_principle_id' };
    }

    const writer = this.writers.get(input.channel);
    if (!writer) {
      return { decision: 'refused', reason: 'no_writer_for_channel_' + input.channel, channel: input.channel };
    }

    const canActivateResult = await checkCanActivate(writer, artifact);
    if (canActivateResult.decision) return canActivateResult.decision;

    const writerInput: WriterInput = {
      artifactId: input.artifactId,
      channel: input.channel,
      principleId,
      idempotencyKey,
      now: input.now,
    };

     
    let writerResult: WriterResult;
    try {
      writerResult = await writer.activate(writerInput, artifact);
    } catch {
      return { decision: 'refused', reason: 'activation_write_failed', channel: input.channel };
    }

    if (!input.confirm) {
      return {
        decision: 'would_activate',
        activationId: writerResult.activationId,
        action: writerResult.action,
        targetRef: writerResult.targetRef,
      };
    }

    try {
      await this.stateReadModel.recordActivation({
        activationId: writerResult.activationId,
        idempotencyKey,
        artifactId: input.artifactId,
        channel: input.channel,
        action: writerResult.action,
        targetRef: writerResult.targetRef,
        activatedAt: input.now,
        deactivatedAt: null,
      });
    } catch {
      return { decision: 'refused', reason: 'activation_record_failed', channel: input.channel };
    }

    return {
      decision: 'activated',
      activationId: writerResult.activationId,
      action: writerResult.action,
      targetRef: writerResult.targetRef,
    };
  }

  private async readArtifact(artifactId: string): Promise<{ artifact: PIArtifactSnapshot; decision: null } | { artifact: null; decision: ActivationDecision }> {
    try {
      const result = await this.artifactReadModel.getArtifactById(artifactId);
      if (!result) {
        return {
          artifact: null,
          decision: {
            decision: 'invalid_artifact',
            reason: 'artifact_not_found',
            nextAction: 'check_pi_artifacts_table_or_remove_stale_activation',
          },
        };
      }
      return { artifact: result, decision: null };
    } catch {
      return { artifact: null, decision: { decision: 'refused', reason: 'artifact_read_failed' } };
    }
  }

  private async checkIdempotency(idempotencyKey: string): Promise<{ decision: ActivationDecision | null }> {
    try {
      const existing = await this.stateReadModel.getActivationStatus(idempotencyKey);
      if (existing) {
        return {
          decision: {
            decision: 'already_activated',
            activationId: existing.activationId,
            action: existing.action,
            targetRef: existing.targetRef,
          },
        };
      }
      return { decision: null };
    } catch {
      return { decision: { decision: 'refused', reason: 'activation_state_read_failed' } };
    }
  }
}
