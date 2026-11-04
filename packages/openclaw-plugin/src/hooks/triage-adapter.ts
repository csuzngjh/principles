/**
 * Triage Adapter — PEAT-B1
 *
 * Plugin-side adapter that maps OpenClaw hook context to evidence triage input.
 * Calls the pure triage policy from principles-core.
 *
 * This file lives in openclaw-plugin because it:
 * - Maps hook-specific context (source strings, session state) to SourceKind
 * - Knows about OpenClaw hook conventions (sessionId, toolName, etc.)
 *
 * PRI-651-B1: hooks are Gate B only — this adapter feeds TriggerController.
 * Gate A (evaluatePainDiagnosticGate) was retired from runtime; its archived
 * plugin adapter and core policy were removed on 2026-10-27. Gate B
 * (TriggerController) is the only admission authority.
 * Core only sees SourceKind and TriageResult.
 *
 * Phase A: the context-driven upgrade flags (unsafe-high-confidence,
 * risky-high-score, repeated-failure) are retired. A descriptor decision is
 * final; technical failures and RuleHost blocks never self-admit as Pain.
 *
 * ERR checklist:
 * - ERR-001: Source kind derived from runtime values with guards, not `as` casts.
 * - ERR-002: Every triage result carries reason + nextAction.
 * - ERR-024/025/048: Production-path tests cover this adapter.
 */

import {
  evaluateTriage,
  type TriageInput,
  type TriageResult,
  type SourceKind,
} from '@principles/core/runtime-v2';

// ── Source Kind Resolution ───────────────────────────────────────────────────

/**
 * Map RawObservation to SourceKind.
 *
 * This is the unified entry point for source-kind classification.
 * It replaces the scattered resolveSourceKindFrom* functions.
 *
 * PRI-360 S1: All source-kind resolution now goes through this single entry point.
 */
export { resolveSourceKind, buildToolFailureObservation, type RawObservation } from './raw-observation-adapter.js';
// All callers should use resolveSourceKind with RawObservation.

// ── Triage Evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate evidence triage for a given source kind and score.
 *
 * This is the main entry point for hooks. It calls the pure triage policy
 * from principles-core and returns the descriptor decision unchanged.
 *
 * PRI-752 reality check: the painEvidenceAdmission flag is NOT consulted by
 * any caller on this path — Gate B admission is unconditional. This doc block
 * previously described a flag check / fallback that does not exist as code.
 */
export function evaluateEvidenceTriage(
  sourceKind: SourceKind,
  score: number,
): TriageResult {
  const input: TriageInput = { sourceKind, score };
  return evaluateTriage(input);
}
