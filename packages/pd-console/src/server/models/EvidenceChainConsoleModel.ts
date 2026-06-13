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

import {
  SqliteConnection,
  sanitizeString,
  assembleEvidenceChain,
  crossReferenceByTimestamp,
  resolveSummary,
} from '@principles/core/runtime-v2';
import type {
  EvidenceChainState,
  EvidenceChainRecord,
  EvidenceChainResponse,
} from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

export type {
  EvidenceChainState,
  EvidenceChainRecord,
  EvidenceChainResponse,
};

export {
  crossReferenceByTimestamp,
  resolveSummary,
};

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function readOwnStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = getOwnValue(record, key);
  if (!Array.isArray(value)) return [];
  return value.filter(isString);
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such column');
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
    const degradedReasons: string[] = [];
    const degradedNextActions: string[] = [];

    // ── 1. Read pain_events from trajectory.db ────────────────────────────
    const trajectoryDbPath = path.join(this.workspaceDir, '.state', 'trajectory.db');
    let painEvents: unknown[] = [];
    let trajectoryDbAvailable = false;

    if (fs.existsSync(trajectoryDbPath)) {
      let trajDb: Database.Database | null = null;
      try {
        trajDb = new Database(trajectoryDbPath, { readonly: true });
        painEvents = trajDb.prepare(
          'SELECT id, session_id, source, score, reason, severity, origin, confidence, text, created_at FROM pain_events ORDER BY created_at DESC LIMIT 100',
        ).all();
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

    // ── 2. Read tasks from state.db ───────────────────────────────────────
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    let tasks: unknown[] = [];
    let dreamerTasks: unknown[] = [];
    let stateDbAvailable = false;

    if (fs.existsSync(stateDbPath)) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();

        try {
          tasks = db.prepare(
            "SELECT task_id, status, last_error, created_at, diagnostic_json, input_ref FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
          ).all();
        } catch (colErr) {
          if (isMissingColumnError(colErr)) {
            try {
              tasks = db.prepare(
                "SELECT task_id, status, last_error, created_at, diagnostic_json FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
              ).all();
            } catch (colErr2) {
              if (isMissingColumnError(colErr2)) {
                tasks = db.prepare(
                  "SELECT task_id, status, last_error, created_at FROM tasks WHERE task_kind = 'diagnostician' ORDER BY created_at DESC",
                ).all();
              } else {
                throw colErr2;
              }
            }
          } else {
            throw colErr;
          }
        }

        try {
          dreamerTasks = db.prepare(
            "SELECT task_id, status FROM tasks WHERE task_kind = 'dreamer'",
          ).all();
        } catch {
          degradedReasons.push('Dreamer task query failed — internalization pipeline status is unavailable.');
          degradedNextActions.push('Check state database dreamer task table integrity.');
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
    let candidates: unknown[] = [];
    if (stateDbAvailable) {
      try {
        const conn = this.getReadConnection();
        const db = conn.getDb();
        try {
          candidates = db.prepare(
            'SELECT candidate_id, task_id, title, description, abstracted_principle, confidence, recommendation_kind FROM principle_candidates',
          ).all();
        } catch (colErr) {
          if (isMissingColumnError(colErr)) {
            candidates = db.prepare(
              'SELECT candidate_id, task_id FROM principle_candidates',
            ).all();
          } else {
            throw colErr;
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

    // ── 5. Assemble using shared logic ────────────────────────────────────
    const response = assembleEvidenceChain({
      workspaceDir: this.workspaceDir,
      painEvents,
      tasks,
      candidates,
      dreamerTasks,
      ledgerPrinciples,
      trajectoryDbAvailable,
      stateDbAvailable,
      degradedReasons,
      degradedNextActions,
    });

    // ── 6. Sanitize strings in place (I/O boundary privacy policy) ────────
    for (const record of response.records) {
      record.summary = sanitizeString(record.summary, this.workspaceDir);
      if (record.rootCauseSummary) {
        record.rootCauseSummary = sanitizeString(record.rootCauseSummary, this.workspaceDir);
      }
      if (record.failureReason) {
        record.failureReason = sanitizeString(record.failureReason, this.workspaceDir);
      }
      if (record.candidateTitle) {
        record.candidateTitle = sanitizeString(record.candidateTitle, this.workspaceDir);
      }
      if (record.candidateSummary) {
        record.candidateSummary = sanitizeString(record.candidateSummary, this.workspaceDir);
      }
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
