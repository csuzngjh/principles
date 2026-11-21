/**
 * macOS scheduler adapter — current-user LaunchAgent (SPEC §10.2, task §3.3).
 *
 * Registration: `~/Library/LaunchAgents/com.principles-disciple.service-host.<key>.plist`
 * with RunAtLoad + StartInterval. Managed with `launchctl bootstrap/bootout/
 * enable/disable` against the caller's own `gui/<uid>` domain — never a
 * LaunchDaemon, never root (task §3.3).
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
import { schedulerInvocationArgs } from './contract.js';
import type {
  SchedulerAdapter,
  SchedulerCommandRunner,
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

  /** Ownership: the on-disk plist must reference THIS install's entry + pdHome. */
  function ownershipVerdict(
    registration: SchedulerRegistration,
    plist: string,
  ): { ours: true } | { ours: false } {
    // ProgramArguments carries XML-escaped paths — special-char install
    // paths (task §3.3) must still match their own plist.
    const entryMatches = plist.includes(registration.cliEntry) || plist.includes(escapeXml(registration.cliEntry));
    const pdHomeMatches = plist.includes(registration.pdHome) || plist.includes(escapeXml(registration.pdHome));
    return entryMatches && pdHomeMatches ? { ours: true } : { ours: false };
  }

  async function run(command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string; timedOut?: boolean }> {
    return runner.run(command, args);
  }

  interface LoadState {
    readonly loaded: boolean;
    readonly disabledKnown: boolean;
    readonly disabled: boolean | null;
    readonly lastResult: string | null;
    readonly unreadableReason?: string;
  }

  /** Loaded + disabled state from launchctl print / print-disabled. */
  async function loadState(label: string): Promise<LoadState> {
    const domain = guiDomain();
    if (!domain.ok) {
      return { loaded: false, disabledKnown: false, disabled: null, lastResult: null, unreadableReason: domain.reason };
    }
    const print = await run('launchctl', ['print', `${domain.domain}/${label}`]);
    const loaded = print.code === 0;
    let lastResult: string | null = null;
    if (loaded) {
      const match = /last exit code\s*=\s*(\d+)/.exec(print.stdout);
      lastResult = match !== null ? match[1] ?? null : null;
    }
    const disabledList = await run('launchctl', ['print-disabled', domain.domain]);
    let disabled: boolean | null = null;
    if (disabledList.code === 0) {
      const line = disabledList.stdout
        .split('\n')
        .find((l) => l.includes(`"${label}"`));
      if (line !== undefined) disabled = /disabled\s*=>\s*true/i.test(line);
    }
    return { loaded, disabledKnown: disabled !== null, disabled, lastResult };
  }

  async function status(registration: SchedulerRegistration): Promise<SchedulerOperationResult> {
    const plistFile = plistPath(registration, homeDirFor(registration));
    const existing = fileIo.readIfExists(plistFile);
    if (!existing.ok) {
      if (existing.reason === 'missing') {
        return {
          ok: true,
          changed: false,
          facts: {
            platform: 'darwin',
            taskName: registration.identity.macosLabel,
            registered: false,
            enabled: false,
            lastRunAt: null,
            lastResult: null,
          },
        };
      }
      return {
        ok: false,
        kind: 'command_failed',
        reason: `launchagent_plist_unreadable:${existing.detail ?? existing.reason}`,
        nextAction: `The plist at ${plistFile} exists but cannot be read; fix its permissions. PD does not treat an unreadable registration as "not installed".`,
      };
    }
    const state = await loadState(registration.identity.macosLabel);
    const enabled = state.loaded && state.disabled !== true;
    return {
      ok: true,
      changed: false,
      facts: {
        platform: 'darwin',
        taskName: registration.identity.macosLabel,
        registered: true,
        enabled,
        triggerIntervalMs: parseMacosStartIntervalMs(existing.content),
        lastRunAt: null,
        lastResult: state.lastResult,
      },
    };
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

      if (existing.ok) {
        const ownership = ownershipVerdict(registration, existing.content);
        if (!ownership.ours) {
          return {
            ok: false,
            kind: 'external_conflict',
            reason: 'launchagent_conflict_foreign_plist',
            nextAction: `${plistFile} already exists but does not reference this PD install (${registration.pdHome}). PD never overwrites a foreign LaunchAgent — inspect it manually.`,
          };
        }
        // Idempotent: our own plist — refresh the loaded instance (bootout +
        // bootstrap) only when it is not currently loaded; enabled/disabled
        // state is preserved (launchctl enable/disable is domain state, kept).
        const state = await loadState(registration.identity.macosLabel);
        if (state.loaded) {
          const disabledList = await run('launchctl', ['print-disabled', domain.domain]);
          let disabled = false;
          if (disabledList.code === 0) {
            const line = disabledList.stdout.split('\n').find((l) => l.includes(`"${registration.identity.macosLabel}"`));
            disabled = line !== undefined && /disabled\s*=>\s*true/i.test(line);
          }
          return {
            ok: true,
            changed: false,
            facts: {
              platform: 'darwin',
              taskName: registration.identity.macosLabel,
              registered: true,
              enabled: !disabled,
              lastRunAt: null,
              lastResult: state.lastResult,
            },
          };
        }
      } else {
        const mkdir = fileIo.mkdirs(agentsDir);
        if (!mkdir.ok) {
          return { ok: false, kind: 'command_failed', reason: `launchagents_dir_unwritable:${mkdir.reason.slice(0, 80)}`, nextAction: `Could not create ${agentsDir}; check permissions and retry pd service install.` };
        }
        const written = fileIo.writeAtomic(plistFile, buildMacosLaunchAgentPlist(registration));
        if (!written.ok) {
          return { ok: false, kind: 'command_failed', reason: `launchagent_write_failed:${written.reason.slice(0, 80)}`, nextAction: `Could not write ${plistFile}; retry pd service install after fixing the filesystem issue.` };
        }
      }

      const bootstrap = await run('launchctl', ['bootstrap', domain.domain, plistFile]);
      if (bootstrap.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchctl_bootstrap_failed:${bootstrap.code ?? 'spawn'}:${(bootstrap.spawnError ?? bootstrap.stderr).trim().slice(0, 120)}`,
          nextAction: `The plist was written to ${plistFile} but launchctl bootstrap failed. Inspect the stderr above; the registration is on disk but not loaded (retry pd service install after fixing the cause).`,
        };
      }
      const state = await loadState(registration.identity.macosLabel);
      return {
        ok: true,
        changed: true,
        facts: {
          platform: 'darwin',
          taskName: registration.identity.macosLabel,
          registered: true,
          enabled: state.loaded && state.disabled !== true,
          lastRunAt: null,
          lastResult: state.lastResult,
        },
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
        return {
          ok: false,
          kind: 'unsafe_state',
          reason: 'scheduler_not_registered',
          nextAction: `No LaunchAgent plist at ${plistFile}. Run pd service install first — enable never creates one.`,
        };
      }
      if (!ownershipVerdict(registration, existing.content).ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'launchagent_conflict_foreign_plist',
          nextAction: `${plistFile} is not PD's own LaunchAgent; PD refuses to modify it.`,
        };
      }
      const label = registration.identity.macosLabel;
      const state = await loadState(label);
      if (state.loaded && state.disabled === false) {
        return {
          ok: true,
          changed: false,
          facts: { platform: 'darwin', taskName: label, registered: true, enabled: true, lastRunAt: null, lastResult: state.lastResult },
        };
      }
      if (!state.loaded) {
        const bootstrap = await run('launchctl', ['bootstrap', domain.domain, plistFile]);
        if (bootstrap.code !== 0) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `launchctl_bootstrap_failed:${bootstrap.code ?? 'spawn'}:${(bootstrap.spawnError ?? bootstrap.stderr).trim().slice(0, 120)}`,
            nextAction: 'bootstrap before enable failed; inspect the stderr above and retry pd service enable.',
          };
        }
      }
      const enable = await run('launchctl', ['enable', `${domain.domain}/${label}`]);
      if (enable.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchctl_enable_failed:${enable.code ?? 'spawn'}:${(enable.spawnError ?? enable.stderr).trim().slice(0, 120)}`,
          nextAction: 'launchctl enable failed; the registration exists but may not fire. Inspect the stderr above and retry.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: { platform: 'darwin', taskName: label, registered: true, enabled: true, lastRunAt: null, lastResult: null },
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
        return {
          ok: false,
          kind: 'unsafe_state',
          reason: 'scheduler_not_registered',
          nextAction: `No LaunchAgent plist at ${plistFile}; nothing to disable.`,
        };
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
      if (state.disabled === true) {
        return {
          ok: true,
          changed: false,
          facts: { platform: 'darwin', taskName: label, registered: true, enabled: false, lastRunAt: null, lastResult: state.lastResult },
        };
      }
      const disable = await run('launchctl', ['disable', `${domain.domain}/${label}`]);
      if (disable.code !== 0) {
        return {
          ok: false,
          kind: 'command_failed',
          reason: `launchctl_disable_failed:${disable.code ?? 'spawn'}:${(disable.spawnError ?? disable.stderr).trim().slice(0, 120)}`,
          nextAction: 'launchctl disable failed; future automatic triggers may still fire. Inspect the stderr above and retry.',
        };
      }
      return {
        ok: true,
        changed: true,
        facts: { platform: 'darwin', taskName: label, registered: true, enabled: false, lastRunAt: null, lastResult: null },
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
      if (!existing.ok && existing.reason === 'missing') {
        return {
          ok: true,
          changed: false,
          facts: { platform: 'darwin', taskName: label, registered: false, enabled: false, lastRunAt: null, lastResult: null },
        };
      }
      if (existing.ok && !ownershipVerdict(registration, existing.content).ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'launchagent_conflict_foreign_plist',
          nextAction: `${plistFile} is not PD's own LaunchAgent; PD never deletes foreign LaunchAgents. Inspect it manually.`,
        };
      }
      // Unload first (ignore "not loaded" outcomes), then remove ONLY our plist.
      const bootout = await run('launchctl', ['bootout', `${domain.domain}/${label}`]);
      if (bootout.code !== 0 && bootout.spawnError === undefined) {
        const stderr = bootout.stderr.trim();
        // "No such process" style outcomes mean it was not loaded — fine.
        if (!/no such process|not loaded|No process existing with specified identity/i.test(stderr)) {
          return {
            ok: false,
            kind: 'command_failed',
            reason: `launchctl_bootout_failed:${bootout.code}:${stderr.slice(0, 120)}`,
            nextAction: 'bootout failed; the agent may still be loaded. Inspect the stderr above, then re-run pd service uninstall.',
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
        facts: { platform: 'darwin', taskName: label, registered: false, enabled: false, lastRunAt: null, lastResult: null },
      };
    },
  };
}
