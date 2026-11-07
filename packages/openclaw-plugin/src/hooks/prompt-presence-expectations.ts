/**
 * Prompt presence forensics: freezes the per-activation expectation set for one
 * prompt build (design v1.2 §3/§5, owner conditions 2 & 3).
 *
 * Rules:
 * - Frozen AFTER the size guard: bodyText must be exactly what this hook returns.
 * - bodyComplete is judged by containment of the host-normalized body inside the
 *   host-normalized post-guard prependSystemContext; a truncated fragment is
 *   marked bodyComplete=false so the wire check can never grant a full_hit.
 * - bodyText replicates the host prompt-section normalization (CRLF→LF, strip
 *   trailing spaces per line, outer trim) so containment survives the host wrap.
 * - Memory-only: expectations ride the hook result to the host and are never
 *   persisted or logged here.
 */

const PRESENCE_EXPECTATIONS_MAX = 64;

export type InjectedExpectation = {
  activationId: string;
  revision: number | string;
  bodyText: string;
  bodyChars: number;
  bodyComplete: boolean;
};

/**
 * Mirrors the host's normalizeStructuredPromptSection (@openclaw/ai
 * prompt-cache-stability.ts): sanitize-adjacent CRLF→LF, per-line trailing
 * space strip, outer trim. Idempotent on already-normalized text.
 */
export function normalizeForWireMatch(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export type FrozenExpectationInput = {
  activationId: string;
  body: string;
};

export function buildInjectedExpectations(params: {
  /** Post-guard prependSystemContext (what this hook actually returns). */
  assembledPrependSystemContext: string;
  /** Target priority body when the adaptive path prioritized one activation. */
  target?: { activationId: string; body: string } | undefined;
  /** Fallback render path entries (escaped bodies as they appear in directives). */
  rendered: FrozenExpectationInput[];
  /** Revision is unknown at this layer; recorded verbatim for the event. */
  revision?: number | string;
}): InjectedExpectation[] | undefined {
  try {
    const assembled = normalizeForWireMatch(params.assembledPrependSystemContext);
    if (!assembled) {
      return undefined;
    }
    const ordered: FrozenExpectationInput[] = [];
    if (params.target && params.target.activationId && params.target.body) {
      ordered.push({ activationId: params.target.activationId, body: params.target.body });
    }
    for (const item of params.rendered) {
      if (!item.activationId || !item.body) {
        continue;
      }
      if (params.target && item.activationId === params.target.activationId) {
        continue; // Target already recorded.
      }
      ordered.push(item);
    }
    const seen = new Set<string>();
    const expectations: InjectedExpectation[] = [];
    for (const item of ordered) {
      if (seen.has(item.activationId) || expectations.length >= PRESENCE_EXPECTATIONS_MAX) {
        continue;
      }
      seen.add(item.activationId);
      const bodyText = normalizeForWireMatch(item.body);
      if (!bodyText) {
        continue;
      }
      expectations.push({
        activationId: item.activationId,
        revision: params.revision ?? "unknown",
        bodyText,
        bodyChars: bodyText.length,
        bodyComplete: assembled.includes(bodyText),
      });
    }
    return expectations.length > 0 ? expectations : undefined;
  } catch {
    // Fail-open: forensics must never break the prompt hook.
    return undefined;
  }
}
