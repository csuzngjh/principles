/**
 * Linux scheduler adapter — systemd --user service + timer (SPEC §10.2,
 * task §3.4).
 *
 * Registration: `<user-unit-dir>/pd-service-host-<key>.service` + `.timer`
 * (current user units only — never a root/system unit). Unit files are
 * written atomically; every `systemctl --user` failure (including
 * daemon-reload and bus-unavailable states) is reported honestly — an
 * unreadable enabled/active state is NEVER folded into "not installed" /
 * "disabled" / "inactive" (task §13 review).
 *
 * Dual-unit contract (task §4 review): the registration is the PAIR —
 * install, status, enable, disable and uninstall check BOTH unit files
 * independently; each must parse as this install's own unit (the service's
 * ExecStart/WorkingDirectory, the timer's Unit= pointer) or PD refuses to
 * touch it. The uninstall sequence verifies ownership first, stops and
 * disables the timer CHECKING each command's result, CONFIRMS inactive and
 * disabled via independent queries, only then removes the files, reloads
 * the manager and re-verifies the registration is gone.
 *
 * Unit-search-path semantics (task §12 review): PD writes under
 * `<home>/.config/systemd/user` — the manager's default search path. A
 * mismatched HOME / XDG_CONFIG_HOME makes the manager unable to see the
 * written units; install therefore ends by asking the manager
 * (`is-enabled` / `cat`) whether it can see the unit, and refuses to
 * report "registered" when it cannot.
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
  SchedulerFacts,
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

/**
 * Escape a value for a unit-file SETTING line (WorkingDirectory=,
 * Description=): systemd expands `%` specifiers and `$`/`${}` environment
 * references inside settings, so a literal `%` becomes `%%` and a literal
 * `$` becomes `$$` (task §7 review — an install path containing `%` or `$`
 * previously produced a broken or mis-expanded unit).
 */
function systemdSettingEscape(value: string): string {
  // '$$$$' in a JS replacement emits '$$' — a literal dollar in unit syntax.
  return value.replace(/%/g, '%%').replace(/\$/g, '$$$$');
}

/**
 * Quote one ExecStart argv token (task §7 review): double-quote the token
 * and escape, in order, `%` → `%%` (specifier), `$` → `$$` (env
 * expansion), `\` → `\\` and `"` → `\"` (quote syntax). The previous
 * serializer escaped only `\` and `"`, silently corrupting paths like
 * `/home/$USER dir` or `C:\proj%` on real hosts.
 */
export function systemdQuote(value: string): string {
  const escaped = value
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Inverse of systemdQuote for ownership parsing (task §5 review): strips
 * the surrounding quotes and reverses `\\` → `\`, `\"` → `"`, `%%` → `%`,
 * `$$` → `$`. Returns null when the quoting is malformed — a malformed
 * ExecStart is a FOREIGN unit, never ours to touch.
 */
function systemdUnquote(token: string): string | null {
  if (!token.startsWith('"') || !token.endsWith('"')) return null;
  const inner = token.slice(1, -1);
  let out = '';
  for (let index = 0; index < inner.length; index += 1) {
    const ch = inner[index] ?? '';
    if (ch === '\\') {
      const next = inner[index + 1];
      if (next === '\\' || next === '"') {
        out += next;
        index += 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '%' || ch === '$') {
      const next = inner[index + 1];
      if (next === ch) {
        out += ch;
        index += 1;
        continue;
      }
      return null;
    }
    out += ch;
  }
  return out;
}

/** Split an ExecStart line into its argv tokens (whitespace-separated, quote-aware). */
function splitExecStart(value: string): string[] | null {
  const tokens: string[] = [];
  const raw = value.trim();
  for (let index = 0; index < raw.length;) {
    while (index < raw.length && /\s/.test(raw[index] ?? '')) index += 1;
    if (index >= raw.length) break;
    const start = index;
    if (raw[index] === '"') {
      index += 1;
      let escaped = false;
      while (index < raw.length) {
        const ch = raw[index] ?? '';
        if (!escaped && ch === '"') { index += 1; break; }
        if (!escaped && ch === '\\') { escaped = true; }
        else { escaped = false; }
        index += 1;
      }
      const token = systemdUnquote(raw.slice(start, index));
      if (token === null) return null;
      tokens.push(token);
    } else {
      while (index < raw.length && !/\s/.test(raw[index] ?? '')) index += 1;
      tokens.push(raw.slice(start, index));
    }
  }
  return tokens;
}

/** Value of a `Key=` line in a unit file (first match wins, like systemd). */
function unitSetting(content: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(content);
  return match === null ? null : (match[1] ?? '').trim();
}

function unescapeSetting(value: string): string | null {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? '';
    if ((ch === '%' || ch === '$')) {
      const next = value[index + 1];
      if (next === ch) {
        out += ch;
        index += 1;
        continue;
      }
      return null;
    }
    out += ch;
  }
  return out;
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
    `Description=PD Service Host managed run-once (pdHome=${systemdSettingEscape(registration.pdHome)})`,
    'Documentation=https://github.com/csuzngjh/principles',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${systemdSettingEscape(registration.pdHome)}`,
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
  function serviceUnitName(registration: SchedulerRegistration): string {
    return `${registration.identity.linuxUnitBase}.service`;
  }

  /**
   * Ownership verdict from the PARSED service unit (task §5 review):
   * ExecStart must decode to exactly [nodePath, ...schedulerInvocationArgs]
   * and WorkingDirectory to exactly this pdHome. A unit merely CONTAINING
   * our path strings inside another job definition is foreign.
   */
  function serviceOwnership(content: string, registration: SchedulerRegistration): boolean {
    const execStart = unitSetting(content, 'ExecStart');
    const workDir = unitSetting(content, 'WorkingDirectory');
    if (execStart === null || workDir === null) return false;
    const argv = splitExecStart(execStart);
    if (argv === null) return false;
    const expected = [registration.nodePath, ...schedulerInvocationArgs(registration)];
    if (argv.length !== expected.length) return false;
    if (!argv.every((token, index) => token === expected[index])) return false;
    const dir = unescapeSetting(workDir);
    return dir === registration.pdHome;
  }

  /**
   * Ownership verdict from the PARSED timer unit (task §4 review): the
   * timer's `Unit=` must point at THIS install's service unit — a foreign
   * timer driving a foreign service is never ours.
   */
  function timerOwnership(content: string, registration: SchedulerRegistration): boolean {
    return unitSetting(content, 'Unit') === serviceUnitName(registration);
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
   * `is-enabled` verdict (task §13 review): distinguishes
   * enabled / disabled / masked / not-found / command-failure.
   * A not-found or manager-unavailable answer is NEVER folded into
   * "disabled" — it is its own evidence class.
   */
  async function enabledVerdict(
    registration: SchedulerRegistration,
  ): Promise<{ enabled: boolean | null; state: 'enabled' | 'disabled' | 'not_found' | 'unreadable'; unreadableReason?: string }> {
    const result = await systemctl(['is-enabled', timerUnitName(registration)]);
    if (result.code === 0) {
      const stdout = result.stdout.trim();
      if (stdout === 'enabled' || stdout === 'enabled-runtime' || stdout === 'alias') {
        return { enabled: true, state: 'enabled' };
      }
      // static/indirect/generated units fire via dependencies, not a timer
      // enablement — treated as not-enabled for our purposes but recorded.
      return { enabled: null, state: 'unreadable', unreadableReason: `systemd_unit_unexpected_state:${stdout.slice(0, 60)}` };
    }
    const stderr = result.stderr.trim();
    if (result.code === 1) {
      if (/not[- ]found|no such unit|could not be found/i.test(stderr)) {
        return { enabled: null, state: 'not_found' };
      }
      if (/disabled/i.test(result.stdout) || stderr === '' || !/failed|error|bus/i.test(stderr)) {
        return { enabled: false, state: 'disabled' };
      }
    }
    return {
      enabled: null,
      state: 'unreadable',
      unreadableReason: `systemctl_is_enabled_failed:${result.code ?? 'spawn'}:${(result.spawnError ?? stderr).slice(0, 120)}`,
    };
  }

  /**
   * `is-active` verdict (task §14 review): independently queries whether the
   * timer is ACTIVE. An unreadable active-state stays null — never folded
   * into enabled/disabled.
   */
  async function activeVerdict(
    registration: SchedulerRegistration,
  ): Promise<{ active: boolean | null; unreadableReason?: string }> {
    const result = await systemctl(['is-active', timerUnitName(registration)]);
    const stdout = result.stdout.trim();
    if (result.code === 0 && stdout === 'active') return { active: true };
    if (stdout === 'inactive' || stdout === 'failed' || stdout === 'deactivating') return { active: false };
    if (result.code === 3 || result.code === 4) return { active: false };
    return {
      active: null,
      unreadableReason: `systemctl_is_active_failed:${result.code ?? 'spawn'}:${(result.spawnError ?? (result.stderr.trim() || stdout)).slice(0, 120)}`,
    };
  }

  /**
   * Whether the manager can SEE the written unit (task §12 review): after
   * writing the units PD asks the manager for them — a not-found answer
   * means the unit dir is outside the manager's search path (HOME/XDG
   * mismatch) and "registered" must not be reported.
   */
  async function managerSeesUnit(
    registration: SchedulerRegistration,
  ): Promise<{ seen: boolean; unreadableReason?: string }> {
    const result = await systemctl(['cat', serviceUnitName(registration)]);
    if (result.code === 0) return { seen: true };
    if (/not[- ]found|no such unit|could not be found|no files found/i.test(result.stderr)) return { seen: false };
    if (result.code === 1 && result.stderr.trim() === '') return { seen: false };
    return {
      seen: false,
      unreadableReason: `systemctl_cat_failed:${result.code ?? 'spawn'}:${(result.spawnError ?? result.stderr.trim()).slice(0, 120)}`,
    };
  }

  interface ServiceFacts {
    readonly lastResult: string | null;
    readonly lastRunAt: string | null;
    readonly unreadableReason?: string;
  }

  /** Last execution status/timestamp from `systemctl show` (absent = null). */
  async function serviceFacts(registration: SchedulerRegistration): Promise<ServiceFacts> {
    const show = await systemctl([
      'show', serviceUnitName(registration),
      '--property=ExecMainStatus', '--property=ExecMainExitTimestamp', '--value',
    ]);
    if (show.code !== 0) {
      return {
        lastResult: null,
        lastRunAt: null,
        unreadableReason: `systemctl_show_failed:${show.code ?? 'spawn'}:${(show.spawnError ?? show.stderr.trim()).slice(0, 120)}`,
      };
    }
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

  function baseFacts(registration: SchedulerRegistration, fields: Partial<SchedulerFacts>): SchedulerFacts {
    return {
      platform: 'linux',
      taskName: timerUnitName(registration),
      registered: null,
      enabled: null,
      active: null,
      lastRunAt: null,
      lastResult: null,
      ...fields,
    };
  }

  /** Facts gathered after a mutation — each witness read independently. */
  async function gatherFacts(registration: SchedulerRegistration): Promise<SchedulerFacts> {
    const enabled = await enabledVerdict(registration);
    const active = await activeVerdict(registration);
    const facts = await serviceFacts(registration);
    const degraded: string[] = [];
    if (enabled.unreadableReason !== undefined) degraded.push(enabled.unreadableReason);
    if (active.unreadableReason !== undefined) degraded.push(active.unreadableReason);
    if (facts.unreadableReason !== undefined) degraded.push(facts.unreadableReason);
    return baseFacts(registration, {
      registered: true,
      enabled: enabled.enabled,
      active: active.active,
      lastRunAt: facts.lastRunAt,
      lastResult: facts.lastResult,
      ...(degraded.length > 0 ? { degradedReasons: degraded } : {}),
    });
  }

  async function status(registration: SchedulerRegistration): Promise<SchedulerOperationResult> {
    const serviceFile = serviceUnitPath(registration);
    const timerFile = timerUnitPath(registration);
    const service = fileIo.readIfExists(serviceFile);
    const timer = fileIo.readIfExists(timerFile);
    if (service.ok && timer.ok) {
      if (!serviceOwnership(service.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: `${serviceFile} exists but its ExecStart/WorkingDirectory do not match this PD install (${registration.pdHome}); PD refuses to touch foreign units. Inspect it manually.`,
        };
      }
      if (!timerOwnership(timer.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_timer_conflict_foreign_unit',
          nextAction: `${timerFile} exists but its Unit= does not point at this PD install's service; PD refuses to touch foreign units. Inspect it manually.`,
        };
      }
      const facts = await gatherFacts(registration);
      return {
        ok: true,
        changed: false,
        facts: { ...facts, triggerIntervalMs: parseLinuxTimerIntervalMs(timer.content) },
      };
    }
    if (unitState(service) === 'missing' && unitState(timer) === 'missing') {
      return {
        ok: true,
        changed: false,
        facts: baseFacts(registration, { registered: false, enabled: false, active: false }),
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

      if (unitState(existingService) !== 'missing' || unitState(existingTimer) !== 'missing') {
        if (unitState(existingService) === 'unreadable' || unitState(existingTimer) === 'unreadable') {
          return unreadableRegistration(registration, unitDetail(existingService) + '/' + unitDetail(existingTimer));
        }
        if (!existingService.ok || !existingTimer.ok) {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'systemd_units_partial_registration',
            nextAction: 'A partial unit registration exists (service without timer or vice versa). Inspect the unit directory, remove leftovers manually if they are yours, then re-run pd service install.',
          };
        }
        // Each unit is verified independently (task §4): a foreign service
        // AND a foreign timer are two separate refusal paths.
        if (!serviceOwnership(existingService.content, registration)) {
          return {
            ok: false,
            kind: 'external_conflict',
            reason: 'systemd_unit_conflict_foreign_unit',
            nextAction: `${serviceFile} already exists but its ExecStart/WorkingDirectory do not match this PD install; PD never overwrites foreign systemd units.`,
          };
        }
        if (!timerOwnership(existingTimer.content, registration)) {
          return {
            ok: false,
            kind: 'external_conflict',
            reason: 'systemd_timer_conflict_foreign_unit',
            nextAction: `${timerFile} already exists but its Unit= does not point at this PD install's service; PD never overwrites foreign systemd units.`,
          };
        }
        // Idempotent: our own units — rewrite with the current definition
        // (refresh) and reload; the enabled state is systemd enablement
        // state, PRESERVED by not touching enable/disable here.
      }

      // Refresh semantics (task §15): an existing OWN registration keeps
      // its interval — only the node/CLI entry and args move forward.
      const preservedInterval = existingTimer.ok
        ? parseLinuxTimerIntervalMs(existingTimer.content)
        : null;
      const effective: SchedulerRegistration = preservedInterval !== null
        ? { ...registration, intervalMs: preservedInterval }
        : registration;

      const dir = unitDir(registration);
      const mkdir = fileIo.mkdirs(dir);
      if (!mkdir.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_unit_dir_unwritable:${mkdir.reason.slice(0, 80)}`, nextAction: `Could not create ${dir}; check permissions and retry pd service install.` };
      }
      const writtenService = fileIo.writeAtomic(serviceFile, buildLinuxServiceUnit(effective));
      if (!writtenService.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_service_write_failed:${writtenService.reason.slice(0, 80)}`, nextAction: `Could not write ${serviceFile}; retry pd service install after fixing the filesystem issue.` };
      }
      const writtenTimer = fileIo.writeAtomic(timerFile, buildLinuxTimerUnit(effective));
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
      // Task §12 review: never report registered when the manager cannot
      // see the unit (HOME/XDG_CONFIG_HOME search-path mismatch).
      const seen = await managerSeesUnit(registration);
      if (!seen.seen) {
        if (seen.unreadableReason === undefined) {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'systemd_unit_not_in_manager_search_path',
            nextAction: `The unit files were written to ${dir} and daemon-reload succeeded, but the user manager cannot see them — this usually means HOME/XDG_CONFIG_HOME differs from where PD writes (<home>/.config/systemd/user). Fix the environment so the manager's search path includes the unit dir, then re-run pd service install.`,
          };
        }
        return {
          ok: false,
          kind: 'command_failed',
          reason: seen.unreadableReason,
          nextAction: 'The unit files were written but PD could not verify the manager sees them. Inspect the stderr above and re-run pd service install.',
        };
      }
      const facts = await gatherFacts(registration);
      return {
        ok: true,
        changed: true,
        facts: { ...facts, triggerIntervalMs: effective.intervalMs },
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
      if (!serviceOwnership(service.content, registration) || !timerOwnership(timer.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: 'The unit pair is not PD\'s own registration; PD refuses to modify foreign systemd units.',
        };
      }
      const already = await enabledVerdict(registration);
      const active = await activeVerdict(registration);
      if (already.enabled === true && active.active === true) {
        const facts = await gatherFacts(registration);
        return {
          ok: true,
          changed: false,
          facts,
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
      // Verify before reporting enabled (task §4/§14): the enable command's
      // exit code alone is not proof the timer is armed + active.
      const verified = await gatherFacts(registration);
      if (verified.enabled !== true) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_enable_unverified',
          nextAction: '`systemctl --user enable --now` returned success but `is-enabled` does not report the timer enabled. Run pd service status to inspect and retry.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: verified,
      };
    },

    async disable(registration) {
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
            nextAction: 'No systemd user registration exists for this install; nothing to disable.',
          };
        }
        return unreadableRegistration(registration, unitDetail(service) + '/' + unitDetail(timer));
      }
      if (!serviceOwnership(service.content, registration) || !timerOwnership(timer.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: 'The unit pair is not PD\'s own registration; PD refuses to modify foreign systemd units.',
        };
      }
      const already = await enabledVerdict(registration);
      const activeBefore = await activeVerdict(registration);
      if (already.enabled === false && activeBefore.active === false) {
        const facts = await gatherFacts(registration);
        return {
          ok: true,
          changed: false,
          facts,
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
      // "无法证明停止时不得返回成功" — verify disabled AND inactive.
      const verified = await gatherFacts(registration);
      if (verified.enabled === true || verified.active === true) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_disable_unverified',
          nextAction: '`systemctl --user disable --now` returned success but the timer still reports enabled or active. Run pd service status to inspect and retry.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: verified,
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
          facts: baseFacts(registration, { registered: false, enabled: false, active: false }),
        };
      }
      if (unitState(service) === 'unreadable' || unitState(timer) === 'unreadable') {
        return unreadableRegistration(registration, unitDetail(service) + '/' + unitDetail(timer));
      }
      // Verify ownership of BOTH units before touching anything (task §4).
      if (service.ok && !serviceOwnership(service.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_unit_conflict_foreign_unit',
          nextAction: `${serviceFile} is not PD's own unit; PD never deletes foreign systemd units. Inspect it manually.`,
        };
      }
      if (timer.ok && !timerOwnership(timer.content, registration)) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'systemd_timer_conflict_foreign_unit',
          nextAction: `${timerFile} is not PD's own unit; PD never deletes foreign systemd units. Inspect it manually.`,
        };
      }
      // Partial leftovers of OUR units are still removed below.
      // 1. Stop future triggers — CHECK the result (task §4: a failing
      //    disable previously still deleted the files and reported success).
      const disable = await systemctl(['disable', '--now', timerUnitName(registration)]);
      if (disable.code !== 0) {
        const stderr = disable.stderr.trim();
        const notFound = /not[- ]found|no such unit|could not be found/i.test(stderr);
        if (!notFound || disable.spawnError !== undefined) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `systemctl_disable_failed:${disable.code ?? 'spawn'}:${(disable.spawnError ?? stderr).slice(0, 120)}`,
            nextAction: '`systemctl --user disable --now` failed during uninstall; the unit files were NOT removed. Inspect the stderr above and re-run pd service uninstall.',
          };
        }
        // not-found: the manager already has no such unit — continue to
        // remove the on-disk files.
      }
      // 2. Confirm inactive + disabled before deleting (task §4).
      const enabled = await enabledVerdict(registration);
      const active = await activeVerdict(registration);
      if (enabled.enabled === true || active.active === true) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_uninstall_unverified',
          nextAction: 'The timer still reports enabled or active after disable; the unit files were NOT removed. Inspect with pd service status and re-run pd service uninstall.',
        };
      }
      // 3. Remove ONLY our unit files.
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
      // 4. daemon-reload + re-verify the registration is gone (task §4).
      const reload = await systemctl(['daemon-reload']);
      if (reload.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `systemctl_daemon_reload_failed:${reload.code ?? 'spawn'}:${(reload.spawnError ?? reload.stderr).trim().slice(0, 120)}`,
          nextAction: 'The unit files were removed but `systemctl --user daemon-reload` failed; the manager may hold a stale registration until the next reload or login. Re-run pd service uninstall (idempotent).',
        };
      }
      const seen = await managerSeesUnit(registration);
      if (seen.seen) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_uninstall_unverified',
          nextAction: 'The unit files were removed but the manager still resolves the service unit — a stale registration may exist in another unit directory. Inspect `systemctl --user cat` output manually.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: baseFacts(registration, { registered: false, enabled: false, active: false }),
      };
    },
  };
}
