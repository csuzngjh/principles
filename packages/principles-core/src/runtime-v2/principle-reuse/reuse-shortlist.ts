/**
 * PRI-917 Slice 1 — deterministic shortlist scoring (pure, no LLM, no I/O).
 *
 * Why a hand-rolled tokenizer: the Principle corpus is Chinese prose, so
 * whitespace tokenization collapses a sentence into one useless token.
 * This module therefore emits CJK character bigrams plus lower-cased latin /
 * numeric word runs. The result is deterministic, dependency-free, and
 * explainable — every score decomposes into named shared terms.
 *
 * Explicit non-goals (SPEC §6): no embedding, no vector store, no semantic
 * search service, no background process, no clock, no randomness.
 */

import type {
  ReuseCandidate,
  ReuseCandidateInput,
  ReuseEvidence,
  ReuseEvidenceField,
  ReusablePrinciple,
  ReuseSemanticField,
  ReuseShortlist,
  ReuseShortlistOptions,
} from './reuse-domain.js';

const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_MAX_EVIDENCE_TERMS = 8;

/**
 * Field-pair weights. Same-field agreement is the strong signal; a
 * cross-field pair catches a candidate that states the claim in `action` where
 * the existing Principle states it in `text`.
 */
const FIELD_PAIR_WEIGHTS: readonly {
  readonly from: ReuseSemanticField;
  readonly to: ReuseSemanticField;
  readonly weight: number;
}[] = [
  { from: 'text', to: 'text', weight: 3 },
  { from: 'action', to: 'action', weight: 3 },
  { from: 'triggerPattern', to: 'triggerPattern', weight: 2 },
  { from: 'text', to: 'action', weight: 1 },
  { from: 'action', to: 'text', weight: 1 },
];

/**
 * Minimal Chinese function-word stop list. Kept deliberately small: over-pruning
 * would erase real signal, and the scoring is advisory (a human/AI Owner
 * decides), not authoritative.
 */
const CJK_STOP_TERMS: ReadonlySet<string> = new Set([
  '的', '了', '是', '在', '和', '与', '或', '及', '对', '为', '以', '等', '中',
  '上', '下', '时', '后', '前', '将', '被', '把', '就', '都', '也', '而', '但',
  '并', '不', '有', '无', '一', '个', '这', '那', '其', '之', '所', '使', '由',
  '如', '若', '则', '于', '从', '到', '向', '再', '更', '最', '很', '会', '能',
  '应', '须', '要', '可', '个', '种', '些', '之', '者', '此', '该', '某',
]);

const CJK_RANGE = /[㐀-䶿一-鿿豈-﫿]/;

function isCjk(ch: string): boolean {
  return CJK_RANGE.test(ch);
}

/**
 * Deterministic, dependency-free tokenizer.
 *
 * - latin / numeric runs → lower-cased word tokens (length >= 2)
 * - CJK runs → character bigrams (single char when the run is length 1)
 * - everything else is a separator
 *
 * The output is sorted, so two equal texts always tokenize identically.
 */
export function tokenizeForReuse(input: string): string[] {
  const normalized = input.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  let latinRun = '';
  let cjkRun = '';

  const flushLatin = (): void => {
    if (latinRun.length >= 2) tokens.push(latinRun);
    latinRun = '';
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      tokens.push(cjkRun);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i++) tokens.push(cjkRun.slice(i, i + 2));
    }
    cjkRun = '';
  };

  for (const ch of normalized) {
    if (isCjk(ch)) {
      flushLatin();
      cjkRun += ch;
    } else if (/[a-z0-9]/.test(ch)) {
      flushCjk();
      latinRun += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();

  const deduped = new Set(tokens);
  for (const stop of CJK_STOP_TERMS) deduped.delete(stop);
  return [...deduped].sort();
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const shared: string[] = [];
  for (const term of a) if (b.has(term)) shared.push(term);
  return shared.sort();
}

/**
 * Score one existing Principle against the candidate.
 *
 * Returns `null` when no field pair shares anything — an entry with no
 * evidence is not a proposal.
 */
export function scoreReuseCandidate(
  input: ReuseCandidateInput,
  principle: ReusablePrinciple,
  maxEvidenceTerms: number = DEFAULT_MAX_EVIDENCE_TERMS,
): ReuseCandidate | null {
  const inputTerms: Record<ReuseSemanticField, Set<string>> = {
    text: new Set(tokenizeForReuse(input.text)),
    triggerPattern: new Set(tokenizeForReuse(input.triggerPattern)),
    action: new Set(tokenizeForReuse(input.action)),
  };
  const principleTerms: Record<ReuseSemanticField, Set<string>> = {
    text: new Set(tokenizeForReuse(principle.text)),
    triggerPattern: new Set(tokenizeForReuse(principle.triggerPattern)),
    action: new Set(tokenizeForReuse(principle.action)),
  };

  const evidence: ReuseEvidence[] = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const pair of FIELD_PAIR_WEIGHTS) {
    const from = inputTerms[pair.from];
    const to = principleTerms[pair.to];
    const smaller = Math.min(from.size, to.size);
    // An empty side can never produce evidence.
    if (smaller === 0) continue;
    totalWeight += pair.weight;
    const shared = intersect(from, to);
    if (shared.length === 0) continue;
    const coverage = shared.length / smaller;
    weighted += pair.weight * coverage;
    const field: ReuseEvidenceField = pair.from === pair.to ? pair.from : `${pair.from}~${pair.to}`;
    evidence.push({
      field,
      sharedTerms: shared.slice(0, maxEvidenceTerms),
      coverage,
    });
  }

  if (evidence.length === 0 || totalWeight === 0) return null;

  const score = weighted / totalWeight;
  const [top] = evidence
    .slice()
    .sort((a, b) => b.coverage - a.coverage || a.field.localeCompare(b.field));
  const reason = top
    ? `shares ${top.sharedTerms.slice(0, 5).join('、')} on ${top.field} (coverage ${(top.coverage * 100).toFixed(0)}%)`
    : 'no field overlap';

  return {
    principleId: principle.id,
    principleText: principle.text,
    score,
    evidence,
    similarityReason: reason,
  };
}

/**
 * Build a deterministic, bounded shortlist of existing Principles that may
 * already cover the candidate.
 *
 * Pure: no I/O, no clock, no randomness. Total order is `score` desc then
 * `principleId` asc, so identical input always yields identical output
 * regardless of ledger insertion order.
 */
export function selectReuseShortlist(
  input: ReuseCandidateInput,
  principles: readonly ReusablePrinciple[],
  options: ReuseShortlistOptions = {},
): ReuseShortlist {
  const topK = options.topK ?? DEFAULT_TOP_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const maxEvidenceTerms = options.maxEvidenceTerms ?? DEFAULT_MAX_EVIDENCE_TERMS;

  const scored: ReuseCandidate[] = [];
  for (const principle of principles) {
    const candidate = scoreReuseCandidate(input, principle, maxEvidenceTerms);
    if (candidate && candidate.score >= minScore) scored.push(candidate);
  }
  scored.sort((a, b) => b.score - a.score || a.principleId.localeCompare(b.principleId));

  return {
    candidates: scored.slice(0, topK),
    eligibleCount: principles.length,
    consideredCount: scored.length,
    candidateKindEligible: true,
  };
}
