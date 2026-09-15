// PRI-796 (git-12): the repo mutation mutex is a CROSS-PROCESS guarantee, so
// the load-bearing cases here hold it from a real child process. An in-process
// test would prove nothing about the failure this exists to prevent.
//
// Round-2 review (the acceptance line for the release protocol): the property
// is "an old holder's release can NEVER delete a successor's lock". v1 tried
// to prove that with a check before the unlink; the check and the unlink could
// always be split by (human recovery + successor acquire). v2 is token-private:
// release unlinks exactly one path — <arena>/owner-<own token>.json — which no
// other process can name. The successor test below runs the REAL sequence
// (A holds → human recovery removes A's record → B really acquires → A's late
// release) and asserts B's claim survives byte-identical.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MUTATION_LOCK_FILENAME,
  MUTATION_LOCK_SCHEMA,
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

async function waitForLockVisible(dir: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Poll the PARSED state, not mere path existence: a holder that created its
  // record but has not finished writing it must not make the loser's holder
  // assertions race the write (PRI-728 shape).
  while (Date.now() < deadline) {
    const state = readMutationLock(dir);
    if (state.exists && state.valid) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function liveToken(): string | null {
  const state = readMutationLock(commonDir);
  return state.exists && state.valid ? state.lock.token : null;
}

const HEX32_RE = /^[0-9a-f]{32}$/;

/** Write a stray owner-shaped record directly (bypassing acquire). */
function rawOwnerRecord(token: string, extra: Record<string, unknown> = {}): string {
  // The token is a fixed fixture basename, whitelisted before it is used as a
  // file name — no caller input ever reaches the path here.
  if (!HEX32_RE.test(token)) throw new Error('fixture bug: non-hex32 token');
  const fileName = 'owner-' + token + '.json';
  const arena = mutationLockPath(commonDir);
  fs.mkdirSync(arena, { recursive: true });
  const file = path.join(arena, fileName);
  fs.writeFileSync(
    file,
    JSON.stringify({ schema: MUTATION_LOCK_SCHEMA, token, operation: 'raw-fixture', pid: 0, ...extra }, null, 2),
    'utf-8'
  );
  return file;
}

describe('repo mutation mutex', () => {
  it('lets exactly one process hold it, and the loser fails loud with the holder identity', async () => {
    const helper = writeHolderHelper(commonDir);
    const holder = runNode([helper, commonDir, '3000'], { env: { PD_MUTEX_MODULE: MUTEX_MODULE_URL } });
    await waitForLockVisible(commonDir);

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
    // Release removed OUR record only; the arena is then simply free.
    expect(readMutationLock(commonDir).exists).toBe(false);
  });

  it('fails closed on an unparsable owner record instead of trusting or replacing it', () => {
    const arena = mutationLockPath(commonDir);
    fs.mkdirSync(arena, { recursive: true });
    const bogus = path.join(arena, 'owner-ffffffffffffffffffffffffffffffff.json');
    fs.writeFileSync(bogus, 'not json at all', 'utf-8');
    const result = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(result.ok).toBe(false);
    expect(result.holder).toContain('unreadable');
    // And it is still there — we did not "fix" the problem by deleting a
    // possibly-live holder's file.
    expect(fs.readFileSync(bogus, 'utf-8')).toBe('not json at all');
  });

  it('treats an owner record whose embedded token does not match its file name as unreadable', () => {
    const file = rawOwnerRecord('a'.repeat(32), { token: 'b'.repeat(32) });
    const state = readMutationLock(commonDir);
    expect(state.exists).toBe(true);
    expect(state.valid).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('elects the oldest live claim as holder (create-then-verify election)', () => {
    const newer = rawOwnerRecord('a'.repeat(32), { operation: 'newer-claim' });
    const older = rawOwnerRecord('b'.repeat(32), { operation: 'older-claim' });
    const t = new Date(Date.now() - 60_000);
    fs.utimesSync(older, t, t);
    expect(liveToken()).toBe('b'.repeat(32));
    // The loser of the election would remove only its own record; reading the
    // mutex must never touch either file.
    expect(fs.existsSync(newer)).toBe(true);
    expect(fs.existsSync(older)).toBe(true);
  });

  // Round-3 review: when two claims share one mtime tick, the winner must be
  // decided by a STRICT TOTAL ORDER on the token — never by readdir order,
  // which two processes may legitimately see differently.
  it('equal-mtime claims elect the same winner in either creation order', () => {
    const tokHi = 'f'.repeat(32); // lexicographically LATER
    const tokLo = '1'.repeat(32); // lexicographically EARLIER
    const tick = new Date(Date.now() - 30_000);

    const arenaA = makeTempDir('pd-election-a-');
    const arenaB = makeTempDir('pd-election-b-');
    try {
      const rec = (arena: string, token: string) => {
        // Fixed fixture tokens, whitelist-checked before use as file names,
        // every derived path bound-checked to its arena root.
        if (!HEX32_RE.test(token)) throw new Error('fixture bug: non-hex32 token');
        const dir = path.resolve(arena, MUTATION_LOCK_FILENAME);
        const arenaBase = path.resolve(arena) + path.sep;
        if (!dir.startsWith(arenaBase)) throw new Error('fixture bug: arena escaped');
        fs.mkdirSync(dir, { recursive: true });
        const fileName = 'owner-' + token + '.json';
        const file = path.resolve(dir, fileName);
        if (!file.startsWith(dir + path.sep)) throw new Error('fixture bug: record escaped arena');
        fs.writeFileSync(file, JSON.stringify({ schema: MUTATION_LOCK_SCHEMA, token, operation: 'tie', pid: 0 }, null, 2), 'utf-8');
        fs.utimesSync(file, tick, tick);
        return file;
      };
      // Creation order differs between the two arenas; the readdir order may
      // follow it. The winner must not.
      rec(arenaA, tokHi);
      rec(arenaA, tokLo);
      rec(arenaB, tokLo);
      rec(arenaB, tokHi);
      const stateA = readMutationLock(arenaA);
      const stateB = readMutationLock(arenaB);
      expect(stateA.exists && stateA.valid).toBe(true);
      expect(stateB.exists && stateB.valid).toBe(true);
      if (stateA.valid && stateB.valid) {
        expect(stateA.lock.token).toBe(stateB.lock.token);
        expect(stateA.lock.token).toBe(tokLo); // the earlier token wins, deterministically
      }
    } finally {
      removeFixture(arenaA);
      removeFixture(arenaB);
    }
  });

  // Round-3 P1 (Owner review): post-election must fail CLOSED. A malformed
  // peer alongside our own live claim must NOT let us win — the peer can
  // still complete with an OLDER creation order, and then two processes
  // would each consider themselves the holder of the mutex. Verified
  // deterministically through the injection seam, not child-process timing.
  it('post-election steps back while a malformed peer exists, removing only its own record', () => {
    const arenaDir = mutationLockPath(commonDir);
    const peer = path.resolve(arenaDir, 'owner-cccccccccccccccccccccccccccccccc.json');
    let injected = false;
    const result = acquireMutationLock({
      commonDir,
      operation: 'worktree-add',
      target: 'a',
      afterOwnCreate: () => {
        // A concurrent claimant that became visible mid-verify and died
        // half-writing its JSON — older mtime: had it parsed, IT would win.
        fs.writeFileSync(peer, '{"schema": "pd-worktr', 'utf-8');
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(peer, old, old);
        injected = true;
      },
    });
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.holder).toContain('unreadable');
    // We never delete foreign records — only our own file left the arena.
    expect(fs.existsSync(peer)).toBe(true);
    expect(fs.readdirSync(arenaDir)).toEqual(['owner-cccccccccccccccccccccccccccccccc.json']);
    // And the board stays fail-closed for readers too.
    expect(readMutationLock(commonDir)).toMatchObject({ exists: true, valid: false });
    fs.rmSync(peer);
  });

  it('release is idempotent and frees the arena', () => {
    const lock = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(lock.ok).toBe(true);
    if (!lock.ok) throw new Error('unreachable');
    expect(lock.release().released).toBe(true);
    expect(lock.release().released).toBe(false);
    expect(readMutationLock(commonDir).exists).toBe(false);
    const again = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'a' });
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
  });

  it('releases the lock even when the guarded operation throws', async () => {
    await expect(
      withMutationLock({ commonDir, operation: 'worktree-add', target: 'a' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(readMutationLock(commonDir).exists).toBe(false);
  });

  it('puts the arena inside the shared git dir, named as documented', () => {
    expect(path.basename(mutationLockPath(commonDir))).toBe(MUTATION_LOCK_FILENAME);
    expect(MUTATION_LOCK_FILENAME).toBe('pd-worktree-mutation.lock');
  });

  // THE ACCEPTANCE SCENARIO (round-2 review): human recovery + a REAL
  // successor acquire happen while the old holder's release is still pending.
  // A's release is a private-path unlink; B's claim is a different file that A
  // structurally cannot name. B must survive byte-identical.
  it('a straggler release after human recovery + real successor acquire leaves the successor lock intact', () => {
    const a = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'wt' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const aFile = a.file;

    // Human recovery: remove exactly the dead holder's record (the documented
    // recovery is to remove only that holder's owner file — no shared-path
    // dance anywhere in the protocol).
    fs.rmSync(aFile);

    const b = acquireMutationLock({ commonDir, operation: 'worktree-remove', target: 'wt2' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const bBefore = fs.readFileSync(b.file, 'utf-8');

    const r = a.release();
    expect(r.released).toBe(false);
    expect(r.reason).toMatch(/already gone/);

    // B's lock is untouched — same bytes, same token, still the holder.
    expect(fs.existsSync(b.file)).toBe(true);
    expect(fs.readFileSync(b.file, 'utf-8')).toBe(bBefore);
    expect(liveToken()).toBe(b.record.token);

    // And the arena still serialises: C cannot get in while B holds it.
    const c = acquireMutationLock({ commonDir, operation: 'worktree-prune', target: 'wt3' });
    expect(c.ok).toBe(false);
    expect(c.holder).toContain('worktree-remove');

    b.release();
  });

  // Same invariant through the harsher recovery shape: the whole arena was
  // removed, the successor recreated it, the straggler holds an old path.
  it('a straggler release after the entire arena was recreated cannot kill the successor', () => {
    const a = acquireMutationLock({ commonDir, operation: 'worktree-add', target: 'wt' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    fs.rmSync(mutationLockPath(commonDir), { recursive: true, force: true });

    const b = acquireMutationLock({ commonDir, operation: 'worktree-remove', target: 'wt2' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    const r = a.release();
    expect(r.released).toBe(false);
    expect(fs.existsSync(b.file)).toBe(true);
    expect(liveToken()).toBe(b.record.token);
    b.release();
  });
});
