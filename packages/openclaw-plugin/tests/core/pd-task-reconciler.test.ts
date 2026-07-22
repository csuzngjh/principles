import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  reconcilePDTasks,
  trigger,
  type PDTaskSpec,
  type CronJob,
} from '../../src/core/pd-task-reconciler.js';
import { readTasks, writeTasks } from '../../src/core/pd-task-store.js';

// Hoisted mutable array so individual tests can control BUILTIN_PD_TASKS.
// Without this, BUILTIN_PD_TASKS defaults to [] and reconcilePDTasks' diff()
// never sees any declared task — making CREATE/DISABLE/SKIP paths untestable.
const { builtinTasks } = vi.hoisted(() => ({
  builtinTasks: [] as PDTaskSpec[],
}));

vi.mock('fs');
vi.mock('../../src/core/pd-task-store.js');
vi.mock('../../src/core/pd-task-types.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, BUILTIN_PD_TASKS: builtinTasks };
});
// writeCronStore uses withLockAsync which acquires a real fs lock; under the
// fs mock the lock path hangs. Bypass the lock and just run the callback.
vi.mock('../../src/utils/file-lock.js', () => ({
  withLockAsync: vi.fn(async (_filePath: string, fn: () => Promise<unknown>) => fn()),
}));

describe('PDTaskReconciler', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-task-reconciler-test-${Date.now()}`);
  const cronStorePath = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');

  const testTask: PDTaskSpec = {
    id: 'test-task',
    name: 'PD Test Task',
    description: 'A test task',
    enabled: true,
    version: '1.0.0',
    schedule: { kind: 'every', everyMs: 3600000 },
    execution: { promptTemplate: 'test', timeoutSeconds: 60 },
    delivery: { mode: 'none' },
  };

  const disabledTask: PDTaskSpec = {
    ...testTask,
    id: 'disabled-task',
    name: 'PD Disabled Task',
    enabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    builtinTasks.length = 0; // reset declared tasks between tests
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p.toString().startsWith(tmpDir)) return true;
      if (p.toString() === cronStorePath) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p.toString() === cronStorePath) {
        return JSON.stringify({ version: 1, jobs: [] });
      }
      return '[]';
    });
    vi.mocked(readTasks).mockReturnValue([]);
  });

  describe('reconcilePDTasks', () => {
    it('should create new jobs for declared builtin tasks with no existing cron job', async () => {
      builtinTasks.push(testTask);
      const result = await reconcilePDTasks(tmpDir, { dryRun: false });
      expect(result.created).toHaveLength(1);
      expect(result.created[0]).toBe('PD Test Task');
    });

    it('should return empty created list when no builtin tasks are declared', async () => {
      // BUILTIN_PD_TASKS is empty (no declared tasks) → diff() has nothing to process
      const result = await reconcilePDTasks(tmpDir, { dryRun: true });
      expect(result.created).toHaveLength(0);
    });

    it('should log orphaned jobs', async () => {
      const orphanJob: CronJob = {
        id: 'pd-orphan-123',
        name: 'PD Orphan Task',
        enabled: true,
        createdAtMs: 123,
        updatedAtMs: 123,
        schedule: { kind: 'every', everyMs: 3600000 },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'An orphan task' },
        state: { nextRunAtMs: 123456 },
        metadata: { pdVersion: '1.0.0', pdTaskId: 'orphan-task' },
      };
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString() === cronStorePath) {
          return JSON.stringify({ version: 1, jobs: [orphanJob] });
        }
        return '[]';
      });
      const logger = { info: vi.fn(), warn: vi.fn() };
      const result = await reconcilePDTasks(tmpDir, { dryRun: true, logger });
      expect(result.orphaned).toHaveLength(1);
      expect(result.orphaned[0]).toBe('PD Orphan Task');
      expect(logger.warn).toHaveBeenCalledWith('[PD:Reconciler] Orphaned job (no declaration): PD Orphan Task');
    });

    it('should not mark non-PD jobs as orphan', async () => {
      const nonPdJob: CronJob = {
        id: 'external-job-123',
        name: 'External Task',
        enabled: true,
        createdAtMs: 123,
        updatedAtMs: 123,
        schedule: { kind: 'every', everyMs: 3600000 },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'An external task' },
        state: { nextRunAtMs: 123456 },
      };
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString() === cronStorePath) {
          return JSON.stringify({ version: 1, jobs: [nonPdJob] });
        }
        return '[]';
      });
      const result = await reconcilePDTasks(tmpDir, { dryRun: true });
      expect(result.orphaned).toHaveLength(0);
    });

    it('should disable existing job when declared task is disabled', async () => {
      // disabledTask must be a declared builtin AND have an existing cron job
      // for diff() to reach the DISABLE branch (task.enabled === false, job exists).
      builtinTasks.push(disabledTask);
      const existingJob: CronJob = {
        id: 'pd-disabled-1',
        name: 'PD Disabled Task',
        enabled: true,
        createdAtMs: 123,
        updatedAtMs: 123,
        schedule: { kind: 'every', everyMs: 3600000 },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: 'A disabled task' },
        state: { nextRunAtMs: 123456 },
        metadata: { pdVersion: '1.0.0', pdTaskId: 'disabled-task' },
      };
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString() === cronStorePath) {
          return JSON.stringify({ version: 1, jobs: [existingJob] });
        }
        return '[]';
      });
      const logger = { info: vi.fn(), warn: vi.fn() };
      const result = await reconcilePDTasks(tmpDir, { dryRun: false, logger });
      expect(result.created).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith('[PD:Reconciler] Disabled job: PD Disabled Task');
    });

    it('should handle malformed cron store gracefully', async () => {
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString() === cronStorePath) {
          return 'not valid json';
        }
        return '[]';
      });
      const logger = { info: vi.fn(), warn: vi.fn() };
      const result = await reconcilePDTasks(tmpDir, { dryRun: true, logger });
      expect(result.created).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to parse cron/jobs.json'));
    });

    it('should handle missing cron store', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation((p) => '[]');
      const logger = { info: vi.fn(), warn: vi.fn() };
      const result = await reconcilePDTasks(tmpDir, { dryRun: true, logger });
      expect(result.created).toHaveLength(0);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cron/jobs.json not found'));
    });
  });

  describe('trigger', () => {
    it('should return error when task not found', async () => {
      vi.mocked(readTasks).mockReturnValue([]);
      const result = await trigger('non-existent', tmpDir);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Task 'non-existent' not found");
    });

    it('should return error when task is auto-disabled without force', async () => {
      const disabledTaskWithMeta: PDTaskSpec = {
        ...testTask,
        meta: { autoDisabled: true, autoDisabledAt: Date.now() },
      };
      vi.mocked(readTasks).mockReturnValue([disabledTaskWithMeta]);
      const result = await trigger('test-task', tmpDir);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Task is auto-disabled. Use force=true to override.');
    });

    it('should trigger an existing enabled task successfully', async () => {
      vi.mocked(readTasks).mockReturnValue([testTask]);
      const result = await trigger('test-task', tmpDir);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      // A successful trigger persists the updated task meta (lastTriggeredAtMs).
      expect(writeTasks).toHaveBeenCalledWith(tmpDir, expect.arrayContaining([expect.objectContaining({ id: 'test-task' })]));
    });
  });
});
