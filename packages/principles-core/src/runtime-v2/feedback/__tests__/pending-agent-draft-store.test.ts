/**
 * PendingAgentDraftStore tests (Task 11).
 *
 * Verifies insertPendingDraft (incl. idempotency), getUnconsumedByTaskId,
 * markConsumed, and listPending against a real SQLite database.
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: agent_draft JSON parsed as unknown; no `as`
 *   casts on row data — only `as unknown` then narrowed via isRecord/typeof.
 * - EP-03 / ERR-002: write failures return { ok: false, error } (rc-9).
 * - EP-03 / ERR-009, ERR-010: corrupt agent_draft JSON fails loud (rc-3).
 * - EP-05 / ERR-015: insertPendingDraft reads fresh state via SELECT before
 *   INSERT/UPDATE; markConsumed uses UPDATE ... WHERE.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import {
  PendingAgentDraftStore,
  type AgentDraftPayload,
} from '../pending-agent-draft-store.js';

function createTestConnection(): SqliteConnection {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-pending-draft-'));
  return new SqliteConnection(tmpDir);
}

function makeDraft(overrides: Partial<AgentDraftPayload> = {}): AgentDraftPayload {
  return {
    summary: 'peer runner failed',
    observedFailure: 'Error: permanent failure',
    commandSummary: 'last tool call: write_file',
    ...overrides,
  };
}

describe('PendingAgentDraftStore', () => {
  let connection = null as unknown as SqliteConnection;
  let store = null as unknown as PendingAgentDraftStore;

  beforeEach(() => {
    connection = createTestConnection();
    // Touch getDb() so initSchema() runs (creates pending_agent_drafts table).
    connection.getDb();
    store = new PendingAgentDraftStore(connection);
  });

  afterEach(() => {
    connection?.close();
  });

  describe('insertPendingDraft', () => {
    it('creates a new row with correct fields and returns ok with pad- prefixed id', () => {
      const result = store.insertPendingDraft({
        taskId: 'task-1',
        painId: 'pain-1',
        agentDraft: makeDraft(),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.id).toMatch(/^pad-/);
      }

      const row = store.getUnconsumedByTaskId('task-1');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.taskId).toBe('task-1');
      expect(row.painId).toBe('pain-1');
      expect(row.consumedAt).toBeNull();
      expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.agentDraft.summary).toBe('peer runner failed');
      expect(row.agentDraft.observedFailure).toBe('Error: permanent failure');
      expect(row.agentDraft.commandSummary).toBe('last tool call: write_file');
    });

    it('persists painId as null when not provided', () => {
      store.insertPendingDraft({
        taskId: 'task-no-pain',
        agentDraft: makeDraft(),
      });

      const row = store.getUnconsumedByTaskId('task-no-pain');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.painId).toBeNull();
    });

    it('serializes agentDraft as JSON in the database', () => {
      store.insertPendingDraft({
        taskId: 'task-1',
        agentDraft: makeDraft({ summary: 'special chars: "quotes" \\backslash' }),
      });

      // Read raw row to verify JSON serialization.
      const db = connection.getDb();
      const rawRow = db
        .prepare('SELECT agent_draft FROM pending_agent_drafts WHERE task_id = ?')
        .get('task-1') as { agent_draft: string } | undefined;
      expect(rawRow).toBeDefined();
      if (!rawRow) throw new Error('rawRow is null');
      const parsed = JSON.parse(rawRow.agent_draft);
      expect(parsed.summary).toBe('special chars: "quotes" \\backslash');
    });

    it('is idempotent: same taskId second insert updates the existing row, does not create a new one', () => {
      const draft1 = makeDraft({ summary: 'first attempt' });
      const r1 = store.insertPendingDraft({ taskId: 'task-idem', painId: 'pain-1', agentDraft: draft1 });
      expect(r1.ok).toBe(true);

      // Brief delay so createdAt differs (ISO millisecond precision).
      // Use a unique draft so we can verify the update.
      const draft2 = makeDraft({ summary: 'second attempt', observedFailure: 'new failure' });
      const r2 = store.insertPendingDraft({ taskId: 'task-idem', painId: 'pain-2', agentDraft: draft2 });
      expect(r2.ok).toBe(true);

      // The id should be preserved (UPDATE, not INSERT).
      if (r1.ok && r2.ok) {
        expect(r2.id).toBe(r1.id);
      }

      // Count rows for this taskId — should be exactly 1.
      const db = connection.getDb();
      const countRow = db
        .prepare('SELECT COUNT(*) as cnt FROM pending_agent_drafts WHERE task_id = ?')
        .get('task-idem') as { cnt: number };
      expect(countRow.cnt).toBe(1);

      // The single row should reflect the updated values.
      const row = store.getUnconsumedByTaskId('task-idem');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.agentDraft.summary).toBe('second attempt');
      expect(row.agentDraft.observedFailure).toBe('new failure');
      expect(row.painId).toBe('pain-2');
    });

    it('idempotent update preserves the original row id', () => {
      const r1 = store.insertPendingDraft({
        taskId: 'task-idem-id',
        agentDraft: makeDraft({ summary: 'v1' }),
      });
      expect(r1.ok).toBe(true);
      const originalId = r1.ok ? r1.id : '';

      // Three successive updates — id must stay the same.
      const r2 = store.insertPendingDraft({
        taskId: 'task-idem-id',
        agentDraft: makeDraft({ summary: 'v2' }),
      });
      const r3 = store.insertPendingDraft({
        taskId: 'task-idem-id',
        agentDraft: makeDraft({ summary: 'v3' }),
      });
      expect(r2.ok && r2.id).toBe(originalId);
      expect(r3.ok && r3.id).toBe(originalId);

      const row = store.getUnconsumedByTaskId('task-idem-id');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.id).toBe(originalId);
      expect(row.agentDraft.summary).toBe('v3');
    });

    it('after markConsumed, a new insert creates a fresh row (partial unique index allows it)', () => {
      const r1 = store.insertPendingDraft({
        taskId: 'task-cycle',
        agentDraft: makeDraft({ summary: 'first' }),
      });
      expect(r1.ok).toBe(true);
      const firstId = r1.ok ? r1.id : '';

      // Mark consumed — frees the partial unique index slot for this taskId.
      expect(store.markConsumed(firstId).ok).toBe(true);

      // A new insert should succeed and create a NEW row (different id).
      const r2 = store.insertPendingDraft({
        taskId: 'task-cycle',
        agentDraft: makeDraft({ summary: 'second' }),
      });
      expect(r2.ok).toBe(true);
      const secondId = r2.ok ? r2.id : '';
      expect(secondId).not.toBe(firstId);

      // getUnconsumedByTaskId should return the NEW row, not the consumed one.
      const row = store.getUnconsumedByTaskId('task-cycle');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.id).toBe(secondId);
      expect(row.agentDraft.summary).toBe('second');

      // The consumed row should still exist in the table (just with consumed_at set).
      const db = connection.getDb();
      const countRow = db
        .prepare('SELECT COUNT(*) as cnt FROM pending_agent_drafts WHERE task_id = ?')
        .get('task-cycle') as { cnt: number };
      expect(countRow.cnt).toBe(2);
    });
  });

  describe('getUnconsumedByTaskId', () => {
    it('returns null when no row exists', () => {
      const row = store.getUnconsumedByTaskId('nonexistent');
      expect(row).toBeNull();
    });

    it('returns null after the only row is consumed', () => {
      store.insertPendingDraft({ taskId: 'task-1', agentDraft: makeDraft() });
      const row = store.getUnconsumedByTaskId('task-1');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(store.markConsumed(row.id).ok).toBe(true);
      expect(store.getUnconsumedByTaskId('task-1')).toBeNull();
    });

    it('returns the unconsumed row when both a consumed and unconsumed row exist for the same taskId', () => {
      // Insert, consume, then insert again — leaves one consumed + one pending.
      const r1 = store.insertPendingDraft({
        taskId: 'task-multi',
        agentDraft: makeDraft({ summary: 'consumed' }),
      });
      expect(r1.ok).toBe(true);
      expect(store.markConsumed(r1.ok ? r1.id : '').ok).toBe(true);

      const r2 = store.insertPendingDraft({
        taskId: 'task-multi',
        agentDraft: makeDraft({ summary: 'pending' }),
      });
      expect(r2.ok).toBe(true);

      const row = store.getUnconsumedByTaskId('task-multi');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.agentDraft.summary).toBe('pending');
      expect(row.consumedAt).toBeNull();
    });
  });

  describe('markConsumed', () => {
    it('sets consumed_at on an existing row', () => {
      const r = store.insertPendingDraft({ taskId: 'task-1', agentDraft: makeDraft() });
      expect(r.ok).toBe(true);
      const id = r.ok ? r.id : '';

      const markResult = store.markConsumed(id);
      expect(markResult.ok).toBe(true);

      // The row should no longer be returned by getUnconsumedByTaskId.
      expect(store.getUnconsumedByTaskId('task-1')).toBeNull();

      // But it should still exist with consumed_at set.
      const db = connection.getDb();
      const rawRow = db
        .prepare('SELECT consumed_at FROM pending_agent_drafts WHERE id = ?')
        .get(id) as { consumed_at: string | null } | undefined;
      expect(rawRow).toBeDefined();
      if (!rawRow) throw new Error('rawRow is null');
      expect(rawRow.consumed_at).not.toBeNull();
      expect(rawRow.consumed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('returns ok:true for a non-existent id (silent success per spec)', () => {
      const result = store.markConsumed('pad-does-not-exist');
      expect(result.ok).toBe(true);
    });

    it('is idempotent: marking an already-consumed row again still returns ok', () => {
      const r = store.insertPendingDraft({ taskId: 'task-1', agentDraft: makeDraft() });
      expect(r.ok).toBe(true);
      const id = r.ok ? r.id : '';

      expect(store.markConsumed(id).ok).toBe(true);
      // Second mark — should still succeed (consumed_at just refreshes).
      const second = store.markConsumed(id);
      expect(second.ok).toBe(true);
    });
  });

  describe('listPending', () => {
    it('returns empty array when no rows exist', () => {
      expect(store.listPending()).toEqual([]);
    });

    it('returns only unconsumed rows, ordered by created_at DESC', () => {
      // Insert three drafts with distinct taskIds. Use raw SQL to set
      // deterministic created_at values so the ORDER BY is unambiguous.
      const db = connection.getDb();
      const baseDraft = JSON.stringify(makeDraft());
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-old', 'task-old', null, baseDraft, '2026-07-01T00:00:00Z', null);
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-mid', 'task-mid', null, baseDraft, '2026-07-02T00:00:00Z', null);
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-new', 'task-new', null, baseDraft, '2026-07-03T00:00:00Z', null);

      // Mark the middle one consumed — it should be excluded.
      expect(store.markConsumed('pad-mid').ok).toBe(true);

      const rows = store.listPending();
      expect(rows).toHaveLength(2);
      // DESC order: newest first.
      if (!rows[0]) throw new Error('rows[0] is null');
      if (!rows[1]) throw new Error('rows[1] is null');
      expect(rows[0].id).toBe('pad-new');
      expect(rows[1].id).toBe('pad-old');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        store.insertPendingDraft({ taskId: `task-${i}`, agentDraft: makeDraft() });
      }
      const rows = store.listPending({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('defaults to limit=100 when no filter provided', () => {
      for (let i = 0; i < 110; i++) {
        store.insertPendingDraft({ taskId: `task-${i}`, agentDraft: makeDraft() });
      }
      const rows = store.listPending();
      expect(rows).toHaveLength(100);
    });
  });

  describe('agentDraft JSON round-trip (rc-1: treat as unknown)', () => {
    it('preserves nested string fields through serialize/deserialize', () => {
      const draft: AgentDraftPayload = {
        summary: 'complex summary with "quotes"',
        observedFailure: 'multi\nline\nfailure',
        commandSummary: 'cmd: foo --bar baz',
      };
      store.insertPendingDraft({ taskId: 'task-complex', agentDraft: draft });

      const row = store.getUnconsumedByTaskId('task-complex');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.agentDraft.summary).toBe(draft.summary);
      expect(row.agentDraft.observedFailure).toBe(draft.observedFailure);
      expect(row.agentDraft.commandSummary).toBe(draft.commandSummary);
    });

    it('preserves a draft with only the required summary field', () => {
      const draft: AgentDraftPayload = { summary: 'minimal' };
      store.insertPendingDraft({ taskId: 'task-min', agentDraft: draft });

      const row = store.getUnconsumedByTaskId('task-min');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.agentDraft.summary).toBe('minimal');
      expect(row.agentDraft.observedFailure).toBeUndefined();
      expect(row.agentDraft.commandSummary).toBeUndefined();
    });

    it('fails loud when agent_draft is corrupt JSON (rc-3: no silent fallback)', () => {
      // Insert a row with invalid JSON directly via raw SQL.
      const db = connection.getDb();
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-corrupt', 'task-corrupt', null, '{not valid json', '2026-07-04T00:00:00Z', null);

      // getUnconsumedByTaskId should throw (fail loud) rather than return
      // a row with a raw string masquerading as AgentDraftPayload.
      expect(() => store.getUnconsumedByTaskId('task-corrupt')).toThrow(/corrupt agent_draft JSON/);

      // listPending should also throw on the same corrupt row.
      expect(() => store.listPending()).toThrow(/corrupt agent_draft JSON/);
    });

    it('fails loud when agent_draft JSON does not match AgentDraftPayload shape (rc-3)', () => {
      const db = connection.getDb();
      // summary is missing — fails isAgentDraftPayload validation.
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-shape', 'task-shape', null, '{"observedFailure":"x"}', '2026-07-04T00:00:00Z', null);

      expect(() => store.getUnconsumedByTaskId('task-shape')).toThrow(/failed shape validation/);
    });

    it('fails loud when agent_draft is empty string (rc-3: corrupt JSON)', () => {
      const db = connection.getDb();
      // Empty string is a string (passes the typeof guard) but is not valid
      // JSON — JSON.parse('') throws SyntaxError. The store must fail loud
      // rather than return a row whose agentDraft is an empty string.
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-empty', 'task-empty', null, '', '2026-07-04T00:00:00Z', null);

      // Empty string fails JSON.parse — should fail loud as corrupt JSON.
      expect(() => store.getUnconsumedByTaskId('task-empty')).toThrow(/corrupt agent_draft JSON/);
    });
  });
});
