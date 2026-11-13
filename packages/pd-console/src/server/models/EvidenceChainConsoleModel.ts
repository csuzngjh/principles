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
 * P1-2 exception: `getAssistantTurn()` returns ONE referenced assistant turn
 * verbatim, on purpose — the Owner must be able to compare the recorded
 * correction against exactly what the agent said. It is bounded to the turn id
 * recorded in correction evidence and pinned to that turn's session.
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
} from '@principles/core/runtime';
import { openTrajectoryDbReadonly } from '@principles/core/trajectory-store';
import { resolveStateDbPath, resolveTrajectoryDbPath } from '@principles/core/runtime/storage-paths';
import type {
  EvidenceChainState,
  EvidenceChainRecord,
  EvidenceChainResponse,
} from '@principles/core/runtime';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { errorMessage } from '../utils/response.js';

export type {
  EvidenceChainState,
  EvidenceChainRecord,
  EvidenceChainResponse,
};

/**
 * P1-2: verbatim assistant output referenced by a correction record.
 *
 * This is the ONE place raw assistant text is returned to the Owner. It is not
 * sanitized on purpose: the Owner must be able to compare the correction text
 * with exactly what the agent said. Access is by turn id, optionally pinned to
 * the session id recorded in the correction evidence, so a record can never
 * pull an unrelated conversation.
 */
export interface AssistantTurnLookup {
  ok: true;
  turn: {
    id: number;
    sessionId: string;
    /** Verbatim assistant output (newlines, spaces and markdown preserved). */
    text: string;
    /**
     * `raw` when the original text was persisted inline or in the overflow
     * blob; `sanitized` when only the redacted copy survives (retention or
     * write-path policy). The UI must label which one the Owner is reading.
     */
    textSource: 'raw' | 'sanitized';
    createdAt: string;
  };
}

export interface AssistantTurnLookupFailure {
  ok: false;
  reason: string;
  nextAction: string;
}

/**
 * P1-2: restore the assistant turn text for verbatim display.
 *
 * Order of preference: inline `raw_text` → overflow blob (`blob_ref`) →
 * `sanitized_text` (kept for retention cases where raw text was purged). The
 * blob path is treated as untrusted: it must resolve inside `<state>/blobs`,
 * otherwise it is ignored (rc-1 / rc-2).
 */
function readVerbatimTurnText(
  row: Record<string, unknown>,
  stateDir: string,
): { text: string; source: 'raw' | 'sanitized' } | null {
  const inlineRaw = typeof row.raw_text === 'string' ? row.raw_text : '';
  if (inlineRaw !== '') return { text: inlineRaw, source: 'raw' };

  const blobRef = typeof row.blob_ref === 'string' ? row.blob_ref : '';
  if (blobRef !== '') {
    const blobsDir = path.resolve(stateDir, 'blobs');
    const blobPath = path.resolve(blobsDir, blobRef);
    const relativeToBlobs = path.relative(blobsDir, blobPath);
    const escapes = relativeToBlobs === '' || relativeToBlobs.startsWith('..') || path.isAbsolute(relativeToBlobs);
    if (!escapes && fs.existsSync(blobPath)) {
      try {
        const blobText = fs.readFileSync(blobPath, 'utf8');
        if (blobText !== '') return { text: blobText, source: 'raw' };
      } catch {
        // Unreadable blob: fall through to the sanitized copy below.
      }
    }
  }

  const sanitized = typeof row.sanitized_text === 'string' ? row.sanitized_text : '';
  if (sanitized !== '') return { text: sanitized, source: 'sanitized' };
  return null;
}

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
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getEvidenceChain(): Promise<EvidenceChainResponse> {
    const degradedReasons: string[] = [];
    const degradedNextActions: string[] = [];

    // ── 1. Read pain_events from trajectory.db ────────────────────────────
    const trajectoryDbPath = resolveTrajectoryDbPath(this.workspaceDir);
    let painEvents: unknown[] = [];
    let trajectoryDbAvailable = false;

    if (fs.existsSync(trajectoryDbPath)) {
      let trajDb: Database.Database | null = null;
      try {
        trajDb = openTrajectoryDbReadonly(this.workspaceDir);
        try {
          painEvents = trajDb.prepare(
            'SELECT id, session_id, source, score, reason, severity, origin, confidence, text, created_at, canonical_pain_id, runtime_task_id, host_kind FROM pain_events ORDER BY created_at DESC LIMIT 100',
          ).all();
        } catch (colErr: unknown) {
          const colMessage = errorMessage(colErr);
          if (colMessage.includes('no such column')) {
            // Degrade per missing column (review round 3): a missing host_kind
            // must not drop canonical_pain_id / runtime_task_id — the task join
            // runs through those, and losing them orphans evidence records.
            try {
              painEvents = trajDb.prepare(
                'SELECT id, session_id, source, score, reason, severity, origin, confidence, text, created_at, canonical_pain_id, runtime_task_id, NULL AS host_kind FROM pain_events ORDER BY created_at DESC LIMIT 100',
              ).all();
            } catch (colErr2: unknown) {
              const colMessage2 = errorMessage(colErr2);
              if (colMessage2.includes('no such column')) {
                painEvents = trajDb.prepare(
                  'SELECT id, session_id, source, score, reason, severity, origin, confidence, text, created_at FROM pain_events ORDER BY created_at DESC LIMIT 100',
                ).all();
              } else {
                throw colErr2;
              }
            }
          } else {
            throw colErr;
          }
        }
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

    // ── 2. Read tasks & candidates from state.db ──────────────────────
    const stateDbPath = resolveStateDbPath(this.workspaceDir);
    let tasks: unknown[] = [];
    let dreamerTasks: unknown[] = [];
    let candidates: unknown[] = [];
    let diagnosticArtifacts: unknown[] = [];
    let stateDbAvailable = false;

    if (fs.existsSync(stateDbPath)) {
      const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
      try {
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

        try {
          candidates = db.prepare(
            'SELECT candidate_id, task_id, title, description, abstracted_principle, confidence, recommendation_kind FROM principle_candidates',
          ).all();
        } catch (colErr) {
          if (isMissingColumnError(colErr)) {
            candidates = db.prepare(
              'SELECT candidate_id, task_id FROM principle_candidates',
            ).all();
          } else if (isMissingTableError(colErr)) {
            // ERR-002: degrade with a specific reason instead of falling through
            // to the generic "Tasks/candidates" message.
            degradedReasons.push('Candidates table not found in state database');
            degradedNextActions.push('Workspace may need initialization via pd config doctor.');
          } else {
            throw colErr;
          }
        }

        // PRI-469: Read diagnostician artifacts from the artifacts table.
        // In production, DiagnosticianCommitter writes Stage C output (rootCause +
        // intentTension) to artifacts.content_json with artifact_kind =
        // 'diagnostician_output'. This is the canonical source for intentTension.
        // The tasks.diagnostic_json column is kept as a fallback for test fixtures.
        // Graceful degradation: if the artifacts table is missing (older workspace),
        // we simply skip it — assembleEvidenceChain falls back to diagnostic_json.
        try {
          diagnosticArtifacts = db.prepare(
            "SELECT task_id, content_json FROM artifacts WHERE artifact_kind = 'diagnostician_output' ORDER BY created_at DESC",
          ).all();
        } catch (artifactsErr) {
          if (isMissingTableError(artifactsErr)) {
            // Artifacts table not present in older workspaces — not an error,
            // just no intentTension data available from artifacts.
          } else {
            // ERR-002: degrade with reason for unexpected errors.
            degradedReasons.push('Failed to read diagnostician artifacts table');
            degradedNextActions.push('Check state database artifacts table integrity.');
          }
        }

        stateDbAvailable = true;
      } catch (err) {
        if (isMissingTableError(err)) {
          degradedReasons.push('Tasks/candidates table not found in state database');
          degradedNextActions.push('Workspace may need initialization via pd config doctor.');
        } else {
          degradedReasons.push('Failed to read state database');
          degradedNextActions.push('Check workspace .pd directory integrity.');
        }
      } finally {
        try { conn.close(); } catch { /* best-effort */ }
      }
    } else {
      degradedReasons.push('State database not found');
      degradedNextActions.push('PD runtime has not been initialized in this workspace.');
    }

    // ── 3. Read ledger principles ────────────────────────────────────
    const ledgerResult = readLedgerPrinciples(this.workspaceDir);
    const ledgerPrinciples = ledgerResult.principles;
    if (ledgerResult.degradedReason) {
      degradedReasons.push(ledgerResult.degradedReason);
      degradedNextActions.push(ledgerResult.nextAction ?? 'Review principle ledger file.');
    }

    // ── 4. Assemble using shared logic ──────────────────────────────
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
      diagnosticArtifacts,
    });

    // ── 5. Sanitize strings in place ─────────────────────────────────
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
      // PRI-469: Sanitize intentTension free-text fields.
      // Enum fields (source, evidenceStrength, suggestedOwnerAction) and
      // relatedIntentFields are controlled vocabularies validated by the core,
      // so they don't need sanitization. The explanation, evidence items,
      // and intentDocHash may contain user/system-generated text.
      if (record.intentTension) {
        record.intentTension.explanation = sanitizeString(record.intentTension.explanation, this.workspaceDir);
        record.intentTension.evidence = record.intentTension.evidence.map(
          (item) => sanitizeString(item, this.workspaceDir),
        );
        if (record.intentTension.intentDocHash) {
          record.intentTension.intentDocHash = sanitizeString(record.intentTension.intentDocHash, this.workspaceDir);
        }
      }
    }

    return response;
  }

  /**
   * P1-2: read the raw assistant turn referenced by correction evidence.
   * Verbatim by contract — no sanitization, no markdown rendering.
   *
   * Uses the registered trajectory-store seam (`openTrajectoryDbReadonly`) so
   * the read-only + path-contract rules have a single owner. The overflow blob
   * directory is derived from the trajectory database location, never
   * hardcoded, and a blob reference is confined to that directory before it is
   * read.
   */
  async getAssistantTurn(turnId: number, expectedSessionId?: string): Promise<AssistantTurnLookup | AssistantTurnLookupFailure> {
    if (!Number.isInteger(turnId) || turnId <= 0) {
      return {
        ok: false,
        reason: 'Assistant turn id must be a positive integer',
        nextAction: 'Reload the page and expand the original output again.',
      };
    }

    const trajectoryDbPath = resolveTrajectoryDbPath(this.workspaceDir);
    if (!fs.existsSync(trajectoryDbPath)) {
      return {
        ok: false,
        reason: 'Trajectory database not found for this workspace',
        nextAction: 'PD has not recorded any turns in this workspace yet.',
      };
    }

    let db: Database.Database | null = null;
    try {
      db = openTrajectoryDbReadonly(this.workspaceDir);
      // Untrusted DB row: narrow with a guard instead of an `as` cast (rc-2).
      const row = db.prepare(
        'SELECT id, session_id, raw_text, sanitized_text, blob_ref, created_at FROM assistant_turns WHERE id = ?',
      ).get(turnId);

      if (!isRecord(row)) {
        return {
          ok: false,
          reason: `Assistant turn ${turnId} was not found`,
          nextAction: 'The trajectory database may have been rotated; the correction text is still shown above.',
        };
      }

      const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
      if (expectedSessionId && sessionId !== expectedSessionId) {
        // Safety: never expose a turn from a different session than the one the
        // correction evidence recorded.
        return {
          ok: false,
          reason: 'Assistant turn does not belong to the recorded session',
          nextAction: 'The evidence link is inconsistent; treat the original output as unavailable.',
        };
      }

      const restored = readVerbatimTurnText(row, path.dirname(trajectoryDbPath));
      if (restored === null) {
        return {
          ok: false,
          reason: 'Assistant turn has no recorded output',
          nextAction: 'The turn exists but its text was not persisted.',
        };
      }

      return {
        ok: true,
        turn: {
          id: turnId,
          sessionId,
          text: restored.text,
          textSource: restored.source,
          createdAt: typeof row.created_at === 'string' ? row.created_at : '',
        },
      };
    } catch (err: unknown) {
      return {
        ok: false,
        reason: `Failed to read assistant turn: ${errorMessage(err)}`,
        nextAction: 'Check trajectory database integrity in the workspace .state directory.',
      };
    } finally {
      db?.close();
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
