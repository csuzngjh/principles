/**
 * Prompt presence forensics: freezes the per-activation expectation set for one
 * prompt build (design v1.2 §3/§5, owner conditions 2 & 3; review-round fixes:
 * final-assembly classification + collection bounding + overflow visibility).
 *
 * Rules:
 * - Frozen AFTER all body, authorization, timeout and budget fallbacks: the
 *   classification runs against the FINAL text this hook returns.
 * - Classification per candidate body (host-normalized):
 *     contained in the final assembly      → bodyComplete=true;
 *     not in final but was in pre-guard    → bodyComplete=false (truncated
 *                                            fragment; never yields full_hit);
 *     in neither                           → excluded (the activation is not
 *                                            part of this assembly at all).
 * - bodyText replicates the host prompt-section normalization (CRLF→LF, strip
 *   trailing spaces per line, outer trim) so containment survives the host wrap.
 * - Collection is bounded: the escape/normalize work happens only for kept
 *   entries; entries beyond the cap are counted as overflow, never silently
 *   dropped.
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

export type BuiltInjectedExpectations = {
  expectations: InjectedExpectation[];
  /** Entries dropped because the collection cap was hit (visibility fact). */
  overflowCount: number;
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

export type FrozenExpectationCandidate = {
  activationId: string;
  /** Raw (pre-escape) body; `escape` is applied only to kept entries. */
  body: string;
  /**
   * PRI-1150: true when `body` is ALREADY rendered/escaped text (e.g. the
   * host-runtime frozen set) — the escape callback must not run again.
   */
  preEscaped?: boolean;
};

export function buildInjectedExpectations(params: {
  /** FINAL post-guard, post-fallback prependSystemContext (what this hook returns). */
  finalAssembly: string;
  /** Pre-guard assembly snapshot, for the truncated-fragment classification. */
  preGuardAssembly?: string;
  /**
   * Target priority body when the adaptive path prioritized one activation.
   * `preEscaped: true` marks the body as ALREADY RENDERED text (the renderer
   * contract applies escapeXml inside the directive slice — see
   * adaptive-principle-intervention.ts), so the escape callback must NOT run
   * again; re-escaping would double-escape and hide a fully assembled target.
   */
  target?: { activationId: string; body: string; preEscaped?: boolean } | undefined;
  /** Candidates from the render path or the host-runtime frozen set (escape applied to kept RAW entries only). */
  rendered: FrozenExpectationCandidate[];
  /** Escape applied to a raw body exactly as the renderer would (e.g. escapeXml). */
  escape?: (text: string) => string;
  /** Revision is unknown at this layer; recorded verbatim for the event. */
  revision?: number | string;
}): BuiltInjectedExpectations | undefined {
  try {
    const finalAssembly = normalizeForWireMatch(params.finalAssembly);
    if (!finalAssembly) {
      return undefined;
    }
    const preGuardAssembly = params.preGuardAssembly
      ? normalizeForWireMatch(params.preGuardAssembly)
      : undefined;
    const escape = params.escape ?? ((text: string) => text);
    const ordered: (FrozenExpectationCandidate & { preEscaped?: boolean })[] = [];
    if (params.target && params.target.activationId && params.target.body) {
      ordered.push({
        activationId: params.target.activationId,
        body: params.target.body,
        preEscaped: params.target.preEscaped === true,
      });
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
    let overflowCount = 0;
    for (const item of ordered) {
      if (seen.has(item.activationId)) {
        continue;
      }
      if (expectations.length >= PRESENCE_EXPECTATIONS_MAX) {
        // Bounded collection: stop materializing, keep the overflow fact.
        overflowCount += 1;
        continue;
      }
      seen.add(item.activationId);
      // Pre-rendered target text is already escaped by the renderer contract;
      // only raw render-path bodies go through the escape callback.
      const bodyText = normalizeForWireMatch(item.preEscaped ? item.body : escape(item.body));
      if (!bodyText) {
        continue;
      }
      const inFinal = finalAssembly.includes(bodyText);
      const inPreGuard = preGuardAssembly ? preGuardAssembly.includes(bodyText) : false;
      if (!inFinal && !inPreGuard) {
        // Not part of this assembly at all (e.g. removed by a fallback):
        // excluded entirely so the event never describes a dropped activation.
        continue;
      }
      expectations.push({
        activationId: item.activationId,
        revision: params.revision ?? "unknown",
        bodyText,
        bodyChars: bodyText.length,
        bodyComplete: inFinal,
      });
    }
    if (expectations.length === 0 && overflowCount === 0) {
      return undefined;
    }
    return { expectations, overflowCount };
  } catch {
    // Fail-open: forensics must never break the prompt hook.
    return undefined;
  }
}
