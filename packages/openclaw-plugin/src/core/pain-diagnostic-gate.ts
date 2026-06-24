/**
 * Pain Diagnostic Gate — PRI-446 thin adapter
 *
 * @deprecated PRI-454 — Gate A (PainDiagnosticGate) is superseded by Gate B
 * (TriggerController + EvidenceTriage). This module remains as the rollback
 * path when `painEvidenceAdmission` or `painEvidenceAdmissionDefault` flags
 * are OFF. Do not add new callers. New admission logic must use
 * `evaluateTriggerController` from runtime-v2/evidence-triage.
 *
 * Disposition: Archive (do not delete) per PRI-454 plan step 6.
 * Removal conditions: Both flags confirmed ON in production for 30 days,
 * and all 5 MVP paths verified on Gate B. See
 * docs/plans/2026-06-pain-evidence-admission-track.md.
 *
 * The pure decision logic (threshold tree, cooldown comparison, episode-key
 * construction) now lives in principles-core
 * (runtime-v2/pain-gate/pain-diagnostic-gate-policy.ts). This file is the
 * stateful adapter that owns:
 *   - the cooldown Map (lastDiagnosedAtByEpisode)
 *   - Date.now() injection
 *   - SystemLogger for unknown-source telemetry
 *
 * It preserves the original export names (evaluatePainDiagnosticGate,
 * isCooldownActiveForEpisode, resetPainDiagnosticGateForTest) so all 5 callers
 * (gate-block-helper, llm, pain, prompt x2) and the characterization test keep
 * working unchanged.
 *
 * ERR checklist:
 * - ERR-011: this is a stateful adapter delegating to core pure logic.
 */

import { SystemLogger } from './system-logger.js';
import {
  evaluatePainDiagnosticGateDecision,
  normalizedSource,
  buildEpisodeKey,
  isCooldownActive as isCooldownActiveCore,
  type PainDiagnosticSource,
  type PainDiagnosticGateReason,
  type PainDiagnosticGateInput,
  type PainDiagnosticGateDecision,
} from '@principles/core/runtime-v2';

// Re-export types so existing type imports keep working.
export type {
  PainDiagnosticSource,
  PainDiagnosticGateReason,
  PainDiagnosticGateInput,
  PainDiagnosticGateDecision,
};

// Module-level cooldown state — owned by this adapter (core is stateless).
const lastDiagnosedAtByEpisode = new Map<string, number>();

export function resetPainDiagnosticGateForTest(): void {
  lastDiagnosedAtByEpisode.clear();
}

/**
 * Check whether cooldown is currently active for a given episode.
 * Used by the trigger controller (PEAT-B2) to align its cooldown decision
 * with the PainDiagnosticGate's cooldown state.
 */
export function isCooldownActiveForEpisode(
  source: string,
  sessionId: string | undefined,
  errorHash: string | undefined,
  cooldownMs?: number,
): boolean {
  const episodeKey = buildEpisodeKey({ source, sessionId, errorHash, score: 0, currentGfi: 0 });
  const last = lastDiagnosedAtByEpisode.get(episodeKey);
  const nowMs = Date.now();
  return isCooldownActiveCore({ source, sessionId, errorHash, cooldownMs, nowMs, lastDiagnosedAtMs: last });
}

/**
 * Evaluate the pain diagnostic gate. Delegates the pure decision to core and,
 * when the decision is to diagnose, records the current time against the
 * episode so subsequent calls within the cooldown window are suppressed.
 */
export function evaluatePainDiagnosticGate(input: PainDiagnosticGateInput): PainDiagnosticGateDecision {
  // Surface unknown sources via telemetry (core cannot log).
  const { unknown } = normalizedSource(input.source);
  if (unknown) {
    SystemLogger.log('', 'GATE_UNKNOWN_SOURCE', `Unknown pain source: "${input.source}"`);
  }

  const episodeKey = buildEpisodeKey(input);
  const last = lastDiagnosedAtByEpisode.get(episodeKey);
  const nowMs = input.nowMs ?? Date.now();

  const decision = evaluatePainDiagnosticGateDecision({ ...input, nowMs }, last);

  // Record the diagnosis time when approved (matches prior markDiagnosed behavior).
  if (decision.shouldDiagnose) {
    lastDiagnosedAtByEpisode.set(episodeKey, nowMs);
  }

  return decision;
}
