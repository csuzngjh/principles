/**
 * Linux scheduler adapter — systemd --user service + timer (SPEC §10.2,
 * task §3.4).
 *
 * Registration: `~/.config/systemd/user/pd-service-host-<key>.service` +
 * `.timer` (current user units only — never a root/system unit). Unit files
 * are written atomically; every `systemctl --user` failure (including
 * daemon-reload and bus-unavailable states) is reported honestly — an
 * unreadable enabled state is NEVER reported as "not installed".
 *
 * Honest platform semantics (SPEC §10.2 audit): the user manager runs while
 * the user has a login session. `loginctl enable-linger` is NOT enabled by
 * PD (task §3.4) — running after logout is explicitly NOT a V1 default.
 *
 * IMPORTANT (task §9.F): unit-tested against a faked command boundary; real
 * Linux acceptance is recorded as NOT_VERIFIED until it runs on a real host.
 */
import * as path from 'node:path';
import { schedulerInvocationArgs } from './contract.js';
import type {
  SchedulerAdapter,
  SchedulerCommandRunner,
  SchedulerCommandResult,
  SchedulerFileIo,
  SchedulerOperationResult,
  SchedulerRegistration,
} from './contract.js';

/** Parse `OnUnitActiveSec=120s` / `90ms` / `2min` from the timer unit. */
export function parseLinuxTimerIntervalMs(timerUnit: string): number | null {
  const match = /^OnUnitActiveSec\s*=\s*(.+)$/m.exec(timerUnit);
  if (match === null) return null;
  const value = match[1]?.trim() ?? '';
  const minMatch = /^(\d+(?:\.\d+)?)min$/.exec(value);
  if (minMatch !== null) return Math.round(Number(minMatch[1] ?? 0) * 60_000);
  const secMatch = /^(\d+(?:\.\d+)?)s$/.exec(value);
  if (secMatch !== null) return Math.round(Number(secMatch[1] ?? 0) * 1000);
  const msMatch = /^(\d+(?:\.\d+)?)ms$/.exec(value);
  if (msMatch !== null) return Math.round(Number(msMatch[1] ?? 0));
  return null;
}

/** systemd ExecStart token: quote, and escape inner quotes/backslashes. */
function systemdQuote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function secondsDuration(intervalMs: number): string {
  if (intervalMs % 1000 === 0) return `${Math.round(intervalMs / 1000)}s`;
  return `${(intervalMs / 1000).toFixed(3)}s`;
}

/** The oneshot service unit. Exported for unit tests. */
export function buildLinuxServiceUnit(registration: SchedulerRegistration): string {
  const execStart = [registration.nodePath, ...schedulerInvocationArgs(registration)]
    .map(systemdQuote)
    .join(' ');
  return [
    '[Unit]',
    `Description=PD Service Host managed run-once (pdHome=${registration.pdHome})`,
    'Documentation=https://github.com/csuzngjh/principles',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${registration.pdHome}`,
    '',
  ].join('\n');
}

/** The repeating timer unit. Exported for unit tests. */
export function buildLinuxTimerUnit(registration: SchedulerRegistration): string {
  return [
    '[Unit]',
    'Description=PD Service Host periodic trigger',
    '',
    '[Timer]',
    `Unit=${registration.identity.linuxUnitBase}.service`,
    'OnBootSec=2min',
    `OnUnitActiveSec=${secondsDuration(registration.intervalMs)}`,
    'AccuracySec=30s',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

export interface LinuxSchedulerDeps {
  readonly runner: SchedulerCommandRunner;
  readonly fileIo: SchedulerFileIo;
}

export function createLinuxSchedulerAdapter(deps: LinuxSchedulerDeps): SchedulerAdapter {
  const { runner, fileIo } = deps;

  /** homeDir derived from the trusted pdHome (…/<home>/.pd → <home>). */
  function homeDirFor(registration: SchedulerRegistration): string {
    return path.dirname(registration.pdHome);
  }
  function unitDir(registration: SchedulerRegistration): string {
    return path.join(homeDirFor(registration), '.config', 'systemd', 'user');
  }
  function serviceUnitPath(registration: SchedulerRegistration): string {
    return path.join(unitDir(registration), `${registration.identity.linuxUnitBase}.service`);
  }
  function timerUnitPath(registration: SchedulerRegistration): string {
    return path.join(unitDir(registration), `${registration.identity.linuxUnitBase}.timer`);
  }
  function timerUnitName(registration: SchedulerRegistration): string {
    return `${registration.identity.linuxUnitBase}.timer`;
  }

  function ownershipVerdict(content: string, registration: SchedulerRegistration): boolean {
    // ExecStart carries systemd-quoted/escaped paths — special-char install
    // paths (task §3.4) must still match their own unit; the Description
    // line carries the raw pdHome.
    const entryMatches = content.includes(registration.cliEntry) || content.includes(systemdQuote(registration.cliEntry));
    const pdHomeMatches = content.includes(registration.pdHome);
    return entryMatches && pdHomeMatches;
  }

  type UnitRead = ReturnType<SchedulerFileIo['readIfExists']>;
  /** 'ok' | 'missing' | 'unreadable' — narrowing helper for the union result. */
  function unitState(read: UnitRead): 'ok' | 'missing' | 'unreadable' {
    if (read.ok) return 'ok';
    return read.reason;
  }
  function unitDetail(read: UnitRead): string {
    if (read.ok || read.detail === undefined) return 'unreadable';
    return read.detail;
  }

  async function systemctl(args: readonly string[]): Promise<SchedulerCommandResult> {
    return runner.run('systemctl', ['--user', ...args]);
  }

  /**
   * `is-enabled` mapping: 0 → enabled, 1 → disabled, anything else
   * (including a dead user bus or a missing systemctl) → UNREADABLE, never
   * silently "not installed" (task §5).
   */
  async function enabledVerdict(
    registration: SchedulerRegistration,
  ): Promise<{ enabled: boolean | null; unreadableReason?: string }> {
    const result = await systemctl(['is-enabled', timerUnitName(registration)]);
    if (result.code === 0) return { enabled: true };
    if (result.code === 1) return { enabled: false };
    return {
      enabled: null,
      unreadableReason: `systemctl_is_enabled_failed:${result.code ?? 'spawn'}:${(result.spawnError ?? result.stderr).trim().slice(0, 120)}`,
    };
  }

  interface ServiceFacts {
    readonly lastResult: string | null;
    readonly lastRunAt: string | null;
  }

  /** Last execution status/timestamp from `systemctl show` (absent = null). */
  async function serviceFacts(registration: SchedulerRegistration): Promise<ServiceFacts> {
    const show = await systemctl([
      'show', `${registration.identity.linuxUnitBase}.service`,
      '--property=ExecMainStatus', '--property=ExecMainExitTimestamp', '--value',
    ]);
    if (show.code !== 0) return { lastResult: null, lastRunAt: null };
    const lines = show.stdout.trim().split('\n');
    const lastResult = lines[0] !== undefined && lines[0].trim() !== '' ? lines[0].trim() : null;
    const lastRunAt = lines[1] !== undefined && lines[1].trim() !== '' ? lines[1].trim() : null;
    return { lastResult, lastRunAt };
  }

  function unreadableRegistration(registration: SchedulerRegistration, detail: string): SchedulerOperationResult {
    return {
      ok: false,
      kind: 'command_failed',
      reason: `systemd_unit_unreadable:${detail.slice(0, 120)}`,
      nextAction: `The unit files under ${unitDir(registration)} exist but cannot be read. PD does not treat an unreadable registration as "not installed" — fix permissions and re-run pd service status.`,
    };
  }

  async function status(registration: SchedulerRegistration): Promise<SchedulerOperationResult> {
    const serviceFile = serviceUnitPath(registration);
    const timerFile = timerUnitPath(registration);
    const service = fileIo.readIfExists(serviceFile);
    const timer = fileIo.readIfExists(timerFile);
    if (service.ok && timer.ok) {
      if (!ownershipVerdict(service.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: `${serviceFile} exists but does not reference this PD install (${registration.pdHome}); PD refuses to touch foreign units. Inspect it manually.`,
        };
      }
      const enabled = await enabledVerdict(registration);
      const facts = await serviceFacts(registration);
      return {
        ok: true,
        changed: false,
        facts: {
          platform: 'linux',
          taskName: timerUnitName(registration),
          registered: true,
          enabled: enabled.enabled,
          triggerIntervalMs: parseLinuxTimerIntervalMs(timer.content),
          lastRunAt: facts.lastRunAt,
          lastResult: facts.lastResult,
        },
      };
    }
    if (!service.ok && service.reason === 'missing' && !timer.ok && timer.reason === 'missing') {
      return {
        ok: true,
        changed: false,
        facts: {
          platform: 'linux',
          taskName: timerUnitName(registration),
          registered: false,
          enabled: false,
          lastRunAt: null,
          lastResult: null,
        },
      };
    }
    if (unitState(service) === 'unreadable' || unitState(timer) === 'unreadable') {
      return unreadableRegistration(registration, unitDetail(service) + '/' + unitDetail(timer));
    }
    // Partial registration (one of the two units) — unsafe, refuse to guess.
    return {
      ok: false,
      kind: 'unsafe_state',
      reason: 'systemd_units_partial_registration',
      nextAction: `Only one of ${serviceFile} / ${timerFile} exists. A partial registration is not a usable scheduler state — inspect both files, remove leftovers manually if they are yours, then re-run pd service install.`,
    };
  }

  return {
    platform: 'linux',

    async install(registration) {
      const serviceFile = serviceUnitPath(registration);
      const timerFile = timerUnitPath(registration);
      const existingService = fileIo.readIfExists(serviceFile);
      const existingTimer = fileIo.readIfExists(timerFile);

      if (existingService.ok || existingTimer.ok) {
        if (existingService.ok && !ownershipVerdict(existingService.content, registration)) {
          return {
            ok: false,
            kind: 'external_conflict',
            reason: 'systemd_unit_conflict_foreign_unit',
            nextAction: `${serviceFile} already exists but does not reference this PD install; PD never overwrites foreign systemd units.`,
          };
        }
        if (!existingService.ok || !existingTimer.ok) {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'systemd_units_partial_registration',
            nextAction: 'A partial unit registration exists (service without timer or vice versa). Inspect the unit directory, remove leftovers manually if they are yours, then re-run pd service install.',
          };
        }
        // Idempotent: our own units — rewrite with the current definition
        // (refresh) and reload; the enabled state is systemd enablement
        // state, PRESERVED by not touching enable/disable here.
      }

      const dir = unitDir(registration);
      const mkdir = fileIo.mkdirs(dir);
      if (!mkdir.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_unit_dir_unwritable:${mkdir.reason.slice(0, 80)}`, nextAction: `Could not create ${dir}; check permissions and retry pd service install.` };
      }
      const writtenService = fileIo.writeAtomic(serviceFile, buildLinuxServiceUnit(registration));
      if (!writtenService.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_service_write_failed:${writtenService.reason.slice(0, 80)}`, nextAction: `Could not write ${serviceFile}; retry pd service install after fixing the filesystem issue.` };
      }
      const writtenTimer = fileIo.writeAtomic(timerFile, buildLinuxTimerUnit(registration));
      if (!writtenTimer.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_timer_write_failed:${writtenTimer.reason.slice(0, 80)}`, nextAction: `Could not write ${timerFile}; the service unit is on disk but the pair is incomplete. Re-run pd service install (idempotent).` };
      }
      const reload = await systemctl(['daemon-reload']);
      if (reload.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `systemctl_daemon_reload_failed:${reload.code ?? 'spawn'}:${(reload.spawnError ?? reload.stderr).trim().slice(0, 120)}`,
          nextAction: 'Unit files were written but `systemctl --user daemon-reload` failed. The registration is on disk but not necessarily active — fix the cause (a dead user bus usually means no active login session) and re-run pd service install.',
        };
      }
      const enabled = await enabledVerdict(registration);
      return {
        ok: true,
        changed: true,
        facts: {
          platform: 'linux',
          taskName: timerUnitName(registration),
          registered: true,
          enabled: enabled.enabled,
          lastRunAt: null,
          lastResult: null,
        },
      };
    },

    async enable(registration) {
      const serviceFile = serviceUnitPath(registration);
      const timerFile = timerUnitPath(registration);
      const service = fileIo.readIfExists(serviceFile);
      const timer = fileIo.readIfExists(timerFile);
      if (!service.ok || !timer.ok) {
        if (unitState(service) === 'missing' || unitState(timer) === 'missing') {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'scheduler_not_registered',
            nextAction: 'No systemd user timer registration exists for this install. Run pd service install first — enable never creates one.',
          };
        }
        return unreadableRegistration(registration, unitDetail(service) + '/' + unitDetail(timer));
      }
      if (!ownershipVerdict(service.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: `${serviceFile} is not PD's own unit; PD refuses to modify it.`,
        };
      }
      const already = await enabledVerdict(registration);
      if (already.enabled === true) {
        const facts = await serviceFacts(registration);
        return {
          ok: true,
          changed: false,
          facts: { platform: 'linux', taskName: timerUnitName(registration), registered: true, enabled: true, lastRunAt: facts.lastRunAt, lastResult: facts.lastResult },
        };
      }
      const enable = await systemctl(['enable', '--now', timerUnitName(registration)]);
      if (enable.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `systemctl_enable_failed:${enable.code ?? 'spawn'}:${(enable.spawnError ?? enable.stderr).trim().slice(0, 120)}`,
          nextAction: '`systemctl --user enable --now` failed. A dead user bus usually means no active login session. Inspect the stderr above; the registration exists but will not fire until enabled.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: { platform: 'linux', taskName: timerUnitName(registration), registered: true, enabled: true, lastRunAt: null, lastResult: null },
      };
    },

    async disable(registration) {
      const serviceFile = serviceUnitPath(registration);
      const service = fileIo.readIfExists(serviceFile);
      if (!service.ok) {
        if (unitState(service) === 'missing') {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'scheduler_not_registered',
            nextAction: 'No systemd user registration exists for this install; nothing to disable.',
          };
        }
        return unreadableRegistration(registration, unitDetail(service));
      }
      if (!ownershipVerdict(service.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: `${serviceFile} is not PD's own unit; PD refuses to modify it.`,
        };
      }
      const already = await enabledVerdict(registration);
      if (already.enabled === false) {
        return {
          ok: true,
          changed: false,
          facts: { platform: 'linux', taskName: timerUnitName(registration), registered: true, enabled: false, lastRunAt: null, lastResult: null },
        };
      }
      const disable = await systemctl(['disable', '--now', timerUnitName(registration)]);
      if (disable.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `systemctl_disable_failed:${disable.code ?? 'spawn'}:${(disable.spawnError ?? disable.stderr).trim().slice(0, 120)}`,
          nextAction: '`systemctl --user disable --now` failed; future automatic triggers may still fire. Inspect the stderr above and retry.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: { platform: 'linux', taskName: timerUnitName(registration), registered: true, enabled: false, lastRunAt: null, lastResult: null },
      };
    },

    status,

    async uninstall(registration) {
      const serviceFile = serviceUnitPath(registration);
      const timerFile = timerUnitPath(registration);
      const service = fileIo.readIfExists(serviceFile);
      const timer = fileIo.readIfExists(timerFile);
      if (unitState(service) === 'missing' && unitState(timer) === 'missing') {
        return {
          ok: true,
          changed: false,
          facts: { platform: 'linux', taskName: timerUnitName(registration), registered: false, enabled: false, lastRunAt: null, lastResult: null },
        };
      }
      if (service.ok && !ownershipVerdict(service.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: `${serviceFile} is not PD's own unit; PD never deletes foreign systemd units. Inspect it manually.`,
        };
      }
      if (unitState(service) === 'unreadable' || unitState(timer) === 'unreadable') {
        return unreadableRegistration(registration, unitDetail(service) + '/' + unitDetail(timer));
      }
      // Stop future triggers first (ignore failures — the files go away next
      // and daemon-reload follows), then remove ONLY our unit files.
      await systemctl(['disable', '--now', timerUnitName(registration)]);
      const removed: string[] = [];
      for (const file of [serviceFile, timerFile]) {
        if (fileIo.exists(file)) {
          const result = fileIo.remove(file);
          if (!result.ok) {
            return {
              ok: false,
              kind: 'command_failed',
              reason: `systemd_unit_remove_failed:${result.reason.slice(0, 80)}`,
              nextAction: `Some unit files were removed (${removed.join(', ') || 'none'}) but ${file} could not be; remove it manually and re-run pd service uninstall to complete the daemon-reload.`,
            };
          }
          removed.push(file);
        }
      }
      const reload = await systemctl(['daemon-reload']);
      if (reload.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `systemctl_daemon_reload_failed:${reload.code ?? 'spawn'}:${(reload.spawnError ?? reload.stderr).trim().slice(0, 120)}`,
          nextAction: 'The unit files were removed but `systemctl --user daemon-reload` failed; the manager may hold a stale registration until the next reload or login. Re-run pd service uninstall (idempotent).',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: { platform: 'linux', taskName: timerUnitName(registration), registered: false, enabled: false, lastRunAt: null, lastResult: null },
      };
    },
  };
}
