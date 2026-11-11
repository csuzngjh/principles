/**
 * L3 automatic diagnosis — precondition contract (SPEC-PD-AGENT-PAIN-INGRESS-001
 * §8.4 / TECHNICAL-DESIGN §8.4, acceptance T37).
 *
 * Every skip must name WHY nothing happened, and every skip must leave the
 * durable task untouched so L2 (Console request-driven) can still serve it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeStateHandle, getDefaultPdConfig } from '@principles/core/runtime';
import { runPendingDiagnosticianOnce, DIAGNOSTICIAN_AUTO_RUN_FLAG } from '../src/diagnostician-auto-run.js';

const dirs: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-l3-auto-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  return root;
}

function writeConfig(root: string, mutate: (config: ReturnType<typeof getDefaultPdConfig>) => void): void {
  // Deep clone: getDefaultPdConfig() shares the `features` entry objects with
  // the process-wide defaults, so mutating in place would flip the flag for
  // every later test (and for any production caller in the same process).
  const config = JSON.parse(JSON.stringify(getDefaultPdConfig())) as ReturnType<typeof getDefaultPdConfig>;
  mutate(config);
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }); } catch { /* temp dir */ }
  }
});

describe('runPendingDiagnosticianOnce — three preconditions', () => {
  it('skips with service_not_running when the caller owns no timer', async () => {
    const root = workspace();
    const result = await runPendingDiagnosticianOnce({ workspaceDir: root, serviceStarted: false });
    expect(result.served).toBe(false);
    expect(result.reason).toBe('service_not_running');
    expect(result.nextAction).toBeTruthy();
  });

  it('skips with flag_off and leaves the pending task for L2', async () => {
    const root = workspace();
    writeConfig(root, (config) => { config.features[DIAGNOSTICIAN_AUTO_RUN_FLAG].enabled = false; });
    const handle = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
    try {
      await handle.stateManager.createTask({ taskId: 'diagnosis_1', taskKind: 'diagnostician', inputRef: 'pain_1', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    } finally {
      await handle.close();
    }

    const result = await runPendingDiagnosticianOnce({ workspaceDir: root });
    expect(result.served).toBe(false);
    expect(result.reason).toBe('flag_off');

    const readBack = await createRuntimeStateHandle({ workspaceDir: root, readonly: true });
    try {
      const [task] = await readBack.stateManager.listTasks({ taskKind: 'diagnostician', limit: 10 });
      expect(task?.taskId).toBe('diagnosis_1');
      expect(task?.status).toBe('pending');
    } finally {
      await readBack.close();
    }
  });

  it('skips with capability_disabled when the Owner disabled the Diagnostician', async () => {
    const root = workspace();
    writeConfig(root, (config) => {
      config.internalAgents.agents.diagnostician.enabled = false;
    });
    const result = await runPendingDiagnosticianOnce({ workspaceDir: root });
    expect(result.served).toBe(false);
    expect(result.reason).toBe('capability_disabled');
    expect(result.message).toBeTruthy();
  });

  it('reports no_candidate on an idle workspace without inventing work', async () => {
    const root = workspace();
    const result = await runPendingDiagnosticianOnce({ workspaceDir: root });
    expect(result.served).toBe(false);
    expect(result.reason).toBe('no_candidate');
    expect(result.taskId).toBeUndefined();
  });

  it('picks the oldest pending task, attempts it, and keeps it durable on failure', async () => {
    const root = workspace();
    const handle = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
    try {
      await handle.stateManager.createTask({ taskId: 'diagnosis_old', taskKind: 'diagnostician', inputRef: 'pain_old', status: 'pending', attemptCount: 0, maxAttempts: 3 });
      // Distinct updated_at so "oldest first" is a real assertion, not a tie.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.stateManager.createTask({ taskId: 'diagnosis_new', taskKind: 'diagnostician', inputRef: 'pain_new', status: 'pending', attemptCount: 0, maxAttempts: 3 });
    } finally {
      await handle.close();
    }

    // No provider is configured in a bare temp workspace, so the attempt must
    // fail loudly as execution_failed — never as a quiet "nothing to do" — and
    // the chosen task must be the oldest one.
    const result = await runPendingDiagnosticianOnce({ workspaceDir: root });
    expect(result.served).toBe(false);
    expect(result.reason).toBe('execution_failed');
    expect(result.taskId).toBe('diagnosis_old');
    expect(result.nextAction).toBeTruthy();

    const readBack = await createRuntimeStateHandle({ workspaceDir: root, readonly: true });
    try {
      const tasks = await readBack.stateManager.listTasks({ taskKind: 'diagnostician', limit: 10 });
      expect(tasks.map((task) => task.taskId).sort()).toEqual(['diagnosis_new', 'diagnosis_old']);
      // Failure must never destroy the work: both tasks still exist.
      expect(tasks.every((task) => task.status !== 'succeeded')).toBe(true);
    } finally {
      await readBack.close();
    }
  });
});
