// PRI-796 (git-12): the repo mutation mutex is a CROSS-PROCESS guarantee, so the
// load-bearing cases here hold it from a real child process. An in-process test
// would prove nothing about the failure this exists to prevent.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MUTATION_LOCK_FILENAME,
  acquireMutationLock,
  mutationLockPath,
  readMutationLock,
  withMutationLock,
} from '../dev/lib/git-mutation-lock.mjs';
import { DEV_SCRIPTS_DIR, makeTempDir, removeFixture, runNode } from './dev-worktree-test-utils';

// A file:// URL, not a native path: the child loads this with a dynamic ESM
// import, and `import()` rejects a Windows backslash path.
const MUTEX_MODULE_URL = pathToFileURL(path.join(DEV_SCRIPTS_DIR, 'lib', 'git-mutation-lock.mjs')).href;

let commonDir: string;

beforeEach(() => {
  // A plain directory stands in for <git-common-dir>: the mutex is pure
  // filesystem coordination and needs no repository to be exercised.
  commonDir = makeTempDir('pd-mutation-lock-');
});

afterEach(() => {
  removeFixture(commonDir);
});

/** A child process that holds the mutex for N ms, then releases it. */
function writeHolderHelper(dir: string): string {
  const file = path.join(dir, 'hold-lock.mjs');
  fs.writeFileSync(
    file,
    [
      "const { acquireMutationLock } = await import(process.env.PD_MUTEX_MODULE);",
      'const lock = acquireMutationLock({',
      '  commonDir: process.argv[2],',
      "  operation: 'test-hold',",
      "  target: 'fixture',",
      '});',
      'if (!lock.ok) {',
      "  console.log('DENIED ' + lock.code);",
      '  process.exit(3);',
      '}',
      "console.log('HELD');",
      'setTimeout(() => { lock.release(); process.exit(0); }, Number(process.argv[3]));',
    ].join('\n'),
    'utf-8'
  );
  return file;
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // PRI-796 review: existence alone leaves a window where the holder created
  // the file but the JSON is not yet readable — poll the PARSED state instead
  // so the loser's holder assertions cannot race the write.
  const dir = path.dirname(file);
  while (Date.now() < deadline) {
    const state = readMutationLock(dir);
    if (state.exists && state.valid) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('repo mutation mutex', () => {
  it('lets exactly one process hold it, and the loser fails loud with the holder identity', async () => {
    const helper = writeHolderHelper(commonDir);
    const holder = runNode([helper, commonDir, '3000'], { env: { PD_MUTEX_MODULE: MUTEX_MODULE_URL } });
    await waitForFile(mutationLockPath(commonDir));
    if (!fs.existsSync(mutationLockPath(commonDir))) {
      // Surface the child's own error rather than a bare assertion failure.
      const failed = await holder;
      throw new Error('the holder child never took the lock.\nstdout: ' + failed.stdout + '\nstderr: ' + failed.stderr);
    }

    const loser = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'other' });
    expect(loser.ok).toBe(false);
    // The message must name the holder — otherwise an operator cannot decide
    // whether removing the lock is safe.
    expect(loser.holder).toContain('test-hold');
    expect(loser.holder).toContain('pid');

    const holderResult = await holder;
    expect(holderResult.stdout).toContain('HELD');
    expect(holderResult.code).toBe(0);

    // The holder released on exit — the mutex is takeable again.
    const after = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'other' });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  }, 60_000);

  it('never overwrites an existing lock and never auto-deletes it', () => {
    const first = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(first.ok).toBe(true);
    const before = readMutationLock(commonDir);
    expect(before.exists).toBe(true);

    const second = acquireMutationLock({ commonDir, operation: 'worktree-remove', target: 'b' });
    expect(second.ok).toBe(false);

    // The original record is untouched — a later process must not be able to
    // clobber a live holder's identity.
    const after = readMutationLock(commonDir);
    expect(after.exists).toBe(true);
    const tokenOf = (state: typeof after): string | null => (state.exists && state.valid ? state.lock.token : null);
    expect(tokenOf(after)).toBe(tokenOf(before));

    if (first.ok) first.release();
    expect(fs.existsSync(mutationLockPath(commonDir))).toBe(false);
  });

  it('fails closed on an unparsable lock file instead of trusting or replacing it', () => {
    fs.writeFileSync(mutationLockPath(commonDir), 'not json at all', 'utf-8');
    const result = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(result.ok).toBe(false);
    expect(result.holder).toContain('unreadable');
    // And it is still there — we did not "fix" the problem by deleting a
    // possibly-live holder's file.
    expect(fs.readFileSync(mutationLockPath(commonDir), 'utf-8')).toBe('not json at all');
  });

  it('release is idempotent', () => {
    const lock = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(lock.ok).toBe(true);
    if (!lock.ok) throw new Error('unreachable');
    expect(lock.release().released).toBe(true);
    expect(lock.release().released).toBe(false);
    expect(fs.existsSync(mutationLockPath(commonDir))).toBe(false);
  });

  it('refuses to delete a lock whose ownership token changed underneath it', () => {
    const lock = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(lock.ok).toBe(true);
    if (!lock.ok) throw new Error('unreachable');

    // Simulate a successor having taken over the file (e.g. after a human
    // cleared the original). The straggler must not unlink it.
    const file = mutationLockPath(commonDir);
    const successor = { ...JSON.parse(fs.readFileSync(file, 'utf-8')), token: 'deadbeefdeadbeefdeadbeefdeadbeef' };
    fs.writeFileSync(file, JSON.stringify(successor, null, 2), 'utf-8');

    const outcome = lock.release();
    expect(outcome.released).toBe(false);
    expect(outcome.reason).toMatch(/no longer owned/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('releases the lock even when the guarded operation throws', async () => {
    await expect(
      withMutationLock({ commonDir, operation: 'worktree-add', target: 'a' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(mutationLockPath(commonDir))).toBe(false);
  });

  it('puts the lock inside the shared git dir, named as documented', () => {
    expect(path.basename(mutationLockPath(commonDir))).toBe(MUTATION_LOCK_FILENAME);
    expect(MUTATION_LOCK_FILENAME).toBe('pd-worktree-mutation.lock');
  });

  // PRI-796 review: the real one-writer property is that a straggler's release
  // can never delete a SUCCESSOR's lock. A successor always re-acquires with a
  // fresh token — deterministic on every platform.
  it('release after a human recovery + successor takeover leaves the successor lock intact', () => {
    const a = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'wt' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    fs.rmSync(mutationLockPath(commonDir)); // codeql[js/file-system-race] -- intentional: human-recovery step of the tested takeover scenario
    const b = acquireMutationLock({ commonDir, operation: 'worktree-remove', target: 'wt' });
    expect(b.ok).toBe(true);

    const r = a.release();
    expect(r.released).toBe(false);
    expect(r.reason).toMatch(/no longer owned|replaced/);
    expect(readMutationLock(commonDir).exists).toBe(true);
    if (b.ok) expect(b.release().released).toBe(true);
  });

  // The inode pin additionally closes the IDENTICAL-content window (a human
  // restoring a byte-copy of our lock). Whether a recreated file keeps the
  // same inode is platform behaviour (Linux recycles; NTFS assigns a fresh
  // index) — assert the contract for whichever case the platform shows.
  it('release distinguishes file identity when the platform reports inodes', () => {
    const a = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'wt' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const file = mutationLockPath(commonDir);
    const content = fs.readFileSync(file, 'utf-8');
    const inoBefore = fs.statSync(file).ino;
    // Deliberate single-threaded construction: the rm+recreate IS the scenario
    // under test (a replacement wearing our bytes); both inode outcomes are
    // asserted explicitly below.
    fs.rmSync(file); // codeql[js/file-system-race] -- intentional fixture race setup
    // codeql[js/file-system-race] -- intentional fixture race setup (sink of the flagged chain)
    fs.writeFileSync(file, content, 'utf-8');
    const inoAfter = fs.statSync(file).ino;

    const r = a.release();
    if (inoBefore !== inoAfter) {
      // Different file object wearing our content: refuse, keep the object.
      expect(r.released).toBe(false);
      expect(readMutationLock(commonDir).exists).toBe(true);
    } else {
      // Platform recycled the identity — the same content is ours to release.
      expect(r.released).toBe(true);
      expect(readMutationLock(commonDir).exists).toBe(false);
    }
  });
});
