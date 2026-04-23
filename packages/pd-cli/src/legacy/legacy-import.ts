/**
 * Legacy Compatibility Import — OpenClaw → PD Runtime v2
 *
 * ## Purpose
 *
 * This module is a **compatibility import path only**.
 * It is NOT the authoritative retrieval path for M3 queries.
 *
 * It syncs diagnostician task data from OpenClaw's legacy JSON-based stores
 * into the PD Runtime v2 SQLite store so that `pd trajectory`, `pd history`,
 * and `pd context` commands have data to query against.
 *
 * **Authoritative path**: `workspace/.pd/state.db` (PD-owned SQLite)
 * **This module's role**: migrate legacy `.state/diagnostician_tasks.json` →
 * `workspace/.pd/state.db` (one-way sync, idempotent)
 *
 * ## Sync Sources
 *
 *   - `.state/diagnostician_tasks.json`  →  tasks + runs tables
 *
 * ## Non-Goals
 *
 * This module does NOT:
 * - Query raw OpenClaw `.state/` files for primary retrieval
 * - Serve as the main path for trajectory/history/context commands
 * - Own any PD task semantics
 *
 * ## Usage
 *
 * Call `syncOpenClawWorkspace(workspaceDir, connection)` once to import,
 * then use `pd trajectory locate`, `pd history query`, `pd context build`
 * which read from `workspace/.pd/state.db` directly.
 *
 * Idempotent: safe to call multiple times. Re-syncs latest state on every call.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { SqliteConnection } from '@principles/core';

interface OpenClawDiagnosticianTask {
  prompt: string;
  createdAt: string;
  status: 'pending' | 'completed';
  reportMissingRetries?: number;
}

interface OpenClawDiagnosticianStore {
  tasks: Record<string, OpenClawDiagnosticianTask>;
}

interface ParsedTaskFields {
  sessionId: string;
  painScore: number;
  painSource: string;
  painReason: string;
}

function readDiagnosticianStore(stateDir: string): OpenClawDiagnosticianStore {
  const filePath = path.join(stateDir, 'diagnostician_tasks.json');
  if (!fs.existsSync(filePath)) {
    return { tasks: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.tasks === 'object' && parsed.tasks !== null && !Array.isArray(parsed.tasks)) {
      return parsed as OpenClawDiagnosticianStore;
    }
    return { tasks: {} };
  } catch {
    return { tasks: {} };
  }
}

function parsePrompt(taskId: string, prompt: string): ParsedTaskFields {
  const sessionId =
    /\*\*Session ID\*\*:\s*([^\n*]+)/.exec(prompt)?.[1]?.trim() ?? taskId;
  const painScore =
    parseInt(/\*\*Pain Score\*\*:\s*(\d+)/.exec(prompt)?.[1] ?? '0', 10);
  const painSource =
    /\*\*Source\*\*:\s*([^\n*]+)/.exec(prompt)?.[1]?.trim() ?? 'unknown';
  const painReason =
    /\*\*Reason\*\*:\s*([^\n*]+)/.exec(prompt)?.[1]?.trim() ?? '';

  return { sessionId, painScore, painSource, painReason };
}

function painScoreToSeverity(score: number): string {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * Sync all openclaw diagnostician tasks into the PD Runtime v2 SQLite store.
 *
 * For each task in diagnostician_tasks.json:
 *   - Upsert into tasks table (base fields + diagnostic_json blob)
 *   - Upsert a corresponding synthetic run into runs table
 *
 * Idempotent: existing records are updated, not duplicated.
 */
export async function syncOpenClawWorkspace(
  workspaceDir: string,
  connection: SqliteConnection,
): Promise<{ tasksSynced: number; runsSynced: number }> {
  const stateDir = path.join(workspaceDir, '.state');
  const store = readDiagnosticianStore(stateDir);

  const db = connection.getDb();
  let tasksSynced = 0;
  let runsSynced = 0;

  const upsertTask = db.prepare(`
    INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES (@taskId, 'diagnostician', @status, @createdAt, @updatedAt, 0, 3, @diagnosticJson)
    ON CONFLICT(task_id) DO UPDATE SET
      status = @status,
      updated_at = @updatedAt,
      diagnostic_json = @diagnosticJson
  `);

  const upsertRun = db.prepare(`
    INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at, attempt_number, created_at, updated_at)
    VALUES (@runId, @taskId, 'openclaw', @executionStatus, @startedAt, @endedAt, 1, @createdAt, @updatedAt)
    ON CONFLICT(run_id) DO UPDATE SET
      execution_status = @executionStatus,
      ended_at = @endedAt,
      updated_at = @updatedAt
  `);

  const now = new Date().toISOString();

  for (const [taskId, task] of Object.entries(store.tasks)) {
    const { sessionId, painScore, painSource, painReason } = parsePrompt(taskId, task.prompt);

    const status =
      task.status === 'pending'
        ? 'pending'
        : task.status === 'completed'
          ? 'succeeded'
          : 'failed';

    const severity = painScoreToSeverity(painScore);
    const reasonSummary = painReason.length > 200 ? painReason.substring(0, 197) + '...' : painReason;

    const diagnosticJson = JSON.stringify({
      workspaceDir,
      reasonSummary,
      source: painSource,
      severity,
      sessionIdHint: sessionId !== taskId ? sessionId : null,
    });

    upsertTask.run({
      taskId,
      status,
      createdAt: task.createdAt,
      updatedAt: now,
      diagnosticJson,
    });
    tasksSynced++;

    const runId = `run_${taskId}_1`;
    upsertRun.run({
      runId,
      taskId,
      executionStatus: status === 'pending' ? 'queued' : 'succeeded',
      startedAt: task.createdAt,
      endedAt: status !== 'pending' ? now : null,
      createdAt: task.createdAt,
      updatedAt: now,
    });
    runsSynced++;
  }

  return { tasksSynced, runsSynced };
}
