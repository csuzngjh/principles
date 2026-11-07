/**
 * PRI-1150 Path A minimal presence checker (design v2 §5).
 *
 * The Path A observation is the host-assembled system prompt delivered by the
 * official `llm_input` hook as a SINGLE string — so this checker needs only
 * full-body containment over that one text. It deliberately does NOT port the
 * transport checker's parts/multi-message machinery.
 *
 * Three mutually exclusive outcomes per expectation: full_hit /
 * checked_missing / unknown (always with a reason). An empty body, a truncated
 * fragment, an over-limit body, an unreadable observation or an internal
 * failure can never be reported as a hit, and none of them — nor a missing
 * snapshot — may be read as "no principle was injected".
 */

import type { RegisteredExpectation } from './prompt-presence-registry.js';

export const PRESENCE_LITE_LIMITS = {
  /** Per-body containment input ceiling (UTF-16 chars; host-runtime caps sets far below this). */
  MAX_BODY_CHARS: 64 * 1024,
  /** Observed system-prompt scan ceiling. */
  MAX_OBSERVATION_CHARS: 32 * 1024 * 1024,
  /** Result entries carried per event (bounded output). */
  MAX_RESULTS: 64,
} as const;

export type PresenceLiteOutcome = 'full_hit' | 'checked_missing' | 'unknown';

export type PresenceLiteReason =
  | 'assembly_truncated'
  | 'body_over_limit'
  | 'invalid_body'
  | 'observation_over_limit'
  | 'unparseable_observation'
  | 'check_failed';

export interface PresenceLiteResult {
  activationId: string;
  outcome: PresenceLiteOutcome;
  reason?: PresenceLiteReason;
  actualBodyChars?: number;
}

export interface PresenceLiteCheck {
  checked: boolean;
  reason?: PresenceLiteReason;
  results: PresenceLiteResult[];
  observationChars: number;
  /** Set when outcome=unknown came from an internal exception (check_failed). */
  checkFailedReason?: string;
  limitsExceeded?: { observationChars?: number; bodyChars?: number };
}

/**
 * Pure containment check over one observed text. Never throws; internal
 * failures surface as unknown:check_failed (callers additionally wrap the
 * invocation so a checker bug can never break the hook).
 */
export function checkAssemblyPresence(params: {
  observedText: unknown;
  expectations: readonly RegisteredExpectation[] | undefined;
  limits?: typeof PRESENCE_LITE_LIMITS;
}): PresenceLiteCheck {
  const limits = params.limits ?? PRESENCE_LITE_LIMITS;
  const base: PresenceLiteCheck = {
    checked: false,
    results: [],
    observationChars: typeof params.observedText === 'string' ? params.observedText.length : 0,
  };
  if (typeof params.observedText !== 'string') {
    return { ...base, results: [] };
  }
  try {
    if (params.observedText.length > limits.MAX_OBSERVATION_CHARS) {
      return {
        ...base,
        checked: true,
        observationChars: params.observedText.length,
        results: (params.expectations ?? []).map((expectation) => ({
          activationId: expectation.activationId,
          outcome: 'unknown' as const,
          reason: 'observation_over_limit' as const,
          actualBodyChars: expectation.bodyChars,
        })),
        limitsExceeded: { observationChars: params.observedText.length },
      };
    }
    const results: PresenceLiteResult[] = [];
    let bodyOverLimit = false;
    for (const expectation of params.expectations ?? []) {
      if (results.length >= limits.MAX_RESULTS) break;
      if (!expectation.bodyComplete) {
        results.push({
          activationId: expectation.activationId,
          outcome: 'unknown',
          reason: 'assembly_truncated',
          actualBodyChars: expectation.bodyChars,
        });
        continue;
      }
      if (typeof expectation.bodyText !== 'string' || expectation.bodyText.trim().length === 0) {
        results.push({
          activationId: expectation.activationId,
          outcome: 'unknown',
          reason: 'invalid_body',
          actualBodyChars: expectation.bodyChars,
        });
        continue;
      }
      if (expectation.bodyText.length > limits.MAX_BODY_CHARS) {
        bodyOverLimit = true;
        results.push({
          activationId: expectation.activationId,
          outcome: 'unknown',
          reason: 'body_over_limit',
          actualBodyChars: expectation.bodyChars,
        });
        continue;
      }
      const hit = params.observedText.includes(expectation.bodyText);
      results.push({
        activationId: expectation.activationId,
        outcome: hit ? 'full_hit' : 'checked_missing',
        actualBodyChars: expectation.bodyChars,
      });
    }
    return {
      ...base,
      checked: true,
      observationChars: params.observedText.length,
      results,
      ...(bodyOverLimit ? { limitsExceeded: { bodyChars: limits.MAX_BODY_CHARS } } : {}),
    };
  } catch (error) {
    return {
      ...base,
      checked: true,
      results: (params.expectations ?? []).map((expectation) => ({
        activationId: expectation.activationId,
        outcome: 'unknown' as const,
        reason: 'check_failed' as const,
        actualBodyChars: expectation.bodyChars,
      })),
      checkFailedReason: `exception:${error instanceof Error ? error.name : typeof error}`,
      limitsExceeded: undefined,
    };
  }
}
