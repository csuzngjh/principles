/**
 * PRI-934 / PRI-935 regression tests — the two module-level single
 * authorities extracted for CLI reuse, verified against a REAL
 * RuntimeStateManager on a temp workspace (P5: persistence goes through the
 * actual store, not a mock).
 *
 *   1. recoverFailedTask (recovery-sweep-service) — the lease-conflict dead
 *      end: a failed diagnostician task must reject acquireLease before
 *      recovery and accept it after. Exhausted-budget + force semantics are
 *      the ones `pd pain retry` relies on.
 *   2. persistPainDiagnosis (pain-signal-bridge) — the CLI diagnosis paths
 *      write the pain_diagnoses ledger through this export; direct invocation
 *      must round-trip a row, stay idempotent on replay, and degrade
 *      observably (rc-9) on an unparseable rootCause prefix.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverFailedTask } from '../recovery-sweep-service.js';
import { persistPainDiagnosis } from '../pain-signal-bridge.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { PDRuntimeError } from '../error-categories.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

const workspaces: string[] = [];
const managers: RuntimeStateManager[] = [];

async function makeStateManager(): Promise<RuntimeStateManager> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-recovery-ledger-'));
  workspaces.push(dir);
  const mgr = new RuntimeStateManager({ workspaceDir: dir });
  await mgr.initialize();
  managers.push(mgr);
  return mgr;
}

afterEach(async () => {
  for (const mgr of managers.splice(0)) {
    try { await mgr.close(); } catch { /* best-effort cleanup */ }
  }
  for (const dir of workspaces.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

async function createFailedTask(mgr: RuntimeStateManager, taskId: string, attemptCount = 1): Promise<void> {
  await mgr.createTask({
    taskId,
    taskKind: 'diagnostician',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
  });
  await mgr.updateTask(taskId, { attemptCount });
  await mgr.markTaskFailed(taskId, 'timeout');
}

describe('recoverFailedTask — single authority (PRI-934)', () => {
  it('a failed task rejects acquireLease before recovery and accepts it after (the dead end, end-to-end)', async () => {
    const mgr = await makeStateManager();
    await createFailedTask(mgr, 'diagnosis_pain-934');

    await expect(
      mgr.acquireLease({ taskId: 'diagnosis_pain-934', owner: 'split-diagnostician-orchestrator', runtimeKind: 'test-double' }),
    ).rejects.toThrow(PDRuntimeError);

    const recovered = await recoverFailedTask(mgr, 'diagnosis_pain-934', true);
    expect(recovered).toMatchObject({
      taskId: 'diagnosis_pain-934',
      previousStatus: 'failed',
      newStatus: 'pending',
      forceApplied: false,
    });

    await expect(
      mgr.acquireLease({ taskId: 'diagnosis_pain-934', owner: 'split-diagnostician-orchestrator', runtimeKind: 'test-double' }),
    ).resolves.toBeDefined();
  });

  it('exhausted budget throws without force; with force the budget is raised (+3) and cleared', async () => {
    const mgr = await makeStateManager();
    await createFailedTask(mgr, 'diag_rootcause-diagnosis_x', 3);

    await expect(recoverFailedTask(mgr, 'diag_rootcause-diagnosis_x', false))
      .rejects.toThrow(/exhausted max attempts/);

    const recovered = await recoverFailedTask(mgr, 'diag_rootcause-diagnosis_x', true);
    expect(recovered).toMatchObject({ attemptCount: 0, maxAttempts: 6, forceApplied: true });
    const task = await mgr.getTask('diag_rootcause-diagnosis_x');
    expect(task?.status).toBe('pending');
    expect(task?.lastError).toBeNull();
  });

  it('non-failed tasks are a no-op returning null (cli-5: no mutation)', async () => {
    const mgr = await makeStateManager();
    await mgr.createTask({
      taskId: 'diagnosis_pending', taskKind: 'diagnostician',
      status: 'pending', attemptCount: 0, maxAttempts: 3,
    });
    await mgr.createTask({
      taskId: 'diagnosis_review', taskKind: 'diagnostician',
      status: 'needs_human_review', attemptCount: 2, maxAttempts: 3,
    });

    expect(await recoverFailedTask(mgr, 'diagnosis_pending', true)).toBeNull();
    expect(await recoverFailedTask(mgr, 'diagnosis_review', true)).toBeNull();
    // Absent task — also null, never throws.
    expect(await recoverFailedTask(mgr, 'diagnosis_missing', true)).toBeNull();

    const review = await mgr.getTask('diagnosis_review');
    expect(review?.status).toBe('needs_human_review');
    expect(review?.attemptCount).toBe(2);
  });
});

function makeOutput(rootCause: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-935',
    summary: 'CLI-path diagnosis',
    rootCause,
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'tool_calls:1', note: 'evidence' }],
    recommendations: [{ kind: 'defer', description: 'none actionable' }],
    confidence: 0.6,
  };
}

describe('persistPainDiagnosis — direct export for CLI callers (PRI-935)', () => {
  it('persists a categorized row and replay of the same diagnosis is idempotent', async () => {
    const mgr = await makeStateManager();
    const deps = { stateManager: mgr };
    const opts = {
      painId: 'pain-935',
      taskId: 'diagnosis_pain-935',
      diagnosticianOutput: makeOutput('People: Agent retried without inspecting lease state'),
      artifactId: 'art-935',
    };

    await persistPainDiagnosis(deps, opts);
    await persistPainDiagnosis(deps, opts);

    const rows = await mgr.getDiagnosesByPainId('pain-935');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('People');
    expect(rows[0]?.artifactId).toBe('art-935');
    expect(rows[0]?.taskId).toBe('diagnosis_pain-935');
  });

  it('unparseable rootCause prefix degrades observably via telemetry, never throws (rc-9)', async () => {
    const mgr = await makeStateManager();
    const events: { eventType: string; payload: Record<string, unknown> }[] = [];

    await expect(persistPainDiagnosis(
      { stateManager: mgr, eventEmitter: { emitTelemetry: (e) => { events.push({ eventType: e.eventType, payload: e.payload }); } } },
      {
        painId: 'pain-noprefix',
        taskId: 'diagnosis_pain-noprefix',
        diagnosticianOutput: makeOutput('No category prefix at all'),
        artifactId: null,
      },
    )).resolves.toBeUndefined();

    expect(await mgr.getDiagnosesByPainId('pain-noprefix')).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('pain_diagnosis_persist_skipped');
    expect(events[0]?.payload.reason).toBe('unparseable_root_cause_prefix');
  });
});
