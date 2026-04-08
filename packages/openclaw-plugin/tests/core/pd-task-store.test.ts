import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readTasks,
  writeTasks,
  initTaskMeta,
  updateSyncMeta,
} from '../../src/core/pd-task-store.js';
import type { PDTaskSpec } from '../../src/core/pd-task-types.js';

const TEST_TASK: PDTaskSpec = {
  id: 'test-task',
  name: 'PD Test Task',
  description: 'A test task',
  enabled: true,
  version: '1.0.0',
  schedule: { kind: 'every', everyMs: 3600000 },
  execution: { promptTemplate: 'test', timeoutSeconds: 60 },
  delivery: { mode: 'none' },
};

describe('PDTaskStore', () => {
  const tmpDir = path.join(os.tmpdir(), `pd-task-store-test-${Date.now()}-${Math.random()}`);
  const stateDir = path.join(tmpDir, '.state');

  beforeEach(() => {
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readTasks', () => {
    it('should return empty array when file does not exist', () => {
      const tasks = readTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('should return empty array for invalid JSON', () => {
      const filePath = path.join(stateDir, 'pd_tasks.json');
      fs.writeFileSync(filePath, 'not valid json', 'utf-8');
      const tasks = readTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('should return empty array for non-array JSON', () => {
      const filePath = path.join(stateDir, 'pd_tasks.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf-8');
      const tasks = readTasks(tmpDir);
      expect(tasks).toEqual([]);
    });

    it('should read and parse valid task array', () => {
      const filePath = path.join(stateDir, 'pd_tasks.json');
      const tasks = [TEST_TASK];
      fs.writeFileSync(filePath, JSON.stringify(tasks), 'utf-8');
      const result = readTasks(tmpDir);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-task');
    });
  });

  describe('writeTasks', () => {
    it('should create .state directory if missing', async () => {
      const newDir = path.join(tmpDir, 'new-workspace');
      await writeTasks(newDir, [TEST_TASK]);
      const newStateDir = path.join(newDir, '.state');
      expect(fs.existsSync(newStateDir)).toBe(true);
    });

    it('should write tasks to pd_tasks.json', async () => {
      await writeTasks(tmpDir, [TEST_TASK]);
      const filePath = path.join(stateDir, 'pd_tasks.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content).toHaveLength(1);
      expect(content[0].id).toBe('test-task');
    });

    it('should use atomic write (tmp + rename)', async () => {
      await writeTasks(tmpDir, [TEST_TASK]);
      const filePath = path.join(stateDir, 'pd_tasks.json');
      const tmpFile = filePath + '.tmp';
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe('initTaskMeta', () => {
    it('should initialize meta if missing', () => {
      const task = { ...TEST_TASK };
      const result = initTaskMeta(task);
      expect(result.meta).toBeDefined();
      expect(result.meta!.createdAtMs).toBeDefined();
    });

    it('should preserve existing meta', () => {
      const task = {
        ...TEST_TASK,
        meta: { createdAtMs: 1000, autoDisabled: true },
      };
      const result = initTaskMeta(task);
      expect(result.meta!.createdAtMs).toBe(1000);
      expect(result.meta!.autoDisabled).toBe(true);
    });
  });

  describe('updateSyncMeta', () => {
    it('should update sync metadata', () => {
      const task = { ...TEST_TASK };
      const result = updateSyncMeta(task, 'ok', 'job-123');
      expect(result.meta!.lastSyncedAtMs).toBeDefined();
      expect(result.meta!.lastSyncStatus).toBe('ok');
      expect(result.meta!.lastSyncedJobId).toBe('job-123');
    });

    it('should record error for failed sync', () => {
      const task = { ...TEST_TASK };
      const result = updateSyncMeta(task, 'error', undefined, 'Lock timeout');
      expect(result.meta!.lastSyncStatus).toBe('error');
      expect(result.meta!.lastSyncError).toBe('Lock timeout');
    });
  });
});
