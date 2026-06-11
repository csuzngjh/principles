/**
 * Internalization Trigger Adapter - Unit Tests (PRI-63/65)
 *
 * PRI-65: Updated to use diagnosticJson for PI metadata, simulating
 * real SqliteTaskStore behavior where PI fields live inside diagnosticJson.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { TaskRecord } from '@principles/core/runtime-v2';
import { createPITaskDiagnosticJson } from '@principles/core/runtime-v2';
import type { InternalizationChannel, ArtifactRef } from '@principles/core/runtime-v2';

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

/** Create a base TaskRecord (no PI metadata). Provider returns this from SQLite. */
function makeTask(overrides: Partial<TaskRecord> & { taskId: string; taskKind: string }): TaskRecord {
  return {
    taskId: overrides.taskId,
    taskKind: overrides.taskKind,
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    attemptCount: 0,
    maxAttempts: 3,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
    inputRef: undefined,
    resultRef: undefined,
    ...overrides,
  } as TaskRecord;
}

/** Create a TaskRecord with PI metadata stored in diagnosticJson (simulates SqliteTaskStore). */
function makePITask(
  taskId: string,
  taskKind: string,
  channel: InternalizationChannel,
  options?: {
    status?: TaskRecord['status'];
    dependencyTaskIds?: string[];
    parentTaskId?: string;
    correlationId?: string;
    timeoutMs?: number;
    inputArtifactRefs?: ArtifactRef[];
    outputArtifactRefs?: ArtifactRef[];
  },
): TaskRecord {
  const meta = {
    dependencyTaskIds: options?.dependencyTaskIds ?? [],
    channel,
    timeoutMs: options?.timeoutMs ?? 300000,
    inputArtifactRefs: options?.inputArtifactRefs ?? [],
    outputArtifactRefs: options?.outputArtifactRefs ?? [],
    parentTaskId: options?.parentTaskId,
    correlationId: options?.correlationId,
  };
  return {
    ...makeTask({ taskId, taskKind, status: options?.status ?? 'pending' }),
    diagnosticJson: createPITaskDiagnosticJson(meta),
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
      const task = makePITask('task-1', 'dreamer', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-1', taskKind: 'dreamer', gateDecision: 'proceed' }),
      );
    });

    it('retry_wait task → logs INTERNALIZATION_TRIGGER_WAKE', async () => {
      const task = makePITask('task-retry', 'philosopher', 'prompt', { status: 'retry_wait', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-retry', taskKind: 'philosopher' }),
      );
    });

    it('task with unmet deps → logs INTERNALIZATION_TRIGGER_BLOCKED with gateDecision blocked', async () => {
      const depTask = makePITask('dep-1', 'scribe', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      const task = makePITask('task-blocked', 'dreamer', 'prompt', { status: 'pending', dependencyTaskIds: ['dep-1'] });
      mockProvider.listTasks.mockResolvedValue([task]);
      mockProvider.getTask.mockResolvedValue(depTask);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED',
        expect.objectContaining({ taskId: 'task-blocked', gateDecision: 'blocked', blockedBy: expect.any(Array) }),
      );
    });

    it('task with failed dep → logs INTERNALIZATION_TRIGGER_BLOCKED with dependency_failed', async () => {
      const depTask = makePITask('dep-failed', 'scribe', 'prompt', { status: 'failed', dependencyTaskIds: [] });
      const task = makePITask('task-dep-failed', 'dreamer', 'prompt', { status: 'pending', dependencyTaskIds: ['dep-failed'] });
      mockProvider.listTasks.mockResolvedValue([task]);
      mockProvider.getTask.mockResolvedValue(depTask);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED',
        expect.objectContaining({ taskId: 'task-dep-failed', gateDecision: 'dependency_failed' }),
      );
    });

    it('task with missing dep → logs INTERNALIZATION_TRIGGER_BLOCKED (fail closed)', async () => {
      const task = makePITask('task-missing-dep', 'dreamer', 'prompt', { status: 'pending', dependencyTaskIds: ['nonexistent'] });
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
        makePITask(`task-${i}`, 'dreamer', 'prompt', { status: 'pending', dependencyTaskIds: [] }),
      );
      mockProvider.listTasks.mockResolvedValue(manyTasks);
      const start = Date.now();
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(Date.now() - start).toBeLessThan(200);
    });

    it('wake() calls only read methods', async () => {
      const task = makePITask('task-readonly', 'scribe', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockProvider.listTasks).toHaveBeenCalled();
    });
  });

  describe('start / stop', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

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

    it('imports hydratePITaskRecord from core (not own JSON.parse)', () => {
      const src = readAdapterSource();
      expect(src).toContain('hydratePITaskRecord');
      // Must not contain ad-hoc JSON.parse for PI metadata
      expect(src).not.toMatch(/JSON\.parse.*diagnosticJson/);
    });

    it('does NOT use isValidPITaskRecord directly on raw provider tasks', () => {
      // The adapter now uses hydratePITaskRecord instead of isValidPITaskRecord
      // to determine if a task is a valid PI task.
      // isValidPITaskRecord checks top-level fields which don't exist on persisted tasks.
      const src = readAdapterSource();
      expect(src).not.toMatch(/isValidPITaskRecord\s*\(\s*t\s*\)/);
    });
  });

  describe('PRI-372: diagnostician stage task kinds are discovered', () => {
    it('diag_rootcause task → logs INTERNALIZATION_TRIGGER_WAKE', async () => {
      const task = makePITask('task-rc', 'diag_rootcause', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-rc', taskKind: 'diag_rootcause', gateDecision: 'proceed' }),
      );
    });

    it('diag_distiller task → logs INTERNALIZATION_TRIGGER_WAKE', async () => {
      const task = makePITask('task-dist', 'diag_distiller', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-dist', taskKind: 'diag_distiller', gateDecision: 'proceed' }),
      );
    });

    it('diag_router task → logs INTERNALIZATION_TRIGGER_WAKE', async () => {
      const task = makePITask('task-router', 'diag_router', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      mockProvider.listTasks.mockResolvedValue([task]);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_WAKE',
        expect.objectContaining({ taskId: 'task-router', taskKind: 'diag_router', gateDecision: 'proceed' }),
      );
    });

    it('diag_rootcause task with unmet dep → logs INTERNALIZATION_TRIGGER_BLOCKED', async () => {
      const depTask = makePITask('dep-1', 'diag_rootcause', 'prompt', { status: 'pending', dependencyTaskIds: [] });
      const task = makePITask('task-rc-blocked', 'diag_distiller', 'prompt', { status: 'pending', dependencyTaskIds: ['dep-1'] });
      mockProvider.listTasks.mockResolvedValue([task]);
      mockProvider.getTask.mockResolvedValue(depTask);
      await adapter.wake({ workspaceDir: '/test', stateDir: '/test/.state' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[PD:InternalizationTrigger] INTERNALIZATION_TRIGGER_BLOCKED',
        expect.objectContaining({ taskId: 'task-rc-blocked', gateDecision: 'blocked' }),
      );
    });
  });
});