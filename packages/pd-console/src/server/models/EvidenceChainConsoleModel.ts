/**
 * EvidenceChainConsoleModel — read model for the Behavior Evidence page.
 *
 * Reads real pain/evidence/diagnosis chain data from:
 * - pain_events table in trajectory.db
 * - tasks table in state.db (diagnostician tasks)
 * - principle_candidates table in state.db
 * - principle ledger JSON
 *
 * Returns structured EvidenceChainRecord items that the frontend can
 * render as single-record cards with proper state grouping.
 *
 * Privacy boundary (G.2 / F.3 / F.5):
 * - No raw prompt, chat, trajectory, token, full absolute path, or stack trace
 * - All summaries go through sanitizeString from evidence-sanitizer
 * - Degraded paths include structured reason + nextAction (ERR-002)
 *
 * ERR checklist:
 * - ERR-001/005: All DB rows treated as unknown, runtime validation with typeof guards
 * - ERR-002: Degraded paths include reason + nextAction, never silent fallback
 * - ERR-009/010: Required fields fail loud
 * - ERR-014/016/017: Evidence previews bounded via sanitizeString
 * - ERR-013: Use Object.hasOwn() for untrusted object keys
 */

import { SqliteConnection, sanitizeString } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────────────

export type EvidenceChainState =
  | 'evidence_only'
  | 'pain_recorded'
  | 'diagnosis_queued'
  | 'diagnosis_running'
  | 'diagnosis_succeeded'
  | 'diagnosis_failed'
  | 'diagnosis_retry_wait'
  | 'candidate_generated'
  | 'internalization_started';

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
  /** PRI-340: human-readable evidence fields (all optional for backward compat) */
  candidateTitle?: string;
  candidateSummary?: string;
  rootCauseSummary?: string;
  confidence?: number;
  recommendationKind?: string;
  /** PRI-380: internalization pipeline linkage */
  internalizationTaskId?: string;
  dreamerTaskStatus?: string;
}

export interface EvidenceChainResponse {
  records: EvidenceChainRecord[];
  generatedAt: string;
  /** Present when data sources are degraded rather than genuinely empty */
  degradedReason?: string;
  nextAction?: string;
  /** Present when evidence-only sources exist but no pain signals */
  note?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Runtime type guard: check if a value is a plain object (Record<string, unknown>).
 * Rejects null, arrays, primitives. Used instead of `as Record<string, unknown>`
 * on untrusted DB rows and parsed JSON (ERR-001/005).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce an array of unknown values (e.g. better-sqlite3 .all() result)
 * into an array of Record<string, unknown> with runtime validation.
 * Filters out any non-record entries instead of casting the whole array (ERR-001).
 */
function coerceRowsToRecords(rows: unknown[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (isRecord(row)) {
      result.push(row);
    }
  }
  return result;
}

/**
 * Safe own-property getter for untrusted records (ERR-013).
 * Uses Object.hasOwn() instead of `in` to avoid prototype-chain matches.
 * Returns undefined when key is absent — caller decides whether that's an error.
 */
function getOwnValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Read an own string property from an untrusted record.
 * Returns undefined when key is absent or value is not a string.
 */
function readOwnString(record: Record<string, unknown>, key: string): string | undefined {
  const value = getOwnValue(record, key);
  return isString(value) ? value : undefined;
}

/**
 * Read an own string-array property from an untrusted record.
 * Returns empty array when key is absent, value is not an array,
 * or array contains non-string elements (ERR-005/007).
 */
function readOwnStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = getOwnValue(record, key);
  if (!Array.isArray(value)) return [];
  return value.filter(isString);
}

/**
 * Coerce a value to string — handles SQLite INTEGER PRIMARY KEY returning number.
 * Returns empty string only for null/undefined; numbers are stringified.
 */
function coerceToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such column');
}

/**
 * Map pain_events source to a display-friendly sourceKind.
 * Manual sources are highest confidence; hook/system sources are evidence-only by default.
 */
function mapSourceKind(source: string): string {
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

/**
 * Determine admission decision based on source kind (PEAT-B1 defaults).
 * Owner-explicit manual pain → store_signal (admitted).
 * Tool failures, dispatch errors, provider failures → evidence_only.
 * Empathy inferred → owner_confirmation_required.
 */
function inferAdmissionDecision(sourceKind: string): string {
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

/**
 * Determine the evidence chain state based on pain event and linked task/candidate data.
 */
interface ChainLinks {
  sourceKind: string;
  linkedTaskStatus?: string;
  linkedCandidateId?: string;
  linkedPrincipleId?: string;
}

function determineState(links: ChainLinks): EvidenceChainState {
  const { sourceKind, linkedTaskStatus, linkedCandidateId, linkedPrincipleId } = links;
  // If linked to a principle, internalization has started
  if (linkedPrincipleId) {
    return 'internalization_started';
  }

  // If linked to a candidate, candidate was generated
  if (linkedCandidateId) {
    return 'candidate_generated';
  }

  // If linked to a task, check task status
  if (linkedTaskStatus) {
    switch (linkedTaskStatus) {
      case 'pending':
      case 'queued':
        return 'diagnosis_queued';
      case 'running':
        return 'diagnosis_running';
      case 'succeeded':
        return 'diagnosis_succeeded';
      case 'failed':
        return 'diagnosis_failed';
      case 'retry_wait':
        return 'diagnosis_retry_wait';
      case 'needs_human_review':
        return 'diagnosis_failed';
      default:
        return 'diagnosis_queued';
    }
  }

  // No task linked — check admission decision
  const admission = inferAdmissionDecision(sourceKind);
  if (admission === 'store_signal') {
    return 'pain_recorded';
  }

  return 'evidence_only';
}

// ── Ledger reading ─────────────────────────────────────────────────────────────

interface LedgerPrinciple {
  id: string;
  derivedFromPainIds?: string[];
  text?: string;
  status?: string;
  createdAt?: string;
}

interface LedgerReadResult {
  principles: LedgerPrinciple[];
  /** Present when ledger exists but could not be fully read (ERR-002) */
  degradedReason?: string;
  nextAction?: string;
}

function readLedgerPrinciples(workspaceDir: string): LedgerReadResult {
  const ledgerPath = path.join(workspaceDir, '.state', 'principle_training_state.json');
  if (!fs.existsSync(ledgerPath)) return { principles: [] };

  let content: string;
  try {
    content = fs.readFileSync(ledgerPath, 'utf-8');
  } catch {
    return {
      principles: [],
      degradedReason: 'Failed to read principle ledger file',
      nextAction: 'Check file permissions for .state/principle_training_state.json',
    };
  }

  if (!content || content.trim() === '') return { principles: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      principles: [],
      degradedReason: 'Principle ledger contains invalid JSON',
      nextAction: 'Review .state/principle_training_state.json for syntax errors. Consider restoring from backup or re-running internalization.',
    };
  }

  if (!isRecord(parsed)) {
    return {
      principles: [],
      degradedReason: 'Principle ledger root is not a JSON object',
      nextAction: 'Review .state/principle_training_state.json structure. Expected { _tree: { principles: {...} } } or { tree: { principles: {...} } }.',
    };
  }

  const treeValue: unknown = Object.hasOwn(parsed, '_tree')
    ? getOwnValue(parsed, '_tree')
    : Object.hasOwn(parsed, 'tree')
      ? getOwnValue(parsed, 'tree')
      : parsed;

  if (!isRecord(treeValue)) {
    return {
      principles: [],
      degradedReason: 'Principle ledger tree is not a JSON object',
      nextAction: 'Review .state/principle_training_state.json structure. The _tree or tree field must be an object.',
    };
  }

  const principlesValue = getOwnValue(treeValue, 'principles');
  if (!isRecord(principlesValue)) {
    return {
      principles: [],
      degradedReason: 'Principle ledger principles field is missing or not an object',
      nextAction: 'Review .state/principle_training_state.json structure. Expected principles to be an object.',
    };
  }

  const result: LedgerPrinciple[] = [];
  for (const [, entry] of Object.entries(principlesValue)) {
    if (isRecord(entry)) {
      result.push({
        id: readOwnString(entry, 'id') ?? '',
        derivedFromPainIds: readOwnStringArray(entry, 'derivedFromPainIds'),
        text: readOwnString(entry, 'text'),
        status: readOwnString(entry, 'status'),
        createdAt: readOwnString(entry, 'createdAt'),
      });
    }
  }
  return { principles: result };
}

// ── PRI-340: Candidate info for human-readable fields ────────────────────────

interface CandidateInfo {
  candidateId: string;
  title?: string;
  description?: string;
  confidence?: number;
  recommendationKind?: string;
}

/**
 * PRI-340: Resolve the best human-readable summary for an evidence chain record.
 * Priority: candidateTitle > rootCauseSummary > painText > painReason > fallback.
 * Pure function for testability.
 */
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

// ── PRI-380: Timestamp cross-reference ─────────────────────────────────────────

interface TaskMapEntry {
  taskId: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  rootCauseSummary?: string;
  diagnosticJsonDegraded?: boolean;
  inputRef?: string;
}

/**
 * PRI-380: Match unmatched pain events to diagnostician tasks by timestamp proximity.
 *
 * When pain_events.id (e.g., 309) does not directly map to a diagnostician task_id
 * (e.g., diagnosis_manual_1781314784282_5v264gy1), we fall back to matching by
 * creation timestamp within a ±5 minute window. Manual pain events are matched
 * first since they have highest admission confidence.
 *
 * Returns a Map from painId (pain_<rowId>) to the matched task entry.
 * Pure function for testability.
 */
export function crossReferenceByTimestamp(
  painEvents: { painId: string; createdAt: string; source: string }[],
  taskMap: Map<string, TaskMapEntry>,
  coveredPainIds: Set<string>,
): Map<string, TaskMapEntry> {
  const CROSS_REF_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const result = new Map<string, TaskMapEntry>();
  const usedTaskIds = new Set<string>();

  // Collect unmatched pain events
  const unmatchedEvents = painEvents.filter(e => !coveredPainIds.has(e.painId));
  if (unmatchedEvents.length === 0) return result;

  // Collect all task entries (regardless of key) that are not already matched
  const availableTasks: [string, TaskMapEntry][] = [];
  for (const [key, entry] of taskMap.entries()) {
    if (!coveredPainIds.has(key)) {
      availableTasks.push([key, entry]);
    }
  }

  // Sort unmatched events by timestamp
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

// ── PRI-380: Dreamer task linkage ─────────────────────────────────────────────

interface DreamerTaskInfo {
  taskId: string;
  status: string;
}

/**
 * PRI-380: Query dreamer tasks and build a candidateId → dreamer info map.
 * Dreamer task IDs follow the pattern: dreamer-<candidateId>-<kind>
 * e.g., dreamer-9a8687df-28f7-4c40-86a6-f2beaa928ae7-prompt
 */
function buildDreamerMap(
  db: Database.Database,
  degradedReasons: string[],
  degradedNextActions: string[],
): Map<string, DreamerTaskInfo> {
  const dreamerMap = new Map<string, DreamerTaskInfo>();
  try {
    const dreamerTasks = coerceRowsToRecords(
      db.prepare(
        "SELECT task_id, status FROM tasks WHERE task_kind = 'dreamer'",
      ).all(),
    );

    for (const task of dreamerTasks) {
      const taskId = isString(task.task_id) ? task.task_id : '';
      const status = isString(task.status) ? task.status : 'unknown';
      // Extract candidateId from dreamer-<candidateId>-<kind>
      if (taskId.startsWith('dreamer-')) {
        const rest = taskId.slice('dreamer-'.length);
        const lastDash = rest.lastIndexOf('-');
        // Format: dreamer-<candidateId>-<kind>
        // candidateId can be UUID (with dashes) or short ID like "cand-pri380-001"
        if (lastDash > 0) {
          const candidateId = rest.slice(0, lastDash);
          if (candidateId && !dreamerMap.has(candidateId)) {
            dreamerMap.set(candidateId, { taskId, status });
          }
        }
      }
    }
  } catch {
    degradedReasons.push('Dreamer task query failed — internalization pipeline status is unavailable.');
    degradedNextActions.push('Check state database dreamer task table integrity.');
  }
  return dreamerMap;
}

// ── Model ──────────────────────────────────────────────────────────────────────

export class EvidenceChainConsoleModel {
  private readConnection: SqliteConnection | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getReadConnection(): SqliteConnection {
    if (!this.readConnection) {
      this.readConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    }
    return this.readConnection;
  }

  /**
   * PRI-380: Populate candidate fields on a record from linked candidate info.
   * Extracted from inline code for DRY reuse across direct/cross-ref/unmatched paths.
   */
  private populateCandidateFields(
    record: EvidenceChainRecord,
    linkedCandidate: CandidateInfo | undefined,
  ): void {
    if (!linkedCandidate) return;
    record.linkedCandidateId = linkedCandidate.candidateId;
    if (linkedCandidate.title) {
      record.candidateTitle = sanitizeString(linkedCandidate.title, this.workspaceDir);
    }
    if (linkedCandidate.description) {
      record.candidateSummary = sanitizeString(linkedCandidate.description, this.workspaceDir);
    }
    if (typeof linkedCandidate.confidence === 'number' && Number.isFinite(linkedCandidate.confidence)) {
      record.confidence = linkedCandidate.confidence;
    }
    if (linkedCandidate.recommendationKind) {
      record.recommendationKind = linkedCandidate.recommendationKind;
    }
  }

  /**
   * PRI-380: Populate dreamer/internalization linkage on a record.
   * Sets internalizationTaskId and dreamerTaskStatus when a dreamer task exists
   * for the linked candidate. Adds nextAction for candidate_generated + dreamer pending.
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  private populateDreamerLinkage(
    record: EvidenceChainRecord,
    linkedCandidate: CandidateInfo | undefined,
    dreamerMap: Map<string, DreamerTaskInfo>,
  ): void {
    if (!linkedCandidate) return;
    const dreamerInfo = dreamerMap.get(linkedCandidate.candidateId);
    if (!dreamerInfo) return;

    record.internalizationTaskId = dreamerInfo.taskId;
    record.dreamerTaskStatus = dreamerInfo.status;

    // Set nextAction for candidate_generated state when dreamer is pending
    if (record.state === 'candidate_generated' && !record.nextAction) {
      if (dreamerInfo.status === 'pending' || dreamerInfo.status === 'queued') {
        record.nextAction = 'Candidate generated. Internalization task is pending \u2014 wait for dreamer to complete.';
      } else if (dreamerInfo.status === 'running') {
        record.nextAction = 'Internalization in progress \u2014 dreamer task is running.';
      } else if (dreamerInfo.status === 'succeeded') {
        record.nextAction = 'Internalization task completed. Check for owner-reviewable principle.';
      } else if (dreamerInfo.status === 'failed') {
        record.nextAction = 'Internalization task failed. Check dreamer task error and retry if appropriate.';
      }
    }
  }

  async getEvidenceChain(): Promise<EvidenceChainResponse> {
    const generatedAt = new Date().toISOString();
    const records: EvidenceChainRecord[] = [];
    const degradedReasons: string[] = [];
    const degradedNextActions: string[] = [];

    // ── 1. Read pain_events from trajectory.db ────────────────────────────
    const trajectoryDbPath = path.join(this.workspaceDir, '.state', 'trajectory.db');
    let painEvents: Record<string, unknown>[] = [];
    let trajectoryDbAvailable = false;

    if (fs.existsSync(trajectoryDbPath)) {
      let trajDb: Database.Database | null = null;
      try {
        trajDb = new Database(trajectoryDbPath, { readonly: true });
        painEvents = coerceRowsToRecords(trajDb.prepare(
          'SELECT id, session_id, source, score, reason, severity, origin, confidence, text, created_at FROM pain_events ORDER BY created_at DESC LIMIT 100',
        ).all());
        trajectoryDbAvailable = true;
      } catch (err) {
        if (isMissingTableError(err)) {
          degradedReasons.push('pain_events table not found in trajectory database');
          degradedNextActions.push('This workspace may not have recorded any pain signals yet.');
        } else {
          degradedReasons.push('Failed to read trajectory database');
          degradedNextActions.push('Check workspace state directory integrity.');
        }
      } finally {
        trajDb?.close();
      }
    } else {
      degradedReasons.push('Trajectory database not found');
      degradedNextActions.push('PD has not recorded any pain signals in this workspace yet.');
    }

    // ── 2. Read diagnostician tasks from state.db ─────────────────────────
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    let taskMap = new Map<string, TaskMapEntry>();
    let stateDbAvailable = false;
    // PRI-380: dreamer map for candidate → internalization task linkage
    let dreamerMap = new Map<string, DreamerTaskInfo>();

    if (fs.existsSync(stateDbPath)) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();
        // PRI-340: try to read diagnostic_json for rootCause summary
        // PRI-380: also read input_ref for Runtime V2 pain ID cross-referencing
        let tasks: Record<string, unknown>[];
        let hasInputRef = true;
        try {
          tasks = coerceRowsToRecords(db.prepare(
            "SELECT task_id, status, last_error, created_at, diagnostic_json, input_ref FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
          ).all());
        } catch (colErr) {
          if (isMissingColumnError(colErr)) {
            // Try without input_ref first, then without diagnostic_json
            try {
              tasks = coerceRowsToRecords(db.prepare(
                "SELECT task_id, status, last_error, created_at, diagnostic_json FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
              ).all());
              hasInputRef = false;
            } catch (colErr2) {
              if (isMissingColumnError(colErr2)) {
                tasks = coerceRowsToRecords(db.prepare(
                  "SELECT task_id, status, last_error, created_at FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
                ).all());
                hasInputRef = false;
              } else {
                throw colErr2;
              }
            }
          } else {
            throw colErr;
          }
        }

        for (const task of tasks) {
          const taskId = isString(task.task_id) ? task.task_id : '';
          // PRI-380: Use input_ref for Runtime V2 pain ID when available
          const inputRefRaw = hasInputRef ? getOwnValue(task, 'input_ref') : undefined;
          const inputRef = isString(inputRefRaw) ? inputRefRaw : undefined;
          // Derive painId: prefer input_ref (normalize to pain_<id> if numeric), fall back to task_id prefix stripping
          let painId: string;
          if (inputRef) {
            // input_ref may be numeric (e.g., "309") or already prefixed ("pain_309")
            painId = /^\d+$/.test(inputRef) ? `pain_${inputRef}` : inputRef;
          } else {
            painId = taskId.startsWith('diagnosis_') ? taskId.slice('diagnosis_'.length) : taskId;
          }
          // PRI-340: parse diagnostic_json for rootCause (ERR-001: no `as`, runtime guards)
          let rootCauseSummary: string | undefined;
          let diagnosticJsonDegraded = false;
          const dj = getOwnValue(task, 'diagnostic_json');
          if (isString(dj)) {
            try {
              const parsed: unknown = JSON.parse(dj);
              if (isRecord(parsed) && Object.hasOwn(parsed, 'rootCause') && isString(parsed.rootCause)) {
                rootCauseSummary = parsed.rootCause;
              }
            } catch {
              // Invalid JSON — degrade gracefully (ERR-002)
              diagnosticJsonDegraded = true;
            }
          }
          taskMap.set(painId, {
            taskId,
            status: isString(task.status) ? task.status : 'unknown',
            lastError: isString(task.last_error) ? task.last_error : null,
            createdAt: isString(task.created_at) ? task.created_at : '',
            rootCauseSummary,
            diagnosticJsonDegraded,
            inputRef,
          });
        }
        stateDbAvailable = true;

        // PRI-380: Build dreamer task map for internalization pipeline visibility
        dreamerMap = buildDreamerMap(db, degradedReasons, degradedNextActions);
      } catch (err) {
        if (isMissingTableError(err)) {
          degradedReasons.push('Tasks table not found in state database');
          degradedNextActions.push('Workspace may need initialization via pd config doctor.');
        } else {
          degradedReasons.push('Failed to read state database');
          degradedNextActions.push('Check workspace .pd directory integrity.');
        }
      }
    } else {
      degradedReasons.push('State database not found');
      degradedNextActions.push('PD runtime has not been initialized in this workspace.');
    }

    // ── 3. Read candidates from state.db ──────────────────────────────────
    // PRI-380: taskId → painId reverse map for candidate linkage
    const taskIdToPainId = new Map<string, string>();
    for (const [pId, entry] of taskMap) {
      taskIdToPainId.set(entry.taskId, pId);
    }

    let candidateMap = new Map<string, CandidateInfo>(); // painId → CandidateInfo
    const candidateByTaskId = new Map<string, CandidateInfo>(); // taskId → CandidateInfo (PRI-380: cross-ref dual index)
    if (stateDbAvailable) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();
        // PRI-340: try rich query first, fall back to basic on missing columns
        let candidates: Record<string, unknown>[];
        let hasRichColumns = true;
        try {
          candidates = coerceRowsToRecords(db.prepare(
            'SELECT candidate_id, task_id, title, description, abstracted_principle, confidence, recommendation_kind FROM principle_candidates',
          ).all());
        } catch (colErr) {
          if (isMissingColumnError(colErr)) {
            candidates = coerceRowsToRecords(db.prepare(
              'SELECT candidate_id, task_id FROM principle_candidates',
            ).all());
            hasRichColumns = false;
          } else {
            throw colErr;
          }
        }

        for (const c of candidates) {
          const candidateId = isString(c.candidate_id) ? c.candidate_id : '';
          const taskId = isString(c.task_id) ? c.task_id : '';
          // PRI-380: Reverse-map candidate → painId via taskIdToPainId first,
          // then fall back to legacy taskId prefix stripping
          let painId = taskIdToPainId.get(taskId) ?? '';
          if (!painId && taskId.startsWith('diagnosis_')) {
            painId = taskId.slice('diagnosis_'.length);
          }
          if (painId && candidateId) {
            const info: CandidateInfo = {
              candidateId,
              title: hasRichColumns ? readOwnString(c, 'title') : undefined,
              description: hasRichColumns ? readOwnString(c, 'description') : undefined,
              confidence: hasRichColumns && typeof c.confidence === 'number' && Number.isFinite(c.confidence)
                ? c.confidence : undefined,
              recommendationKind: hasRichColumns ? readOwnString(c, 'recommendation_kind') : undefined,
            };
            candidateMap.set(painId, info);
            // PRI-380: dual index by taskId for cross-reference lookups
            if (taskId) candidateByTaskId.set(taskId, info);
          }
        }
      } catch (err) {
        if (isMissingTableError(err)) {
          degradedReasons.push('Candidates table not found in state database');
          degradedNextActions.push('Candidate and internalization chain links are unavailable. Workspace may need initialization.');
        } else {
          degradedReasons.push('Failed to read candidates table');
          degradedNextActions.push('Check state database integrity.');
        }
      }
    }

    // ── 4. Read ledger principles ─────────────────────────────────────────
    const ledgerResult = readLedgerPrinciples(this.workspaceDir);
    const ledgerPrinciples = ledgerResult.principles;
    if (ledgerResult.degradedReason) {
      degradedReasons.push(ledgerResult.degradedReason);
      degradedNextActions.push(ledgerResult.nextAction ?? 'Review principle ledger file.');
    }
    const painToPrincipleMap = new Map<string, string>(); // painId → principleId
    for (const p of ledgerPrinciples) {
      for (const painId of p.derivedFromPainIds ?? []) {
        painToPrincipleMap.set(painId, p.id);
      }
    }

    // ── 5. Build evidence chain records from pain_events ──────────────────
    // PRI-380: Track pain event metadata for timestamp cross-referencing
    const painEventMeta = new Array<{ painId: string; createdAt: string; source: string }>();
    const directMatchedPainIds = new Set<string>();

    for (const event of painEvents) {
      // SQLite INTEGER PRIMARY KEY returns number, not string — must coerce
      const eventId = coerceToString(event.id);
      if (!eventId) continue; // Skip records with no valid id (ERR-009: fail loud)
      const source = isString(event.source) ? event.source : 'unknown';
      const reason = isString(event.reason) ? event.reason : '';
      const text = isString(event.text) ? event.text : '';
      const createdAt = isString(event.created_at) ? event.created_at : '';
      const score = typeof event.score === 'number' ? event.score : 0;

      const sourceKind = mapSourceKind(source);

      // Use id as a stable painId reference
      const painId = `pain_${eventId}`;

      // Track for cross-referencing
      painEventMeta.push({ painId, createdAt, source });

      // Look up linked task, candidate, principle
      const linkedTask = taskMap.get(painId);
      if (linkedTask) {
        directMatchedPainIds.add(painId);
      }
      const linkedCandidate = candidateMap.get(painId);
      const linkedPrincipleId = painToPrincipleMap.get(painId) || undefined;

      // Determine state
      const state = determineState({
        sourceKind,
        linkedTaskStatus: linkedTask?.status,
        linkedCandidateId: linkedCandidate?.candidateId,
        linkedPrincipleId,
      });

      // PRI-340: Build summary using priority resolution
      const rawSummary = resolveSummary({
        candidateTitle: linkedCandidate?.title,
        rootCauseSummary: linkedTask?.rootCauseSummary,
        painText: text,
        painReason: reason,
        fallback: `Pain signal (source: ${source}, score: ${score})`,
      });
      const summary = sanitizeString(rawSummary, this.workspaceDir);

      const record: EvidenceChainRecord = {
        id: painId,
        sourceKind,
        observedAt: createdAt,
        state,
        summary,
        admissionDecision: inferAdmissionDecision(sourceKind),
      };

      // PRI-340: Populate human-readable candidate fields
      this.populateCandidateFields(record, linkedCandidate);

      // PRI-340: Populate rootCause summary from diagnostic_json
      if (linkedTask?.rootCauseSummary) {
        record.rootCauseSummary = sanitizeString(linkedTask.rootCauseSummary, this.workspaceDir);
      }

      if (linkedTask) {
        record.linkedTaskId = linkedTask.taskId;
        record.linkedTaskStatus = linkedTask.status;
        if (linkedTask.lastError && (state === 'diagnosis_failed' || state === 'diagnosis_retry_wait')) {
          record.failureReason = sanitizeString(linkedTask.lastError, this.workspaceDir);
          record.nextAction = state === 'diagnosis_retry_wait'
            ? 'Diagnosis is waiting for automatic retry. Check pipeline status if it stays in this state.'
            : 'Diagnosis failed. Check the error details and retry if appropriate.';
        } else if (state === 'diagnosis_succeeded' && !linkedCandidate) {
          record.nextAction = 'Diagnosis completed. A candidate principle may be generated shortly.';
        }
        // PRI-340: diagnostic_json parse failure → degrade (ERR-002)
        if (linkedTask.diagnosticJsonDegraded) {
          record.degradedReason = 'Diagnostic data for this record could not be parsed';
          if (!record.nextAction) {
            record.nextAction = 'Check task diagnostic data integrity.';
          }
        }
      }

      // PRI-380: Dreamer task linkage for candidate → internalization visibility
      this.populateDreamerLinkage(record, linkedCandidate, dreamerMap);

      if (linkedPrincipleId) {
        record.linkedPrincipleId = linkedPrincipleId;
      }

      // PRI-380: Skip pushing record for unmatched pain events when state.db has tasks.
      // Section 5b will handle them via cross-reference or loud degradation.
      if (!linkedTask && stateDbAvailable && taskMap.size > 0) {
        continue;
      }

      records.push(record);
    }

    // ── 5b. PRI-380: Timestamp cross-reference for unmatched pain events ──────
    // When pain_events.id doesn't directly map to a diagnostician task_id,
    // match by creation timestamp proximity (±5 min window).
    const crossRefMap = crossReferenceByTimestamp(painEventMeta, taskMap, directMatchedPainIds);

    for (const event of painEvents) {
      const eventId = coerceToString(event.id);
      if (!eventId) continue;
      const painId = `pain_${eventId}`;
      if (directMatchedPainIds.has(painId)) continue; // Already processed

      const crossRefTask = crossRefMap.get(painId);
      if (!crossRefTask) {
        // PRI-380: No match found — if state.db has tasks, degrade loudly (ERR-002)
        // instead of silently showing pain_recorded as if no diagnosis happened
        if (stateDbAvailable && taskMap.size > 0) {
          const source = isString(event.source) ? event.source : 'unknown';
          const reason = isString(event.reason) ? event.reason : '';
          const text = isString(event.text) ? event.text : '';
          const createdAt = isString(event.created_at) ? event.created_at : '';
          const score = typeof event.score === 'number' ? event.score : 0;
          const sourceKind = mapSourceKind(source);

          const record: EvidenceChainRecord = {
            id: painId,
            sourceKind,
            observedAt: createdAt,
            state: inferAdmissionDecision(sourceKind) === 'store_signal' ? 'pain_recorded' : 'evidence_only',
            summary: sanitizeString(
              text || reason || `Pain signal (source: ${source}, score: ${score})`,
              this.workspaceDir,
            ),
            admissionDecision: inferAdmissionDecision(sourceKind),
            degradedReason: 'Could not link this pain event to a diagnostician task. The chain may be incomplete.',
            nextAction: 'Check Runtime V2 pipeline status. The diagnostician task may have a different pain ID format.',
          };
          // ERR-002: Surface at response level too
          degradedReasons.push(`Pain event ${painId} could not be linked to a diagnostician task.`);
          degradedNextActions.push('Check Runtime V2 pipeline status for unmatched pain ID formats.');
          records.push(record);
        }
        continue;
      }

      // Build a full record with cross-referenced task data
      const source = isString(event.source) ? event.source : 'unknown';
      const reason = isString(event.reason) ? event.reason : '';
      const text = isString(event.text) ? event.text : '';
      const createdAt = isString(event.created_at) ? event.created_at : '';
      const score = typeof event.score === 'number' ? event.score : 0;
      const sourceKind = mapSourceKind(source);

      // Look up candidate: prefer painId key, fall back to taskId dual index
      const linkedCandidate = candidateMap.get(painId) || candidateByTaskId.get(crossRefTask.taskId);
      const linkedPrincipleId = painToPrincipleMap.get(painId) || undefined;

      const state = determineState({
        sourceKind,
        linkedTaskStatus: crossRefTask.status,
        linkedCandidateId: linkedCandidate?.candidateId,
        linkedPrincipleId,
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
        summary: sanitizeString(rawSummary, this.workspaceDir),
        admissionDecision: inferAdmissionDecision(sourceKind),
        linkedTaskId: crossRefTask.taskId,
        linkedTaskStatus: crossRefTask.status,
      };

      // Populate candidate fields
      this.populateCandidateFields(record, linkedCandidate);

      if (crossRefTask.rootCauseSummary) {
        record.rootCauseSummary = sanitizeString(crossRefTask.rootCauseSummary, this.workspaceDir);
      }

      if (crossRefTask.lastError && (state === 'diagnosis_failed' || state === 'diagnosis_retry_wait')) {
        record.failureReason = sanitizeString(crossRefTask.lastError, this.workspaceDir);
        record.nextAction = state === 'diagnosis_retry_wait'
          ? 'Diagnosis is waiting for automatic retry.'
          : 'Diagnosis failed. Check error details and retry.';
      } else if (state === 'candidate_generated') {
        // PRI-380: Check dreamer task status for next action
        const dreamerInfo = linkedCandidate ? dreamerMap.get(linkedCandidate.candidateId) : undefined;
        if (dreamerInfo) {
          record.internalizationTaskId = dreamerInfo.taskId;
          record.dreamerTaskStatus = dreamerInfo.status;
          if (dreamerInfo.status === 'pending' || dreamerInfo.status === 'queued') {
            record.nextAction = 'Candidate generated. Internalization task is pending — wait for dreamer to complete.';
          } else if (dreamerInfo.status === 'running') {
            record.nextAction = 'Internalization in progress — dreamer task is running.';
          }
        } else {
          record.nextAction = 'Candidate generated. Waiting for internalization pipeline to seed dreamer task.';
        }
      }

      // Dreamer linkage
      this.populateDreamerLinkage(record, linkedCandidate, dreamerMap);

      if (linkedPrincipleId) {
        record.linkedPrincipleId = linkedPrincipleId;
      }

      if (crossRefTask.diagnosticJsonDegraded) {
        record.degradedReason = 'Diagnostic data for this record could not be parsed';
        if (!record.nextAction) {
          record.nextAction = 'Check task diagnostic data integrity.';
        }
      }

      records.push(record);
    }

    // ── 6. Also include tasks that have no matching pain_event ─────────────
    // This catches manual pain that was recorded directly through the bridge
    // without a trajectory.db entry (e.g., pd pain record)
    const coveredPainIds = new Set(records.map(r => r.id));
    // Also exclude task map entries that were matched via cross-reference
    const crossRefTaskIds = new Set<string>();
    for (const entry of crossRefMap.values()) {
      crossRefTaskIds.add(entry.taskId);
    }
    for (const [painId, task] of taskMap.entries()) {
      if (coveredPainIds.has(painId)) continue;
      if (crossRefTaskIds.has(task.taskId)) continue; // Already matched via cross-ref

      const linkedCandidate = candidateMap.get(painId);
      const linkedPrincipleId = painToPrincipleMap.get(painId) || undefined;

      const state = determineState({
        sourceKind: 'manual',
        linkedTaskStatus: task.status,
        linkedCandidateId: linkedCandidate?.candidateId,
        linkedPrincipleId,
      });

      // PRI-340: Use resolveSummary instead of hard-coded ID string
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
        summary: sanitizeString(rawSummary, this.workspaceDir),
        admissionDecision: 'store_signal',
        linkedTaskId: task.taskId,
        linkedTaskStatus: task.status,
        linkedPrincipleId,
        failureReason: (task.lastError && (state === 'diagnosis_failed' || state === 'diagnosis_retry_wait'))
          ? sanitizeString(task.lastError, this.workspaceDir)
          : undefined,
        nextAction: (state === 'diagnosis_retry_wait')
          ? 'Diagnosis is waiting for automatic retry.'
          : (state === 'diagnosis_failed')
            ? 'Diagnosis failed. Check error details and retry.'
            : undefined,
      };

      // PRI-340: Populate human-readable candidate fields
      this.populateCandidateFields(record, linkedCandidate);

      // PRI-340: Populate rootCause summary from diagnostic_json
      if (task.rootCauseSummary) {
        record.rootCauseSummary = sanitizeString(task.rootCauseSummary, this.workspaceDir);
      }

      // PRI-380: Dreamer task linkage
      this.populateDreamerLinkage(record, linkedCandidate, dreamerMap);

      // PRI-340: diagnostic_json parse failure → degrade (ERR-002)
      if (task.diagnosticJsonDegraded) {
        record.degradedReason = 'Diagnostic data for this record could not be parsed';
        if (!record.nextAction) {
          record.nextAction = 'Check task diagnostic data integrity.';
        }
      }

      records.push(record);
    }

    // Sort by observedAt descending
    records.sort((a, b) => b.observedAt.localeCompare(a.observedAt));

    // ── 7. Build response ─────────────────────────────────────────────────
    const response: EvidenceChainResponse = {
      records,
      generatedAt,
    };

    if (degradedReasons.length > 0) {
      response.degradedReason = degradedReasons.join('; ');
      response.nextAction = degradedNextActions.join(' ');
    }

    // Note when evidence-only sources exist but no pain signals
    if (records.length === 0 && trajectoryDbAvailable && stateDbAvailable) {
      response.note = 'PD has not captured any displayable behavior evidence in this workspace yet.';
    }

    return response;
  }

  dispose(): void {
    if (this.readConnection) {
      try {
        this.readConnection.close();
      } catch (err) {
        console.warn('EvidenceChainConsoleModel.dispose: failed to close connection:', err instanceof Error ? err.message : String(err));
      }
      this.readConnection = null;
    }
  }
}
