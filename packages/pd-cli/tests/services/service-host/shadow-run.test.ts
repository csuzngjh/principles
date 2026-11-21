/**
 * The Phase 2 shadow coordinator (task §9 admission boundary + task §10
 * status + task §6 carry-forward): explicit-selection requirement, the
 * admission gate chain (authorized discovery → legacy-owned owner
 * projection → adapter binding), lastProgressAt carry-forward across runs,
 * per-workspace failure isolation, persisted status contract, and the
 * no-handover evidence (manifest bytes identical, no scheduler side
 * effects).
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runServiceShadowOnce, type ShadowRunResult } from '../../../src/services/service-host/shadow-run.js';
import { runServiceRunOnce } from '../../../src/services/service-host/run-once.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';
import { shadowProgressPath } from '../../../src/services/service-host/shadow-progress-store.js';
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

/** A valid persisted host-tool declaration (the saveHostToolDeclaration payload shape). */
function validDeclaration(hostKind: string): Record<string, unknown> {
  return {
    version: 2,
    hostKind,
    mappings: [{ rawToolName: 'Read', canonicalKind: 'read' }],
    declaredAt: '2026-11-21T00:00:00.000Z',
  };
}

/** A codex-bound workspace: .pd dir + VALID host-tool declaration (binding evidence). */
function codexWorkspace(home: string, name: string): string {
  const ws = path.join(home, name);
  const semanticsDir = path.join(ws, '.pd', 'host-tool-semantics');
  mkdirSync(semanticsDir, { recursive: true });
  const declaration = path.join(semanticsDir, 'codex.json');
  writeFileSync(declaration, JSON.stringify(validDeclaration('codex')), 'utf8');
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
    writeFileSync(wbDeclaration, JSON.stringify(validDeclaration('workbuddy')), 'utf8');
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

describe('F1: shadow resolves host roots from the trusted home only', () => {
  it('inherited CODEX_HOME / WORKBUDDY_CONFIG_DIR overrides cannot steer discovery, and are recorded as ignored', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'canonical-ws');
    const fakeCodexHome = tempHome('pd-sh-evil-codex-');
    const fakeWbConfig = tempHome('pd-sh-evil-wb-');
    installSandbox(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      env: { CODEX_HOME: fakeCodexHome, WORKBUDDY_CONFIG_DIR: fakeWbConfig },
      probes: { adapters: { codex: fakeAdapter('codex', { outcome: 'cycle_completed', lastProgressAt: '2026-11-21T11:00:00Z', taskStateChanged: true }), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    const isolation = result.status.environmentIsolation;
    // The fake overrides were inherited but did NOT steer anything.
    expect(isolation.inheritedHostRootEnvVars).toContain('CODEX_HOME');
    expect(isolation.inheritedHostRootEnvVars).toContain('WORKBUDDY_CONFIG_DIR');
    expect(isolation.ignoredHostRootEnvVars).toContain('CODEX_HOME');
    expect(isolation.ignoredHostRootEnvVars).toContain('WORKBUDDY_CONFIG_DIR');
    // Host-root reports name the trusted-home defaults (source 'default'),
    // never the inherited fake roots.
    const codexRoot = result.status.discovery.hostRoots.find((r) => r.host === 'codex');
    expect(codexRoot?.source).toBe('default');
    expect(codexRoot?.root).toBe(path.join(home, '.codex'));
    expect(codexRoot?.root).not.toBe(fakeCodexHome);
    const wbRoot = result.status.discovery.hostRoots.find((r) => r.host === 'workbuddy');
    expect(wbRoot?.root).toBe(path.join(home, '.workbuddy'));
    expect(wbRoot?.root).not.toBe(fakeWbConfig);
  });
});

describe('F2: invalid host-tool declarations are not binding evidence', () => {
  it('a garbage same-named declaration file does NOT admit the adapter (claims still can)', async () => {
    const home = tempHome();
    const ws = path.join(home, 'forged-decl-ws');
    mkdirSync(path.join(ws, '.pd', 'host-tool-semantics'), { recursive: true });
    // A same-named file that is NOT a valid declaration (no mappings, no version).
    const forged = path.join(ws, '.pd', 'host-tool-semantics', 'codex.json');
    writeFileSync(forged, 'definitely not a declaration', 'utf8');
    installSandbox(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    // No valid claim either → refused; the forged file grants nothing.
    expect(result.executions[0]?.admission).toBe('refused');
    expect(result.executions[0]?.refusalReason).toContain('no_adapter_supports_workspace');
  });
});

describe('F6: the cross-run progress projection survives A→B→A and dry-runs', () => {
  it('progress recorded for A survives an intervening B run and a dry-run, and a later empty A cycle keeps it', async () => {
    const home = tempHome();
    const wsA = codexWorkspace(home, 'carry-a');
    const wsB = codexWorkspace(home, 'carry-b');
    const pdHome = installSandbox(home, [wsA, wsB]);
    const adapters = {
      codex: fakeAdapter('codex'),
      workbuddy: fakeAdapter('workbuddy'),
    };
    // Run 1: A makes real progress at 08:00.
    const runA1 = await runServiceShadowOnce({
      workspaces: [wsA],
      trustedHomeDir: home,
      probes: { adapters: { ...adapters, codex: fakeAdapter('codex', { outcome: 'cycle_completed', lastProgressAt: '2026-11-21T08:00:00Z', taskStateChanged: true }) } },
    });
    expectCompleted(runA1);
    expect(runA1.executions[0]?.lastProgressSource).toBe('task_state_change');
    // Run 2: B alone (its own empty cycle).
    const runB = await runServiceShadowOnce({
      workspaces: [wsB],
      trustedHomeDir: home,
      probes: { adapters },
    });
    expectCompleted(runB);
    expect(runB.executions[0]?.lastProgressAt).toBeNull();
    // Run 3: a DRY-RUN replaces the status file with no shadow section —
    // the projection must be untouched by it.
    const dry = runServiceRunOnce({ env: {}, trustedHomeDir: home });
    expect(dry.ok && dry.outcome === 'completed').toBe(true);
    // Run 4: A again, EMPTY cycle — the 08:00 value survives.
    const runA2 = await runServiceShadowOnce({
      workspaces: [wsA],
      trustedHomeDir: home,
      probes: { adapters },
    });
    expectCompleted(runA2);
    expect(runA2.executions[0]?.lastProgressAt).toBe('2026-11-21T08:00:00Z');
    expect(runA2.executions[0]?.lastProgressSource).toBe('previous_run');
    // The projection file exists under the PD-owned service dir.
    expect(existsSync(shadowProgressPath(pdHome))).toBe(true);
    // ...and its schema is the versioned v1.
    const store = JSON.parse(readFileSync(shadowProgressPath(pdHome), 'utf8')) as { schemaVersion: string; entries: Record<string, unknown> };
    expect(store.schemaVersion).toBe('pd.shadow-progress.v1');
    expect(Object.keys(store.entries).length).toBeGreaterThanOrEqual(1);
  });

  it('R3: a corrupt store fails the merge with recovery guidance and preserves the ORIGINAL file byte-for-byte', async () => {
    const home = tempHome();
    const wsC = codexWorkspace(home, 'fresh-progress-ws');
    const pdHome = installSandbox(home, [wsC]);
    const storeFile = shadowProgressPath(pdHome);
    mkdirSync(path.dirname(storeFile), { recursive: true });
    // One VALID old entry + one INVALID old entry — the whole file reads
    // corrupt, but it still carries recoverable history for other workspaces.
    const original = `${JSON.stringify({
      schemaVersion: 'pd.shadow-progress.v1',
      entries: {
        '/valid/old-ws': { lastProgressAt: '2026-11-20T08:00:00Z', source: 'task_state_change', updatedAt: '2026-11-20T08:00:00Z' },
        '/invalid/old-ws': { bogus: true },
      },
    }, null, 2)}\n`;
    writeFileSync(storeFile, original, 'utf8');
    const result = await runServiceShadowOnce({
      workspaces: [wsC],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex', { outcome: 'cycle_completed', lastProgressAt: '2026-11-21T13:00:00Z', taskStateChanged: true }), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    // This run's own progress is still reported truthfully via the status…
    expect(result.executions[0]?.lastProgressAt).toBe('2026-11-21T13:00:00Z');
    expect(result.status.shadow?.progressCarryVerdict).toBe('corrupt');
    // …the merge failure is surfaced with guidance…
    expect(result.status.nextAction).toContain('progress projection could not be updated');
    // …and the file was NOT replaced by a this-run-only projection.
    expect(readFileSync(storeFile, 'utf8')).toBe(original);
  });

  it('a corrupt projection store degrades observably (progressCarryVerdict) without deleting the file', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'corrupt-carry-ws');
    const pdHome = installSandbox(home, [ws]);
    // A pre-existing corrupt store.
    const storeFile = shadowProgressPath(pdHome);
    mkdirSync(path.dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, '{ this is: not: json', 'utf8');
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(result.status.shadow?.progressCarryVerdict).toBe('corrupt');
    expect(result.executions[0]?.lastProgressAt).toBeNull();
    // Preservation over cleanup: the corrupt file is still there.
    expect(existsSync(storeFile)).toBe(true);
  });
});

describe('R2: an interrupt stops the dispatch queue, not just the in-flight worker', () => {
  it('abort during workspace A prevents workspace B from ever dispatching; executed results + status + lock settle', async () => {
    const home = tempHome();
    const wsA = codexWorkspace(home, 'abort-a');
    const wsB = codexWorkspace(home, 'abort-b');
    installSandbox(home, [wsA, wsB]);
    const controller = new AbortController();
    let bDispatched = 0;
    const abortingCodex: WorkerAdapter = {
      hostKind: 'codex',
      adapterVersion: WORKER_ADAPTER_CONTRACT_VERSION,
      supports: () => ({ supported: true }),
      executeOnce: async (input) => {
        if (input.workspaceDir === path.resolve(wsB)) bDispatched += 1;
        controller.abort(); // the interrupt lands while A is in flight
        return fakeAdapter('codex', { outcome: 'cancelled' }).executeOnce(input);
      },
    };
    const result = await runServiceShadowOnce({
      workspaces: [wsA, wsB],
      trustedHomeDir: home,
      signal: controller.signal,
      probes: { adapters: { codex: abortingCodex, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    // Exactly ONE dispatch happened — B's Worker was never started.
    expect(bDispatched).toBe(0);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.execution?.cycleOutcome).toBe('cancelled');
    expect(result.executions[0]?.workspaceState).toBe('failed');
    // The persisted status is truthful: only A's (cancelled) execution exists.
    const persisted = JSON.parse(readFileSync(serviceRunStatusPath(path.join(home, '.pd')), 'utf8')) as { shadow?: { executions?: unknown[] } };
    expect(persisted.shadow?.executions).toHaveLength(1);
    // The install lock was released — a fresh run can acquire it immediately.
    const rerun = await runServiceShadowOnce({
      workspaces: [wsA],
      trustedHomeDir: home,
      probes: { adapters: { codex: fakeAdapter('codex'), workbuddy: fakeAdapter('workbuddy') } },
    });
    expect(rerun.ok && rerun.outcome === 'completed').toBe(true);
  });

  it('a signal aborted before the run starts dispatches nothing at all', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'pre-aborted-ws');
    installSandbox(home, [ws]);
    const controller = new AbortController();
    controller.abort();
    let dispatched = 0;
    const counting = fakeAdapter('codex');
    const spy: WorkerAdapter = {
      ...counting,
      executeOnce: async (input) => {
        dispatched += 1;
        return counting.executeOnce(input);
      },
    };
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      signal: controller.signal,
      probes: { adapters: { codex: spy, workbuddy: fakeAdapter('workbuddy') } },
    });
    expectCompleted(result);
    expect(dispatched).toBe(0);
    expect(result.executions).toHaveLength(0);
  });
});

describe('F7: a degraded cycle with real task progress carries the evidenced timestamp', () => {
  it('degraded outcome + taskStateChanged → lastProgressAt recorded as task_state_change', async () => {
    const home = tempHome();
    const ws = codexWorkspace(home, 'degraded-progress-ws');
    installSandbox(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      trustedHomeDir: home,
      probes: {
        adapters: {
          codex: fakeAdapter('codex', { outcome: 'degraded', lastProgressAt: '2026-11-21T12:00:00Z', taskStateChanged: true }),
          workbuddy: fakeAdapter('workbuddy'),
        },
      },
    });
    expectCompleted(result);
    expect(result.executions[0]?.workspaceState).toBe('degraded');
    expect(result.executions[0]?.lastProgressAt).toBe('2026-11-21T12:00:00Z');
    expect(result.executions[0]?.lastProgressSource).toBe('task_state_change');
  });
});
