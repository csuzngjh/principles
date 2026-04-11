import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { PluginLogger } from '../../src/utils/plugin-logger.js';
import type { EventLog } from '../../src/core/event-log.js';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as nocturnalRuntime from '../../src/service/nocturnal-runtime.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('TaskContextBuilder', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcb-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create instance with workspaceDir stored', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);
      expect(tcb).toBeDefined();
    });
  });

  describe('buildCycleContext', () => {
    it('should return CycleContextResult with idle, cooldown, recentPain, activeSessions, errors', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');

      const mockWctx = {
        workspaceDir: tempDir,
        stateDir: tempDir,
      } as unknown as WorkspaceContext;

      const tcb = new TaskContextBuilder(tempDir);
      const result = await tcb.buildCycleContext(mockWctx, undefined, undefined);

      expect(result).toHaveProperty('idle');
      expect(result).toHaveProperty('cooldown');
      expect(result).toHaveProperty('recentPain');
      expect(result).toHaveProperty('activeSessions');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('should return error result for invalid wctx (null)', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const result = await tcb.buildCycleContext(null as unknown as WorkspaceContext, undefined, undefined);

      expect(result.errors).toContain('Invalid workspace context');
      expect(result.idle.isIdle).toBe(false);
    });

    it('should return error result for invalid wctx (undefined)', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const result = await tcb.buildCycleContext(undefined as unknown as WorkspaceContext, undefined, undefined);

      expect(result.errors).toContain('Invalid workspace context');
    });

    it('should return error result for invalid wctx (non-object)', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const result = await tcb.buildCycleContext('not-an-object' as unknown as WorkspaceContext, undefined, undefined);

      expect(result.errors).toContain('Invalid workspace context');
    });

    it('should call eventLog.recordSkip when checkWorkspaceIdle throws (FB-04 fail-visible)', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');

      const mockWctx = {
        workspaceDir: tempDir,
        stateDir: tempDir,
      } as unknown as WorkspaceContext;

      const mockEventLog = {
        recordSkip: vi.fn(),
      } as unknown as EventLog;

      // Force checkWorkspaceIdle to throw via spy
      const idleSpy = vi.spyOn(nocturnalRuntime, 'checkWorkspaceIdle').mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      try {
        const tcb = new TaskContextBuilder(tempDir);
        const result = await tcb.buildCycleContext(mockWctx, undefined, mockEventLog);

        // FB-04: should emit skip event and continue (fail-visible)
        expect(mockEventLog.recordSkip).toHaveBeenCalledWith(undefined, expect.objectContaining({
          reason: 'checkWorkspaceIdle_error',
          fallback: 'default_idle_assumption',
        }));
        expect(result.errors).toContainEqual(expect.stringContaining('checkWorkspaceIdle failed'));
      } finally {
        idleSpy.mockRestore();
      }
    });

    it('should call eventLog.recordSkip when checkCooldown throws (FB-05 fail-visible)', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');

      const mockWctx = {
        workspaceDir: tempDir,
        stateDir: tempDir,
      } as unknown as WorkspaceContext;

      const mockEventLog = {
        recordSkip: vi.fn(),
      } as unknown as EventLog;

      // Force checkCooldown to throw via spy
      const cooldownSpy = vi.spyOn(nocturnalRuntime, 'checkCooldown').mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      try {
        const tcb = new TaskContextBuilder(tempDir);
        const result = await tcb.buildCycleContext(mockWctx, undefined, mockEventLog);

        // FB-05: should emit skip event and continue (fail-visible)
        expect(mockEventLog.recordSkip).toHaveBeenCalledWith(undefined, expect.objectContaining({
          reason: 'checkCooldown_error',
          fallback: 'no_cooldown_assumption',
        }));
        expect(result.errors).toContainEqual(expect.stringContaining('checkCooldown failed'));
      } finally {
        cooldownSpy.mockRestore();
      }
    });
  });

  describe('buildFallbackSnapshot', () => {
    it('should return NocturnalSessionSnapshot when sleepTask has recentPainContext', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const sleepTask: EvolutionQueueItem = {
        id: 'task-001',
        taskKind: 'sleep_reflection',
        priority: 1,
        source: 'nocturnal',
        score: 85,
        reason: 'high_pain_detected',
        timestamp: '2026-04-11T10:00:00.000Z',
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        recentPainContext: {
          mostRecent: {
            score: 80,
            source: 'gate_block',
            reason: 'repeated_file_modification',
            timestamp: '2026-04-11T09:55:00.000Z',
            sessionId: 'session-pain-001',
          },
          recentPainCount: 3,
          recentMaxPainScore: 80,
        },
      };

      const result = tcb.buildFallbackSnapshot(sleepTask);

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('sessionId');
      expect(result).toHaveProperty('startedAt');
      expect(result).toHaveProperty('updatedAt');
      expect(result).toHaveProperty('assistantTurns');
      expect(result).toHaveProperty('userTurns');
      expect(result).toHaveProperty('toolCalls');
      expect(result).toHaveProperty('painEvents');
      expect(result).toHaveProperty('gateBlocks');
      expect(result).toHaveProperty('stats');
      expect(result).toHaveProperty('_dataSource', 'pain_context_fallback');
    });

    it('should return null when sleepTask has no recentPainContext', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const sleepTask: EvolutionQueueItem = {
        id: 'task-002',
        taskKind: 'sleep_reflection',
        priority: 1,
        source: 'nocturnal',
        score: 50,
        reason: 'scheduled',
        timestamp: '2026-04-11T10:00:00.000Z',
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
      };

      const result = tcb.buildFallbackSnapshot(sleepTask);

      expect(result).toBeNull();
    });

    it('should set _dataSource to pain_context_fallback', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const sleepTask: EvolutionQueueItem = {
        id: 'task-003',
        taskKind: 'sleep_reflection',
        priority: 1,
        source: 'nocturnal',
        score: 70,
        reason: 'high_pain',
        timestamp: '2026-04-11T10:00:00.000Z',
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        recentPainContext: {
          mostRecent: {
            score: 70,
            source: 'pain_signal',
            reason: 'repeated_errors',
            timestamp: '2026-04-11T09:50:00.000Z',
            sessionId: 'session-003',
          },
          recentPainCount: 1,
          recentMaxPainScore: 70,
        },
      };

      const result = tcb.buildFallbackSnapshot(sleepTask);

      expect(result!._dataSource).toBe('pain_context_fallback');
    });

    it('should use task id as sessionId when mostRecent is null', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      const sleepTask: EvolutionQueueItem = {
        id: 'task-fallback-001',
        taskKind: 'sleep_reflection',
        priority: 1,
        source: 'nocturnal',
        score: 60,
        reason: 'scheduled',
        timestamp: '2026-04-11T10:00:00.000Z',
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        recentPainContext: {
          mostRecent: null,
          recentPainCount: 0,
          recentMaxPainScore: 0,
        },
      };

      const result = tcb.buildFallbackSnapshot(sleepTask);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('task-fallback-001');
    });
  });

  describe('no throw at boundaries', () => {
    it('should not throw when wctx is invalid — returns error result', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const tcb = new TaskContextBuilder(tempDir);

      await expect(
        tcb.buildCycleContext(null as unknown as WorkspaceContext, undefined, undefined)
      ).resolves.not.toThrow();
    });

    it('should not throw when workspaceDir does not exist — returns valid result', async () => {
      const { TaskContextBuilder } = await import('../../src/service/task-context-builder.js');
      const badDir = '/this/path/does/not/exist';
      const tcb = new TaskContextBuilder(badDir);

      const mockWctx = {
        workspaceDir: badDir,
        stateDir: badDir,
      } as unknown as WorkspaceContext;

      // checkWorkspaceIdle and checkCooldown return defaults (no throw) for nonexistent paths
      // so errors stays empty — this is acceptable behavior
      const result = await tcb.buildCycleContext(mockWctx, undefined, undefined);
      expect(result).toHaveProperty('idle');
      expect(result).toHaveProperty('cooldown');
      expect(result).toHaveProperty('recentPain');
      expect(result).toHaveProperty('activeSessions');
      expect(result).toHaveProperty('errors');
      // No throw — promise resolves with valid result
      expect(true).toBe(true);
    });
  });
});
