/**
 * The Phase 3 managed-run coordinator (PRI-1281 task §4): the ownership
 * admission matrix (service_host_owned executes; legacy skipped; transition
 * states forbidden; non-authorized refused), the legal-empty semantics, the
 * truthful triggerSource record, progress carry-forward, per-workspace
 * failure isolation, and the fail-closed manifest/marker behavior.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runServiceManagedOnce, type ManagedRunResult } from '../../../src/services/service-host/managed-run.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';
import { shadowProgressPath } from '../../../src/services/service-host/shadow-progress-store.js';
import type { AdapterCycleResult, WorkerAdapter, WorkspaceDescriptor, AdapterSupport } from '../../../src/services/service-host/worker-adapter.js';
import { WORKER_ADAPTER_CONTRACT_VERSION } from '../../../src/services/service-host/worker-adapter.js';

const dirs: string[] = [];
function tempHome(prefix = 'pd-sh-managed-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function activeRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generation: 5,
    releaseId: 'bundled-9.9.9-managed',
    releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null,
    transactionId: 'txn-managed-1',
    productVersion: '9.9.9',
  };
}

type OwnerFixture =
  | 'none'
  | { state: 'legacy_owned' }
  | { state: 'service_host_owned' }
  | { state: 'handover_preparing' }
  | { state: 'rollback_pending' };

function ownerRecord(fixture: OwnerFixture): Record<string, unknown> | undefined {
  if (fixture === 'none') return undefined;
  switch (fixture.state) {
    case 'legacy_owned':
      return { state: 'legacy_owned', effectiveOwner: 'legacy', generation: 1, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-20T00:00:00.000Z' };
    case 'service_host_owned':
      return { state: 'service_host_owned', effectiveOwner: 'service_host', generation: 1, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-20T00:00:00.000Z' };
    case 'handover_preparing':
      return { state: 'handover_preparing', effectiveOwner: 'legacy', generation: 1, operationId: 'op-handover-1', previousOwner: 'legacy', targetOwner: 'service_host', updatedAt: '2026-11-20T00:00:00.000Z' };
    case 'rollback_pending':
      return { state: 'rollback_pending', effectiveOwner: 'service_host', generation: 1, operationId: 'op-rollback-1', previousOwner: 'service_host', targetOwner: 'legacy', updatedAt: '2026-11-20T00:00:00.000Z' };
  }
}

/** Write a sandbox install: manifest + authoritative active record. */
function installSandbox(home: string, workspaces: string[], ownerFixtures: Record<string, OwnerFixture> = {}): string {
  const pdDir = path.join(home, '.pd');
  mkdirSync(pdDir, { recursive: true });
  const manifestFile = path.join(pdDir, 'install.json');
  const activeFile = path.join(pdDir, 'active.json');
  const backgroundExecutions: Record<string, unknown> = {};
  for (const [ws, fixture] of Object.entries(ownerFixtures)) {
    const record = ownerRecord(fixture);
    if (record !== undefined) backgroundExecutions[ws] = record;
  }
  writeFileSync(manifestFile, JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: ['codex', 'workbuddy'],
    workspaces,
    ...(Object.keys(backgroundExecutions).length > 0 ? { backgroundExecutions } : {}),
  }), 'utf8');
  writeFileSync(activeFile, JSON.stringify(activeRecord()), 'utf8');
  return pdDir;
}

function validDeclaration(hostKind: string): Record<string, unknown> {
  return {
    version: 2,
    hostKind,
    mappings: [{ rawToolName: 'Read', canonicalKind: 'read' }],
    declaredAt: '2026-11-21T00:00:00.000Z',
  };
}

/**
 * A codex-bound workspace: .pd dir + VALID host-tool declaration.
 * `home` comes from mkdtempSync and `name` from call-site literals only.
 */
function codexWorkspace(home: string, name: string): string {
  const ws = `${home}${path.sep}${name}`;
  const semanticsDir = path.join(ws, '.pd', 'host-tool-semantics');
  mkdirSync(semanticsDir, { recursive: true });
  writeFileSync(path.join(semanticsDir, 'codex.json'), JSON.stringify(validDeclaration('codex')), 'utf8');
  return ws;
}

/** A workspace WITHOUT a .pd dir (registered but on-disk state missing → degraded verdict). */
function missingStateWorkspace(home: string, name: string): string {
  const ws = `${home}${path.sep}${name}`;
  mkdirSync(home, { recursive: true });
  return ws;
}

function fakeAdapter(hostKind: 'codex' | 'workbuddy', overrides: {
  outcome?: AdapterCycleResult['cycleOutcome'];
  lastProgressAt?: string | null;
  taskStateChanged?: boolean;
  throw?: Error;
} = {}): WorkerAdapter {
  return {
    hostKind,
    adapterVersion: WORKER_ADAPTER_CONTRACT_VERSION,
    supports: (descriptor: WorkspaceDescriptor): AdapterSupport => ({
      supported:
        descriptor.discoveryVerdict === 'authorized'
        && (descriptor.claimingHosts.includes(hostKind) || descriptor.declaredHostKinds.includes(hostKind)),
    }),
    executeOnce: async (input) => {
      if (overrides.throw !== undefined) throw overrides.throw;
      const completedAt = new Date().toISOString();
      return {
        hostKind,
        adapterVersion: WORKER_ADAPTER_CONTRACT_VERSION,
        workspaceDir: input.workspaceDir,
        invocationId: input.invocationId,
        cycleOutcome: overrides.outcome ?? 'cycle_completed_without_business_progress',
        lastProgressAt: overrides.lastProgressAt ?? null,
        businessProgress: {
          taskStateChanged: overrides.taskStateChanged ?? false,
          changedTaskCount: overrides.taskStateChanged === true ? 1 : 0,
          diagnosticianSucceeded: false,
          downstreamRan: false,
          postProcessingResumed: 0,
          catchUpProcessed: 0,
          evidenceReadable: true,
        },
        health: {
          livenessFile: path.join(input.workspaceDir, '.state', `${hostKind}-worker-liveness.json`),
          livenessRecorded: true,
          lastCycleDriver: 'service_host',
          lastCycleCompletedAt: completedAt,
          lastCycleMode: 'ready',
          runningStage: null,
        },
        startedAt: completedAt,
        completedAt,
        durationMs: 10,
        worker: {
          cliEntry: 'fixture-entry.mjs',
          cliEntrySource: 'canonical',
          exitCode: 0,
          termSignal: null,
          timedOut: false,
          cancelled: false,
          stdoutTruncated: false,
          environmentReport: {
            stripped: [],
            pinnedFromTrustedIdentity: ['PD_INVOCATION_SOURCE'],
            passedThrough: [],
            invocationSource: 'service_host',
          },
        },
      };
    },
  };
}

function expectCompleted(result: ManagedRunResult): asserts result is Extract<ManagedRunResult, { outcome: 'completed' }> {
  if (!result.ok || result.outcome !== 'completed') {
    throw new Error(`expected completed, got ${JSON.stringify({ ok: result.ok, outcome: result.outcome, reason: result.reason })}`);
  }
}

describe('ownership admission matrix (task §4)', () => {
  it('executes a service_host_owned authorized workspace through the bound adapter', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'sh-owned');
    installSandbox(home, [ws], { [ws]: { state: 'service_host_owned' } });
    let dispatched = 0;
    const adapter = fakeAdapter('codex');
    const counting: WorkerAdapter = { ...adapter, executeOnce: async (input) => { dispatched += 1; return adapter.executeOnce(input); } };

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: counting, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(dispatched).toBe(1);
    const record = result.executions.find((e) => e.canonicalDir === ws || e.canonicalDir.toLowerCase() === ws.toLowerCase());
    expect(record, 'execution record for the owned workspace').toBeDefined();
    expect(record?.admission).toBe('executed');
    expect(record?.workspaceState).toBe('completed');
    expect(record?.hostKind).toBe('codex');
    expect(result.status.managed?.emptyReason).toBeUndefined();
  });

  it('skips legacy-owned workspaces WITHOUT dispatching any adapter (the legacy owner stays unique)', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'legacy-ws');
    installSandbox(home, [ws], { [ws]: { state: 'legacy_owned' } });
    let dispatched = 0;
    const adapter = fakeAdapter('codex');
    const counting: WorkerAdapter = { ...adapter, executeOnce: async (input) => { dispatched += 1; return adapter.executeOnce(input); } };

    const result = await runServiceManagedOnce({
      triggerSource: 'manual',
      trustedHomeDir: home,
      probes: { adapters: { codex: counting, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(dispatched).toBe(0);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.admission).toBe('skipped');
    expect(result.executions[0]?.skipReason).toBe('legacy_owned_workspace');
    // Legal empty execution: zero service_host_owned workspaces.
    expect(result.status.managed?.emptyReason).toBe('no_service_host_owned_workspaces');
    expect(result.status.nextAction).toContain('legal empty');
  });

  it('NEVER executes handover_preparing workspaces (forbidden transition state)', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'handover-ws');
    installSandbox(home, [ws], { [ws]: { state: 'handover_preparing' } });
    let dispatched = 0;
    const adapter = fakeAdapter('codex');
    const counting: WorkerAdapter = { ...adapter, executeOnce: async (input) => { dispatched += 1; return adapter.executeOnce(input); } };

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: counting, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(dispatched).toBe(0);
    expect(result.executions[0]?.skipReason).toBe('handover_preparing_forbidden');
    expect(result.status.managed?.emptyReason).toBe('no_service_host_owned_workspaces');
  });

  it('NEVER executes rollback_pending workspaces', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'rollback-ws');
    installSandbox(home, [ws], { [ws]: { state: 'rollback_pending' } });
    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions[0]?.skipReason).toBe('rollback_pending_forbidden');
  });

  it('refuses (skip) a service_host_owned workspace whose discovery verdict is not authorized', async () => {
    const home = tempHome();
    const ws = missingStateWorkspace(home, 'broken-ws'); // no .pd → degraded verdict
    installSandbox(home, [ws], { [ws]: { state: 'service_host_owned' } });
    let dispatched = 0;
    const adapter = fakeAdapter('codex');
    const counting: WorkerAdapter = { ...adapter, executeOnce: async (input) => { dispatched += 1; return adapter.executeOnce(input); } };

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: counting, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(dispatched).toBe(0);
    expect(result.executions[0]?.skipReason).toMatch(/^workspace_not_authorized:/);
  });

  it('records a service_host_owned workspace with no adapter binding as executed-but-unavailable (never silently dropped)', async () => {
    const home = tempHome();
    const ws = `${home}${path.sep}unbound-ws`;
    mkdirSync(path.join(ws, '.pd'), { recursive: true }); // authorized, but no declaration/claim
    installSandbox(home, [ws], { [ws]: { state: 'service_host_owned' } });
    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    const record = result.executions[0];
    expect(record?.admission).toBe('executed');
    expect(record?.workspaceState).toBe('unavailable');
    expect(record?.skipReason).toMatch(/^no_adapter_supports_workspace:/);
    // NOT the legal-empty shape: a target existed.
    expect(result.status.managed?.emptyReason).toBeUndefined();
  });
});

describe('fail-closed trusted prefix', () => {
  it('refuses the whole run when the manifest is unparsable (marker unreadable ≠ zero workspaces)', async () => {
    const home = tempHome();
    const pdDir = path.join(home, '.pd');
    mkdirSync(pdDir, { recursive: true });
    writeFileSync(path.join(pdDir, 'install.json'), '{ not json', 'utf8');
    writeFileSync(path.join(pdDir, 'active.json'), JSON.stringify(activeRecord()), 'utf8');

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('refused');
    expect(result.reason).toMatch(/^install_manifest_/);
  });

  it('refuses when no active release record exists', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'sh-owned');
    const pdDir = path.join(home, '.pd');
    mkdirSync(pdDir, { recursive: true });
    writeFileSync(path.join(pdDir, 'install.json'), JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex'], workspaces: [ws] }), 'utf8');

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^active_release_/);
  });
});

describe('status contract + progress projection', () => {
  it('records the truthful triggerSource and writes the versioned status document', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'sh-owned');
    const pdDir = installSandbox(home, [ws], { [ws]: { state: 'service_host_owned' } });

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.status.triggerSource).toBe('scheduler');
    expect(result.status.managed?.triggerSource).toBe('scheduler');
    const persisted = JSON.parse(readFileSync(serviceRunStatusPath(pdDir), 'utf8'));
    expect(persisted.schemaVersion).toBe('pd.service-run-status.v1');
    expect(persisted.triggerSource).toBe('scheduler');
    expect(persisted.managed.triggerSource).toBe('scheduler');
    expect(Array.isArray(persisted.managed.executions)).toBe(true);
  });

  it('merges evidenced progress into the cross-run store (carry-forward contract)', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'sh-owned');
    const pdDir = installSandbox(home, [ws], { [ws]: { state: 'service_host_owned' } });
    const progressedAt = '2026-11-22T01:02:03.000Z';

    const first = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex', { taskStateChanged: true, lastProgressAt: progressedAt }), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(first);
    expect(first.executions[0]?.lastProgressAt).toBe(progressedAt);
    const store = JSON.parse(readFileSync(shadowProgressPath(pdDir), 'utf8'));
    expect(JSON.stringify(store)).toContain(progressedAt);

    // Second run without progress keeps the previous value (never the empty
    // cycle's completion time).
    const second = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(second);
    expect(second.executions[0]?.lastProgressAt).toBe(progressedAt);
    expect(second.executions[0]?.lastProgressSource).toBe('previous_run');
  });

  it('isolates an adapter throw to its workspace and keeps the run completed-with-failure', async () => {
    const home = tempHome();
    const wsA = codexWorkspace(home, 'sh-a');
    const wsB = codexWorkspace(home, 'sh-b');
    installSandbox(home, [wsA, wsB], { [wsA]: { state: 'service_host_owned' }, [wsB]: { state: 'service_host_owned' } });

    let calls = 0;
    const throwing: WorkerAdapter = {
      ...fakeAdapter('codex'),
      executeOnce: async (input) => {
        calls += 1;
        if (input.workspaceDir.toLowerCase() === wsA.toLowerCase()) throw new Error('boom Bearer sk-secret-token-123');
        return fakeAdapter('codex').executeOnce(input);
      },
    };

    const result = await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: throwing, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(calls).toBe(2);
    const failedRecord = result.executions.find((e) => e.skipReason !== undefined && e.skipReason.startsWith('adapter_threw:'));
    expect(failedRecord, 'adapter throw recorded with a bounded, sanitized reason').toBeDefined();
    // sanitizeWorkerText redacts bearer tokens (the real contract) and
    // bounds length — not arbitrary prose.
    expect(failedRecord?.skipReason).toContain('<redacted>');
    expect((failedRecord?.skipReason ?? '').length).toBeLessThan(220);
    expect(failedRecord?.workspaceState).toBe('failed');
    const healthy = result.executions.find((e) => e.workspaceState === 'completed');
    expect(healthy, 'the OTHER workspace still completed (FR-07)').toBeDefined();
  });
});

describe('manifest immutability (no handover side effects)', () => {
  it('leaves the install manifest byte-identical after a managed run', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'sh-owned');
    const pdDir = installSandbox(home, [ws], { [ws]: { state: 'service_host_owned' } });
    const manifestFile = path.join(pdDir, 'install.json');
    const before = readFileSync(manifestFile, 'utf8');

    await runServiceManagedOnce({
      triggerSource: 'scheduler',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expect(readFileSync(manifestFile, 'utf8')).toBe(before);
  });
});
