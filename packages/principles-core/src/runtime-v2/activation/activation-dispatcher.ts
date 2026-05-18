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
      return this.enqueueForApproval(input, idempotencyKey);
    }

    return this.activateArtifact(input, artifact, idempotencyKey);
  }

  private async enqueueForApproval(input: DispatchInput, _idempotencyKey: string): Promise<ActivationDecision> {
    const riskLevel = getChannelRiskLevel(input.channel);

    if (!this.approvalQueueStore) {
      return {
        decision: 'refused',
        reason: 'requires_approval',
        channel: input.channel,
        riskLevel,
      };
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
      const record = await this.approvalQueueStore.enqueue(
        { artifactId: input.artifactId, channel: input.channel, riskLevel, confidence: input.confidence },
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

    // eslint-disable-next-line @typescript-eslint/init-declarations
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
        return { artifact: null, decision: { decision: 'invalid_artifact', reason: 'artifact_not_found' } };
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
