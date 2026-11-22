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

/** All `Key=` values inside `[Section]` (comments, blank lines and other
 * sections are ignored — systemd semantics). Empty `Key=` lines are kept:
 * in systemd they RESET a list setting, so ownership must see them. */
function sectionSettings(content: string, section: string, key: string): string[] {
  const values: string[] = [];
  let inSection = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      inSection = header[1] === section;
      continue;
    }
    if (!inSection || line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const kv = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line);
    if (kv !== null && kv[1] === key) values.push((kv[2] ?? '').trim());
  }
  return values;
}

/**
 * systemd time-span → ms: `900s`, `15min`, `2h`, `1d`, `1w`, `1h30min`,
 * `1h 30min`, or a bare number (seconds). Composite expressions are summed
 * like systemd does; unknown units/leftover text yield null.
 */
export function parseSystemdDurationMs(value: string): number | null {
  const compact = value.trim().replace(/\s+/g, '');
  if (compact === '') return null;
  if (/^\d+(?:\.\d+)?$/.test(compact)) return Math.round(Number(compact) * 1000);
  const UNIT_MS: Record<string, number> = {
    us: 0.001,
    usec: 0.001,
    'µs': 0.001,
    ms: 1,
    msec: 1,
    s: 1000,
    sec: 1000,
    second: 1000,
    seconds: 1000,
    m: 60_000,
    min: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 604_800_000,
    week: 604_800_000,
    weeks: 604_800_000,
  };
  let rest = compact;
  let total = 0;
  while (rest.length > 0) {
    const match = /^(\d+(?:\.\d+)?)(usec|us|µs|msec|ms|seconds?|sec|s|minutes?|min|m|hours?|hr|h|days?|d|weeks?|w)/i.exec(rest);
    if (match === null) return null;
    const unit = UNIT_MS[(match[2] ?? '').toLowerCase()];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    rest = rest.slice(match[0].length);
  }
  return total > 0 ? Math.round(total) : null;
}

/** Parse `OnUnitActiveSec=` from the timer unit's [Timer] section. */
export function parseLinuxTimerIntervalMs(timerUnit: string): number | null {
  const values = sectionSettings(timerUnit, 'Timer', 'OnUnitActiveSec');
  const [value] = values;
  if (value === undefined) return null;
  return parseSystemdDurationMs(value);
}

/**
 * Escape a value for a non-command unit SETTING line (WorkingDirectory=,
 * Description=): systemd expands `%` specifiers there, but does NOT apply
 * `$`/`${}` environment substitution (that substitution only applies to
 * Exec* command lines and a few documented settings) — doubling `$` here
 * would leave a literal `$$` in the unit.
 */
function systemdSettingEscape(value: string): string {
  return value.replace(/%/g, '%%');
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

/** Inverse of systemdSettingEscape — `%` specifiers only (settings are
 * not env-substituted; a `$`/`$$` sequence is ambiguous → null). */
function unescapeSetting(value: string): string | null {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? '';
    if (ch === '%') {
      const next = value[index + 1];
      if (next === '%') {
        out += '%';
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
    // Section-scoped, multiplicity-aware ownership (review §5): systemd
    // allows several ExecStart= lines (each adds a command) and empty
    // `ExecStart=` resets the list — our unit declares exactly ONE
    // non-empty ExecStart inside [Service]; anything else is ambiguous.
    const execStarts = sectionSettings(content, 'Service', 'ExecStart');
    const workDirs = sectionSettings(content, 'Service', 'WorkingDirectory');
    if (execStarts.length !== 1 || execStarts[0] === '') return false;
    if (workDirs.length !== 1 || workDirs[0] === '') return false;
    const argv = splitExecStart(execStarts[0] ?? '');
    if (argv === null) return false;
    const expected = [registration.nodePath, ...schedulerInvocationArgs(registration)];
    if (argv.length !== expected.length) return false;
    if (!argv.every((token, index) => token === expected[index])) return false;
    const dir = unescapeSetting(workDirs[0] ?? '');
    return dir === registration.pdHome;
  }

  /**
   * Ownership verdict from the PARSED timer unit (task §4 review): the
   * timer's `Unit=` must point at THIS install's service unit — a foreign
   * timer driving a foreign service is never ours.
   */
  function timerOwnership(content: string, registration: SchedulerRegistration): boolean {
    // Exactly one `Unit=` pointer inside [Timer], pointing at OUR service.
    const units = sectionSettings(content, 'Timer', 'Unit');
    return units.length === 1 && units[0] === serviceUnitName(registration);
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
  /** stderr phrases that are systemd's definitive "manager has no such
   * unit" answer (search-path miss, never loaded, or systemd 254+ exit 4). */
  const UNIT_NOT_FOUND = /not[- ]found|no such unit|could not be found|no such file or directory|no files found/i;

  /**
   * `is-enabled` verdict — evidence classes only, never stderr inference
   * (task review §3.1): only an explicit stdout verdict decides
   * enabled/disabled; a not-found phrase decides not_found; EVERY other
   * outcome — permission denied, empty output, spawn failure, timeout, a
   * dead user bus, an unrecognized exit code/text — is `unreadable`
   * (UNKNOWN), never folded into "disabled".
   */
  async function enabledVerdict(
    registration: SchedulerRegistration,
  ): Promise<{ enabled: boolean | null; state: 'enabled' | 'disabled' | 'not_found' | 'unreadable'; unreadableReason?: string }> {
    const result = await systemctl(['is-enabled', timerUnitName(registration)]);
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.spawnError !== undefined) {
      return { enabled: null, state: 'unreadable', unreadableReason: `systemctl_is_enabled_failed:spawn:${result.spawnError.slice(0, 120)}` };
    }
    if (result.code === 0) {
      if (stdout === 'enabled' || stdout === 'enabled-runtime' || stdout === 'alias') {
        return { enabled: true, state: 'enabled' };
      }
      // static/indirect/generated/masked-runtime etc. are enablement states
      // the contract cannot classify — they stay UNKNOWN, never disabled.
      return { enabled: null, state: 'unreadable', unreadableReason: `systemd_unit_unexpected_state:${stdout.slice(0, 60)}` };
    }
    // Non-zero exit: only an explicit verdict line counts as evidence.
    if (stdout === 'disabled') {
      return { enabled: false, state: 'disabled' };
    }
    // 'masked' cannot fire and cannot be enabled — a stronger form of
    // disabled that satisfies "not enabled" but is still explicit stdout.
    if (stdout === 'masked' || stdout === 'masked-runtime') {
      return { enabled: false, state: 'disabled' };
    }
    if (stdout === 'not-found' || UNIT_NOT_FOUND.test(stderr)) {
      // Exit 4 + "not-found" (systemd 254+), exit 1 + "Failed to get unit
      // file state ... No such file", etc. — positive not-registered.
      return { enabled: null, state: 'not_found' };
    }
    return {
      enabled: null,
      state: 'unreadable',
      unreadableReason: `systemctl_is_enabled_failed:${result.code ?? 'spawn'}:${(stderr || stdout || 'no output').slice(0, 120)}`,
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
  /**
   * Manager view of BOTH units via `systemctl cat` (review §3.5):
   * `cat` prints `# /resolved/path` headers — the primary file for each
   * unit must be OUR file (a same-name unit elsewhere in the search path
   * shadows ours → ambiguous), and any `*.d/*.conf` drop-in makes the
   * effective unit different from the file we verified → ambiguous.
   */
  async function managerUnitView(
    registration: SchedulerRegistration,
  ): Promise<{ seen: true; shadowed?: string } | { seen: false; unreadableReason?: string }> {
    const units: [string, string][] = [
      [serviceUnitName(registration), serviceUnitPath(registration)],
      [timerUnitName(registration), timerUnitPath(registration)],
    ];
    for (const [name, file] of units) {
      const result = await systemctl(['cat', name]);
      if (result.code !== 0) {
        if (result.spawnError === undefined && (UNIT_NOT_FOUND.test(result.stderr) || (result.code === 1 && result.stderr.trim() === ''))) {
          return { seen: false };
        }
        return {
          seen: false,
          unreadableReason: `systemctl_cat_failed:${result.code ?? 'spawn'}:${(result.spawnError ?? result.stderr.trim()).slice(0, 120)}`,
        };
      }
      const headers = [...result.stdout.matchAll(/^#\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
      const primary = headers.find((h) => h.endsWith('.service') || h.endsWith('.timer'));
      if (primary !== undefined && primary !== file) {
        return { seen: true, shadowed: `resolved_path:${primary}` };
      }
      const dropIn = headers.find((h) => /\.d\/[^/]+\.conf$/.test(h));
      if (dropIn !== undefined) {
        return { seen: true, shadowed: `drop_in:${dropIn}` };
      }
    }
    return { seen: true };
  }

  /** Both units must be definitively gone from the manager's view. */
  async function managerUnitsGone(
    registration: SchedulerRegistration,
  ): Promise<{ gone: true } | { gone: false; still: string } | { gone: null; unreadableReason: string }> {
    for (const name of [serviceUnitName(registration), timerUnitName(registration)]) {
      const result = await systemctl(['cat', name]);
      if (result.code === 0) return { gone: false, still: name };
      if (result.spawnError === undefined && (UNIT_NOT_FOUND.test(result.stderr) || (result.code === 1 && result.stderr.trim() === ''))) {
        continue;
      }
      return {
        gone: null,
        unreadableReason: `systemctl_cat_failed:${result.code ?? 'spawn'}:${(result.spawnError ?? result.stderr.trim()).slice(0, 120)}`,
      };
    }
    return { gone: true };
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
          // A partial registration completes only when the present file is
          // provably OURS — a foreign leftover is still a refusal.
          if (existingService.ok && !serviceOwnership(existingService.content, registration)) {
            return {
              ok: false,
              kind: 'external_conflict',
              reason: 'systemd_unit_conflict_foreign_unit',
              nextAction: `${serviceFile} exists but its ExecStart/WorkingDirectory do not match this PD install; PD never overwrites foreign systemd units. Inspect it manually.`,
            };
          }
          if (existingTimer.ok && !timerOwnership(existingTimer.content, registration)) {
            return {
              ok: false,
              kind: 'external_conflict',
              reason: 'systemd_timer_conflict_foreign_unit',
              nextAction: `${timerFile} exists but its Unit= does not point at this PD install's service; PD never overwrites foreign systemd units. Inspect it manually.`,
            };
          }
          // own partial leftover from a failed first install → the writes
          // below complete the pair (first-install rollback normally
          // removes leftovers; this path is the safe resume).
        } else {
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
      }

      // Refresh semantics (task §15): an existing OWN registration keeps
      // its interval — only the node/CLI entry and args move forward —
      // UNLESS the caller explicitly passed a new --interval-ms. An
      // UNPARSEABLE existing interval must refuse BEFORE writing: silently
      // falling back to the default would clobber an unknown schedule.
      const preservedInterval = existingTimer.ok && registration.intervalExplicit !== true
        ? parseLinuxTimerIntervalMs(existingTimer.content)
        : null;
      if (existingTimer.ok && registration.intervalExplicit !== true && preservedInterval === null) {
        return {
          ok: false,
          kind: 'unsafe_state',
          reason: 'systemd_timer_interval_unparseable',
          nextAction: `The existing timer's OnUnitActiveSec in ${timerFile} could not be parsed — PD refuses to overwrite an unknown interval with a default. Fix the value manually or pass --interval-ms explicitly, then retry.`,
        };
      }
      const effective: SchedulerRegistration = preservedInterval !== null
        ? { ...registration, intervalMs: preservedInterval }
        : registration;

      const dir = unitDir(registration);
      const mkdir = fileIo.mkdirs(dir);
      if (!mkdir.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_unit_dir_unwritable:${mkdir.reason.slice(0, 80)}`, nextAction: `Could not create ${dir}; check permissions and retry pd service install.` };
      }
      // Refresh failure must restore the ORIGINAL files — a half-rewritten
      // pair is never left behind (review §5). A first install has no
      // original: its rollback removes the file this call created.
      const priorService = existingService.ok ? existingService.content : null;
      const priorTimer = existingTimer.ok ? existingTimer.content : null;
      const rollbackUnit = (file: string, prior: string | null, reason: string): string => {
        if (prior === null) {
          const removed = fileIo.remove(file);
          return removed.ok ? reason : `${reason}+rollback_remove_failed:${file}:${removed.reason.slice(0, 60)}`;
        }
        const restored = fileIo.writeAtomic(file, prior);
        return restored.ok ? reason : `${reason}+rollback_restore_failed:${file}:${restored.reason.slice(0, 60)}`;
      };

      const writtenService = fileIo.writeAtomic(serviceFile, buildLinuxServiceUnit(effective));
      if (!writtenService.ok) {
        return { ok: false, kind: 'command_failed', reason: `systemd_service_write_failed:${writtenService.reason.slice(0, 80)}`, nextAction: `Could not write ${serviceFile}; retry pd service install after fixing the filesystem issue.` };
      }
      const writtenTimer = fileIo.writeAtomic(timerFile, buildLinuxTimerUnit(effective));
      if (!writtenTimer.ok) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: rollbackUnit(serviceFile, priorService, `systemd_timer_write_failed:${writtenTimer.reason.slice(0, 80)}`),
          nextAction: `Could not write ${timerFile}; the service unit was rolled back to its previous content (or removed for a first install). Re-run pd service install.`,
        };
      }
      const rollbackBoth = (reason: string): string =>
        rollbackUnit(timerFile, priorTimer, rollbackUnit(serviceFile, priorService, reason));
      const reload = await systemctl(['daemon-reload']);
      if (reload.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: rollbackBoth(`systemctl_daemon_reload_failed:${reload.code ?? 'spawn'}:${(reload.spawnError ?? reload.stderr).trim().slice(0, 120)}`),
          nextAction: 'Unit files were written but `systemctl --user daemon-reload` failed; the files were rolled back to their previous content (or removed for a first install). Fix the cause (a dead user bus usually means no active login session) and re-run pd service install.',
        };
      }
      // Task §12 review: never report registered when the manager cannot
      // see BOTH units (HOME/XDG_CONFIG_HOME search-path mismatch). A
      // resolved path that is not our file, or a *.d/*.conf drop-in, makes
      // the effective unit ambiguous → refuse, never claim it ours.
      const view = await managerUnitView(registration);
      if (!view.seen) {
        if (view.unreadableReason === undefined) {
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
          reason: rollbackBoth(view.unreadableReason),
          nextAction: 'The unit files were written but PD could not verify the manager sees them; the files were rolled back to their previous content. Inspect the stderr above and re-run pd service install.',
        };
      }
      if (view.shadowed !== undefined) {
        return {
          ok: false,
          kind: 'unsafe_state',
          reason: rollbackBoth(`systemd_unit_ambiguous_manager_view:${view.shadowed.slice(0, 100)}`),
          nextAction: `The written units are ours, but the manager's effective unit resolves differently (${view.shadowed}) — a same-name unit elsewhere or a drop-in changes what systemd would run; the files were rolled back. Inspect \`systemctl --user cat\` and resolve the conflict, then re-run pd service install.`,
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
      // Drop-ins or a same-name unit elsewhere make the EFFECTIVE unit
      // different from the file we verified → ambiguous, refuse to arm it.
      const view = await managerUnitView(registration);
      if (view.seen && view.shadowed !== undefined) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: `systemd_unit_ambiguous_manager_view:${view.shadowed.slice(0, 100)}`,
          nextAction: `The manager's effective unit resolves via ${view.shadowed} — a drop-in or same-name unit changes what systemd would run; PD refuses to modify an ambiguous registration. Inspect \`systemctl --user cat\` manually.`,
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
      // exit code alone is not proof — BOTH is-enabled and is-active must
      // positively answer; either UNKNOWN means the enable is unverified.
      const verified = await gatherFacts(registration);
      if (verified.enabled !== true || verified.active !== true) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_enable_unverified',
          nextAction: '`systemctl --user enable --now` returned success but `is-enabled`/`is-active` do not positively report enabled+active. Run pd service status to inspect and retry.',
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
      const view = await managerUnitView(registration);
      if (view.seen && view.shadowed !== undefined) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: `systemd_unit_ambiguous_manager_view:${view.shadowed.slice(0, 100)}`,
          nextAction: `The manager's effective unit resolves via ${view.shadowed} — a drop-in or same-name unit changes what systemd would run; PD refuses to modify an ambiguous registration. Inspect \`systemctl --user cat\` manually.`,
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
      // "无法证明停止时不得返回成功" — require POSITIVE disabled+inactive
      // evidence; an unreadable verdict (query timeout/failure) is not
      // proof of stopped and must fail closed, not report success.
      const verified = await gatherFacts(registration);
      if (verified.enabled !== false || verified.active !== false) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_disable_unverified',
          nextAction: '`systemctl --user disable --now` returned success but the timer does not positively report disabled and inactive. Run pd service status to inspect and retry.',
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
        const notFound = /not[- ]found|no such unit|could not be found|no such file|does not exist/i.test(stderr);
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
      // 2. Confirm inactive + disabled before deleting (task §4): require
      // POSITIVE stopped evidence — `not_found` (the manager provably has
      // no such timer) or `disabled` for enablement, and an explicit
      // inactive answer for activity. An UNREADABLE verdict is not proof;
      // treat it as still-live and refuse to delete.
      const enabled = await enabledVerdict(registration);
      const active = await activeVerdict(registration);
      const provablyDisabled = enabled.enabled === false || enabled.state === 'not_found';
      if (!provablyDisabled || active.active !== false) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: 'systemd_uninstall_unverified',
          nextAction: 'The timer does not positively report disabled and inactive after disable (enabled/active may still be true or unreadable); the unit files were NOT removed. Inspect with pd service status and re-run pd service uninstall.',
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
      // BOTH units must be definitively gone from the manager's view —
      // an unreadable manager query is UNKNOWN, not success.
      const gone = await managerUnitsGone(registration);
      if (gone.gone !== true) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: gone.gone === false ? 'systemd_uninstall_unverified' : `systemd_uninstall_unverified:${gone.unreadableReason.slice(0, 80)}`,
          nextAction: gone.gone === false
            ? `The unit files were removed but the manager still resolves ${gone.still} — a stale registration may exist in another unit directory. Inspect \`systemctl --user cat ${gone.still}\` manually.`
            : 'The unit files were removed but the manager state could not be verified — the removal is on disk but OS-visible state is UNKNOWN. Re-run pd service uninstall once systemctl answers.',
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
