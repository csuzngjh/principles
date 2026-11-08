// Real-git integration tests for scripts/dev/cleanup-task-worktree.mjs —
// the safe-removal path (AGENTS.md §23A git-8-cleanup-after-merge, git-4
// no-unknown-work-destruction).
//
// PRI-796 added three refusals to this tool (git lock, active lease, open PR).
// Those are covered here; the completion-proof taxonomy itself is unchanged and
// stays covered by the cases below.
//
// `--skip-gh` is passed throughout so the suite does not depend on the local
// gh installation or on network latency: these cases are about git-level
// semantics, and the GitHub `PR MERGED` evidence path is covered by the
// workspace-lifecycle classifier tests.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gitCommonDirAbsolute, normalizeGitPath, runGit } from '../dev/lib/git.mjs';
import { withMutationLock } from '../dev/lib/git-mutation-lock.mjs';
import { removeWorktreeSafely, resolveAdminReversePointer } from '../dev/lib/safe-worktree-remove.mjs';
import {
  changedExternalTargets,
  fingerprintExternalTarget,
  snapshotExternalTargets,
} from '../dev/cleanup-task-worktree.mjs';
import {
  commitFile,
  git,
  makeJunction,
  removeFixture,
  runDevScript,
  setupOriginFixture,
  worktreeList,
} from './dev-worktree-test-utils';

let root: string;
let primary: string;

beforeAll(async () => {
  const fixture = await setupOriginFixture('pd-cleanup-wt-test-');
  root = fixture.root;
  primary = fixture.primary;
});

afterAll(() => {
  removeFixture(root);
});

/** Create a task worktree with one commit on its branch. */
async function makeTask(slug: string): Promise<{ wt: string; branch: string }> {
  const r = await runDevScript('create-task-worktree.mjs', ['PRI-800', slug, '--skip-bootstrap', '--json'], { cwd: primary });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout) as { worktree: string; branch: string };
  await commitFile(out.worktree, slug + '.txt', 'x\n', 'task commit');
  return { wt: out.worktree, branch: out.branch };
}

/** Merge a task branch into main (primary) and push, the way a PR merge lands. */
async function mergeIntoMain(branch: string): Promise<void> {
  await git(primary, 'fetch', 'origin');
  await git(primary, 'switch', 'main');
  await git(primary, 'pull', '--ff-only', 'origin', 'main');
  await git(primary, 'merge', '--no-ff', '-m', 'Merge task ' + branch, branch);
  await git(primary, 'push', 'origin', 'main');
}

describe('cleanup-task-worktree', () => {
  it('removes a clean, merged worktree and deletes the branch when asked', async () => {
    const { wt, branch } = await makeTask('merged');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-' + 'merged');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; removedWorktree: string; deletedBranch: string };
    expect(out.ok).toBe(true);
    expect(normalizeGitPath(out.removedWorktree)).toBe(normalizeGitPath(wt));
    expect(out.deletedBranch).toBe(branch);

    expect(fs.existsSync(wt)).toBe(false);
    const list = await worktreeList(primary);
    expect(list.some((w) => w.path === wt)).toBe(false);
    const branchGone = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch).catch(() => null);
    expect(branchGone).toBeNull();
  }, 120_000);

  it('removes the worktree but keeps the branch without --delete-branch', async () => {
    const { wt, branch } = await makeTask('keep-branch');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-keep');

    const r = await runDevScript('cleanup-task-worktree.mjs', [wt, '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    const branchSha = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch);
    expect(branchSha.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('REFUSES a dirty worktree and destroys nothing (git-4)', async () => {
    const { wt, branch } = await makeTask('dirty');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-dirty');
    fs.writeFileSync(path.join(wt, 'precious-wip.txt'), 'do not delete me\n', 'utf-8');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('uncommitted');
    // Non-destruction negative control: worktree AND the unknown file survive.
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'precious-wip.txt'), 'utf-8')).toBe('do not delete me\n');
  }, 120_000);

  it('REFUSES --delete-branch when the branch is not merged into origin/main', async () => {
    const { wt, branch } = await makeTask('unmerged');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('NOT an ancestor');
    // Nothing was removed.
    expect(fs.existsSync(wt)).toBe(true);
    const branchSha = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch);
    expect(branchSha.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('REFUSES to remove a CLEAN worktree whose branch is not merged, even WITHOUT --delete-branch (git-8 completion contract)', async () => {
    // The exact hazard the completion contract exists for: agent A committed
    // its work (porcelain-clean) but the PR is not merged; a second agent
    // running cleanup without --delete-branch must NOT destroy agent A's
    // active working directory.
    const { wt, branch } = await makeTask('unmerged-clean');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('NOT an ancestor');
    expect(out.error).toContain('Worktree was not removed');
    expect(out.nextAction).toContain('squash-merged');
    // Non-destruction negative controls: worktree, its committed content and
    // the branch all survive the refused cleanup.
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'unmerged-clean.txt'), 'utf-8')).toBe('x\n');
    const branchSha = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch);
    expect(branchSha.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('REFUSES to remove the primary checkout', async () => {
    const r = await runDevScript('cleanup-task-worktree.mjs', [primary, '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('PRIMARY');
    expect(fs.existsSync(primary)).toBe(true);
  }, 60_000);

  it('REFUSES a Git-locked worktree and never unlocks it (SPEC §14.3)', async () => {
    const { wt, branch } = await makeTask('locked');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-locked');
    await git(primary, 'worktree', 'lock', '--reason', 'writer=zcode task=PRI-800-locked', wt);

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('Git worktree lock');
    expect(out.nextAction).toContain('never unlocks');

    // The lock is still there, and so is the worktree.
    const porcelain = await git(primary, 'worktree', 'list', '--porcelain');
    expect(porcelain).toContain('locked');
    expect(fs.existsSync(wt)).toBe(true);
  }, 120_000);

  it('REFUSES a worktree held by an ACTIVE write lease — same behaviour as the batch sweep (SPEC §14.2)', async () => {
    const { wt, branch } = await makeTask('leased');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-leased');
    fs.writeFileSync(
      path.join(wt, '.workspace-lease.json'),
      JSON.stringify(
        {
          schema: 'pd-workspace-lease/1',
          workspace: wt,
          owner: 'zcode:' + branch,
          branch,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        },
        null,
        2
      ),
      'utf-8'
    );

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('ACTIVE write lease');
    expect(out.error).toContain('zcode:' + branch);
    expect(out.nextAction).toContain('dev:worktree:release');
    expect(fs.existsSync(wt)).toBe(true);
  }, 120_000);

  it('SKIPS the global prune while a sibling worktree is unreadable, and still cleans the target (PRI-712)', async () => {
    // Target: clean + merged → removable as usual.
    const target = await makeTask('pruneguard-target');
    await mergeIntoMain(target.branch);
    await git(primary, 'switch', '-c', 'work/back-from-pruneguard-target');

    // Sibling: simulates the PRI-710 incident precondition — a live worktree
    // whose git probe currently fails (here: damaged .git pointer; in the
    // wild: Windows lock races). Its admin metadata must survive the global
    // prune this cleanup runs afterwards.
    const sibling = await makeTask('pruneguard-sibling');
    const siblingGitFile = path.join(sibling.wt, '.git');
    const gitPointer = fs.readFileSync(siblingGitFile, 'utf-8');
    fs.rmSync(siblingGitFile);

    try {
      const r = await runDevScript('cleanup-task-worktree.mjs', [target.branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { ok: boolean; pruned: boolean; notes: string[] };
      expect(out.ok).toBe(true);
      // The sanctioned target is still cleaned — the guard only defers the prune.
      expect(fs.existsSync(target.wt)).toBe(false);
      expect(out.pruned).toBe(false);
      expect(out.notes.join(' ')).toContain('skipped global worktree prune');

      // Negative control: the sibling's admin entry AND its work survived.
      const list = await worktreeList(primary);
      expect(list.some((w) => normalizeGitPath(w.path) === normalizeGitPath(sibling.wt))).toBe(true);
      expect(fs.existsSync(path.join(sibling.wt, 'pruneguard-sibling.txt'))).toBe(true);
    } finally {
      // Fixture hygiene: restore the pointer so removeFixture can clean up.
      fs.writeFileSync(siblingGitFile, gitPointer, 'utf-8');
    }
  }, 120_000);

  it('succeeds on a porcelain-clean worktree that still contains ignored build output (node_modules)', async () => {
    const { wt, branch } = await makeTask('with-ignored');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-ignored');
    // Ignored build output — present in every real dev worktree.
    fs.mkdirSync(path.join(wt, 'node_modules', 'some-pkg'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'some-pkg', 'index.js'), '// build output\n', 'utf-8');
    const status = await git(wt, 'status', '--porcelain');
    expect(status.trim()).toBe('');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
  }, 120_000);

  it('fails clearly for an unknown target', async () => {
    const r = await runDevScript('cleanup-task-worktree.mjs', ['ai/nope-never-existed', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('No worktree or branch matches');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// ERR-098 / PRI-1143 — the removal primitive itself is the defect.
//
// `git worktree remove` is NOT junction-safe. On 2026-11-06 it recursed through a
// MERGED worktree's gitignored fixture junctions and deleted real files in the
// global install — on the FIRST, non-forced removal, with a clean porcelain
// (OCC-20261106T025529Z-g9kvsgn43c). So these cases put a link that LEAVES the
// worktree into an otherwise clean, merged worktree: the tool must refuse by
// default, remove nothing, and leave the external tree byte-identical.
// ---------------------------------------------------------------------------

const createdLinks: string[] = [];

/** Create a junction and remember it, so teardown detaches it before rm -r. */
function trackJunction(link: string, target: string): void {
  makeJunction(link, target);
  createdLinks.push(link);
}

afterEach(() => {
  // A fixture tree containing a junction is not something `removeFixture` should
  // be asked to recurse through: detach every link this suite created first.
  while (createdLinks.length > 0) {
    const link = createdLinks.pop() as string;
    try {
      fs.unlinkSync(link);
    } catch {
      /* already detached by the code under test */
    }
  }
});

/** Content-level fingerprint: relative path + sha256 of every file under `dir`. */
function fingerprintTree(dir: string): string {
  const rows: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else rows.push(path.relative(dir, full) + '=' + crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(dir);
  return rows.sort().join('\n');
}

describe('external target fingerprints', () => {
  it('detects a file truncated after the snapshot even when the file still exists', () => {
    const outside = path.join(root, 'external-fingerprint-truncate');
    fs.mkdirSync(outside, { recursive: true });
    const targetFile = path.join(outside, 'large-package.bin');
    fs.writeFileSync(targetFile, Buffer.alloc(4096, 0x41));
    const snapshot = snapshotExternalTargets([{ canonicalTarget: outside, unsafeReason: 'outside' }]);
    expect(snapshot).toHaveLength(1);
    fs.writeFileSync(targetFile, Buffer.from('x'));
    expect(fs.existsSync(targetFile)).toBe(true);
    expect(changedExternalTargets(snapshot)).toEqual([outside]);
    expect(fingerprintExternalTarget(outside)).not.toBe(snapshot[0].fingerprint);
  });

  it('deduplicates multiple links to the same canonical external target', () => {
    const outside = path.join(root, 'external-fingerprint-deduplicate');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const snapshot = snapshotExternalTargets([
      { canonicalTarget: outside, unsafeReason: 'outside' },
      { canonicalTarget: outside, unsafeReason: 'outside' },
    ]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].path).toBe(outside);
  });

  it('detects truncation when the external target itself is a regular file', () => {
    const outsideFile = path.join(root, 'external-file-target.bin');
    fs.writeFileSync(outsideFile, Buffer.alloc(2048, 0x41));
    const snapshot = snapshotExternalTargets([{ canonicalTarget: outsideFile, unsafeReason: 'outside' }]);
    expect(snapshot).toHaveLength(1);
    fs.writeFileSync(outsideFile, Buffer.from('x'));
    expect(changedExternalTargets(snapshot)).toEqual([outsideFile]);
  });

  it('ignores only the expected worktree subtree while still checking external siblings', () => {
    const outside = path.join(root, 'external-parent-target');
    const expectedWorktree = path.join(outside, 'pool', 'task-worktree');
    fs.mkdirSync(expectedWorktree, { recursive: true });
    fs.writeFileSync(path.join(expectedWorktree, 'expected-to-disappear.txt'), 'expected');
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const snapshot = snapshotExternalTargets(
      [{ canonicalTarget: outside, unsafeReason: 'outside' }],
      { excludePaths: [expectedWorktree] },
    );
    fs.rmSync(expectedWorktree, { recursive: true, force: true });
    expect(changedExternalTargets(snapshot)).toEqual([]);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'changed');
    expect(changedExternalTargets(snapshot)).toEqual([outside]);
  });
});

/** The 2026-11-06 shape: a global install with root entries and nested skill files. */
function makeExternalInstall(label: string): string {
  const outside = path.join(root, 'outside-install-' + label);
  const skills = path.join(outside, 'dist', 'extensions', 'browser', 'skills', 'browser-automation');
  fs.mkdirSync(skills, { recursive: true });
  fs.writeFileSync(path.join(outside, '.openclaw-lifecycle-pending'), 'pending\n', 'utf-8');
  fs.writeFileSync(path.join(outside, 'CHANGELOG.md'), '# changelog\n', 'utf-8');
  fs.writeFileSync(path.join(outside, 'cli-root-options.mjs'), 'export const rootOptions = 1;\n', 'utf-8');
  fs.writeFileSync(path.join(skills, 'SKILL.md'), '# skill\n', 'utf-8');
  return outside;
}

describe('cleanup-task-worktree junction safety (ERR-098 / PRI-1143)', () => {
  it('REFUSES a clean merged worktree whose junction points outside it, and destroys nothing', async () => {
    const { wt, branch } = await makeTask('junction-refuse');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-junction-refuse');

    const outside = makeExternalInstall('refuse');
    const before = fingerprintTree(outside);
    trackJunction(path.join(wt, 'node_modules', 'openclaw'), outside);
    expect((await git(wt, 'status', '--porcelain')).trim(), 'the link must sit in ignored output so porcelain stays clean').toBe('');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; reason?: string; error: string; externalLinkCount?: number };
    expect(out.ok).toBeFalsy();
    expect(out.reason).toBe('EXTERNAL_LINKS_PRESENT');
    expect(out.externalLinkCount).toBe(1);
    expect(out.error).toContain('OUTSIDE');

    // Nothing was removed and nothing outside was touched.
    expect(fs.existsSync(wt)).toBe(true);
    const list = await worktreeList(primary);
    expect(list.some((w) => normalizeGitPath(w.path) === normalizeGitPath(wt))).toBe(true);
    const branchSha = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch);
    expect(branchSha.trim().length).toBeGreaterThan(0);
    expect(fingerprintTree(outside)).toBe(before);
  }, 120_000);

  it('--detach-external-links removes ONLY the links: worktree gone, external target byte-identical', async () => {
    const { wt, branch } = await makeTask('junction-detach');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-junction-detach');

    const outside = makeExternalInstall('detach');
    const before = fingerprintTree(outside);
    trackJunction(path.join(wt, 'node_modules', 'openclaw'), outside);

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--detach-external-links', '--json'], {
      cwd: primary,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; detachedExternalLinks: number; notes: string[] };
    expect(out.ok).toBe(true);
    expect(out.detachedExternalLinks).toBe(1);
    expect(out.notes.join(' ')).toContain('every target re-verified present');

    expect(fs.existsSync(wt)).toBe(false);
    // The hard acceptance criterion: 4 external files, same hashes, still there.
    expect(fingerprintTree(outside)).toBe(before);
  }, 120_000);

  it('does NOT refuse when a junction stays inside the worktree it is removing', async () => {
    const { wt, branch } = await makeTask('junction-internal');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-junction-internal');

    fs.mkdirSync(path.join(wt, 'node_modules', 'real-pkg'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'real-pkg', 'index.js'), 'real\n', 'utf-8');
    trackJunction(path.join(wt, 'node_modules', 'linked-pkg'), path.join(wt, 'node_modules', 'real-pkg'));

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; notes: string[] };
    expect(out.ok).toBe(true);
    expect(out.notes.join(' ')).toContain('internal reparse point');
    expect(fs.existsSync(wt)).toBe(false);
  }, 120_000);

  it('detaches a verified ancestor-cycle junction without requiring external-link override', async () => {
    const { wt, branch } = await makeTask('junction-cycle');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-junction-cycle');

    fs.mkdirSync(path.join(wt, 'node_modules'), { recursive: true });
    trackJunction(path.join(wt, 'node_modules', 'self'), wt);
    const r = await runDevScript(
      'cleanup-task-worktree.mjs',
      [branch, '--delete-branch', '--skip-gh', '--json'],
      { cwd: primary }
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; notes: string[] };
    expect(out.ok).toBe(true);
    expect(out.notes.join(' ')).toContain('reparse point');
    expect(fs.existsSync(wt)).toBe(false);
    await expect(git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch)).rejects.toThrow();
  }, 120_000);

  it('can clean a target worktree when the CLI itself was launched from that worktree', async () => {
    const { wt, branch } = await makeTask('cleanup-from-target-cwd');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-target-cwd');

    const r = await runDevScript(
      'cleanup-task-worktree.mjs',
      [branch, '--delete-branch', '--skip-gh', '--json'],
      { cwd: wt },
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; removedWorktree: string; deletedBranch: string };
    expect(out.ok).toBe(true);
    expect(normalizeGitPath(out.removedWorktree)).toBe(normalizeGitPath(wt));
    expect(out.deletedBranch).toBe(branch);
    expect(fs.existsSync(wt)).toBe(false);
    expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(false);
  }, 120_000);

  it('resolves a relative Git admin reverse pointer from adminDir, not process cwd', () => {
    const adminDir = path.join(root, 'repo', '.git', 'worktrees', 'task');
    const relativePointer = path.join('..', '..', '..', '..', 'task-worktree', '.git');
    expect(resolveAdminReversePointer(adminDir, relativePointer))
      .toBe(path.resolve(adminDir, relativePointer));
    const absolutePointer = path.join(root, 'task-worktree', '.git');
    expect(resolveAdminReversePointer(adminDir, absolutePointer)).toBe(path.resolve(absolutePointer));
  });

  it('does NOT report EXTERNAL_TARGET_LOST when the external target was already missing', async () => {
    const { wt, branch } = await makeTask('junction-dangling');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-junction-dangling');

    const gone = path.join(root, 'already-gone-install');
    fs.mkdirSync(gone, { recursive: true });
    trackJunction(path.join(wt, 'node_modules', 'openclaw'), gone);
    fs.rmSync(gone, { recursive: true, force: true }); // target missing BEFORE cleanup

    const r = await runDevScript(
      'cleanup-task-worktree.mjs',
      [branch, '--delete-branch', '--skip-gh', '--detach-external-links', '--json'],
      { cwd: primary }
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(true);
    expect(out.reason).toBeUndefined();
    expect(fs.existsSync(wt)).toBe(false);
    await expect(git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch)).rejects.toThrow();
  }, 120_000);
});


describe('quarantine removal: late non-cooperating Junction (ERR-098)', () => {
  it('restores a worktree when Git reports failure after the quarantine rename completed', async () => {
    const { wt } = await makeTask('partial-quarantine-move');
    const commonDir = await gitCommonDirAbsolute(primary);
    let injected = false;
    const runGitCommand = async (args: string[], options: { cwd: string; allowFailure?: boolean }) => {
      if (!injected && args[0] === 'worktree' && args[1] === 'move' && args[2] === wt) {
        await runGit(args, options);
        injected = true;
        throw new Error('simulated failure after directory and Git metadata move');
      }
      return runGit(args, options);
    };
    const result = await withMutationLock(
      { commonDir, operation: 'worktree-remove', target: wt },
      () => removeWorktreeSafely({ cwd: wt, worktreePath: wt, primaryPath: primary, runGitCommand }),
    );
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.restoredPath).toBe(wt);
    expect(result.quarantinePath).toBeUndefined();
    expect(fs.existsSync(wt)).toBe(true);
    expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(true);
  }, 120_000);

  it('accepts only the tracked deletion explicitly authorized by the detach pass', async () => {
    const { wt } = await makeTask('expected-tracked-link-delete-only');
    const expectedPath = path.join(wt, 'expected-link');
    fs.writeFileSync(expectedPath, 'link target placeholder\n', 'utf-8');
    await git(wt, 'add', 'expected-link');
    await git(wt, 'commit', '-m', 'track link path for deletion-status contract');
    fs.unlinkSync(expectedPath);

    const commonDir = await gitCommonDirAbsolute(primary);
    const result = await withMutationLock(
      { commonDir, operation: 'worktree-remove', target: wt },
      () => removeWorktreeSafely({
        cwd: wt,
        worktreePath: wt,
        primaryPath: primary,
        expectedDeletedPaths: [expectedPath],
      }),
    );
    expect(result.ok).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(false);
  }, 120_000);

  it('refuses unrelated work when a caller-authorized tracked deletion is present', async () => {
    const { wt } = await makeTask('expected-tracked-link-delete');
    const expectedPath = path.join(wt, 'expected-link');
    const unexpectedPath = path.join(wt, 'unexpected-wip');
    fs.writeFileSync(expectedPath, 'link target placeholder\n', 'utf-8');
    fs.writeFileSync(unexpectedPath, 'uncommitted work\n', 'utf-8');
    await git(wt, 'add', 'expected-link', 'unexpected-wip');
    await git(wt, 'commit', '-m', 'track files for deletion-status contract');
    fs.unlinkSync(expectedPath);
    fs.writeFileSync(unexpectedPath, 'changed after commit\n', 'utf-8');

    const commonDir = await gitCommonDirAbsolute(primary);
    const accepted = await withMutationLock(
      { commonDir, operation: 'worktree-remove', target: wt },
      () => removeWorktreeSafely({
        cwd: wt,
        worktreePath: wt,
        primaryPath: primary,
        expectedDeletedPaths: [expectedPath],
      }),
    );
    expect(accepted.ok).toBe(false);
    expect(accepted.reasonCode).toBe('OWNERSHIP_CHANGED');
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(unexpectedPath)).toBe(true);
  }, 120_000);

  it('never follows a Junction created AFTER the caller preflight', async () => {
    // The production helper performs its own final status/ownership check and
    // moves the worktree before unlinking. This deterministic seam models a
    // writer that does not participate in the Git metadata mutation lock and
    // adds a new Junction after the earlier scan but before recursive deletion.
    const { wt } = await makeTask('late-junction');
    const outside = makeExternalInstall('late-junction');
    const before = fingerprintTree(outside);
    const commonDir = await gitCommonDirAbsolute(primary);
    let injected = false;
    const result = await withMutationLock(
      { commonDir, operation: 'worktree-remove', target: wt },
      () => removeWorktreeSafely({
        cwd: primary,
        worktreePath: wt,
        primaryPath: primary,
        onQuarantined: (quarantined) => {
          const lateLink = path.join(quarantined, 'node_modules');
          trackJunction(lateLink, outside);
          injected = true;
        },
      }),
    );

    expect(injected).toBe(true);
    expect(result.ok, result.reason).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
    expect(fingerprintTree(outside)).toBe(before);
    expect((await worktreeList(primary)).some((w) => normalizeGitPath(w.path) === normalizeGitPath(wt))).toBe(false);
  }, 120_000);

  it('refuses a swapped .git marker and never overwrites the external target', async () => {
    const { wt } = await makeTask('marker-swap');
    const outside = makeExternalInstall('marker-swap');
    const before = fingerprintTree(outside);
    const commonDir = await gitCommonDirAbsolute(primary);
    let quarantine = '';
    let originalMarker = '';
    try {
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({
          cwd: primary,
          worktreePath: wt,
          primaryPath: primary,
          onQuarantined: (moved) => {
            quarantine = moved;
            const marker = path.join(moved, '.git');
            originalMarker = fs.readFileSync(marker, 'utf-8');
            fs.unlinkSync(marker);
            // A non-cooperating process swaps a directory Junction in place
            // between the Git move and filesystem verification.
            trackJunction(marker, outside);
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.quarantinePath).toBe(quarantine);
      expect(fingerprintTree(outside)).toBe(before);
      const listed = await worktreeList(primary);
      expect(listed.some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(quarantine))).toBe(true);
    } finally {
      if (quarantine && fs.existsSync(quarantine)) {
        const marker = path.join(quarantine, '.git');
        try {
          fs.unlinkSync(marker);
        } catch {
          /* already detached */
        }
        fs.writeFileSync(marker, originalMarker, 'utf-8');
        await git(primary, 'worktree', 'move', quarantine, wt);
        fs.rmdirSync(path.dirname(quarantine));
      }
    }
    expect(fingerprintTree(outside)).toBe(before);
    expect(fs.existsSync(wt)).toBe(true);
  }, 120_000);

  it.skipIf(process.platform === 'win32')('does not block when a non-cooperating writer replaces the .git marker with a FIFO', async () => {
    const { wt } = await makeTask('marker-fifo');
    const commonDir = await gitCommonDirAbsolute(primary);
    let quarantine = '';
    let originalMarker = '';
    try {
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({
          cwd: wt,
          worktreePath: wt,
          primaryPath: primary,
          onQuarantined: (moved) => {
            quarantine = moved;
            const marker = path.join(moved, '.git');
            originalMarker = fs.readFileSync(marker, 'utf-8');
            fs.unlinkSync(marker);
            execFileSync('mkfifo', [marker]);
          },
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.quarantinePath).toBe(quarantine);
      expect(result.reason).toContain('not a regular file');
      expect(fs.existsSync(quarantine)).toBe(true);
      expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(quarantine))).toBe(true);
    } finally {
      if (quarantine && fs.existsSync(quarantine)) {
        const marker = path.join(quarantine, '.git');
        try { fs.unlinkSync(marker); } catch { /* already detached */ }
        fs.writeFileSync(marker, originalMarker, 'utf-8');
        await git(primary, 'worktree', 'move', quarantine, wt);
        fs.rmdirSync(path.dirname(quarantine));
      }
    }
  }, 120_000);

  it('refuses to delete Git admin metadata through a junctioned worktrees parent', async () => {
    const { wt, branch } = await makeTask('admin-root-junction');
    const commonDir = await gitCommonDirAbsolute(primary);
    const adminRoot = path.join(commonDir, 'worktrees');
    const externalAdminRoot = path.join(path.dirname(commonDir), '.pd-test-worktrees-admin-' + crypto.randomUUID());
    let redirected = false;
    let adminRootMoved = false;
    try {
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({
          cwd: primary,
          worktreePath: wt,
          primaryPath: primary,
          onTreeRemoved: () => {
            // Simulate a non-cooperating process redirecting the Git admin
            // parent after the worktree tree is gone but before metadata cleanup.
            fs.renameSync(adminRoot, externalAdminRoot);
            adminRootMoved = true;
            makeJunction(adminRoot, externalAdminRoot);
            redirected = true;
          },
        }),
      );
      expect(redirected).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.reasonCode).toBe('REMOVAL_FAILED_RESIDUE_SHELL');
      // The admin metadata outside .git must remain untouched.
      expect(fs.readdirSync(externalAdminRoot).length).toBeGreaterThan(0);
    } finally {
      if (adminRootMoved) {
        if (fs.existsSync(adminRoot)) {
          if (process.platform === 'win32') fs.rmdirSync(adminRoot);
          else fs.unlinkSync(adminRoot);
        }
        if (fs.existsSync(externalAdminRoot) && !fs.existsSync(adminRoot)) {
          fs.renameSync(externalAdminRoot, adminRoot);
        }
      }
      await git(primary, 'worktree', 'prune').catch(() => undefined);
      await git(primary, 'branch', '-D', branch).catch(() => undefined);
    }
  }, 120_000);

  it('preserves a recreated original path and leaves its branch undeleted', async () => {
    const { wt, branch } = await makeTask('recreated-original-path');
    const commonDir = await gitCommonDirAbsolute(primary);
    let recreated = false;
    try {
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({
          cwd: primary,
          worktreePath: wt,
          primaryPath: primary,
          onTreeRemoved: (originalPath) => {
            fs.mkdirSync(originalPath, { recursive: true });
            fs.writeFileSync(path.join(originalPath, 'late-owner-file.txt'), 'preserve me\n', 'utf-8');
            recreated = true;
          },
        }),
      );
      expect(recreated).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.reasonCode).toBe('REMOVAL_FAILED_RESIDUE_SHELL');
      expect(fs.readFileSync(path.join(wt, 'late-owner-file.txt'), 'utf-8')).toBe('preserve me\n');
      expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(false);
      const branchSha = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch);
      expect(branchSha.trim().length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
      await git(primary, 'branch', '-D', branch).catch(() => undefined);
    }
  }, 120_000);

  /** Resolve a worktree's Git admin directory from its marker with an explicit containment check. */
  async function adminDirOfWorktree(commonDir: string, worktreePath: string): Promise<string> {
    const marker = fs.readFileSync(path.join(worktreePath, '.git'), 'utf-8');
    const pointer = marker.split('gitdir: ')[1].trim();
    const resolved = path.resolve(worktreePath, pointer);
    const adminRoot = path.join(commonDir, 'worktrees');
    if (!resolved.startsWith(adminRoot + path.sep)) throw new Error('admin dir escaped the repository admin root');
    return resolved;
  }

  it('removes a worktree containing an initialized submodule via a verified manual rename', async () => {
    // git refuses `git worktree move` for worktrees with initialized submodules
    // ("working trees containing submodules cannot be moved or removed"), so
    // the removal must quarantine via rename + verified admin retarget — and
    // the shared submodule admin area (<commonDir>/modules) must survive.
    const subSrc = path.join(root, 'submodule-src');
    fs.mkdirSync(subSrc, { recursive: true });
    fs.writeFileSync(path.join(subSrc, 'lib.txt'), 'submodule content\n', 'utf-8');
    await git(subSrc, 'init');
    await git(subSrc, 'add', '.');
    await git(subSrc, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'sub init');

    const superRepo = path.join(root, 'submodule-super');
    fs.mkdirSync(superRepo, { recursive: true });
    await git(superRepo, 'init', '-b', 'main');
    await git(superRepo, 'config', 'protocol.file.allow', 'always');
    fs.writeFileSync(path.join(superRepo, 'app.txt'), 'app\n', 'utf-8');
    await git(superRepo, 'add', '.');
    await git(superRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'super init');
    await git(superRepo, '-c', 'protocol.file.allow=always', 'submodule', 'add', path.join('..', path.basename(subSrc)), 'sub');
    await git(superRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add submodule');

    const wt = path.join(root, 'submodule-worktree');
    await git(superRepo, 'worktree', 'add', wt, '-b', 'task-with-submodule');
    await git(wt, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
    expect(fs.existsSync(path.join(wt, 'sub', 'lib.txt'))).toBe(true);
    // The submodule admin lives in the super-project's common modules dir.
    const superCommonDir = await gitCommonDirAbsolute(superRepo);
    const modulesAdmin = path.join(superCommonDir, 'modules', 'sub');
    expect(fs.existsSync(modulesAdmin)).toBe(true);

    try {
      const commonDir = await gitCommonDirAbsolute(superRepo);
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({ cwd: superRepo, worktreePath: wt, primaryPath: superRepo }),
      );
      expect(result.ok, result.reason + ' ' + result.notes.join('; ')).toBe(true);
      expect(result.notes.join(' ')).toContain('manual rename');
      // The worktree tree and its exact admin dir are gone.
      expect(fs.existsSync(wt)).toBe(false);
      expect((await worktreeList(superRepo)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(false);
      // git-4: the shared submodule admin area was never touched.
      expect(fs.existsSync(modulesAdmin)).toBe(true);
      // The super-project checkout and its own submodule are intact.
      expect(fs.readFileSync(path.join(superRepo, 'sub', 'lib.txt'), 'utf-8').replace(/\r\n/g, '\n')).toBe('submodule content\n');
      expect((await git(superRepo, 'status', '--porcelain')).trim()).toBe('');
    } finally {
      if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
      await git(superRepo, 'worktree', 'prune').catch(() => undefined);
      await git(superRepo, 'branch', '-D', 'task-with-submodule').catch(() => undefined);
    }
  }, 180_000);

  it('reports a restore when the rollback move commits despite reporting failure', async () => {
    const { wt } = await makeTask('rollback-also-fails');
    const commonDir = await gitCommonDirAbsolute(primary);
    let moves = 0;
    const runGitCommand = async (args: string[], options: { cwd: string; allowFailure?: boolean }) => {
      if (args[0] === 'worktree' && args[1] === 'move') {
        // Both the forward quarantine move AND the rollback move commit on
        // disk, then report failure. The state machine must trust the disk,
        // not the error: the worktree IS back at its original path.
        await runGit(args, options);
        moves += 1;
        throw new Error('simulated move failure after the rename committed');
      }
      return runGit(args, options);
    };
    try {
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({ cwd: wt, worktreePath: wt, primaryPath: primary, runGitCommand }),
      );
      expect(moves).toBe(2);
      expect(result.ok).toBe(false);
      // Disk truth: the rollback committed, so the result reports a restore —
      // never a phantom quarantine.
      expect(result.restoredPath).toBe(wt);
      expect(result.quarantinePath).toBeUndefined();
      expect(fs.existsSync(wt)).toBe(true);
      expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(true);
      expect(result.notes.join(' ')).toContain('rollback move reported failure');
    } finally {
      await git(primary, 'worktree', 'prune').catch(() => undefined);
    }
  }, 120_000);

  it('restores the worktree when the .git marker uses a relative gitdir pointer', async () => {
    // Relative gitdir markers (worktree.useRelativePaths-style layouts) are
    // only resolvable from the ORIGINAL worktree position. The quarantine move
    // adds a path segment, so the pointer can no longer be proven: fail closed
    // and put the worktree back, never delete against a guessed path.
    const { wt, branch } = await makeTask('relative-gitdir');
    await mergeIntoMain(branch);
    const commonDir = await gitCommonDirAbsolute(primary);
    const markerFile = path.join(wt, '.git');
    const absoluteMarker = fs.readFileSync(markerFile, 'utf-8');
    const adminDir = await adminDirOfWorktree(commonDir, wt);
    try {
      // Rewrite the marker to a RELATIVE pointer, valid only at the original
      // position: after quarantine the resolution cannot be proven. A freshly
      // created worktree marker denies `w`-mode writes on Windows (open-file
      // scan holds it), but `r+` works — write in place and truncate.
      const relativeMarker = 'gitdir: ' + path.relative(wt, adminDir) + '\n';
      const fd = fs.openSync(markerFile, 'r+');
      try {
        fs.writeFileSync(fd, relativeMarker, 'utf-8');
        fs.ftruncateSync(fd, Buffer.byteLength(relativeMarker, 'utf-8'));
      } finally {
        fs.closeSync(fd);
      }

      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: wt },
        () => removeWorktreeSafely({ cwd: primary, worktreePath: wt, primaryPath: primary }),
      );
      expect(result.ok).toBe(false);
      expect(result.restoredPath).toBe(wt);
      expect(fs.existsSync(wt)).toBe(true);
      expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(wt))).toBe(true);
      expect(fs.existsSync(path.join(wt, 'relative-gitdir.txt'))).toBe(true);
    } finally {
      // Restore the canonical marker so the fixture stays consistent, using
      // the same r+ write that worked on the way in.
      if (fs.existsSync(wt)) {
        try {
          const fd = fs.openSync(markerFile, 'r+');
          try {
            fs.writeFileSync(fd, absoluteMarker, 'utf-8');
            fs.ftruncateSync(fd, Buffer.byteLength(absoluteMarker, 'utf-8'));
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          /* fixture consistency only; the suite does not depend on it */
        }
      }
    }
  }, 120_000);

  it('refuses admin metadata whose reverse pointer names a different worktree', async () => {
    const victim = await makeTask('reverse-pointer-victim');
    const other = await makeTask('reverse-pointer-other');
    const commonDir = await gitCommonDirAbsolute(primary);
    const victimAdminDir = await adminDirOfWorktree(commonDir, victim.wt);
    const pointerFile = path.join(victimAdminDir, 'gitdir');
    const originalPointer = fs.readFileSync(pointerFile, 'utf-8');
    try {
      // Tamper: the admin record now claims the OTHER worktree's marker.
      const tamperedPointer = path.join(other.wt, '.git');
      fs.writeFileSync(pointerFile, tamperedPointer + '\n', 'utf-8');
      const result = await withMutationLock(
        { commonDir, operation: 'worktree-remove', target: victim.wt },
        () => removeWorktreeSafely({ cwd: primary, worktreePath: victim.wt, primaryPath: primary }),
      );
      expect(result.ok).toBe(false);
      // Zero mutation: ownership looks broken before anything is touched.
      expect(fs.existsSync(victim.wt)).toBe(true);
      expect(fs.readFileSync(path.join(victim.wt, 'reverse-pointer-victim.txt'), 'utf-8')).toBe('x\n');
      expect(fs.existsSync(victimAdminDir)).toBe(true);
      // The innocent other worktree is untouched and still registered.
      expect(fs.existsSync(other.wt)).toBe(true);
      expect((await worktreeList(primary)).some((entry) => normalizeGitPath(entry.path) === normalizeGitPath(other.wt))).toBe(true);
    } finally {
      fs.writeFileSync(pointerFile, originalPointer, 'utf-8');
    }
  }, 120_000);
});
