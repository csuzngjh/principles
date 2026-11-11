/**
 * Codex governance admission orchestration (Codex Governance Closure Slice B,
 * PRI-623; SPEC §12/§13).
 *
 * Owns ONLY the Codex facts: mapping live hook payloads and decoded transcript
 * observations onto the host-neutral admission candidates of
 * `@principles/host-runtime` (`admitGovernanceSignals`), then driving the
 * admitted pains through the existing continuation seams —
 * `ensureGovernanceDiagnosticianTask` (Runtime async enqueue, never an
 * LLM) and `promoteAdmittedGovernanceEvidence` (Slice A's ≤12 + trigger +
 * next-assistant window with its durable pending tail).
 *
 * No Codex JSONL knowledge crosses into host-runtime; no second pain or task
 * authority exists here.
 */
import {
  admitGovernanceSignals,
  ensureGovernanceContinuation,
  type GovernanceSignalCandidate,
} from '@principles/host-runtime';
import type { GovernanceObservationInput } from '@principles/host-runtime';
import type { PayloadFields } from './ingestion-fields.js';

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

/**
 * Decoded transcript observations → candidates. Only user turns produce
 * candidates: tool-call observations remain technical trajectory (recorded by
 * the workflow's own writers), never a behavioral-deviation Pain by themselves.
 * The logical keys are the decoded ones, so a replay of an already-admitted
 * live event is an observation-level no-op (SPEC §10).
 */
export function buildTranscriptCandidates(observations: readonly GovernanceObservationInput[]): readonly GovernanceSignalCandidate[] {
  const candidates: GovernanceSignalCandidate[] = [];
  for (const observation of observations) {
    if (observation.kind !== 'user_turn') continue;
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
}): Promise<GovernanceAdmissionRun> {
  const { workspaceDir, candidates } = args;
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
    if (outcome.disposition !== 'admitted' && outcome.disposition !== 'already_admitted') continue;
    const cont = await ensureGovernanceContinuation({
      workspaceDir,
      logicalObservationKey: outcome.logicalObservationKey,
      canonicalPainId: outcome.canonicalPainId,
      codexConversationIngestionEnabled: true,
      // Legacy alias: an older installed host-runtime reads only this name.
      conversationIngestionEnabled: true,
    });
    if (!cont.ok) {
      push(cont.reason, cont.nextAction);
    }
  }
  return { degradations };
}
