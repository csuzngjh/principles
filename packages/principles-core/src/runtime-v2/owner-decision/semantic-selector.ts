/**
 * Principle Semantic Selector v0 — Owner Decision Experience v1 (SPEC §10.2).
 *
 * Selects the most human-readable EXISTING principle text for the Owner's
 * first layer. v0 is whole-field selection only: no sentence extraction, no
 * word deletion, no rewriting, no LLM. If no source field qualifies as a
 * standalone human behavior principle, the answer is UNKNOWN — the technical
 * original stays reachable in Technical Details.
 *
 * Source order (constrained by lineage/version FIRST, then tier):
 *   1. Scribe principleDraft.statement  (same lineage/revision as the decision artifact)
 *   2. Distiller abstractedPrinciple    (same candidate)
 *   3. Philosopher principleCandidate.title (exact verifiable relation)
 *   4. candidate.description            (only kind=principle AND whole-field qualified)
 *   5. UNKNOWN
 *
 * Qualification is deliberately conservative: ANY technical residue (paths,
 * file names, regex, hashes, internal ids, tool/hook names, snake_case
 * identifiers) disqualifies the whole field. Borderline → UNKNOWN, never a
 * partial cleanup. The audit's 34%/54% implementation-leakage labels are test
 * fixtures, not runtime inputs — there is no per-id special casing here.
 */

/** Ordered candidate sources handed to the selector by the collector. */
export interface SemanticSource {
  tier: 'scribe' | 'distiller' | 'philosopher' | 'candidate_principle';
  /** Whole-field text as persisted. */
  text: string;
  /** Artifact/principle version anchor (e.g. artifact id or 'ledger'), for display only. */
  sourceVersion: string;
}

export interface SemanticSelection {
  status: 'known';
  text: string;
  sourceTier: SemanticSource['tier'];
  selectionMode: 'whole_field';
  selectionReason: string;
  sourceVersion: string;
}

export interface SemanticUnknown {
  status: 'unknown';
  reasonCode:
    | 'no_qualified_source'
    | 'only_technical_recommendation_available'
    | 'no_sources';
  reasonText: string;
}

export type SemanticSelectionResult = SemanticSelection | SemanticUnknown;

// ── Conservative qualification heuristics (v0) ──────────────────────────────
//
// Every pattern below marks text that requires PD-internal knowledge to
// understand. None of them prove a text IS implementation-heavy; they only
// prove it is NOT safely human-readable as a whole field.

const TECHNICAL_MARKERS: RegExp[] = [
  // File names / extensions and path-like segments.
  /\.[a-z]{2,4}\b/i,
  /(?:^|[\s（(「'"，,：:])\/[\w.-]+(?:\/[\w.-]+)+/,
  /[a-zA-Z]:\\\\?/,
  // Regex residue and glob patterns.
  /[\^$]\s?|\{\\d|\*\*|\\\w{1,3}[^a-z]|\/.*\/[gimsu]*\s*$/,
  // Hex hashes (>=16 hex chars in a row) and UUIDs.
  /\b[0-9a-f]{16,}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  // Internal id namespaces written into free text.
  /\b(?:pi-art-|pi-rule-|apr_|act_|cand(?:idate)?[-_:]?\s?(?:id)?:)/i,
  /candidate:\/\/|ledger:\/\/|artifact:\/\//i,
  // Tool / hook / algorithm vocabulary that only makes sense inside the host.
  /\bhook\b/i,
  /\bmd5\b|\bsha-?\d+\b/i,
  /\bregex p?(?:attern)?\b/i,
  /\bapi\b/i,
  /\bjson\b|\byaml\b|\bsql\b/i,
  /\bsqlite\b/i,
  /\bmtimes?\b/i,
  /\bhash(?:值|算法)?\b/i,
  // snake_case identifiers (tool names like write_file, sessions_yield).
  /\b[a-z]+(?:_[a-z0-9]+)+\b/,
];

/** Whole-field human-readability gate. True = safe for the Owner first layer. */
export function isWholeFieldHumanReadable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false; // too short to carry an obligation
  if (trimmed.length > 600) return false; // not a principle statement
  for (const marker of TECHNICAL_MARKERS) {
    if (marker.test(trimmed)) return false;
  }
  return true;
}

/**
 * Semantic Selector v0: first qualified source in tier order. Sources must
 * already be lineage-constrained by the caller (only scribe artifacts bound
 * to THIS principle's revision, only the same candidate's distiller field…).
 */
export function selectLearnedPrincipleV0(sources: SemanticSource[]): SemanticSelectionResult {
  if (sources.length === 0) {
    return {
      status: 'unknown',
      reasonCode: 'no_sources',
      reasonText: '没有可用于展示的原则文本来源。',
    };
  }
  const tierOrder: SemanticSource['tier'][] = ['scribe', 'distiller', 'philosopher', 'candidate_principle'];
  const tierNames: Record<SemanticSource['tier'], string> = {
    scribe: 'Scribe 正式草案',
    distiller: 'Distiller 抽象原则',
    philosopher: 'Philosopher 候选原则',
    candidate_principle: '原始原则建议',
  };
  // Tier order wins over input order; among the same tier the caller's order
  // (newest first) wins.
  const [selected] = sources
    .filter((source) => isWholeFieldHumanReadable(source.text))
    .sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));
  if (selected === undefined) {
    return {
      status: 'unknown',
      reasonCode: 'only_technical_recommendation_available',
      reasonText: '这项提案已有技术建议，但可读的行为准则暂缺。',
    };
  }
  return {
    status: 'known',
    text: selected.text.trim(),
    sourceTier: selected.tier,
    selectionMode: 'whole_field',
    selectionReason: `${tierNames[selected.tier]}的完整字段，未经改写。`,
    sourceVersion: selected.sourceVersion,
  };
}
