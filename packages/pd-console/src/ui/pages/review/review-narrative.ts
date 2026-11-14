/**
 * Turns one queued item into the single card the Owner reads.
 *
 * REVIEW_SESSION_SPEC §1.3: three short paragraphs (当时 / PD 建议 / 为什么现在
 * 决定), one impact line, and everything else behind a disclosure. This is a
 * display assembly over fields the server already returns — no new backend
 * field, no generated copy, no second truth.
 *
 * Hard limits (B3-01/02/04): paragraph ≤40 chars, total ≤120, impact ≤30,
 * evidence ≤3 lines of ≤40, and no identifiers/paths/enums in the first layer.
 */
import { formatDate } from '../../utils/format-date.js';
import { describeApiError } from '../../utils/technical-detail.js';
import { showsUnlinkedCandidateNote } from '../focus/focus-validation.js';
import type { ReviewItem } from './review-items.js';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface ReviewNarrativeRow {
  label: string;
  value: string;
}

export interface ReviewNarrative {
  heading: string;
  source: string;
  /** 1. 当时发生了什么 */
  happened: string;
  /** 2. PD 建议 */
  advice: string;
  /** 3. 为什么现在需要你决定 */
  whyNow: string;
  impact: string;
  /** Full sentences for the second layer when the first layer truncated. */
  happenedFull: string;
  adviceFull: string;
  evidence: string[];
  /** Evidence rows beyond the three shown in the first layer. */
  evidenceMore: number;
  execution: string[];
  technical: ReviewNarrativeRow[];
  /** No readable evidence — the card keeps a way out instead of pretending. */
  evidenceInsufficient: boolean;
  /** No readable principle sentence — the heading falls back and says so. */
  textMissing: boolean;
  /** The approval's lineage resolved to no principle name (PRI-940/941). */
  sourceUnlinked: boolean;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PATH_LIKE = /(?:^|[\s（(])(?:[A-Za-z]:\\|\/|~\/)[^\s，。；)）]+/;
const RAW_ENUM = /\b[a-z]+(?:_[a-z0-9]+){1,}\b/;
const RAW_JSON = /^\s*[{[][\s\S]*[}\]]\s*$/;

/** True when a string reads like a machine value, not a sentence. */
export function looksTechnical(text: string): boolean {
  return UUID.test(text) || PATH_LIKE.test(text) || RAW_JSON.test(text) || RAW_ENUM.test(text);
}

function firstSentence(text: string | null | undefined): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const match = /^[\s\S]*?[。！？.!?\n]/.exec(trimmed);
  const sentence = (match ? match[0] : trimmed).replace(/\s+/g, ' ').trim();
  return sentence;
}

function readable(text: string | null | undefined): string {
  const sentence = firstSentence(text);
  if (sentence === '' || looksTechnical(sentence)) return '';
  return sentence;
}

/** The whole (normalized) source, kept for the second layer when the first clipped. */
function fullText(text: string | null | undefined, fallback: string): string {
  if (typeof text !== 'string') return fallback;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '' || looksTechnical(normalized)) return fallback;
  return normalized;
}

/** First candidate that reads as a sentence; empty string when none does. */
function firstReadable(...values: readonly (string | null | undefined)[]): string {
  for (const value of values) {
    if (readable(value) !== '') return value ?? '';
  }
  return '';
}

/** Hard cap INCLUDING the ellipsis: a 40-char limit yields ≤40 code points. */
function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= max) return normalized;
  return `${characters.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function kindLabel(kind: string, t: Translate): string {
  switch (kind) {
    case 'rulecode_decision': return t('pages.review.kind.rulecode');
    case 'evaluator_review': return t('pages.review.kind.evaluator');
    case 'rollout_review': return t('pages.review.kind.rollout');
    case 'activation_approval': return t('pages.review.kind.activation');
    default: return t('pages.review.kind.unknown');
  }
}

function channelLabel(channel: string, t: Translate): string {
  switch (channel) {
    case 'prompt': return t('pages.review.channel.prompt');
    case 'code_tool_hook': return t('pages.review.channel.code');
    case 'defer_archive': return t('pages.review.channel.archive');
    default: return t('pages.review.channel.unknown');
  }
}

function humanTime(iso: string, language?: string): string {
  return formatDate(iso, language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** A machine grouping key is never a title (PRI-940). */
function decisionHeading(title: string, t: Translate): string {
  const trimmed = title.trim();
  if (trimmed.startsWith('unlinked:') || looksTechnical(trimmed)) return t('pages.review.fallback.heading');
  return clip(trimmed, 18) || t('pages.review.fallback.heading');
}

function uniqueBounded(values: readonly string[], max: number, length: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const line = clip(value, length);
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    result.push(line);
    if (result.length >= max) break;
  }
  return result;
}

function emptyNarrative(item: ReviewItem, t: Translate): ReviewNarrative {
  return {
    heading: decisionHeading(item.title, t),
    source: '',
    happened: t('pages.review.fallback.happened'),
    advice: t('pages.review.fallback.advice'),
    whyNow: t('pages.review.whyNow.review'),
    impact: t('pages.review.impact.generic'),
    happenedFull: t('pages.review.fallback.happened'),
    adviceFull: t('pages.review.fallback.advice'),
    evidence: [],
    evidenceMore: 0,
    execution: [t('pages.review.execution.generic1'), t('pages.review.execution.generic2')],
    technical: [],
    evidenceInsufficient: true,
    textMissing: true,
    sourceUnlinked: false,
  };
}

function decisionNarrative(item: ReviewItem, t: Translate, language?: string): ReviewNarrative {
  const { decision } = item;
  if (decision === undefined) return emptyNarrative(item, t);
  const brief = decision.review?.brief;
  const formation = brief?.formationEvidence;
  const evidenceCount = decision.review?.evidence.items.length ?? 0;

  const happenedRaw = firstReadable(formation?.diagnosis?.summary, decision.summary);
  const happenedSentence = readable(happenedRaw) || t('pages.review.fallback.happened');
  const happenedFull = fullText(happenedRaw, happenedSentence);

  const adviceRaw = firstReadable(brief?.principle?.statement, brief?.summary, decision.machineRecommendation);
  const adviceSentence = readable(adviceRaw) || t('pages.review.fallback.advice');
  const adviceFull = fullText(adviceRaw, adviceSentence);
  const whyNow = decision.kind === 'rulecode_decision'
    ? t('pages.review.whyNow.rulecode')
    : decision.kind === 'activation_approval'
      ? t('pages.review.whyNow.activation')
      : t('pages.review.whyNow.review');

  const tools = (brief?.implementation?.affectedTools ?? [])
    .map((tool) => tool.trim())
    .filter((tool) => tool !== '' && !looksTechnical(tool));
  const impactText = tools.length > 0
    ? t('pages.review.impact.tools', { tools: clip(tools.slice(0, 2).join('、'), 16) })
    : t('pages.review.impact.generic');

  const evidenceRows: string[] = [];
  for (const row of formation?.diagnosis?.evidence ?? []) {
    if (row.note.trim() !== '') evidenceRows.push(row.note);
  }
  for (const row of decision.review?.evidence.items ?? []) {
    const value = looksTechnical(row.value) || row.value.trim() === '' ? '' : row.value;
    evidenceRows.push(value === '' ? row.label : `${row.label}：${value}`);
  }
  for (const concern of brief?.concerns ?? []) evidenceRows.push(concern);
  const allEvidence = uniqueBounded(evidenceRows, 50, 40);
  const evidence = allEvidence.slice(0, 3);

  const executionSource = brief?.implementation?.summary ?? brief?.principle?.rationale ?? '';
  const executionSentences = executionSource
    .split(/[。！？!?\n]/)
    .map((sentence) => readable(sentence))
    .filter((sentence) => sentence !== '')
    .slice(0, 2)
    .map((sentence) => clip(sentence, 30));
  if (executionSentences.length === 0) {
    executionSentences.push(t('pages.review.execution.generic1'), t('pages.review.execution.generic2'));
  }
  if (tools.length > 0) {
    executionSentences.push(clip(t('pages.review.execution.scope', { tools: tools.slice(0, 2).join('、') }), 30));
  }

  const technical: ReviewNarrativeRow[] = [
    { label: t('pages.review.technical.principleId'), value: decision.principleId ?? '—' },
    { label: t('pages.review.technical.source'), value: decision.taskId },
    { label: t('pages.review.technical.reviewKey'), value: decision.reviewKey },
    { label: t('pages.review.technical.createdAt'), value: humanTime(decision.createdAt, language) },
    { label: t('pages.review.technical.kind'), value: kindLabel(decision.kind, t) },
    { label: t('pages.review.technical.status'), value: t('pages.review.technical.pending') },
    { label: t('pages.review.technical.completeness'), value: decision.review?.evidence.completeness ?? '—' },
  ];

  return {
    heading: decisionHeading(item.title, t),
    source: evidenceCount > 0
      ? t('pages.review.sourceCount', { time: humanTime(decision.createdAt, language), count: evidenceCount })
      : humanTime(decision.createdAt, language),
    happened: clip(happenedSentence, 40),
    advice: clip(adviceSentence, 40),
    whyNow: clip(whyNow, 40),
    impact: clip(impactText, 30),
    happenedFull,
    adviceFull,
    evidence,
    evidenceMore: Math.max(0, allEvidence.length - evidence.length),
    execution: executionSentences,
    technical,
    evidenceInsufficient: evidence.length === 0 || decision.review?.evidence.completeness === 'insufficient',
    textMissing: readable(brief?.principle?.statement) === '' && readable(item.title) === '',
    sourceUnlinked: false,
  };
}

function approvalNarrative(item: ReviewItem, t: Translate, language?: string): ReviewNarrative {
  const { approval } = item;
  if (approval === undefined) return emptyNarrative(item, t);
  const { group, record } = approval;
  const oldStatement = readable(group.revisionReview?.oldStatement);
  const oldStatementFull = fullText(group.revisionReview?.oldStatement, '');
  const candidate = readable(group.candidateDescription)
    // The synthesized grouping key is never readable copy (PRI-940) — even when
    // it happens to contain no token that `looksTechnical` recognises.
    || (group.principleTitle.startsWith('unlinked:') ? '' : readable(group.principleTitle));
  const candidateFull = fullText(group.candidateDescription ?? group.principleTitle, '');

  const happenedSentence = oldStatement !== ''
    ? t('pages.review.approval.previous', { text: oldStatement })
    : t('pages.review.fallback.happened');
  const happenedFull = oldStatementFull !== ''
    ? t('pages.review.approval.previous', { text: oldStatementFull })
    : happenedSentence;
  const adviceSentence = candidate || t('pages.review.fallback.advice');
  const adviceFull = candidateFull !== '' ? candidateFull : adviceSentence;
  const whyNow = group.revisionReview !== undefined
    ? t('pages.review.whyNow.revision')
    : t('pages.review.whyNow.approval');

  const impactText = t('pages.review.impact.approval', { channel: channelLabel(record.channel, t) });

  const evidence: string[] = [];
  evidence.push(t('pages.review.approval.requested', { time: humanTime(record.createdAt, language) }));
  if (oldStatement !== '') evidence.push(t('pages.review.approval.previous', { text: clip(oldStatement, 30) }));
  if (group.records.length > 1) evidence.push(t('pages.review.approval.versions', { count: group.records.length }));

  const execution = record.channel === 'prompt'
    ? [t('pages.review.execution.prompt1'), t('pages.review.execution.prompt2')]
    : record.channel === 'code_tool_hook'
      ? [t('pages.review.execution.code1'), t('pages.review.execution.code2')]
      : [t('pages.review.execution.archive1'), t('pages.review.execution.archive2')];

  const technical: ReviewNarrativeRow[] = [
    { label: t('pages.review.technical.principleId'), value: group.principleId },
    { label: t('pages.review.technical.approvalId'), value: record.id },
    { label: t('pages.review.technical.artifact'), value: record.artifactId },
    { label: t('pages.review.technical.channel'), value: channelLabel(record.channel, t) },
    { label: t('pages.review.technical.createdAt'), value: humanTime(record.createdAt, language) },
    { label: t('pages.review.technical.status'), value: t('pages.review.technical.pending') },
  ];

  return {
    heading: decisionHeading(candidate || group.principleTitle || item.title, t),
    source: group.records.length > 1
      ? t('pages.review.sourceCount', { time: humanTime(record.createdAt, language), count: group.records.length })
      : humanTime(record.createdAt, language),
    happened: clip(happenedSentence, 40),
    advice: clip(adviceSentence, 40),
    whyNow: clip(whyNow, 40),
    impact: clip(impactText, 30),
    happenedFull,
    adviceFull,
    evidence: uniqueBounded(evidence, 3, 40),
    evidenceMore: Math.max(0, uniqueBounded(evidence, 50, 40).length - 3),
    execution: execution.map((sentence) => clip(sentence, 30)),
    technical,
    evidenceInsufficient: group.artifactUnavailable === true || evidence.length === 0,
    textMissing: candidate === '',
    sourceUnlinked: showsUnlinkedCandidateNote(group),
  };
}

export function deriveReviewNarrative(item: ReviewItem, t: Translate, language?: string): ReviewNarrative {
  return item.kind === 'decision'
    ? decisionNarrative(item, t, language)
    : approvalNarrative(item, t, language);
}

/**
 * Which of the two decisions may the Owner take right now.
 *
 * `textMissing` blocks approval only: you should not approve what you cannot
 * read, but rejecting unreadable content is a legal (and often the correct)
 * exit — the server accepts it (pending + valid channel + non-empty reason).
 * Locking reject here was the defect that left such cards undecidable forever.
 */
export function reviewActionAvailability(input: {
  narrative: Pick<ReviewNarrative, 'textMissing' | 'evidenceInsufficient'>;
  lockedReason: string | null;
  acceptForbidden?: boolean;
  requiresAcknowledgement?: boolean;
  acknowledged?: boolean;
  /**
   * The server proved this record's approval precheck will refuse. Offering
   * the button would guarantee a dead end; reject stays enabled so the Owner
   * can still close the record without deleting its history.
   */
  approveBlocked?: boolean;
}): { approveDisabled: boolean; rejectDisabled: boolean } {
  const { narrative, lockedReason } = input;
  return {
    approveDisabled: lockedReason !== null
      || input.acceptForbidden === true
      || narrative.evidenceInsufficient
      || narrative.textMissing
      || input.approveBlocked === true
      || (input.requiresAcknowledgement === true && input.acknowledged !== true),
    rejectDisabled: lockedReason !== null,
  };
}

/**
 * Owner-facing action failure: what happened + what to do next (D14).
 *
 * Approve and reject get their own copy — a failed rejection must never read
 * "approval did not go through". Permanent refusals (missing or unusable source
 * identity) must not invite a retry, because retrying cannot change them.
 * `activation_failed` is deliberately NOT permanent: it wraps both recoverable
 * and unrecoverable causes, and the server's own nextAction asks for a retry.
 */
export function describeReviewActionError(
  raw: string | null | undefined,
  t: Translate,
  action: 'approve' | 'reject',
): string {
  const value = (raw ?? '').trim();
  // A stale precheck is neither a permanent refusal nor a generic failure: the
  // material/identity moved after the card was rendered, so reload and re-judge.
  if (/precheck_stale/i.test(value)) {
    return t('pages.review.actionErrors.precheckStale');
  }
  if (/stale_review|stale_owner_decision|already_resolved|conflict/i.test(value)) {
    return t('pages.review.actionErrors.stale');
  }
  if (/no_principle_id_in_artifact|candidate_missing|principle_not_in_ledger|artifact_kind_not_rule|not a rule|unresolved|provenance/i.test(value)) {
    return action === 'reject'
      ? t('pages.review.actionErrors.rejectPermanent')
      : t('pages.review.actionErrors.approvePermanent');
  }
  if (action === 'reject') return t('pages.review.actionErrors.rejectGeneric');
  if (/artifact.{0,20}(invalid|kind)/i.test(value)) {
    return t('pages.review.actionErrors.notRunnable');
  }
  const described = describeApiError(value);
  if (described.text === '这条内容属于技术细节' || described.text === value) {
    return t('pages.review.actionErrors.generic');
  }
  return described.text;
}
