/**
 * Linux scheduler adapter — systemd --user protocol tests against a
 * STATEFUL faked command boundary (task §9.F). Covers the reviewed
 * contract:
 *
 *  - dual-unit: install/status/enable/disable/uninstall verify BOTH the
 *    .service (parsed ExecStart/WorkingDirectory) and the .timer (parsed
 *    Unit= pointer) independently (task §4/§5);
 *  - ExecStart serialization: %, $, space, quote, backslash (task §7);
 *  - manager visibility: install never reports registered when the manager
 *    cannot see the units (task §12);
 *  - query-failure evidence: not-found / disabled / unreadable stay
 *    distinct — is-enabled≠is-active≠last-run (task §13/§14);
 *  - uninstall: disable result CHECKED, inactive+disabled VERIFIED, files
 *    removed only after, daemon-reload, manager re-verify (task §4).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  schedulerIdentityFor,
  type SchedulerCommandResult,
  type SchedulerCommandRunner,
  type SchedulerFileIo,
  type SchedulerRegistration,
} from '../../../src/services/service-host/scheduler/contract.js';
import { buildLinuxServiceUnit, buildLinuxTimerUnit, createLinuxSchedulerAdapter, parseLinuxTimerIntervalMs, systemdQuote } from '../../../src/services/service-host/scheduler/linux.js';

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
}

/** Mutable user-manager state the fake answers from. */
interface SystemdState {
  /** Timer enablement flag (systemd enablement, not activity). */
  enabled: boolean;
  /** Timer ACTIVE state — independent from enabled (task §14). */
  active: boolean;
  /** The manager's unit-file cache sees our units (search-path hit). */
  managerSees: boolean;
  lastResult?: string;
  lastRunAt?: string;
}

/**
 * Stateful systemctl --user fake. `failures` maps a subcommand to a fixed
 * result (state unchanged). Semantics:
 *  - is-enabled → 0 'enabled' / 1 'disabled' / 1 'not-found' when the
 *    manager has no such unit;
 *  - is-active → 0 'active' / 3 'inactive';
 *  - cat → 0 when the manager sees the unit, 1 'not-found' otherwise;
 *  - enable/disable flip enabled+active; show reports last-run facts.
 */
function systemctlRunner(state: SystemdState, failures: Readonly<Record<string, SchedulerCommandResult | readonly SchedulerCommandResult[]>> = {}): {
  runner: SchedulerCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const failureIndexes = new Map<string, number>();
  const runner: SchedulerCommandRunner = {
    async run(command, args) {
      if (command !== 'systemctl') throw new Error(`unexpected command: ${command}`);
      if (args[0] !== '--user') throw new Error(`expected systemctl --user, got: ${args.join(' ')}`);
      const sub = args[1];
      if (sub === undefined) throw new Error(`systemctl call without a subcommand: ${args.join(' ')}`);
      calls.push({ command, args });
      const injected = failures[sub];
      if (Array.isArray(injected)) {
        const index = failureIndexes.get(sub) ?? 0;
        failureIndexes.set(sub, index + 1);
        const scripted = injected[index];
        if (scripted !== undefined) return scripted;
      } else if (injected !== undefined) {
        return injected;
      }
      switch (sub) {
        case 'daemon-reload':
          return { code: 0, stdout: '', stderr: '' };
        case 'is-enabled':
          if (!state.managerSees) return { code: 1, stdout: '', stderr: 'Failed to get unit file state for x.timer: No such file or directory' };
          return state.enabled
            ? { code: 0, stdout: 'enabled\n', stderr: '' }
            : { code: 1, stdout: 'disabled\n', stderr: '' };
        case 'is-active':
          return state.active
            ? { code: 0, stdout: 'active\n', stderr: '' }
            : { code: 3, stdout: 'inactive\n', stderr: '' };
        case 'cat':
          return state.managerSees
            ? { code: 0, stdout: '# unit file\n', stderr: '' }
            : { code: 1, stdout: '', stderr: 'No files found for x.service.' };
        case 'enable':
          state.enabled = true;
          state.active = true;
          return { code: 0, stdout: '', stderr: '' };
        case 'disable':
          state.enabled = false;
          state.active = false;
          return { code: 0, stdout: '', stderr: '' };
        case 'stop':
          state.active = false;
          return { code: 0, stdout: '', stderr: '' };
        case 'show':
          return { code: 0, stdout: `${state.lastResult ?? ''}\n${state.lastRunAt ?? ''}\n`, stderr: '' };
        default:
          throw new Error(`unexpected systemctl subcommand '${sub}': ${args.join(' ')}`);
      }
    },
  };
  return { runner, calls };
}

/** In-memory file boundary implementing the SchedulerFileIo contract. */
class FakeFileIo implements SchedulerFileIo {
  readonly files = new Map<string, string>();
  readonly unreadableFiles = new Set<string>();
  readonly writeLog: Array<{ file: string; content: string }> = [];
  readonly removeLog: string[] = [];
  readonly mkdirLog: string[] = [];

  readIfExists(file: string): ReturnType<SchedulerFileIo['readIfExists']> {
    if (this.unreadableFiles.has(file)) return { ok: false, reason: 'unreadable', detail: 'EACCES: permission denied' };
    const content = this.files.get(file);
    if (content === undefined) return { ok: false, reason: 'missing' };
    return { ok: true, content };
  }

  readonly failWrites = new Set<string>();

  writeAtomic(file: string, content: string): ReturnType<SchedulerFileIo['writeAtomic']> {
    if (this.failWrites.has(file)) return { ok: false, reason: 'EACCES: permission denied' };
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

function installOurs(fileIo: FakeFileIo, registration: SchedulerRegistration): void {
  const { serviceFile, timerFile } = unitPaths(registration);
  fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration));
  fileIo.files.set(timerFile, buildLinuxTimerUnit(registration));
}

function subsOf(calls: readonly RecordedCall[]): string[] {
  return calls.map((c) => c.args[1] ?? '');
}

describe('systemdQuote (task §7)', () => {
  it.each([
    ['plain', '/usr/bin/node', '"/usr/bin/node"'],
    ['spaces', '/home/pd user/.pd/index.js', '"/home/pd user/.pd/index.js"'],
    ['dollar (env-expansion escaped)', '/home/$USER/.pd', '"/home/$$USER/.pd"'],
    ['percent (specifier escaped)', '/home/pd%h/.pd', '"/home/pd%%h/.pd"'],
    ['backslash', 'C:\\dir\\node.exe', '"C:\\\\dir\\\\node.exe"'],
    ['double quote', '/home/a"b/.pd', '"/home/a\\"b/.pd"'],
    ['combined', '/home/p$d%h a\\.pd', '"/home/p$$d%%h a\\\\.pd"'],
  ])('%s', (_label, input, expected) => {
    expect(systemdQuote(input)).toBe(expected);
  });
});

describe('createLinuxSchedulerAdapter', () => {
  it('install writes both unit files, reloads, and verifies the manager sees them (default disabled)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const state: SystemdState = { enabled: false, active: false, managerSees: true };
    const { runner, calls } = systemctlRunner(state);
    const fileIo = new FakeFileIo();
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBe(false);
    expect(result.facts.active).toBe(false);
    expect(fileIo.files.get(serviceFile)).toBe(buildLinuxServiceUnit(registration));
    expect(fileIo.files.get(timerFile)).toBe(buildLinuxTimerUnit(registration));
    // Sequence: daemon-reload → manager visibility probe (cat ×2, one
    // per unit — dual verification) → facts.
    expect(subsOf(calls)).toEqual(['daemon-reload', 'cat', 'cat', 'is-enabled', 'is-active', 'show']);
  });

  it('install refuses to report registered when the manager cannot see the units (task §12 HOME/XDG mismatch)', async () => {
    const registration = makeRegistration();
    const state: SystemdState = { enabled: false, active: false, managerSees: false };
    const { runner } = systemctlRunner(state);
    const fileIo = new FakeFileIo();
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('systemd_unit_not_in_manager_search_path');
  });

  it('install refreshes our own units — interval preserved, enablement untouched (task §15)', async () => {
    const registration = makeRegistration();
    const { timerFile } = unitPaths(registration);
    const state: SystemdState = { enabled: true, active: true, managerSees: true };
    const { runner, calls } = systemctlRunner(state);
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    // Custom interval already registered — refresh must NOT reset to default.
    fileIo.files.set(timerFile, buildLinuxTimerUnit({ ...registration, intervalMs: 300_000 }));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.triggerIntervalMs).toBe(300_000);
    expect(fileIo.files.get(timerFile)).toBe(buildLinuxTimerUnit({ ...registration, intervalMs: 300_000 }));
    expect(subsOf(calls)).not.toContain('enable');
    expect(subsOf(calls)).not.toContain('disable');
  });

  it('install refresh honors an explicitly passed --interval-ms over the registered one', async () => {
    // An explicit interval is a user command — it must win over the
    // refresh-preserve rule (review: silent interval override).
    const registration: SchedulerRegistration = { ...makeRegistration(), intervalMs: 600_000, intervalExplicit: true };
    const { timerFile } = unitPaths(registration);
    const state: SystemdState = { enabled: true, active: true, managerSees: true };
    const { runner } = systemctlRunner(state);
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    fileIo.files.set(timerFile, buildLinuxTimerUnit({ ...registration, intervalMs: 300_000 }));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.triggerIntervalMs).toBe(600_000);
    expect(fileIo.files.get(timerFile)).toBe(buildLinuxTimerUnit({ ...registration, intervalMs: 600_000 }));
  });

  it('disable fails closed when the post-disable verdict is unreadable — never reports stopped without proof', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true }, {
      // disable --now "succeeds" but the verdict query cannot be answered
      // (e.g. bus error) — an unknown state is NOT proof of stopped.
      'is-enabled': { code: 2, stdout: '', stderr: 'Failed to connect to bus: Connection timed out' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('systemd_disable_unverified');
  });

  it('uninstall fails closed and keeps the unit files when the stopped-verdict is unreadable', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true }, {
      'is-active': { code: null, stdout: '', stderr: '', spawnError: 'ENOENT: systemctl not found' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('systemd_uninstall_unverified');
    // Nothing was deleted — the possibly-live registration is left for the operator.
    expect(fileIo.files.has(serviceFile)).toBe(true);
    expect(fileIo.files.has(timerFile)).toBe(true);
    expect(fileIo.removeLog.length).toBe(0);
  });

  it('install refuses a foreign service unit and does not overwrite it', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const foreignUnit = '[Unit]\nDescription=someone else\n[Service]\nExecStart=/bin/false\nWorkingDirectory=/\n';
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, foreignUnit);
    fileIo.files.set(timerFile, buildLinuxTimerUnit(registration));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_unit_conflict_foreign_unit');
    expect(fileIo.files.get(serviceFile)).toBe(foreignUnit);
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install refuses a foreign TIMER unit (Unit= points elsewhere) and does not overwrite it (task §4)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const foreignTimer = '[Timer]\nUnit=other.service\nOnUnitActiveSec=60s\n';
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration));
    fileIo.files.set(timerFile, foreignTimer);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_timer_conflict_foreign_unit');
    expect(fileIo.files.get(timerFile)).toBe(foreignTimer);
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install safely completes an OWN partial registration (service unit without its timer)', async () => {
    // A leftover of OUR service unit (e.g. first-install rollback that
    // failed mid-way) is provably PD-owned → install completes the pair
    // instead of refusing; a retry converges (review §3.8).
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(fileIo.files.get(timerFile)).toBe(buildLinuxTimerUnit(registration));
  });

  it('install safely completes an OWN timer-only partial registration', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.files.set(timerFile, buildLinuxTimerUnit(registration));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(true);
    expect(fileIo.files.get(serviceFile)).toBe(buildLinuxServiceUnit(registration));
    expect(fileIo.files.get(timerFile)).toBe(buildLinuxTimerUnit(registration));
  });

  it('install refuses a timer-only partial registration with extra OnCalendar', async () => {
    const registration = makeRegistration();
    const { timerFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    const foreignTimer = buildLinuxTimerUnit(registration).replace(
      'OnUnitActiveSec=120s',
      'OnUnitActiveSec=120s\nOnCalendar=Mon..Fri 08:00',
    );
    fileIo.files.set(timerFile, foreignTimer);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_timer_conflict_foreign_unit');
    expect(fileIo.files.get(timerFile)).toBe(foreignTimer);
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install refuses a FOREIGN partial registration (service unit without its timer)', async () => {
    const registration = makeRegistration();
    const { serviceFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration).replace('ExecStart=', 'ExecStart=/usr/bin/other '));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_unit_conflict_foreign_unit');
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it.each([
    'ExecStartPre=/usr/bin/side-effect',
    'ExecStartPost=/usr/bin/side-effect',
    'ExecStop=/usr/bin/side-effect',
  ])('install refuses a service unit with an extra execution directive: %s', async (directive) => {
    const registration = makeRegistration();
    const { serviceFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const canonical = fileIo.files.get(serviceFile) ?? '';
    fileIo.files.set(serviceFile, canonical.replace('[Service]\n', '[Service]\n' + directive + '\n'));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_unit_conflict_foreign_unit');
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('uninstall refuses a timer-only partial registration with extra OnCalendar', async () => {
    const registration = makeRegistration();
    const { timerFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    const foreignTimer = buildLinuxTimerUnit(registration).replace(
      'OnUnitActiveSec=120s',
      'OnUnitActiveSec=120s\nOnCalendar=Mon..Fri 08:00',
    );
    fileIo.files.set(timerFile, foreignTimer);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_timer_conflict_foreign_unit');
    expect(fileIo.files.get(timerFile)).toBe(foreignTimer);
    expect(fileIo.removeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install refuses to overwrite an UNREADABLE unit (fail-closed)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.unreadableFiles.add(serviceFile);
    fileIo.unreadableFiles.add(timerFile);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('systemd_unit_unreadable')).toBe(true);
    expect(fileIo.writeLog).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('install restores first-install files and reloads the manager after daemon-reload failure', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner, calls } = systemctlRunner(
      { enabled: false, active: false, managerSees: false },
      {
        'daemon-reload': [
          { code: 1, stdout: '', stderr: 'Failed to connect to bus' },
          { code: 0, stdout: '', stderr: '' },
        ],
      },
    );
    const fileIo = new FakeFileIo();
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('systemctl_daemon_reload_failed:1:');
    expect(fileIo.files.has(serviceFile)).toBe(false);
    expect(fileIo.files.has(timerFile)).toBe(false);
    expect(subsOf(calls).filter((sub) => sub === 'daemon-reload')).toHaveLength(2);
  });

  it('enable refuses when no units exist (unsafe_state scheduler_not_registered)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsafe_state');
    expect(result.reason).toBe('scheduler_not_registered');
  });

  it('enable runs systemctl --user enable --now and VERIFIES enabled+active', async () => {
    const registration = makeRegistration();
    const timerName = `${registration.identity.linuxUnitBase}.timer`;
    const state: SystemdState = { enabled: false, active: false, managerSees: true };
    const { runner, calls } = systemctlRunner(state);
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBe(true);
    const enableCall = calls.find((c) => c.args[1] === 'enable');
    expect(enableCall?.args).toEqual(['--user', 'enable', '--now', timerName]);
    expect(state.enabled).toBe(true);
  });

  it('enable fails when the timer does not verify enabled after enable --now', async () => {
    const registration = makeRegistration();
    const state: SystemdState = { enabled: false, active: false, managerSees: true };
    const { runner } = systemctlRunner(state, {
      // enable reports success but the flag flaps back — the adapter must
      // notice via is-enabled, not trust the exit code.
      enable: { code: 0, stdout: '', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason).toBe('systemd_enable_unverified');
  });

  it('enable is a no-op when is-enabled already reports enabled AND active', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.enable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(subsOf(calls)).not.toContain('enable');
  });

  it('disable runs systemctl --user disable --now and VERIFIES disabled+inactive', async () => {
    const registration = makeRegistration();
    const timerName = `${registration.identity.linuxUnitBase}.timer`;
    const state: SystemdState = { enabled: true, active: true, managerSees: true };
    const { runner, calls } = systemctlRunner(state);
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.enabled).toBe(false);
    expect(result.facts.active).toBe(false);
    const disableCall = calls.find((c) => c.args[1] === 'disable');
    expect(disableCall?.args).toEqual(['--user', 'disable', '--now', timerName]);
  });

  it('disable fails when the timer still reports enabled after disable --now (unproven stop)', async () => {
    const registration = makeRegistration();
    const state: SystemdState = { enabled: true, active: true, managerSees: true };
    const { runner } = systemctlRunner(state, {
      // disable exits 0 but leaves the timer enabled — the adapter must not
      // report "stopped" without proof (task §4).
      disable: { code: 0, stdout: '', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason).toBe('systemd_disable_unverified');
  });

  it('disable is a no-op when already disabled AND inactive', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.disable(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(subsOf(calls)).not.toContain('disable');
  });

  it('status reports enabled vs active INDEPENDENTLY (task §14): enabled=true, active=false', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: true, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBe(false);
  });

  it('status reports enabled=false, active=true without folding one into the other', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: false, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(false);
    expect(result.facts.active).toBe(true);
  });

  it('status keeps enabled=null + degradedReasons when is-enabled is unreadable (bus failure)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner(
      { enabled: true, active: true, managerSees: true },
      { 'is-enabled': { code: 3, stdout: '', stderr: 'Failed to connect to bus' } },
    );
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.registered).toBe(true);
    expect(result.facts.enabled).toBeNull(); // never silently false
    expect(result.facts.active).toBe(true);
    expect(result.facts.degradedReasons?.some((r) => r.startsWith('systemctl_is_enabled_failed'))).toBe(true);
  });

  it('status keeps active=null when is-active is unparsable (query failure ≠ inactive)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner(
      { enabled: true, active: true, managerSees: true },
      { 'is-active': { code: 1, stdout: 'wat\n', stderr: 'unexpected reply' } },
    );
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBeNull();
    expect(result.facts.degradedReasons?.some((r) => r.startsWith('systemctl_is_active_failed'))).toBe(true);
  });

  it('status reports a foreign timer (Unit= elsewhere) as external_conflict', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.files.set(serviceFile, buildLinuxServiceUnit(registration));
    fileIo.files.set(timerFile, '[Timer]\nUnit=other.service\n');
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
    expect(result.reason).toBe('systemd_timer_conflict_foreign_unit');
  });

  it('status reads ExecMainStatus and ExecMainExitTimestamp from systemctl show --value lines', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ enabled: true, active: true, managerSees: true, lastResult: '0', lastRunAt: 'Sun 2026-11-22 10:00:00 UTC' });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.status(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(true);
    expect(result.facts.active).toBe(true);
    expect(result.facts.triggerIntervalMs).toBe(120_000);
    expect(result.facts.lastResult).toBe('0');
    expect(result.facts.lastRunAt).toBe('Sun 2026-11-22 10:00:00 UTC');
    const showCall = calls.find((c) => c.args[1] === 'show');
    expect(showCall?.args).toContain(`${registration.identity.linuxUnitBase}.service`);
    expect(showCall?.args).toContain('--property=ExecMainStatus');
    expect(showCall?.args).toContain('--property=ExecMainExitTimestamp');
    expect(showCall?.args).toContain('--value');
  });

  it('uninstall verifies disabled+inactive, removes both units, reloads, re-verifies gone (task §4)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const state: SystemdState = { enabled: true, active: true, managerSees: true };
    // After the files are removed, the manager stops seeing them.
    const { runner, calls } = systemctlRunner(state, {});
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    // The fake's cat answers from managerSees — flip it when the files are
    // gone, as a real manager would after daemon-reload.
    const origRemove = fileIo.remove.bind(fileIo);
    fileIo.remove = (file) => {
      const result = origRemove(file);
      state.managerSees = false;
      return result;
    };

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.facts.registered).toBe(false);
    expect(fileIo.files.has(serviceFile)).toBe(false);
    expect(fileIo.files.has(timerFile)).toBe(false);
    // Dual verification: BOTH units must be gone from the manager's view.
    expect(subsOf(calls)).toEqual(['disable', 'is-enabled', 'is-active', 'daemon-reload', 'cat', 'cat']);
  });

  it('uninstall does NOT delete files when disable fails (task §4: no early delete)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner(
      { enabled: true, active: true, managerSees: true },
      { disable: { code: 1, stdout: '', stderr: 'Failed to connect to bus' } },
    );
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('systemctl_disable_failed')).toBe(true);
    expect(fileIo.files.has(serviceFile)).toBe(true);
    expect(fileIo.files.has(timerFile)).toBe(true);
    expect(fileIo.removeLog).toHaveLength(0);
  });

  it('uninstall keeps files when the timer still reports enabled after disable (unverified)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner(
      { enabled: true, active: true, managerSees: true },
      { disable: { code: 0, stdout: '', stderr: '' } }, // exit 0 but flag stays set
    );
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason).toBe('systemd_uninstall_unverified');
    expect(fileIo.files.has(serviceFile)).toBe(true);
    expect(fileIo.files.has(timerFile)).toBe(true);
  });

  it('uninstall continues past a not-found manager state and removes the leftover files', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: false });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fileIo.files.has(serviceFile)).toBe(false);
    expect(fileIo.files.has(timerFile)).toBe(false);
  });

  it('uninstall refuses a foreign service unit and preserves both files', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const foreignUnit = '[Unit]\nDescription=not ours\n';
    const { runner, calls } = systemctlRunner({ enabled: true, active: true, managerSees: true });
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

  it('uninstall refuses an unreadable unit (never deletes what it cannot verify)', async () => {
    const registration = makeRegistration();
    const { serviceFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.unreadableFiles.add(serviceFile);
    installOurs(fileIo, registration);
    fileIo.unreadableFiles.add(serviceFile);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('command_failed');
    expect(result.reason.startsWith('systemd_unit_unreadable')).toBe(true);
    expect(fileIo.removeLog).toHaveLength(0);
  });

  it('uninstall is an idempotent no-op when nothing is registered', async () => {
    const registration = makeRegistration();
    const { runner, calls } = systemctlRunner({ enabled: false, active: false, managerSees: false });
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo: new FakeFileIo() });

    const result = await adapter.uninstall(registration);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.facts.registered).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('lifecycle reliability round 3 (verdict strictness / dual verification / rollback)', () => {
  it('exit 4 + stdout not-found is positive not-found evidence (systemd 254+)', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true }, {
      'is-enabled': { code: 4, stdout: 'not-found\n', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.status(registration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // not-found is its own class — enabled stays null, never disabled.
    expect(result.facts.enabled).toBeNull();
  });

  it.each([
    ['permission denied', { code: 1, stdout: '', stderr: 'Failed to get unit file state: Permission denied' }],
    ['an empty answer', { code: 1, stdout: '', stderr: '' }],
    ['a dead user bus', { code: 2, stdout: '', stderr: 'Failed to connect to bus: No medium found' }],
    ['unrecognized output', { code: 0, stdout: 'baffled\n', stderr: '' }],
  ])('is-enabled %s → unreadable UNKNOWN, never inferred as disabled', async (_label, injected) => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true }, {
      'is-enabled': injected,
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.status(registration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBeNull();
    expect(result.facts.degradedReasons?.length ?? 0).toBeGreaterThan(0);
  });

  it('a masked unit is explicit not-enabled evidence', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true }, {
      'is-enabled': { code: 1, stdout: 'masked\n', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.status(registration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.enabled).toBe(false);
  });

  it('enable fails when post-enable is-active does not positively answer', async () => {
    const registration = makeRegistration();
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true }, {
      'is-active': { code: 3, stdout: 'inactive\n', stderr: '' },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.enable(registration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('systemd_enable_unverified');
  });

  it('refresh refuses BEFORE writing when the registered interval cannot be parsed', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const weird = (fileIo.files.get(timerFile) ?? '').replace(/OnUnitActiveSec=.+/, 'OnUnitActiveSec=whenever');
    fileIo.files.set(timerFile, weird);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('systemd_timer_interval_unparseable');
    // Not a byte was touched.
    expect(fileIo.writeLog).toHaveLength(0);
    expect(fileIo.files.get(timerFile)).toBe(weird);
    expect(fileIo.files.get(serviceFile)).toBeDefined();
  });

  it.each([
    ['120s', 120_000],
    ['15min', 900_000],
    ['2h', 7_200_000],
    ['1h30min', 5_400_000],
    ['1d', 86_400_000],
    ['1h 30min', 5_400_000],
    ['90ms', 90],
    ['900', 900_000],
  ])('parseLinuxTimerIntervalMs parses OnUnitActiveSec=%s → %s ms', (value, expected) => {
    expect(parseLinuxTimerIntervalMs(`[Timer]\nOnUnitActiveSec=${value}\n`)).toBe(expected);
  });

  it.each([['whenever'], ['10fortnights'], [''], ['0s']])(
    'parseLinuxTimerIntervalMs refuses %j → null',
    (value) => {
      expect(parseLinuxTimerIntervalMs(`[Timer]\nOnUnitActiveSec=${value}\n`)).toBeNull();
    },
  );

  it('refresh preserves a registered h/min interval it can parse', async () => {
    const registration = makeRegistration();
    const { timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    fileIo.files.set(timerFile, (fileIo.files.get(timerFile) ?? '').replace(/OnUnitActiveSec=.+/, 'OnUnitActiveSec=1h30min'));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.triggerIntervalMs).toBe(5_400_000);
    expect(fileIo.files.get(timerFile)).toContain('OnUnitActiveSec=5400s');
  });

  it('a service unit with TWO ExecStart lines is foreign (multi-command ambiguity)', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    fileIo.files.set(serviceFile, (fileIo.files.get(serviceFile) ?? '') + 'ExecStart=/usr/bin/evil\n');
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
  });

  it('a service unit whose ExecStart sits outside [Service] is foreign', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const unit = fileIo.files.get(serviceFile) ?? '';
    const execLine = /ExecStart=.+/.exec(unit)?.[0] ?? '';
    fileIo.files.set(serviceFile, unit.replace(execLine, '').replace('[Service]', `${execLine}\n[Service]`));
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('external_conflict');
  });

  it.runIf(process.platform === 'linux')('accepts the same unit file reached through a symlinked unit directory', async () => {
    // Real users sometimes symlink ~/.config (dotfiles layouts); the CI
    // sandbox uses the same shape to bridge systemd's account-home search
    // path. systemctl reports the manager-visible physical path, but it is
    // the SAME file — not a foreign shadowed unit.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-systemd-symlink-test-'));
    try {
      const realHome = path.join(tempRoot, 'real-home');
      const sandboxHome = path.join(tempRoot, 'sandbox-home');
      const realUnitDir = path.join(realHome, '.config', 'systemd', 'user');
      const sandboxUnitDir = path.join(sandboxHome, '.config', 'systemd', 'user');
      fs.mkdirSync(realUnitDir, { recursive: true });
      fs.mkdirSync(path.dirname(sandboxUnitDir), { recursive: true });
      fs.symlinkSync(realUnitDir, sandboxUnitDir, 'dir');
      const pdHome = path.join(sandboxHome, '.pd');
      const registration: SchedulerRegistration = {
        pdHome,
        homeDir: sandboxHome,
        cliEntry: path.join(sandboxHome, 'tools', 'pd-cli', 'index.js'),
        nodePath: path.join(sandboxHome, 'tools', 'bin', 'node'),
        intervalMs: 120_000,
        identity: schedulerIdentityFor(pdHome),
      };
      const serviceContent = buildLinuxServiceUnit(registration);
      const timerContent = buildLinuxTimerUnit(registration);
      fs.writeFileSync(path.join(realUnitDir, `${registration.identity.linuxUnitBase}.service`), serviceContent);
      fs.writeFileSync(path.join(realUnitDir, `${registration.identity.linuxUnitBase}.timer`), timerContent);
      const fileIo = new FakeFileIo();
      const { serviceFile, timerFile } = unitPaths(registration);
      fileIo.files.set(serviceFile, serviceContent);
      fileIo.files.set(timerFile, timerContent);
      const runner: SchedulerCommandRunner = {
        async run(command, args) {
          if (command !== 'systemctl') throw new Error(`unexpected command: ${command}`);
          const sub = args[1];
          const unitName = args[2] ?? '';
          if (sub === 'daemon-reload') return { code: 0, stdout: '', stderr: '' };
          if (sub === 'cat') {
            const physical = path.join(realUnitDir, unitName);
            return { code: 0, stdout: `# ${physical}\n${unitName.endsWith('.service') ? serviceContent : timerContent}`, stderr: '' };
          }
          if (sub === 'is-enabled') return { code: 1, stdout: 'disabled\n', stderr: '' };
          if (sub === 'is-active') return { code: 3, stdout: 'inactive\n', stderr: '' };
          if (sub === 'show') return { code: 0, stdout: '\n\n', stderr: '' };
          throw new Error(`unexpected systemctl subcommand '${sub}'`);
        },
      };
      const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
      const result = await adapter.install(registration);
      expect(result.ok, result.ok ? undefined : `${result.reason}: ${result.nextAction}`).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('a drop-in in the manager view makes the effective unit ambiguous → refuse', async () => {
    const registration = makeRegistration();
    const { serviceFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: true, active: true, managerSees: true }, {
      cat: { code: 0, stdout: `# ${serviceFile}\n[Service]\nExecStart=x\n# /etc/systemd/user/x.service.d/10-override.conf\n[Service]\nExecStart=\n` },
    });
    const fileIo = new FakeFileIo();
    installOurs(fileIo, registration);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('systemd_unit_ambiguous_manager_view');
    expect(result.reason).toContain('systemd_refresh_rollback_manager_view_unverified');
  });

  it('first-install timer-write failure removes the just-written service unit', async () => {
    const registration = makeRegistration();
    const { serviceFile, timerFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    fileIo.failWrites.add(timerFile);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('systemd_timer_write_failed');
    expect(fileIo.files.has(serviceFile)).toBe(false);
    expect(fileIo.removeLog).toContain(serviceFile);
  });

  it('refresh restores both files and verifies manager state after a transient manager-view read failure', async () => {
    const base = makeRegistration();
    const registration: SchedulerRegistration = { ...base, intervalMs: 60_000, intervalExplicit: true };
    const { serviceFile, timerFile } = unitPaths(registration);
    const transientCatFailure = {
      code: 1,
      stdout: '',
      stderr: 'temporary systemctl cat failure',
    };
    const { runner, calls } = systemctlRunner(
      { enabled: true, active: true, managerSees: true },
      { cat: [transientCatFailure] },
    );
    const fileIo = new FakeFileIo();
    installOurs(fileIo, base);
    const priorService = fileIo.files.get(serviceFile);
    const priorTimer = fileIo.files.get(timerFile);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('systemctl_cat_failed');
    expect(result.reason).not.toContain('systemd_refresh_rollback_manager_view_unverified');
    expect(fileIo.files.get(serviceFile)).toBe(priorService);
    expect(fileIo.files.get(timerFile)).toBe(priorTimer);
    expect(subsOf(calls).filter((sub) => sub === 'daemon-reload')).toHaveLength(2);
    expect(subsOf(calls).slice(0, 5)).toEqual(['daemon-reload', 'cat', 'daemon-reload', 'cat', 'cat']);
  });
  it('reports a distinct failure when the manager cannot reload the restored snapshot', async () => {
    const base = makeRegistration();
    const registration: SchedulerRegistration = { ...base, intervalMs: 60_000, intervalExplicit: true };
    const { serviceFile, timerFile } = unitPaths(registration);
    const shadowed = {
      code: 0,
      stdout: '# ' + serviceFile + '\n# ' + serviceFile + '.d/10-override.conf\n',
      stderr: '',
    };
    const { runner } = systemctlRunner(
      { enabled: true, active: true, managerSees: true },
      {
        'daemon-reload': [
          { code: 0, stdout: '', stderr: '' },
          { code: 1, stdout: '', stderr: 'rollback bus error' },
        ],
        cat: [shadowed],
      },
    );
    const fileIo = new FakeFileIo();
    installOurs(fileIo, base);
    const priorService = fileIo.files.get(serviceFile);
    const priorTimer = fileIo.files.get(timerFile);
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });

    const result = await adapter.install(registration);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('systemd_refresh_rollback_manager_reload_failed');
    expect(fileIo.files.get(serviceFile)).toBe(priorService);
    expect(fileIo.files.get(timerFile)).toBe(priorTimer);
  });

  it('paths containing $ and % round-trip through ExecStart quoting and WorkingDirectory escaping', async () => {
    const pdHome = '/home/we$ird %dir/.pd';
    const homeDir = '/home/we$ird %dir';
    const registration: SchedulerRegistration = {
      pdHome, homeDir,
      cliEntry: `${homeDir}/rel/index.js`, nodePath: '/usr/bin/node',
      intervalMs: 120_000, identity: schedulerIdentityFor(pdHome),
    };
    const { serviceFile } = unitPaths(registration);
    const { runner } = systemctlRunner({ enabled: false, active: false, managerSees: true });
    const fileIo = new FakeFileIo();
    const adapter = createLinuxSchedulerAdapter({ runner, fileIo });
    const result = await adapter.install(registration);
    expect(result.ok).toBe(true);
    // Field-specific escaping: ExecStart args escape BOTH $ (env
    // expansion) and % (specifiers), while WorkingDirectory only needs
    // %% for specifiers — a stray $$ there would prove blanket escaping.
    const unit = fileIo.files.get(serviceFile) ?? '';
    expect(unit).toContain('"/home/we$$ird %%dir/rel/index.js"');
    expect(unit).toContain('WorkingDirectory=/home/we$ird %%dir/.pd');
    const status = await adapter.status(registration);
    expect(status.ok).toBe(true);
  });
});
