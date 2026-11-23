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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { readWorkspaceBackgroundOwnership } from '@principles/install-layout';
import { provisionFreshInstallWorkspace } from '../src/service-host-provisioning.js';
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
function fakeSpawn(replies: Record<string, Reply>, calls: string[][]): typeof import('node:child_process').spawn {
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
  return ((_command: string, args: readonly string[]) => {
    const key = `${args[1] ?? ''} ${args[2] ?? ''}`;
    calls.push([...args]);
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

  it('never hands over ownership when the scheduler is not verified enabled', async () => {
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
    expect(outcome.firstCycle.attempted).toBe(false);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir })).toEqual({
      status: 'legacy_owned', source: 'no_record', generation: 0,
    });
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
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    expect(existsSync(path.join(pdHome, 'service', 'install-provisioning.json'))).toBe(false);
  });
});
