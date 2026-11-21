/**
 * Worker Adapter unified contract (task §3–§5, TD §2.3): the supports()
 * binding-evidence matrix (claims / declarations — never feature flags),
 * hostKind/adapterVersion fields, structured outcome mapping from real
 * worker results (ready/paused/degraded/nonzero/garbage/shape-rejected),
 * timeout / cancellation / spawn-failure outcomes, allowlist environment
 * reaching the spawn boundary, and liveness health projection.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeStateHandle, getDefaultPdConfig } from '@principles/core/runtime';
import { createCodexWorkerAdapter } from '../../../src/services/service-host/worker-adapter-codex.js';
import { createWorkbuddyWorkerAdapter } from '../../../src/services/service-host/worker-adapter-workbuddy.js';
import { WORKER_ADAPTER_CONTRACT_VERSION, resolveActiveReleaseCliEntry } from '../../../src/services/service-host/worker-adapter.js';
import type { WorkerProcessOptions, WorkerProcessResult } from '../../../src/services/service-host/worker-process.js';
import { resolveCoordinatorInstallIdentity } from '../../../src/services/service-host/install-identity.js';
import type { WorkspaceDescriptor } from '../../../src/services/service-host/worker-adapter.js';
import type { AdapterCycleResult } from '../../../src/services/service-host/worker-adapter.js';

const dirs: string[] = [];
function tempDir(prefix = 'pd-sh-adapter-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandboxIdentity() {
  const home = tempDir('pd-sh-adapter-home-');
  const resolved = resolveCoordinatorInstallIdentity({}, { trustedHomeDir: home });
  if (!resolved.ok) throw new Error(`identity refused: ${resolved.reason}`);
  return resolved.identity;
}

function fixtureEntry(): ReturnType<typeof resolveActiveReleaseCliEntry> {
  // Integration-grade entry injection: tests point at fixture scripts; the
  // production path (no probe) resolves the active-release install.
  return { kind: 'entry', entry: 'fixture-entry.mjs', source: 'canonical' };
}

function descriptor(overrides: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  return {
    canonicalDir: 'C:\\ws\\fixture',
    discoveryVerdict: 'authorized',
    claimingHosts: ['codex'],
    declaredHostKinds: [],
    ...overrides,
  };
}

function procResult(overrides: Partial<WorkerProcessResult> = {}): WorkerProcessResult {
  return {
    exitCode: 0,
    termSignal: null,
    stdout: JSON.stringify({ workspaceDir: 'C:\\ws\\fixture', mode: 'ready' }),
    stdoutTruncated: false,
    stderrTail: '',
    timedOut: false,
    cancelled: false,
    durationMs: 5,
    ...overrides,
  };
}

/** A real workspace with a bootstrapped state store (progress evidence path). */
async function workspaceWithStore(): Promise<string> {
  const workspace = tempDir();
  mkdirSync(path.join(workspace, '.pd'), { recursive: true });
  const handle = await createRuntimeStateHandle({ workspaceDir: workspace, readonly: false, bootstrapIfMissing: true });
  await handle.close().catch(() => undefined);
  return workspace;
}

const FIXTURE_ENTRY_PROBE = { resolveCliEntry: fixtureEntry };

describe('supports() — binding evidence only (task §3)', () => {
  const codex = createCodexWorkerAdapter();
  it('accepts an authorized workspace with a validated codex claim', () => {
    expect(codex.supports(descriptor())).toEqual({ supported: true });
  });
  it('accepts a workspace with only a persisted host-tool declaration', () => {
    expect(codex.supports(descriptor({ claimingHosts: [], declaredHostKinds: ['codex'] }))).toEqual({ supported: true });
  });
  it('rejects a workspace with NO binding evidence (flags/cwd are not identity)', () => {
    const verdict = codex.supports(descriptor({ claimingHosts: [], declaredHostKinds: [] }));
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.reason).toBe('no_host_binding_evidence');
  });
  it('rejects a non-authorized discovery verdict', () => {
    const verdict = codex.supports(descriptor({ discoveryVerdict: 'degraded' }));
    expect(verdict.supported).toBe(false);
    if (!verdict.supported) expect(verdict.reason).toContain('workspace_not_authorized');
  });
  it('a workbuddy claim does not admit the codex adapter', () => {
    const verdict = codex.supports(descriptor({ claimingHosts: ['workbuddy'] }));
    expect(verdict.supported).toBe(false);
  });
  it('hostKind / adapterVersion are part of the contract surface', () => {
    expect(codex.hostKind).toBe('codex');
    expect(codex.adapterVersion).toBe(WORKER_ADAPTER_CONTRACT_VERSION);
    const wb = createWorkbuddyWorkerAdapter();
    expect(wb.hostKind).toBe('workbuddy');
    expect(wb.adapterVersion).toBe(WORKER_ADAPTER_CONTRACT_VERSION);
  });
});

describe('executeOnce — outcome mapping (fail-closed, rc-1..rc-4)', () => {
  it('ready + real task-state change → cycle_completed with a task-sourced lastProgressAt', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const spawnWorkerProcess = async (): Promise<WorkerProcessResult> => {
      // Simulate the real worker advancing a task between the snapshots.
      const handle = await createRuntimeStateHandle({ workspaceDir: workspace, readonly: false, bootstrapIfMissing: true });
      try {
        await handle.stateManager.createTask({
          taskId: 'adapter-evidence-1',
          taskKind: 'diagnostician',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
        });
      } finally {
        await handle.close().catch(() => undefined);
      }
      return procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready' }) });
    };
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-1',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess },
    });
    expect(result.hostKind).toBe('codex');
    expect(result.adapterVersion).toBe(WORKER_ADAPTER_CONTRACT_VERSION);
    expect(result.invocationId).toBe('inv-1');
    expect(result.cycleOutcome).toBe('cycle_completed');
    expect(result.lastProgressAt).not.toBeNull();
    expect(result.businessProgress.taskStateChanged).toBe(true);
    expect(result.businessProgress.changedTaskCount).toBe(1);
  });

  it('ready + an EMPTY cycle → cycle_completed_without_business_progress with null progress (task §6)', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-2',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess: async () => procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready' }) }) },
    });
    expect(result.cycleOutcome, `reason=${result.reason ?? 'none'}`).toBe('cycle_completed_without_business_progress');
    expect(result.lastProgressAt).toBeNull();
    expect(result.businessProgress.taskStateChanged).toBe(false);
  });

  it('report evidence alone (diagnostician succeeded, no task diff visible) still marks the cycle completed', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-2b',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready', report: { diagnostician: { taskId: 't9', status: 'succeeded' } } }),
        }),
      },
    });
    expect(result.cycleOutcome).toBe('cycle_completed');
    expect(result.businessProgress.diagnosticianSucceeded).toBe(true);
  });

  it('paused and degraded worker modes map 1:1 with reason/nextAction', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createWorkbuddyWorkerAdapter();
    const run = async (mode: string): Promise<AdapterCycleResult> => adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: `inv-${mode}`,
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({ workspaceDir: workspace, mode, reason: `${mode}_fixture`, nextAction: 'fixture next' }),
        }),
      },
    });
    const paused = await run('paused');
    expect(paused.cycleOutcome).toBe('paused');
    expect(paused.reason).toBe('paused_fixture');
    expect(paused.nextAction).toBe('fixture next');
    const degraded = await run('degraded');
    expect(degraded.cycleOutcome).toBe('degraded');
    expect(degraded.reason).toBe('degraded_fixture');
  });

  it('garbage stdout fails closed as failed/worker_result_unparseable', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-3',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess: async () => procResult({ stdout: 'not json at all' }) },
    });
    expect(result.cycleOutcome).toBe('failed');
    expect(result.reason).toContain('worker_result_unparseable');
  });

  it('a result naming a DIFFERENT workspace is rejected (shape guard)', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-4',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({ stdout: JSON.stringify({ workspaceDir: '/some/other/workspace', mode: 'ready' }) }),
      },
    });
    expect(result.cycleOutcome).toBe('failed');
    expect(result.reason).toContain('worker_result_rejected:workspace_mismatch');
  });

  it('an unknown mode value is rejected (unknown results never pass)', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-5',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'super-ready' }) }),
      },
    });
    expect(result.cycleOutcome).toBe('failed');
    expect(result.reason).toContain('worker_result_rejected:unknown_mode');
  });

  it('timeout and cancellation outcomes never fabricate success (task §8)', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const timeout = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-6',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess: async () => procResult({ timedOut: true, exitCode: null, stdout: '' }) },
    });
    expect(timeout.cycleOutcome).toBe('timeout');
    expect(timeout.reason).toContain('worker_timeout');
    const cancelled = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-7',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess: async () => procResult({ cancelled: true, exitCode: null, stdout: '' }) },
    });
    expect(cancelled.cycleOutcome).toBe('cancelled');
  });

  it('a missing CLI entry is unavailable (never a worktree fallback, task §7.4)', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-8',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      // No resolveCliEntry probe: the real resolver finds no install in the sandbox.
    });
    expect(result.cycleOutcome).toBe('unavailable');
    expect(result.reason).toBe('cli_entry_missing');
  });

  it('unreadable progress evidence (corrupt store) degrades a ready cycle (rc-9)', async () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    writeFileSync(path.join(workspace, '.pd', 'state.db'), 'definitely not a sqlite database', 'utf8');
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-9',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess: async () => procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready' }) }) },
    });
    expect(result.cycleOutcome).toBe('degraded');
    expect(result.reason).toContain('progress_evidence_unavailable');
  });
});

describe('environment + liveness projection', () => {
  it('the spawned child env is allowlist-built and pointer-free even under a polluted parent env (task §7)', async () => {
    const workspace = await workspaceWithStore();
    const identity = sandboxIdentity();
    const captured: WorkerProcessOptions[] = [];
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-env',
      timeoutMs: 5_000,
      identity,
      inheritedEnv: {
        PD_EXPERIMENT_ROOT: '/evil/root',
        PD_WORKSPACE_DIR: '/evil/ws',
        CODEX_HOME: '/evil/codex',
        PD_INVOCATION_SOURCE: 'companion',
        PATH: '/usr/bin',
      },
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async (options) => {
          captured.push(options);
          return procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready' }) });
        },
      },
    });
    expect(result.cycleOutcome).toBe('cycle_completed_without_business_progress');
    const env = captured[0]?.env;
    expect(env).toBeDefined();
    expect(env?.PD_INVOCATION_SOURCE).toBe('service_host');
    expect(env?.CODEX_HOME).toBe(identity.hostRoots.codexHome);
    expect(env?.HOME).toBe(identity.homeDir);
    expect(env?.PD_EXPERIMENT_ROOT).toBeUndefined();
    expect(env?.PD_WORKSPACE_DIR).toBeUndefined();
    expect(env?.PATH).toBe('/usr/bin');
    // The CLI is invoked parameterized — no shell string, no cwd reliance.
    expect(captured[0]?.args).toEqual(['codex', 'worker', '--once', '--json', '--workspace', path.resolve(workspace)]);
  });

  it('health projects the liveness facts written by the worker cycle', async () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, '.state'), { recursive: true });
    writeFileSync(
      path.join(workspace, '.state', 'codex-worker-liveness.json'),
      JSON.stringify({ lastCycleDriver: 'service_host', lastCycleCompletedAt: '2026-11-21T09:00:00Z', lastCycleMode: 'ready', runningStage: null }),
      'utf8',
    );
    const storeWorkspace = await workspaceWithStore();
    // Reuse the same workspace dir: move the store into the liveness workspace.
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: storeWorkspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-health',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => {
          mkdirSync(path.join(storeWorkspace, '.state'), { recursive: true });
          writeFileSync(
            path.join(storeWorkspace, '.state', 'codex-worker-liveness.json'),
            JSON.stringify({ lastCycleDriver: 'service_host', lastCycleCompletedAt: '2026-11-21T09:30:00Z', lastCycleMode: 'ready', runningStage: null }),
            'utf8',
          );
          return procResult({ stdout: JSON.stringify({ workspaceDir: storeWorkspace, mode: 'ready' }) });
        },
      },
    });
    expect(result.health.livenessRecorded).toBe(true);
    expect(result.health.lastCycleDriver).toBe('service_host');
    expect(result.health.lastCycleCompletedAt).toBe('2026-11-21T09:30:00Z');
    void workspace;
  });

  it('F13: the invocation id reaches the child env and the liveness correlation closes', async () => {
    const workspace = await workspaceWithStore();
    const captured: WorkerProcessOptions[] = [];
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-corr-777',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async (options) => {
          captured.push(options);
          mkdirSync(path.join(workspace, '.state'), { recursive: true });
          // The (service_host-driven) worker records the id it received.
          writeFileSync(
            path.join(workspace, '.state', 'codex-worker-liveness.json'),
            JSON.stringify({ lastCycleDriver: 'service_host', lastInvocationId: 'inv-corr-777', lastCycleCompletedAt: '2026-11-21T10:00:00Z', lastCycleMode: 'ready', runningStage: null }),
            'utf8',
          );
          return procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready' }) });
        },
      },
    });
    expect(captured[0]?.env.PD_INVOCATION_ID).toBe('inv-corr-777');
    expect(result.health.lastInvocationId).toBe('inv-corr-777');
    expect(result.invocationId).toBe('inv-corr-777');
  });

  it('F3: worker stderr and reason strings are sanitized (paths redacted) before persistence', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-sanitize',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({
            workspaceDir: workspace,
            mode: 'degraded',
            reason: `pd_config_invalid:cannot parse C:\\Users\\op\\.pd\\config.yaml near line 3`,
            nextAction: `Repair /home/op/workspace/.pd/config.yaml`,
          }),
          stderrTail: `Error: ENOENT at D:\\secret\\projects\\app\\node_modules\\x.js\n\x07bell\r\nsome tail`,
        }),
      },
    });
    expect(result.cycleOutcome).toBe('degraded');
    // Absolute paths are redacted to <path> — the status never carries them.
    expect(result.reason).toContain('<path>');
    expect(result.reason).not.toContain('C:\\Users');
    expect(result.nextAction).toContain('<path>');
    expect(result.nextAction).not.toContain('/home/op');
    expect(result.worker.stderrTail).toContain('<path>');
    expect(result.worker.stderrTail).not.toContain('D:\\secret');
    // Control characters are stripped.
    expect(result.worker.stderrTail).not.toMatch(/[\x07\r]/);
    expect(result.worker.stderrTail).not.toContain('\n');
  });

  it('F5: a downstream ATTEMPT (ran without succeeded runStatus) is not progress evidence', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-downstream-attempt',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({
            workspaceDir: workspace,
            mode: 'ready',
            report: { downstream: { ran: true, runStatus: 'retried' } },
          }),
        }),
      },
    });
    // No task diff, no persisted-outcome evidence → the empty-cycle rule.
    expect(result.cycleOutcome).toBe('cycle_completed_without_business_progress');
    expect(result.lastProgressAt).toBeNull();
  });

  it('F5: a succeeded downstream run still counts as persisted evidence', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-downstream-ok',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({
            workspaceDir: workspace,
            mode: 'ready',
            report: { downstream: { ran: true, runStatus: 'succeeded' } },
          }),
        }),
      },
    });
    expect(result.cycleOutcome).toBe('cycle_completed');
    expect(result.lastProgressAt).not.toBeNull();
    expect(result.businessProgress.downstreamRan).toBe(true);
  });

  it('F5: Codex catch-up counts only rollouts that persisted rows (inserted > 0), not re-checked sessions', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-replay',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({
            workspaceDir: workspace,
            mode: 'ready',
            report: {
              catchUp: {
                status: 'ok',
                rollouts: [
                  // Re-examined, already-synced session: an entry WITHOUT writes.
                  { rolloutIdentity: 'r1', outcome: { status: 'ok', inserted: 0 } },
                  // Degraded rollout: no persisted rows either.
                  { rolloutIdentity: 'r2', outcome: { status: 'degraded', reason: 'x' } },
                ],
                remainingLagRollouts: [],
              },
            },
          }),
        }),
      },
    });
    expect(result.cycleOutcome).toBe('cycle_completed_without_business_progress');
    expect(result.businessProgress.catchUpProcessed).toBe(0);
    expect(result.lastProgressAt).toBeNull();
  });

  it('F5: Codex catch-up rollouts with inserted > 0 ARE evidence (with the real timestamp)', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-ingest',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async () => procResult({
          stdout: JSON.stringify({
            workspaceDir: workspace,
            mode: 'ready',
            report: {
              catchUp: {
                status: 'ok',
                rollouts: [{ rolloutIdentity: 'r1', outcome: { status: 'ok', inserted: 3 } }],
                remainingLagRollouts: [],
              },
            },
          }),
        }),
      },
    });
    expect(result.cycleOutcome).toBe('cycle_completed');
    expect(result.businessProgress.catchUpProcessed).toBe(3);
    expect(result.lastProgressAt).not.toBeNull();
  });

  it('F7: a degraded cycle with a REAL task change records the evidenced progress timestamp', async () => {
    const workspace = await workspaceWithStore();
    const adapter = createCodexWorkerAdapter();
    const spawnWorkerProcess = async (): Promise<WorkerProcessResult> => {
      // The worker degraded at a later step, but the diagnosis DID complete:
      // the task moved pending → succeeded between the snapshots.
      const handle = await createRuntimeStateHandle({ workspaceDir: workspace, readonly: false, bootstrapIfMissing: true });
      try {
        await handle.stateManager.createTask({
          taskId: 'degraded-progress-1',
          taskKind: 'diagnostician',
          status: 'pending',
          attemptCount: 0,
          maxAttempts: 3,
        });
      } finally {
        await handle.close().catch(() => undefined);
      }
      return procResult({
        stdout: JSON.stringify({
          workspaceDir: workspace,
          mode: 'degraded',
          reason: 'catch_up:lag',
        }),
      });
    };
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-degraded-progress',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      probes: { ...FIXTURE_ENTRY_PROBE, spawnWorkerProcess },
    });
    // The outcome stays truthfully degraded; the progress timestamp is real.
    expect(result.cycleOutcome).toBe('degraded');
    expect(result.reason).toBe('catch_up:lag');
    expect(result.businessProgress.taskStateChanged).toBe(true);
    expect(result.lastProgressAt).not.toBeNull();
  });

  it('F4: the child env carries the workspace config apiKeyEnv names even when they are not credential-pattern-shaped', async () => {
    const workspace = tempDir();
    mkdirSync(path.join(workspace, '.pd'), { recursive: true });
    const handle = await createRuntimeStateHandle({ workspaceDir: workspace, readonly: false, bootstrapIfMissing: true });
    await handle.close().catch(() => undefined);
    // A valid config whose runtime profile names a custom credential var.
    const config = getDefaultPdConfig();
    (config.runtimeProfiles as Record<string, unknown>)['custom-cred-profile'] = {
      type: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEAM_LLM_AUTH',
    };
    const configFile = path.join(workspace, '.pd', 'config.yaml');
    writeFileSync(configFile, JSON.stringify(config), 'utf8');
    const captured: WorkerProcessOptions[] = [];
    const adapter = createCodexWorkerAdapter();
    const result = await adapter.executeOnce({
      workspaceDir: workspace,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: 'inv-custom-cred',
      timeoutMs: 5_000,
      identity: sandboxIdentity(),
      inheritedEnv: { TEAM_LLM_AUTH: 'fixture-inert-value' },
      probes: {
        ...FIXTURE_ENTRY_PROBE,
        spawnWorkerProcess: async (options) => {
          captured.push(options);
          return procResult({ stdout: JSON.stringify({ workspaceDir: workspace, mode: 'ready' }) });
        },
      },
    });
    // TEAM_LLM_AUTH matches no credential PATTERN — only the config-derived
    // allowlist keeps it alive for the worker's resolveProviderApiKey chain.
    expect(captured[0]?.env.TEAM_LLM_AUTH).toBe('fixture-inert-value');
    // The PERSISTED report carries NAMES only — the value never lands there.
    expect(JSON.stringify(result.worker.environmentReport)).toContain('TEAM_LLM_AUTH');
    expect(JSON.stringify(result.worker.environmentReport)).not.toContain('fixture-inert-value');
    expect(result.cycleOutcome).toBe('cycle_completed_without_business_progress');
  });
});
