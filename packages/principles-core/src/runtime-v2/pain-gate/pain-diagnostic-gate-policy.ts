/**
 * Pain Diagnostic Gate Policy — PRI-446 (migrated from the plugin adapter)
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
 * Pure decision logic for pain-diagnostic cooldown and gate evaluation.
 *
 * This module is the single source of truth for the gate's threshold decision
 * tree. It is fully pure: no I/O, no Date.now(), no module-level mutable state.
 * All time and cooldown state is passed in as parameters. The plugin-side
 * pain-diagnostic-gate.ts is now a thin adapter that owns the cooldown Map and
 * feeds Date.now() / the last-diagnosed timestamp into this function.
 *
 * Field precedence / thresholds are copied byte-for-byte from the prior plugin
 * implementation; the plugin's pain-diagnostic-gate.test.ts (40 tests) passes
 * unchanged through the adapter as the equivalence proof.
 *
 * ERR checklist:
 * - ERR-001: inputs validated with Number.isFinite, not `as` casts.
 * - ERR-002: every decision carries reason + detail.
 * - EP-01: source string normalized with a Set membership check.
 */

// ── Defaults (migrated verbatim; previously inline magic numbers) ──────────

/** Default cooldown window: 15 minutes. */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
/** Default pain-trigger threshold. */
export const DEFAULT_PAIN_TRIGGER = 40;
/** Default high-severity threshold (risky high-score). */
export const DEFAULT_HIGH_SEVERITY = 70;
/** Default repeated-failure threshold (consecutive errors). */
export const DEFAULT_REPEATED_FAILURE = 4;
/** Default semantic-pain floor. */
export const DEFAULT_SEMANTIC_PAIN_FLOOR = 60;

const PAIN_DIAGNOSTIC_SOURCES = [
  'manual',
  'tool_failure',
  'dispatch_error',
  'gate_blocked',
  'user_empathy',
  'llm_paralysis',
  'semantic',
  'subagent_error',
] as const;

export type PainDiagnosticSource = typeof PAIN_DIAGNOSTIC_SOURCES[number];

export type PainDiagnosticGateReason =
  | 'manual'
  | 'high_gfi'
  | 'repeated_failure'
  | 'semantic_pain'
  | 'llm_paralysis'
  | 'risky_high_score'
  | 'subagent_error'
  | 'gate_blocked'
  | 'cooldown'
  | 'below_gate';

export interface PainDiagnosticGateInput {
  source: PainDiagnosticSource | string;
  score: number;
  currentGfi: number;
  consecutiveErrors?: number;
  isRisky?: boolean;
  errorHash?: string;
  sessionId?: string;
  nowMs?: number;
  cooldownMs?: number;
  thresholds?: {
    painTrigger?: number;
    highSeverity?: number;
    highGfi?: number;
    repeatedFailure?: number;
    semanticPain?: number;
  };
}

export interface PainDiagnosticGateDecision {
  shouldDiagnose: boolean;
  reason: PainDiagnosticGateReason;
  episodeKey: string;
  detail: string;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalize a raw source string to a known PainDiagnosticSource.
 *
 * Unknown sources are passed through unchanged (the caller may still match them
 * against custom thresholds) but flagged via the returned `unknown` flag so the
 * plugin adapter can log it. Core itself does not log.
 */
export function normalizedSource(source: string): { source: PainDiagnosticSource | string; unknown: boolean } {
  if (source.startsWith('llm_') && source !== 'llm_paralysis') {
    return { source: 'semantic', unknown: false };
  }
  const isKnown = (PAIN_DIAGNOSTIC_SOURCES as readonly string[]).includes(source);
  return { source, unknown: !isKnown };
}

/**
 * Build the episode key that scopes cooldown to a (session, source, hash) triple.
 */
export function buildEpisodeKey(input: PainDiagnosticGateInput): string {
  const { source } = normalizedSource(input.source);
  const sessionId = input.sessionId || 'unknown';
  const hash = input.errorHash || 'no-hash';
  return `${sessionId}:${source}:${hash}`;
}

/**
 * Evaluate the pure gate decision.
 *
 * @param input - gate input (time in nowMs is the caller's responsibility)
 * @param lastDiagnosedAtMs - the last time this episode was diagnosed, or undefined
 *   if never. Provided by the plugin adapter which owns the cooldown Map.
 * @returns the gate decision. If shouldDiagnose is true, the caller MUST record
 *   nowMs against this episode (the plugin adapter does this in markDiagnosed).
 *
 * Note on the "unknown source" side effect: the prior plugin implementation
 * logged unknown sources via SystemLogger. Core cannot log, so it surfaces the
 * unknown flag through normalizedSource; the plugin adapter is responsible for
 * logging when it observes an unknown source before calling this function.
 */
export function evaluatePainDiagnosticGateDecision(
  input: PainDiagnosticGateInput,
  lastDiagnosedAtMs?: number,
): PainDiagnosticGateDecision {
  const {source} = normalizedSource(input.source);
  const episodeKey = buildEpisodeKey(input);
  const painTrigger = input.thresholds?.painTrigger ?? DEFAULT_PAIN_TRIGGER;
  const highSeverity = input.thresholds?.highSeverity ?? DEFAULT_HIGH_SEVERITY;
  const highGfi = input.thresholds?.highGfi ?? Math.max(highSeverity, painTrigger + 30);
  const repeatedFailure = input.thresholds?.repeatedFailure ?? DEFAULT_REPEATED_FAILURE;
  const semanticPain = input.thresholds?.semanticPain ?? Math.max(painTrigger, DEFAULT_SEMANTIC_PAIN_FLOOR);
  const score = Number.isFinite(input.score) ? input.score : 0;
  const currentGfi = Number.isFinite(input.currentGfi) ? input.currentGfi : 0;
  const consecutiveErrors = typeof input.consecutiveErrors === 'number' && Number.isFinite(input.consecutiveErrors)
    ? input.consecutiveErrors
    : 0;

  const cooldownMs = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const nowMs = input.nowMs ?? 0;
  const withinCooldown = cooldownMs > 0 && lastDiagnosedAtMs !== undefined && nowMs - lastDiagnosedAtMs < cooldownMs;

  const approve = (reason: PainDiagnosticGateReason, detail: string): PainDiagnosticGateDecision => {
    if (withinCooldown) {
      return {
        shouldDiagnose: false,
        reason: 'cooldown',
        episodeKey,
        detail: `recently diagnosed; ${detail}`,
      };
    }
    return { shouldDiagnose: true, reason, episodeKey, detail };
  };

  if (source === 'manual') {
    return approve('manual', 'manual pain signal bypasses automatic gate');
  }

  if (source === 'subagent_error' && score >= painTrigger) {
    return approve('subagent_error', `subagent error score ${score} >= ${painTrigger}`);
  }

  if (source === 'llm_paralysis' && score >= painTrigger) {
    return approve('llm_paralysis', `llm paralysis score ${score} >= ${painTrigger}`);
  }

  if (source === 'gate_blocked' && score >= painTrigger) {
    return approve('gate_blocked', `gate blocked score ${score} >= ${painTrigger}`);
  }

  if ((source === 'user_empathy' || source === 'semantic') && score >= semanticPain) {
    return approve('semantic_pain', `semantic pain score ${score} >= ${semanticPain}`);
  }

  if (input.isRisky === true && score >= highSeverity) {
    return approve('risky_high_score', `risky operation score ${score} >= ${highSeverity}`);
  }

  if (consecutiveErrors >= repeatedFailure) {
    return approve('repeated_failure', `consecutive errors ${consecutiveErrors} >= ${repeatedFailure}`);
  }

  if (currentGfi >= highGfi) {
    return approve('high_gfi', `GFI ${currentGfi.toFixed(1)} >= ${highGfi}`);
  }

  return {
    shouldDiagnose: false,
    reason: 'below_gate',
    episodeKey,
    detail: `score=${score}; gfi=${currentGfi.toFixed(1)}; consecutive=${consecutiveErrors}`,
  };
}

/**
 * Pure cooldown check for an episode.
 *
 * Used by the trigger controller (PEAT-B2) and re-exported by the plugin adapter
 * as isCooldownActiveForEpisode so its cooldown decision aligns with the gate.
 */
export interface CooldownCheckInput {
  /** Source string used to build the episode key. */
  readonly source: string;
  /** Session id used to build the episode key. */
  readonly sessionId?: string;
  /** Error hash used to build the episode key. */
  readonly errorHash?: string;
  /** Cooldown window in ms. Falls back to DEFAULT_COOLDOWN_MS when undefined. */
  readonly cooldownMs?: number;
  /** Current time in ms (caller-injected; core has no clock). */
  readonly nowMs: number;
  /** Last time this episode was diagnosed, or undefined if never. */
  readonly lastDiagnosedAtMs?: number;
}

export function isCooldownActive(input: CooldownCheckInput): boolean {
  const effectiveCooldown = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (effectiveCooldown <= 0) return false;
  if (input.lastDiagnosedAtMs === undefined) return false;
  return input.nowMs - input.lastDiagnosedAtMs < effectiveCooldown;
}
