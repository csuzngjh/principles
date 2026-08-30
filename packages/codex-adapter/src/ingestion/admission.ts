/**
 * Codex governance admission orchestration (Codex Governance Closure Slice B,
 * PRI-623; SPEC §12/§13).
 *
 * Owns ONLY the Codex facts: mapping live hook payloads and decoded transcript
 * observations onto the host-neutral admission candidates of
 * `@principles/host-runtime` (`admitGovernanceSignals`), then driving the
 * admitted pains through the existing continuation seams —
 * `ensureGovernanceDiagnosticianTask` (Runtime V2 async enqueue, never an
 * LLM) and `promoteAdmittedGovernanceEvidence` (Slice A's ≤12 + trigger +
 * next-assistant window with its durable pending tail).
 *
 * No Codex JSONL knowledge crosses into host-runtime; no second pain or task
 * authority exists here.
 */
import {
  admitGovernanceSignals,
  ensureGovernanceDiagnosticianTask,
  promoteAdmittedGovernanceEvidence,
  type GovernanceSignalCandidate,
} from '@principles/host-runtime';
import type { GovernanceObservationInput } from '@principles/host-runtime';
import type { PayloadFields } from './ingestion-fields.js';
import { isRecord, own } from './ingestion-fields.js';

/** The live host-event source used by the identity derivation (parity with the dispatch handler). */
const CODEX_POST_TOOL_USE_SOURCE = 'codex:post_tool_use';

export interface GovernanceAdmissionDegradation {
  readonly reason: string;
  readonly nextAction: string;
}

export interface GovernanceAdmissionRun {
  /** Bounded structured degradations (only real failures; duplicate / rate-limited / ordinary conversation are normal outcomes and stay silent, SPEC §20/§21). */
  readonly degradations: readonly GovernanceAdmissionDegradation[];
}

/** Live UserPromptSubmit payload → correction candidate (logical key mirrors the observation). */
export function buildLiveCorrectionCandidate(args: {
  fields: PayloadFields;
  rolloutIdentity: string;
}): GovernanceSignalCandidate | null {
  const { fields } = args;
  if (fields.turnId === null || fields.prompt === null) return null;
  return {
    kind: 'user_correction',
    hostKind: 'codex',
    logicalObservationKey: `codex|${args.rolloutIdentity}|${fields.turnId}|user`,
    rolloutIdentity: args.rolloutIdentity,
    rootSessionId: fields.sessionId,
    hostTurnId: fields.turnId,
    text: fields.prompt,
    observedAt: new Date().toISOString(),
  };
}

/** Live PostToolUse payload → tool-failure candidate (logical key mirrors the observation). */
export function buildLiveToolCandidate(args: {
  fields: PayloadFields;
  rolloutIdentity: string;
}): GovernanceSignalCandidate | null {
  const { fields } = args;
  if (fields.turnId === null || fields.toolUseId === null) return null;
  return {
    kind: 'tool_failure',
    hostKind: 'codex',
    logicalObservationKey: `codex|${args.rolloutIdentity}|${fields.toolUseId}`,
    rolloutIdentity: args.rolloutIdentity,
    rootSessionId: fields.sessionId,
    hostTurnId: fields.turnId,
    toolName: fields.toolName ?? '',
    source: CODEX_POST_TOOL_USE_SOURCE,
    ...(fields.toolInput !== undefined ? { toolInput: fields.toolInput } : {}),
    ...(fields.toolResponse !== undefined ? { toolOutput: fields.toolResponse } : {}),
    observedAt: new Date().toISOString(),
  };
}

/**
 * Decoded transcript observations → candidates. User turns carry visibleText;
 * tool calls carry the CommandExecution facts projection. The logical keys are
 * the decoded ones, so a replay of an already-admitted live event is an
 * observation-level no-op (SPEC §10).
 */
export function buildTranscriptCandidates(observations: readonly GovernanceObservationInput[]): readonly GovernanceSignalCandidate[] {
  const candidates: GovernanceSignalCandidate[] = [];
  for (const observation of observations) {
    if (observation.kind === 'user_turn') {
      if (observation.visibleText === undefined) continue;
      candidates.push({
        kind: 'user_correction',
        hostKind: 'codex',
        logicalObservationKey: observation.logicalObservationKey,
        rolloutIdentity: observation.rolloutIdentity,
        rootSessionId: observation.rootSessionId,
        hostTurnId: observation.hostTurnId,
        text: observation.visibleText,
        observedAt: observation.observedAt,
      });
    } else if (observation.kind === 'tool_call') {
      const facts = observation.toolFacts;
      if (!isRecord(facts)) continue;
      const toolName = own(facts, 'toolName');
      const exitCode = own(facts, 'exitCode');
      candidates.push({
        kind: 'tool_failure',
        hostKind: 'codex',
        logicalObservationKey: observation.logicalObservationKey,
        rolloutIdentity: observation.rolloutIdentity,
        rootSessionId: observation.rootSessionId,
        hostTurnId: observation.hostTurnId,
        toolName: typeof toolName === 'string' ? toolName : '',
        source: CODEX_POST_TOOL_USE_SOURCE,
        toolInput: own(facts, 'command') ?? null,
        ...(exitCode !== undefined ? { toolOutput: { exitCode, stdout: own(facts, 'stdout') ?? null, stderr: own(facts, 'stderr') ?? null } } : {}),
        observedAt: observation.observedAt,
      });
    }
  }
  return candidates;
}

/**
 * Run admission for the given candidates and drive every admitted pain
 * through task-ensure + evidence promotion. Exactly-once is owned by the
 * host-runtime seams; this orchestrator only sequences them and surfaces
 * bounded degradations (duplicate / rate-limited / ordinary conversation are
 * normal outcomes and produce no noise, SPEC §20/§21).
 */
export async function runGovernanceAdmission(args: {
  workspaceDir: string;
  candidates: readonly GovernanceSignalCandidate[];
  rolloutIdentity: string;
}): Promise<GovernanceAdmissionRun> {
  const { workspaceDir, candidates, rolloutIdentity } = args;
  if (candidates.length === 0) return { degradations: [] };
  const degradations: GovernanceAdmissionDegradation[] = [];
  const push = (reason: string, nextAction: string): void => {
    if (degradations.length < 4) degradations.push({ reason: reason.slice(0, 300), nextAction: nextAction.slice(0, 300) });
  };

  const admitted = admitGovernanceSignals({ workspaceDir, candidates });
  if (!admitted.ok) {
    push(admitted.reason, admitted.nextAction);
    return { degradations };
  }

  for (const outcome of admitted.outcomes) {
    if (!('disposition' in outcome)) continue;
    if (outcome.disposition === 'already_admitted' && outcome.diagnosticianTaskId === null) {
      // Crash window (marker committed, task ensure lost): heal at delivery
      // time instead of waiting for reconciliation.
      const healed = await ensureGovernanceDiagnosticianTask({
        workspaceDir,
        logicalObservationKey: outcome.logicalObservationKey,
        canonicalPainId: outcome.canonicalPainId,
      });
      if (!healed.ok) push(healed.reason, healed.nextAction);
      continue;
    }
    if (outcome.disposition !== 'admitted') continue;
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: outcome.logicalObservationKey,
      canonicalPainId: outcome.canonicalPainId,
    });
    if (!ensured.ok) {
      push(ensured.reason, ensured.nextAction);
      continue;
    }
    const promoted = promoteAdmittedGovernanceEvidence({
      workspaceDir,
      rolloutIdentity,
      triggerLogicalKey: outcome.logicalObservationKey,
      canonicalPainId: outcome.canonicalPainId,
    });
    if (!promoted.ok && promoted.reason !== 'rollout_not_found' && promoted.reason !== 'trigger_not_found') {
      push(promoted.reason, promoted.nextAction);
    }
  }
  return { degradations };
}
