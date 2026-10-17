import { describe, it, expect } from 'vitest';
import {
  ConsoleSupervisor,
  mapLaunchFailureReason,
  nextRestartDelayMs,
  MAX_RESTART_ATTEMPTS,
  STABILITY_WINDOW_MS,
  ENTRY_WAIT_DELAYS_MS,
  ENTRY_WAIT_TOTAL_MS,
} from '../../src/lib/supervisor.js';

/** Fake clock: quick crashes (< STABILITY_WINDOW) accumulate attempts. */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('ConsoleSupervisor — happy paths', () => {
  it('idle → start → starting → onLaunchStarted(managed) → running', () => {
    const sup = new ConsoleSupervisor();
    expect(sup.start()).toBe(true);
    expect(sup.getState().kind).toBe('starting');
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 999, startedVersion: '1.0.0' });
    const s = sup.getState();
    expect(s.kind).toBe('running');
    if (s.kind === 'running') {
      expect(s.mode).toBe('managed');
      expect(s.serverPid).toBe(999);
      expect(s.startedVersion).toBe('1.0.0');
    }
    expect(sup.isManaged()).toBe(true);
    expect(sup.canRestart()).toBe(true);
  });

  it('reused result → running(attached) without serverPid', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onLaunchReused('http://127.0.0.1:3100', 3100);
    const s = sup.getState();
    expect(s.kind).toBe('running');
    expect(sup.isManaged()).toBe(false);
  });

  it('ownsProcess is true after a fresh spawn (even without serverPid — old pd-cli) and false after reuse', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100 });
    expect(sup.getState().kind).toBe('running');
    expect(sup.isManaged()).toBe(false); // no pid knowledge…
    expect(sup.ownsProcess()).toBe(true); // …but we spawned it — must reap on quit

    // stop the owned server, then a later launch reuses an external instance
    sup.markIntentionalStop();
    sup.onServerExit(0);
    expect(sup.start()).toBe(true);
    sup.onLaunchReused('http://127.0.0.1:3100', 3100);
    expect(sup.ownsProcess()).toBe(false); // external instance — never kill
  });

  it('refuses double start while starting/running', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    expect(sup.start()).toBe(false);
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 1 });
    expect(sup.start()).toBe(false);
  });
});

describe('ConsoleSupervisor — failure mapping (rc-9)', () => {
  it('maps workspace_missing / console_runtime_not_installed / others', () => {
    expect(mapLaunchFailureReason('workspace_missing')).toBe('workspace_missing');
    expect(mapLaunchFailureReason('console_runtime_not_installed')).toBe('pd_not_installed');
    expect(mapLaunchFailureReason('console_web_ui_missing')).toBe('pd_not_installed');
    expect(mapLaunchFailureReason('console_exited_with_code_1')).toBe('launch_failed');
  });

  // 2026-10-16: install-layout failure causes stay distinct — a manifest from
  // a NEWER PD reads as "update the Companion", never as "PD not installed".
  it('maps install-layout resolution causes distinctly', () => {
    expect(mapLaunchFailureReason('install_manifest_unsupported_version: 2')).toBe('install_manifest_incompatible');
    expect(mapLaunchFailureReason('install_manifest_malformed: expected an object')).toBe('pd_not_installed');
    expect(mapLaunchFailureReason('install_runtime_missing')).toBe('pd_not_installed');
    expect(mapLaunchFailureReason('install_layout_legacy_fallback')).toBe('pd_not_installed');
  });

  it('launch failure carries detail and nextAction into degraded', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onLaunchFailure({ reason: 'workspace_missing', nextAction: 'Pass --workspace <path>' });
    const s = sup.getState();
    expect(s.kind).toBe('degraded');
    if (s.kind === 'degraded') {
      expect(s.reason).toBe('workspace_missing');
      expect(s.nextAction).toBe('Pass --workspace <path>');
    }
    expect(sup.canRestart()).toBe(true);
  });

  it('spawn ENOENT → node_missing degraded', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onSpawnError('ENOENT', 'spawn node ENOENT');
    const s = sup.getState();
    expect(s.kind === 'degraded' && s.reason).toBe('node_missing');
  });
});

describe('ConsoleSupervisor — crash loop protection (EP-03)', () => {
  it('schedules restarts with growing delay, then degrades after MAX_RESTART_ATTEMPTS quick crashes', () => {
    const clock = makeClock();
    const sup = new ConsoleSupervisor(clock.now);
    sup.start();
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 42 });

    clock.advance(500); // quick crash
    let delay = sup.onServerExit(1);
    expect(delay).toBe(1000);
    expect(sup.getState().kind).toBe('restarting');

    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 43 });
    clock.advance(500);
    delay = sup.onServerExit(1);
    expect(delay).toBe(2000);

    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 44 });
    clock.advance(500);
    delay = sup.onServerExit(1);
    expect(delay).toBe(4000);

    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 45 });
    clock.advance(500);
    delay = sup.onServerExit(1);
    expect(delay).toBeUndefined(); // loop guard
    const s = sup.getState();
    expect(s.kind === 'degraded' && s.reason).toBe('server_crash_loop');
  });

  it('a crash after a stable run (>= STABILITY_WINDOW_MS) starts a new episode — no loop guard', () => {
    const clock = makeClock();
    const sup = new ConsoleSupervisor(clock.now);
    sup.start();
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 42 });

    for (let episode = 0; episode < MAX_RESTART_ATTEMPTS + 2; episode++) {
      clock.advance(STABILITY_WINDOW_MS + 1_000); // ran stably
      const delay = sup.onServerExit(1);
      expect(delay).toBe(1_000); // always first attempt of a new episode
      sup.start();
      sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 43 + episode });
    }
    expect(sup.getState().kind).toBe('running');
  });

  it('intentional stop exits to idle without restart', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 42 });
    sup.markIntentionalStop();
    expect(sup.onServerExit(0)).toBeUndefined();
    expect(sup.getState().kind).toBe('idle');
  });

  it('requestRestart from degraded restarts; from running it refuses (caller must stop first)', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onLaunchFailure({ reason: 'anything' });
    expect(sup.requestRestart()).toBe(true);
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 1 });
    expect(sup.requestRestart()).toBe(false);
  });
});

describe('ConsoleSupervisor — entry-wait ladder for the update race (PRI-1012)', () => {
  const entryPath = String.raw`C:\Users\admin\.pd\runtime\pd-cli\dist\index.js`;

  it('waits a missing entry out with the full ladder, then degrades with the waited total', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    const delays = ENTRY_WAIT_DELAYS_MS.map(() => sup.onEntryMissing(`stat ENOENT: ${entryPath}`));
    expect(delays).toEqual([...ENTRY_WAIT_DELAYS_MS]);
    expect(sup.getState().kind).toBe('restarting');

    // budget exhausted → degraded, and the detail says how long it actually waited
    expect(sup.onEntryMissing(`stat ENOENT: ${entryPath}`)).toBeUndefined();
    const s = sup.getState();
    expect(s.kind).toBe('degraded');
    if (s.kind === 'degraded') {
      expect(s.reason).toBe('launch_failed');
      expect(s.detail).toContain(`${ENTRY_WAIT_DELAYS_MS.length} waits`);
      expect(s.detail).toContain(`${ENTRY_WAIT_TOTAL_MS / 1000}s`);
    }
  });

  it('burning the whole entry budget does NOT burn the crash-loop budget', () => {
    const clock = makeClock();
    const sup = new ConsoleSupervisor(clock.now);
    sup.start();
    for (const delay of ENTRY_WAIT_DELAYS_MS) expect(sup.onEntryMissing('stat ENOENT')).toBe(delay);
    // the update chain finishes and the console launches
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 42 });
    clock.advance(500); // quick crash — must still get the FULL crash ladder
    expect(sup.onServerExit(1)).toBe(1_000);
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 43 });
    clock.advance(500);
    expect(sup.onServerExit(1)).toBe(2_000);
  });

  it('a launch result resets the entry budget for the next episode', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    sup.onEntryMissing('stat ENOENT');
    sup.onEntryMissing('stat ENOENT');
    sup.onLaunchStarted({ url: 'http://127.0.0.1:3100', port: 3100, serverPid: 42 });
    sup.markIntentionalStop();
    sup.onServerExit(0);
    sup.start();
    // a later episode starts from the top of the ladder, not where it left off
    expect(sup.onEntryMissing('stat ENOENT')).toBe(ENTRY_WAIT_DELAYS_MS[0]);
  });

  it('a manual restart resets the entry budget after exhaustion', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    for (const delay of ENTRY_WAIT_DELAYS_MS) expect(sup.onEntryMissing('stat ENOENT')).toBe(delay);
    expect(sup.onEntryMissing('stat ENOENT')).toBeUndefined(); // degraded now
    // restartFromTray() is stopServer() + start(); requestRestart() has no
    // production caller, so this asserts the path the Owner can actually click.
    expect(sup.start()).toBe(true);
    expect(sup.entryWaitsLeft()).toBe(ENTRY_WAIT_DELAYS_MS.length);
    expect(sup.onEntryMissing('stat ENOENT')).toBe(ENTRY_WAIT_DELAYS_MS[0]);
  });

  it('the remaining wait budget is readable while a wait is pending', () => {
    const sup = new ConsoleSupervisor();
    sup.start();
    expect(sup.entryWaitsLeft()).toBe(ENTRY_WAIT_DELAYS_MS.length);
    sup.onEntryMissing('stat ENOENT');
    expect(sup.entryWaitsLeft()).toBe(ENTRY_WAIT_DELAYS_MS.length - 1);
    for (const delay of ENTRY_WAIT_DELAYS_MS.slice(1)) expect(sup.onEntryMissing('stat ENOENT')).toBe(delay);
    expect(sup.onEntryMissing('stat ENOENT')).toBeUndefined();
    expect(sup.entryWaitsLeft()).toBe(0); // never negative once the episode degraded
  });

  it('refuses to schedule a wait when no launch result is awaited', () => {
    const idle = new ConsoleSupervisor();
    expect(idle.onEntryMissing('stat ENOENT')).toBeUndefined();
    expect(idle.getState().kind).toBe('idle');

    const degraded = new ConsoleSupervisor();
    degraded.start();
    degraded.onSpawnError('EACCES', 'spawn refused');
    expect(degraded.onEntryMissing('stat ENOENT')).toBeUndefined();
    const s = degraded.getState();
    expect(s.kind === 'degraded' && s.detail).toBe('spawn refused'); // not overwritten
  });

  it('the ladder outlasts the update window measured on the 2.3.6 install (1m50s)', () => {
    // Evidence: version_change_restart at 14:11:29.004Z vs journal `staged` at
    // 14:13:18.941Z. Shorten the ladder below that window and the race this
    // ticket is about comes back.
    expect(ENTRY_WAIT_TOTAL_MS).toBeGreaterThanOrEqual(110_000);
    expect(ENTRY_WAIT_TOTAL_MS).toBe(ENTRY_WAIT_DELAYS_MS.reduce((a, b) => a + b, 0));
  });
});

describe('nextRestartDelayMs', () => {
  it('grows 1s → 2s → 4s and caps', () => {
    expect(nextRestartDelayMs(1)).toBe(1_000);
    expect(nextRestartDelayMs(2)).toBe(2_000);
    expect(nextRestartDelayMs(3)).toBe(4_000);
    expect(nextRestartDelayMs(99)).toBe(4_000);
  });

  it('MAX_RESTART_ATTEMPTS is 3', () => {
    expect(MAX_RESTART_ATTEMPTS).toBe(3);
  });
});
