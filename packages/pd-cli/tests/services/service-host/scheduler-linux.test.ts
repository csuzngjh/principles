/**
 * Linux scheduler adapter — systemd --user protocol tests against a faked
 * command boundary (task §9.F): unit file write + daemon-reload sequencing,
 * idempotent refresh without touching enablement, fail-closed foreign/partial
 * unit handling, honest daemon-reload and is-enabled failure mapping (an
 * unreadable enabled state is null, never silently "not installed"), and the
 * ExecMainStatus/ExecMainExitTimestamp facts from systemctl show.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  schedulerIdentityFor,
  type SchedulerCommandResult,
  type SchedulerCommandRunner,
  type SchedulerFileIo,
  type SchedulerRegistration,
} from '../../../src/services/service-host/scheduler/contract.js';
import { buildLinuxServiceUnit, buildLinuxTimerUnit, createLinuxSchedulerAdapter } from '../../../src/services/service-host/scheduler/linux.js';

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

type Handler = SchedulerCommandResult | ((args: readonly string[]) => SchedulerCommandResult);

/** Dispatches by `systemctl --user <sub>`; unscripted subcommands throw. */
function systemctlRunner(handlers: Readonly<Record<string, Handler>>): {
  runner: SchedulerCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: SchedulerCommandRunner = {
    async run(command, args) {
      if (command !== 'systemctl') throw new Error(`unexpected command: ${command}`);
      if (args[0] !== '--user') throw new Error(`expected systemctl --user, got: ${args.join(' ')}`);
      const sub = args[1];
      if (sub === undefined) throw new Error(`systemctl call without a subcommand: ${args.join(' ')}`);
      const handler = handlers[sub];
      if (handler === undefined) throw new Error(`unexpected systemctl subcommand '${sub}': ${args.join(' ')}`);
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

const IS_ENABLED_YES: SchedulerCommandResult = { code: 0, stdout: 'enabled\n', stderr: '' };
const IS_ENABLED_NO: SchedulerCommandResult = { code: 1, stdout: 'disabled\n', stderr: '' };
const RELOAD_OK: SchedulerCommandResult = { code: 0, stdout: '', stderr: '' };

/**
 * Registration with Linux-realistic POSIX paths: the adapter under test
 * targets Linux hosts, and ExecStart goes through systemd quoting (backslash
 * doubling), so Windows-style backslash paths would not round-trip through
 * the builder output the way they do on the real platform.
 */
const LINUX_HOME = '/home/pd-sched-test';

function makeRegistration(): SchedulerRegistration {
  const pdHome = `${LINUX_HOME}/.pd`;
  const cliEntry = `${LINUX_HOME}/tools/pd-cli/index.js`;
  const nodePath = `${LINUX_HOME}/tools/bin/node`;
  return { pdHome, homeDir: path.dirname(pdHome), cliEntry, nodePath, intervalMs: 120_000, identity: schedulerIdentityFor(pdHome) };
}

function unitPaths(registration: SchedulerRegistration): { serviceFile: string; timerFile: string } {
  const dir = path.join(path.dirname(registration.pdHome), '.config', 'systemd', 'user');
  return {
    serviceFile: path.join(dir, `${registration.identity.linuxUnitBase}.service`),
    timerFile: path.join(dir, `${registration.identity.linuxUnitBase}.timer`),
  };
}

/** Pre-fill both unit files with OUR definitions. */
function installOurs(fileIo: FakeFileIo, registration: SchedulerRegistration): void {
  const { serviceFile, timerFile } = unitPaths(registration);
  fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration));
  fileIo.files.set(timerFile, buildLinuxTimerUnit(registration));
}

describe('createLinuxSchedulerAdapter', () => {
  it('install writes both unit files and runs daemon-reload (default disabled)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({ 'daemon-reload': RELOAD_OK, 'is-enabled': IS_ENABLED_NO });
    const fileIo = new FakeFileIo();
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.platform).toBe('linux');
    expect(result.facts.taskName).toBe(`${registration.identity.linuxUnitBase}.timer`);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(false);
    expect(fileIo.files.get(serviceFile)).toBe(buildLinuxServiceUnit(registration));
    expect(fileIo.files.get(timerFile)).toBe(buildLinuxTimerUnit(registration));
    expect(calls.map((c) => c.args[1])).toEqual(['daemon-reload', 'is-enabled']);
  });

  it('install refreshes our own units (rewrite + daemon-reload) without enabling them', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ 'daemon-reload': RELOAD_OK, 'is-enabled': IS_ENABLED_YES });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(true); // from is-enabled exit 0
    expect(fileIo.writeLog).toHaveLength(2); // rewritten with the current definition
    expect(calls.find((c) => c.args[1] === 'daemon-reload')).toBeDefined();
    expect(calls.find((c) => c.args[1] === 'enable')).toBeUndefined();
  });

  it('install refuses a foreign service unit and does not overwrite it', async () => {
    const registration = makeRegistration();
    const { serviceFile } = unitPaths(registration);
    const foreignUnit = '[Unit]\nDescription=someone else\n';
    const { runner, calls } = systemctlRunner({});
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, foreignUnit);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_unit_conflict_foreign_unit');
    expect(fileIo.files.get(serviceFile)).toBe(foreignUnit); // untouched
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install refuses a partial registration (service unit without its timer)', async () => {
    const registration = makeRegistration();
    const { serviceFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({});
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('systemd_units_partial_registration');
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install reports daemon-reload failure honestly (files on disk, operation failed)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({
      'daemon-reload': { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' },
    });
    const fileIo = new FakeFileIo();
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('systemctl_daemon_reload_failed:1:')).toBe(true);
    expect(result.reason).toContain('Failed to connect to bus');
    expect(fileIo.writeLog).toHaveLength(2); // unit files were written before the reload
  });

  it('enable refuses when no units exist (unsafe_state scheduler_not_registered)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({});
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('scheduler_not_registered');
  });

  it('enable runs systemctl --user enable --now for our timer', async () => {
    const registration = makeRegistration();
    const timerName = `${registration.identity.linuxUnitBase}.timer`;
    const { runner, calls } = systemctlRunner({ 'is-enabled': IS_ENABLED_NO, enable: RELOAD_OK });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(true);
    const enableCall = calls.find((c) => c.args[1] === 'enable');
    expect(enableCall?.args).toEqual(['--user', 'enable', '--now', timerName]);
  });

  it('enable is a no-op when is-enabled already reports enabled', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ 'is-enabled': IS_ENABLED_YES, show: { code: 0, stdout: '\n\n', stderr: '' } });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.enabled).toBe(true);
    expect(calls.find((c) => c.args[1] === 'enable')).toBeUndefined();
  });

  it('status keeps registered=true and enabled=null when is-enabled is unreadable (exit 3)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({
      'is-enabled': { code: 3, stdout: '', stderr: 'Failed to connect to bus' },
      show: { code: 0, stdout: '\n\n', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBeNull(); // never silently false
  });

  it('disable runs systemctl --user disable --now for our timer', async () => {
    const registration = makeRegistration();
    const timerName = `${registration.identity.linuxUnitBase}.timer`;
    const { runner, calls } = systemctlRunner({ 'is-enabled': IS_ENABLED_YES, disable: RELOAD_OK });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(false);
    const disableCall = calls.find((c) => c.args[1] === 'disable');
    expect(disableCall?.args).toEqual(['--user', 'disable', '--now', timerName]);
  });

  it('disable is a no-op when is-enabled already reports disabled', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ 'is-enabled': IS_ENABLED_NO });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(calls.find((c) => c.args[1] === 'disable')).toBeUndefined();
  });

  it('uninstall stops the timer (failure ignored), removes both units, then daemon-reloads', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({
      disable: { code: 1, stdout: '', stderr: 'Failed to connect to bus' }, // ignored by uninstall
      'daemon-reload': RELOAD_OK,
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.registered).toBe(false);
    expect(fileIo.files.has(serviceFile)).toBe(false);
    expect(fileIo.files.has(timerFile)).toBe(false);
    expect(fileIo.removeLog.sort()).toEqual([serviceFile, timerFile].sort());
    expect(calls.map((c) => c.args[1])).toEqual(['disable', 'daemon-reload']);
  });

  it('uninstall refuses a foreign service unit and preserves both files', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const foreignUnit = '[Unit]\nDescription=not ours\n';
    const { runner, calls } = systemctlRunner({});
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, foreignUnit);
    fileIo.files.set(timerFile, buildLinuxTimerUnit(registration));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(fileIo.files.get(serviceFile)).toBe(foreignUnit);
    expect(fileIo.files.has(timerFile)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('status reads ExecMainStatus and ExecMainExitTimestamp from systemctl show --value lines', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({
      'is-enabled': IS_ENABLED_YES,
      show: { code: 0, stdout: '0\nSun 2026-11-22 10:00:00 UTC\n', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.triggerIntervalMs).toBe(120_000);
    expect(result.facts.lastResult).toBe('0');
    expect(result.facts.lastRunAt).toBe('Sun 2026-11-22 10:00:00 UTC');
    const showCall = calls.find((c) => c.args[1] === 'show');
    expect(showCall?.args).toContain(`${registration.identity.linuxUnitBase}.service`);
    expect(showCall?.args).toContain('--property=ExecMainStatus');
    expect(showCall?.args).toContain('--property=ExecMainExitTimestamp');
    expect(showCall?.args).toContain('--value');
  });
});
