/**
 * Pain Gate — PRI-446
 *
 * Pure pain-diagnostic gate decision logic (cooldown + threshold tree).
 * No I/O, no plugin imports. The plugin adapter owns the cooldown Map and
 * injects time/state into these pure functions.
 */

export type {
  PainDiagnosticSource,
  PainDiagnosticGateReason,
  PainDiagnosticGateInput,
  PainDiagnosticGateDecision,
  CooldownCheckInput,
} from './pain-diagnostic-gate-policy.js';

export {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PAIN_TRIGGER,
  DEFAULT_HIGH_SEVERITY,
  DEFAULT_REPEATED_FAILURE,
  DEFAULT_SEMANTIC_PAIN_FLOOR,
  normalizedSource,
  buildEpisodeKey,
  evaluatePainDiagnosticGateDecision,
  isCooldownActive,
} from './pain-diagnostic-gate-policy.js';
