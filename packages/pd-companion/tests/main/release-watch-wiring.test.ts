/**
 * PRI-1016 wiring guard.
 *
 * main.ts is the Electron main process and cannot be driven inside vitest
 * (same constraint as coexistence.test.ts and entry-wait-wiring.test.ts, which
 * established the source-characterisation precedent for this package). The
 * decision itself is tested as pure logic (tests/lib/release-watch.test.ts +
 * the BDD feature); this file locks the production assembly: the version watch
 * must feed the installation authority into that decision and must not fall
 * back to the plugin component version.
 *
 * The shapes below are matched as patterns, not as transcribed statements: this
 * guard exists to catch a wiring change, and it must not light up because a
 * call was re-wrapped onto the next line.
 *
 * Production-path evidence beyond this guard is the manual recipe in the PR
 * description (installed runtime + a managed Console, apply an update, then
 * read the `version_change_restart` line and the release ids from the
 * Companion log).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN_SRC = fileURLToPath(new URL('../../src/main/main.ts', import.meta.url));

function src(): string {
  return fs.readFileSync(MAIN_SRC, 'utf8');
}

/** The body of a top-level function, from its declaration to the next one. */
function topLevelFn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + 1);
  const end = next === -1 ? source.length : next;
  const body = source.slice(start, end);
  expect(body.length).toBeGreaterThan(0);
  expect(body.length, `${name} slice must stop at the next function`)
    .toBeLessThan(source.length);
  return body;
}

function expectShape(section: string, what: string, pattern: RegExp): void {
  expect(pattern.test(section), what).toBe(true);
}

function countMatches(section: string, pattern: RegExp): number {
  return Array.from(section.matchAll(pattern)).length;
}

/** The argument object of a `log('event', ...)` call, braces included. */
function logEvent(section: string, event: string): string {
  const match = new RegExp(String.raw`log\('${event}',\s*(\{[^}]*\})\s*\)`, 's').exec(section);
  expect(match, `${event} is logged`).not.toBeNull();
  return match[1];
}

describe('PRI-1016 — the version watch decides on the installation authority', () => {
  it('the watch is driven by judgeReleaseWatch fed from the active record', () => {
    const source = src();
    expectShape(source, 'imports the release-watch module',
      /import\s*\{[^}]*\bjudgeReleaseWatch\b[^}]*\}\s*from\s*['"][^'"]*release-watch\.js['"]/);
    const watch = topLevelFn(source, 'watchInstalledRelease');
    expectShape(watch, 'decides via judgeReleaseWatch', /judgeReleaseWatch\(\s*\{/);
    expectShape(watch, 'reads the installation authority', /read:\s*readActiveRecord\(\)/);
    expectShape(watch, 'compares against the launched release baseline', /started:\s*serverStartedRelease\b/);
    expectShape(watch, 'honours the ownership mode', /mode:\s*s\.mode\b/);
  });

  it('the watch never consults the plugin component version', () => {
    // The marker is a component axis and flips before activation; feeding it to
    // the decision re-creates both the false negative and the PRI-1012 race.
    expect(topLevelFn(src(), 'watchInstalledRelease')).not.toContain('readInstalledVersion');
  });

  it('the record path comes from the install layout, not a literal', () => {
    const source = src();
    expectShape(source, 'path resolved from the install layout',
      /activeRecordPath\s*=\s*resolveActiveRecordPath\(\s*home\s*\)/);
    // A quoted 'active.json' in main.ts would mean this process invents the
    // install path instead of taking it from the shared layout authority.
    expect(/['"`]active\.json['"`]/.test(source)).toBe(false);
    const reader = topLevelFn(source, 'readActiveRecord');
    expectShape(reader, 'reads the resolved path through the release watcher',
      /readActiveRelease\(\s*activeRecordPath\s*,\s*fs\s*\)/);
    // unresolved path is its own structured reason, not a silent undefined
    expectShape(reader, 'an unresolved path fails closed with a reason', /active_record_path_unresolved/);
  });

  it('a restart is executed by the existing hand-over, not a second restart mechanism', () => {
    const watch = topLevelFn(src(), 'watchInstalledRelease');
    expectShape(watch, 'snapshots the owned handle before the state changes', /ownedManagedHandle\(/);
    expect(watch.indexOf('ownedManagedHandle(')).toBeLessThan(watch.indexOf('supervisor.onServerExit(null)'));
    expectShape(watch, 'kills the old server through the confirmed-stop helper', /killManagedServerAndConfirm\(/);
    expectShape(watch, 'respawns through the shared retry ladder',
      /scheduleRestartRetry\(\s*delay\s*,\s*['"]version_change['"]\s*\)/);
    expectShape(watch, 'registers the target release for the launch hand-over',
      /pendingTargetRelease\s*=\s*decision\.to\b/);
  });

  it('every non-restart decision is reported, none silently degrades to the marker (rc-9)', () => {
    const watch = topLevelFn(src(), 'watchInstalledRelease');
    for (const arm of ['authority_unavailable', 'no_baseline', 'attached_no_action']) {
      expectShape(watch, `handles the ${arm} decision`, new RegExp(`case '${arm}'`));
    }
    expectShape(watch, 'reports an unavailable authority', /log\('release_watch_unavailable'/);
    expectShape(watch, 'reports an attached divergence', /log\('version_change_attached_no_action'/);
    // the restart log carries the identity evidence an operator needs
    const restart = logEvent(watch, 'version_change_restart');
    for (const field of ['from', 'to', 'fromGeneration', 'toGeneration', 'fromVersion', 'toVersion']) {
      expectShape(restart, `restart log carries ${field}`, new RegExp(`[({,]\\s*${field}\\s*[,:]`));
    }
  });

  it('the launch baseline is the record read at that moment, and a failed read is logged', () => {
    const handler = topLevelFn(src(), 'handleLaunchResult');
    // Both outcomes that claim a live Console (started / reused) register the
    // baseline and report a failed read — one path quietly missing is the defect.
    expect(countMatches(handler, /readActiveRecord\(\)/g)).toBe(2);
    expect(countMatches(handler, /serverStartedRelease\s*=\s*record\.ok\s*\?\s*record\.identity\s*:\s*undefined/g)).toBe(2);
    expect(countMatches(handler, /log\('release_baseline_unavailable'/g)).toBe(2);
    // the hand-over gate compares release ids, never a component version
    expectShape(handler, 'the hand-over gate is keyed on the release identity',
      /judgeVersionChangeLaunch\(\s*pendingTargetRelease\?\.releaseId/);
  });

  it('the entry-wait log proves the race on the release axis, not only the marker', () => {
    const notReady = logEvent(src(), 'pd_cli_entry_not_ready');
    for (const field of ['fromReleaseId', 'targetReleaseId', 'authorityUnavailable']) {
      expectShape(notReady, `entry-wait log carries ${field}`, new RegExp(`[({,]\\s*${field}\\s*[,:]`));
    }
  });

  it('an Owner stop drops both the pending hand-over and the baseline', () => {
    const stop = topLevelFn(src(), 'stopServer');
    expectShape(stop, 'the pending target is dropped', /pendingTargetRelease\s*=\s*undefined/);
    expectShape(stop, 'the release baseline is dropped', /serverStartedRelease\s*=\s*undefined/);
  });
});


describe('PRI-1040 worker release watch production wiring', () => {
  it('both host registries receive authority and reconcile on timers independent of Console state', () => {
    const section = topLevelFn(src(), 'startWorkspaceWorkerSupervision');
    expect(countMatches(section, /readRelease:\s*readActiveRecord/g)).toBe(2);
    expect(countMatches(section, /setInterval\(/g)).toBe(2);
    expect(countMatches(section, /syncFromManifest\(/g)).toBe(4);
    expect(section).not.toContain('supervisor.getState');
    expect(countMatches(section, /workspace_worker_handover_degraded/g)).toBe(2);
    expect(topLevelFn(src(), 'rebuildTrayMenu')).toContain('handoverIssues()');
    expect(topLevelFn(src(), 'spawnWorkspaceWorkerFor')).toMatch(/stdio:\s*\['ignore', 'ignore', 'pipe', 'ipc'\]/);
  });
});
