/**
 * pain-card-helpers.ts — Pure display logic for EvidenceChainCard.
 *
 * PRI-344: Extracted from PainPage.tsx for testability.
 * No React dependency, no I/O. All functions are pure.
 */

// ── Confidence mapping ────────────────────────────────────────────────────────

export type ConfidenceLabel = 'high' | 'mid' | 'low';

/**
 * Map a numeric confidence to a human-readable label.
 * Thresholds: ≥0.7 → 'high', 0.4–<0.7 → 'mid', <0.4 → 'low'
 */
export function mapConfidenceLabel(confidence: number): ConfidenceLabel {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.4) return 'mid';
  return 'low';
}

// ── Card layer data structures ────────────────────────────────────────────────

export interface Layer1Data {
  stateLabel: string;
  sourceLabel: string;
  observedAt: string;
}

export interface Layer2Data {
  /** trigger behavior summary — always present */
  triggerSummary: string;
  /** PD conclusion — only when candidateTitle exists */
  conclusion: string | null;
  /** applicability — candidateSummary or rootCauseSummary */
  applicability: string | null;
  /** confidence level label + raw value */
  confidence: { label: ConfidenceLabel; raw: number } | null;
  /** failure reason — only for failed states */
  failureReason: string | null;
  /** degraded reason — when data is degraded */
  degradedReason: string | null;
  /** next action guidance */
  nextAction: string | null;
}

export interface Layer3Data {
  id: string;
  linkedTaskId: string | null;
  linkedTaskStatus: string | null;
  linkedCandidateId: string | null;
  linkedPrincipleId: string | null;
  sourceKind: string;
  state: string;
  /** PRI-380: internalization task linkage */
  internalizationTaskId: string | null;
  dreamerTaskStatus: string | null;
}

export interface CardLayers {
  layer1: Layer1Data;
  layer2: Layer2Data;
  layer3: Layer3Data;
}

export interface RecordData {
  id: string;
  sourceKind: string;
  observedAt: string;
  state: string;
  summary: string;
  candidateTitle?: string;
  candidateSummary?: string;
  rootCauseSummary?: string;
  confidence?: number;
  recommendationKind?: string;
  failureReason?: string;
  degradedReason?: string;
  nextAction?: string;
  linkedTaskId?: string;
  linkedTaskStatus?: string;
  linkedCandidateId?: string;
  linkedPrincipleId?: string;
  /** PRI-380: internalization task linkage */
  internalizationTaskId?: string;
  dreamerTaskStatus?: string;
}

/**
 * Build the three-layer card data from a record.
 * - Layer 1: status badges + source + timestamp
 * - Layer 2: human-readable content (trigger, conclusion, applicability, confidence)
 * - Layer 3: technical IDs (collapsed by default)
 */
export function buildCardLayers(record: RecordData): CardLayers {
  const layer1: Layer1Data = {
    stateLabel: record.state,
    sourceLabel: record.sourceKind,
    observedAt: record.observedAt,
  };

  const layer2: Layer2Data = {
    triggerSummary: record.summary,
    conclusion: record.candidateTitle ?? null,
    applicability: record.candidateSummary ?? record.rootCauseSummary ?? null,
    confidence: record.confidence != null
      ? { label: mapConfidenceLabel(record.confidence), raw: record.confidence }
      : null,
    failureReason: record.failureReason ?? null,
    degradedReason: record.degradedReason ?? null,
    nextAction: record.nextAction ?? null,
  };

  const layer3: Layer3Data = {
    id: record.id,
    linkedTaskId: record.linkedTaskId ?? null,
    linkedTaskStatus: record.linkedTaskStatus ?? null,
    linkedCandidateId: record.linkedCandidateId ?? null,
    linkedPrincipleId: record.linkedPrincipleId ?? null,
    sourceKind: record.sourceKind,
    state: record.state,
    internalizationTaskId: record.internalizationTaskId ?? null,
    dreamerTaskStatus: record.dreamerTaskStatus ?? null,
  };

  return { layer1, layer2, layer3 };
}

// ── Debug ID summary (clipboard-friendly) ────────────────────────────────────

/**
 * Build a copyable debug ID summary string for developer troubleshooting.
 * Only includes non-null fields. Format: `key: value` per line.
 *
 * Purpose: replaces the 8-row ID table in Layer 3 with one copyable string,
 * so Owners never need to read raw IDs in the UI — they copy this string
 * only when reporting an issue to a developer.
 */
export function buildDebugIdSummary(record: RecordData): string {
  const lines: string[] = [];
  lines.push(`pain_id: ${record.id}`);
  if (record.linkedTaskId) lines.push(`task_id: ${record.linkedTaskId}`);
  if (record.linkedTaskStatus) lines.push(`task_status: ${record.linkedTaskStatus}`);
  if (record.linkedCandidateId) lines.push(`candidate_id: ${record.linkedCandidateId}`);
  if (record.linkedPrincipleId) lines.push(`principle_id: ${record.linkedPrincipleId}`);
  if (record.internalizationTaskId) lines.push(`internalization_task_id: ${record.internalizationTaskId}`);
  if (record.dreamerTaskStatus) lines.push(`dreamer_status: ${record.dreamerTaskStatus}`);
  lines.push(`source_kind: ${record.sourceKind}`);
  lines.push(`state: ${record.state}`);
  return lines.join('\n');
}

/**
 * Check if a record's Layer 2 human-readable content is effectively empty.
 * Used to show an honest placeholder instead of a visually-empty card that
 * invites the user to expand Layer 3 IDs.
 *
 * "Effectively empty" = triggerSummary is blank OR equals a generic state-machine
 * string, AND no conclusion/applicability/failureReason/degradedReason.
 */
export function isLayer2EffectivelyEmpty(record: RecordData): boolean {
  const hasText = (value?: string): boolean =>
    typeof value === 'string' && value.trim().length > 0;
  const hasConclusion = hasText(record.candidateTitle);
  const hasApplicability = hasText(record.candidateSummary) || hasText(record.rootCauseSummary);
  const hasFailure = hasText(record.failureReason) || hasText(record.degradedReason);
  if (hasConclusion || hasApplicability || hasFailure) return false;
  // triggerSummary is the only required field; if it's blank or a generic
  // placeholder, the card visually looks empty.
  const summary = record.summary?.trim();
  if (!summary) return true;
  return false;
}
