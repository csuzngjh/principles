// Real-git integration tests for scripts/dev/cleanup-task-worktree.mjs —
// the safe-removal path (AGENTS.md §23A git-8-cleanup-after-merge, git-4
// no-unknown-work-destruction).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGitPath } from '../dev/lib/git.mjs';
import {
  commitFile,
  git,
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
  const r = await runDevScript('create-task-worktree.mjs', ['PRI-800', slug, '--json'], { cwd: primary });
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

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--json'], { cwd: primary });
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

    const r = await runDevScript('cleanup-task-worktree.mjs', [wt, '--json'], { cwd: primary });
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

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('uncommitted');
    // Non-destruction negative control: worktree AND the unknown file survive.
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readFileSync(path.join(wt, 'precious-wip.txt'), 'utf-8')).toBe('do not delete me\n');
  }, 120_000);

  it('REFUSES --delete-branch when the branch is not merged into origin/main', async () => {
    const { wt, branch } = await makeTask('unmerged');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('NOT an ancestor');
    // Nothing was removed.
    expect(fs.existsSync(wt)).toBe(true);
    const branchSha = await git(primary, 'rev-parse', '--verify', 'refs/heads/' + branch);
    expect(branchSha.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it('REFUSES to remove the primary checkout', async () => {
    const r = await runDevScript('cleanup-task-worktree.mjs', [primary, '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('PRIMARY');
    expect(fs.existsSync(primary)).toBe(true);
  }, 60_000);

  it('succeeds on a porcelain-clean worktree that still contains ignored build output (node_modules)', async () => {
    const { wt, branch } = await makeTask('with-ignored');
    await mergeIntoMain(branch);
    await git(primary, 'switch', '-c', 'work/back-from-ignored');
    // Ignored build output — present in every real dev worktree.
    fs.mkdirSync(path.join(wt, 'node_modules', 'some-pkg'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'some-pkg', 'index.js'), '// build output\n', 'utf-8');
    const status = await git(wt, 'status', '--porcelain');
    expect(status.trim()).toBe('');

    const r = await runDevScript('cleanup-task-worktree.mjs', [branch, '--delete-branch', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
  }, 120_000);

  it('fails clearly for an unknown target', async () => {
    const r = await runDevScript('cleanup-task-worktree.mjs', ['ai/nope-never-existed', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('No worktree or branch matches');
  }, 60_000);
});
