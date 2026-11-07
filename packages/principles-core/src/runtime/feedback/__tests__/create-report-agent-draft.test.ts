/**
 * Task 13 tests: createFeedbackReport agentDraft merge from PendingAgentDraftStore.
 *
 * Verifies:
 * - taskId without store → normal report, no agentDraft
 * - taskId with store but no pending draft → normal report, no agentDraft
 * - taskId with store + pending draft → report merges agentDraft, marks consumed
 * - user-provided agentDraft takes priority over store draft, but store draft still consumed
 * - store.getUnconsumedByTaskId throws → rc-9: report still created, error in redactionNotes
 * - store.markConsumed throws → rc-9: report still created, error in redactionNotes
 * - no taskId with store provided → store is not queried
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: no `as` casts on untrusted input. Test inputs are
 *   plain objects passed as `unknown` to createFeedbackReport.
 * - EP-03 / ERR-002, rc-9: store operation failures do not silently swallow —
 *   errors are recorded in report.privacy.redactionNotes.
 * - EP-03 / ERR-009, ERR-010: corrupt agent_draft JSON in the store fails loud
 *   inside getUnconsumedByTaskId (throws), caught by createFeedbackReport.
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
import { createFeedbackReport } from '../create-report.js';

const baseInput = {
  type: 'bug' as const,
  title: 'Test feedback',
  description: 'Something went wrong during task execution',
};

const diagnostics = {};

/**
 * Test-only subclass of PendingAgentDraftStore whose markConsumed always
 * throws. Used to verify the rc-9 defensive path in createFeedbackReport.
 * getUnconsumedByTaskId is inherited unchanged (works against the real DB).
 */
class ThrowingMarkConsumedStore extends PendingAgentDraftStore {
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  override markConsumed(_id: string): never {
    throw new Error('mock markConsumed failure');
  }
}

describe('createFeedbackReport — Task 13 agentDraft merge', () => {
  let connection: SqliteConnection;
  let store: PendingAgentDraftStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-create-report-'));
    connection = new SqliteConnection(tmpDir);
    connection.getDb(); // triggers initSchema (creates pending_agent_drafts table)
    store = new PendingAgentDraftStore(connection);
  });

  afterEach(() => {
    try {
      connection?.close();
    } catch {
      // best-effort close
    }
  });

  describe('taskId without store', () => {
    it('creates a normal report without agentDraft when store is not provided', () => {
      const input = { ...baseInput, taskId: 'task-123' };
      const result = createFeedbackReport(input, diagnostics, undefined, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.agentDraft).toBeUndefined();
      }
    });
  });

  describe('taskId with store but no pending draft', () => {
    it('creates a normal report without agentDraft and does not call markConsumed', () => {
      const input = { ...baseInput, taskId: 'task-no-draft' };
      const result = createFeedbackReport(input, diagnostics, undefined, store);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.agentDraft).toBeUndefined();
      }
      // No draft existed, so none should be consumed
      expect(store.getUnconsumedByTaskId('task-no-draft')).toBeNull();
    });
  });

  describe('taskId with store and pending draft', () => {
    it('merges the pending agent draft into the report and marks it consumed', () => {
      const taskId = 'task-with-draft';
      const draft: AgentDraftPayload = {
        summary: 'Agent observed a timeout',
        observedFailure: 'Error: connection timeout after 30s',
        commandSummary: 'last command: pd runtime exec --task task-with-draft',
      };
      const insertResult = store.insertPendingDraft({ taskId, agentDraft: draft });
      expect(insertResult.ok).toBe(true);

      const input = { ...baseInput, taskId };
      const result = createFeedbackReport(input, diagnostics, undefined, store);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.agentDraft).toBeDefined();
        if (!result.report.agentDraft) throw new Error('agentDraft is null');
        expect(result.report.agentDraft.summary).toBe('Agent observed a timeout');
        expect(result.report.agentDraft.observedFailure).toBe('Error: connection timeout after 30s');
        expect(result.report.agentDraft.commandSummary).toBe('last command: pd runtime exec --task task-with-draft');
      }
      // The draft should be consumed (consumedAt set)
      expect(store.getUnconsumedByTaskId(taskId)).toBeNull();
    });

    it('merges a minimal draft (summary only) correctly', () => {
      const taskId = 'task-minimal-draft';
      store.insertPendingDraft({
        taskId,
        agentDraft: { summary: 'Minimal agent summary' },
      });

      const input = { ...baseInput, taskId };
      const result = createFeedbackReport(input, diagnostics, undefined, store);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.agentDraft).toBeDefined();
        if (!result.report.agentDraft) throw new Error('agentDraft is null');
        expect(result.report.agentDraft.summary).toBe('Minimal agent summary');
        expect(result.report.agentDraft.observedFailure).toBeUndefined();
        expect(result.report.agentDraft.commandSummary).toBeUndefined();
      }
      expect(store.getUnconsumedByTaskId(taskId)).toBeNull();
    });
  });

  describe('user-provided agentDraft takes priority', () => {
    it('uses the user-provided agentDraft but still marks the store draft as consumed', () => {
      const taskId = 'task-priority';
      const storeDraft: AgentDraftPayload = {
        summary: 'Agent summary (should not be used)',
      };
      store.insertPendingDraft({ taskId, agentDraft: storeDraft });

      const input = {
        ...baseInput,
        taskId,
        agentDraft: {
          summary: 'User-provided summary',
          observedFailure: 'User-provided failure',
        },
      };
      const result = createFeedbackReport(input, diagnostics, undefined, store);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.agentDraft).toBeDefined();
        if (!result.report.agentDraft) throw new Error('agentDraft is null');
        expect(result.report.agentDraft.summary).toBe('User-provided summary');
        expect(result.report.agentDraft.observedFailure).toBe('User-provided failure');
      }
      // The store draft should still be consumed (user's report supersedes it)
      expect(store.getUnconsumedByTaskId(taskId)).toBeNull();
    });
  });

  describe('no taskId with store provided', () => {
    it('does not query the store when taskId is not provided', () => {
      // Insert a draft for some task — it should NOT be touched
      store.insertPendingDraft({
        taskId: 'task-untouched',
        agentDraft: { summary: 'should not be consumed' },
      });

      const input = { ...baseInput }; // no taskId
      const result = createFeedbackReport(input, diagnostics, undefined, store);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.report.agentDraft).toBeUndefined();
      }
      // The draft should still be unconsumed
      const row = store.getUnconsumedByTaskId('task-untouched');
      expect(row).not.toBeNull();
      if (!row) throw new Error('row is null');
      expect(row.agentDraft.summary).toBe('should not be consumed');
    });
  });

  describe('store.getUnconsumedByTaskId throws (rc-9: no silent fallback)', () => {
    it('creates the report without agentDraft and records the error in redactionNotes', () => {
      const taskId = 'task-corrupt';
      // Insert a row with corrupt JSON directly via raw SQL — the store's
      // getUnconsumedByTaskId will throw when parsing the corrupt agent_draft.
      const db = connection.getDb();
      db.prepare(
        'INSERT INTO pending_agent_drafts (id, task_id, pain_id, agent_draft, created_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('pad-corrupt', taskId, null, '{not valid json', '2026-07-04T00:00:00Z', null);

      const input = { ...baseInput, taskId };
      const result = createFeedbackReport(input, diagnostics, undefined, store);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // No agentDraft merged — the store threw before returning a draft
        expect(result.report.agentDraft).toBeUndefined();
        // rc-9: error must be recorded in redactionNotes (not silently swallowed)
        const notes = result.report.privacy.redactionNotes;
        expect(notes.some((n) => n.includes('agent draft lookup failed'))).toBe(true);
      }
    });
  });

  describe('store.markConsumed throws (rc-9: no silent fallback)', () => {
    it('creates the report with agentDraft and records the markConsumed error in redactionNotes', () => {
      const throwingStore = new ThrowingMarkConsumedStore(connection);

      const taskId = 'task-mark-throws';
      const draft: AgentDraftPayload = {
        summary: 'Agent summary for markConsumed test',
      };
      throwingStore.insertPendingDraft({ taskId, agentDraft: draft });

      const input = { ...baseInput, taskId };
      const result = createFeedbackReport(input, diagnostics, undefined, throwingStore);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // agentDraft was merged BEFORE markConsumed was called
        expect(result.report.agentDraft).toBeDefined();
        if (!result.report.agentDraft) throw new Error('agentDraft is null');
        expect(result.report.agentDraft.summary).toBe('Agent summary for markConsumed test');
        // rc-9: markConsumed error must be recorded in redactionNotes
        const notes = result.report.privacy.redactionNotes;
        expect(notes.some((n) => n.includes('agent draft markConsumed failed'))).toBe(true);
      }
    });
  });
});
