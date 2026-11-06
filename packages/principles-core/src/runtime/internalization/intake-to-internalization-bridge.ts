import type { InternalizationChannel, PipelineTopologyMode } from './peer-runner-contracts.js';
import { INTERNALIZATION_CHANNELS } from './peer-runner-contracts.js';
import type { InternalizationRouteKind } from './internalization-route.js';
import type { CandidateRecord } from '../store/candidate/candidate-store.js';
import { PI_METADATA_KEY } from './pitask-metadata.js';

/**
 * PRI-720 C6: all deterministic dreamer task ids for one candidate across
 * channels. Seed dedup MUST check all of them — the C6 demotion changes the
 * channel suffix of the derived id, so taskId-equality alone would miss a
 * chain already seeded under the pre-demotion id (double-seed →
 * double-activation of the same candidate).
 */
export function dreamerTaskIdsForCandidate(candidateId: string): string[] {
  return INTERNALIZATION_CHANNELS.map((channel) => `dreamer-${candidateId}-${channel}`);
}

/**
 * PRI-720 C6: candidate-level seed dedup — finds an existing dreamer task for
 * this candidate under ANY channel suffix (the demotion changes the derived
 * id's channel, so exact-id lookups would miss pre-demotion chains).
 */
export async function findExistingDreamerTask<T extends { taskId: string }>(
  getTask: (taskId: string) => Promise<T | null>,
  candidateId: string,
): Promise<T | null> {
  for (const taskId of dreamerTaskIdsForCandidate(candidateId)) {
    const found = await getTask(taskId);
    if (found) return found;
  }
  return null;
}

export interface IntakeToInternalizationBridgeInput {
  candidateId: string;
  recommendationKind: string;
  route: InternalizationRouteKind;
  ready: boolean;
  sourcePainId?: string;
  workspaceDir?: string;
  now?: string;
  /**
   * PRI-720: topology mode for the seeded chain. Hosts resolve this from the
   * `prompt_full_pipeline` feature flag (or explicit operator/lab options) at
   * seed time. The seed ALWAYS serializes the resolved mode explicitly
   * ('standard' when absent here), so field absence on a record identifies a
   * pre-PRI-720 legacy chain (full-chain topology, AC12).
   */
  pipelineMode?: PipelineTopologyMode;
  /**
   * PRI-720 C6: parsed diagnostician recommendation content (the candidate's
   * `sourceRecommendationJson`). Optional for backward compatibility — when
   * absent, rule-candidate routes keep the pre-existing behavior. When
   * present, a rule recommendation WITHOUT complete mechanical trigger
   * evidence (triggerPattern + observable action) is demoted to the prompt
   * channel instead of entering the RuleCode sub-chain (deterministic field
   * check — never an LLM judgment).
   */
  recommendation?: unknown;
  /** Diagnostician task ID that produced this candidate (lineage). */
  sourceTaskId?: string;
  /** Artifact ID of the diagnostician artifact (lineage). */
  sourceArtifactId?: string;
  /** Run ID of the diagnostician execution (lineage). */
  sourceRunId?: string;
}

export type BridgeDecision =
  | {
    decision: 'seeded';
    taskId: string;
    taskKind: 'dreamer';
    channel: InternalizationChannel;
    /** PRI-720 C6: present when a rule candidate without mechanical evidence was demoted to prompt. */
    demotedFromChannel?: InternalizationChannel;
  }
  | { decision: 'already_exists'; taskId: string }
  | { decision: 'not_internalizable'; reason: string }
  | { decision: 'invalid_candidate'; reason: string };

/**
 * PRI-720 C6 admission discipline: a rule recommendation may only enter the
 * code_tool_hook channel when it carries COMPLETE mechanical trigger evidence
 * — an observable triggerPattern and an observable action declaration.
 * Deterministic field checks only (rc-1/rc-3); no LLM judgment. Cognitive
 * behavioral principles without this evidence are prompt-channel material.
 *
 * Evidence shapes accepted (asymmetry hardening, review 2026-09-15): the
 * recommendation object itself, a `{ recommendation: {...} }` envelope, and
 * snake_case column-style keys (trigger_pattern/action) matching the
 * candidate-intake readiness fallback.
 */
function hasMechanicalEvidenceShape(recommendation: unknown): boolean {
  if (typeof recommendation !== 'object' || recommendation === null) return false;
  const r = recommendation as Record<string, unknown>;
  const trigger = Reflect.get(r, 'triggerPattern') ?? Reflect.get(r, 'trigger_pattern');
  const action = Reflect.get(r, 'action');
  return typeof trigger === 'string' && trigger.trim() !== ''
    && typeof action === 'string' && action.trim() !== '';
}

export function hasRuleMechanicalEvidence(recommendation: unknown): boolean {
  if (hasMechanicalEvidenceShape(recommendation)) return true;
  if (typeof recommendation !== 'object' || recommendation === null) return false;
  return hasMechanicalEvidenceShape(Reflect.get(recommendation, 'recommendation'));
}

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

  const channel = ROUTE_CHANNEL_MAP[input.route];
  if (!channel) {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" has no channel mapping — not internalizable` };
  }

  if (!MVP_ENABLED_CHANNELS.has(channel)) {
    return { decision: 'not_internalizable', reason: `Channel "${channel}" for route "${input.route}" is MVP-disabled — not internalizable in current stage` };
  }

  // PRI-720 C6 (P1 fix, Owner review 2026-09-15): the demotion runs BEFORE the
  // ready gate and is the SINGLE admission authority for rule candidates —
  // every entry (candidate CLI via decideInternalizationRoute's ready, pain
  // bridge / diagnose via route-mapped ready) converges here, so the same
  // recommendation gets the same channel from every path. A rule candidate
  // without complete mechanical trigger evidence is demoted to the prompt
  // channel (principle semantic path); on the prompt channel the
  // rule-specific readiness fields (triggerPattern/action) no longer apply,
  // so a route-layer ready=false for exactly those fields must not pre-empt
  // the demotion.
  let effectiveChannel = channel;
  let demotedFromChannel: InternalizationChannel | undefined;
  if (input.route === 'rule-candidate' && !hasRuleMechanicalEvidence(input.recommendation)) {
    demotedFromChannel = channel;
    effectiveChannel = 'prompt';
  }

  if (!input.ready && demotedFromChannel === undefined) {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" is not ready — missing required fields` };
  }

  if (input.route === 'deferred') {
    return { decision: 'not_internalizable', reason: `Route "${input.route}" is deferred — no internalization action required` };
  }

  const taskId = `dreamer-${input.candidateId}-${effectiveChannel}`;
  return {
    decision: 'seeded',
    taskId,
    taskKind: 'dreamer',
    channel: effectiveChannel,
    ...(demotedFromChannel !== undefined ? { demotedFromChannel } : {}),
  };
}

export interface BridgeTaskSeed {
  taskId: string;
  taskKind: 'dreamer';
  channel: InternalizationChannel;
  /** PRI-720: explicit topology mode written on every new seed ('standard' | 'full_chain'). */
  pipelineMode?: PipelineTopologyMode;
  /** PRI-720 C6: present when a rule candidate was demoted to prompt (no mechanical evidence). */
  demotedFromChannel?: InternalizationChannel;
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
  // PRI-720 P1 fix (Owner review): new seeds ALWAYS write the topology mode
  // explicitly ('standard' or 'full_chain'); field ABSENCE unambiguously
  // identifies a pre-PRI-720 record, which keeps legacy full-chain topology
  // (AC12 — no mid-flight reinterpretation).
  const seedPipelineMode: PipelineTopologyMode = input.pipelineMode === 'full_chain' ? 'full_chain' : 'standard';
  const finalDiagnosticJson = JSON.stringify({
    [PI_METADATA_KEY]: {
      dependencyTaskIds,
      channel: decision.channel,
      pipelineMode: seedPipelineMode,
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
    pipelineMode: seedPipelineMode,
    ...(decision.decision === 'seeded' && decision.demotedFromChannel !== undefined
      ? { demotedFromChannel: decision.demotedFromChannel }
      : {}),
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
  /** PRI-720: seed-time topology mode (see IntakeToInternalizationBridgeInput.pipelineMode). */
  pipelineMode?: PipelineTopologyMode;
}

export function buildDreamerSeedFromCandidate(
  candidate: CandidateRecord,
  options: BuildDreamerSeedFromCandidateOptions,
): BridgeTaskSeed | BridgeDecision {
  const { route, ready, sourcePainId, pipelineMode } = options;

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

  // PRI-720 C6: surface the recommendation content for the deterministic
  // code-channel admission check. Unparseable JSON = no evidence (demote).
  let recommendation: unknown;
  try {
    recommendation = JSON.parse(candidate.sourceRecommendationJson) as unknown;
  } catch {
    recommendation = undefined;
  }

  return buildDreamerTaskSeed({
    candidateId: candidate.candidateId,
    recommendationKind: candidate.recommendationKind ?? 'unknown',
    route,
    ready,
    sourcePainId,
    pipelineMode,
    recommendation,
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
