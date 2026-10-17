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
    const event = source.slice(source.indexOf(marker), source.indexOf(marker) + 400);
    for (const field of ['entry', 'detail', 'state', 'willRetryInMs', 'targetVersion']) {
      expect(event, field).toMatch(new RegExp(`[({,]\\s*${field}\\s*[,:]`));
    }
  });

  it('the retry is scheduled under the same quitting/state guard as the crash restart', () => {
    const source = src();
    const guard = "if (!quitting && supervisor.getState().kind === 'restarting') spawnCli();";
    expect(source.split(guard).length - 1).toBeGreaterThanOrEqual(3); // crash retry, version-change retry, entry retry
    expect(source).toContain('if (delay !== undefined) {');
  });

  it('the update-chain race is documented where the wait budget is declared', () => {
    const supervisor = fs.readFileSync(fileURLToPath(new URL('../../src/lib/supervisor.ts', import.meta.url)), 'utf8');
    expect(supervisor).toContain('ENTRY_WAIT_DELAYS_MS');
    expect(supervisor).toContain('version_change_restart');
    expect(supervisor).toContain('PRI-1012');
  });
});
