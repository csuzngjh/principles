/**
 * macOS scheduler adapter — launchctl protocol tests against a STATEFUL
 * faked command boundary (task §9.F). Covers the reviewed lifecycle
 * (task §3):
 *
 *   unregistered → installed_disabled → enabled → disabled → enabled →
 *   uninstalled
 *
 * install writes ONLY the plist + log dir (no bootstrap) and pins the
 * persistent disabled flag; enable clears the flag, bootstraps and VERIFIES
 * loaded; disable pins the flag, bootouts and VERIFIES unloaded; status
 * reads each witness independently (an unreadable disabled-flag yields
 * enabled=null + degradedReasons, never a guessed false); uninstall removes
 * ONLY our own plist after verifying the job is gone.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  schedulerIdentityFor,
  type SchedulerCommandResult,
  type SchedulerCommandRunner,
  type SchedulerFileIo,
  type SchedulerRegistration,
} from '../../../src/services/service-host/scheduler/contract.js';
import { buildMacosLaunchAgentPlist, createMacosSchedulerAdapter, type MacosSchedulerDeps } from '../../../src/services/service-host/scheduler/macos.js';

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sched-macos-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** Mutable launchd domain state the fake answers from. */
interface LaunchctlState {
  /** The LaunchAgent label print-disabled reports overrides for. */
  label: string;
  loaded: boolean;
  /** launchd persistent disable override (null = no override recorded). */
  disabled: boolean | null;
}

/**
 * Stateful launchctl fake: subcommand semantics mirror launchd —
 * print fails when not loaded, print-disabled lists overrides only,
 * enable/disable flip the flag, bootstrap/bootout flip loaded.
 * `failures` maps a subcommand to a result to inject (state unchanged).
 */
function launchctlRunner(state: LaunchctlState, failures: Readonly<Record<string, SchedulerCommandResult>> = {}): {
  runner: SchedulerCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: SchedulerCommandRunner = {
    async run(command, args) {
      if (command !== 'launchctl') throw new Error(`unexpected command: ${command}`);
      const sub = args[0];
      if (sub === undefined) throw new Error(`launchctl call without a subcommand: ${args.join(' ')}`);
      calls.push({ command, args });
      const injected = failures[sub];
      if (injected !== undefined) return injected;
      switch (sub) {
        case 'print':
          return state.loaded
            ? { code: 0, stdout: 'state = running\n\tlast exit code = 0\n', stderr: '' }
            : { code: 1, stdout: '', stderr: 'Could not find service' };
        case 'print-disabled': {
          const lines = ['\t"com.apple.other" => disabled => false'];
          if (state.disabled !== null) {
            lines.push(`\t"${state.label}" => disabled => ${state.disabled}`);
          }
          return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
        }
        case 'disable':
          state.disabled = true;
          return { code: 0, stdout: '', stderr: '' };
        case 'enable':
          state.disabled = false;
          return { code: 0, stdout: '', stderr: '' };
        case 'bootstrap':
          state.loaded = true;
          return { code: 0, stdout: '', stderr: '' };
        case 'bootout':
          state.loaded = false;
          return { code: 0, stdout: '', stderr: '' };
        default:
          throw new Error(`unexpected launchctl subcommand '${sub}': ${args.join(' ')}`);
      }
    },
  };
  return { runner, calls };
}

/** In-memory file boundary implementing the SchedulerFileIo contract. */
class FakeFileIo implements SchedulerFileIo {
  readonly files = new Map<string, string>();
  readonly writeLog: Array<{ file: string; content: string }> = [];
  readonly removeLog: string[] = [];
  readonly mkdirLog: string[] = [];
  failMkdirs = false;

  readIfExists(file: string): ReturnType<SchedulerFileIo['readIfExists']> {
    const content = this.files.get(file);
    if (content === undefined) return { ok: false, reason: 'missing' };
    return { ok: true, content };
  }

  writeAtomic(file: string, content: string): ReturnType<SchedulerFileIo['writeAtomic']> {
    this.files.set(file, content);
    this.writeLog.push({ file, content });
    return { ok: true };
  }

  remove(file: string): ReturnType<SchedulerFileIo['remove']> {
    this.removeLog.push(file);
    if (!this.files.delete(file)) return { ok: false, reason: 'missing' };
    return { ok: true };
  }

  exists(file: string): boolean {
    return this.files.has(file);
  }

  mkdirs(dir: string): ReturnType<SchedulerFileIo['mkdirs']> {
    this.mkdirLog.push(dir);
    if (this.failMkdirs) return { ok: false, reason: 'EACCES: permission denied' };
    return { ok: true };
  }
}

function makeRegistration(home: string): SchedulerRegistration {
  const pdHome = path.join(home, '.pd');
  const cliEntry = path.join(home, 'tools', 'pd-cli', 'index.js');
  const nodePath = path.join(home, 'tools', 'bin', 'node');
  return { pdHome, homeDir: path.dirname(pdHome), cliEntry, nodePath, intervalMs: 120_000, identity: schedulerIdentityFor(pdHome) };
}

function plistPathFor(registration: SchedulerRegistration): string {
  return path.join(path.dirname(registration.pdHome), 'Library', 'LaunchAgents', `${registration.identity.macosLabel}.plist`);
}

function logDirFor(registration: SchedulerRegistration): string {
  return path.join(registration.pdHome, 'service');
}

function makeDeps(runner: SchedulerCommandRunner, fileIo: SchedulerFileIo, getUid: () => number | undefined = () => 501): MacosSchedulerDeps {
  return { runner, fileIo, getUid };
}

function subsOf(calls: readonly RecordedCall[]): string[] {
  return calls.map((c) => c.args[0] ?? '');
}

describe('createMacosSchedulerAdapter', () => {
  it('install writes the plist + log dir, pins disabled, and NEVER bootstraps (installed_disabled)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: false, disabled: null };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.platform).toBe('darwin');
    expect(result.facts.registered).toBe(true);
    // installed_disabled — a fresh registration never fires at next login.
    expect(result.facts.enabled).toBe(false);
    expect(result.facts.active).toBe(false);

    const written = fileIo.files.get(plistFile);
    expect(written).toBe(buildMacosLaunchAgentPlist(registration));
    expect(written).toContain('<key>RunAtLoad</key>');
    expect(written).toContain('<integer>120</integer>');

    // install = write + persistent disable ONLY: no bootstrap, no enable.
    expect(subsOf(calls)).not.toContain('bootstrap');
    expect(subsOf(calls)).not.toContain('enable');
    const disableCall = calls.find((c) => c.args[0] === 'disable');
    expect(disableCall?.args).toEqual(['disable', `gui/501/${registration.identity.macosLabel}`]);
    // The log dir is created up-front (task §6: first triggered run writes logs).
    expect(fileIo.mkdirLog).toContain(logDirFor(registration));
    expect(state.disabled).toBe(true);
    expect(state.loaded).toBe(false);
  });

  it('install fails closed when the log directory cannot be created (no writes)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner } = launchctlRunner({ label: registration.identity.macosLabel, loaded: false, disabled: null });
    const fileIo = new FakeFileIo();
    fileIo.failMkdirs = true;
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('launchagent_log_dir_unwritable')).toBe(true);
    expect(fileIo.writeLog).toHaveLength(0);
  });

  it('install refreshes an ENABLED+LOADED own agent: bootout+bootstrap, enabled stays enabled (task §15)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: true, disabled: false };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBe(true);
    // The enabled flag is NEVER touched on a refresh — no disable call.
    expect(subsOf(calls)).not.toContain('disable');
    // The loaded job is bounced so it picks up the refreshed definition.
    expect(subsOf(calls)).toContain('bootout');
    expect(subsOf(calls)).toContain('bootstrap');
    expect(state.disabled).toBe(false);
    expect(state.loaded).toBe(true);
  });

  it('install refreshes a DISABLED own agent: the disabled flag stays pinned', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: false, disabled: true };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(false);
    expect(subsOf(calls)).not.toContain('bootstrap');
    expect(state.disabled).toBe(true);
  });

  it('install refuses a foreign plist at our label path and does not overwrite it', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const foreignPlist = buildMacosLaunchAgentPlist({
      ...registration,
      cliEntry: path.join(home, 'elsewhere', 'cli.js'),
      pdHome: path.join(home, 'elsewhere', '.pd'),
    });
    const { runner, calls } = launchctlRunner({ label: registration.identity.macosLabel, loaded: false, disabled: null });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, foreignPlist);
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('launchagent_conflict_foreign_plist');
    expect(fileIo.files.get(plistFile)).toBe(foreignPlist); // untouched
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('enable refuses when no plist exists (unsafe_state scheduler_not_registered)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner } = launchctlRunner({ label: registration.identity.macosLabel, loaded: false, disabled: null });
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, new FakeFileIo()));

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('scheduler_not_registered');
  });

  it('enable clears the flag, bootstraps and VERIFIES loaded before reporting enabled', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: false, disabled: true };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBe(true);
    const enableCall = calls.find((c) => c.args[0] === 'enable');
    expect(enableCall?.args).toEqual(['enable', `gui/501/${label}`]);
    const bootstrapCall = calls.find((c) => c.args[0] === 'bootstrap');
    expect(bootstrapCall?.args).toEqual(['bootstrap', 'gui/501', plistPathFor(registration)]);
    expect(state.disabled).toBe(false);
    expect(state.loaded).toBe(true);
  });

  it('enable fails when bootstrap does not leave the job loaded (no enabled claim)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: false, disabled: true };
    const { runner } = launchctlRunner(state, {
      bootstrap: { code: 5, stdout: '', stderr: 'Input/output error' },
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('launchctl_bootstrap_failed')).toBe(true);
    expect(state.loaded).toBe(false);
  });

  it('disable pins the flag, bootouts and VERIFIES unloaded before reporting stopped', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: true, disabled: false };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(false);
    expect(result.facts.active).toBe(false);
    expect(calls.find((c) => c.args[0] === 'disable')?.args).toEqual(['disable', `gui/501/${label}`]);
    expect(calls.find((c) => c.args[0] === 'bootout')?.args).toEqual(['bootout', `gui/501/${label}`]);
    expect(state.disabled).toBe(true);
    expect(state.loaded).toBe(false);
  });

  it('disable fails when the job stays loaded after bootout (无法证明停止时不得返回成功)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: true, disabled: false };
    const { runner } = launchctlRunner(state, {
      bootout: { code: 113, stdout: '', stderr: 'Could not kickstart service' },
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('launchctl_bootout_failed')).toBe(true);
    expect(state.loaded).toBe(true);
  });

  it('disable is a no-op when already disabled AND unloaded', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: false, disabled: true };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.enabled).toBe(false);
    expect(calls.find((c) => c.args[0] === 'disable')).toBeUndefined();
    expect(calls.find((c) => c.args[0] === 'bootout')).toBeUndefined();
  });

  it('status reports each witness independently: loaded agent, clear flag → enabled+active', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner } = launchctlRunner({ label: registration.identity.macosLabel, loaded: true, disabled: false });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBe(true);
    expect(result.facts.lastResult).toBe('0');
    expect(result.facts.triggerIntervalMs).toBe(120_000);
  });

  it('status reports enabled=null + degradedReasons when print-disabled fails (unknown ≠ false)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner } = launchctlRunner(
      { label: registration.identity.macosLabel, loaded: true, disabled: null },
      { 'print-disabled': { code: 1, stdout: '', stderr: 'service disabled state could not be read' } },
    );
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBeNull();
    expect(result.facts.active).toBe(true);
    expect(result.facts.degradedReasons?.some((r) => r.startsWith('launchctl_print_disabled_failed'))).toBe(true);
  });

  it('status reports a foreign same-label plist as external_conflict, never as ours', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const foreignPlist = '<plist version="1.0"><dict><key>Label</key><string>someone.else</string></dict></plist>';
    const { runner } = launchctlRunner({ label: registration.identity.macosLabel, loaded: false, disabled: null });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), foreignPlist);
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.status(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
  });

  it('full lifecycle: unregistered → installed_disabled → enabled → disabled → enabled → uninstalled', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: false, disabled: null };
    const { runner } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const installed = await adapter.install(registration);
    expect(installed.ok && installed.facts.enabled === false && installed.facts.registered === true).toBe(true);

    const enabled = await adapter.enable(registration);
    expect(enabled.ok && enabled.facts.enabled === true && enabled.facts.active === true).toBe(true);

    const disabled = await adapter.disable(registration);
    expect(disabled.ok && disabled.facts.enabled === false && disabled.facts.active === false).toBe(true);

    const reEnabled = await adapter.enable(registration);
    expect(reEnabled.ok && reEnabled.facts.enabled === true).toBe(true);

    const removed = await adapter.uninstall(registration);
    expect(removed.ok && removed.facts.registered === false).toBe(true);
    expect(fileIo.files.has(plistFile)).toBe(false);
    expect(state.loaded).toBe(false);
  });

  it('uninstall stops+unloads, verifies gone, then removes ONLY our plist', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const plistFile = plistPathFor(registration);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: true, disabled: false };
    const { runner, calls } = launchctlRunner(state);
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.registered).toBe(false);
    expect(calls.find((c) => c.args[0] === 'bootout')?.args).toEqual(['bootout', `gui/501/${label}`]);
    expect(fileIo.removeLog).toEqual([plistFile]);
    expect(fileIo.files.has(plistFile)).toBe(false);
  });

  it('uninstall refuses a foreign plist and keeps it on disk', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const foreignPlist = '<plist version="1.0"><dict><key>Label</key><string>someone.else</string></dict></plist>';
    const { runner, calls } = launchctlRunner({ label: registration.identity.macosLabel, loaded: false, disabled: null });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, foreignPlist);
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(fileIo.files.get(plistFile)).toBe(foreignPlist);
    expect(fileIo.removeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('uninstall keeps the plist when the loaded job cannot be verified gone', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: true, disabled: false };
    const { runner } = launchctlRunner(state, {
      bootout: { code: 113, stdout: '', stderr: 'Could not kickstart service' },
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(fileIo.files.has(plistFile)).toBe(true); // never deleted early
    expect(fileIo.removeLog).toHaveLength(0);
  });

  it('uninstall fails closed and keeps the plist when launchctl print cannot answer', async () => {
    // A failed print WITHOUT a definitive not-loaded answer leaves the
    // loaded state UNKNOWN — deleting the plist would orphan a possibly
    // still-loaded job that keeps firing with no file to re-inspect.
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const state: LaunchctlState = { label: registration.identity.macosLabel, loaded: true, disabled: false };
    const { runner } = launchctlRunner(state, {
      print: { code: null, stdout: '', stderr: '', spawnError: 'EACCES: launchctl not executable' },
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason).toContain('launchagent_loaded_state_unverified');
    expect(fileIo.files.has(plistFile)).toBe(true);
    expect(fileIo.removeLog).toHaveLength(0);
  });

  it('install refuses when the uid is unavailable (no writes, no launchctl calls)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner, calls } = launchctlRunner({ label: registration.identity.macosLabel, loaded: false, disabled: null });
    const fileIo = new FakeFileIo();
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo, () => undefined));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('macos_uid_unavailable');
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
