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
    let taskMap = new Map<string, { taskId: string; status: string; lastError: string | null; createdAt: string; rootCauseSummary?: string; diagnosticJsonDegraded?: boolean }>();
    let stateDbAvailable = false;

    if (fs.existsSync(stateDbPath)) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();
        // PRI-340: try to read diagnostic_json for rootCause summary
        let tasks: Record<string, unknown>[];
        try {
          tasks = coerceRowsToRecords(db.prepare(
            "SELECT task_id, status, last_error, created_at, diagnostic_json FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
          ).all());
        } catch (colErr) {
          if (isMissingColumnError(colErr)) {
            tasks = coerceRowsToRecords(db.prepare(
              "SELECT task_id, status, last_error, created_at FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
            ).all());
          } else {
            throw colErr;
          }
        }

        for (const task of tasks) {
          const taskId = isString(task.task_id) ? task.task_id : '';
          // Diagnostician task IDs follow pattern "diagnosis_<painId>"
          const painId = taskId.startsWith('diagnosis_') ? taskId.slice('diagnosis_'.length) : taskId;
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
          });
        }
        stateDbAvailable = true;
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
    let candidateMap = new Map<string, CandidateInfo>(); // painId → CandidateInfo
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
          // Reverse-map: taskId → painId
          const painId = taskId.startsWith('diagnosis_') ? taskId.slice('diagnosis_'.length) : '';
          if (painId && candidateId) {
            candidateMap.set(painId, {
              candidateId,
              title: hasRichColumns ? readOwnString(c, 'title') : undefined,
              description: hasRichColumns ? readOwnString(c, 'description') : undefined,
              confidence: hasRichColumns && typeof c.confidence === 'number' && Number.isFinite(c.confidence)
                ? c.confidence : undefined,
              recommendationKind: hasRichColumns ? readOwnString(c, 'recommendation_kind') : undefined,
            });
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

      // Look up linked task, candidate, principle
      const linkedTask = taskMap.get(painId);
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
      if (linkedCandidate) {
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

      if (linkedPrincipleId) {
        record.linkedPrincipleId = linkedPrincipleId;
      }

      records.push(record);
    }

    // ── 6. Also include tasks that have no matching pain_event ─────────────
    // This catches manual pain that was recorded directly through the bridge
    // without a trajectory.db entry (e.g., pd pain record)
    const coveredPainIds = new Set(records.map(r => r.id));
    for (const [painId, task] of taskMap.entries()) {
      if (coveredPainIds.has(painId)) continue;

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
      if (linkedCandidate) {
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

      // PRI-340: Populate rootCause summary from diagnostic_json
      if (task.rootCauseSummary) {
        record.rootCauseSummary = sanitizeString(task.rootCauseSummary, this.workspaceDir);
      }

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
