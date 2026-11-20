/**
 * Child helper for the multi-process lock contention test. A FIXED script:
 * no code is ever interpolated into it — the only inputs are argv data
 * (the sandbox home and an optional hold delay).
 *
 * Exit contract: 0 = acquired (+ released after the hold delay),
 * 7 = held, 8 = corrupt, 9 = unwritable.
 */
import { acquireServiceRunLock, releaseServiceRunLock } from '../../../../dist/services/service-host/locking/service-run-lock.js';

const home = process.argv[2];
const holdMs = Number(process.argv[3] ?? '0');
const result = acquireServiceRunLock(home);
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
