import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { readWorkspaceBackgroundOwnership } from '@principles/install-layout';
import { readAllPendingProvisioning } from '../src/service-host-provisioning.js';
import type { ServiceHostSchedulerOutcome } from '../src/service-host-bridge.js';
import {
  mergeManifestProvisioningTargets,
  openClawGatewayQuiesceFromObservedStatus,
  openClawMigrationRequiresGatewayCheck,
  provisionServiceHostInstallTargets,
  type ServiceHostInstallProvisioningInput,
  shouldProvisionOnInstall,
} from '../src/installer.js';

const homes: string[] = [];
let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let previousPdWorkspaceDir: string | undefined;
let previousOpenClawWorkspace: string | undefined;

function useIsolatedHome(): string {
  home = mkdtempSync(path.join(os.tmpdir(), 'pd-historical-migration-'));
  homes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
  delete process.env.PD_HOME;
  return home;
}

function seedManifestAndOpenClawBinding(workspaceDir: string): void {
  const pdHome = path.join(home, '.pd');
  mkdirSync(pdHome, { recursive: true });
  writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({
    layoutVersion: 1,
    mode: 'canonical',
    hosts: [],
    workspaces: [workspaceDir],
  }), 'utf8');
  const openclawHome = path.join(home, '.openclaw');
  mkdirSync(openclawHome, { recursive: true });
  writeFileSync(path.join(openclawHome, 'principles-disciple.json'), JSON.stringify({ workspace: workspaceDir }), 'utf8');
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  previousPdWorkspaceDir = process.env.PD_WORKSPACE_DIR;
  previousOpenClawWorkspace = process.env.OPENCLAW_WORKSPACE;
  delete process.env.PD_WORKSPACE_DIR;
  delete process.env.OPENCLAW_WORKSPACE;
  useIsolatedHome();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  if (previousPdWorkspaceDir === undefined) delete process.env.PD_WORKSPACE_DIR; else process.env.PD_WORKSPACE_DIR = previousPdWorkspaceDir;
  if (previousOpenClawWorkspace === undefined) delete process.env.OPENCLAW_WORKSPACE; else process.env.OPENCLAW_WORKSPACE = previousOpenClawWorkspace;
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('historical workspace migration eligibility', () => {
  it('explicit enable + verified scheduler + authoritative manifest registration is enough without a pending marker', () => {
    expect(shouldProvisionOnInstall({
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      schedulerState: 'enabled',
      workspaceRegistered: true,
      alreadyOwned: false,
    })).toBe(true);
  });

  it('unauthorized, unverified-scheduler, and unregistered workspaces remain ineligible', () => {
    const base = {
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      schedulerState: 'enabled',
      workspaceRegistered: true,
      alreadyOwned: false,
    };
    expect(shouldProvisionOnInstall({ ...base, consentIntent: 'refresh_if_registered' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, consentSource: 'recommended_default' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, schedulerState: 'registered_disabled' })).toBe(false);
    expect(shouldProvisionOnInstall({ ...base, workspaceRegistered: false })).toBe(false);
  });

  it('manifest targets are additive, canonical-deduplicated, and host-neutral until binding verification', () => {
    const existing = [{ host: 'codex' as const, workspaceDir: path.resolve('one') }];
    const merged = mergeManifestProvisioningTargets(existing, [path.resolve('one'), path.resolve('two')]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1]).toMatchObject({ host: 'none', workspaceDir: path.resolve('two') });
  });
});

describe('OpenClaw migration gateway preflight authority', () => {
  it('requires the gateway check for an explicit hostless migration whose manifest workspace is OpenClaw-bound', () => {
    const workspaceDir = path.join(home, 'workspace with spaces');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    expect(openClawMigrationRequiresGatewayCheck({
      host: 'none',
      workspaceDir: path.join(home, 'elsewhere'),
      serviceHost: { intent: 'enable', source: 'explicit_flag' },
    })).toBe(true);
  });


  it('includes the real OpenClaw binding even when the old manifest omitted that workspace', () => {
    const boundWorkspace = path.join(home, 'actual openclaw workspace');
    mkdirSync(boundWorkspace, { recursive: true });
    const openclawHome = path.join(home, '.openclaw');
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(path.join(openclawHome, 'principles-disciple.json'), JSON.stringify({ workspace: boundWorkspace }), 'utf8');
    const pdHome = path.join(home, '.pd');
    mkdirSync(pdHome, { recursive: true });
    writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: [],
      workspaces: [path.join(home, 'unrelated manifest workspace')],
    }), 'utf8');

    expect(openClawMigrationRequiresGatewayCheck({
      host: 'none',
      workspaceDir: path.join(home, 'invocation cwd workspace'),
      serviceHost: { intent: 'enable', source: 'explicit_flag' },
    })).toBe(true);
  });

  it('requires the gateway check when OpenClaw is a sibling refresh target even without explicit Service Host migration', () => {
    expect(openClawMigrationRequiresGatewayCheck({
      host: 'codex',
      workspaceDir: path.join(home, 'codex workspace'),
      refreshTargets: ['openclaw'],
    })).toBe(true);
  });

  it('does not treat missing or unreadable gateway config as migration quiesce evidence', () => {
    for (const observation of ['no_config', 'config_unreadable', 'port_not_configured'] as const) {
      const quiesce = openClawGatewayQuiesceFromObservedStatus({ isRunning: false, observation }, true);
      expect(quiesce.ok).toBe(false);
    }
    expect(openClawGatewayQuiesceFromObservedStatus({ isRunning: false, observation: 'port_not_listening' }, true))
      .toEqual({ ok: true, evidence: 'not_running' });
    // Ordinary upgrades keep the historical absence semantics; the strictness is migration-scoped.
    expect(openClawGatewayQuiesceFromObservedStatus({ isRunning: false, observation: 'no_config' }, false))
      .toEqual({ ok: true, evidence: 'not_running' });
  });

  it('does not widen the check without explicit migration authorization or for a non-migration target', () => {
    const workspaceDir = path.join(home, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    expect(openClawMigrationRequiresGatewayCheck({ host: 'none', workspaceDir })).toBe(false);
    expect(openClawMigrationRequiresGatewayCheck({
      host: 'none',
      workspaceDir,
      serviceHost: { intent: 'refresh_if_registered', source: 'policy' },
    })).toBe(false);
  });
});


type Reply = { code: number; stdout: string };

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
  return ((_command: string, args: readonly string[], _options: unknown) => {
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

function fakeInstalledCli(pdHome: string): void {
  const entry = path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '// fixture CLI entry', 'utf8');
}

function successfulOpenClawProbes(calls: string[][]): typeof import('node:child_process').spawn {
  return fakeSpawn({
    'openclaw worker': { code: 0, stdout: '{"mode":"ready"}' },
    'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","runId":"r","managed":{"executions":[]}}' },
  }, calls);
}

describe('production install provisioning orchestration for historical workspaces', () => {
  it('migrates a manifest workspace with no pending marker through binding verification, CAS, and first run-once', async () => {
    const workspaceDir = path.join(home, 'historical workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    const pdHome = path.join(home, '.pd');
    fakeInstalledCli(pdHome);
    const calls: string[][] = [];
    let scans = 0;

    const report = await provisionServiceHostInstallTargets({
      pdHome,
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      pendingEntries: [],
      manifestWorkspaces: [workspaceDir],
      scanFn: () => { scans += 1; return { ok: true, workers: [] }; },
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited', pid: 4242 },
      probes: { spawnFn: successfulOpenClawProbes(calls) },
      warn: () => undefined,
    });

    expect(scans).toBe(2); // target selection plus fresh evidence at the CAS boundary
    expect(report?.targets).toHaveLength(1);
    expect(report?.targets[0]).toMatchObject({ host: 'openclaw', workspaceDir });
    expect(report?.targets[0]?.outcome).toMatchObject({ ownership: 'service_host_owned', generation: 1, pendingProvisioning: false });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: path.join(pdHome, 'install.json'), workspaceDir }))
      .toMatchObject({ status: 'service_host_owned', generation: 1 });
    expect(calls.some((args) => args.includes('--readiness'))).toBe(true);
    expect(calls.some((args) => args.includes('run-once'))).toBe(true);
  });

  it('does not scan or migrate without explicit authorization or a verified enabled scheduler', async () => {
    const workspaceDir = path.join(home, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    const pdHome = path.join(home, '.pd');
    fakeInstalledCli(pdHome);
    for (const input of [
      { consentIntent: 'refresh_if_registered', consentSource: 'explicit_flag', scheduler: ENABLED_SCHEDULER },
      { consentIntent: 'enable', consentSource: 'recommended_default', scheduler: ENABLED_SCHEDULER },
      { consentIntent: 'enable', consentSource: 'explicit_flag', scheduler: { ...ENABLED_SCHEDULER, state: 'registered_disabled' as const, enabled: false } },
    ]) {
      let scans = 0;
      const report = await provisionServiceHostInstallTargets({
        pdHome,
        freshInstall: false,
        consentIntent: input.consentIntent,
        consentSource: input.consentSource,
        scheduler: input.scheduler,
        runTargets: [],
        pendingEntries: [],
        manifestWorkspaces: [workspaceDir],
        scanFn: () => { scans += 1; return { ok: true, workers: [] }; },
        probes: { spawnFn: successfulOpenClawProbes([]) },
        warn: () => undefined,
      });
      expect(report).toBeNull();
      expect(scans).toBe(0);
      expect(readWorkspaceBackgroundOwnership({ manifestPath: path.join(pdHome, 'install.json'), workspaceDir }))
        .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
    }
  });

  it('already service_host_owned workspaces are skipped before scan and do not increment generation', async () => {
    const workspaceDir = path.join(home, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    const pdHome = path.join(home, '.pd');
    fakeInstalledCli(pdHome);
    const base: ServiceHostInstallProvisioningInput = {
      pdHome,
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      pendingEntries: [],
      manifestWorkspaces: [workspaceDir],
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited' as const, pid: 4242 },
      probes: { spawnFn: successfulOpenClawProbes([]) },
      warn: () => undefined,
    };
    const first = await provisionServiceHostInstallTargets({ ...base, scanFn: () => ({ ok: true, workers: [] }) });
    expect(first?.targets[0]?.outcome.generation).toBe(1);
    let scans = 0;
    const second = await provisionServiceHostInstallTargets({
      ...base,
      scanFn: () => { scans += 1; return { ok: true, workers: [] }; },
    });
    expect(second).toBeNull();
    expect(scans).toBe(0);
    expect(readWorkspaceBackgroundOwnership({ manifestPath: path.join(pdHome, 'install.json'), workspaceDir }))
      .toMatchObject({ status: 'service_host_owned', generation: 1 });
  });

  it('a positive scan stays pending and a later invocation scans again rather than trusting prior evidence', async () => {
    const workspaceDir = path.join(home, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    const pdHome = path.join(home, '.pd');
    fakeInstalledCli(pdHome);
    let scans = 0;
    const scanFn = () => {
      scans += 1;
      return { ok: true, workers: [{ pid: 4242, workspaceDir }] };
    };
    const input: ServiceHostInstallProvisioningInput = {
      pdHome,
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      pendingEntries: [],
      manifestWorkspaces: [workspaceDir],
      scanFn,
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited' as const, pid: 4242 },
      probes: { spawnFn: successfulOpenClawProbes([]) },
      warn: () => undefined,
    };
    const first = await provisionServiceHostInstallTargets(input);
    const second = await provisionServiceHostInstallTargets(input);
    expect(scans).toBe(2); // a positive selection scan blocks before any CAS-boundary rescan
    expect(first?.targets[0]?.outcome.pendingProvisioning).toBe(true);
    expect(second?.targets[0]?.outcome.pendingProvisioning).toBe(true);
    expect(readWorkspaceBackgroundOwnership({ manifestPath: path.join(pdHome, 'install.json'), workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
  });

  it('multiple historical workspaces migrate independently without cross-workspace ownership pollution', async () => {
    const openclawWorkspace = path.join(home, 'openclaw workspace');
    const hostlessWorkspace = path.join(home, 'hostless workspace');
    mkdirSync(openclawWorkspace, { recursive: true });
    mkdirSync(hostlessWorkspace, { recursive: true });
    seedManifestAndOpenClawBinding(openclawWorkspace);
    const pdHome = path.join(home, '.pd');
    const manifestPath = path.join(pdHome, 'install.json');
    writeFileSync(manifestPath, JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: [],
      workspaces: [openclawWorkspace, hostlessWorkspace],
    }), 'utf8');
    fakeInstalledCli(pdHome);
    const report = await provisionServiceHostInstallTargets({
      pdHome,
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      pendingEntries: [],
      manifestWorkspaces: [openclawWorkspace, hostlessWorkspace],
      scanFn: () => ({ ok: true, workers: [] }),
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited', pid: 4242 },
      probes: { spawnFn: successfulOpenClawProbes([]) },
      warn: () => undefined,
    });
    expect(report?.targets).toHaveLength(2);
    expect(report?.targets.map((target) => target.host)).toEqual(['openclaw', 'none']);
    for (const workspaceDir of [openclawWorkspace, hostlessWorkspace]) {
      expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
        .toMatchObject({ status: 'service_host_owned', generation: 1 });
    }
  });

  it('a missing concrete host binding stays fail-closed across repeated migrations without being rewritten to none', async () => {
    const workspaceDir = path.join(home, 'custom openclaw workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const pdHome = path.join(home, '.pd');
    mkdirSync(pdHome, { recursive: true });
    writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: [],
      workspaces: [workspaceDir],
    }), 'utf8');
    fakeInstalledCli(pdHome);
    const base = {
      pdHome,
      freshInstall: false as const,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      manifestWorkspaces: [workspaceDir],
      scanFn: () => ({ ok: true as const, workers: [] }),
      probes: { spawnFn: successfulOpenClawProbes([]) },
      warn: () => undefined,
    };
    const first = await provisionServiceHostInstallTargets({
      ...base,
      pendingEntries: [{ workspaceDir, host: 'openclaw', recordedAt: new Date().toISOString(), reason: 'prior deferred migration' }],
    });
    expect(first?.targets[0]).toMatchObject({ host: 'openclaw' });
    expect(first?.targets[0]?.outcome.firstCycle).toMatchObject({ reason: 'binding_unverifiable' });
    const persisted = readAllPendingProvisioning(pdHome).entries.find((entry) => entry.workspaceDir === workspaceDir);
    expect(persisted?.host).toBe('openclaw');

    const second = await provisionServiceHostInstallTargets({
      ...base,
      pendingEntries: readAllPendingProvisioning(pdHome).entries,
    });
    expect(second?.targets[0]).toMatchObject({ host: 'openclaw' });
    expect(second?.targets[0]?.outcome.firstCycle).toMatchObject({ reason: 'binding_unverifiable' });
    expect(readWorkspaceBackgroundOwnership({ manifestPath: path.join(pdHome, 'install.json'), workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
  });

  it('a Codex-only migration does not treat installer-inherited PD_WORKSPACE_DIR as an OpenClaw binding', async () => {
    const workspaceDir = path.join(home, 'codex only workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const pdHome = path.join(home, '.pd');
    mkdirSync(pdHome, { recursive: true });
    writeFileSync(path.join(pdHome, 'install.json'), JSON.stringify({
      layoutVersion: 1,
      mode: 'canonical',
      hosts: [],
      workspaces: [workspaceDir],
    }), 'utf8');
    const dataRoot = path.join(home, '.codex', 'plugins', 'data', 'principles-disciple-principles');
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'mcp-binding.json'), JSON.stringify({ host: 'codex', workspaceDir }), 'utf8');
    fakeInstalledCli(pdHome);
    process.env.PD_WORKSPACE_DIR = workspaceDir;
    process.env.OPENCLAW_WORKSPACE = workspaceDir;
    const calls: string[][] = [];
    const report = await provisionServiceHostInstallTargets({
      pdHome,
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      pendingEntries: [],
      manifestWorkspaces: [workspaceDir],
      scanFn: () => ({ ok: true, workers: [] }),
      probes: { spawnFn: fakeSpawn({
        'codex worker': { code: 0, stdout: '{"mode":"ready"}' },
        'service run-once': { code: 0, stdout: '{"ok":true,"outcome":"completed","runId":"r","managed":{"executions":[]}}' },
      }, calls) },
      warn: () => undefined,
    });
    expect(report?.targets[0]).toMatchObject({ host: 'codex' });
    expect(report?.targets[0]?.outcome).toMatchObject({ ownership: 'service_host_owned', pendingProvisioning: false });
    expect(calls.some((args) => args.includes('run-once'))).toBe(true);
  });

  it('an unverifiable host binding stays pending and never reaches CAS', async () => {
    const workspaceDir = path.join(home, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    seedManifestAndOpenClawBinding(workspaceDir);
    writeFileSync(path.join(home, '.openclaw', 'principles-disciple.json'), '{not json', 'utf8');
    const pdHome = path.join(home, '.pd');
    fakeInstalledCli(pdHome);
    const manifestPath = path.join(pdHome, 'install.json');
    const before = readFileSync(manifestPath, 'utf8');
    const report = await provisionServiceHostInstallTargets({
      pdHome,
      freshInstall: false,
      consentIntent: 'enable',
      consentSource: 'explicit_flag',
      scheduler: ENABLED_SCHEDULER,
      runTargets: [],
      pendingEntries: [],
      manifestWorkspaces: [workspaceDir],
      scanFn: () => ({ ok: true, workers: [] }),
      openClawGatewayQuiesce: { ok: true, evidence: 'process_exited', pid: 4242 },
      probes: { spawnFn: successfulOpenClawProbes([]) },
      warn: () => undefined,
    });
    expect(report?.targets[0]?.outcome).toMatchObject({ ownership: 'not_provisioned', pendingProvisioning: true });
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
    expect(readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir }))
      .toEqual({ status: 'legacy_owned', source: 'no_record', generation: 0 });
  });
});
