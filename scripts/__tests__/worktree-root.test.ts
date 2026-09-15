// PRI-796: the shared worktree pool and the task identity it encodes.
// Pure logic — no git, no filesystem.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POOL_DIRNAME,
  WORKTREE_ROOT_ENV,
  resolveTaskIdentity,
  resolveWorktreeRoot,
  taskIdentityFromBranch,
  utcDateStamp,
  worktreePathFor,
} from '../dev/lib/worktree-root.mjs';

// PORTABILITY: this test file runs on Windows AND on the Linux CI runner. A
// literal 'D:/Code/principles' is an ABSOLUTE path on Windows but a RELATIVE one
// on POSIX, so it must not be used as a fixture here — the platform-appropriate
// absolute form is built with path.resolve, and the real Windows layout is pinned
// separately below.
const PRIMARY = path.resolve(path.sep, 'srv', 'code', 'principles');
const OTHER_PRIMARY = path.resolve(path.sep, 'elsewhere', 'other', 'principles');

describe('resolveWorktreeRoot (git-10)', () => {
  it('derives the pool from the primary checkout without any hardcoded drive', () => {
    const { root, source } = resolveWorktreeRoot({ primaryPath: PRIMARY, env: {} });
    expect(source).toBe('derived');
    expect(root).toBe(path.join(path.dirname(PRIMARY), POOL_DIRNAME, 'principles'));
    // The derivation must FOLLOW the primary rather than a literal — the repo
    // lives on a different drive in CI and on other machines.
    const other = resolveWorktreeRoot({ primaryPath: OTHER_PRIMARY, env: {} });
    expect(other.root).toBe(path.join(path.dirname(OTHER_PRIMARY), POOL_DIRNAME, 'principles'));
    expect(other.root).not.toBe(root);
  });

  it.runIf(process.platform === 'win32')('derives D:\\Code\\_worktrees\\principles for D:\\Code\\principles', () => {
    // The Owner's actual layout — pinned only where drive letters exist.
    const { root } = resolveWorktreeRoot({ primaryPath: path.join('D:', 'Code', 'principles'), env: {} });
    expect(root).toBe(path.join('D:', 'Code', '_worktrees', 'principles'));
  });

  it('refuses a path that is not absolute FOR THIS PLATFORM instead of fabricating one', () => {
    // On POSIX a Windows-shaped path is relative; resolving it would silently
    // produce '<cwd>/D:/Code/...'. Fail loud instead (found by CI).
    const notAbsoluteHere = process.platform === 'win32' ? 'relative/dir' : 'D:/Code/principles';
    expect(() => resolveWorktreeRoot({ primaryPath: notAbsoluteHere, env: {} })).toThrow(/must be an absolute path/);
  });

  it('lets PD_WORKTREE_ROOT override the pool root', () => {
    const custom = path.resolve(path.sep, 'pools', 'pd');
    const { root, source } = resolveWorktreeRoot({ primaryPath: PRIMARY, env: { [WORKTREE_ROOT_ENV]: custom } });
    expect(source).toBe('env');
    expect(root).toBe(path.resolve(custom));
  });

  it('ignores a blank PD_WORKTREE_ROOT instead of resolving to cwd', () => {
    const { source } = resolveWorktreeRoot({ primaryPath: PRIMARY, env: { [WORKTREE_ROOT_ENV]: '   ' } });
    expect(source).toBe('derived');
  });
});

describe('resolveTaskIdentity (git-11)', () => {
  it('maps a task + slug onto one identity used by BOTH branch and directory', () => {
    const id = resolveTaskIdentity({ task: 'PRI-790', slug: 'signal-confirmations' });
    expect(id.identity).toBe('PRI-790-signal-confirmations');
    expect(id.branch).toBe('ai/PRI-790-signal-confirmations');
    expect(id.dirName).toBe('PRI-790-signal-confirmations');
    // The old sibling layout repeated the repo name; the pool path already
    // encodes the repository, so the directory must not repeat it.
    expect(id.dirName.startsWith('principles-')).toBe(false);
    expect(id.dirName.startsWith('ai-')).toBe(false);
  });

  it('gives adhoc tasks a dated, randomly suffixed identity so same-day agents cannot collide', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    const a = resolveTaskIdentity({ task: 'adhoc', slug: 'ref-investigation', now, random: 'a31f8c' });
    const b = resolveTaskIdentity({ task: 'adhoc', slug: 'ref-investigation', now, random: 'bb12de' });
    expect(a.identity).toBe('adhoc-20260914-ref-investigation-a31f8c');
    expect(a.branch).toBe('ai/adhoc-20260914-ref-investigation-a31f8c');
    expect(utcDateStamp(now)).toBe('20260914');
    expect(a.identity).not.toBe(b.identity);
  });

  it('rejects malformed task ids and slugs before anything is created', () => {
    expect(() => resolveTaskIdentity({ task: 'bad id', slug: 'ok' })).toThrow(/invalid task id/i);
    expect(() => resolveTaskIdentity({ task: 'PRI-1', slug: 'Bad_Slug' })).toThrow(/invalid slug/i);
    expect(() => resolveTaskIdentity({ task: 'adhoc', slug: 'ok', random: 'NOTHEX' })).toThrow(/adhoc suffix/);
  });

  it('places the worktree directly under the pool root', () => {
    const { root } = resolveWorktreeRoot({ primaryPath: PRIMARY, env: {} });
    const id = resolveTaskIdentity({ task: 'PRI-790', slug: 'signal-confirmations' });
    expect(worktreePathFor({ root, dirName: id.dirName })).toBe(path.join(root, 'PRI-790-signal-confirmations'));
  });
});

describe('taskIdentityFromBranch', () => {
  it('recovers the identity from a task branch', () => {
    expect(taskIdentityFromBranch('ai/PRI-790-signal-confirmations')).toBe('PRI-790-signal-confirmations');
  });

  it('returns null outside the task namespace — the control plane is not a slot', () => {
    expect(taskIdentityFromBranch('main')).toBeNull();
    expect(taskIdentityFromBranch('work/something')).toBeNull();
    expect(taskIdentityFromBranch('ai/')).toBeNull();
    expect(taskIdentityFromBranch(null)).toBeNull();
  });
});
