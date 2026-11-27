/**
 * PRI-1278 Phase 5: fresh-install ownership provisioning.
 *
 * Contract under test (against REAL manifests in a temp PD home, fake CLI
 * replies for the two bounded probes):
 *  - ownership is handed over ONLY when the scheduler is verified enabled;
 *  - a Service-Host-only install owns the workspace and truthfully reports
 *    `waiting_for_host_binding` (no fabricated worker);
 *  - an existing ownership record is NEVER overwritten (upgrades use handover);
 *  - a failed readiness probe leaves ownership untouched;
 *  - the auditable provisioning record is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { readWorkspaceBackgroundOwnership } from '@principles/install-layout';
import { provisionFreshInstallWorkspace, readAllPendingProvisioning, readPendingProvisioningEvidence } from '../src/service-host-provisioning.js';
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

  it('refuses an upgrade workspace that already carries an ownership record', async () => {
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
      probes: { spawnFn: fakeSpawn({}, []) },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toMatchObject({ status: 'legacy_owned', source: 'record', generation: 2 });
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
      resume: true,
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

  it('resume refuses to flip while a legacy OpenClaw Gateway may still consume the workspace', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: {
        gatewayRunning: () => true,
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_running' });
    // No readiness probe ran: proving the legacy consumer is gone comes first.
    expect(calls.filter((args) => args.includes('worker'))).toHaveLength(0);
  });

  it('resume probes the VERIFIED host when no legacy Gateway is running', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    seedManifest(pdHome, workspaceDir);
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'openclaw',
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: {
        gatewayRunning: () => false,
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });
    expect(outcome.ownership).toBe('service_host_owned');
    expect(calls.some((args) => args.includes('--readiness'))).toBe(true);
  });

  async function seedDeferredPending(pdHome: string, workspaceDir: string, host: 'codex' | 'workbuddy' | 'all'): Promise<void> {
    const initial = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host,
      scheduler: { ...ENABLED_SCHEDULER, state: 'consent_required', enabled: null },
      warn: () => undefined,
      probes: { spawnFn: fakeSpawn({}, []) },
    });
    expect(initial.pendingProvisioning).toBe(true);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({
      host,
      reason: 'scheduler_consent_required',
    });
  }

  it.each(['codex', 'workbuddy'] as const)('deferred %s resume with a potentially active legacy consumer is blocked before readiness and CAS', async (host) => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    await seedDeferredPending(pdHome, workspaceDir, host);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host,
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          [`${host} worker`]: { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });

    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_consumer_unproven' });
    expect(outcome.pendingProvisioning).toBe(true);
    expect(outcome.nextAction.startsWith('controlled_handover:')).toBe(true);
    expect(outcome.evidencePath).toBeDefined();
    const evidence = JSON.parse(readFileSync(outcome.evidencePath ?? '', 'utf8')) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      schemaVersion: 'pd.service-install-provisioning.v1',
      pendingProvisioning: true,
      pendingReason: 'legacy_consumer_unproven',
      readiness: { status: 'skipped' },
      ownership: { before: 'legacy_owned', after: 'legacy_owned', generation: 0 },
    });
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_unproven' });
    expect(calls.filter((args) => args.includes('worker') || args.includes('run-once'))).toHaveLength(0);
  });

  it.each(['codex', 'workbuddy'] as const)('deferred %s resume with unknown legacy consumer status is blocked before readiness and CAS', async (host) => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    await seedDeferredPending(pdHome, workspaceDir, host);
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host,
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: { spawnFn: fakeSpawn({}, calls) },
    });

    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_consumer_unproven' });
    expect(outcome.nextAction).toContain('controlled_handover');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_unproven' });
    expect(calls).toHaveLength(0);
  });

  it('a deferred Codex pending marker cannot be bypassed when the current binding resolves to none', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    await seedDeferredPending(pdHome, workspaceDir, 'codex');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'none',
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });

    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_consumer_unproven' });
    expect(outcome.nextAction).toContain('controlled_handover');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_unproven' });
    expect(calls.filter((args) => args.includes('worker') || args.includes('run-once'))).toHaveLength(0);
  });

  it('deferred host=all resume cannot bypass the Codex/WorkBuddy legacy-consumer guard', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    await seedDeferredPending(pdHome, workspaceDir, 'all');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    let gatewayProbes = 0;
    const outcome = await provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'all',
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: {
        gatewayRunning: () => {
          gatewayProbes += 1;
          return false;
        },
        spawnFn: fakeSpawn({
          'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
          'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });

    expect(gatewayProbes).toBe(1);
    expect(outcome.ownership).toBe('not_provisioned');
    expect(outcome.readiness).toBe('skipped');
    expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_consumer_unproven' });
    expect(outcome.nextAction).toContain('controlled_handover');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_unproven' });
    expect(calls.filter((args) => args.includes('worker') || args.includes('run-once'))).toHaveLength(0);
  });

  it('a non-deferred Codex fresh install keeps the existing provisioning behavior', async () => {
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
      probes: {
        spawnFn: fakeSpawn({
          'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });

    expect(outcome.ownership).toBe('service_host_owned');
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toMatchObject({ status: 'service_host_owned', generation: 1 });
    expect(calls.some((args) => args.includes('--status'))).toBe(true);
  });

  it('concurrent blocked deferred resumes never race into an ownership write', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    await seedDeferredPending(pdHome, workspaceDir, 'codex');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    const runResume = () => provisionFreshInstallWorkspace({
      pdHome,
      workspaceDir,
      host: 'codex',
      scheduler: ENABLED_SCHEDULER,
      resume: true,
      warn: () => undefined,
      probes: {
        spawnFn: fakeSpawn({
          'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
          'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: 'r', managed: { executions: [] } }) },
        }, calls),
      },
    });
    const [first, second] = await Promise.all([runResume(), runResume()]);

    for (const outcome of [first, second]) {
      expect(outcome.ownership).toBe('not_provisioned');
      expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_consumer_unproven' });
    }
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_unproven' });
    expect(calls.filter((args) => args.includes('worker') || args.includes('run-once'))).toHaveLength(0);
  });

  it('repeating a blocked deferred resume is idempotent and still never writes ownership', async () => {
    const { pdHome, workspaceDir } = tempPdHome();
    fakeInstalledCli(pdHome);
    const manifestPath = seedManifest(pdHome, workspaceDir);
    await seedDeferredPending(pdHome, workspaceDir, 'codex');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const calls: string[][] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await provisionFreshInstallWorkspace({
        pdHome,
        workspaceDir,
        host: 'codex',
        scheduler: ENABLED_SCHEDULER,
        resume: true,
        warn: () => undefined,
        probes: {
          spawnFn: fakeSpawn({
            'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
            'service run-once': { code: 0, stdout: JSON.stringify({ ok: true, outcome: 'completed', runId: `r-${attempt}`, managed: { executions: [] } }) },
          }, calls),
        },
      });
      expect(outcome.ownership).toBe('not_provisioned');
      expect(outcome.firstCycle).toMatchObject({ attempted: false, reason: 'legacy_consumer_unproven' });
      expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
        .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    }
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(readPendingProvisioningEvidence(pdHome, workspaceDir)).toMatchObject({ reason: 'legacy_consumer_unproven' });
    expect(calls.filter((args) => args.includes('worker') || args.includes('run-once'))).toHaveLength(0);
  });
});
