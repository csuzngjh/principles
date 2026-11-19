/**
 * Package-wide real-home write sentinel (vitest `setupFiles`).
 *
 * Snapshots the REAL user profile's PD identity state (active.json,
 * install.json, transactions/backups listings, the OpenClaw extension slot)
 * before a test file runs and asserts it is byte-identical afterwards.
 *
 * Why this exists next to per-file sandboxing: a test that forgets to pin a
 * home authority — or pins only `HOME` while a consumer reads `os.homedir()`
 * (USERPROFILE on Windows, e.g. agent-skill.ts / installers/index.ts) — still
 * passes its own assertions while corrupting the machine's deployment
 * identity. That is exactly how the fixture version `1.230.2` ended up in the
 * Owner's real `~/.pd/active.json` and surfaced in the console version
 * history. The fixture cannot detect its own escape; this sentinel can.
 *
 * Read-only by construction: it observes and reports, it never repairs.
 */
import { afterAll } from 'vitest';
import { assertRealHomeStateUnchanged, snapshotRealHomeState } from './home-sandbox.js';

const beforeRun = realHomeRootSnapshot();

// Snapshot lazily so a module-load failure never masks the suite's real result.
function realHomeRootSnapshot(): ReturnType<typeof snapshotRealHomeState> {
  try {
    return snapshotRealHomeState();
  } catch {
    // Fail-open on the SNAPSHOT only: an unreadable home records as
    // `unreadable:*` entries during describePath(), so this catch is a
    // last-resort guard against an exotic environment, not a normal path.
    return { roots: [], entries: [] };
  }
}

afterAll(() => {
  if (beforeRun.roots.length === 0) return;
  assertRealHomeStateUnchanged(beforeRun, 'the installer test suite');
});
