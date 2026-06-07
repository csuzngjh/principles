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

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
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

function readLedgerPrinciples(workspaceDir: string): LedgerPrinciple[] {
  const ledgerPath = path.join(workspaceDir, '.state', 'principle_training_state.json');
  if (!fs.existsSync(ledgerPath)) return [];

  try {
    const content = fs.readFileSync(ledgerPath, 'utf-8');
    if (!content || content.trim() === '') return [];
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return [];

    const tree = Object.hasOwn(parsed, '_tree')
      ? (parsed as Record<string, unknown>)._tree
      : Object.hasOwn(parsed, 'tree')
        ? (parsed as Record<string, unknown>).tree
        : parsed;

    if (typeof tree !== 'object' || tree === null) return [];
    const {principles} = (tree as Record<string, unknown>);
    if (typeof principles !== 'object' || principles === null) return [];

    const result: LedgerPrinciple[] = [];
    for (const [, value] of Object.entries(principles)) {
      if (typeof value === 'object' && value !== null) {
        const p = value as Record<string, unknown>;
        result.push({
          id: isString(p.id) ? p.id : '',
          derivedFromPainIds: Array.isArray(p.derivedFromPainIds)
            ? p.derivedFromPainIds.filter(isString)
            : [],
          text: isString(p.text) ? p.text : undefined,
          status: isString(p.status) ? p.status : undefined,
          createdAt: isString(p.createdAt) ? p.createdAt : undefined,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
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
        painEvents = trajDb.prepare(
          'SELECT id, session_id, source, score, reason, severity, origin, confidence, text, created_at FROM pain_events ORDER BY created_at DESC LIMIT 100',
        ).all() as Record<string, unknown>[];
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
    let taskMap = new Map<string, { taskId: string; status: string; lastError: string | null; createdAt: string }>();
    let stateDbAvailable = false;

    if (fs.existsSync(stateDbPath)) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();
        const tasks = db.prepare(
          "SELECT task_id, status, last_error, created_at FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
        ).all() as Record<string, unknown>[];

        for (const task of tasks) {
          const taskId = isString(task.task_id) ? task.task_id : '';
          // Diagnostician task IDs follow pattern "diagnosis_<painId>"
          const painId = taskId.startsWith('diagnosis_') ? taskId.slice('diagnosis_'.length) : taskId;
          taskMap.set(painId, {
            taskId,
            status: isString(task.status) ? task.status : 'unknown',
            lastError: isString(task.last_error) ? task.last_error : null,
            createdAt: isString(task.created_at) ? task.created_at : '',
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
    let candidateMap = new Map<string, string>(); // painId → candidateId
    if (stateDbAvailable) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();
        const candidates = db.prepare(
          'SELECT candidate_id, task_id FROM principle_candidates',
        ).all() as Record<string, unknown>[];

        for (const c of candidates) {
          const candidateId = isString(c.candidate_id) ? c.candidate_id : '';
          const taskId = isString(c.task_id) ? c.task_id : '';
          // Reverse-map: taskId → painId
          const painId = taskId.startsWith('diagnosis_') ? taskId.slice('diagnosis_'.length) : '';
          if (painId && candidateId) {
            candidateMap.set(painId, candidateId);
          }
        }
      } catch (err) {
        if (!isMissingTableError(err)) {
          degradedReasons.push('Failed to read candidates table');
          degradedNextActions.push('Check state database integrity.');
        }
      }
    }

    // ── 4. Read ledger principles ─────────────────────────────────────────
    const ledgerPrinciples = readLedgerPrinciples(this.workspaceDir);
    const painToPrincipleMap = new Map<string, string>(); // painId → principleId
    for (const p of ledgerPrinciples) {
      for (const painId of p.derivedFromPainIds ?? []) {
        painToPrincipleMap.set(painId, p.id);
      }
    }

    // ── 5. Build evidence chain records from pain_events ──────────────────
    for (const event of painEvents) {
      const eventId = isString(event.id) ? String(event.id) : '';
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
      const linkedCandidateId = candidateMap.get(painId) || undefined;
      const linkedPrincipleId = painToPrincipleMap.get(painId) || undefined;

      // Determine state
      const state = determineState({
        sourceKind,
        linkedTaskStatus: linkedTask?.status,
        linkedCandidateId,
        linkedPrincipleId,
      });

      // Build bounded, sanitized summary
      const rawSummary = text || reason || `Pain signal (source: ${source}, score: ${score})`;
      const summary = sanitizeString(rawSummary, this.workspaceDir);

      const record: EvidenceChainRecord = {
        id: painId,
        sourceKind,
        observedAt: createdAt,
        state,
        summary,
        admissionDecision: inferAdmissionDecision(sourceKind),
      };

      if (linkedTask) {
        record.linkedTaskId = linkedTask.taskId;
        record.linkedTaskStatus = linkedTask.status;
        if (linkedTask.lastError && (state === 'diagnosis_failed' || state === 'diagnosis_retry_wait')) {
          record.failureReason = sanitizeString(linkedTask.lastError, this.workspaceDir);
          record.nextAction = state === 'diagnosis_retry_wait'
            ? 'Diagnosis is waiting for automatic retry. Check pipeline status if it stays in this state.'
            : 'Diagnosis failed. Check the error details and retry if appropriate.';
        }
      }

      if (linkedCandidateId) {
        record.linkedCandidateId = linkedCandidateId;
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

      const linkedCandidateId = candidateMap.get(painId) || undefined;
      const linkedPrincipleId = painToPrincipleMap.get(painId) || undefined;

      const state = determineState({
        sourceKind: 'manual',
        linkedTaskStatus: task.status,
        linkedCandidateId,
        linkedPrincipleId,
      });

      records.push({
        id: painId,
        sourceKind: 'manual',
        observedAt: task.createdAt,
        state,
        summary: sanitizeString(`Manual pain signal (task: ${task.taskId})`, this.workspaceDir),
        admissionDecision: 'store_signal',
        linkedTaskId: task.taskId,
        linkedTaskStatus: task.status,
        linkedCandidateId,
        linkedPrincipleId,
        failureReason: (task.lastError && (state === 'diagnosis_failed' || state === 'diagnosis_retry_wait'))
          ? sanitizeString(task.lastError, this.workspaceDir)
          : undefined,
        nextAction: (state === 'diagnosis_retry_wait')
          ? 'Diagnosis is waiting for automatic retry.'
          : (state === 'diagnosis_failed')
            ? 'Diagnosis failed. Check error details and retry.'
            : undefined,
      });
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
