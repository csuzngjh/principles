/**
 * Phase 7.2 P1-02 / P1-C06 — live-PID coordination lock holder child.
 *
 * Acquires the per-candidate coordination lock through the BUILT internal
 * lock module (same path discipline as the adapter) and then idles forever:
 * the holder is ALIVE, so a contender must fail loud, never steal the lock.
 * Killed by the parent test when done.
 *
 * Env: PD_LOCK_STATE_DIR, PD_LOCK_CANDIDATE_ID. Prints "HELD" once acquired.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distLockPath = path.resolve(testsDir, '..', 'dist', 'ledger-file-lock.js');

const stateDir = process.env.PD_LOCK_STATE_DIR;
const candidateId = process.env.PD_LOCK_CANDIDATE_ID;
if (!stateDir || !candidateId) {
  console.error('missing PD_LOCK_* env');
  process.exit(2);
}

const safe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidateId)
  ? candidateId
  : 'hashed-id';
const lockTarget = path.join(stateDir, 'candidate-coordination', safe);

const { withLockAsync } = await import(pathToFileURL(distLockPath).href);

// Never-resolving section: the lock stays held (live PID) until killed.
withLockAsync(lockTarget, () => new Promise(() => {}), { maxRetries: 80, baseRetryDelayMs: 20, maxRetryDelayMs: 200 })
  .then(() => {}, () => {});
process.stdout.write('HELD\n');
// A pending promise alone does NOT keep the Node event loop alive — an idle
// timer does. Without it the child would exit, its lock would read as a DEAD
// holder, and the contender would legitimately reclaim it (P1-C05 instead of
// the P1-C06 live-holder contention this fixture exists to create).
setInterval(() => {}, 1 << 30);
