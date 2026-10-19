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

function watchBody(source: string): string {
  const start = source.indexOf('function watchInstalledRelease');
  expect(start, 'watch function exists').toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\nfunction ', start + 1));
}

describe('PRI-1016 — the version watch decides on the installation authority', () => {
  it('the watch is driven by judgeReleaseWatch fed from the active record', () => {
    const source = src();
    expect(source).toContain("from '../lib/release-watch.js'");
    const watch = watchBody(source);
    expect(watch).toContain('judgeReleaseWatch({');
    expect(watch).toContain('read: readActiveRecord()');
    expect(watch).toContain('started: serverStartedRelease');
    expect(watch).toContain('mode: s.mode');
  });

  it('the watch never consults the plugin component version', () => {
    // The marker is a component axis and flips before activation; feeding it to
    // the decision re-creates both the false negative and the PRI-1012 race.
    expect(watchBody(src())).not.toContain('readInstalledVersion');
  });

  it('the record path comes from the install layout, not a literal', () => {
    const source = src();
    expect(source).toContain('activeRecordPath = resolveActiveRecordPath(home);');
    expect(source).not.toContain("'active.json'");
    const readerStart = source.indexOf('function readActiveRecord');
    const reader = source.slice(readerStart, source.indexOf('\nfunction ', readerStart + 1));
    expect(reader).toContain('readActiveRelease(activeRecordPath, fs)');
    // unresolved path is its own structured reason, not a silent undefined
    expect(reader).toContain('active_record_path_unresolved');
  });

  it('a restart is executed by the existing hand-over, not a second restart mechanism', () => {
    const watch = watchBody(src());
    expect(watch).toContain('ownedManagedHandle(s, supervisor.ownsProcess(), cliChild?.pid)');
    expect(watch.indexOf('ownedManagedHandle(')).toBeLessThan(watch.indexOf('supervisor.onServerExit(null)'));
    expect(watch).toContain('killManagedServerAndConfirm(');
    expect(watch).toContain("scheduleRestartRetry(delay, 'version_change')");
    expect(watch).toContain('pendingTargetRelease = decision.to;');
  });

  it('every non-restart decision is reported, none silently degrades to the marker (rc-9)', () => {
    const watch = watchBody(src());
    expect(watch).toContain("case 'authority_unavailable'");
    expect(watch).toContain("log('release_watch_unavailable'");
    expect(watch).toContain("case 'no_baseline'");
    expect(watch).toContain('version_change_attached_no_action');
    // the restart log carries the identity evidence an operator needs
    const restartAt = watch.indexOf("log('version_change_restart'");
    expect(restartAt).toBeGreaterThan(-1);
    const event = watch.slice(restartAt, watch.indexOf('});', restartAt));
    for (const field of ['from', 'to', 'fromGeneration', 'toGeneration', 'fromVersion', 'toVersion']) {
      expect(event, field).toMatch(new RegExp(`[({,]\\s*${field}\\s*[,:]`));
    }
  });

  it('the launch baseline is the record read at that moment, and a failed read is logged', () => {
    const source = src();
    const start = source.indexOf('function handleLaunchResult');
    const handler = source.slice(start, source.indexOf('\nfunction ', start + 1));
    expect(handler.split('const record = readActiveRecord();').length - 1).toBe(2);
    expect(handler.split("log('release_baseline_unavailable'").length - 1).toBe(2);
    expect(handler).toContain('serverStartedRelease = record.ok ? record.identity : undefined;');
    // the hand-over gate compares release ids, never a component version
    expect(handler).toContain('judgeVersionChangeLaunch(pendingTargetRelease?.releaseId, parsed');
  });

  it('an Owner stop drops both the pending hand-over and the baseline', () => {
    const source = src();
    const stopStart = source.indexOf('function stopServer');
    const stop = source.slice(stopStart, source.indexOf('\nfunction ', stopStart + 1));
    expect(stop).toContain('pendingTargetRelease = undefined;');
    expect(stop).toContain('serverStartedRelease = undefined;');
  });
});
