import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { StalledDiagnosticianTaskReadModel } from '../stalled-diagnostician-task-read-model.js';
import { status as diagnoseStatus } from '../cli/diagnose.js';

describe('StalledDiagnosticianTaskReadModel & CLI status', () => {
  let tmpDir: string;
  let stateManager: RuntimeStateManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-stalled-test-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies a task as stalled when it is pending, attempt=0, has no runs, and age > threshold', async () => {
    const tenMinutesAgo = new Date(Date.now() - 600 * 1000).toISOString();
    await stateManager.taskStore.createTask({
      taskId: 'stalled-task-001',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-stalled-001',
    });
    
    // Manually force the created_at timestamp to the past
    const db = stateManager.connection.getDb();
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(tenMinutesAgo, 'stalled-task-001');

    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    
    // Test listStalledTasks
    const stalledList = await readModel.listStalledTasks(300);
    expect(stalledList).toHaveLength(1);
    const [firstStalled] = stalledList;
    expect(firstStalled).toBeDefined();
    expect(firstStalled?.taskId).toBe('stalled-task-001');
    expect(firstStalled?.inputRef).toBe('pain-stalled-001');
    expect(firstStalled?.age).toBeGreaterThanOrEqual(600);
    expect(firstStalled?.reason).toContain('submitted-without-run');
    expect(firstStalled?.nextAction).toContain('pd diagnose run');

    // Test checkStalledTask
    const stalledInfo = await readModel.checkStalledTask('stalled-task-001', 300);
    expect(stalledInfo).not.toBeNull();
    expect(stalledInfo?.taskId).toBe('stalled-task-001');
    expect(stalledInfo?.age).toBeGreaterThanOrEqual(600);

    // Test CLI status API
    const cliResult = await diagnoseStatus({
      taskId: 'stalled-task-001',
      stateManager,
      stalledThresholdSeconds: 300,
    });
    expect(cliResult).not.toBeNull();
    expect(cliResult?.status).toBe('pending');
    expect(cliResult?.inputRef).toBe('pain-stalled-001');
    expect(cliResult?.age).toBeGreaterThanOrEqual(600);
    expect(cliResult?.reason).toContain('submitted-without-run');
    expect(cliResult?.nextAction).toContain('pd diagnose run');
  });

  it('classifies a task as fresh pending (NOT stalled) if age <= threshold', async () => {
    await stateManager.taskStore.createTask({
      taskId: 'fresh-task-001',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-fresh-001',
    });

    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    
    // Check with default threshold (300s), should be fresh
    const stalledInfo = await readModel.checkStalledTask('fresh-task-001', 300);
    expect(stalledInfo).toBeNull();

    // Check with listStalledTasks
    const stalledList = await readModel.listStalledTasks(300);
    expect(stalledList).toHaveLength(0);

    // Test CLI status API
    const cliResult = await diagnoseStatus({
      taskId: 'fresh-task-001',
      stateManager,
      stalledThresholdSeconds: 300,
    });
    expect(cliResult).not.toBeNull();
    expect(cliResult?.status).toBe('pending');
    expect(cliResult?.reason).toBeUndefined();
    expect(cliResult?.nextAction).toBeUndefined();
  });

  it('does not classify a task as stalled if status is not pending', async () => {
    const tenMinutesAgo = new Date(Date.now() - 600 * 1000).toISOString();
    await stateManager.taskStore.createTask({
      taskId: 'leased-task-001',
      taskKind: 'diagnostician',
      status: 'leased',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-leased-001',
    });
    const db = stateManager.connection.getDb();
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(tenMinutesAgo, 'leased-task-001');

    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    const stalledInfo = await readModel.checkStalledTask('leased-task-001', 300);
    expect(stalledInfo).toBeNull();
  });

  it('does not classify a task as stalled if attemptCount > 0', async () => {
    const tenMinutesAgo = new Date(Date.now() - 600 * 1000).toISOString();
    await stateManager.taskStore.createTask({
      taskId: 'attempted-task-001',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 1,
      maxAttempts: 3,
      inputRef: 'pain-attempted-001',
    });
    const db = stateManager.connection.getDb();
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(tenMinutesAgo, 'attempted-task-001');

    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    const stalledInfo = await readModel.checkStalledTask('attempted-task-001', 300);
    expect(stalledInfo).toBeNull();
  });

  it('does not classify a task as stalled if it has runs', async () => {
    const tenMinutesAgo = new Date(Date.now() - 600 * 1000).toISOString();
    await stateManager.taskStore.createTask({
      taskId: 'has-runs-task-001',
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'pain-runs-001',
    });
    const db = stateManager.connection.getDb();
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(tenMinutesAgo, 'has-runs-task-001');

    // Add a run
    await stateManager.runStore.createRun({
      runId: 'run-001',
      taskId: 'has-runs-task-001',
      runtimeKind: 'test-double',
      executionStatus: 'running',
      startedAt: tenMinutesAgo,
      attemptNumber: 1,
    });

    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    const stalledInfo = await readModel.checkStalledTask('has-runs-task-001', 300);
    expect(stalledInfo).toBeNull();
  });

  it('does not classify non-diagnostician task kinds as stalled', async () => {
    const tenMinutesAgo = new Date(Date.now() - 600 * 1000).toISOString();
    await stateManager.taskStore.createTask({
      taskId: 'intake-task-001',
      taskKind: 'principle_candidate_intake',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: 'candidate-001',
    });
    const db = stateManager.connection.getDb();
    db.prepare('UPDATE tasks SET created_at = ? WHERE task_id = ?').run(tenMinutesAgo, 'intake-task-001');

    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    const stalledInfo = await readModel.checkStalledTask('intake-task-001', 300);
    expect(stalledInfo).toBeNull();
  });

  it('returns null for a task that does not exist', async () => {
    const readModel = new StalledDiagnosticianTaskReadModel({ stateManager });
    const stalledInfo = await readModel.checkStalledTask('non-existent-task', 300);
    expect(stalledInfo).toBeNull();
  });
});
