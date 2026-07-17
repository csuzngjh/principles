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

vi.mock('fs');
vi.mock('../../src/core/pd-task-store.js');

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
    it('should create new tasks', async () => {
      vi.mocked(readTasks).mockReturnValue([]);
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

    it('should skip CREATE for disabled task', async () => {
      vi.mocked(readTasks).mockReturnValue([disabledTask]);
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (p.toString() === cronStorePath) {
          return JSON.stringify({ version: 1, jobs: [] });
        }
        return '[]';
      });
      const result = await reconcilePDTasks(tmpDir, { dryRun: true });
      expect(result.created).toHaveLength(0);
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
  });
});