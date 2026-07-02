/**
 * Regression test for concurrent race condition in processEvolutionQueueWithResult.
 *
 * Defect: loadEvolutionQueue + purgeStaleFailedTasks + saveEvolutionQueue ran without
 * lock protection, causing:
 * - Data loss when concurrent cycles overwrite each other's purge results
 * - Queue corruption from concurrent uncoordinated writes
 * - Task duplication as deleted tasks reappear in subsequent cycles
 *
 * Fix: Acquire lock BEFORE any queue operations (load/purge/save/process).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { processEvolutionQueueWithResult, purgeStaleFailedTasks } from '../../src/service/evolution-worker.js';
import { saveEvolutionQueue, loadEvolutionQueue, acquireQueueLock } from '../../src/service/queue-io.js';
import type { EvolutionQueueItem } from '../../src/core/evolution-types.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';
import type { EventLog } from '../../src/core/event-log.js';
import type { PluginLogger } from '../../src/openclaw-sdk.js';

// Mock logger
const mockLogger: PluginLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock workspace context
class MockWorkspaceContext implements WorkspaceContext {
  workspaceDir: string;
  stateDir: string;
  config: any;
  eventLog: EventLog;

  constructor(dir: string) {
    this.workspaceDir = dir;
    this.stateDir = path.join(dir, '.principles');
    this.config = new Map([
      ['language', 'en'],
      ['intervals.worker_poll_ms', 900000],
    ]);
    this.eventLog = { write: vi.fn() } as any;
  }

  resolve(key: string): string {
    if (key === 'EVOLUTION_QUEUE') {
      return path.join(this.stateDir, 'evolution_queue.json');
    }
    return '';
  }

  static fromHookContext(ctx: any): WorkspaceContext {
    return new MockWorkspaceContext(ctx.workspaceDir);
  }
}

describe('processEvolutionQueueWithResult concurrent race condition fix', () => {
  let tempDir: string;
  let queuePath: string;
  let wctx: MockWorkspaceContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queue-race-test-'));
    wctx = new MockWorkspaceContext(tempDir);
    queuePath = wctx.resolve('EVOLUTION_QUEUE');

    // Ensure state directory exists
    fs.mkdirSync(wctx.stateDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prevents concurrent purge operations from losing data (regression test)', async () => {
    // Setup: Create queue with stale failed task (25 hours old)
    const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const queue: EvolutionQueueItem[] = [
      {
        id: 'stale-task-1',
        taskKind: 'model_eval',
        priority: 'medium',
        source: 'test',
        score: 50,
        reason: 'stale failure',
        timestamp: staleTimestamp,
        status: 'failed',
        resolution: 'failed_max_retries',
        retryCount: 3,
        maxRetries: 3,
        lastError: 'timeout',
      },
      {
        id: 'active-task-1',
        taskKind: 'model_eval',
        priority: 'high',
        source: 'test',
        score: 80,
        reason: 'active task',
        timestamp: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
      },
    ];
    saveEvolutionQueue(queuePath, queue);

    // Simulate concurrent execution: two cycles start simultaneously
    // WITHOUT the fix, they would both load the original queue and purge independently,
    // potentially causing one to overwrite the other's changes.

    // With the fix: lock is acquired before any operations, preventing race
    const cycle1Promise = processEvolutionQueueWithResult(wctx, mockLogger, wctx.eventLog, undefined);
    const cycle2Promise = processEvolutionQueueWithResult(wctx, mockLogger, wctx.eventLog, undefined);

    // Wait for both cycles to complete
    const [result1, result2] = await Promise.all([cycle1Promise, cycle2Promise]);

    // Verify: stale task should be purged once, not duplicated
    const finalQueue = loadEvolutionQueue(queuePath);

    // The stale task should be removed
    expect(finalQueue.find(t => t.id === 'stale-task-1')).toBeUndefined();

    // The active task should still exist
    expect(finalQueue.find(t => t.id === 'active-task-1')).toBeDefined();

    // Total should be 1 (only active task remains)
    expect(finalQueue.length).toBe(1);

    // Both cycles should report same consistent state
    expect(result1.queue.total).toBe(1);
    expect(result2.queue.total).toBe(1);
  });

  it('ensures lock is held during load-purge-save sequence', async () => {
    // Setup: Create queue with stale failed task
    const staleTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const queue: EvolutionQueueItem[] = [
      {
        id: 'stale-task',
        taskKind: 'model_eval',
        priority: 'medium',
        source: 'test',
        score: 50,
        reason: 'stale',
        timestamp: staleTimestamp,
        status: 'failed',
        retryCount: 3,
        maxRetries: 3,
      },
    ];
    saveEvolutionQueue(queuePath, queue);

    // Attempt to acquire lock during processEvolutionQueueWithResult execution
    // This should wait until processEvolutionQueueWithResult releases its lock
    let lockAcquiredDuringProcess = false;
    const lockPromise = acquireQueueLock(queuePath, mockLogger, '.lock').then((release) => {
      lockAcquiredDuringProcess = true;
      release();
    });

    // Start processing
    const processPromise = processEvolutionQueueWithResult(wctx, mockLogger, wctx.eventLog, undefined);

    // Give process a moment to acquire its lock
    await vi.advanceTimersByTimeAsync(10);

    // Lock acquisition should not have completed yet (process holds the lock)
    expect(lockAcquiredDuringProcess).toBe(false);

    // Complete processing
    await processPromise;

    // Now lock acquisition should succeed
    await lockPromise;
    expect(lockAcquiredDuringProcess).toBe(true);
  });

  it('prevents queue corruption from simultaneous writes', async () => {
    // Setup: Create initial queue
    const queue: EvolutionQueueItem[] = [
      {
        id: 'task-1',
        taskKind: 'model_eval',
        priority: 'medium',
        source: 'test',
        score: 50,
        reason: 'test',
        timestamp: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
      },
    ];
    saveEvolutionQueue(queuePath, queue);

    // Simulate 10 concurrent cycles
    const promises = Array(10).fill(null).map(() =>
      processEvolutionQueueWithResult(wctx, mockLogger, wctx.eventLog, undefined)
    );

    await Promise.all(promises);

    // Verify: queue should be valid JSON and not corrupted
    const rawContent = fs.readFileSync(queuePath, 'utf8');
    expect(() => JSON.parse(rawContent)).not.toThrow();

    const finalQueue = JSON.parse(rawContent);
    expect(Array.isArray(finalQueue)).toBe(true);

    // Task should still exist (not lost due to corruption)
    expect(finalQueue.find(t => t.id === 'task-1')).toBeDefined();
  });
});