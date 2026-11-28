/**
 * PRI-1278 consolidation: Service Host ownership provisioning.
 *
 * Contract under test (against REAL manifests in a temp PD home, fake CLI
 * replies for the two bounded probes):
 *  - ownership is handed over ONLY when the scheduler is verified enabled
 *    (fail-closed, no companion fallback);
 *  - a Service-Host-only install owns the workspace and truthfully reports
 *    `waiting_for_host_binding` (no fabricated worker);
 *  - ANY prior ownership state — including an explicit legacy_owned record —
 *    is flippable residue: the legacy consumer implementation is deleted
 *    repo-wide, so the provision CAS converges it in one atomic write;
 *  - an upgrade run does NOT flip while the legacy-worker scan names the
 *    workspace or cannot verify quiesce (the one-time switch evidence gate);
 *  - a failed readiness probe leaves ownership untouched;
 *  - the auditable provisioning record is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readWorkspaceBackgroundOwnership } from '@principles/install-layout';
import {
  matchLegacyWorkerArgv,
  matchLegacyWorkerCommandLine,
  parseDarwinProcArgs2,
  parseDarwinArgvReaderOutput,
  parseWindowsCommandLineArgv,
  provisionFreshInstallWorkspace,
  readAllPendingProvisioning,
  readPendingProvisioningEvidence,
  scanRunningLegacyWorkerProcesses,
} from '../src/service-host-provisioning.js';
import type { ServiceHostSchedulerOutcome } from '../src/service-host-bridge.js';

const dirs: string[] = [];
function tempPdHome(): { home: string; pdHome: string; workspaceDir: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'cpd-sh-provision-'));
  dirs.push(home);
  const pdHome = path.join(home, '.pd');
  const workspaceDir = path.join(home, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  return { home, pdHome, workspaceDir };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeInstalledCli(pdHome: string): void {
  const entry = path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '// fixture CLI entry', 'utf8');
}

function seedManifest(pdHome: string, workspaceDir: string): string {
  mkdirSync(pdHome, { recursive: true });
  const manifestPath = path.join(pdHome, 'install.json');
  writeFileSync(manifestPath, JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: [],
    workspaces: [workspaceDir],
  }, null, 2) + '\n', 'utf8');
  return manifestPath;
}

type Reply = { code: number; stdout: string };

/** Fake spawn keyed by the first two non-entry tokens (e.g. "openclaw worker", "service run-once"). */
function fakeSpawn(replies: Record<string, Reply>, calls: string[][], envs: Array<Record<string, string | undefined>> = []): typeof import('node:child_process').spawn {
  const childLike = (reply: Reply): ChildProcess => {
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const stdoutListeners: Array<(chunk: Buffer) => void> = [];
    const on = (event: string, fn: (payload: unknown) => void): void => {
      (listeners[event] ??= []).push(fn);
      if (event === 'close') {
        setTimeout(() => {
          for (const stdoutFn of stdoutListeners) stdoutFn(Buffer.from(reply.stdout, 'utf8'));
          fn(reply.code);
        }, 0);
      }
    };
    return {
      on,
      kill: () => true,
      stdout: { on: (event: string, fn: (chunk: Buffer) => void) => { if (event === 'data') stdoutListeners.push(fn); } },
      stderr: { on: () => undefined },
    } as unknown as ChildProcess;
  };
  return ((_command: string, args: readonly string[], options: { env?: Record<string, string | undefined> }) => {
    const key = `${args[1] ?? ''} ${args[2] ?? ''}`;
    calls.push([...args]);
    envs.push(options.env ?? {});
    return childLike(replies[key] ?? { code: 1, stdout: '{"ok":false,"reason":"unscripted"}' });
  }) as unknown as typeof import('node:child_process').spawn;
}

const ENABLED_SCHEDULER: ServiceHostSchedulerOutcome = {
  state: 'enabled',
  registered: true,
  enabled: true,
  triggerIntervalMs: 120_000,
  nextAction: 'enabled',
  warnings: [],
};

describe('provisionFreshInstallWorkspace', () => {
  it('Service-Host-only: owns the workspace, reports waiting_for_host_binding, runs the first real cycle, writes evidence', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const spawnFn = fakeSpawn({
      'service run-once': {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          schemaVersion: 'pd.service-run-status.v1',
          outcome: 'completed',
          runId: 'run-1',
          managed: { executions: [] },
        }),
      },
    }, calls);

    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: ENABLED_SCHEDULER,
      warn: (m) => { throw new Error(`no warnings expected: ${m}`); },
      probes: { spawnFn },
    });

    expect(outcome.ownership).toBe('service_host_owned');
    expect(outcome.generation).toBe(1);
    expect(outcome.readiness).toBe('waiting_for_host_binding');
    expect(outcome.firstCycle).toMatchObject({ attempted: true, ok: true, outcome: 'completed' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir })).toMatchObject({
      status: 'service_host_owned',
      generation: 1,
    });
    // No readiness probe was fabricated for a host-less install.
    expect(calls.filter((args) => args.includes('worker'))).toHaveLength(0);
    expect(outcome.evidencePath).toBeDefined();
    const evidence = JSON.parse(readFileSync(outcome.evidencePath ?? '', 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 'pd.service-install-provisioning.v1',
      ownership: { before: 'legacy_owned', after: 'service_host_owned', generation: 1 },
      readiness: { status: 'waiting_for_host_binding' },
    });
  });

  it('never hands over ownership when the scheduler is not verified enabled — it records a PENDING marker', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: { ...ENABLED_SCHEDULER, state: 'consent_required', enabled: null },
      warn: () => undefined,
      probes: { spawnFn: fakeSpawn({}, []) },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.pendingProvisioning).toBe(true);
    expect(outcome.firstCycle.attempted).toBe(false);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir })).toEqual({
      status: 'legacy_owned', source: 'no_record', generation: 0,
    });
    // Durable hint for a LATER explicit install; never an ownership authority.
    expect(outcome.evidencePath).toBeDefined();
    const marker = readPendingProvisioningEvidence(pdHome, workspaceDir);
    expect(marker).toMatchObject({ reason: 'scheduler_consent_required' });
    expect(readPendingProvisioningEvidence(pdHome, path.join(pdHome, 'other-ws'))).toBeNull();
  });

  it('flips an upgrade workspace whose explicit legacy_owned record is residue (new CAS semantics)', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = path.join(pdHome, 'install.json');
    mkdirSync(pdHome, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: ['codex'],
      workspaces: [workspaceDir],
      backgroundExecutions: {
        [workspaceDir]: { state: 'legacy_owned', effectiveOwner: 'legacy', generation: 2, operationId: null, previousOwner: null, targetOwner: null, updatedAt: '2026-11-22T00:00:00.000Z' },
      },
    }, null, 2) + '\n', 'utf8');
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, []),
      },
    });
    // The legacy consumer implementation is deleted repo-wide: the record
    // cannot prove a live consumer, so provisioning converges it atomically
    // (generation 2 → 3) instead of refusing.
    expect(outcome.ownership).toBe('service_host_owned');
    expect(outcome.ownershipBefore).toBe('legacy_owned');
    expect(outcome.generation).toBe(3);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toMatchObject({ status: 'service_host_owned', generation: 3 });
  });

  it('an idempotent re-install on an already-owned workspace writes nothing new', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const spawnFn = fakeSpawn({
      'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
    }, []);
    const first = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: { spawnFn },
    });
    expect(first.ownership).toBe('service_host_owned');
    expect(first.generation).toBe(1);

    const second = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: { spawnFn },
    });
    expect(second.ownership).toBe('already_owned');
    expect(second.generation).toBe(1);
    expect(second.pendingProvisioning).not.toBe(true);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toMatchObject({ status: 'service_host_owned', generation: 1 });
  });

  it('a failed readiness probe leaves ownership untouched (no consumer, no silent flip)', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'codex',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'codex worker': { code: 0, stdout: '{"mode":"manual_action_required"}' },
        }, []),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('failed');
    expect(outcome.pendingProvisioning).toBe(true);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'readiness_failed' });
  });

  it('first-cycle evidence counts REAL worker runs and THIS run\'s progress only', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              outcome: 'completed',
              runId: 'run-count',
              managed: {
                executions: [
                  // No adapter → waiting, never "executed".
                  { canonicalDir: workspaceDir, admission: 'executed', hostKind: null, workspaceState: 'waiting_for_host_binding', lastProgressAt: '2026-01-01T00:00:00.000Z', lastProgressSource: 'previous_run' },
                  // Real worker + this run's progress.
                  { canonicalDir: workspaceDir, admission: 'executed', hostKind: 'openclaw', workspaceState: 'completed', execution: { mode: 'ready' }, lastProgressAt: '2026-11-23T00:00:00.000Z', lastProgressSource: 'cycle_evidence' },
                  // Real worker but only a CARRIED timestamp.
                  { canonicalDir: workspaceDir, admission: 'executed', hostKind: 'openclaw', workspaceState: 'completed', execution: { mode: 'ready' }, lastProgressAt: '2026-01-01T00:00:00.000Z', lastProgressSource: 'previous_run' },
                  // A SIBLING workspace's work must not be attributed here.
                  { canonicalDir: path.join(path.dirname(workspaceDir), 'sibling-ws'), admission: 'executed', hostKind: 'openclaw', workspaceState: 'completed', execution: { mode: 'ready' }, lastProgressAt: '2026-11-23T00:00:00.000Z', lastProgressSource: 'cycle_evidence' },
                ],
              },
            }),
          },
        }, []),
      },
    });
    expect(outcome.ownership).toBe('service_host_owned');
    expect(outcome.firstCycle).toMatchObject({ executed: 2, progressed: 1, waitingForBinding: 1 });
  });

  it('host worker probes never receive --pd-home and carry the trusted HOME instead', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const envs: Array<Record<string, string | undefined>> = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","runId":"r","managed":{"executions":[]}}' },
        }, calls, envs),
      },
    });
    expect(outcome.ownership).toBe('service_host_owned');
    const readinessIndex = calls.findIndex((args) => args.includes('--readiness'));
    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    const readinessArgs = calls[readinessIndex] ?? [];
    // The worker command has no --pd-home registration; passing it makes
    // Commander reject the probe (the reviewed defect).
    expect(readinessArgs).not.toContain('--pd-home');
    expect(readinessArgs).toContain('--workspace');
    // Identity travels through the trusted home env.
    expect(envs[readinessIndex]?.HOME).toBe(path.dirname(pdHome));
    expect(envs[readinessIndex]?.USERPROFILE).toBe(path.dirname(pdHome));
    // `pd service run-once` DOES accept --pd-home and still receives it.
    const runOnceIndex = calls.findIndex((args) => args.includes('run-once'));
    expect(calls[runOnceIndex]).toContain('--pd-home');
  });

  it('records EACH deferred workspace independently (multi-host pending registry)', async () => {
    const { home, pdHome, workspaceDir } = tempPdHome();
    const second = path.join(home, 'codex-ws');
    mkdirSync(second, { recursive: true });
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const notEnabled: ServiceHostSchedulerOutcome = { ...ENABLED_SCHEDULER, state: 'consent_required', enabled: null };
    for (const workspace of [workspaceDir, second]) {
      const outcome = await provisionFreshInstallWorkspace({
        pdHome,
        workspaceDir: workspace,
        host: 'none',
        scheduler: notEnabled,
        warn: () => undefined,
        probes: { spawnFn: fakeSpawn({}, []) },
      });
      expect(outcome.pendingProvisioning).toBe(true);
    }
    expect(readAllPendingProvisioning(pdHome).entries.map((entry) => entry.workspaceDir).sort())
      .toEqual([workspaceDir, second].sort());

    // Resuming ONE workspace clears only its own hint.
    const resumed = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, []),
      },
    });
    expect(resumed.ownership).toBe('service_host_owned');
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toBeNull();
    expect(readPendingProvisioningEvidence(pdHome, second)).toMatchObject({
      reason: 'scheduler_consent_required',
      host: 'none',
    });
  });

  it('persists the REAL directory, so a re-pointed link cannot claim a new target on resume', async () => {
    const { home, pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const projectA = path.join(home, 'project-a');
    const projectB = path.join(home, 'project-b');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    const link = path.join(home, 'current');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(projectA, link, linkType);
    } catch {
      // Symlink creation can be policy-restricted; the behavior is covered on
      // platforms where it is permitted (CI Windows creates junctions).
      return;
    }
    await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir: link,
      host: 'none',
      scheduler: { ...ENABLED_SCHEDULER, state: 'consent_required', enabled: null },
      warn: () => undefined,
      probes: { spawnFn: fakeSpawn({}, []) },
    });
    const entry = readAllPendingProvisioning(pdHome).entries[0];
    expect(entry?.workspaceDir).toBe(realpathSync.native(projectA));
    expect(entry?.requestedWorkspaceDir).toBe(link);

    // Re-point the link: the recorded hint still targets project-a.
    unlinkSync(link);
    symlinkSync(projectB, link, linkType);
    expect(readPendingProvisioningEvidence(pdHome, link)).toBeNull();
    expect(readPendingProvisioningEvidence(pdHome, projectB)).toBeNull();
    expect(readPendingProvisioningEvidence(pdHome, projectA)).toMatchObject({
      workspaceDir: realpathSync.native(projectA),
    });
  });

  it('resume refuses to flip ownership when the host binding cannot be verified', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      bindingVerification: {
        ok: false,
        reason: 'openclaw declaration unreadable',
        nextAction: 'Repair the declaration and re-run.',
      },
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
        }, []),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.pendingProvisioning).toBe(true);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'binding_unverifiable' });
  });

  it('one-time switch: a legacy worker process still consuming THIS workspace keeps ownership pending', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'codex',
      scheduler: ENABLED_SCHEDULER,
      legacyWorkerScan: { ok: true, workers: [{ pid: 4242, workspaceDir }] },
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_worker_still_running' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_worker_still_running' });
    // No readiness probe ran: proving the old consumer is gone comes first.
    expect(calls.filter((args) => args.includes('worker'))).toHaveLength(0);
  });

  it('one-time switch: an unverifiable legacy worker scan is fail-closed pending', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'codex',
      scheduler: ENABLED_SCHEDULER,
      legacyWorkerScan: { ok: false, workers: [], detail: 'process table unreadable' },
      warn: () => undefined,
      probes: { spawnFn: fakeSpawn({}, []) },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_worker_still_running' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_worker_still_running' });
  });

  it('one-time switch: a clean scan lets provisioning proceed to service_host_owned', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'codex',
      scheduler: ENABLED_SCHEDULER,
      legacyWorkerScan: { ok: true, workers: [{ pid: 4242, workspaceDir: path.join(os.tmpdir(), 'pd-other-workspace') }] },
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('service_host_owned');
    // Codex answers the no-consume readiness question through `--status`.
    expect(calls.some((args) => args.includes('--status'))).toBe(true);
  });

  it('repeating a scan-blocked provisioning is idempotent and never writes ownership', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await provisionFreshInstallWorkspace({
        pdHome,
        workspaceDir,
        host: 'codex',
        scheduler: ENABLED_SCHEDULER,
        legacyWorkerScan: { ok: true, workers: [{ pid: 4242, workspaceDir }] },
        warn: () => undefined,
        probes: { spawnFn: fakeSpawn({}, []) },
      });
      expect(outcome.ownership).toBe('not_provisioned');
      expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
        .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    }
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_worker_still_running' });
  });
});

describe('scanRunningLegacyWorkerProcesses — real Linux argv scan', () => {
  it.runIf(process.platform === 'linux')('finds a real legacy worker whose workspace path contains spaces, without once/unrelated false positives', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'pd-real-worker-scan-'));
    dirs.push(base);
    const workspaceDir = path.join(base, 'pd legacy worker test', 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const script = path.join(base, 'legacy-worker-fixture.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n', 'utf8');
    const children: ChildProcess[] = [];
    const start = (args: readonly string[]): ChildProcess => {
      const child = spawn(process.execPath, [script, ...args], { stdio: 'ignore', windowsHide: true });
      children.push(child);
      return child;
    };
    const legacy = start(['codex', 'worker', '--workspace', workspaceDir]);
    const once = start(['codex', 'worker', '--once', '--workspace', workspaceDir]);
    const unrelated = start(['unrelated', 'worker', '--workspace', workspaceDir]);
    try {
      // Bounded readiness polling, not a fixed startup sleep: the scan itself
      // is the observation, and slow CI process startup must not become flaky.
      const deadline = Date.now() + 2_000;
      let scan = scanRunningLegacyWorkerProcesses();
      while (!scan.workers.some((worker) => worker.pid === legacy.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        scan = scanRunningLegacyWorkerProcesses();
      }
      expect(scan).toMatchObject({ ok: true });
      const found = scan.workers.find((worker) => worker.pid === legacy.pid);
      expect(found?.workspaceDir).toBe(workspaceDir);
      expect(scan.workers.some((worker) => worker.pid === once.pid)).toBe(false);
      expect(scan.workers.some((worker) => worker.pid === unrelated.pid)).toBe(false);
    } finally {
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
        else child.once('close', () => resolve(undefined));
        setTimeout(() => resolve(undefined), 1000);
      })));
    }
  });

  it('argv matching preserves exact workspace boundaries and requires host + worker shape', () => {
    const workspace = '/tmp/pd legacy worker test/workspace';
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', 'worker', '--workspace', workspace])).toBe(workspace);
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', 'worker', `--workspace=${workspace}`])).toBe(workspace);
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', 'worker', '--once', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', 'worker', '--status', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'openclaw', 'worker', '--readiness', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'openclaw', 'worker', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'unrelated', 'worker', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', 'not-worker', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', '', 'worker', '--workspace', workspace])).toBeNull();
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'worker', 'codex', 'worker', '--workspace', workspace])).toBe(workspace);
    expect(matchLegacyWorkerArgv(['node', 'pd.js', 'codex', 'worker', '--workspace', '--once'])).toBe('--once');
  });

  it('windows command-line tokenization preserves quoted workspace boundaries', () => {
    const windowsWorkspace = 'C:\\pd legacy worker test\\workspace';
    const argv = parseWindowsCommandLineArgv(`"C:\\Program Files\\node\\node.exe" pd.js codex worker --workspace "${windowsWorkspace}"`);
    expect(argv).not.toBeNull();
    expect(argv?.at(-1)).toBe(windowsWorkspace);
    expect(matchLegacyWorkerArgv(argv ?? [])).toBe(windowsWorkspace);
    expect(parseWindowsCommandLineArgv(`node.exe pd.js codex worker --workspace "C:\\path with --once text"`)).toContain('C:\\path with --once text');
  });

  it('a process-table read failure is fail-closed, never an empty scan', () => {
    const scan = scanRunningLegacyWorkerProcesses({
      rows: () => { throw new Error('process table denied'); },
    });
    expect(scan.ok).toBe(false);
    expect(scan.workers).toEqual([]);
    expect(scan.detail).toContain('process table denied');
  });
});

describe('OpenClaw Gateway quiescence evidence gate', () => {
  it('unproven Gateway quiescence blocks before readiness, CAS, and first cycle', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      requireOpenClawGatewayQuiesce: true,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","managed":{"executions":[]}}' },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'openclaw_gateway_unproven' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'openclaw_gateway_unproven' });
    expect(calls).toHaveLength(0);
  });

  it('re-verifies Gateway quiescence immediately before CAS and blocks stale positive evidence', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      requireOpenClawGatewayQuiesce: true,
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited', pid: 4242 },
      openClawGatewayQuiesceFn: () => ({ ok: false, reason: 'gateway listener returned during install' }),
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","managed":{"executions":[]}}' },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('ready');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'openclaw_gateway_unproven' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir })).toMatchObject({ status: 'legacy_owned', generation: 0 });
    expect(calls.some((args) => args.includes('--readiness'))).toBe(true);
    expect(calls.some((args) => args.includes('run-once'))).toBe(false);
  });

  it('a host binding changed during readiness fails closed before CAS and first run-once', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'codex',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      hostBindingReverification: () => ({ ok: true, host: 'openclaw' }),
      probes: {
        spawnFn: fakeSpawn({
          'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","runId":"r","managed":{"executions":[]}}' },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'binding_changed' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir })).toMatchObject({ status: 'legacy_owned', generation: 0 });
    expect(calls.some((args) => args.includes('run-once'))).toBe(false);
  });

  it('re-verifies host binding only after the final asynchronous Gateway probe', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const events: string[] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      warn: () => undefined,
      requireOpenClawGatewayQuiesce: true,
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited', pid: 4242 },
      openClawGatewayQuiesceFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push('gateway');
        return { ok: true, evidence: 'process_exited', pid: 4242 };
      },
      hostBindingReverification: () => {
        events.push('binding');
        return { ok: true, host: 'openclaw' };
      },
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","runId":"r","managed":{"executions":[]}}' },
        }, []),
      },
    });
    expect(outcome.ownership).toBe('service_host_owned');
    expect(events).toEqual(['gateway', 'binding']);
  });

  it('verified Gateway process exit evidence permits readiness, CAS, and first run-once', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      requireOpenClawGatewayQuiesce: true,
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited', pid: 4242 },
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","runId":"r","managed":{"executions":[]}}' },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('service_host_owned');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir })).toMatchObject({ status: 'service_host_owned', generation: 1 });
    expect(calls.some((args) => args.includes('--readiness'))).toBe(true);
    expect(calls.some((args) => args.includes('run-once'))).toBe(true);
  });
});


describe('Darwin KERN_PROCARGS2 argv parsing', () => {
  const darwinPayload = (argv: string[], execPath = '/usr/local/bin/node', env: string[] = ['HOME=/secret']): Buffer => Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeInt32LE(argv.length, 0); return b; })(),
    Buffer.from(`${execPath}\0\0\0${argv.map((arg) => `${arg}\0`).join('')}${env.map((entry) => `${entry}\0`).join('')}`, 'utf8'),
  ]);

  it('preserves exact argv boundaries including workspaces with spaces', () => {
    const argv = ['node', 'pd.js', 'codex', 'worker', '--workspace', '/tmp/pd legacy worker test/workspace'];
    const execPath = '/usr/local/bin/node';
    const payload = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32LE(argv.length, 0); return b; })(),
      Buffer.from(`${execPath}\0\0\0${argv.join('\0')}\0HOME=/secret\0`, 'utf8'),
    ]);
    expect(parseDarwinProcArgs2(payload)).toEqual(argv);
    expect(matchLegacyWorkerArgv(parseDarwinProcArgs2(payload) ?? [])).toBe('/tmp/pd legacy worker test/workspace');
  });

  it('preserves empty interior and trailing argv elements without creating false adjacency', () => {
    const interior = ['node', 'pd.js', 'codex', '', 'worker', '--workspace', '/tmp/workspace'];
    expect(parseDarwinProcArgs2(darwinPayload(interior))).toEqual(interior);
    expect(matchLegacyWorkerArgv(interior)).toBeNull();

    const trailing = ['node', 'pd.js', 'codex', 'worker', '--workspace', '/tmp/workspace', ''];
    expect(parseDarwinProcArgs2(darwinPayload(trailing))).toEqual(trailing);
  });

  it('returns null for malformed/truncated payloads rather than guessing', () => {
    expect(parseDarwinProcArgs2(Buffer.alloc(2))).toBeNull();
    const bad = Buffer.alloc(4);
    bad.writeInt32LE(4, 0);
    expect(parseDarwinProcArgs2(Buffer.concat([bad, Buffer.from('/bin/node\0node\0', 'utf8')]))).toBeNull();

    const missingFinalNul = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeInt32LE(3, 0); return b; })(),
      Buffer.from('/usr/local/bin/node\0\0\0node\0pd.js\0codex', 'utf8'),
    ]);
    expect(parseDarwinProcArgs2(missingFinalNul)).toBeNull();
  });

  it('reader output round-trips raw hex exactly, skips exited rows, and fails closed for unreadable rows', () => {
    const argv = ['node', 'pd.js', 'codex', 'worker', '--workspace', '/tmp/pd legacy worker test/workspace', ''];
    const hex = darwinPayload(argv).toString('hex');
    const rows = parseDarwinArgvReaderOutput(`4242\t${hex}\n4243\tEXITED\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 4242, argv });
    expect(() => parseDarwinArgvReaderOutput('4244\tERROR:EPERM:1\n')).toThrow(/unverifiable/);
    expect(() => parseDarwinArgvReaderOutput('not-a-row\n')).toThrow(/unverifiable/);
    expect(parseDarwinArgvReaderOutput('4245\tEXITED\n')).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('real Windows legacy worker scan', () => {
  it('finds a same-user child worker with a workspace containing spaces and excludes --once', { timeout: 20_000 }, async () => {
    const workspace = path.join(os.tmpdir(), `pd windows worker test ${process.pid}`);
    mkdirSync(workspace, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'codex', 'worker', '--workspace', workspace], { stdio: 'ignore', windowsHide: true });
    const once = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'codex', 'worker', '--once', '--workspace', workspace], { stdio: 'ignore', windowsHide: true });
    try {
      const deadline = Date.now() + 12_000;
      let scan = scanRunningLegacyWorkerProcesses({ platform: 'win32' });
      while (!scan.workers.some((worker) => worker.pid === child.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        scan = scanRunningLegacyWorkerProcesses({ platform: 'win32' });
      }
      expect(scan.ok, scan.detail ?? 'no scan detail').toBe(true);
      expect(scan.workers).toContainEqual({ pid: child.pid, workspaceDir: workspace });
      expect(scan.workers.some((worker) => worker.pid === once.pid)).toBe(false);
    } finally {
      child.kill();
      once.kill();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe.runIf(process.platform === 'darwin')('real Darwin legacy worker scan', () => {
  it('finds a real child worker with a workspace containing spaces and excludes --once', async () => {
    const workspace = path.join(os.tmpdir(), `pd darwin worker test ${process.pid}`);
    mkdirSync(workspace, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'codex', 'worker', '--workspace', workspace], { stdio: 'ignore' });
    const once = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'codex', 'worker', '--once', '--workspace', workspace], { stdio: 'ignore' });
    // Python exposes raw POSIX fork without a runtime subprocess manager that
    // opportunistically reaps children. The forked child exits immediately and
    // the parent never wait()s, leaving real process-table zombie residue while
    // the active worker keeps running. (Ruby fork/spawn proved unreliable here:
    // its runtime may reap the child before the assertion.) The scan must
    // classify that residue as exited rather than failing the whole machine
    // scan on the zombie's unreadable KERN_PROCARGS2 payload.
    const zombieParent = spawn('/usr/bin/python3', ['-c', 'import os,time\npid=os.fork()\nif pid == 0:\n os._exit(0)\ntime.sleep(60)'], { stdio: 'ignore' });
    try {
      const zombieDeadline = Date.now() + 5_000;
      let zombieSeen = false;
      while (!zombieSeen && Date.now() < zombieDeadline) {
        const ps = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat='], { encoding: 'utf8' });
        zombieSeen = ps.split('\n').some((line) => {
          const parts = line.trim().split(/\s+/);
          return Number.parseInt(parts[1] ?? '', 10) === zombieParent.pid && (parts[2] ?? '').startsWith('Z');
        });
        if (!zombieSeen) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(zombieSeen, zombieParent.pid === undefined ? 'zombie parent did not start' : `no zombie child observed for parent pid ${zombieParent.pid}`).toBe(true);
      const deadline = Date.now() + 2_000;
      let scan = scanRunningLegacyWorkerProcesses({ platform: 'darwin' });
      while (!scan.workers.some((worker) => worker.pid === child.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        scan = scanRunningLegacyWorkerProcesses({ platform: 'darwin' });
      }
      expect(scan.ok, scan.detail ?? 'no scan detail').toBe(true);
      expect(scan.workers).toContainEqual({ pid: child.pid, workspaceDir: workspace });
      expect(scan.workers.some((worker) => worker.pid === once.pid)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      once.kill('SIGKILL');
      zombieParent.kill('SIGKILL');
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it('treats a process that becomes a zombie after enumeration as exited residue', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-darwin-zombie-race-'));
    const pidFile = path.join(dir, 'child.pid');
    const parent = spawn('/usr/bin/python3', [
      '-c',
      'import os,time,sys\npid=os.fork()\nif pid == 0:\n os.execl("/bin/sh", "sh", "-c", "sleep 60")\nwith open(sys.argv[1], "w") as f:\n f.write(str(pid))\ntime.sleep(60)',
      pidFile,
    ], { stdio: 'ignore' });
    let childPid: number | undefined;
    try {
      const deadline = Date.now() + 2_000;
      while (!existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(pidFile), 'zombie-race child pid file was not written').toBe(true);
      childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
      expect(Number.isInteger(childPid) && childPid > 1).toBe(true);
      let hookRan = false;
      const scan = scanRunningLegacyWorkerProcesses({
        platform: 'darwin',
        afterDarwinEnumeration: () => {
          hookRan = true;
          if (childPid !== undefined) process.kill(childPid, 'SIGKILL');
        },
      });
      expect(hookRan).toBe(true);
      expect(scan.ok, scan.detail ?? 'no scan detail').toBe(true);
    } finally {
      if (childPid !== undefined) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already dead or reaped */ }
      }
      parent.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
