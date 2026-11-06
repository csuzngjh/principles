/**
 * PendingAgentDraftStore — durable store for agent-generated draft context
 * attached to a failed peer-runner task.
 *
 * Task 11: When a peer runner reaches a permanent-failure terminal state
 * (BasePeerRunner catch block — Task 12), it constructs an AgentDraftPayload
 * and writes it here via insertPendingDraft. The feedback-report pipeline
 * (Task 13) later reads the unconsumed draft for a given taskId and merges
 * it into the user-facing FeedbackReport so the maintainer sees the agent's
 * perspective alongside the user's description. After a successful merge,
 * markConsumed sets consumed_at so the draft cannot be re-attached.
 *
 * Idempotency contract: the schema's partial unique index
 *   UNIQUE(task_id) WHERE consumed_at IS NULL
 * guarantees at most one unconsumed draft per task_id at the DB level.
 * insertPendingDraft honors this by first SELECTing for an existing
 * unconsumed row, then UPDATE-ing it in place (rather than INSERT-ing a new
 * row) when one exists. This matches the spec requirement: "如果 taskId 已有
 * 未消费行，UPDATE 该行的 agent_draft / created_at / pain_id，不创建新行".
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: agent_draft JSON is parsed into `unknown` and
 *   validated field-by-field via isAgentDraftPayload before being exposed as
 *   AgentDraftPayload. No `as` casts on row data (rc-1, rc-2).
 * - EP-01 / ERR-013: Object.hasOwn (not `in`) is used to check payload keys
 *   on the parsed-unknown object (rc-5).
 * - EP-03 / ERR-002: write failures return { ok: false, error } so callers
 *   can log an observable reason (rc-9).
 * - EP-03 / ERR-009, ERR-010: corrupt agent_draft JSON fails loud —
 *   getUnconsumedByTaskId / listPending throw a structured Error rather than
 *   silently returning a raw string masquerading as the original object
 *   (rc-3-fail-loud-missing).
 * - EP-05 / ERR-015: insertPendingDraft reads fresh state via
 *   SELECT ... WHERE consumed_at IS NULL immediately before the
 *   INSERT/UPDATE decision, so concurrent writers see the latest row.
 */

import type { SqliteConnection } from '../store/sqlite-connection.js';

/** Agent-authored draft context attached to a failed task. */
export interface AgentDraftPayload {
  summary: string;
  observedFailure?: string;
  commandSummary?: string;
}

/** A row in the pending_agent_drafts table. agentDraft is typed (validated). */
export interface PendingAgentDraftRow {
  id: string;
  taskId: string;
  painId: string | null;
  agentDraft: AgentDraftPayload;
  createdAt: string;
  consumedAt: string | null;
}

/** Result of an insert or markConsumed operation. */
export type PendingDraftOpResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate that an unknown value (parsed JSON) matches AgentDraftPayload.
 * Uses Object.hasOwn (rc-5) and explicit typeof guards (rc-1, rc-2: no `as`).
 */
function isAgentDraftPayload(value: unknown): value is AgentDraftPayload {
  if (!isRecord(value)) return false;
  if (!Object.hasOwn(value, 'summary') || typeof value.summary !== 'string') return false;
  if (Object.hasOwn(value, 'observedFailure') && typeof value.observedFailure !== 'string') {
    return false;
  }
  if (Object.hasOwn(value, 'commandSummary') && typeof value.commandSummary !== 'string') {
    return false;
  }
  return true;
}

/**
 * Generate a `pad-<uuid>` id, falling back to `pad-<ts>-<rand>` if the
 * WebCrypto randomUUID is unavailable (mirrors the feedback module's `fb-`
 * prefix pattern in create-report.ts).
 */
function generateDraftId(): string {
  try {
    if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
      return 'pad-' + globalThis.crypto.randomUUID();
    }
  } catch {
    // Fallback below
  }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return 'pad-' + ts + '-' + rand;
}

/**
 * Map a sqlite row (Record<string, unknown>) to a PendingAgentDraftRow.
 *
 * agent_draft is JSON.parse'd into `unknown` and then validated via
 * isAgentDraftPayload (rc-1, rc-2, rc-5). Corrupt JSON fails loud (rc-3)
 * by throwing a structured Error — the caller can catch and surface a
 * reason instead of silently degrading.
 */
function rowToPendingDraft(row: Record<string, unknown>): PendingAgentDraftRow {
  if (typeof row.agent_draft !== 'string') {
    // rc-3: fail loud — required field missing or wrong type.
    throw new Error(
      `pending_agent_drafts row has non-string agent_draft (id=${String(row.id)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.agent_draft);
  } catch (parseErr) {
    // rc-3: fail loud with observable reason (do NOT return a raw string
    // masquerading as AgentDraftPayload).
    throw new Error(
      `pending_agent_drafts row has corrupt agent_draft JSON (id=${String(row.id)}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      { cause: parseErr },
    );
  }
  if (!isAgentDraftPayload(parsed)) {
    // rc-3: fail loud — parsed JSON does not match AgentDraftPayload shape.
    throw new Error(
      `pending_agent_drafts row agent_draft failed shape validation (id=${String(row.id)})`,
    );
  }
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    painId: row.pain_id === null || row.pain_id === undefined ? null : String(row.pain_id),
    agentDraft: parsed,
    createdAt: String(row.created_at),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at),
  };
}

export class PendingAgentDraftStore {
  constructor(private readonly connection: SqliteConnection) {}

  /**
   * Insert a pending agent draft for a task, or UPDATE the existing
   * unconsumed draft if one already exists for the same taskId (idempotent).
   *
   * On UPDATE, the row's `id` is preserved; agent_draft / created_at / pain_id
   * are overwritten with the new values. This honors the spec: "如果 taskId 已有
   * 未消费行（consumed_at IS NULL），UPDATE 该行的 agent_draft / created_at /
   * pain_id，不创建新行".
   *
   * Returns `{ ok: true, id }` on success (id is the row's PRIMARY KEY,
   * either the existing one for an UPDATE or a fresh `pad-` id for an INSERT).
   */
  insertPendingDraft(input: {
    taskId: string;
    painId?: string;
    agentDraft: AgentDraftPayload;
  }): PendingDraftOpResult {
    try {
      const db = this.connection.getDb();
      const createdAt = new Date().toISOString();
      let agentDraftJson: string;
      try {
        agentDraftJson = JSON.stringify(input.agentDraft);
      } catch (serializeErr) {
        // rc-9: surface serialization failure with a reason instead of
        // silently dropping the row or storing an empty string.
        return {
          ok: false,
          error: `agentDraft serialization failed: ${serializeErr instanceof Error ? serializeErr.message : String(serializeErr)}`,
        };
      }
      const painId = input.painId ?? null;

      // Read fresh state (rc-7 / ERR-015): SELECT the current unconsumed row
      // immediately before deciding INSERT vs UPDATE. The partial unique index
      // UNIQUE(task_id) WHERE consumed_at IS NULL is the DB-level backstop.
      const existing = db
        .prepare(
          'SELECT id FROM pending_agent_drafts WHERE task_id = ? AND consumed_at IS NULL LIMIT 1',
        )
        .get(input.taskId);

      if (isRecord(existing) && typeof existing.id === 'string') {
        // Idempotent UPDATE: preserve the existing row's id, refresh the
        // payload + timestamp + pain_id linkage.
        db.prepare(
          'UPDATE pending_agent_drafts SET pain_id = ?, agent_draft = ?, created_at = ? WHERE id = ?',
        ).run(painId, agentDraftJson, createdAt, existing.id);
        return { ok: true, id: existing.id };
      }

      const id = generateDraftId();
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, input.taskId, painId, agentDraftJson, createdAt, null);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Get the unconsumed draft for a task, or null if none.
   * Fails loud (rc-3) when agent_draft is corrupt JSON — throws a structured
   * Error so callers can observe the corruption instead of silently receiving
   * a raw string masquerading as the original object.
   */
  getUnconsumedByTaskId(taskId: string): PendingAgentDraftRow | null {
    const db = this.connection.getDb();
    const row = db
      .prepare(
        'SELECT id, task_id, pain_id, agent_draft, created_at, consumed_at FROM pending_agent_drafts WHERE task_id = ? AND consumed_at IS NULL LIMIT 1',
      )
      .get(taskId);
    if (!isRecord(row)) return null;
    return rowToPendingDraft(row);
  }

  /**
   * Mark a draft as consumed (set consumed_at = now).
   * Returns `{ ok: true }` whether or not the row exists — this is the
   * explicit "ok: true 静默" behavior called out in the task spec for
   * markConsumed on a non-existent id. The reasoning: markConsumed is called
   * from the feedback-report success path as a cleanup step; a missing row
   * (already consumed, never existed, or concurrently deleted) is not an
   * error condition the caller can act on.
   */
  markConsumed(id: string): PendingDraftOpResult {
    try {
      const db = this.connection.getDb();
      const consumedAt = new Date().toISOString();
      // UPDATE is idempotent: re-marking an already-consumed row just
      // refreshes consumed_at, which is harmless.
      db.prepare('UPDATE pending_agent_drafts SET consumed_at = ? WHERE id = ?').run(consumedAt, id);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * List pending (unconsumed) drafts, most recent first.
   * Fails loud (rc-3) on corrupt agent_draft JSON.
   */
  listPending(filter?: { limit?: number }): PendingAgentDraftRow[] {
    const db = this.connection.getDb();
    const limit = filter?.limit ?? 100;
    const rows = db
      .prepare(
        'SELECT id, task_id, pain_id, agent_draft, created_at, consumed_at FROM pending_agent_drafts WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit);
    const out: PendingAgentDraftRow[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      out.push(rowToPendingDraft(row));
    }
    return out;
  }
}
