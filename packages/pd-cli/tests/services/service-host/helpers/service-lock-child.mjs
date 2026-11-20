/**
 * Child helper for the multi-process lock contention test. A FIXED script:
 * no code is ever interpolated into it — the only inputs are argv data
 * (the sandbox home, an optional hold delay, and an optional gate spec).
 *
 * Exit contract: 0 = acquired (+ released after the hold delay),
 * 7 = held, 8 = corrupt, 9 = unwritable.
 *
 * Gate mode (deterministic interleavings — P1-4):
 *   argv[4] = comma-separated takeover phases to pause at
 *             ('mutex-acquired', 'stale-verified', 'lock-removed');
 *   argv[5] = flag directory. At each listed phase the child writes
 *             `<flagDir>/at-<phase>` then waits for `<flagDir>/go-<phase>`
 *             to appear (bounded poll on a real condition — never a random
 *             sleep), so the parent can interleave other contenders at an
 *             exact point inside the critical section.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireServiceRunLock, releaseServiceRunLock } from '../../../../dist/services/service-host/locking/service-run-lock.js';

const home = process.argv[2];
const holdMs = Number(process.argv[3] ?? '0');
const gatePhases = (process.argv[4] ?? '').split(',').filter((p) => p.length > 0);
const flagDir = process.argv[5];

function gate(phase) {
  if (!gatePhases.includes(phase)) return;
  fs.writeFileSync(path.join(flagDir, `at-${phase}`), String(process.pid));
  const goFile = path.join(flagDir, `go-${phase}`);
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) throw new Error(`gate timeout waiting for ${goFile}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const result = acquireServiceRunLock(home, {
  probes: flagDir === undefined ? undefined : { takeoverSync: gate },
});
if (!result.ok) {
  const codes = { held: 7, corrupt: 8, unwritable: 9 };
  process.stdout.write(JSON.stringify({ kind: result.kind }));
  process.exit(codes[result.kind] ?? 9);
}
process.stdout.write(JSON.stringify({ token: result.handle.token, stale: result.staleTakenOver }));
if (holdMs > 0) {
  setTimeout(() => {
    releaseServiceRunLock(result.handle);
    process.exit(0);
  }, holdMs);
} else {
  releaseServiceRunLock(result.handle);
  process.exit(0);
}
