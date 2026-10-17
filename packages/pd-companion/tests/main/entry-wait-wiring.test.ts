/**
 * PRI-1012 wiring guard.
 *
 * main.ts is the Electron main process and cannot be driven inside vitest
 * (same constraint as coexistence.test.ts, which established the source
 * characterisation precedent for this package). The behavioural contract of
 * the fix lives in the pure state machine and is tested there
 * (tests/lib/supervisor.test.ts + tests/bdd/supervisor.steps.ts); this file
 * only locks the production assembly: the spawn path must route a transiently
 * missing pd-cli entry into the bounded entry-wait, and must keep logging it.
 *
 * Production-path evidence beyond this guard is the manual recipe in the PR
 * description (point PD_WORKSPACE/installed runtime at a directory whose
 * pd-cli/dist/index.js is absent, then trigger a tray restart and read the
 * `pd_cli_entry_not_ready` lines from the Companion log).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN_SRC = fileURLToPath(new URL('../../src/main/main.ts', import.meta.url));

function src(): string {
  return fs.readFileSync(MAIN_SRC, 'utf8');
}

describe('PRI-1012 — pd-cli entry check is a bounded wait, not an instant degrade', () => {
  it('spawnCli classifies the entry through the lib verdict seam', () => {
    const source = src();
    expect(source).toContain("from '../lib/entry-verdict.js'");
    expect(source).toContain('entryFileVerdict(entry)');
    // the fail-closed boolean that conflated "missing now" with "never a file"
    expect(source).not.toContain('isSafeExistingFile');
  });

  it('the seam itself distinguishes transient damage from an unsafe candidate', () => {
    const lib = fs.readFileSync(fileURLToPath(new URL('../../src/lib/entry-verdict.ts', import.meta.url)), 'utf8');
    // filesystem state wrong right now → worth waiting on
    expect(lib).toContain('transient: true');
    // value itself unsafe → never worth waiting on
    expect(lib).toContain('transient: false');
  });

  it('only a non-transient verdict still degrades immediately', () => {
    const source = src();
    expect(source).toContain('if (!entryCheck.transient) {');
    expect(source).toContain("log('pd_cli_entry_rejected'");
  });

  it('a transient miss asks the supervisor for a wait and logs the decision (rc-9)', () => {
    const source = src();
    expect(source).toContain('supervisor.onEntryMissing(entryCheck.detail)');
    const marker = "log('pd_cli_entry_not_ready'";
    expect(source).toContain(marker);
    // the log must carry what the next operator needs to tell a race from damage
    const start = source.indexOf(marker);
    const event = source.slice(start, source.indexOf('});', start));
    for (const field of ['entry', 'detail', 'state', 'willRetryInMs', 'waitsLeft', 'fromVersion', 'targetVersion']) {
      expect(event, field).toMatch(new RegExp(`[({,]\\s*${field}\\s*[,:]`));
    }
  });

  it('every restart retry shares one guarded helper, so two chains cannot be live at once', () => {
    const source = src();
    // one place decides when a pending retry fires
    expect(source).toContain("restartRetryTimer = setTimeout(() => {");
    const guard = "if (quitting || s.kind !== 'restarting') {";
    expect(source.split(guard).length - 1).toBe(1);
    // the entry wait is not free of that guard: a tray restart during a 60s wait
    // must cancel the pending chain instead of spawning a second CLI the quit
    // path no longer owns.
    expect(source).toContain("scheduleRestartRetry(delay, 'entry_wait')");
    for (const why of ['server_exit', 'attached_server_lost', 'version_change']) {
      expect(source, why).toContain(`scheduleRestartRetry(delay, '${why}')`);
    }
    // no ad-hoc retry timers survive
    expect(source).not.toContain("if (!quitting && supervisor.getState().kind === 'restarting') spawnCli();");
    expect(source).toContain('  clearRestartRetry();\n  supervisor.markIntentionalStop();');
  });

  it('the cold-start path uses the same verdict and hands a transient miss to the wait', () => {
    const source = src();
    expect(source).toContain('const coldStartEntry = entryFileVerdict(resolvePdCliEntry(extDir))');
    expect(source).toContain('coldStartEntry.transient && runtime?.fallbackReason === undefined');
    // a raw existence test here degraded an in-flight update and told the Owner
    // to re-run the installer — the §1.1 hazard this ticket is about
    expect(source).not.toContain('fs.existsSync(resolvePdCliEntry(');
  });

  it('the tray says what is actually happening while the entry is waited on', () => {
    const source = src();
    expect(source).toContain('ENTRY_PENDING_REASON_PREFIX');
    expect(source).toContain("'等待 PD 更新完成…'");
  });

  it('the update-chain race is documented where the wait budget is declared', () => {
    const supervisor = fs.readFileSync(fileURLToPath(new URL('../../src/lib/supervisor.ts', import.meta.url)), 'utf8');
    expect(supervisor).toContain('ENTRY_WAIT_DELAYS_MS');
    expect(supervisor).toContain('version_change_restart');
    expect(supervisor).toContain('PRI-1012');
  });
});
