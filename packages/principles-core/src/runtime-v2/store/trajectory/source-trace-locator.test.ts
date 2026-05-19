/**
 * SourceTraceLocator contract tests — PRI-189.
 *
 * Tests the formalized source trace lookup semantics extracted from
 * SqliteContextAssembler. Covers all SourceTraceLocateDecision values
 * and the core invariant: fullTrace only comes from sourcePainId-aligned
 * source task/runs.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from '../sqlite-connection.js';
import { SqliteTaskStore } from '../task/sqlite-task-store.js';
import { SqliteTrajectoryLocator } from './sqlite-trajectory-locator.js';
import { SqliteSourceTraceLocator } from './sqlite-source-trace-locator.js';
import type { TaskRecord } from '../../task-status.js';
import type { SourceTraceLocateQuery } from './source-trace-locator.js';

interface TestFixture {
  tmpDir: string;
  connection: SqliteConnection;
  taskStore: SqliteTaskStore;
  trajectoryLocator: SqliteTrajectoryLocator;
  sourceTraceLocator: SqliteSourceTraceLocator;
}

const WORKSPACE = '/tmp/test-workspace';

function createFixture(): TestFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-source-trace-locator-test-'));
  const connection = new SqliteConnection(tmpDir);
  const taskStore = new SqliteTaskStore(connection);
  const trajectoryLocator = new SqliteTrajectoryLocator(connection);
  const sourceTraceLocator = new SqliteSourceTraceLocator(taskStore, trajectoryLocator);
  return { tmpDir, connection, taskStore, trajectoryLocator, sourceTraceLocator };
}

function cleanupFixture(fixture: TestFixture): void {
  fixture.connection.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

async function createSourceTask(
  fixture: TestFixture,
  taskId: string,
  opts: { sessionId: string; sourcePainId?: string; painId?: string },
): Promise<void> {
  const dj: Record<string, unknown> = { sessionIdHint: opts.sessionId };
  if (opts.sourcePainId) dj.sourcePainId = opts.sourcePainId;
  if (opts.painId) dj.painId = opts.painId;
  const existing = await fixture.taskStore.getTask(taskId);
  if (!existing) {
    await fixture.taskStore.createTask({
      taskId,
      taskKind: 'user_session',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 1,
      diagnosticJson: JSON.stringify(dj),
    } satisfies Omit<TaskRecord, 'createdAt' | 'updatedAt'>);
  }
}

function q(overrides: Partial<SourceTraceLocateQuery> = {}): SourceTraceLocateQuery {
  return {
    sourcePainId: overrides.sourcePainId,
    sessionIdHint: overrides.sessionIdHint,
    workspaceDir: overrides.workspaceDir ?? WORKSPACE,
    excludeTaskIds: overrides.excludeTaskIds,
  };
}

describe('SqliteSourceTraceLocator', () => {

  it('returns found when source task diagnosticJson has matching sourcePainId', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_src_1', { sessionId: 'sess-1', sourcePainId: 'pain-A' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-A',
        sessionIdHint: 'sess-1',
      }));

      expect(result.decision).toBe('found');
      expect(result.candidate).not.toBeNull();
      if (result.candidate) {
        expect(result.candidate.taskId).toBe('task_src_1');
        expect(result.candidate.sourcePainId).toBe('pain-A');
      }
      expect(result.candidates.length).toBe(1);
    } finally { cleanupFixture(f); }
  });

  it('returns found when source task diagnosticJson has matching painId (not sourcePainId)', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_src_painid', { sessionId: 'sess-painid', painId: 'pain-B' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-B',
        sessionIdHint: 'sess-painid',
      }));

      expect(result.decision).toBe('found');
      expect(result.candidate).not.toBeNull();
      if (result.candidate) {
        expect(result.candidate.taskId).toBe('task_src_painid');
      }
    } finally { cleanupFixture(f); }
  });

  it('returns missing_source_pain_id when query has no sourcePainId', async () => {
    const f = createFixture();
    try {
      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: undefined,
        sessionIdHint: 'sess-any',
      }));

      expect(result.decision).toBe('missing_source_pain_id');
      expect(result.candidate).toBeNull();
      expect(result.ambiguityNotes.length).toBeGreaterThan(0);
    } finally { cleanupFixture(f); }
  });

  it('returns missing_session_hint when query has no sessionIdHint', async () => {
    const f = createFixture();
    try {
      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-X',
        sessionIdHint: undefined,
      }));

      expect(result.decision).toBe('missing_session_hint');
      expect(result.candidate).toBeNull();
      expect(result.ambiguityNotes.length).toBeGreaterThan(0);
    } finally { cleanupFixture(f); }
  });

  it('does not return found when session has task but diagnosticJson has no sourcePainId/painId', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_no_pain', { sessionId: 'sess-nopain' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-missing',
        sessionIdHint: 'sess-nopain',
      }));

      expect(result.decision).not.toBe('found');
      expect(result.candidate).toBeNull();
    } finally { cleanupFixture(f); }
  });

  it('returns source_pain_mismatch when candidate has different sourcePainId', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_mismatch', { sessionId: 'sess-mismatch', sourcePainId: 'pain-B' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-A',
        sessionIdHint: 'sess-mismatch',
      }));

      expect(result.decision).toBe('source_pain_mismatch');
      expect(result.candidate).toBeNull();
      expect(result.ambiguityNotes.some(n => n.includes('mismatch'))).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('returns not_found when session has no tasks at all', async () => {
    const f = createFixture();
    try {
      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-orphan',
        sessionIdHint: 'sess-empty',
      }));

      expect(result.decision).toBe('not_found');
      expect(result.candidate).toBeNull();
    } finally { cleanupFixture(f); }
  });

  it('returns ambiguous when multiple candidates match same sourcePainId', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_amb_1', { sessionId: 'sess-amb', sourcePainId: 'pain-amb' });
      await createSourceTask(f, 'task_amb_2', { sessionId: 'sess-amb', sourcePainId: 'pain-amb' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-amb',
        sessionIdHint: 'sess-amb',
      }));

      expect(result.decision).toBe('ambiguous');
      expect(result.candidate).toBeNull();
      expect(result.candidates.length).toBe(2);
      expect(result.ambiguityNotes.some(n => n.includes('task_amb_1') || n.includes('task_amb_2'))).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('excludes tasks listed in excludeTaskIds', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_diag_self', { sessionId: 'sess-excl', sourcePainId: 'pain-excl' });
      await createSourceTask(f, 'task_real_source', { sessionId: 'sess-excl', sourcePainId: 'pain-excl' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-excl',
        sessionIdHint: 'sess-excl',
        excludeTaskIds: ['task_diag_self'],
      }));

      expect(result.decision).toBe('found');
      expect(result.candidate).not.toBeNull();
      if (result.candidate) {
        expect(result.candidate.taskId).toBe('task_real_source');
      }
      expect(result.candidates.every(c => c.taskId !== 'task_diag_self')).toBe(true);
    } finally { cleanupFixture(f); }
  });

  it('returns not_found when all matching candidates are excluded', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_only_one', { sessionId: 'sess-excl-all', sourcePainId: 'pain-excl-all' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-excl-all',
        sessionIdHint: 'sess-excl-all',
        excludeTaskIds: ['task_only_one'],
      }));

      expect(result.decision).toBe('not_found');
      expect(result.candidate).toBeNull();
    } finally { cleanupFixture(f); }
  });

  it('handles candidate with null diagnosticJson without crashing', async () => {
    const f = createFixture();
    try {
      const db = f.connection.getDb();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('task_null_dj', 'user_session', 'succeeded', now, now, 1, 1, null);

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-nulldj',
        sessionIdHint: 'sess-nulldj',
      }));

      expect(result.decision).not.toBe('found');
      expect(result.candidate).toBeNull();
    } finally { cleanupFixture(f); }
  });

  it('returns storage_unavailable when TrajectoryLocator is not provided', async () => {
    const f = createFixture();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const locator = new SqliteSourceTraceLocator(f.taskStore, undefined as any);

      const result = await locator.locate(q({
        sourcePainId: 'pain-no-traj',
        sessionIdHint: 'sess-no-traj',
      }));

      expect(result.decision).toBe('storage_unavailable');
      expect(result.candidate).toBeNull();
      expect(result.ambiguityNotes.length).toBeGreaterThan(0);
    } finally { cleanupFixture(f); }
  });

  it('does not return found based on sessionIdHint alone without sourcePainId match', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_session_only', { sessionId: 'sess-session-only', sourcePainId: 'pain-other' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-different',
        sessionIdHint: 'sess-session-only',
      }));

      expect(result.decision).not.toBe('found');
      expect(result.candidate).toBeNull();
    } finally { cleanupFixture(f); }
  });

  it('returns found with correct sourceTypes from TrajectoryLocator candidates', async () => {
    const f = createFixture();
    try {
      await createSourceTask(f, 'task_sourcetypes', { sessionId: 'sess-st', sourcePainId: 'pain-st' });

      const result = await f.sourceTraceLocator.locate(q({
        sourcePainId: 'pain-st',
        sessionIdHint: 'sess-st',
      }));

      expect(result.decision).toBe('found');
      expect(result.candidate).not.toBeNull();
      if (result.candidate) {
        expect(result.candidate.sourceTypes.length).toBeGreaterThan(0);
      }
    } finally { cleanupFixture(f); }
  });
});
