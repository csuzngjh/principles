/**
 * Child helper for the multi-process lock contention test. A FIXED script:
 * no code is ever interpolated into it — the only inputs are argv data
 * (the sandbox home, an optional hold delay, an optional gate spec, an
 * optional flag directory, and an optional mode).
 *
 * Exit contract: 0 = acquired (+ released after the hold delay),
 * 7 = held, 8 = corrupt, 9 = unwritable, 10 = acquired but the RELEASE
 * genuinely failed (failed_busy / failed_unwritable — never reported as
 * a clean release).
 *
 * Gate mode (deterministic interleavings — P1-4):
 *   argv[4] = comma-separated phases to pause at. Takeover phases
 *             ('mutex-acquired', 'stale-verified', 'lock-removed') run
 *             inside the acquire transaction; 'lock-held' parks the child
 *             AFTER a successful acquire (holding the lock FILE, gate
 *             released); 'release-held' parks INSIDE the release
 *             transaction (gate still held);
 *   argv[5] = flag directory. At each listed phase the child writes
 *             `<flagDir>/at-<phase>` then waits for `<flagDir>/go-<phase>`
 *             to appear (bounded poll on a real condition — never a random
 *             sleep), so the parent can interleave other contenders at an
 *             exact point inside the critical section.
 *
 * Failure-injection mode:
 *   argv[6] = 'acquire-end-fail' → the acquire transaction's END is made
 *             to fail (exercises the orphan-lock compensation path);
 *             'release-end-fail' → the same for the release transaction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireServiceRunLock, releaseServiceRunLock } from '../../../../dist/services/service-host/locking/service-run-lock.js';

const home = process.argv[2];
const holdMs = Number(process.argv[3] ?? '0');
const gatePhases = (process.argv[4] ?? '').split(',').filter((p) => p.length > 0);
const flagDir = process.argv[5] || undefined;
const mode = process.argv[6] ?? '';

function gate(phase) {
  if (flagDir === undefined || !gatePhases.includes(phase)) return;
  fs.writeFileSync(path.join(flagDir, `at-${phase}`), String(process.pid));
  const goFile = path.join(flagDir, `go-${phase}`);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error(`gate timeout waiting for ${goFile}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const result = acquireServiceRunLock(home, {
  probes: {
    ...(flagDir === undefined ? {} : { takeoverSync: gate }),
    ...(mode === 'acquire-end-fail' ? { gateEndFailure: true } : {}),
  },
});
if (!result.ok) {
  const codes = { held: 7, corrupt: 8, unwritable: 9 };
  process.stdout.write(JSON.stringify({ kind: result.kind }));
  process.exit(codes[result.kind] ?? 9);
}
process.stdout.write(JSON.stringify({ token: result.handle.token, stale: result.staleTakenOver }));

function finish() {
  const rel = releaseServiceRunLock(result.handle, {
    ...(mode === 'release-end-fail' ? { injectEndFailure: true } : {}),
    insideTxn: () => gate('release-held'),
  });
  // 0 covers 'released' AND 'not_owned' (a late release after a real
  // takeover is a normal outcome, never a failure); only a genuinely
  // failed release reports 10.
  process.exit(rel === 'failed_busy' || rel === 'failed_unwritable' ? 10 : 0);
}

gate('lock-held');
if (holdMs > 0) {
  setTimeout(finish, holdMs);
} else {
  finish();
}
