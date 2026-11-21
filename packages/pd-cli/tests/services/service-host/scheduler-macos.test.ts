/**
 * macOS scheduler adapter — launchctl protocol tests against a faked command
 * boundary (task §9.F): plist write + bootstrap sequencing into gui/<uid>,
 * idempotence with preserved enablement, fail-closed foreign-plist handling,
 * load/disable state parsing from print/print-disabled, bootout tolerance for
 * "not loaded" outcomes, and the uid-unavailable refusal.
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

type Handler = SchedulerCommandResult | ((args: readonly string[]) => SchedulerCommandResult);

/** Dispatches by launchctl subcommand (args[0]); unscripted subcommands throw. */
function launchctlRunner(handlers: Readonly<Record<string, Handler>>): {
  runner: SchedulerCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: SchedulerCommandRunner = {
    async run(command, args) {
      if (command !== 'launchctl') throw new Error(`unexpected command: ${command}`);
      const sub = args[0];
      if (sub === undefined) throw new Error(`launchctl call without a subcommand: ${args.join(' ')}`);
      const handler = handlers[sub];
      if (handler === undefined) throw new Error(`unexpected launchctl subcommand '${sub}': ${args.join(' ')}`);
      calls.push({ command, args });
      return typeof handler === 'function' ? handler(args) : handler;
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
    return { ok: true };
  }
}

const PRINT_LOADED: SchedulerCommandResult = { code: 0, stdout: 'state = running\n\tlast exit code = 0\n', stderr: '' };
const PRINT_DISABLED_CLEAN: SchedulerCommandResult = { code: 0, stdout: '\t"com.apple.other" => disabled => true\n', stderr: '' };
const OK: SchedulerCommandResult = { code: 0, stdout: '', stderr: '' };

function printDisabledWith(label: string, disabled: boolean): SchedulerCommandResult {
  return {
    code: 0,
    stdout: `\t"com.apple.other" => disabled => false\n\t"${label}" => disabled => ${disabled ? 'true' : 'false'}\n`,
    stderr: '',
  };
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

function makeDeps(runner: SchedulerCommandRunner, fileIo: SchedulerFileIo, getUid: () => number | undefined = () => 501): MacosSchedulerDeps {
  return { runner, fileIo, getUid };
}

describe('createMacosSchedulerAdapter', () => {
  it('install writes our plist and bootstraps it into gui/501', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const { runner, calls } = launchctlRunner({
      print: PRINT_LOADED,
      'print-disabled': PRINT_DISABLED_CLEAN,
      bootstrap: OK,
    });
    const fileIo = new FakeFileIo();
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.platform).toBe('darwin');
    expect(result.facts.taskName).toBe(registration.identity.macosLabel);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);

    const written = fileIo.files.get(plistFile);
    expect(written).toBe(buildMacosLaunchAgentPlist(registration));
    expect(written).toContain('<key>RunAtLoad</key>');
    expect(written).toContain('<true/>');
    expect(written).toContain('<key>StartInterval</key>');
    expect(written).toContain('<integer>120</integer>');

    const bootstrapCall = calls.find((c) => c.args[0] === 'bootstrap');
    expect(bootstrapCall?.args).toEqual(['bootstrap', 'gui/501', plistFile]);
  });

  it('install is idempotent for our own loaded plist (no bootstrap, enabled state preserved)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner, calls } = launchctlRunner({
      print: PRINT_LOADED,
      'print-disabled': PRINT_DISABLED_CLEAN,
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(calls.filter((c) => c.args[0] === 'bootstrap')).toHaveLength(0);
    expect(fileIo.writeLog).toHaveLength(0);
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
    const { runner, calls } = launchctlRunner({});
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
    const { runner } = launchctlRunner({});
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, new FakeFileIo()));

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('scheduler_not_registered');
  });

  it('enable issues launchctl enable when the agent is loaded but disabled', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const { runner, calls } = launchctlRunner({
      print: PRINT_LOADED,
      'print-disabled': printDisabledWith(label, true),
      enable: OK,
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(true);
    const enableCall = calls.find((c) => c.args[0] === 'enable');
    expect(enableCall?.args).toEqual(['enable', `gui/501/${label}`]);
  });

  it('disable is a no-op when the agent is already disabled', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const { runner, calls } = launchctlRunner({
      print: PRINT_LOADED,
      'print-disabled': printDisabledWith(label, true),
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.enabled).toBe(false);
    expect(calls.find((c) => c.args[0] === 'disable')).toBeUndefined();
  });

  it('status reports registered+enabled with the last exit code when the domain is clean', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner } = launchctlRunner({
      print: PRINT_LOADED,
      'print-disabled': PRINT_DISABLED_CLEAN,
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.lastResult).toBe('0');
    expect(result.facts.lastRunAt).toBeNull();
    expect(result.facts.triggerIntervalMs).toBe(120_000);
  });

  it('status reports enabled=false when print-disabled lists our label as disabled', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const { runner } = launchctlRunner({
      print: PRINT_LOADED,
      'print-disabled': printDisabledWith(label, true),
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistPathFor(registration), buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(false);
  });

  it('uninstall bootouts the agent then removes only our plist', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const label = registration.identity.macosLabel;
    const plistFile = plistPathFor(registration);
    const { runner, calls } = launchctlRunner({ bootout: OK });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.registered).toBe(false);
    const bootoutCall = calls.find((c) => c.args[0] === 'bootout');
    expect(bootoutCall?.args).toEqual(['bootout', `gui/501/${label}`]);
    expect(fileIo.removeLog).toEqual([plistFile]);
    expect(fileIo.files.has(plistFile)).toBe(false);
  });

  it('uninstall refuses a foreign plist and keeps it on disk', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const foreignPlist = '<plist version="1.0"><dict><key>Label</key><string>someone.else</string></dict></plist>';
    const { runner, calls } = launchctlRunner({});
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

  it('uninstall treats bootout "No process existing" as not-loaded and still succeeds', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const plistFile = plistPathFor(registration);
    const { runner } = launchctlRunner({
      bootout: { code: 3, stdout: '', stderr: 'No process existing with specified identity' },
    });
    const fileIo = new FakeFileIo();
    fileIo.files.set(plistFile, buildMacosLaunchAgentPlist(registration));
    const adapter = createMacosSchedulerAdapter(makeDeps(runner, fileIo));

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(fileIo.files.has(plistFile)).toBe(false);
  });

  it('install refuses when the uid is unavailable (no writes, no launchctl calls)', async () => {
    const home = tempHome();
    const registration = makeRegistration(home);
    const { runner, calls } = launchctlRunner({});
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
