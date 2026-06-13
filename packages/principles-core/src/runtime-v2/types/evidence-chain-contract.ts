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
  if (admission === 'store_signal') {
    return 'recorded-only';
  }
  return 'recorded-only'; // All evidence-only also defaults to recorded-only
}

export function determineNextAction(state: EvidenceChainState, workspaceDir: string): string | undefined {
  const ws = workspaceDir;
  switch (state) {
    case 'diagnosis-retry-wait':
      return `Diagnosis is waiting for automatic retry. Run: pd pain retry --workspace "${ws}" to force retry.`;
    case 'diagnosis-failed':
      return `Diagnosis failed. Check the error details and retry if appropriate, or run: pd pain retry --workspace "${ws}"`;
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
    record.nextAction = determineNextAction(state, workspaceDir);

    if (!linkedTask && stateDbAvailable && taskMap.size > 0) {
      continue;
    }

    records.push(record);
  }

  // 5b. Proximity Cross-Referencing for Unmatched Pain Events
  const crossRefMap = crossReferenceByTimestamp(painEventMeta, taskMap, directMatchedPainIds);

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

        const record: EvidenceChainRecord = {
          id: painId,
          sourceKind,
          observedAt: createdAt,
          state: 'recorded-only',
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

    record.nextAction = determineNextAction(state, workspaceDir);

    if (crossRefTask.diagnosticJsonDegraded) {
      record.degradedReason = 'Diagnostic data for this record could not be parsed';
    }

    records.push(record);
  }

  // 6. Include tasks that have no matching pain_event (e.g. CLI direct records)
  const coveredPainIds = new Set(records.map(r => r.id));
  const crossRefTaskIds = new Set<string>();
  for (const entry of crossRefMap.values()) {
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

    record.nextAction = determineNextAction(state, workspaceDir);

    if (task.diagnosticJsonDegraded) {
      record.degradedReason = 'Diagnostic data for this record could not be parsed';
    }

    records.push(record);
  }

  // Sort by observedAt descending
  records.sort((a, b) => b.observedAt.localeCompare(a.observedAt));

  const response: EvidenceChainResponse = {
    records,
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
