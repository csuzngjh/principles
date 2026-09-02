/**
 * PRI-638 — Diagnostician capability authority: unified disabled semantics.
 *
 * History of this file: it started as a characterization suite that LOCKED IN
 * the divergent behaviour found on main (investigation evidence for the
 * two-switch matrix in `docs/plans/2026-09-pri638-diagnostician-kill-switch.md`).
 * Per the issue contract ("characterization tests first, then convert them into
 * the new canonical behaviour tests") the same probes now assert the CONVERGED
 * semantics:
 *
 *   Capability authority (the only one): internalAgents.agents.diagnostician.enabled
 *   Disabled representation:            errorCategory 'capability_missing' +
 *                                       FailureCategory 'capability_disabled'
 *   Pain persistence:                   the durable diagnosis task is created
 *                                       even when the capability is disabled
 *   Retry budget:                       attemptCount untouched by a disabled run
 *   Provider calls:                     0 on every disabled path
 *   Recovery:                           re-enable → executePendingDiagnosis /
 *                                       `pd pain retry` resumes the same task
 *
 * Everything below runs real production wiring: computeEffectivePdConfig →
 * createPainSignalBridge → PainSignalBridge → RuntimeStateManager (real SQLite
 * on a temp workspace). The provider entry point
 * (OpenClawCliRuntimeAdapter.startRun) is stubbed so probes stay deterministic.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPainSignalBridge,
  disposePainSignalBridgesForWorkspace,
  DisabledDiagnosticianRunner,
  DIAGNOSTICIAN_DISABLED_FAILURE_REASON,
} from '../pain-signal-runtime-factory.js';
import { OpenClawCliRuntimeAdapter } from '../adapter/openclaw-cli-runtime-adapter.js';
import { PrincipleTreeLedgerAdapter } from '../adapter/principle-tree-ledger-adapter.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import { CandidateIntakeService } from '../candidate-intake-service.js';
import { computeEffectivePdConfig, getDefaultPdConfig } from '../config/index.js';
import type { PdConfig } from '../config/index.js';
import type { EffectivePdConfig } from '../config/pd-config-types.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const workspaces: string[] = [];
const managers: RuntimeStateManager[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri638-'));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  for (const mgr of managers.splice(0)) {
    try { await mgr.close(); } catch { /* best-effort */ }
  }
  for (const dir of workspaces.splice(0)) {
    try { await disposePainSignalBridgesForWorkspace(dir); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* best-effort */ }
  }
  vi.restoreAllMocks();
});

function effectiveConfigFor(opts: { agentEnabled: boolean; splitPipeline?: boolean }): EffectivePdConfig {
  const base: PdConfig = getDefaultPdConfig();
  const config: PdConfig = {
    ...base,
    runtimeProfiles: {
      ...base.runtimeProfiles,
      'pri638-openclaw': { type: 'openclaw', provider: 'lmstudio', model: 'qwen3.6-27b-mtp' },
    },
    internalAgents: {
      defaultRuntime: base.internalAgents.defaultRuntime,
      agents: {
        ...base.internalAgents.agents,
        diagnostician: {
          enabled: opts.agentEnabled,
          runtimeProfile: 'pri638-openclaw',
        },
      },
    },
    features: {
      ...base.features,
      // splitPipeline stays configurable only to prove it no longer decides
      // anything about capability.
      ...(opts.splitPipeline === undefined ? {} : { diagnostician_split_pipeline: { category: 'quiet', enabled: opts.splitPipeline } }),
    },
  };
  return computeEffectivePdConfig(config);
}

const PAIN_ID = 'pain-pri638-1';
const TASK_ID = `diagnosis_${PAIN_ID}`;

function makeOutput(rootCause: string, over: Partial<DiagnosticianOutputV1> = {}): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-638',
    summary: 'PRI-638 recovery probe diagnosis',
    rootCause,
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'tool_calls:1', note: 'characterization evidence' }],
    recommendations: [{ kind: 'defer', description: 'no actionable principle' }],
    confidence: 0.7,
    ...over,
  };
}

// ── Unified disabled semantics ───────────────────────────────────────────────

describe('PRI-638 — unified disabled semantics (capability = internalAgents.diagnostician.enabled)', () => {
  it('capability disabled: bridge still constructs, Pain persists, structured capability_missing, zero provider calls', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const startRunSpy = vi
      .spyOn(OpenClawCliRuntimeAdapter.prototype, 'startRun')
      .mockRejectedValue(new Error('pri638-probe: provider boundary reached'));
    startRunSpy.mockClear();

    const bridge = await createPainSignalBridge({
      workspaceDir,
      stateDir,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      owner: 'pri638',
      effectiveConfig: effectiveConfigFor({ agentEnabled: false }),
      getEnvVar: () => undefined,
    });

    const result = await bridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'PRI-638 probe',
      score: 80,
      sessionId: 'pri638-session',
      agentId: 'pri638',
      evidence: [{ sourceRef: 'tool_calls:1', note: 'characterization evidence' }],
    });

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('capability_missing');
    expect(result.nextAction).toContain('internalAgents.agents.diagnostician.enabled');

    // Pain evidence survived: the durable diagnosis task exists.
    const reader = new RuntimeStateManager({ workspaceDir });
    managers.push(reader);
    await reader.initialize();
    const task = await reader.getTask(TASK_ID);
    expect(task).not.toBeNull();
    expect(task?.status).toBe('pending');
    // A capability-disabled run is not an attempt: no LLM retry budget burned.
    expect(task?.attemptCount).toBe(0);

    // Kill switch sits at the capability boundary — the provider was never touched.
    expect(startRunSpy.mock.calls).toHaveLength(0);
  });

  it('capability disabled holds for BOTH split flag values (the flag no longer decides capability)', async () => {
    for (const splitPipeline of [true, false]) {
      const workspaceDir = makeWorkspace();
      const stateDir = path.join(workspaceDir, '.state');
      fs.mkdirSync(stateDir, { recursive: true });

      const bridge = await createPainSignalBridge({
        workspaceDir,
        stateDir,
        ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
        owner: 'pri638',
        effectiveConfig: effectiveConfigFor({ agentEnabled: false, splitPipeline }),
        getEnvVar: () => undefined,
      });
      const painId = `pain-pri638-split-${splitPipeline}`;
      const result = await bridge.onPainDetected({
        painId,
        painType: 'user_frustration',
        source: 'manual',
        reason: 'PRI-638 probe',
        score: 80,
        sessionId: 'pri638-session',
        agentId: 'pri638',
        evidence: [{ sourceRef: 'tool_calls:1', note: 'characterization evidence' }],
      });

      expect(result.status).toBe('failed');
      expect(result.errorCategory).toBe('capability_missing');
      expect(result.message).toContain('disabled');

      // Pain persisted under BOTH flag values — identical durable outcome.
      const reader = new RuntimeStateManager({ workspaceDir });
      managers.push(reader);
      await reader.initialize();
      expect(await reader.getTask(`diagnosis_${painId}`)).not.toBeNull();
    }
  });

  it('fully enabled normal path is unchanged: bridge constructs through the normal capability path', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const bridge = await createPainSignalBridge({
      workspaceDir,
      stateDir,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      owner: 'pri638',
      effectiveConfig: effectiveConfigFor({ agentEnabled: true }),
      getEnvVar: () => undefined,
    });

    // The pipeline run itself is not probed here: its per-stage budget
    // (timeoutMs/3 = 100s) is unfit for a unit suite and is already covered by
    // diag-chain-e2e / golden-path-diagnostician-e2e. The structural fact this
    // suite must pin is that the enabled path still constructs a live bridge.
    expect(bridge).toBeDefined();
  });
});

// ── Recovery contract ────────────────────────────────────────────────────────

describe('PRI-638 — recovery contract (disabled → re-enable → diagnosis resumes)', () => {
  it('disabled run leaves a pending task; after re-enable the same task completes', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });

    // Phase 1 — capability disabled: the pain lands, no diagnosis runs.
    const disabledBridge = await createPainSignalBridge({
      workspaceDir,
      stateDir,
      ledgerAdapter,
      owner: 'pri638',
      effectiveConfig: effectiveConfigFor({ agentEnabled: false }),
      getEnvVar: () => undefined,
    });
    const disabledResult = await disabledBridge.onPainDetected({
      painId: PAIN_ID,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'PRI-638 recovery probe',
      score: 80,
      sessionId: 'pri638-session',
      agentId: 'pri638',
      evidence: [{ sourceRef: 'tool_calls:1', note: 'recovery probe evidence' }],
    });
    expect(disabledResult.status).toBe('failed');
    expect(disabledResult.errorCategory).toBe('capability_missing');

    // Phase 2 — Owner re-enables the agent. The SAME task (same taskId, same
    // pain identity) is picked up and completes. The runner here is a stub
    // standing in for the split pipeline (whose 100s-per-stage budget is unfit
    // for a unit suite); everything around it — task store, lease semantics,
    // diagnosis persistence, candidate intake — is the real production path.
    const stateManager = new RuntimeStateManager({ workspaceDir });
    managers.push(stateManager);
    await stateManager.initialize();
    const runnerStub = {
      // The real committer marks the task succeeded when the router commits;
      // the stub reproduces exactly that transition.
      run: vi.fn(async (taskId: string) => {
        await stateManager.updateTask(taskId, { status: 'succeeded', attemptCount: 1 });
        return {
          status: 'succeeded' as const,
          taskId,
          output: makeOutput('People: agent skipped the argument validation step'),
          attemptCount: 1,
        };
      }),
    };
    const recoveryBridge = new PainSignalBridge({
      stateManager,
      runner: runnerStub,
      intakeService: new CandidateIntakeService({ stateManager, ledgerAdapter }),
      ledgerAdapter,
      workspaceDir,
      owner: 'pri638-recovery',
    });

    const recovered = await recoveryBridge.executePendingDiagnosis({ taskId: TASK_ID });

    expect(runnerStub.run).toHaveBeenCalledWith(TASK_ID);
    // The SAME task, created while the capability was disabled, completed
    // after re-enable — no data loss, no re-admission needed.
    expect(recovered.errorCategory).not.toBe('capability_missing');
    const task = await stateManager.getTask(TASK_ID);
    expect(task?.status).toBe('succeeded');
  });

  it('DisabledDiagnosticianRunner carries the canonical reason and a real recovery action', async () => {
    const runner = new DisabledDiagnosticianRunner();
    const result = await runner.run('task-1');

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('capability_missing');
    expect(result.failureReason).toBe(DIAGNOSTICIAN_DISABLED_FAILURE_REASON);
    expect(result.nextAction).toContain('internalAgents.agents.diagnostician.enabled');
  });
});

// ── PRI-638 P1-A: disabled re-trigger must not reset durable task state ──────
//
// Owner-disable means PAUSE, not "re-trigger". While the capability is
// disabled, re-emitting a Pain must only ensure the durable task exists; an
// existing task keeps its status / attemptCount / lastError / lease untouched.
// (This is the regression suite for the P1-A review finding.)

describe('PRI-638 P1-A — disabled re-trigger preserves durable task state', () => {
  async function makeDisabledBridge(workspaceDir: string, stateDir: string) {
    return createPainSignalBridge({
      workspaceDir,
      stateDir,
      ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
      owner: 'pri638-p1a',
      effectiveConfig: effectiveConfigFor({ agentEnabled: false }),
      getEnvVar: () => undefined,
    });
  }

  function painData(painId: string) {
    return {
      painId,
      painType: 'user_frustration' as const,
      source: 'manual',
      reason: 'PRI-638 P1-A probe',
      score: 80,
      sessionId: 'pri638-session',
      agentId: 'pri638',
      evidence: [{ sourceRef: 'tool_calls:1', note: 'evidence' }],
    };
  }

  it('A1: new Pain while disabled → task created pending, attemptCount 0, provider 0', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const startRunSpy = vi.spyOn(OpenClawCliRuntimeAdapter.prototype, 'startRun').mockRejectedValue(new Error('probe'));
    startRunSpy.mockClear();

    const bridge = await makeDisabledBridge(workspaceDir, stateDir);
    const result = await bridge.onPainDetected(painData('pain-p1a-new'));

    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('capability_missing');
    const reader = new RuntimeStateManager({ workspaceDir });
    managers.push(reader);
    await reader.initialize();
    const task = await reader.getTask('diagnosis_pain-p1a-new');
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(0);
    expect(startRunSpy.mock.calls).toHaveLength(0);
  });

  it('A2: existing pending keeps attemptCount + lastError', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const writer = new RuntimeStateManager({ workspaceDir });
    managers.push(writer);
    await writer.initialize();
    await writer.createTask({
      taskId: 'diagnosis_pain-p1a-pending',
      taskKind: 'diagnostician',
      inputRef: 'pain-p1a-pending',
      status: 'pending',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: 'timeout',
      diagnosticJson: JSON.stringify({ painId: 'pain-p1a-pending', evidence: [] }),
    });

    const bridge = await makeDisabledBridge(workspaceDir, stateDir);
    const result = await bridge.onPainDetected(painData('pain-p1a-pending'));

    expect(result.errorCategory).toBe('capability_missing');
    const task = await writer.getTask('diagnosis_pain-p1a-pending');
    expect(task?.status).toBe('pending');
    expect(task?.attemptCount).toBe(1);
    expect(task?.lastError).toBe('timeout');
  });

  it('A3: retry_wait keeps status/attemptCount/lastError/lease unchanged', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

    const writer = new RuntimeStateManager({ workspaceDir });
    managers.push(writer);
    await writer.initialize();
    await writer.createTask({
      taskId: 'diagnosis_pain-p1a-retrywait',
      taskKind: 'diagnostician',
      inputRef: 'pain-p1a-retrywait',
      status: 'retry_wait',
      attemptCount: 2,
      maxAttempts: 3,
      lastError: 'timeout',
      leaseExpiresAt,
      diagnosticJson: JSON.stringify({ painId: 'pain-p1a-retrywait', evidence: [] }),
    });

    const bridge = await makeDisabledBridge(workspaceDir, stateDir);
    await bridge.onPainDetected(painData('pain-p1a-retrywait'));

    const task = await writer.getTask('diagnosis_pain-p1a-retrywait');
    expect(task?.status).toBe('retry_wait');
    expect(task?.attemptCount).toBe(2);
    expect(task?.lastError).toBe('timeout');
    expect(task?.leaseExpiresAt).toBe(leaseExpiresAt);
  });

  it('A4: failed task is never resurrected by a disabled re-trigger', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const writer = new RuntimeStateManager({ workspaceDir });
    managers.push(writer);
    await writer.initialize();
    await writer.createTask({
      taskId: 'diagnosis_pain-p1a-failed',
      taskKind: 'diagnostician',
      inputRef: 'pain-p1a-failed',
      status: 'failed',
      attemptCount: 3,
      maxAttempts: 3,
      lastError: 'max_attempts_exceeded',
      diagnosticJson: JSON.stringify({ painId: 'pain-p1a-failed', evidence: [] }),
    });

    const bridge = await makeDisabledBridge(workspaceDir, stateDir);
    await bridge.onPainDetected(painData('pain-p1a-failed'));

    const task = await writer.getTask('diagnosis_pain-p1a-failed');
    expect(task?.status).toBe('failed');
    expect(task?.attemptCount).toBe(3);
    expect(task?.lastError).toBe('max_attempts_exceeded');
  });

  it('A5: needs_human_review task is never resurrected', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const writer = new RuntimeStateManager({ workspaceDir });
    managers.push(writer);
    await writer.initialize();
    await writer.createTask({
      taskId: 'diagnosis_pain-p1a-nhr',
      taskKind: 'diagnostician',
      inputRef: 'pain-p1a-nhr',
      status: 'needs_human_review',
      attemptCount: 2,
      maxAttempts: 3,
      lastError: 'output_invalid',
      diagnosticJson: JSON.stringify({ painId: 'pain-p1a-nhr', evidence: [] }),
    });

    const bridge = await makeDisabledBridge(workspaceDir, stateDir);
    await bridge.onPainDetected(painData('pain-p1a-nhr'));

    const task = await writer.getTask('diagnosis_pain-p1a-nhr');
    expect(task?.status).toBe('needs_human_review');
    expect(task?.attemptCount).toBe(2);
  });

  it('A6: succeeded task stays idempotent while disabled', async () => {
    const workspaceDir = makeWorkspace();
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const writer = new RuntimeStateManager({ workspaceDir });
    managers.push(writer);
    await writer.initialize();
    await writer.createTask({
      taskId: 'diagnosis_pain-p1a-done',
      taskKind: 'diagnostician',
      inputRef: 'pain-p1a-done',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({ painId: 'pain-p1a-done', evidence: [] }),
    });

    const bridge = await makeDisabledBridge(workspaceDir, stateDir);
    const result = await bridge.onPainDetected(painData('pain-p1a-done'));

    // Idempotent semantics preserved: the disabled path reports the existing
    // result through buildExistingResult (its status follows the existing
    // no-candidates shaping), and crucially the task is NOT reset.
    expect(result.errorCategory).not.toBe('capability_missing');
    const task = await writer.getTask('diagnosis_pain-p1a-done');
    expect(task?.status).toBe('succeeded');
    expect(task?.attemptCount).toBe(1);
  });
});

