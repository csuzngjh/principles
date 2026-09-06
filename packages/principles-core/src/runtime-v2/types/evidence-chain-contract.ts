/**
 * EvidenceChainContract — shared core contracts and assembly mapper for
 * the Pain Evidence Chain (PRI-385).
 *
 * This file is purely logical (no fs, db, or network dependencies) and
 * lives inside principles-core to be shared by Console read models,
 * CLI commands, and test fixtures.
 */

import { Type } from '@sinclair/typebox';
import {
  IntentTensionSchema,
  type IntentTension,
  type IntentTensionSource,
  type EvidenceStrength,
  type IntentRelatedField,
  type SuggestedOwnerAction,
} from '../diagnostician/diag-rootcause-output.js';

// PRI-469: re-export IntentTension so consumers can import it from the
// evidence-chain module without reaching into the diagnostician package.
// The canonical definition lives in diag-rootcause-output.ts (PRI-468, SPEC §16).
export type { IntentTension };

// ── Types and Schemas ─────────────────────────────────────────────────────────

export type EvidenceChainState =
  | 'recorded-only'
  | 'evidence-only'
  | 'diagnosis-queued'
  | 'diagnosis-running'
  | 'diagnosis-succeeded'
  | 'diagnosis-failed'
  | 'diagnosis-retry-wait'
  | 'candidate-generated'
  | 'internalization-missing'
  | 'internalization-pending'
  | 'internalization-running'
  | 'internalization-failed'
  | 'internalization-succeeded'
  | 'owner-reviewable'
  | 'malformed'
  | 'degraded';

export const EvidenceChainStateSchema = Type.Union([
  Type.Literal('recorded-only'),
  Type.Literal('evidence-only'),
  Type.Literal('diagnosis-queued'),
  Type.Literal('diagnosis-running'),
  Type.Literal('diagnosis-succeeded'),
  Type.Literal('diagnosis-failed'),
  Type.Literal('diagnosis-retry-wait'),
  Type.Literal('candidate-generated'),
  Type.Literal('internalization-missing'),
  Type.Literal('internalization-pending'),
  Type.Literal('internalization-running'),
  Type.Literal('internalization-failed'),
  Type.Literal('internalization-succeeded'),
  Type.Literal('owner-reviewable'),
  Type.Literal('malformed'),
  Type.Literal('degraded'),
]);

export interface EvidenceChainRecord {
  id: string;
  sourceKind: string;
  observedAt: string;
  state: EvidenceChainState;
  summary: string;
  admissionDecision?: string;
  linkedPainId?: string;
  linkedTaskId?: string;
  linkedTaskStatus?: string;
  linkedCandidateId?: string;
  linkedPrincipleId?: string;
  failureReason?: string;
  degradedReason?: string;
  nextAction?: string;
  candidateTitle?: string;
  candidateSummary?: string;
  rootCauseSummary?: string;
  confidence?: number;
  recommendationKind?: string;
  internalizationTaskId?: string;
  dreamerTaskStatus?: string;
  /** PRI-406: Canonical pain identity (e.g. manual_<ts>_<hash>). */
  canonicalPainId?: string;
  /** PRI-406: Runtime V2 diagnostician task ID. */
  runtimeTaskId?: string;
  /** PRI-406: How this record was linked — 'canonical' (precise via canonical_pain_id) or 'legacy' (timestamp/content heuristic). */
  linkMode?: 'canonical' | 'legacy';
  /**
   * PRI-625 Slice D: evidence host attribution (SPEC §15 — pain/candidate
   * views identify the Codex host with safe lineage). Validated against the
   * known host kinds; absent/unset rows render as 'unknown'.
   */
  hostKind?: 'openclaw' | 'codex' | 'unknown';
  /**
   * PRI-469: Optional intent tension surfaced from the diagnostician artifact
   * (Stage A output, SPEC §16). Present only when:
   *   1. The `intent_engineering` flag was on at diagnosis time, AND
   *   2. The Stage A LLM chose to emit an intentTension, AND
   *   3. The artifact content_json validated successfully.
   *
   * This field is for Owner-facing display only (SPEC §22.1.2). It MUST NOT
   * directly create rules or modify ledger principle status (SPEC §22).
   * `confidence` is forbidden on this object (SPEC §16.3).
   */
  intentTension?: IntentTension;
}

export const EvidenceChainRecordSchema = Type.Object({
  id: Type.String(),
  sourceKind: Type.String(),
  observedAt: Type.String(),
  state: EvidenceChainStateSchema,
  summary: Type.String(),
  admissionDecision: Type.Optional(Type.String()),
  linkedPainId: Type.Optional(Type.String()),
  linkedTaskId: Type.Optional(Type.String()),
  linkedTaskStatus: Type.Optional(Type.String()),
  linkedCandidateId: Type.Optional(Type.String()),
  linkedPrincipleId: Type.Optional(Type.String()),
  failureReason: Type.Optional(Type.String()),
  degradedReason: Type.Optional(Type.String()),
  nextAction: Type.Optional(Type.String()),
  candidateTitle: Type.Optional(Type.String()),
  candidateSummary: Type.Optional(Type.String()),
  rootCauseSummary: Type.Optional(Type.String()),
  confidence: Type.Optional(Type.Number()),
  recommendationKind: Type.Optional(Type.String()),
  internalizationTaskId: Type.Optional(Type.String()),
  dreamerTaskStatus: Type.Optional(Type.String()),
  canonicalPainId: Type.Optional(Type.String()),
  runtimeTaskId: Type.Optional(Type.String()),
  linkMode: Type.Optional(Type.Union([Type.Literal('canonical'), Type.Literal('legacy')])),
  // PRI-469: optional intent tension from diagnostician artifact (SPEC §16).
  // `confidence` is forbidden on this object (SPEC §16.3); enforced by
  // IntentTensionSchema's additionalProperties:false and by validateIntentTension.
  intentTension: Type.Optional(IntentTensionSchema),
});

export interface EvidenceChainResponse {
  records: EvidenceChainRecord[];
  generatedAt: string;
  degradedReason?: string;
  nextAction?: string;
  note?: string;
}

export const EvidenceChainResponseSchema = Type.Object({
  records: Type.Array(EvidenceChainRecordSchema),
  generatedAt: Type.String(),
  degradedReason: Type.Optional(Type.String()),
  nextAction: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
});

// ── Internal Helpers & Type Guards ───────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function getOwnValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readOwnString(record: Record<string, unknown>, key: string): string | undefined {
  const value = getOwnValue(record, key);
  return isString(value) ? value : undefined;
}

function _readOwnStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = getOwnValue(record, key);
  if (!Array.isArray(value)) return [];
  return value.filter(isString);
}

function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

// ── PRI-469: Intent Tension validation (SPEC §16) ────────────────────────────
//
// Pure helper that validates an untrusted `intentTension` object read from the
// diagnostician artifact's content_json. Returns the validated IntentTension
// (with evidence truncated to max 3 per SPEC §16.4) or `undefined` when the
// data is malformed. The caller is responsible for setting a degradedReason
// when validation fails (ERR-002: graceful degradation must include a reason).
//
// SPEC §16.3: `confidence` is FORBIDDEN on intentTension. The Stage A
// rootCause-level confidence is the only diagnostician confidence. This helper
// explicitly rejects any object carrying a `confidence` field, in addition to
// the TypeBox schema's additionalProperties:false guard — defense in depth
// (ERR-001: untrusted data from DB artifacts).

const VALID_INTENT_TENSION_SOURCES = new Set<string>([
  'none',
  'action_drift',
  'intent_suspect',
  'healthy_tension',
]);

const VALID_EVIDENCE_STRENGTHS = new Set<string>(['weak', 'moderate', 'strong']);

const VALID_INTENT_RELATED_FIELDS = new Set<string>([
  'why',
  'desired_outcome',
  'non_negotiables',
  'stop_escalation',
  'current_strategic_focus',
]);

const VALID_SUGGESTED_OWNER_ACTIONS = new Set<string>([
  'confirm_drift',
  'revise_intent',
  'observe',
  'dismiss',
  'promote_to_principle',
  'promote_to_rulehost',
]);

/** SPEC §16.4: evidence array is capped at 3 items to limit Owner review burden. */
const INTENT_TENSION_EVIDENCE_MAX = 3;

/**
 * Validate an untrusted `intentTension` value from a diagnostician artifact.
 *
 * @returns The validated IntentTension (evidence truncated to max 3), or
 *          `undefined` when the value is malformed. Never throws.
 *
 * Runtime Contract rules applied:
 *   - Rule 1: input is `unknown`, validated before use (ERR-001)
 *   - Rule 2: no `as` bypass — all fields checked with typeof / Set.has (ERR-001/005)
 *   - Rule 4: array element types validated element-wise (ERR-005/007)
 *   - Rule 5: Object.hasOwn used for key checks (ERR-013)
 *   - Rule 9: callers must set a degradedReason when this returns undefined (ERR-002)
 */
export function validateIntentTension(value: unknown): IntentTension | undefined {
  if (!isRecord(value)) return undefined;

  // SPEC §16.3: confidence is forbidden on intentTension.
  if (Object.hasOwn(value, 'confidence')) return undefined;

  const source = getOwnValue(value, 'source');
  if (typeof source !== 'string' || !VALID_INTENT_TENSION_SOURCES.has(source)) {
    return undefined;
  }

  const evidenceStrength = getOwnValue(value, 'evidenceStrength');
  if (typeof evidenceStrength !== 'string' || !VALID_EVIDENCE_STRENGTHS.has(evidenceStrength)) {
    return undefined;
  }

  // relatedIntentFields: must be an array of valid enum strings (ERR-005/007).
  const relatedIntentFieldsRaw = getOwnValue(value, 'relatedIntentFields');
  if (!Array.isArray(relatedIntentFieldsRaw)) return undefined;
  const relatedIntentFields: IntentRelatedField[] = [];
  for (const f of relatedIntentFieldsRaw) {
    // Runtime-validated against the enum Set; the `as` cast below is AFTER
    // validation, which is the correct pattern (Rule 2 forbids using `as`
    // INSTEAD of validation, not after it).
    if (typeof f !== 'string' || !VALID_INTENT_RELATED_FIELDS.has(f)) return undefined;
    relatedIntentFields.push(f as IntentRelatedField);
  }

  // evidence: must be an array of strings. Truncate to max 3 (SPEC §16.4,
  // graceful degradation — keep the first 3 rather than dropping the whole
  // tension, so the Owner still sees the signal).
  const evidenceRaw = getOwnValue(value, 'evidence');
  if (!Array.isArray(evidenceRaw)) return undefined;
  const evidence: string[] = [];
  for (const e of evidenceRaw) {
    if (typeof e !== 'string') return undefined;
    evidence.push(e);
  }
  const truncatedEvidence = evidence.slice(0, INTENT_TENSION_EVIDENCE_MAX);

  const explanation = getOwnValue(value, 'explanation');
  if (typeof explanation !== 'string' || explanation.length === 0) return undefined;

  const suggestedOwnerAction = getOwnValue(value, 'suggestedOwnerAction');
  if (
    typeof suggestedOwnerAction !== 'string' ||
    !VALID_SUGGESTED_OWNER_ACTIONS.has(suggestedOwnerAction)
  ) {
    return undefined;
  }

  // intentDocHash: optional string.
  const intentDocHash = getOwnValue(value, 'intentDocHash');
  if (intentDocHash !== undefined && typeof intentDocHash !== 'string') return undefined;

  const result: IntentTension = {
    source: source as IntentTensionSource,
    evidenceStrength: evidenceStrength as EvidenceStrength,
    relatedIntentFields,
    evidence: truncatedEvidence,
    explanation,
    suggestedOwnerAction: suggestedOwnerAction as SuggestedOwnerAction,
  };
  if (typeof intentDocHash === 'string') {
    result.intentDocHash = intentDocHash;
  }
  return result;
}

// ── Mapping & State Resolution ────────────────────────────────────────────────

export function mapSourceKind(source: string): string {
  switch (source) {
    case 'manual':
    case 'owner_explicit_cli':
    case 'owner_explicit_chat':
      return 'manual';
    case 'tool_call':
    case 'hook':
      return 'tool_call';
    case 'rulehost':
    case 'gate':
      return 'rulehost';
    case 'empathy':
    case 'empathy_inferred':
      return 'empathy_inferred';
    case 'review':
    case 'review_finding':
      return 'review';
    default:
      return source || 'unknown';
  }
}

export function inferAdmissionDecision(sourceKind: string): string {
  switch (sourceKind) {
    case 'manual':
    case 'review':
      return 'store_signal';
    case 'empathy_inferred':
      return 'owner_confirmation_required';
    default:
      return 'evidence_only';
  }
}

export interface ChainStateParams {
  sourceKind: string;
  taskStatus?: string;
  hasCandidate: boolean;
  dreamerStatus?: string;
  ledgerPrincipleStatus?: string;
}

export function determineState(params: ChainStateParams): EvidenceChainState {
  const { sourceKind, taskStatus, hasCandidate, dreamerStatus, ledgerPrincipleStatus } = params;

  if (ledgerPrincipleStatus === 'active' || ledgerPrincipleStatus === 'probation') {
    return 'internalization-succeeded';
  }
  if (ledgerPrincipleStatus === 'candidate') {
    return 'owner-reviewable';
  }

  if (hasCandidate) {
    if (!dreamerStatus) {
      return 'internalization-missing';
    }
    switch (dreamerStatus) {
      case 'pending':
      case 'queued':
        return 'internalization-pending';
      case 'running':
        return 'internalization-running';
      case 'failed':
        return 'internalization-failed';
      case 'succeeded':
        return 'internalization-succeeded';
      default:
        return 'candidate-generated';
    }
  }

  if (taskStatus) {
    switch (taskStatus) {
      case 'pending':
      case 'queued':
        return 'diagnosis-queued';
      case 'running':
        return 'diagnosis-running';
      case 'succeeded':
        return 'diagnosis-succeeded';
      case 'failed':
      case 'needs_human_review':
        return 'diagnosis-failed';
      case 'retry_wait':
        return 'diagnosis-retry-wait';
      default:
        return 'diagnosis-queued';
    }
  }

  const admission = inferAdmissionDecision(sourceKind);
  if (admission === 'evidence_only') {
    // Observed evidence that has NOT entered the governance chain (tool_call / hook /
    // rulehost observations). Kept distinct from `recorded-only` so owners do not
    // mistake passive observations for active governance. (PRI-385 P1-2)
    return 'evidence-only';
  }
  // store_signal (manual/review) and owner_confirmation_required (empathy_inferred)
  // are owner-admitted signals awaiting the pipeline → active chain.
  return 'recorded-only';
}

/**
 * Derive the raw painId accepted by `pd pain retry --pain-id` from a diagnostician
 * task_id. Convention (PainToPrincipleService): `task_id = diagnosis_${painId}`, so the
 * painId is `task_id` with a single leading `diagnosis_` stripped — and it must round-trip
 * (`diagnosis_` + painId === original linkedTaskId).
 *
 * Only the canonical `diagnosis_<painId>` form is safe: sub-run ids like
 * `diag_router-diagnosis_*` do NOT start with `diagnosis_`, so they fall through to the
 * `pd diagnose run --task-id` fallback. The record display id (`pain_*` / `manual_*`) is
 * intentionally NOT used here — it does not satisfy the `diagnosis_${painId}` convention.
 * (ERR-008: lineage/painId must come from one consistent source = the real task_id.)
 */
function deriveRetryPainId(linkedTaskId: string | undefined): string | undefined {
  if (!linkedTaskId || !linkedTaskId.startsWith('diagnosis_')) return undefined;
  const painId = linkedTaskId.slice('diagnosis_'.length);
  // Reject empty remainder or a remainder that still carries the prefix (ambiguous).
  if (!painId || painId.startsWith('diagnosis_')) return undefined;
  return painId;
}

/**
 * Build an executable recovery command for failed/retry-wait diagnosis.
 *
 * Priority (PRI-385 P1-1):
 *   1. Safe raw painId  → `pd pain retry --pain-id <painId> --workspace "<ws>" --runtime <kind>`
 *   2. Any linkedTaskId → `pd diagnose run --task-id <linkedTaskId> --workspace "<ws>" --runtime <kind>`
 *   3. Neither          → returns undefined (caller emits a reason-style nextAction instead).
 *
 * `--workspace` is always explicit (per PRI-385 owner note: recovery commands must
 * preserve workspace identity). `--runtime <kind>` is shown as a required placeholder
 * because `pd pain retry` / `pd diagnose run` refuse without an explicit runtime.
 */
function buildRetryCommand(linkedTaskId: string | undefined, ws: string): string | undefined {
  const painId = deriveRetryPainId(linkedTaskId);
  if (painId) {
    return `pd pain retry --pain-id ${painId} --workspace "${ws}" --runtime <kind>`;
  }
  if (linkedTaskId) {
    return `pd diagnose run --task-id ${linkedTaskId} --workspace "${ws}" --runtime <kind>`;
  }
  return undefined;
}

export interface NextActionContext {
  state: EvidenceChainState;
  workspaceDir: string;
  /**
   * Display record id (`pain_*` / `manual_*` / task-derived). Carried for context only;
   * it is NOT a valid `--pain-id` (format mismatch with the `diagnosis_${painId}` convention).
   */
  recordId?: string;
  /** The actual diagnostician task_id; the authoritative source for the retry painId (ERR-008). */
  linkedTaskId?: string;
}

export function determineNextAction(ctx: NextActionContext): string | undefined {
  const { state, workspaceDir: ws, linkedTaskId } = ctx;
  switch (state) {
    case 'diagnosis-retry-wait': {
      const cmd = buildRetryCommand(linkedTaskId, ws);
      return cmd
        ? `Diagnosis is waiting for automatic retry. Force retry: ${cmd}`
        : 'Diagnosis is waiting for automatic retry, but no retryable task id is linked. Check Runtime V2 pipeline status.';
    }
    case 'diagnosis-failed': {
      const cmd = buildRetryCommand(linkedTaskId, ws);
      return cmd
        ? `Diagnosis failed. Retry: ${cmd}`
        : 'Diagnosis failed, but no retryable task id is linked. Check the failure details and Runtime V2 pipeline status.';
    }
    case 'diagnosis-succeeded':
      return 'Diagnosis completed. A principle candidate may be generated shortly.';
    case 'candidate-generated':
    case 'internalization-missing':
      return `Candidate generated. Waiting for internalization pipeline. Run: pd runtime internalization run-once --workspace "${ws}"`;
    case 'internalization-pending':
      return 'Candidate generated. Internalization task is pending — wait for dreamer to complete.';
    case 'internalization-running':
      return 'Internalization in progress — dreamer task is running.';
    case 'internalization-failed':
      return `Internalization task failed. Check dreamer task error or run: pd runtime internalization run-once --workspace "${ws}" to retry.`;
    case 'owner-reviewable':
      return 'Principle candidate is ready for owner review.';
    case 'internalization-succeeded':
      return 'Internalization task completed. Check for owner-reviewable principle.';
    default:
      return undefined;
  }
}

export function resolveSummary(fields: {
  candidateTitle?: string;
  rootCauseSummary?: string;
  painText?: string;
  painReason?: string;
  fallback: string;
}): string {
  if (fields.candidateTitle) return fields.candidateTitle;
  if (fields.rootCauseSummary) return fields.rootCauseSummary;
  if (fields.painText) return fields.painText;
  if (fields.painReason) return fields.painReason;
  return fields.fallback;
}

// ── ID Normalization ──────────────────────────────────────────────────────────

export interface NormalizationResult {
  success: boolean;
  normalized?: string;
  reason?: string;
  nextAction?: string;
}

export function normalizeDiagnosticianTaskId(taskId: string): NormalizationResult {
  if (!taskId) {
    return {
      success: false,
      reason: 'Diagnostician task ID is empty or missing.',
      nextAction: 'Verify that the principle candidates table contains valid task IDs.',
    };
  }

  if (!taskId.includes('diagnosis_')) {
    return { success: true, normalized: taskId };
  }

  if (taskId.startsWith('diagnosis_')) {
    return { success: true, normalized: taskId };
  }

  const idx = taskId.indexOf('diagnosis_');
  if (idx > 0 && taskId[idx - 1] === '-') {
    const normalized = taskId.slice(idx);
    return { success: true, normalized };
  }

  return {
    success: false,
    reason: `Malformed diagnostician task ID: "${taskId}". Unable to normalize to canonical "diagnosis_*" format.`,
    nextAction: 'Ensure task IDs follow the format "diagnosis_*" or "<stage>-diagnosis_*".',
  };
}

// ── Timestamp Proximity Matching ──────────────────────────────────────────────

export interface TaskMapEntry {
  taskId: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  rootCauseSummary?: string;
  diagnosticJsonDegraded?: boolean;
  inputRef?: string;
  /** PRI-469: intent tension extracted from the diagnostician artifact (Stage A output). */
  intentTension?: IntentTension;
  /** PRI-469: set when the artifact content_json could not be parsed or intentTension was malformed. */
  artifactDegraded?: boolean;
}

export function crossReferenceByTimestamp(
  painEvents: { painId: string; createdAt: string; source: string }[],
  taskMap: Map<string, TaskMapEntry>,
  coveredPainIds: Set<string>,
): Map<string, TaskMapEntry> {
  const CROSS_REF_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const result = new Map<string, TaskMapEntry>();
  const usedTaskIds = new Set<string>();

  const unmatchedEvents = painEvents.filter(e => !coveredPainIds.has(e.painId));
  if (unmatchedEvents.length === 0) return result;

  const availableTasks: [string, TaskMapEntry][] = [];
  for (const [key, entry] of taskMap.entries()) {
    if (!coveredPainIds.has(key)) {
      availableTasks.push([key, entry]);
    }
  }

  unmatchedEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const event of unmatchedEvents) {
    const eventTime = new Date(event.createdAt).getTime();
    if (Number.isNaN(eventTime)) continue;

    let bestMatch: [string, TaskMapEntry] | null = null;
    let bestDelta = Infinity;

    for (const [taskKey, taskEntry] of availableTasks) {
      if (usedTaskIds.has(taskKey)) continue;
      const taskTime = new Date(taskEntry.createdAt).getTime();
      if (Number.isNaN(taskTime)) continue;

      const delta = Math.abs(eventTime - taskTime);
      if (delta <= CROSS_REF_WINDOW_MS && delta < bestDelta) {
        bestDelta = delta;
        bestMatch = [taskKey, taskEntry];
      }
    }

    if (bestMatch) {
      usedTaskIds.add(bestMatch[0]);
      result.set(event.painId, bestMatch[1]);
    }
  }

  return result;
}

// ── Deduplication Helper ───────────────────────────────────────────────────────

/**
 * Normalize a summary string for dedupe matching.
 *
 * Pipeline (Unicode-aware, reviewer P1 round 3):
 *   1. NFKC normalization — folds compatibility characters and fullwidth
 *      forms (e.g. "Ａｇｅｎｔ" -> "Agent", "ＡＧＥＮＴ<U+3000>修改" -> "AGENT 修改")
 *      so visually identical text produced by different input methods
 *      collapses to the same canonical form.
 *   2. Lowercase.
 *   3. Strip every character that is NOT a Unicode letter (\p{L}), Unicode
 *      number (\p{N}), or whitespace. This is the critical fix: the previous
 *      pattern `[^\w\s]` only retained `[A-Za-z0-9_]`, which deleted CJK
 *      ideographs entirely — a Chinese pain summary like "Agent 未经批准修改了配置"
 *      was reduced to "agent", making every Chinese pain hash to the same key
 *      and silently breaking content-hash dedupe for non-ASCII owners.
 *      \p{L} keeps all letters across every script (Latin, CJK, Cyrillic,
 *      Arabic, ...); \p{N} keeps all digits; whitespace is preserved for the
 *      collapse step below.
 *   4. Collapse runs of whitespace to a single space and trim.
 *
 * Examples:
 *   - "Agent modified config!" and "agent modified config" hash to the same key.
 *   - "Agent 未经批准修改了配置！" and "agent 未经批准修改了配置" hash to the same key.
 *   - "Ａｇｅｎｔ<U+3000>修改" and "Agent 修改" hash to the same key (NFKC fold).
 *
 * Exported for direct unit testing of the normalization rules.
 */
export function normalizeSummaryForDedupe(summary: string): string {
  return summary
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Maximum allowed observedAt gap (in milliseconds) for content-hash dedupe
 * under condition (b) below.
 *
 * Content alone is NOT strong enough: an owner may legitimately log the same
 * pain ("Agent modified config without approval") today AND again tomorrow as
 * two separate real recurrences. Suppressing the second occurrence would
 * silently hide real recurrence signal from the owner, which is dangerous for
 * pain/episode judgement.
 *
 * We therefore require content-hash match AND observedAt within this window.
 * The 1s value matches the original (loose) timestamp-window behavior, but is
 * now AND'd with content equality rather than acting alone — strict addition,
 * never a replacement. Recurrence aggregation across wide time windows is
 * intentionally NOT done here; it belongs to the (future) episode layer so
 * the owner never loses raw recurrence signal at the evidence-chain stage.
 */
const CONTENT_DEDUPE_PROXIMITY_MS = 1000;

/**
 * Dedupe evidence records so the same real pain signal is not shown twice.
 *
 * Background (PRI-388): a single CLI/manual pain may end up both as a row in
 * trajectory.db.pain_events (shown as `pain_N`, often "recorded-only / unlinked")
 * and as a Runtime V2 canonical pain record (e.g. `manual_*`, shown with full
 * candidate/internalization state). Showing both cards misleads the owner into
 * thinking the same signal is simultaneously "untouched" and "in flight".
 *
 * Lineage policy (reviewer P1): deduping CANNOT rely on timestamp alone OR on
 * content alone — two DIFFERENT real pains can land within 1s (would be wrongly
 * merged by time alone), AND the same pain text can legitimately recur at very
 * different times (would be wrongly merged by content alone, hiding real
 * recurrence signal). We therefore require STRONG lineage evidence before
 * suppressing a trajectory row:
 *
 *   (a) the canonical record's linkedTaskId round-trips to the trajectory pain
 *       id via the `diagnosis_<painId>` convention — a diagnosis task IS the
 *       canonical record for that specific trajectory row; OR
 *   (b) the canonical record and the trajectory record share the same
 *       sourceKind, their normalized summaries match exactly (a content hash,
 *       not a substring contains() — see G.2 / F.3 in shared-constraints),
 *       AND their observedAt timestamps fall within CONTENT_DEDUPE_PROXIMITY_MS
 *       of each other.
 *
 * Either condition is sufficient. Time alone is NEVER a dedupe signal.
 * Content alone is NEVER a dedupe signal. The two are AND'd for condition (b)
 * precisely so that real recurrences (same text, far-apart timestamps) survive.
 *
 * Ordering (reviewer P1-2): the input array is already sorted by observedAt
 * descending. We MUST preserve that order, so we filter in place instead of
 * rebuilding canonical-then-trajectory buckets (which would scramble the sort).
 *
 * Privacy: no raw prompt/chat/trajectory text is exposed beyond what each
 * record already carries (G.2 / F.3 / F.5).
 */
function dedupeRecords(records: EvidenceChainRecord[]): EvidenceChainRecord[] {
  if (records.length === 0) return records;

  // 1. Collect canonical (Runtime V2) records — those that carry a linkedTaskId
  //    and therefore represent the authoritative chain state for their event.
  const canonicalRecords: EvidenceChainRecord[] = [];
  for (const record of records) {
    if (record.linkedTaskId) {
      canonicalRecords.push(record);
    }
  }
  if (canonicalRecords.length === 0) return records;

  // 2. Build a lookup of trajectory pain ids that a canonical task explicitly
  //    references via the `diagnosis_<painId>` round-trip (condition a).
  //    Also build a (sourceKind, normalizedSummary) -> canonical observedAt ms
  //    multi-map for content-hash matching (condition b). We collect ALL
  //    observedAt timestamps per content key so the trajectory-side check can
  //    apply the proximity window — a single global set is unsafe because it
  //    would suppress recurrences logged far outside the canonical's time.
  const diagnosisTrajectoryIds = new Set<string>();
  const canonicalObservedAtByKey = new Map<string, number[]>();

  for (const canonical of canonicalRecords) {
    // Condition (a): linkedTaskId of form `diagnosis_<painId>` where <painId>
    // is itself a trajectory pain id (pain_N).
    const { linkedTaskId } = canonical;
    if (linkedTaskId && linkedTaskId.startsWith('diagnosis_')) {
      const painId = linkedTaskId.slice('diagnosis_'.length);
      if (painId.startsWith('pain_')) {
        diagnosisTrajectoryIds.add(painId);
      }
    }

    // Condition (b) content key: same sourceKind + normalized summary. We fold
    // candidateTitle and rootCauseSummary into the canonical's content signature
    // so a trajectory row whose text matches the candidate title or root cause
    // still dedupes against the canonical card. We collect observedAt ms per
    // key so the trajectory check can require time proximity AND content match.
    const canonicalObservedAtMs = Date.parse(canonical.observedAt);
    if (Number.isNaN(canonicalObservedAtMs)) continue;
    const parts = [
      canonical.summary,
      canonical.candidateTitle,
      canonical.rootCauseSummary,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);
    for (const part of parts) {
      const normalized = normalizeSummaryForDedupe(part);
      if (!normalized) continue;
      const key = `${canonical.sourceKind}||${normalized}`;
      const arr = canonicalObservedAtByKey.get(key);
      if (arr) {
        arr.push(canonicalObservedAtMs);
      } else {
        canonicalObservedAtByKey.set(key, [canonicalObservedAtMs]);
      }
    }
  }

  if (diagnosisTrajectoryIds.size === 0 && canonicalObservedAtByKey.size === 0) {
    return records;
  }

  // 3. Mark trajectory records (no linkedTaskId) that have STRONG lineage to a
  //    canonical record. Only strong lineage suppresses a row. For condition
  //    (b), strong lineage = same sourceKind + same normalized summary +
  //    observedAt within CONTENT_DEDUPE_PROXIMITY_MS. Content alone or time
  //    alone is never sufficient.
  const idsToRemove = new Set<string>();
  for (const record of records) {
    if (record.linkedTaskId) continue; // canonical records are never removed

    let suppress = false;

    // Condition (a): trajectory id explicitly referenced by a diagnosis_* task.
    // This is the strongest lineage — a diagnosis task IS the canonical record
    // for that specific trajectory row.
    if (diagnosisTrajectoryIds.has(record.id)) {
      suppress = true;
    }

    // Condition (b): same sourceKind + normalized summary hash AND observedAt
    // within the proximity window. Without the time-window gate, an owner who
    // logs the same pain today AND tomorrow (a real recurrence) would have the
    // second trajectory row silently deleted whenever any canonical task shares
    // its content — losing the recurrence signal that episode judgement needs.
    if (!suppress) {
      const normalized = normalizeSummaryForDedupe(record.summary);
      if (normalized) {
        const key = `${record.sourceKind}||${normalized}`;
        const candidates = canonicalObservedAtByKey.get(key);
        if (candidates && candidates.length > 0) {
          const tMs = Date.parse(record.observedAt);
          if (
            !Number.isNaN(tMs) &&
            candidates.some(c => Math.abs(c - tMs) <= CONTENT_DEDUPE_PROXIMITY_MS)
          ) {
            suppress = true;
          }
        }
      }
    }

    if (suppress) {
      idsToRemove.add(record.id);
    }
  }

  if (idsToRemove.size === 0) return records;

  // 4. Filter in place to preserve the observedAt-descending sort order.
  return records.filter(record => !idsToRemove.has(record.id));
}

// ── Dynamic Assembly Mapper (Pure logic) ──────────────────────────────────────

export interface CandidateInfo {
  candidateId: string;
  title?: string;
  description?: string;
  confidence?: number;
  recommendationKind?: string;
}

export interface DreamerTaskInfo {
  taskId: string;
  status: string;
}

export interface LedgerPrinciple {
  id: string;
  derivedFromPainIds?: string[];
  text?: string;
  status?: string;
  createdAt?: string;
}

export function assembleEvidenceChain(params: {
  workspaceDir: string;
  painEvents: unknown[];
  tasks: unknown[];
  candidates: unknown[];
  dreamerTasks: unknown[];
  ledgerPrinciples: LedgerPrinciple[];
  trajectoryDbAvailable: boolean;
  stateDbAvailable: boolean;
  degradedReasons?: string[];
  degradedNextActions?: string[];
  /**
   * PRI-469: Diagnostician artifacts (rows from the `artifacts` table where
   * artifact_kind = 'diagnostician_output'). Each row is treated as untrusted
   * `unknown` and must have `task_id` (string) and `content_json` (string of
   * JSON containing the DiagnosticianOutputV1 with optional `rootCause` and
   * `intentTension`).
   *
   * Production architecture: DiagnosticianCommitter writes the full Stage C
   * output to the artifacts table, NOT to tasks.diagnostic_json. The artifact
   * is the canonical source for both rootCause and intentTension.
   * tasks.diagnostic_json remains as a test-fixture fallback only.
   */
  diagnosticArtifacts?: unknown[];
}): EvidenceChainResponse {
  const {
    workspaceDir,
    painEvents: rawPainEvents,
    tasks: rawTasks,
    candidates: rawCandidates,
    dreamerTasks: rawDreamerTasks,
    ledgerPrinciples,
    trajectoryDbAvailable,
    stateDbAvailable,
    diagnosticArtifacts: rawDiagnosticArtifacts,
  } = params;

  const generatedAt = new Date().toISOString();
  const records: EvidenceChainRecord[] = [];
  const degradedReasons = params.degradedReasons ? [...params.degradedReasons] : [];
  const degradedNextActions = params.degradedNextActions ? [...params.degradedNextActions] : [];

  // Coerce untrusted arrays using element-wise guards (ERR-001/005/007)
  const painEvents = rawPainEvents.filter(isRecord);
  const tasks = rawTasks.filter(isRecord);
  const candidates = rawCandidates.filter(isRecord);
  const dreamerTasks = rawDreamerTasks.filter(isRecord);
  const diagnosticArtifacts = (rawDiagnosticArtifacts ?? []).filter(isRecord);

  // PRI-469: Build artifact lookup by task_id. Each artifact row has
  // { task_id: string, content_json: string }. content_json holds the
  // DiagnosticianOutputV1 JSON (including rootCause and optional intentTension).
  // Artifact is the CANONICAL source; tasks.diagnostic_json is a fallback.
  const artifactByTaskId = new Map<string, Record<string, unknown>>();
  for (const artifact of diagnosticArtifacts) {
    const taskId = readOwnString(artifact, 'task_id');
    if (!taskId) continue;
    // First artifact wins — duplicate task_ids should not happen, but if they
    // do we keep the first to avoid silent data swapping (ERR-015).
    if (!artifactByTaskId.has(taskId)) {
      artifactByTaskId.set(taskId, artifact);
    }
  }

  // 1. Process tasks into a map
  const taskMap = new Map<string, TaskMapEntry>();
  for (const task of tasks) {
    const taskId = readOwnString(task, 'task_id') ?? '';
    const inputRefRaw = getOwnValue(task, 'input_ref');
    const inputRef = isString(inputRefRaw) ? inputRefRaw : undefined;

    let painId: string;
    if (inputRef) {
      painId = /^\d+$/.test(inputRef) ? `pain_${inputRef}` : inputRef;
    } else {
      painId = taskId.startsWith('diagnosis_') ? taskId.slice('diagnosis_'.length) : taskId;
    }

    // PRI-469: Extract rootCause and intentTension from the diagnostician
    // artifact (canonical source). Artifact takes precedence over
    // tasks.diagnostic_json, which is kept only as a test-fixture fallback.
    let rootCauseSummary: string | undefined;
    let intentTension: IntentTension | undefined;
    let artifactDegraded = false;
    let diagnosticJsonDegraded = false;

    const artifact = taskId ? artifactByTaskId.get(taskId) : undefined;
    if (artifact) {
      const contentJson = readOwnString(artifact, 'content_json');
      if (typeof contentJson === 'string') {
        try {
          const parsed: unknown = JSON.parse(contentJson);
          if (isRecord(parsed)) {
            // rootCause from artifact (canonical, takes precedence).
            // The artifact stores DiagnosticianOutputV1 where rootCause is an
            // object: { summary: string, confidence: number, ... }. Legacy
            // test fixtures may store rootCause as a plain string. Handle both.
            const artifactRootCause = getOwnValue(parsed, 'rootCause');
            if (typeof artifactRootCause === 'string') {
              rootCauseSummary = artifactRootCause;
            } else if (isRecord(artifactRootCause)) {
              const rootCauseSummaryValue = getOwnValue(artifactRootCause, 'summary');
              if (typeof rootCauseSummaryValue === 'string') {
                rootCauseSummary = rootCauseSummaryValue;
              }
            }
            // intentTension from artifact — validated with runtime guards.
            // Only extract when the key is present (optional field).
            if (Object.hasOwn(parsed, 'intentTension')) {
              const validated = validateIntentTension(getOwnValue(parsed, 'intentTension'));
              if (validated) {
                intentTension = validated;
              } else {
                // intentTension was present but malformed — degrade visibly
                // (ERR-002). rootCause may still be valid, so we do NOT clobber
                // it; we only flag the artifact as partially degraded.
                artifactDegraded = true;
              }
            }
          } else {
            // content_json parsed but not an object — degrade.
            artifactDegraded = true;
          }
        } catch {
          // content_json is not valid JSON — degrade. rootCause and
          // intentTension both unavailable from the artifact.
          artifactDegraded = true;
        }
      } else {
        // content_json missing or not a string — degrade.
        artifactDegraded = true;
      }
    }

    // Fallback: tasks.diagnostic_json (test-fixture compat). Only used when
    // the artifact did not provide a rootCause.
    if (rootCauseSummary === undefined) {
      const dj = getOwnValue(task, 'diagnostic_json');
      if (isString(dj)) {
        try {
          const parsed = JSON.parse(dj);
          if (isRecord(parsed) && Object.hasOwn(parsed, 'rootCause') && isString(parsed.rootCause)) {
            rootCauseSummary = parsed.rootCause;
          }
        } catch {
          diagnosticJsonDegraded = true;
        }
      }
    }

    taskMap.set(painId, {
      taskId,
      status: readOwnString(task, 'status') ?? 'unknown',
      lastError: readOwnString(task, 'last_error') ?? null,
      createdAt: readOwnString(task, 'created_at') ?? '',
      rootCauseSummary,
      diagnosticJsonDegraded,
      inputRef,
      intentTension,
      artifactDegraded,
    });
  }

  // 2. Build dreamer map
  const dreamerMap = new Map<string, DreamerTaskInfo>();
  for (const task of dreamerTasks) {
    const taskId = readOwnString(task, 'task_id') ?? '';
    const status = readOwnString(task, 'status') ?? 'unknown';
    if (taskId.startsWith('dreamer-')) {
      const rest = taskId.slice('dreamer-'.length);
      const lastDash = rest.lastIndexOf('-');
      if (lastDash > 0) {
        const candidateId = rest.slice(0, lastDash);
        if (candidateId && !dreamerMap.has(candidateId)) {
          dreamerMap.set(candidateId, { taskId, status });
        }
      }
    }
  }

  // 3. Build candidates map and reverse lookups
  const taskIdToPainId = new Map<string, string>();
  for (const [pId, entry] of taskMap) {
    taskIdToPainId.set(entry.taskId, pId);
    const normResult = normalizeDiagnosticianTaskId(entry.taskId);
    if (normResult.success && normResult.normalized) {
      taskIdToPainId.set(normResult.normalized, pId);
    }
  }

  const candidateMap = new Map<string, CandidateInfo>();
  const candidateByTaskId = new Map<string, CandidateInfo>();

  for (const c of candidates) {
    const candidateId = readOwnString(c, 'candidate_id') ?? '';
    if (!candidateId) continue;

    const rawTaskId = readOwnString(c, 'task_id') ?? '';
    const normResult = normalizeDiagnosticianTaskId(rawTaskId);
    if (!normResult.success || !normResult.normalized) {
      if (normResult.reason) degradedReasons.push(normResult.reason);
      if (normResult.nextAction) degradedNextActions.push(normResult.nextAction);
      continue;
    }

    const taskId = normResult.normalized;
    let painId = taskIdToPainId.get(taskId) ?? '';
    if (!painId && taskId.startsWith('diagnosis_')) {
      painId = taskId.slice('diagnosis_'.length);
    }

    const info: CandidateInfo = {
      candidateId,
      title: readOwnString(c, 'title'),
      description: readOwnString(c, 'description'),
      confidence: typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : undefined,
      recommendationKind: readOwnString(c, 'recommendation_kind'),
    };

    if (painId) candidateMap.set(painId, info);
    if (taskId) candidateByTaskId.set(taskId, info);
  }

  // 4. Map ledger principles to painId
  const painToPrincipleMap = new Map<string, string>();
  const principleStatusMap = new Map<string, string>();
  for (const p of ledgerPrinciples) {
    if (p.status) {
      principleStatusMap.set(p.id, p.status);
    }
    for (const pId of p.derivedFromPainIds ?? []) {
      painToPrincipleMap.set(pId, p.id);
    }
  }

  // 5. Assemble records
  const painEventMeta: { painId: string; createdAt: string; source: string }[] = [];
  const directMatchedPainIds = new Set<string>();

  for (const event of painEvents) {
    const eventId = coerceToString(event.id);
    if (!eventId) continue;

    const source = readOwnString(event, 'source') ?? 'unknown';
    const reason = readOwnString(event, 'reason') ?? '';
    const text = readOwnString(event, 'text') ?? '';
    const createdAt = readOwnString(event, 'created_at') ?? '';
    const score = typeof event.score === 'number' ? event.score : 0;
    // PRI-406: Read canonical_pain_id and runtime_task_id from pain_events
    const canonicalPainId = readOwnString(event, 'canonical_pain_id');
    const runtimeTaskId = readOwnString(event, 'runtime_task_id');

    const sourceKind = mapSourceKind(source);
    const painId = `pain_${eventId}`;
    painEventMeta.push({ painId, createdAt, source });

    // PRI-625 Slice D: evidence host attribution from pain_events.host_kind
    // (PRI-640 column). Unknown/legacy rows (pre-migration) degrade to
    // 'unknown' — a missing host kind must not hide the record (§15: safe
    // lineage, no silent drops).
    const rawHostKind = readOwnString(event, 'host_kind');
    const hostKind: 'openclaw' | 'codex' | 'unknown' =
      rawHostKind === 'openclaw' || rawHostKind === 'codex' ? rawHostKind : 'unknown';

    // PRI-406: Prefer precise join via canonical_pain_id → tasks.input_ref.
    // When a pain event carries canonical_pain_id, look up the task by that ID
    // first (the taskMap key is derived from input_ref, which equals canonical_pain_id).
    // This is the authoritative join path — no timestamp/content heuristic needed.
    let linkedTask = taskMap.get(painId);
    let linkMode: 'canonical' | 'legacy' | undefined;

    if (canonicalPainId) {
      const canonicalTask = taskMap.get(canonicalPainId);
      if (canonicalTask) {
        linkedTask = canonicalTask;
        linkMode = 'canonical';
      } else if (runtimeTaskId) {
        // Fallback: try to find task by runtimeTaskId in taskMap values
        for (const [, entry] of taskMap.entries()) {
          if (entry.taskId === runtimeTaskId) {
            linkedTask = entry;
            linkMode = 'canonical';
            break;
          }
        }
      }
    }

    if (linkedTask) {
      directMatchedPainIds.add(painId);
      if (!linkMode) {
        linkMode = 'legacy';
      }
    }
    const linkedCandidate = candidateMap.get(painId)
      || (canonicalPainId ? candidateMap.get(canonicalPainId) : undefined)
      || (linkedTask ? candidateByTaskId.get(linkedTask.taskId) : undefined);
    const linkedPrincipleId = painToPrincipleMap.get(painId)
      || (canonicalPainId ? painToPrincipleMap.get(canonicalPainId) : undefined);
    const ledgerPrincipleStatus = linkedPrincipleId ? principleStatusMap.get(linkedPrincipleId) : undefined;
    const dreamerInfo = linkedCandidate ? dreamerMap.get(linkedCandidate.candidateId) : undefined;

    const state = determineState({
      sourceKind,
      taskStatus: linkedTask?.status,
      hasCandidate: !!linkedCandidate,
      dreamerStatus: dreamerInfo?.status,
      ledgerPrincipleStatus,
    });

    const rawSummary = resolveSummary({
      candidateTitle: linkedCandidate?.title,
      rootCauseSummary: linkedTask?.rootCauseSummary,
      painText: text,
      painReason: reason,
      fallback: `Pain signal (source: ${source}, score: ${score})`,
    });

    const record: EvidenceChainRecord = {
      id: painId,
      sourceKind,
      observedAt: createdAt,
      state,
      summary: rawSummary,
      admissionDecision: inferAdmissionDecision(sourceKind),
    };

    // PRI-406: Set canonical identity and link mode
    if (canonicalPainId) {
      record.canonicalPainId = canonicalPainId;
    }
    record.hostKind = hostKind;
    if (runtimeTaskId) {
      record.runtimeTaskId = runtimeTaskId;
    }
    if (linkMode) {
      record.linkMode = linkMode;
    }

    // PRI-406: When a pain event is linked via canonical_pain_id, also mark
    // the canonical ID as covered so step 6 doesn't create a duplicate record
    // for the same task.
    if (canonicalPainId && linkedTask) {
      directMatchedPainIds.add(canonicalPainId);
    }

    if (linkedCandidate) {
      record.linkedCandidateId = linkedCandidate.candidateId;
      if (linkedCandidate.title) record.candidateTitle = linkedCandidate.title;
      if (linkedCandidate.description) record.candidateSummary = linkedCandidate.description;
      if (linkedCandidate.confidence !== undefined) record.confidence = linkedCandidate.confidence;
      if (linkedCandidate.recommendationKind) record.recommendationKind = linkedCandidate.recommendationKind;
    }

    if (linkedTask) {
      record.linkedTaskId = linkedTask.taskId;
      record.linkedTaskStatus = linkedTask.status;
      if (linkedTask.rootCauseSummary) {
        record.rootCauseSummary = linkedTask.rootCauseSummary;
      }
      if (linkedTask.lastError && (state === 'diagnosis-failed' || state === 'diagnosis-retry-wait')) {
        record.failureReason = linkedTask.lastError;
      }
      if (linkedTask.diagnosticJsonDegraded) {
        record.degradedReason = 'Diagnostic data for this record could not be parsed';
      }
      // PRI-469: surface intentTension from the diagnostician artifact.
      if (linkedTask.intentTension) {
        record.intentTension = linkedTask.intentTension;
      }
      // PRI-469: artifact degraded (content_json unparseable or intentTension
      // malformed) — degrade visibly (ERR-002). Do not clobber an existing
      // degradedReason from diagnosticJsonDegraded; append instead.
      if (linkedTask.artifactDegraded && !record.degradedReason) {
        record.degradedReason = 'Diagnostician artifact for this record could not be fully parsed; intentTension may be unavailable.';
      }
    }

    if (dreamerInfo) {
      record.internalizationTaskId = dreamerInfo.taskId;
      record.dreamerTaskStatus = dreamerInfo.status;
    }

    if (linkedPrincipleId) {
      record.linkedPrincipleId = linkedPrincipleId;
    }

    // Generate nextAction from state
    record.nextAction = determineNextAction({ state, workspaceDir, recordId: painId, linkedTaskId: linkedTask?.taskId });

    if (!linkedTask && stateDbAvailable && taskMap.size > 0) {
      // PRI-406: Rows without canonical_pain_id that have no linked task
      // continue to get the "Could not link" banner (same as before).
      // Rows WITH canonical_pain_id that have no linked task also get the
      // banner — this is a real problem since the precise join should have worked.
      // The linkMode field distinguishes the linking strategy used.
      continue;
    }

    records.push(record);
  }

  // 5b. Proximity Cross-Referencing for Unmatched Pain Events
  const crossRefMap = crossReferenceByTimestamp(painEventMeta, taskMap, directMatchedPainIds);
  // Tasks whose cross-ref is backed by STRONG lineage (content hash match
  // between trajectory text and task candidate title / root cause). These
  // are NOT added to the weak crossRefTaskIds set, so step 6 will emit the
  // canonical task-id record for them. (PRI-388 reviewer P1: dedupe must
  // rely on strong lineage, not timestamp alone.)
  const strongMatchedTaskIds = new Set<string>();

  for (const event of painEvents) {
    const eventId = coerceToString(event.id);
    if (!eventId) continue;
    const painId = `pain_${eventId}`;
    if (directMatchedPainIds.has(painId)) continue;

    const crossRefTask = crossRefMap.get(painId);
    if (!crossRefTask) {
      if (stateDbAvailable && taskMap.size > 0) {
        const source = readOwnString(event, 'source') ?? 'unknown';
        const reason = readOwnString(event, 'reason') ?? '';
        const text = readOwnString(event, 'text') ?? '';
        const createdAt = readOwnString(event, 'created_at') ?? '';
        const score = typeof event.score === 'number' ? event.score : 0;
        const sourceKind = mapSourceKind(source);
        // PRI-406: Read canonical fields
        const eventCanonicalPainId = readOwnString(event, 'canonical_pain_id');
        const eventRuntimeTaskId = readOwnString(event, 'runtime_task_id');

        // No linked task/candidate: state is admission-driven. tool_call/hook observations
        // are `evidence-only`; manual/review are `recorded-only`. (PRI-385 P1-2)
        const unmatchedState = determineState({ sourceKind, hasCandidate: false });

        const record: EvidenceChainRecord = {
          id: painId,
          sourceKind,
          observedAt: createdAt,
          state: unmatchedState,
          summary: text || reason || `Pain signal (source: ${source}, score: ${score})`,
          admissionDecision: inferAdmissionDecision(sourceKind),
        };

        // PRI-406: Set canonical identity fields
        if (eventCanonicalPainId) {
          record.canonicalPainId = eventCanonicalPainId;
        }
        if (eventRuntimeTaskId) {
          record.runtimeTaskId = eventRuntimeTaskId;
        }

        // PRI-406: Both canonical and legacy unlinked rows get the same
        // "Could not link" banner (ERR-002). The linkMode field distinguishes
        // the linking strategy used; legacy rows additionally get linkMode='legacy'.
        record.degradedReason = 'Could not link this pain event to a diagnostician task. The chain may be incomplete.';
        record.nextAction = `Check Runtime V2 pipeline status. The diagnostician task may have a different pain ID format.`;
        if (!eventCanonicalPainId) {
          record.linkMode = 'legacy';
        }
        degradedReasons.push(`Pain event ${painId} could not be linked to a diagnostician task.`);
        degradedNextActions.push('Check Runtime V2 pipeline status for unmatched pain ID formats.');
        records.push(record);
      }
      continue;
    }

    // ── Strong-lineage gate (PRI-388 reviewer P1) ────────────────────────
    // If the trajectory event's text strongly matches the cross-referenced
    // task's candidate title or root cause (a content hash, NOT timestamp
    // alone), they describe the SAME real event. Skip emitting a
    // trajectory-id (pain_<N>) record here; step 6 will emit the canonical
    // task-id record instead. This prevents two cards for one event while
    // still emitting trajectory-id records for genuine timestamp-only
    // (weak) cross-refs where content does not match.
    const trajText = readOwnString(event, 'text') ?? '';
    const trajReason = readOwnString(event, 'reason') ?? '';
    const trajectoryContentKey = normalizeSummaryForDedupe(trajText || trajReason);
    if (trajectoryContentKey) {
      const crossCandidate = candidateByTaskId.get(crossRefTask.taskId);
      const taskContentFields = [
        crossRefTask.rootCauseSummary,
        crossCandidate?.title,
      ].filter((v): v is string => typeof v === 'string' && v.length > 0);
      const isStrongLineageMatch = taskContentFields.some(
        c => normalizeSummaryForDedupe(c) === trajectoryContentKey
      );
      if (isStrongLineageMatch) {
        strongMatchedTaskIds.add(crossRefTask.taskId);
        continue;
      }
    }

    const source = readOwnString(event, 'source') ?? 'unknown';
    const reason = readOwnString(event, 'reason') ?? '';
    const text = readOwnString(event, 'text') ?? '';
    const createdAt = readOwnString(event, 'created_at') ?? '';
    const score = typeof event.score === 'number' ? event.score : 0;
    const sourceKind = mapSourceKind(source);
    // PRI-406: Read canonical fields for cross-ref records
    const eventCanonicalPainId = readOwnString(event, 'canonical_pain_id');
    const eventRuntimeTaskId = readOwnString(event, 'runtime_task_id');

    const linkedCandidate = candidateMap.get(painId)
      || (eventCanonicalPainId ? candidateMap.get(eventCanonicalPainId) : undefined)
      || candidateByTaskId.get(crossRefTask.taskId);
    const linkedPrincipleId = painToPrincipleMap.get(painId)
      || (eventCanonicalPainId ? painToPrincipleMap.get(eventCanonicalPainId) : undefined);
    const ledgerPrincipleStatus = linkedPrincipleId ? principleStatusMap.get(linkedPrincipleId) : undefined;
    const dreamerInfo = linkedCandidate ? dreamerMap.get(linkedCandidate.candidateId) : undefined;

    const state = determineState({
      sourceKind,
      taskStatus: crossRefTask.status,
      hasCandidate: !!linkedCandidate,
      dreamerStatus: dreamerInfo?.status,
      ledgerPrincipleStatus,
    });

    const rawSummary = resolveSummary({
      candidateTitle: linkedCandidate?.title,
      rootCauseSummary: crossRefTask.rootCauseSummary,
      painText: text,
      painReason: reason,
      fallback: `Pain signal (source: ${source}, score: ${score})`,
    });

    const record: EvidenceChainRecord = {
      id: painId,
      sourceKind,
      observedAt: createdAt,
      state,
      summary: rawSummary,
      admissionDecision: inferAdmissionDecision(sourceKind),
      linkedTaskId: crossRefTask.taskId,
      linkedTaskStatus: crossRefTask.status,
      linkMode: 'legacy', // Cross-ref is always legacy (timestamp heuristic)
    };

    // PRI-406: Set canonical identity fields
    if (eventCanonicalPainId) {
      record.canonicalPainId = eventCanonicalPainId;
    }
    if (eventRuntimeTaskId) {
      record.runtimeTaskId = eventRuntimeTaskId;
    }

    if (linkedCandidate) {
      record.linkedCandidateId = linkedCandidate.candidateId;
      if (linkedCandidate.title) record.candidateTitle = linkedCandidate.title;
      if (linkedCandidate.description) record.candidateSummary = linkedCandidate.description;
      if (linkedCandidate.confidence !== undefined) record.confidence = linkedCandidate.confidence;
      if (linkedCandidate.recommendationKind) record.recommendationKind = linkedCandidate.recommendationKind;
    }

    if (crossRefTask.rootCauseSummary) {
      record.rootCauseSummary = crossRefTask.rootCauseSummary;
    }
    // PRI-469: surface intentTension from the cross-referenced task's artifact.
    if (crossRefTask.intentTension) {
      record.intentTension = crossRefTask.intentTension;
    }

    if (crossRefTask.lastError && (state === 'diagnosis-failed' || state === 'diagnosis-retry-wait')) {
      record.failureReason = crossRefTask.lastError;
    }

    if (dreamerInfo) {
      record.internalizationTaskId = dreamerInfo.taskId;
      record.dreamerTaskStatus = dreamerInfo.status;
    }

    if (linkedPrincipleId) {
      record.linkedPrincipleId = linkedPrincipleId;
    }

    record.nextAction = determineNextAction({ state, workspaceDir, recordId: painId, linkedTaskId: crossRefTask.taskId });

    if (crossRefTask.diagnosticJsonDegraded) {
      record.degradedReason = 'Diagnostic data for this record could not be parsed';
    }
    // PRI-469: artifact degraded — degrade visibly (ERR-002).
    if (crossRefTask.artifactDegraded && !record.degradedReason) {
      record.degradedReason = 'Diagnostician artifact for this record could not be fully parsed; intentTension may be unavailable.';
    }

    records.push(record);
  }

  // 6. Include tasks that have no matching pain_event (e.g. CLI direct records)
  const coveredPainIds = new Set(records.map(r => r.id));
  // PRI-406: Also consider canonicalPainId as covered to prevent step 6 from
  // creating a duplicate record for the same task that step 5 already linked.
  for (const r of records) {
    if (r.canonicalPainId) {
      coveredPainIds.add(r.canonicalPainId);
    }
  }
  // Only WEAK cross-refs (timestamp-only) block step 6 from creating a
  // task-id record. Strong-lineage cross-refs deferred in step 5b so the
  // canonical task-id form is shown. (PRI-388 reviewer P1.)
  const crossRefTaskIds = new Set<string>();
  for (const entry of crossRefMap.values()) {
    if (strongMatchedTaskIds.has(entry.taskId)) continue;
    crossRefTaskIds.add(entry.taskId);
  }

  for (const [painId, task] of taskMap.entries()) {
    if (coveredPainIds.has(painId)) continue;
    if (crossRefTaskIds.has(task.taskId)) continue;

    const linkedCandidate = candidateMap.get(painId);
    const linkedPrincipleId = painToPrincipleMap.get(painId);
    const ledgerPrincipleStatus = linkedPrincipleId ? principleStatusMap.get(linkedPrincipleId) : undefined;
    const dreamerInfo = linkedCandidate ? dreamerMap.get(linkedCandidate.candidateId) : undefined;

    const state = determineState({
      sourceKind: 'manual',
      taskStatus: task.status,
      hasCandidate: !!linkedCandidate,
      dreamerStatus: dreamerInfo?.status,
      ledgerPrincipleStatus,
    });

    const rawSummary = resolveSummary({
      candidateTitle: linkedCandidate?.title,
      rootCauseSummary: task.rootCauseSummary,
      fallback: `Manual pain signal (task: ${task.taskId})`,
    });

    const record: EvidenceChainRecord = {
      id: painId,
      sourceKind: 'manual',
      observedAt: task.createdAt,
      state,
      summary: rawSummary,
      admissionDecision: 'store_signal',
      linkedTaskId: task.taskId,
      linkedTaskStatus: task.status,
      // PRI-406: Task-only records from Runtime V2 are canonical-linked
      // (their painId IS the canonical pain identity, e.g. manual_*)
      canonicalPainId: painId.startsWith('pain_') ? undefined : painId,
      linkMode: 'canonical',
    };

    if (linkedCandidate) {
      record.linkedCandidateId = linkedCandidate.candidateId;
      if (linkedCandidate.title) record.candidateTitle = linkedCandidate.title;
      if (linkedCandidate.description) record.candidateSummary = linkedCandidate.description;
      if (linkedCandidate.confidence !== undefined) record.confidence = linkedCandidate.confidence;
      if (linkedCandidate.recommendationKind) record.recommendationKind = linkedCandidate.recommendationKind;
    }

    if (task.rootCauseSummary) {
      record.rootCauseSummary = task.rootCauseSummary;
    }
    // PRI-469: surface intentTension from the task's diagnostician artifact.
    if (task.intentTension) {
      record.intentTension = task.intentTension;
    }

    if (task.lastError && (state === 'diagnosis-failed' || state === 'diagnosis-retry-wait')) {
      record.failureReason = task.lastError;
    }

    if (dreamerInfo) {
      record.internalizationTaskId = dreamerInfo.taskId;
      record.dreamerTaskStatus = dreamerInfo.status;
    }

    if (linkedPrincipleId) {
      record.linkedPrincipleId = linkedPrincipleId;
    }

    record.nextAction = determineNextAction({ state, workspaceDir, recordId: painId, linkedTaskId: task.taskId });

    if (task.diagnosticJsonDegraded) {
      record.degradedReason = 'Diagnostic data for this record could not be parsed';
    }
    // PRI-469: artifact degraded — degrade visibly (ERR-002).
    if (task.artifactDegraded && !record.degradedReason) {
      record.degradedReason = 'Diagnostician artifact for this record could not be fully parsed; intentTension may be unavailable.';
    }

    records.push(record);
  }

  // Sort by observedAt descending
  records.sort((a, b) => b.observedAt.localeCompare(a.observedAt));

  // 7. Dedupe: Runtime V2 canonical pain (has linkedTaskId) takes precedence over trajectory pain rows
  // When the same real pain signal appears as both a trajectory pain (pain_N) and a
  // Runtime V2 canonical pain (manual_*), show only the canonical record with full chain state.
  // This prevents misleading "unlinked" and "candidate" cards for the same event.
  const dedupedRecords = dedupeRecords(records);

  const response: EvidenceChainResponse = {
    records: dedupedRecords,
    generatedAt,
  };

  // Group unmatched pain event warnings (PRI-382)
  if (degradedReasons.length > 0) {
    const unmatchedPainIds: string[] = [];
    const otherReasons: string[] = [];
    const unmatchedPainRegex = /^Pain event (.*) could not be linked to a diagnostician task\.$/;

    for (const reason of degradedReasons) {
      const match = unmatchedPainRegex.exec(reason);
      if (match && match[1]) {
        unmatchedPainIds.push(match[1]);
      } else {
        otherReasons.push(reason);
      }
    }

    const finalReasons: string[] = [];
    if (unmatchedPainIds.length > 0) {
      if (unmatchedPainIds.length === 1) {
        finalReasons.push(`Pain event ${unmatchedPainIds[0]} could not be linked to a diagnostician task.`);
      } else {
        finalReasons.push(
          `${unmatchedPainIds.length} evidence records could not be linked to diagnostician tasks. Showing per-record details below.`,
        );
      }
    }

    const uniqueOtherReasons = Array.from(new Set(otherReasons));
    finalReasons.push(...uniqueOtherReasons);

    response.degradedReason = finalReasons.join('; ');

    const uniqueNextActions = Array.from(new Set(degradedNextActions));
    response.nextAction = uniqueNextActions.join(' ');
  }

  if (records.length === 0 && trajectoryDbAvailable && stateDbAvailable) {
    response.note = 'PD has not captured any displayable behavior evidence in this workspace yet.';
  }

  return response;
}
