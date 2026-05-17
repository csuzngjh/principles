import type { InternalizationChannel } from '../internalization/peer-runner-contracts.js';
import type {
  ActivationArtifactReadModel,
  ActivationDecision,
  ActivationStateReadModel,
  CanActivateResult,
  ChannelWriter,
  DispatchInput,
  PIArtifactSnapshot,
  WriterInput,
} from './activation-types.js';
import {
  isLowRiskChannel,
  getChannelRiskLevel,
  makeIdempotencyKey,
} from './activation-types.js';
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

export class ActivationDispatcher {
  private readonly writers: Map<InternalizationChannel, ChannelWriter>;

  constructor(
    private readonly artifactReadModel: ActivationArtifactReadModel,
    private readonly stateReadModel: ActivationStateReadModel,
    writers: Iterable<ChannelWriter>,
  ) {
    this.writers = new Map<InternalizationChannel, ChannelWriter>();
    for (const writer of writers) {
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

    if (input.rolloutDecision === 'require_approval') {
      return { decision: 'refused', reason: 'requires_approval', channel: input.channel, riskLevel: getChannelRiskLevel(input.channel) };
    }

    if (!isLowRiskChannel(input.channel)) {
      return {
        decision: 'refused',
        reason: `high_risk_channel_${input.channel}`,
        riskLevel: getChannelRiskLevel(input.channel),
        channel: input.channel,
      };
    }

    const principleId = extractPrincipleId(artifact);
    if (!principleId) {
      return { decision: 'invalid_artifact', reason: 'no_principle_id' };
    }

    const writer = this.writers.get(input.channel);
    if (!writer) {
      return { decision: 'refused', reason: `no_writer_for_channel_${input.channel}`, channel: input.channel };
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

    if (!input.confirm) {
      const writerResult = await writer.activate(writerInput, artifact);
      return {
        decision: 'would_activate',
        activationId: writerResult.activationId,
        action: writerResult.action,
        targetRef: writerResult.targetRef,
      };
    }

    const writerResult = await writer.activate(writerInput, artifact);

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
