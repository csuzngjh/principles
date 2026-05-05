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
    channel: 'prompt' as TaskRecord['channel'],
    timeoutMs: 300000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    ...overrides,
  } as TaskRecord;
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
    mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

    it('pending task with no deps → logs INTERNALIZATION_TRIGGER_WAKE with correct payload', async () => {
      const task = makeTask({ taskId: 'task-1', taskKind: 'dreamer', status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-1', taskKind: 'dreamer', gateDecision: 'proceed' }),
      );
    });

    it('retry_wait task → logs INTERNALIZATION_TRIGGER_WAKE', async () => {
      const task = makeTask({ taskId: 'task-retry', taskKind: 'philosopher', status: 'retry_wait', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-retry', taskKind: 'philosopher' }),
      );
    });

    it('task with unmet deps → logs INTERNALIZATION_TRIGGER_BLOCKED with gateDecision blocked', async () => {
      const depTask = makeTask({ taskId: 'dep-1', taskKind: 'scribe', status: 'pending', dependencyTaskIds: [] });
      const task = makeTask({ taskId: 'task-blocked', taskKind: 'dreamer', status: 'pending', dependencyTaskIds: ['dep-1'] });
      mockProvider.listTasks.mockResolvedValue([task]);
      mockProvider.getTask.mockResolvedValue(depTask);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED',
        expect.objectContaining({ taskId: 'task-blocked', gateDecision: 'blocked', blockedBy: expect.any(Array) }),
      );
    });

    it('task with failed dep → logs INTERNALIZATION_TRIGGER_BLOCKED with dependency_failed', async () => {
      const depTask = makeTask({ taskId: 'dep-failed', taskKind: 'scribe', status: 'failed', dependencyTaskIds: [] });
      const task = makeTask({ taskId: 'task-dep-failed', taskKind: 'dreamer', status: 'pending', dependencyTaskIds: ['dep-failed'] });
      mockProvider.listTasks.mockResolvedValue([task]);
      mockProvider.getTask.mockResolvedValue(depTask);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED',
        expect.objectContaining({ taskId: 'task-dep-failed', gateDecision: 'dependency_failed' }),
      );
    });

    it('task with missing dep → logs INTERNALIZATION_TRIGGER_BLOCKED (fail closed)', async () => {
      const task = makeTask({ taskId: 'task-missing-dep', taskKind: 'dreamer', status: 'pending', dependencyTaskIds: ['nonexistent'] });
      mockProvider.listTasks.mockResolvedValue([task]);
      mockProvider.getTask.mockResolvedValue(null);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED',
        expect.objectContaining({ taskId: 'task-missing-dep', gateDecision: 'blocked' }),
      );
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