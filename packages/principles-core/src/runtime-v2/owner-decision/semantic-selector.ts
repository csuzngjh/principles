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
  selectionMode: 'whole_field' | 'extracted_sentence';
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

// ── Semantic Selector v1 — bounded verbatim extraction (SPEC §10.3) ────────
//
// v1 only ADDS a fallback on top of v0: when no whole field qualifies, extract
// ONE already-existing standalone human behavior sentence from the same tier
// sources, VERBATIM (whole sentence, no word deletion — so negations,
// conditions, exceptions and quantifiers are preserved by construction).
// Never: interpret hooks as principles, generalize by deleting words, rewrite
// rationale, or upgrade rule/implementation/prompt descriptions.

const OBLIGATION_MARKERS = /必须|不得|应当|应该|禁止|需要先|要先|避免|须|shall|must|never|always/i;

/** Splits a field into sentence units without dropping any characters. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;])\s*/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/**
 * Extracts the first standalone human behavior sentence (verbatim) from the
 * given sources, or null when none qualifies. A sentence qualifies when it
 * (a) passes the same whole-field technical-residue gate per sentence,
 * (b) carries an explicit behavioral obligation marker, and
 * (c) is long enough to be a standalone obligation.
 * Extraction only helps multi-sentence fields: a single-sentence field that
 * failed the whole-field gate fails the same gate per sentence.
 */
export function extractStandaloneBehaviorSentence(sources: SemanticSource[]): { text: string; tier: SemanticSource['tier']; sourceVersion: string } | null {
  const tierOrder: SemanticSource['tier'][] = ['scribe', 'distiller', 'philosopher', 'candidate_principle'];
  const ordered = [...sources].sort((a, b) => tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier));
  for (const source of ordered) {
    if (isWholeFieldHumanReadable(source.text)) continue; // v0 already covers this field
    const sentences = splitSentences(source.text);
    if (sentences.length < 2) continue;
    for (const sentence of sentences) {
      if (sentence.length >= 10 && OBLIGATION_MARKERS.test(sentence) && isWholeFieldHumanReadable(sentence)) {
        return { text: sentence, tier: source.tier, sourceVersion: source.sourceVersion };
      }
    }
  }
  return null;
}

/**
 * Semantic Selector v1: v0 whole-field selection first; bounded verbatim
 * sentence extraction as the only fallback. No rewriting, ever.
 */
export function selectLearnedPrincipleV1(sources: SemanticSource[]): SemanticSelectionResult {
  const wholeField = selectLearnedPrincipleV0(sources);
  if (wholeField.status === 'known') return wholeField;
  const extracted = extractStandaloneBehaviorSentence(sources);
  if (extracted !== null) {
    return {
      status: 'known',
      text: extracted.text,
      sourceTier: extracted.tier,
      selectionMode: 'extracted_sentence',
      selectionReason: '从同一来源字段中逐字摘录的独立行为句（未删词、未改写；保留原有否定与条件）。',
      sourceVersion: extracted.sourceVersion,
    };
  }
  return wholeField;
}
