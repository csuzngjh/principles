/**
 * Internalization Trigger Adapter - Unit Tests (PRI-63)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { TaskRecord } from '@principles/core/runtime-v2';

type MockLogger = {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
};

interface MockProvider {
  listTasks: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
}

function makeTask(overrides: Partial<TaskRecord> & { taskId: string; taskKind: string }): TaskRecord {
  return {
    taskId: overrides.taskId,
    taskKind: overrides.taskKind,
    status: overrides.status ?? 'pending',
    resultRef: undefined,
    lastError: undefined,
    attemptCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dependencyTaskIds: overrides.dependencyTaskIds ?? [],
    correlationId: overrides.correlationId,
    ...overrides,
  };
}

function readAdapterSource(): string {
  return readFileSync(
    resolve(__dirname, '../../src/service/internalization-trigger-adapter.ts'),
    'utf8',
  );
}

describe('Internalization Trigger Adapter', () => {
  let mockProvider: MockProvider;
  let mockLogger: MockLogger;
  let adapter: {
    wake: (ctx: { workspaceDir: string; stateDir: string }) => Promise<void>;
    start: (ctx: { workspaceDir: string; stateDir: string }, intervalMs?: number) => () => void;
    stop: () => void;
  };

  beforeEach(async () => {
    mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    mockProvider = { listTasks: vi.fn(), getTask: vi.fn() };
    const mod = await import('../../src/service/internalization-trigger-adapter.js');
    adapter = mod.createInternalizationTrigger(
      mockProvider as import('../../src/service/internalization-trigger-adapter.js').InternalizationTaskProvider,
      mockLogger,
    ) as typeof adapter;
  });

  describe('wake — basic behavior', () => {
    it('no pending tasks → returns without error', async () => {
      mockProvider.listTasks.mockResolvedValue([]);
      await expect(adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' })).resolves.not.toThrow();
    });

    it('pending task with no deps → does not throw', async () => {
      const task = makeTask({ taskId: 'task-1', taskKind: 'dreamer', status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await expect(adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' })).resolves.not.toThrow();
    });

    it('retry_wait task → does not throw', async () => {
      const task = makeTask({ taskId: 'task-retry', taskKind: 'philosopher', status: 'retry_wait', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await expect(adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' })).resolves.not.toThrow();
    });
  });

  describe('wake — fail closed', () => {
    it('missing workspaceDir → does not throw', async () => {
      await expect(adapter.wake({ workspaceDir: '', stateDir: '/test/.state' })).resolves.not.toThrow();
    });

    it('missing stateDir → does not throw', async () => {
      await expect(adapter.wake({ workspaceDir: '/test', stateDir: '' })).resolves.not.toThrow();
    });

    it('provider throws → does not throw', async () => {
      mockProvider.listTasks.mockRejectedValue(new Error('SQLite error'));
      await expect(adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' })).resolves.not.toThrow();
    });

    it('task with unknown taskKind → filtered out silently', async () => {
      const unknownTask = makeTask({ taskId: 'task-unknown', taskKind: 'diagnostician', status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([unknownTask]);
      await expect(adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' })).resolves.not.toThrow();
    });
  });

  describe('wake — fire and forget', () => {
    it('wake() returns in < 200ms even with many tasks', async () => {
      const manyTasks = Array.from({ length: 20 }, (_, i) =>
        makeTask({ taskId: `task-${i}`, taskKind: 'dreamer', status: 'pending', dependencyTaskIds: [] }),
      );
      mockProvider.listTasks.mockResolvedValue(manyTasks);
      const start = Date.now();
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(Date.now() - start).toBeLessThan(200);
    });

    it('wake() calls only read methods', async () => {
      const task = makeTask({ taskId: 'task-readonly', taskKind: 'scribe', status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockProvider.listTasks).toHaveBeenCalled();
    });
  });

  describe('start / stop', () => {
    beforeEach(() => { vi.useFakeTimers(); });

    it('start() returns a stop function', () => {
      mockProvider.listTasks.mockResolvedValue([]);
      const stop = adapter.start({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(typeof stop).toBe('function');
      stop();
    });

    it('stop() is idempotent', () => {
      mockProvider.listTasks.mockResolvedValue([]);
      const stop = adapter.start({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(() => stop()).not.toThrow();
      expect(() => stop()).not.toThrow();
    });
  });

  describe('architecture guards (source-level)', () => {
    it('does not import nocturnal-trinity', () => {
      expect(readAdapterSource()).not.toContain('nocturnal-trinity');
    });

    it('does not import runTrinity', () => {
      expect(readAdapterSource()).not.toContain('runTrinity');
    });

    it('does import @principles/core/runtime-v2', () => {
      expect(readAdapterSource()).toContain('@principles/core/runtime-v2');
    });
  });
});