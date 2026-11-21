/**
 * The Phase 2 shadow coordinator (task §9 admission boundary + task §10
 * status + task §6 carry-forward): explicit-selection requirement, the
 * admission gate chain (authorized discovery → legacy-owned owner
 * projection → adapter binding), lastProgressAt carry-forward across runs,
 * per-workspace failure isolation, persisted status contract, and the
 * no-handover evidence (manifest bytes identical, no scheduler side
 * effects).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runServiceShadowOnce, type ShadowRunResult } from '../../../src/services/service-host/shadow-run.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';
import type { AdapterCycleResult, WorkerAdapter, WorkspaceDescriptor, AdapterSupport } from '../../../src/services/service-host/worker-adapter.js';
import { WORKER_ADAPTER_CONTRACT_VERSION } from '../../../src/services/service-host/worker-adapter.js';

const dirs: string[] = [];
function tempHome(prefix = 'pd-sh-shadow-'): string {
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
    releaseId: 'bundled-9.9.9-shadow',
    releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null,
    transactionId: 'txn-shadow-1',
    productVersion: '9.9.9',
  };
}

/** Write a sandbox install: manifest + authoritative active record. */
function installSandbox(home: string, workspaces: string[], manifestExtra: Record<string, unknown> = {}): string {
  const pdDir = path.join(home, '.pd');
  mkdirSync(pdDir, { recursive: true });
  const manifestFile = path.join(pdDir, 'install.json');
  const activeFile = path.join(pdDir, 'active.json');
  writeFileSync(manifestFile, JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex', 'workbuddy'], workspaces, ...manifestExtra }), 'utf8');
  writeFileSync(activeFile, JSON.stringify(activeRecord()), 'utf8');
  return pdDir;
}

/** A codex-bound workspace: .pd dir + host-tool declaration (binding evidence). */
function codexWorkspace(home: string, name: string): string {
  const ws = path.join(home, name);
  const semanticsDir = path.join(ws, '.pd', 'host-tool-semantics');
  mkdirSync(semanticsDir, { recursive: true });
  const declaration = path.join(semanticsDir, 'codex.json');
  writeFileSync(declaration, JSON.stringify({ hostKind: 'codex' }), 'utf8');
  return ws;
}

function fakeAdapter(hostKind: 'codex' | 'workbuddy', overrides: {
  outcome?: AdapterCycleResult['cycleOutcome'];
  lastProgressAt?: string | null;
  taskStateChanged?: boolean;
  throw?: Error;
  support?: AdapterSupport;
} = {}): WorkerAdapter {
  return {
    hostKind,
    adapterVersion: WORKER_ADAPTER_CONTRACT_VERSION,
    supports: (descriptor: WorkspaceDescriptor) => overrides.support ?? {
      supported:
        descriptor.discoveryVerdict === 'authorized'
        && (descriptor.claimingHosts.includes(hostKind) || descriptor.declaredHostKinds.includes(hostKind)),
    },
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

function expectCompleted(result: ShadowRunResult): asserts result is Extract<ShadowRunResult, { outcome: 'completed' }> {
  if (!result.ok || result.outcome !== 'completed') {
    throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 400)}`);
  }
}

describe('mode gate (task §9: explicit, default-off)', () => {
  it('refuses without explicit --workspace selections', async () => {
    const result = await runServiceShadowOnce({ workspaces: [], trustedHomeDir: tempHome() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shadow_requires_explicit_workspace');
  });
});

describe('admission gates', () => {
  it('a path outside authorized discovery is refused, not executed', async () => {
    const home = tempHome();
    installSandbox(home, []);
    const result = await runServiceShadowOnce({
      workspaces: [path.join(home, 'nowhere')],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.admission).toBe('refused');
    expect(result.executions[0]?.refusalReason).toBe('workspace_not_in_authorized_discovery');
    expect(result.executions[0]?.workspaceState).toBe('unavailable');
    const statusFile = serviceRunStatusPath(path.join(home, '.pd'));
    const persisted = JSON.parse(readFileSync(statusFile, 'utf8')) as { shadow?: { executions?: { admission: string }[] } };
    expect(persisted.shadow?.executions?.[0]?.admission).toBe('refused');
  });

  it('a non-legacy owner marker (handover in flight) refuses the shadow run (Phase 2 never touches it)', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'owned-ws');
    const pdHome = installSandbox(home, [ws], {
      backgroundExecutions: {
        [path.resolve(ws)]: {
          state: 'handover_preparing',
          effectiveOwner: 'legacy',
          generation: 3,
          operationId: 'op-fixture-1',
          previousOwner: 'legacy',
          targetOwner: 'service_host',
          updatedAt: '2026-11-20T00:00:00Z',
        },
      },
    });
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions[0]?.admission).toBe('refused');
    expect(result.executions[0]?.refusalReason).toContain('shadow_requires_legacy_owned_workspace');
    // The owner marker was NOT modified (no handover evidence tampering).
    const manifestAfter = readFileSync(path.join(pdHome, 'install.json'), 'utf8');
    expect(manifestAfter).toContain('handover_preparing');
  });

  it('a workspace with NO adapter binding evidence is refused', async () => {
    const home = tempHome();
    const ws = path.join(home, 'unbound-ws');
    mkdirSync(path.join(ws, '.pd'), { recursive: true });
    installSandbox(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions[0]?.admission).toBe('refused');
    expect(result.executions[0]?.refusalReason).toContain('no_adapter_supports_workspace');
  });

  it('hostFilter restricts execution to the selected adapter', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'both-bound');
    mkdirSync(path.join(ws, '.pd', 'host-tool-semantics'), { recursive: true });
    const wbDeclaration = path.join(ws, '.pd', 'host-tool-semantics', 'workbuddy.json');
    writeFileSync(wbDeclaration, JSON.stringify({ hostKind: 'workbuddy' }), 'utf8');
    installSandbox(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      hostFilter: 'workbuddy',
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.hostKind).toBe('workbuddy');
  });
});

describe('execution + status (task §10) + carry-forward (task §6)', () => {
  it('an admitted cycle persists the shadow section and leaves the manifest bytes identical (no handover)', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'good-ws');
    const pdHome = installSandbox(home, [ws]);
    const manifestBefore = readFileSync(path.join(pdHome, 'install.json'), 'utf8');
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex', { outcome: 'cycle_completed', lastProgressAt: '2026-11-21T08:00:00Z', taskStateChanged: true }), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions[0]?.admission).toBe('admitted');
    expect(result.executions[0]?.workspaceState).toBe('completed');
    expect(result.executions[0]?.lastProgressAt).toBe('2026-11-21T08:00:00Z');
    expect(result.executions[0]?.lastProgressSource).toBe('task_state_change');
    const statusFile = serviceRunStatusPath(pdHome);
    const persisted = JSON.parse(readFileSync(statusFile, 'utf8')) as {
      schemaVersion: string;
      dryRun: boolean;
      shadow?: { executions?: { cycleOutcome?: string }[] };
    };
    expect(persisted.schemaVersion).toBe('pd.service-run-status.v1');
    expect(persisted.dryRun).toBe(false);
    expect(persisted.shadow?.executions?.[0]?.execution?.cycleOutcome).toBe('cycle_completed');
    // NO handover: the manifest is byte-identical after the run.
    expect(readFileSync(path.join(pdHome, 'install.json'), 'utf8')).toBe(manifestBefore);
  });

  it('an empty cycle KEEPS the previous run\'s lastProgressAt (never the completion time)', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'carry-ws');
    const pdHome = installSandbox(home, [ws]);
    // Run 1: real progress recorded.
    await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex', { outcome: 'cycle_completed', lastProgressAt: '2026-11-21T08:00:00Z', taskStateChanged: true }), workbuddy: fakeAdapter('workbuddy') } },
    });
    // Run 2: empty cycle — the previous timestamp survives.
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions[0]?.execution?.cycleOutcome).toBe('cycle_completed_without_business_progress');
    expect(result.executions[0]?.lastProgressAt).toBe('2026-11-21T08:00:00Z');
    expect(result.executions[0]?.lastProgressSource).toBe('previous_run');
    const statusFile = serviceRunStatusPath(pdHome);
    const persisted = JSON.parse(readFileSync(statusFile, 'utf8')) as { shadow?: { executions?: { lastProgressAt?: string; lastProgressSource?: string }[] } };
    expect(persisted.shadow?.executions?.[0]?.lastProgressAt).toBe('2026-11-21T08:00:00Z');
    expect(persisted.shadow?.executions?.[0]?.lastProgressSource).toBe('previous_run');
  });

  it('one workspace failing does not block the other (FR-07 isolation)', async () => {
    const home = tempHome();
    const bad = codexWorkspace(home, 'bad-ws');
    const good = codexWorkspace(home, 'good-ws2');
    installSandbox(home, [bad, good]);
    const goodAdapter = fakeAdapter('codex', { outcome: 'cycle_completed', lastProgressAt: '2026-11-21T09:00:00Z', taskStateChanged: true });
    const result = await runServiceShadowOnce({
      workspaces: [bad, good],
      trustedHomeDir: home,
      probes: {
        adapters: {
          codex: {
            // Same adapter for both workspaces: throws for one, succeeds for the other.
            hostKind: 'codex',
            adapterVersion: WORKER_ADAPTER_CONTRACT_VERSION,
            supports: () => ({ supported: true }),
            executeOnce: async (input) => {
              if (input.workspaceDir === path.resolve(bad)) throw new Error('fixture adapter explosion');
              return goodAdapter.executeOnce(input);
            },
          },
          workbuddy: fakeAdapter('workbuddy'),
        },
      },
    });
    expectCompleted(result);
    const byDir = new Map(result.executions.map((e) => [path.resolve(e.requestedDir), e]));
    expect(byDir.get(path.resolve(bad))?.workspaceState).toBe('failed');
    expect(byDir.get(path.resolve(bad))?.refusalReason).toContain('adapter_threw');
    expect(byDir.get(path.resolve(good))?.workspaceState).toBe('completed');
  });

  it('a paused cycle keeps the previous progress absent and reports workspaceState paused', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'paused-ws');
    installSandbox(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex', { outcome: 'paused' }), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.executions[0]?.workspaceState).toBe('paused');
    expect(result.executions[0]?.lastProgressAt).toBeNull();
  });
});
