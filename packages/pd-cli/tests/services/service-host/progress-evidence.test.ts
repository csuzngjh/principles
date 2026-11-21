/**
 * lastProgressAt evidence (task §6 / FR-10): a pure status-map diff — new
 * tasks and STATUS transitions count as progress; a updatedAt-only bump
 * (lease renewal) does NOT — plus a real state-store roundtrip through the
 * read-only snapshot reader.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeStateHandle } from '@principles/core/runtime';
import {
  diffTaskProgress,
  readTaskProgressSnapshot,
  type TaskProgressSnapshot,
} from '../../../src/services/service-host/progress-evidence.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-progress-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function snapshot(entries: readonly [string, string][], maxUpdatedAt: string | null): TaskProgressSnapshot {
  return { tasks: new Map(entries), maxUpdatedAt };
}

describe('diffTaskProgress (pure)', () => {
  it('a NEW task is business progress with the after-snapshot max timestamp', () => {
    const before = snapshot([], null);
    const after = snapshot([['t1', 'pending']], '2026-11-21T10:00:00Z');
    const diff = diffTaskProgress(before, after);
    expect(diff.taskStateChanged).toBe(true);
    expect(diff.changedCount).toBe(1);
    expect(diff.changedAt).toBe('2026-11-21T10:00:00Z');
  });

  it('a STATUS transition is business progress (pending → succeeded)', () => {
    const before = snapshot([['t1', 'pending']], '2026-11-21T10:00:00Z');
    const after = snapshot([['t1', 'succeeded']], '2026-11-21T10:05:00Z');
    const diff = diffTaskProgress(before, after);
    expect(diff.taskStateChanged).toBe(true);
    expect(diff.changedCount).toBe(1);
    expect(diff.changedAt).toBe('2026-11-21T10:05:00Z');
  });

  it('a updatedAt-only bump (lease renewal, SAME status) is NOT progress — the empty-cycle rule (task §6)', () => {
    const before = snapshot([['t1', 'leased']], '2026-11-21T10:00:00Z');
    const after = snapshot([['t1', 'leased']], '2026-11-21T10:02:00Z');
    const diff = diffTaskProgress(before, after);
    expect(diff.taskStateChanged).toBe(false);
    expect(diff.changedCount).toBe(0);
    expect(diff.changedAt).toBeNull();
  });

  it('identical snapshots are not progress', () => {
    const before = snapshot([['t1', 'pending'], ['t2', 'retry_wait']], '2026-11-21T10:00:00Z');
    const diff = diffTaskProgress(before, { tasks: before.tasks, maxUpdatedAt: before.maxUpdatedAt });
    expect(diff.taskStateChanged).toBe(false);
  });
});

describe('readTaskProgressSnapshot (real store)', () => {
  it('round-trips tasks through the reader; a missing store is an EMPTY snapshot, never created', async () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    const handle = await createRuntimeStateHandle({ workspaceDir: workspace, readonly: false, bootstrapIfMissing: true });
    try {
      await handle.stateManager.createTask({
        taskId: 'task-progress-fixture-1',
        taskKind: 'diagnostician',
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
    const read = readTaskProgressSnapshot(workspace);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.snapshot.tasks.get('task-progress-fixture-1')).toBe('pending');
      expect(read.snapshot.maxUpdatedAt).not.toBeNull();
      expect(read.snapshot.storePresent).toBe(true);
    }

    // No .pd state store at all → EMPTY snapshot (nothing persisted, nothing
    // progressed), and the reader must not fabricate the file.
    const empty = tempDir();
    const missing = readTaskProgressSnapshot(empty);
    expect(missing.ok).toBe(true);
    if (missing.ok) {
      expect(missing.snapshot.tasks.size).toBe(0);
      expect(missing.snapshot.storePresent).toBe(false);
      expect(missing.snapshot.maxUpdatedAt).toBeNull();
    }
    expect(existsSync(path.join(empty, '.pd', 'state.db'))).toBe(false);
  });

  it('a CORRUPT store is a structured failure (rc-9), never a guess', () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    writeFileSync(path.join(workspace, '.pd', 'state.db'), 'definitely not a sqlite database', 'utf8');
    const corrupt = readTaskProgressSnapshot(workspace);
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.reason).toContain('progress_snapshot');
  });
});
