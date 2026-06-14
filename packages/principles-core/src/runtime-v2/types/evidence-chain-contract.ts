/**
 * EvidenceChainContract — shared core contracts and assembly mapper for
 * the Pain Evidence Chain (PRI-385).
 *
 * This file is purely logical (no fs, db, or network dependencies) and
 * lives inside principles-core to be shared by Console read models,
 * CLI commands, and test fixtures.
 */

import { Type } from '@sinclair/typebox';

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

    let rootCauseSummary: string | undefined;
    let diagnosticJsonDegraded = false;
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

    taskMap.set(painId, {
      taskId,
      status: readOwnString(task, 'status') ?? 'unknown',
      lastError: readOwnString(task, 'last_error') ?? null,
      createdAt: readOwnString(task, 'created_at') ?? '',
      rootCauseSummary,
      diagnosticJsonDegraded,
      inputRef,
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

    const sourceKind = mapSourceKind(source);
    const painId = `pain_${eventId}`;
    painEventMeta.push({ painId, createdAt, source });

    const linkedTask = taskMap.get(painId);
    if (linkedTask) {
      directMatchedPainIds.add(painId);
    }
    const linkedCandidate = candidateMap.get(painId);
    const linkedPrincipleId = painToPrincipleMap.get(painId);
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
          degradedReason: 'Could not link this pain event to a diagnostician task. The chain may be incomplete.',
          nextAction: `Check Runtime V2 pipeline status. The diagnostician task may have a different pain ID format.`,
        };
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

    const linkedCandidate = candidateMap.get(painId) || candidateByTaskId.get(crossRefTask.taskId);
    const linkedPrincipleId = painToPrincipleMap.get(painId);
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
    };

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

    records.push(record);
  }

  // 6. Include tasks that have no matching pain_event (e.g. CLI direct records)
  const coveredPainIds = new Set(records.map(r => r.id));
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
