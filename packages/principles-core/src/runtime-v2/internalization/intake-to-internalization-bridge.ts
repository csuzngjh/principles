import type { InternalizationChannel } from './peer-runner-contracts.js';
import type { InternalizationRouteKind } from './internalization-route.js';
import type { CandidateRecord } from '../store/candidate/candidate-store.js';
import { PI_METADATA_KEY } from './pitask-metadata.js';

export interface IntakeToInternalizationBridgeInput {
  candidateId: string;
  recommendationKind: string;
  route: InternalizationRouteKind;
  ready: boolean;
  sourcePainId?: string;
  workspaceDir?: string;
  now?: string;
  /** Diagnostician task ID that produced this candidate (lineage). */
  sourceTaskId?: string;
  /** Artifact ID of the diagnostician artifact (lineage). */
  sourceArtifactId?: string;
  /** Run ID of the diagnostician execution (lineage). */
  sourceRunId?: string;
}

export type BridgeDecision =
  | { decision: 'seeded'; taskId: string; taskKind: 'dreamer'; channel: InternalizationChannel }
  | { decision: 'already_exists'; taskId: string }
  | { decision: 'not_internalizable'; reason: string }
  | { decision: 'invalid_candidate'; reason: string };

export const MVP_ENABLED_CHANNELS: ReadonlySet<InternalizationChannel> = new Set<InternalizationChannel>([
  'prompt',
  'code_tool_hook',
  'defer_archive',
]);

export const CANDIDATE_KIND_TO_ROUTE: Record<string, InternalizationRouteKind> = {
  principle: 'principle-ledger',
  rule: 'rule-candidate',
  implementation: 'implementation-candidate',
  prompt: 'prompt-injection-candidate',
  defer: 'deferred',
};

export const ROUTE_CHANNEL_MAP: Record<string, InternalizationChannel> = {
  'principle-ledger': 'prompt',
  'rule-candidate': 'code_tool_hook',
  'implementation-candidate': 'skill',
  'prompt-injection-candidate': 'prompt',
};

export function computeBridgeDecision(
  input: IntakeToInternalizationBridgeInput,
): BridgeDecision {
  if (!input.candidateId || input.candidateId.trim() === '') {
    return { decision: 'invalid_candidate', reason: 'candidateId must be a non-empty string' };
  }

  // PRI-355: Prevent recursive concatenation — reject candidateIds that look like taskIds
  if (/^(dreamer|pi-art|scribe|philosopher)[-_]/.test(input.candidateId)) {
    return { decision: 'invalid_candidate', reason: 'candidateId_looks_like_taskId_not_candidateId' };
  }

  // PRI-355: Reject excessively long candidateIds (normal UUID is 36 chars)
  if (input.candidateId.length > 200) {
    return { decision: 'invalid_candidate', reason: 'candidateId_too_long' };
  }

  if (!input.ready) {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" is not ready — missing required fields` };
  }

  if (input.route === 'deferred') {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" is deferred — no internalization action required` };
  }

  const channel = ROUTE_CHANNEL_MAP[input.route];
  if (!channel) {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" has no channel mapping — not internalizable` };
  }

  if (!MVP_ENABLED_CHANNELS.has(channel)) {
    return { decision: 'not_internalizable', reason: `Channel "${channel}" for route "${input.route}" is MVP-disabled — not internalizable in current stage` };
  }

  const taskId = `dreamer-${input.candidateId}-${channel}`;
  return { decision: 'seeded', taskId, taskKind: 'dreamer', channel };
}

export interface BridgeTaskSeed {
  taskId: string;
  taskKind: 'dreamer';
  channel: InternalizationChannel;
  diagnosticJson: string;
  status: 'pending';
  attemptCount: number;
  maxAttempts: number;
}

export function buildDreamerTaskSeed(
  input: IntakeToInternalizationBridgeInput,
): BridgeTaskSeed | BridgeDecision {
  const decision = computeBridgeDecision(input);
  if (decision.decision !== 'seeded') {
    return decision;
  }

  // Build inputArtifactRefs: always include the candidate itself
  const inputArtifactRefs: { artifactType: string; ref: string }[] = [
    { artifactType: 'candidate', ref: `candidate://${input.candidateId}` },
  ];
  // If we have the diagnostician artifact, include it for lineage traceability
  if (input.sourceArtifactId && input.sourceArtifactId.trim() !== '') {
    inputArtifactRefs.push({
      artifactType: 'diagnostician_output',
      ref: `artifact://${input.sourceArtifactId}`,
    });
  }

  // Build dependencyTaskIds from sourceTaskId (the diagnostician task)
  const dependencyTaskIds: string[] = [];
  if (input.sourceTaskId && input.sourceTaskId.trim() !== '') {
    dependencyTaskIds.push(input.sourceTaskId);
  }

  // Build diagnosticJson as a single object — no parse round-trip
  const finalDiagnosticJson = JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds,
      channel: decision.channel,
      timeoutMs: 300_000,
      inputArtifactRefs,
      outputArtifactRefs: [],
      parentTaskId: undefined,
      correlationId: input.candidateId,
    },
    candidateId: input.candidateId,
    ...(input.sourcePainId?.trim() ? { sourcePainId: input.sourcePainId.trim() } : {}),
    ...(input.sourceTaskId?.trim() ? { sourceTaskId: input.sourceTaskId.trim() } : {}),
    ...(input.sourceArtifactId?.trim() ? { sourceArtifactId: input.sourceArtifactId.trim() } : {}),
    ...(input.sourceRunId?.trim() ? { sourceRunId: input.sourceRunId.trim() } : {}),
  });

  return {
    taskId: decision.taskId,
    taskKind: 'dreamer',
    channel: decision.channel,
    diagnosticJson: finalDiagnosticJson,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
  };
}

/**
 * Build a dreamer task seed from a CandidateRecord, preserving diagnostician lineage.
 *
 * Extracts sourceTaskId, sourceArtifactId, and sourceRunId from the candidate record
 * so the resulting dreamer task carries real dependencyTaskIds and inputArtifactRefs
 * instead of empty lineage and weak candidate:// refs.
 *
 * This is the preferred factory for candidate→dreamer seeding. New production
 * entrypoints should call this rather than hand-building the bridge input.
 * The optional sourcePainId is for callers that already have a painId in scope
 * (e.g. PainSignalBridge).
 */
export interface BuildDreamerSeedFromCandidateOptions {
  route: InternalizationRouteKind;
  ready: boolean;
  sourcePainId?: string;
}

export function buildDreamerSeedFromCandidate(
  candidate: CandidateRecord,
  options: BuildDreamerSeedFromCandidateOptions,
): BridgeTaskSeed | BridgeDecision {
  const { route, ready, sourcePainId } = options;

  // PRI-395: Fail loud when all lineage fields are empty — an empty seed
  // provides no traceability and indicates the candidate lacks diagnostician lineage.
  const lineageFields = [
    candidate.taskId?.trim(),
    candidate.artifactId?.trim(),
    candidate.sourceRunId?.trim(),
  ];
  if (lineageFields.every(f => !f)) {
    return {
      decision: 'invalid_candidate',
      reason: `Candidate ${candidate.candidateId} has no diagnostician lineage (taskId, artifactId, sourceRunId all empty/blank)`,
    };
  }

  return buildDreamerTaskSeed({
    candidateId: candidate.candidateId,
    recommendationKind: candidate.recommendationKind ?? 'unknown',
    route,
    ready,
    sourcePainId,
    sourceTaskId: candidate.taskId?.trim() || undefined,
    sourceArtifactId: candidate.artifactId?.trim() || undefined,
    sourceRunId: candidate.sourceRunId?.trim() || undefined,
  });
}

export interface BridgeTaskStore {
  getTask(taskId: string): Promise<{ taskId: string } | null>;
  createTask(input: {
    taskId: string;
    taskKind: string;
    status: 'pending';
    attemptCount: number;
    maxAttempts: number;
    diagnosticJson: string;
  }): Promise<{ taskId: string }>;
}

export async function seedIntakeTask(
  input: IntakeToInternalizationBridgeInput,
  store: BridgeTaskStore,
): Promise<BridgeDecision> {
  const decision = computeBridgeDecision(input);
  if (decision.decision !== 'seeded') {
    return decision;
  }

  const existing = await store.getTask(decision.taskId);
  if (existing) {
    return { decision: 'already_exists', taskId: existing.taskId };
  }

  const seed = buildDreamerTaskSeed(input);
  // eslint-disable-next-line no-restricted-syntax -- 'in' required for discriminated union narrowing (BridgeTaskSeed | BridgeDecision)
  if ('decision' in seed) {
    return seed;
  }

  try {
    await store.createTask({
      taskId: seed.taskId,
      taskKind: seed.taskKind,
      status: seed.status,
      attemptCount: seed.attemptCount,
      maxAttempts: seed.maxAttempts,
      diagnosticJson: seed.diagnosticJson,
    });
  } catch (error) {
    const concurrent = await store.getTask(seed.taskId);
    if (concurrent) {
      return { decision: 'already_exists', taskId: concurrent.taskId };
    }
    throw error;
  }

  return decision;
}
