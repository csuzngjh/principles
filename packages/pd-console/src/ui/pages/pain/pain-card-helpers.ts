/**
 * pain-card-helpers.ts — Pure display logic for EvidenceChainCard.
 *
 * PRI-344: Extracted from PainPage.tsx for testability.
 * No React dependency, no I/O. All functions are pure.
 */

import type { IntentTensionData, IntentDecisionRecordData, EvidenceChainProvenanceData } from '../../utils/validators.js';
import type { IntentDecisionInputPayload } from '../../api.js';
import { enumLabel } from '../../utils/enum-labels.js';

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

// ── Provenance badge (SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.4) ─────────────

/** Raw source kind used by the MCP agent-assisted submission channel. */
export const MCP_AGENT_ASSISTED_SOURCE_KIND = 'mcp_agent_assisted';

/**
 * i18n key for the neutral wording used when a pain record was observed by an
 * agent and authorized by the Owner (MCP submission path).
 */
export const AGENT_REPORTED_PROVENANCE_LABEL_KEY = 'pages.pain.provenanceAgentReportedOwnerApproved';

/**
 * i18n key used when the record came through the MCP agent-assisted channel but
 * the authorization could not be verified (missing / unknown provenance, or an
 * unparseable `diagnostic_json`).
 */
export const AGENT_REPORTED_AUTHORIZATION_UNVERIFIED_KEY = 'pages.pain.provenanceAgentReportedAuthorizationUnverified';

/** i18n key for the generic neutral source-kind label of `mcp_agent_assisted`. */
export const MCP_AGENT_ASSISTED_SOURCE_LABEL_KEY = 'common.enums.sourceKind.mcp_agent_assisted';

/**
 * Which of the three display tiers a record falls into.
 *
 * - `authorized_agent_report` — verified Owner authorization.
 * - `unverified_agent_report` — agent-assisted submission whose authorization
 *   cannot be verified. Must never be presented as Owner authorization.
 * - `source_kind` — every other record keeps its existing source-kind label.
 */
export type ProvenanceBadgeKind =
  | 'authorized_agent_report'
  | 'unverified_agent_report'
  | 'source_kind';

export interface ProvenanceBadge {
  kind: ProvenanceBadgeKind;
  /**
   * i18n key for tiers 1 and 2. `undefined` means the caller resolves the label
   * through `enumLabel('sourceKind', ...)` (tier 3).
   */
  labelKey?: string;
}

/**
 * Resolve the display tier for a record's source/provenance.
 *
 * Priority:
 * 1. `provenance === 'agent_reported_owner_approved'` → authorized agent report;
 * 2. `sourceKind === 'mcp_agent_assisted'` with NO provenance → agent report
 *    whose authorization cannot be verified;
 * 3. everything else → the existing source-kind path.
 *
 * Tier 2 is deliberately narrow: missing provenance must never be read as Owner
 * authorization, and legacy provenance values stay on their existing path.
 */
export function resolveProvenanceBadge(record: RecordData): ProvenanceBadge {
  if (record.provenance === 'agent_reported_owner_approved') {
    return { kind: 'authorized_agent_report', labelKey: AGENT_REPORTED_PROVENANCE_LABEL_KEY };
  }
  if (record.sourceKind === MCP_AGENT_ASSISTED_SOURCE_KIND && record.provenance === undefined) {
    return { kind: 'unverified_agent_report', labelKey: AGENT_REPORTED_AUTHORIZATION_UNVERIFIED_KEY };
  }
  return { kind: 'source_kind' };
}

/**
 * Whether the card renders the neutral "agent reported, Owner authorized"
 * badge instead of the raw source-kind badge.
 *
 * Only `agent_reported_owner_approved` changes to the authorized wording: the
 * three legacy provenance values keep their existing rendering and their raw
 * provenance is never shown. The internal enum literal must never reach the
 * Owner, and this record must never be presented as the Owner's own observation.
 */
export function isAgentReportedOwnerApproved(record: RecordData): boolean {
  return resolveProvenanceBadge(record).kind === 'authorized_agent_report';
}

/**
 * zh-CN mirror of the two provenance i18n keys, used only when no translator is
 * supplied (pure tests). The React page always passes `t`, so the real UI reads
 * the i18n catalog; this keeps the helper total without leaking an enum.
 */
const SAFE_SOURCE_DISPLAY_FALLBACK: Readonly<Record<'authorized_agent_report' | 'unverified_agent_report', string>> = {
  authorized_agent_report: '智能体报告，拥有者已授权',
  unverified_agent_report: '智能体报告（授权信息不可验证）',
};

/**
 * Single Owner-facing source label resolver for Layer 1, Layer 3 (technical
 * details) and the copied debug summary.
 *
 * Every Owner-facing path must go through this function so no internal enum
 * literal (`mcp_agent_assisted`, `agent_reported_owner_approved`, …) can leak.
 * Records without verifiable provenance degrade to neutral wording; they are
 * never presented as Owner authorization.
 */
export function resolveSourceDisplayLabel(
  record: RecordData,
  t?: (key: string) => string,
): string {
  const badge = resolveProvenanceBadge(record);
  if (badge.kind !== 'source_kind') {
    return t && badge.labelKey ? t(badge.labelKey) : SAFE_SOURCE_DISPLAY_FALLBACK[badge.kind];
  }
  return enumLabel('sourceKind', record.sourceKind, t);
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
  /**
   * PRI-469: optional intent tension from the diagnostician artifact.
   * Present only when the record carries a validated intentTension.
   * The UI renders an IntentTensionPanel when this is non-null (SPEC §22.1.2).
   */
  intentTension: IntentTensionData | null;
}

export interface Layer3Data {
  id: string;
  linkedTaskId: string | null;
  linkedTaskStatus: string | null;
  linkedCandidateId: string | null;
  linkedPrincipleId: string | null;
  /** Safe Owner-facing source label — never the raw source kind enum. */
  sourceLabel: string;
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
  /** PRI-469: optional intent tension from diagnostician artifact (SPEC §16). */
  intentTension?: IntentTensionData;
  /** SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.4: internal provenance discriminator. */
  provenance?: EvidenceChainProvenanceData;
}

/**
 * Build the three-layer card data from a record.
 * - Layer 1: status badges + source + timestamp
 * - Layer 2: human-readable content (trigger, conclusion, applicability, confidence)
 * - Layer 3: technical IDs (collapsed by default)
 */
export function buildCardLayers(record: RecordData, t?: (key: string) => string): CardLayers {
  // All Owner-facing layers share one safe resolver (SPEC §6.6.4).
  const sourceLabel = resolveSourceDisplayLabel(record, t);

  const layer1: Layer1Data = {
    stateLabel: record.state,
    sourceLabel,
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
    // PRI-469: pass intentTension through to Layer 2 for the IntentTensionPanel.
    intentTension: record.intentTension ?? null,
  };

  const layer3: Layer3Data = {
    id: record.id,
    linkedTaskId: record.linkedTaskId ?? null,
    linkedTaskStatus: record.linkedTaskStatus ?? null,
    linkedCandidateId: record.linkedCandidateId ?? null,
    linkedPrincipleId: record.linkedPrincipleId ?? null,
    sourceLabel,
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
export function buildDebugIdSummary(record: RecordData, t?: (key: string) => string): string {
  const lines: string[] = [];
  lines.push(`pain_id: ${record.id}`);
  if (record.linkedTaskId) lines.push(`task_id: ${record.linkedTaskId}`);
  if (record.linkedTaskStatus) lines.push(`task_status: ${record.linkedTaskStatus}`);
  if (record.linkedCandidateId) lines.push(`candidate_id: ${record.linkedCandidateId}`);
  if (record.linkedPrincipleId) lines.push(`principle_id: ${record.linkedPrincipleId}`);
  if (record.internalizationTaskId) lines.push(`internalization_task_id: ${record.internalizationTaskId}`);
  if (record.dreamerTaskStatus) lines.push(`dreamer_status: ${record.dreamerTaskStatus}`);
  // Owner-facing clipboard text: the safe label, never the raw source enum.
  lines.push(`source_kind: ${resolveSourceDisplayLabel(record, t)}`);
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

// ── PRI-469: Intent Tension panel rendering helpers (SPEC §22.1) ─────────────

/**
 * Whether the IntentTensionPanel should render a high-salience decision panel.
 *
 * SPEC §22.1.3: when `source = none`, do NOT render a high-salience decision
 * panel. The tension may still be shown in technical details as "no intent
 * tension", but it must not compete for the Owner's attention.
 *
 * This helper is pure and tested independently of the React component.
 */
export function shouldRenderIntentTensionPanel(tension: IntentTensionData | null | undefined): tension is IntentTensionData {
  if (!tension) return false;
  // source='none' means no tension detected — suppress the high-salience panel.
  if (tension.source === 'none') return false;
  return true;
}

/**
 * Whether follow-up actions (precipitate candidate principle, promote to
 * RuleHost, view Intent Patch Proposal) should be visible.
 *
 * SPEC §22.1.4: follow-up actions are NOT the first-layer decision. They only
 * appear after the Owner has confirmed a decision (an IntentDecisionRecord
 * has been persisted for this tension).
 *
 * PRI-470: replaced the PRI-469 stub. Now returns true only when a non-empty
 * decisions array exists — i.e., at least one IntentDecisionRecord has been
 * persisted for this tension.
 */
export function shouldRenderFollowUpActions(
  decisions?: IntentDecisionRecordData[] | null,
): boolean {
  if (!Array.isArray(decisions)) return false;
  return decisions.length > 0;
}

// ── PRI-470: Owner decision payload builder (SPEC §22.1) ─────────────────────

/**
 * Context needed to build an IntentDecisionInputPayload from a tension.
 * `id` is a caller-supplied UUID for the decision record. `recordId` is the
 * evidence chain record ID used as a fallback when taskId is not available.
 * `painId` and `intentDocHash` are optional.
 */
export interface IntentDecisionContext {
  id: string;
  recordId: string;
  painId?: string;
  taskId?: string;
  intentDocHash?: string;
}

/**
 * The Owner's decision on an intent tension. `ownerAction` overrides
 * `tension.suggestedOwnerAction` — the Owner may choose a different action
 * than the one PD suggested. `note` is an optional trimmed annotation.
 */
export interface IntentDecisionChoice {
  ownerAction: string;
  note?: string;
}

/**
 * Build an IntentDecisionInputPayload from an IntentTension and the Owner's
 * chosen action. The payload is sent to POST /api/intent-decisions.
 *
 * - `id` is the caller-supplied decision UUID (P0 fix: server requires this).
 * - `taskId` falls back to `recordId` when not provided.
 * - Optional fields (painId, intentDocHash, note) are omitted when empty.
 * - `note` is trimmed before being included.
 * - `evidenceRefs` is passed through as-is; truncation is the backend's job
 *   (the frontend must not silently drop evidence the Owner might rely on).
 * - `ownerAction` overrides `tension.suggestedOwnerAction` — the Owner may
 *   choose a different action than the one PD suggested.
 *
 * P0 fix (PRI-471): the previous payload used `evidence` + `explanation` +
 * `suggestedAction` and omitted `id`, which did not match the server's
 * `IntentDecisionInput` contract (SPEC §21.7). The server requires `id` and
 * `evidenceRefs`, and does not accept `explanation` or `suggestedAction` —
 * those are snapshot fields the server persists from the tension, not inputs.
 */
export function buildIntentDecisionPayload(
  tension: IntentTensionData,
  context: IntentDecisionContext,
  choice: IntentDecisionChoice,
): IntentDecisionInputPayload {
  const { ownerAction, note } = choice;
  const payload: IntentDecisionInputPayload = {
    id: context.id,
    taskId: context.taskId ?? context.recordId,
    source: tension.source,
    evidenceStrength: tension.evidenceStrength,
    relatedIntentFields: tension.relatedIntentFields,
    evidenceRefs: tension.evidence,
    ownerAction,
  };
  if (context.painId !== undefined && context.painId.length > 0) {
    payload.painId = context.painId;
  }
  if (context.intentDocHash !== undefined && context.intentDocHash.length > 0) {
    payload.intentDocHash = context.intentDocHash;
  }
  if (note !== undefined && note.trim().length > 0) {
    payload.note = note.trim();
  }
  return payload;
}
