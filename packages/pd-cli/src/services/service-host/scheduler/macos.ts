/**
 * macOS scheduler adapter — current-user LaunchAgent (SPEC §10.2, task §3.3).
 *
 * Registration: `~/Library/LaunchAgents/com.principles-disciple.service-host.<key>.plist`
 * with RunAtLoad + StartInterval. Managed with `launchctl bootstrap/bootout/
 * enable/disable` against the caller's own `gui/<uid>` domain — never a
 * LaunchDaemon, never root (task §3.3).
 *
 * Lifecycle contract (task §3 review):
 *  - install writes the plist + the log directory ONLY (no bootstrap, no
 *    Worker) and persistently DISABLES the label — a LaunchAgent left
 *    enabled would auto-load with RunAtLoad at the next login, which would
 *    break the installed_disabled contract;
 *  - enable verifies ownership, `launchctl enable`, then `bootstrap` when
 *    not loaded, and verifies the job is loaded before reporting enabled;
 *  - disable `launchctl disable` (persistent) + `bootout`, and verifies
 *    the job is actually unloaded — never reports stopped without proof;
 *  - status reads each witness independently (plist existence/ownership,
 *    launchd loaded state, launchd disabled flag); an unreadable witness
 *    yields unknown, never a guessed false;
 *  - uninstall verifies ownership, stops+unloads, then removes ONLY our
 *    own plist — an external same-label LaunchAgent is never deleted.
 *
 * Honest platform semantics (SPEC §10.2 audit): a LaunchAgent exists only
 * inside an interactive login session — no pre-login trigger, no trigger
 * after logout. This adapter never claims otherwise.
 *
 * IMPORTANT (task §9.F): this implementation is unit-tested against a faked
 * command boundary; real-platform acceptance on macOS is recorded as
 * NOT_VERIFIED until it runs on a real Darwin host.
 */
import * as path from 'node:path';
import plistLib from 'plist';
import { schedulerInvocationArgs } from './contract.js';
import type {
  SchedulerAdapter,
  SchedulerCommandRunner,
  SchedulerFacts,
  SchedulerFileIo,
  SchedulerOperationResult,
  SchedulerRegistration,
} from './contract.js';

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}



/** The LaunchAgent plist document. Exported for unit tests. */
export function buildMacosLaunchAgentPlist(registration: SchedulerRegistration): string {
  const programArguments = [
    registration.nodePath,
    ...schedulerInvocationArgs(registration),
  ].map((part) => `      <string>${escapeXml(part)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${escapeXml(registration.identity.macosLabel)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>StartInterval</key>',
    `  <integer>${Math.round(registration.intervalMs / 1000)}</integer>`,
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(registration.pdHome)}</string>`,
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(path.join(registration.pdHome, 'service', 'scheduler-stdout.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(path.join(registration.pdHome, 'service', 'scheduler-stderr.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface MacosSchedulerDeps {
  readonly runner: SchedulerCommandRunner;
  readonly fileIo: SchedulerFileIo;
  /** Injection point for tests; production = process.getuid(). */
  readonly getUid?: () => number | undefined;
}

/** Parse `<key>StartInterval</key><integer>N</integer>` (seconds) from the plist. */
export function parseMacosStartIntervalMs(plist: string): number | null {
  const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/i.exec(plist);
  if (match === null) return null;
  const seconds = Number(match[1] ?? 0);
  return seconds > 0 ? seconds * 1000 : null;
}

/** Parsed plist fields the ownership verdict inspects (structural, not substring). */
interface ParsedLaunchAgent {
  readonly label: string | null;
  readonly programArguments: readonly string[] | null;
  readonly workingDirectory: string | null;
}

/**
 * The complete set of keys a PD-built LaunchAgent may declare (see
 * buildMacosLaunchAgentPlist). Any additional top-level key — an extra
 * trigger like StartCalendarInterval, environment overrides, or an
 * unexpected action — makes the plist FOREIGN: PD never claims a document
 * that does more than the builder can emit.
 */
const LAUNCH_AGENT_KEYS: ReadonlySet<string> = new Set([
  'Label',
  'ProgramArguments',
  'WorkingDirectory',
  'RunAtLoad',
  'StartInterval',
  'StandardOutPath',
  'StandardErrorPath',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Structural LaunchAgent plist reader: parses the real plist document with
 * the project-locked `plist` library, then verifies the result against the
 * builder's key/type contract. A plist fails the parse (ok=false) when it
 * is unparseable, has a non-dict root, declares an unknown top-level key,
 * duplicates any of the required keys anywhere in the raw text (covers
 * comment-forgery — the XML parser drops comments but the raw count
 * still exposes the duplicate), or carries fields of the wrong type. A
 * plist that fails the parse can never equal our registration, so it is
 * FOREIGN.
 */
function parseLaunchAgent(plistText: string): { ok: true; parsed: ParsedLaunchAgent } | { ok: false } {
  let root: unknown;
  try {
    root = plistLib.parse(plistText);
  } catch {
    return { ok: false };
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { ok: false };
  }
  const dict = root as Record<string, unknown>;
  for (const key of Object.keys(dict)) {
    if (!LAUNCH_AGENT_KEYS.has(key)) return { ok: false };
    // Duplicate-key guard: the parsed value keeps only one instance, so
    // count raw `<key>NAME</key>` occurrences — a comment- or nesting-forged
    // duplicate still shows up in the raw text.
    const occurrences = plistText.match(new RegExp(`<key>${escapeRegExp(key)}</key>`, 'g'));
    if ((occurrences?.length ?? 0) > 1) return { ok: false };
  }
  const label = dict.Label;
  const programArguments = dict.ProgramArguments;
  const workingDirectory = dict.WorkingDirectory;
  return {
    ok: true,
    parsed: {
      label: typeof label === 'string' ? label : null,
      programArguments:
        Array.isArray(programArguments) && programArguments.every((a) => typeof a === 'string')
          ? (programArguments)
          : null,
      workingDirectory: typeof workingDirectory === 'string' ? workingDirectory : null,
    },
  };
}

/** launchctl print stderr/stdout patterns that definitively mean "not loaded". */
const LAUNCHCTL_NOT_LOADED = /could not find|no such|not loaded|can't find|cannot find|does not exist/i;

/** launchctl bootout stderr patterns that definitively mean "nothing to unload". */
const LAUNCHCTL_NOT_LOADED_BOOTOUT = /no such process|not loaded|No process existing with specified identity/i;

export function createMacosSchedulerAdapter(deps: MacosSchedulerDeps): SchedulerAdapter {
  const { runner, fileIo } = deps;
  const getUid = deps.getUid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : undefined));

  function guiDomain(): { ok: true; domain: string; uid: number } | { ok: false; reason: string; nextAction: string } {
    const uid = getUid();
    if (uid === undefined) {
      return {
        ok: false,
        reason: 'macos_uid_unavailable',
        nextAction: 'The LaunchAgent domain needs the current user uid (process.getuid); it is unavailable in this process context.',
      };
    }
    return { ok: true, domain: `gui/${uid}`, uid };
  }

  function plistPath(registration: SchedulerRegistration, homeDir: string): string {
    return path.join(homeDir, 'Library', 'LaunchAgents', `${registration.identity.macosLabel}.plist`);
  }

  /** homeDir derived from the trusted pdHome (…/<home>/.pd → <home>). */
  function homeDirFor(registration: SchedulerRegistration): string {
    return path.dirname(registration.pdHome);
  }

  function logDirFor(registration: SchedulerRegistration): string {
    return path.join(registration.pdHome, 'service');
  }

  /**
   * Ownership verdict from the PARSED plist (task §5 review): Label must be
   * exactly our label, ProgramArguments must be exactly [nodePath, ...
   * schedulerInvocationArgs()] and WorkingDirectory exactly our pdHome.
   * Anything that fails to parse, or merely contains our strings inside a
   * different job definition, is foreign — never overwritten or deleted.
   */
  function ownershipVerdict(
    registration: SchedulerRegistration,
    plist: string,
  ): { ours: true } | { ours: false } {
    const result = parseLaunchAgent(plist);
    if (!result.ok) return { ours: false };
    const {parsed} = result;
    if (parsed.label !== registration.identity.macosLabel) return { ours: false };
    if (parsed.workingDirectory !== registration.pdHome) return { ours: false };
    const expected = [registration.nodePath, ...schedulerInvocationArgs(registration)];
    if (parsed.programArguments === null || parsed.programArguments.length !== expected.length) {
      return { ours: false };
    }
    return parsed.programArguments.every((token, index) => token === expected[index])
      ? { ours: true }
      : { ours: false };
  }

  /**
   * Strict `launchctl print-disabled` reader: real macOS output is
   * `disabled services = {` then one `"<label>" : true|false` entry per
   * line then `}`. Only an exact label match decides the flag; a missing
   * entry means not-disabled (launchd lists only overrides); ANY other
   * non-empty, non-structural line makes the verdict UNKNOWN — never
   * defaulted to enabled or disabled.
   */
  function parseDisabledFlag(stdout: string, label: string): { ok: true; disabled: boolean } | { ok: false } {
    let flag = false;
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      if (/^disabled\s+services\s*=\s*\{?$/i.test(line) || /^\}$/.test(line)) continue;
      const entry = /^"([^"]+)"\s*[:=]\s*(true|false|1|0)\s*$/i.exec(line);
      if (entry === null) return { ok: false };
      if (entry[1] === label) {
        const value = entry[2] ?? '';
        flag = value.toLowerCase() === 'true' || value === '1';
      }
    }
    return { ok: true, disabled: flag };
  }

  async function run(command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string; timedOut?: boolean }> {
    return runner.run(command, args);
  }

  interface LoadState {
    /** launchctl print found the job loaded in the domain. */
    readonly loaded: boolean;
    /** False when `launchctl print` failed WITHOUT a definitive not-loaded answer — callers must fail closed, never treat it as unloaded. */
    readonly loadedKnown: boolean;
    /** print-disabled produced a verdict for the label. */
    readonly disabledKnown: boolean;
    /** launchd persistent disabled flag (null = unreadable). */
    readonly disabled: boolean | null;
    readonly lastResult: string | null;
    readonly unreadableReasons: readonly string[];
  }

  /** Loaded + disabled state from launchctl print / print-disabled. */
  async function loadState(label: string): Promise<LoadState> {
    const domain = guiDomain();
    if (!domain.ok) {
      return { loaded: false, loadedKnown: false, disabledKnown: false, disabled: null, lastResult: null, unreadableReasons: [domain.reason] };
    }
    const reasons: string[] = [];
    const print = await run('launchctl', ['print', `${domain.domain}/${label}`]);
    const loaded = print.code === 0;
    // A failed print is only proof of "not loaded" when launchd says so;
    // any other failure (spawn, permission, timeout) leaves the loaded
    // state UNKNOWN — an unknown state must not drive bootout/delete.
    const notFound = LAUNCHCTL_NOT_LOADED.test(`${print.stderr}\n${print.stdout}`);
    const loadedKnown = loaded || notFound;
    if (!loaded && !notFound) {
      reasons.push(
        `launchctl_print_failed:${print.code ?? 'spawn'}:${(print.spawnError ?? print.stderr.trim() ?? print.stdout.trim()).slice(0, 100)}`,
      );
    }
    let lastResult: string | null = null;
    if (loaded) {
      const match = /last exit code\s*=\s*(\d+)/.exec(print.stdout);
      lastResult = match !== null ? match[1] ?? null : null;
    }
    const disabledList = await run('launchctl', ['print-disabled', domain.domain]);
    let disabled: boolean | null = null;
    if (disabledList.code === 0) {
      const probe = parseDisabledFlag(disabledList.stdout, label);
      const flag = probe.ok ? probe.disabled : null;
      if (flag !== null) {
        disabled = flag;
      } else {
        reasons.push('launchctl_print_disabled_unparseable');
      }
    } else {
      reasons.push(
        `launchctl_print_disabled_failed:${disabledList.code ?? 'spawn'}:${(disabledList.spawnError ?? disabledList.stderr).trim().slice(0, 100)}`,
      );
    }
    return { loaded, loadedKnown, disabledKnown: disabled !== null, disabled, lastResult, unreadableReasons: reasons };
  }

  /**
   * launchctl print tri-state: 'loaded' only on exit 0; 'not_loaded' only
   * on launchd's definitive not-found answer; anything else is 'unknown'
   * and must fail closed — never treated as unloaded.
   */
  async function probeLoaded(label: string): Promise<{ state: 'loaded' | 'not_loaded' | 'unknown'; reason?: string }> {
    const domain = guiDomain();
    if (!domain.ok) return { state: 'unknown', reason: domain.reason };
    const print = await run('launchctl', ['print', `${domain.domain}/${label}`]);
    if (print.code === 0) return { state: 'loaded' };
    if (LAUNCHCTL_NOT_LOADED.test(`${print.stderr}\n${print.stdout}`)) return { state: 'not_loaded' };
    return {
      state: 'unknown',
      reason: `launchctl_print_failed:${print.code ?? 'spawn'}:${(print.spawnError ?? print.stderr.trim() ?? print.stdout.trim()).slice(0, 100)}`,
    };
  }

  /** launchctl print confirms the job is loaded. */
  async function verifyLoaded(label: string): Promise<boolean> {
    return (await probeLoaded(label)).state === 'loaded';
  }

  function baseFacts(registration: SchedulerRegistration, fields: Partial<SchedulerFacts>): SchedulerFacts {
    return {
      platform: 'darwin',
      taskName: registration.identity.macosLabel,
      registered: null,
      enabled: null,
      active: null,
      lastRunAt: null,
      lastResult: null,
      ...fields,
    };
  }

  function commandFailed(reason: string, nextAction: string): SchedulerOperationResult {
    return { ok: false, kind: 'command_failed', reason, nextAction };
  }

  async function status(registration: SchedulerRegistration): Promise<SchedulerOperationResult> {
    const plistFile = plistPath(registration, homeDirFor(registration));
    const existing = fileIo.readIfExists(plistFile);
    if (!existing.ok) {
      if (existing.reason === 'missing') {
        return {
          ok: true,
          changed: false,
          facts: baseFacts(registration, { registered: false, enabled: false, active: false }),
        };
      }
      return {
        ok: false,
        kind: 'command_failed',
        reason: `launchagent_plist_unreadable:${existing.detail ?? existing.reason}`,
        nextAction: `The plist at ${plistFile} exists but cannot be read; fix its permissions. PD does not treat an unreadable registration as "not installed".`,
      };
    }
    // Ownership is a status witness too (task §5): a foreign same-label
    // LaunchAgent is NOT our registration.
    if (!ownershipVerdict(registration, existing.content).ours) {
      return {
        ok: false,
        kind: 'external_conflict',
        reason: 'launchagent_conflict_foreign_plist',
        nextAction: `${plistFile} exists but its Label/ProgramArguments/WorkingDirectory do not match this PD install (${registration.pdHome}); PD does not report a foreign LaunchAgent as its own — inspect it manually.`,
      };
    }
    const state = await loadState(registration.identity.macosLabel);
    // enabled (will fire) = the launchd disabled flag is clear; unreadable
    // flag = null, never folded into loaded/unloaded or guessed (task §9).
    const enabled = state.disabled === null ? null : !state.disabled;
    const active = state.loadedKnown ? state.loaded : null;
    return {
      ok: true,
      changed: false,
      facts: baseFacts(registration, {
        registered: true,
        enabled,
        active,
        triggerIntervalMs: parseMacosStartIntervalMs(existing.content),
        lastResult: state.lastResult,
        ...(state.unreadableReasons.length > 0 ? { degradedReasons: state.unreadableReasons } : {}),
      }),
    };
  }

  /** Create + verify the scheduler log directory (`<pdHome>/service`). */
  function ensureLogDir(registration: SchedulerRegistration): { ok: true } | { ok: false; result: SchedulerOperationResult } {
    const dir = logDirFor(registration);
    const made = fileIo.mkdirs(dir);
    if (!made.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          kind: 'command_failed',
          reason: `launchagent_log_dir_unwritable:${made.reason.slice(0, 80)}`,
          nextAction: `The stdout/stderr log directory ${dir} could not be created; the first triggered run would fail on missing logs. Fix permissions and retry.`,
        },
      };
    }
    return { ok: true };
  }

  return {
    platform: 'darwin',

    async install(registration) {
      const domain = guiDomain();
      if (!domain.ok) {
        return { ok: false, kind: 'unavailable', reason: domain.reason, nextAction: domain.nextAction };
      }
      const homeDir = homeDirFor(registration);
      const plistFile = plistPath(registration, homeDir);
      const agentsDir = path.dirname(plistFile);
      const existing = fileIo.readIfExists(plistFile);
      let refreshOnly = false;

      if (existing.ok) {
        const ownership = ownershipVerdict(registration, existing.content);
        if (!ownership.ours) {
          return {
            ok: false,
            kind: 'external_conflict',
            reason: 'launchagent_conflict_foreign_plist',
            nextAction: `${plistFile} already exists but is not this PD install's LaunchAgent (Label/ProgramArguments/WorkingDirectory mismatch). PD never overwrites a foreign LaunchAgent — inspect it manually.`,
          };
        }
        refreshOnly = true;
      } else if (existing.reason === 'unreadable') {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchagent_plist_unreadable:${existing.detail ?? existing.reason}`,
          nextAction: `${plistFile} exists but cannot be read; PD refuses to overwrite an unreadable registration — fix its permissions first.`,
        };
      }

      // install never bootstraps and never starts a Worker (task §3): the
      // log directory is created up-front so the first ENABLED trigger can
      // write stdout/stderr (task §6 review).
      const logDir = ensureLogDir(registration);
      if (!logDir.ok) return logDir.result;

      // Refresh semantics (task §15): an existing OWN registration keeps its
      // interval — only the node/CLI entry and args move forward.
      const preservedInterval = refreshOnly && registration.intervalExplicit !== true
        ? (existing.ok ? parseMacosStartIntervalMs(existing.content) : null)
        : null;
      const effective: SchedulerRegistration = preservedInterval !== null
        ? { ...registration, intervalMs: preservedInterval }
        : registration;

      const label = registration.identity.macosLabel;
      // Read launchd state BEFORE replacing the plist (review §4 matrix):
      // a refresh whose enabled flag is UNREADABLE must refuse before any
      // mutation — a blind swap could leave a still-enabled job firing a
      // stale definition.
      const state = await loadState(label);
      if (refreshOnly && state.disabled === null) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchagent_disabled_state_unverified:${(state.unreadableReasons[0] ?? 'print_disabled_unreadable').slice(0, 100)}`,
          nextAction: `print-disabled could not prove the enabled flag of the existing registration; ${plistFile} was NOT replaced. Fix the launchctl error above and retry pd service install.`,
        };
      }
      const wasEnabled = refreshOnly && state.disabled === false;
      const priorContent = existing.ok ? existing.content : null;

      const mkdir = fileIo.mkdirs(agentsDir);
      if (!mkdir.ok) {
        return { ok: false, kind: 'command_failed', reason: `launchagents_dir_unwritable:${mkdir.reason.slice(0, 80)}`, nextAction: `Could not create ${agentsDir}; check permissions and retry pd service install.` };
      }
      const written = fileIo.writeAtomic(plistFile, buildMacosLaunchAgentPlist(effective));
      if (!written.ok) {
        return { ok: false, kind: 'command_failed', reason: `launchagent_write_failed:${written.reason.slice(0, 80)}`, nextAction: `Could not write ${plistFile}; retry pd service install after fixing the filesystem issue.` };
      }

      /** Roll the plist back: fresh install removes the file it created; a
       * refresh restores the pre-call content. The primary error stays —
       * a rollback failure is appended, never hidden. */
      const rollbackPlist = (reason: string): string => {
        if (priorContent === null) {
          const removed = fileIo.remove(plistFile);
          return removed.ok ? reason : `${reason}+rollback_remove_failed:${removed.reason.slice(0, 60)}`;
        }
        const restored = fileIo.writeAtomic(plistFile, priorContent);
        return restored.ok ? reason : `${reason}+rollback_restore_failed:${restored.reason.slice(0, 60)}`;
      };

      let pinnedDisabled = false;
      if (wasEnabled) {
        // When the loaded state is UNKNOWN a possibly-loaded job must still
        // be reloaded — bootout tolerates a definitive not-loaded answer.
        if (!state.loadedKnown || state.loaded) {
          const bootout = await run('launchctl', ['bootout', `${domain.domain}/${label}`]);
          if (bootout.code !== 0) {
            const stderr = bootout.stderr.trim();
            const notLoaded = bootout.spawnError === undefined && LAUNCHCTL_NOT_LOADED_BOOTOUT.test(stderr);
            if (!notLoaded) {
              return {
                ok: false,
                kind: 'command_failed',
                reason: rollbackPlist(`launchctl_bootout_failed:${bootout.code ?? 'spawn'}:${(bootout.spawnError ?? stderr).slice(0, 120)}`),
                nextAction: 'The refreshed plist could not replace the loaded job (bootout failed); the previous plist was restored and its definition stays active. Inspect the stderr above and retry.',
              };
            }
          }
        }
        // Reload the definition while the enabled flag stays enabled: also
        // covers enabled+unloaded — a confirmed-unloaded job is bootstrapped
        // straight back (bootout is skipped, nothing to unload).
        const bootstrap = await run('launchctl', ['bootstrap', domain.domain, plistFile]);
        if (bootstrap.code !== 0 || !(await verifyLoaded(label))) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: rollbackPlist(bootstrap.code === 0 ? 'launchagent_reload_unverified' : `launchctl_bootstrap_failed:${bootstrap.code ?? 'spawn'}:${(bootstrap.spawnError ?? bootstrap.stderr).trim().slice(0, 120)}`),
            nextAction: 'The refreshed plist could not be reloaded; the previous plist was restored but the job may now be unloaded — run pd service status, then retry (a retry re-bootstraps safely).',
          };
        }
      } else if (state.disabled !== true) {
        // installed_disabled (task §3): a never-disabled LaunchAgent
        // auto-loads at the next login and RunAtLoad would fire it — so
        // install explicitly pins the persistent disabled flag.
        const disable = await run('launchctl', ['disable', `${domain.domain}/${label}`]);
        if (disable.code !== 0) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: rollbackPlist(`launchctl_disable_failed:${disable.code ?? 'spawn'}:${(disable.spawnError ?? disable.stderr).trim().slice(0, 120)}`),
            nextAction: `The plist was written but the persistent disable could not be verified — the install was rolled back, leaving the label enabled would fire it at the next login (RunAtLoad). Inspect the stderr above and re-run pd service install.`,
          };
        }
        pinnedDisabled = true;
      }
      if (!refreshOnly) {
        // First install is transactional: the disabled pin must be PROVABLE.
        // On any doubt, remove the plist this call created and restore the
        // disable override to its pre-install value (pinned -> enable).
        const verify = await loadState(label);
        if (verify.disabled !== true) {
          let reason = rollbackPlist(`launchagent_disable_unverified:${(verify.unreadableReasons[0] ?? 'flag_not_set').slice(0, 80)}`);
          if (pinnedDisabled) {
            const enable = await run('launchctl', ['enable', `${domain.domain}/${label}`]);
            if (enable.code !== 0) {
              reason += `+rollback_enable_failed:${(enable.spawnError ?? enable.stderr).trim().slice(0, 60)}`;
            }
          }
          return {
            ok: false,
            kind: 'command_failed',
            reason,
            nextAction: 'The plist was written but the persistent disable could not be proven; the install was rolled back — the new plist was removed and the disable override restored. Inspect launchctl print-disabled and retry pd service install.',
          };
        }
      }
      const after = await loadState(label);
      return {
        ok: true,
        changed: !refreshOnly,
        facts: baseFacts(registration, {
          registered: true,
          enabled: after.disabled === null ? null : !after.disabled,
          active: after.loaded,
          triggerIntervalMs: effective.intervalMs,
          lastResult: after.lastResult,
          ...(after.unreadableReasons.length > 0 ? { degradedReasons: after.unreadableReasons } : {}),
        }),
      };
    },

    async enable(registration) {
      const domain = guiDomain();
      if (!domain.ok) {
        return { ok: false, kind: 'unavailable', reason: domain.reason, nextAction: domain.nextAction };
      }
      const plistFile = plistPath(registration, homeDirFor(registration));
      const existing = fileIo.readIfExists(plistFile);
      if (!existing.ok) {
        if (existing.reason === 'missing') {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'scheduler_not_registered',
            nextAction: `No LaunchAgent plist at ${plistFile}. Run pd service install first — enable never creates one.`,
          };
        }
        return commandFailed(
          `launchagent_plist_unreadable:${existing.detail ?? existing.reason}`,
          `${plistFile} exists but cannot be read; PD refuses to enable an unverifiable registration — fix its permissions first.`,
        );
      }
      if (!ownershipVerdict(registration, existing.content).ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'launchagent_conflict_foreign_plist',
          nextAction: `${plistFile} is not PD's own LaunchAgent; PD refuses to modify it.`,
        };
      }
      // The log dir must exist before bootstrap so the first fired run can
      // write its stdout/stderr (task §6 review).
      const logDir = ensureLogDir(registration);
      if (!logDir.ok) return logDir.result;

      const label = registration.identity.macosLabel;
      const state = await loadState(label);
      if (state.loaded && state.disabled === false) {
        return {
          ok: true,
          changed: false,
          facts: baseFacts(registration, { registered: true, enabled: true, active: true, lastResult: state.lastResult }),
        };
      }
      // enable BEFORE bootstrap (task §3): the flag must be clear so the
      // bootstrapped job is actually armed.
      if (state.disabled !== false) {
        const enable = await run('launchctl', ['enable', `${domain.domain}/${label}`]);
        if (enable.code !== 0) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `launchctl_enable_failed:${enable.code ?? 'spawn'}:${(enable.spawnError ?? enable.stderr).trim().slice(0, 120)}`,
            nextAction: 'launchctl enable failed; the registration exists but stays disabled. Inspect the stderr above and retry.',
          };
        }
      }
      if (!state.loaded) {
        const bootstrap = await run('launchctl', ['bootstrap', domain.domain, plistFile]);
        if (bootstrap.code !== 0) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `launchctl_bootstrap_failed:${bootstrap.code ?? 'spawn'}:${(bootstrap.spawnError ?? bootstrap.stderr).trim().slice(0, 120)}`,
            nextAction: 'bootstrap after enable failed; inspect the stderr above and retry pd service enable.',
          };
        }
      }
      // Verify before reporting success (task §3): a confirmed-loaded job
      // AND a proven-clear disabled flag are both required — either
      // UNKNOWN means the enable is unverified, never a success.
      const postEnable = await loadState(label);
      if (!postEnable.loaded || postEnable.disabled !== false) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: postEnable.loaded
            ? 'launchagent_enable_flag_unverified'
            : 'launchagent_enable_unverified',
          nextAction: 'launchctl enable/bootstrap returned success but the job is not provably loaded+enabled in the gui domain. Run pd service status to inspect and retry.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: baseFacts(registration, { registered: true, enabled: true, active: true }),
      };
    },

    async disable(registration) {
      const domain = guiDomain();
      if (!domain.ok) {
        return { ok: false, kind: 'unavailable', reason: domain.reason, nextAction: domain.nextAction };
      }
      const label = registration.identity.macosLabel;
      const plistFile = plistPath(registration, homeDirFor(registration));
      const existing = fileIo.readIfExists(plistFile);
      if (!existing.ok) {
        if (existing.reason === 'missing') {
          return {
            ok: false,
            kind: 'unsafe_state',
            reason: 'scheduler_not_registered',
            nextAction: `No LaunchAgent plist at ${plistFile}; nothing to disable.`,
          };
        }
        return commandFailed(
          `launchagent_plist_unreadable:${existing.detail ?? existing.reason}`,
          `${plistFile} exists but cannot be read; PD refuses to touch an unverifiable registration — fix its permissions first.`,
        );
      }
      if (!ownershipVerdict(registration, existing.content).ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'launchagent_conflict_foreign_plist',
          nextAction: `${plistFile} is not PD's own LaunchAgent; PD refuses to modify it.`,
        };
      }
      const state = await loadState(label);
      if (state.disabled === true && state.loadedKnown && !state.loaded) {
        return {
          ok: true,
          changed: false,
          facts: baseFacts(registration, { registered: true, enabled: false, active: false, lastResult: state.lastResult }),
        };
      }
      // Persistent disable first (survives logout/login), then bootout the
      // currently-loaded job (task §3).
      if (state.disabled !== true) {
        const disable = await run('launchctl', ['disable', `${domain.domain}/${label}`]);
        if (disable.code !== 0) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `launchctl_disable_failed:${disable.code ?? 'spawn'}:${(disable.spawnError ?? disable.stderr).trim().slice(0, 120)}`,
            nextAction: 'launchctl disable failed; future automatic triggers may still fire. Inspect the stderr above and retry.',
          };
        }
      }
      // A possibly-loaded job (loaded state UNKNOWN) is bootout-ed too —
      // the command tolerates a definitive not-loaded answer, and a stale
      // loaded job must not keep firing under the disabled flag.
      if (state.loaded || !state.loadedKnown) {
        const bootout = await run('launchctl', ['bootout', `${domain.domain}/${label}`]);
        if (bootout.code !== 0) {
          const stderr = bootout.stderr.trim();
          if (bootout.spawnError !== undefined || !LAUNCHCTL_NOT_LOADED_BOOTOUT.test(stderr)) {
            return {
              ok: false,
              kind: 'command_failed',
              reason: `launchctl_bootout_failed:${bootout.code ?? 'spawn'}:${stderr.slice(0, 120)}`,
              nextAction: 'bootout failed; the agent may still be loaded. Inspect the stderr above and retry.',
            };
          }
        }
      }
      // Prove it is unloaded before reporting stopped (task §3): UNKNOWN
      // is a distinct, never-successful verdict.
      const probe = await probeLoaded(label);
      if (probe.state !== 'not_loaded') {
        return {
          ok: false,
          kind: 'command_failed',
          reason: probe.state === 'unknown' ? `launchagent_disable_unverified:${(probe.reason ?? 'print_failed').slice(0, 80)}` : 'launchagent_disable_unverified',
          nextAction: 'launchctl disable/bootout returned success but the job still reports loaded — or the loaded state could not be proven. Run pd service status to inspect and retry.',
        };
      }
      const after = await loadState(label);
      return {
        ok: true,
        changed: true,
        facts: baseFacts(registration, {
          registered: true,
          enabled: after.disabled === null ? null : !after.disabled,
          active: after.loaded,
          lastResult: after.lastResult,
          ...(after.unreadableReasons.length > 0 ? { degradedReasons: after.unreadableReasons } : {}),
        }),
      };
    },

    status,

    async uninstall(registration) {
      const domain = guiDomain();
      if (!domain.ok) {
        return { ok: false, kind: 'unavailable', reason: domain.reason, nextAction: domain.nextAction };
      }
      const label = registration.identity.macosLabel;
      const plistFile = plistPath(registration, homeDirFor(registration));
      const existing = fileIo.readIfExists(plistFile);
      if (!existing.ok) {
        if (existing.reason === 'missing') {
          return {
            ok: true,
            changed: false,
            facts: baseFacts(registration, { registered: false, enabled: false, active: false }),
          };
        }
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchagent_plist_unreadable:${existing.detail ?? existing.reason}`,
          nextAction: `${plistFile} exists but cannot be read; PD never removes an unverifiable registration — fix its permissions first.`,
        };
      }
      if (!ownershipVerdict(registration, existing.content).ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'launchagent_conflict_foreign_plist',
          nextAction: `${plistFile} is not PD's own LaunchAgent; PD never deletes foreign LaunchAgents. Inspect it manually.`,
        };
      }
      // Stop + unload OUR job first, verify it is gone, then remove ONLY our
      // plist (task §3).
      const state = await loadState(label);
      // An UNREADABLE loaded state is not proof the job is unloaded —
      // deleting the plist while a stale-loaded job still points at it
      // would leave an untracked registration. Fail closed instead (the
      // plist is NOT removed; re-run once launchctl answers).
      if (!state.loadedKnown) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchagent_loaded_state_unverified:${(state.unreadableReasons[0] ?? 'launchctl_print_failed').slice(0, 120)}`,
          nextAction: '`launchctl print` could not prove whether the job is loaded; the plist was NOT removed. Inspect the error above and re-run pd service uninstall.',
        };
      }
      if (state.disabled !== true) {
        const disable = await run('launchctl', ['disable', `${domain.domain}/${label}`]);
        if (disable.code !== 0) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `launchctl_disable_failed:${disable.code ?? 'spawn'}:${(disable.spawnError ?? disable.stderr).trim().slice(0, 120)}`,
            nextAction: 'launchctl disable failed; the job could re-load at the next login — the plist was NOT removed. Inspect the stderr above, then re-run pd service uninstall.',
          };
        }
      }
      if (state.loaded) {
        const bootout = await run('launchctl', ['bootout', `${domain.domain}/${label}`]);
        if (bootout.code !== 0) {
          const stderr = bootout.stderr.trim();
          if (bootout.spawnError !== undefined || !LAUNCHCTL_NOT_LOADED_BOOTOUT.test(stderr)) {
            return {
              ok: false,
              kind: 'command_failed',
              reason: `launchctl_bootout_failed:${bootout.code ?? 'spawn'}:${stderr.slice(0, 120)}`,
              nextAction: 'bootout failed; the agent may still be loaded and its plist was NOT removed. Inspect the stderr above, then re-run pd service uninstall.',
            };
          }
        }
        const probe = await probeLoaded(label);
        if (probe.state !== 'not_loaded') {
          return {
            ok: false,
            kind: 'command_failed',
            reason: probe.state === 'unknown' ? `launchagent_unload_unverified:${(probe.reason ?? 'print_failed').slice(0, 80)}` : 'launchagent_unload_unverified',
            nextAction: 'The job still reports loaded after bootout — or the unload could not be proven; the plist was NOT removed. Inspect with pd service status and retry.',
          };
        }
      }
      const removed = fileIo.remove(plistFile);
      if (!removed.ok) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchagent_remove_failed:${removed.reason.slice(0, 80)}`,
          nextAction: `The agent was unloaded but ${plistFile} could not be removed; delete it manually after reviewing why.`,
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
