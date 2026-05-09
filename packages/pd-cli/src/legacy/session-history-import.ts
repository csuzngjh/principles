/**
 * Session History Import — OpenClaw trajectory.db → PD Runtime v2
 *
 * Reads real conversation history from OpenClaw's trajectory.db and imports
 * assistant_turns, user_turns, and tool_calls into PD-owned runtime-v2 runs table
 * so that `pd history query` and `pd context build` return non-empty results.
 *
 * This is a COMPATIBILITY IMPORT — not authoritative retrieval.
 * Primary retrieval always goes through `.pd/state.db` only.
 */
import Database from 'better-sqlite3';
import * as path from 'path';

interface OpenClawTrajectoryDb {
  getAssistantTurns(sessionId: string): AssistantTurn[];
  getUserTurns(sessionId: string): UserTurn[];
  getToolCalls(sessionId: string): ToolCall[];
  getSessionIds(): string[];
}

interface AssistantTurn {
  id: number;
  session_id: string;
  run_id: string;
  provider: string;
  model: string;
  sanitized_text: string;
  created_at: string;
}

interface UserTurn {
  id: number;
  session_id: string;
  turn_index: number;
  raw_text: string;
  created_at: string;
}

interface ToolCall {
  id: number;
  session_id: string;
  tool_name: string;
  outcome: string;
  duration_ms: number | null;
  exit_code: number | null;
  error_type: string | null;
  error_message: string | null;
  created_at: string;
}

function openTrajectoryDb(dbPath: string): OpenClawTrajectoryDb {
  const db = new Database(dbPath, { readonly: true });

  return {
    getAssistantTurns(sessionId: string): AssistantTurn[] {
      return db
        .prepare(
          'SELECT id, session_id, run_id, provider, model, sanitized_text, created_at ' +
            'FROM assistant_turns WHERE session_id = ? ORDER BY id ASC',
        )
        .all(sessionId) as AssistantTurn[];
    },

    getUserTurns(sessionId: string): UserTurn[] {
      return db
        .prepare(
          'SELECT id, session_id, turn_index, raw_text, created_at ' +
            'FROM user_turns WHERE session_id = ? ORDER BY id ASC',
        )
        .all(sessionId) as UserTurn[];
    },

    getToolCalls(sessionId: string): ToolCall[] {
      return db
        .prepare(
          'SELECT id, session_id, tool_name, outcome, duration_ms, exit_code, ' +
            'error_type, error_message, created_at ' +
            'FROM tool_calls WHERE session_id = ? ORDER BY id ASC',
        )
        .all(sessionId) as ToolCall[];
    },

    getSessionIds(): string[] {
      return (
        db.prepare('SELECT session_id FROM sessions ORDER BY started_at DESC').all() as {
          session_id: string;
        }[]
      ).map((r) => r.session_id);
    },
  };
}

/**
 * Import session history from OpenClaw trajectory.db into PD runtime-v2 runs table.
 *
 * For each task that has a sessionIdHint in its diagnostic_json:
 *   1. Look up the session in trajectory.db
 *   2. Import assistant_turns, user_turns, tool_calls as entries
 *   3. Upsert into runs table with full payload (JSON string)
 *
 * Idempotent: updates existing run records, does not duplicate.
 */
export async function importSessionHistory(
  openclawWorkspaceDir: string,
  pdWorkspaceDir: string,
  getDb: () => Database.Database,
): Promise<{ sessionsProcessed: number; entriesImported: number }> {
  const trajectoryPath = path.join(openclawWorkspaceDir, '.state', 'trajectory.db');
  const trajectoryDb = openTrajectoryDb(trajectoryPath);
  const db = getDb();

  // Find all tasks with a sessionIdHint
  const tasksWithSession = db
    .prepare(
      `SELECT task_id, json_extract(diagnostic_json, '$.sessionIdHint') as session_id
       FROM tasks
       WHERE json_extract(diagnostic_json, '$.sessionIdHint') IS NOT NULL
         AND json_extract(diagnostic_json, '$.sessionIdHint') != ''`,
    )
    .all() as { task_id: string; session_id: string }[];

  let sessionsProcessed = 0;
  let entriesImported = 0;

  const upsertRun = db.prepare(`
    INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, ended_at,
      attempt_number, created_at, updated_at, input_payload, output_payload)
    VALUES (@runId, @taskId, 'openclaw-history', @executionStatus, @startedAt, @endedAt,
      1, @createdAt, @updatedAt, @inputPayload, @outputPayload)
    ON CONFLICT(run_id) DO UPDATE SET
      input_payload = @inputPayload,
      output_payload = @outputPayload,
      ended_at = @endedAt,
      updated_at = @updatedAt
  `);

  const now = new Date().toISOString();

  for (const { task_id, session_id } of tasksWithSession) {
    // Verify session exists in trajectory.db
    const assistantTurns = trajectoryDb.getAssistantTurns(session_id);
    if (assistantTurns.length === 0) continue;

    const userTurns = trajectoryDb.getUserTurns(session_id);
    const toolCalls = trajectoryDb.getToolCalls(session_id);

    // Use the latest timestamp from the session as ended_at
    const lastTimestamp =
      assistantTurns.length > 0
        ? assistantTurns[assistantTurns.length - 1].created_at
        : now;

    // Build input (user turns + tool calls) and output (assistant turns) payloads
    const inputPayload = JSON.stringify({
      type: 'session_history',
      sessionId: session_id,
      userTurns: userTurns.map((t) => ({
        turnIndex: t.turn_index,
        text: t.raw_text,
        ts: t.created_at,
      })),
      toolCalls: toolCalls.map((t) => ({
        toolName: t.tool_name,
        outcome: t.outcome,
        durationMs: t.duration_ms,
        exitCode: t.exit_code,
        errorType: t.error_type,
        errorMessage: t.error_message,
        ts: t.created_at,
      })),
    });

    const outputPayload = JSON.stringify({
      type: 'assistant_turns',
      sessionId: session_id,
      turns: assistantTurns.map((t) => ({
        provider: t.provider,
        model: t.model,
        text: t.sanitized_text,
        ts: t.created_at,
      })),
    });

    const runId = `run_${task_id}_history_1`;

    upsertRun.run({
      runId,
      taskId: task_id,
      executionStatus: 'succeeded',
      startedAt: assistantTurns[0].created_at,
      endedAt: lastTimestamp,
      createdAt: assistantTurns[0].created_at,
      updatedAt: now,
      inputPayload,
      outputPayload,
    });

    entriesImported += assistantTurns.length + userTurns.length + toolCalls.length;
    sessionsProcessed++;
  }

  return { sessionsProcessed, entriesImported };
}

function _buildConversationEntries(
  assistantTurns: AssistantTurn[],
  userTurns: UserTurn[],
  toolCalls: ToolCall[],
): string {
  // Interleave and sort by timestamp for a unified view
  type Entry = { ts: string; role: string; text: string; toolName?: string };
  const entries: Entry[] = [];

  for (const t of assistantTurns) {
    entries.push({ ts: t.created_at, role: 'assistant', text: t.sanitized_text });
  }
  for (const t of userTurns) {
    entries.push({ ts: t.created_at, role: 'user', text: t.raw_text ?? '' });
  }
  for (const t of toolCalls) {
    entries.push({
      ts: t.created_at,
      role: 'tool',
      text: `${t.tool_name}: ${t.outcome}${t.error_message ? ` — ${t.error_message}` : ''}`,
      toolName: t.tool_name,
    });
  }

  entries.sort((a, b) => a.ts.localeCompare(b.ts));
  return JSON.stringify(entries, null, 2);
}
