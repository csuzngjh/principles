/**
 * S4: one context-budget authority for every adapter that assembles a
 * provider request.
 *
 * Why this exists
 * ---------------
 * Before S4 each adapter carried its own magic character cap (Artificer L2
 * truncated `inputPayload` at 50_000 chars) with no relationship to the
 * model's own context window and no record that a cut happened. That is both
 * wrong (the cap could sit far below a 128k-token window, cutting evidence
 * that would have fit) and silent (the Owner had no way to see what was
 * dropped).
 *
 * This module owns two small decisions:
 *   1. how many input tokens a model can accept, derived from its context
 *      window minus the output reservation, with a soft ratio covering the
 *      estimator's error (pi-ai estimates characters / 3.5 — a heuristic);
 *   2. how to fit one text block into such a budget while reporting exactly
 *      what was dropped.
 *
 * It deliberately does NOT rank context items by confidence or approval state.
 * `StartRunInput.contextItems` carries only `{role, content}` and no production
 * caller populates it, so a confidence/owner-confirmation ranking would be a
 * contract with no producer (AGENTS.md P7). Callers that need that ranking must
 * first introduce the data; until then this module only ever cuts at the
 * model-window boundary and always leaves a record.
 */
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';

/**
 * Headroom for the estimator's error and for request parts this module does not
 * see (tool declarations, message envelopes).
 */
export const CONTEXT_BUDGET_SOFT_RATIO = 0.9;

/** Never hand a caller a zero-token budget: let the provider reject a tiny one. */
export const MIN_CONTEXT_BUDGET_TOKENS = 1_024;

export interface ContextBudget {
  contextWindowTokens: number;
  reserveOutputTokens: number;
  /** Input tokens available to this request. */
  budgetTokens: number;
}

/**
 * Derive the input-token budget from a model context window.
 *
 * A non-finite/absent window yields an effectively unbounded budget so callers
 * with incomplete model metadata keep their previous behavior instead of
 * failing on an invented limit.
 */
export function resolveContextBudget(
  contextWindowTokens: number,
  reserveOutputTokens = 0,
): ContextBudget {
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return {
      contextWindowTokens,
      reserveOutputTokens,
      budgetTokens: Number.POSITIVE_INFINITY,
    };
  }
  const reserve = Number.isFinite(reserveOutputTokens) && reserveOutputTokens > 0 ? reserveOutputTokens : 0;
  const usable = Math.floor(contextWindowTokens * CONTEXT_BUDGET_SOFT_RATIO) - reserve;
  return {
    contextWindowTokens,
    reserveOutputTokens: reserve,
    budgetTokens: Math.max(MIN_CONTEXT_BUDGET_TOKENS, usable),
  };
}

/** Estimated input tokens for the request parts the caller assembled. */
export function estimateRequestTokens(parts: {
  systemPrompt?: string;
  texts: readonly string[];
}): number {
  let tokens = parts.systemPrompt ? estimateTextTokens(parts.systemPrompt) : 0;
  for (const text of parts.texts) tokens += estimateTextTokens(text);
  return tokens;
}

export interface TextBudgetFit {
  text: string;
  truncated: boolean;
  originalChars: number;
  keptChars: number;
  droppedChars: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

/**
 * Fit a single text block into `maxTokens`.
 *
 * The chars-per-token ratio is measured on the actual text instead of reusing
 * pi-ai's private 3.5 constant, so the cut point matches the library's own
 * estimator for that script (CJK and Latin text differ materially).
 */
export function fitTextToTokenBudget(text: string, maxTokens: number): TextBudgetFit {
  const estimatedTokensBefore = estimateTextTokens(text);
  const base = {
    text,
    truncated: false,
    originalChars: text.length,
    keptChars: text.length,
    droppedChars: 0,
    estimatedTokensBefore,
    estimatedTokensAfter: estimatedTokensBefore,
  };
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || estimatedTokensBefore <= maxTokens) {
    return base;
  }

  const charsPerToken = text.length / Math.max(1, estimatedTokensBefore);
  const keptChars = Math.max(0, Math.min(text.length, Math.floor(maxTokens * charsPerToken)));
  const kept = text.slice(0, keptChars);
  return {
    text: kept,
    truncated: true,
    originalChars: text.length,
    keptChars,
    droppedChars: text.length - keptChars,
    estimatedTokensBefore,
    estimatedTokensAfter: estimateTextTokens(kept),
  };
}
