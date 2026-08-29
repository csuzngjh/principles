// Real-git integration tests for scripts/dev/check-dev-worktree.mjs —
// the single authority for safe-write-clone judgement (AGENTS.md §23A).
// Every case drives the real CLI against a real temporary repository.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitFile,
  git,
  initRepo,
  makeTempDir,
  removeFixture,
  runDevScript,
} from './dev-worktree-test-utils';

let root: string;

beforeAll(() => {
  root = makeTempDir('pd-guard-test-');
});

afterAll(() => {
  removeFixture(root);
});

function jsonOut(stdout: string): { ok: boolean; violations: Array<{ rule: string }>; branch: string | null; isPrimary: boolean | null } {
  const parsed = JSON.parse(stdout) as { ok: boolean; violations: Array<{ rule: string }>; branch: string | null; isPrimary: boolean | null };
  return parsed;
}

describe('check-dev-worktree guard', () => {
  it('fails in the primary checkout on a non-protected branch (control plane is read-only)', async () => {
    const repo = path.join(root, 'primary-branch');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    await git(repo, 'switch', '-c', 'work/some-task');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: repo });
    expect(r.code).toBe(1);
    const out = jsonOut(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.isPrimary).toBe(true);
    expect(out.violations.map((v) => v.rule)).toEqual(['primary-worktree']);
  }, 60_000);

  it('fails in the primary checkout on main with BOTH protected-branch and primary-worktree', async () => {
    const repo = path.join(root, 'on-main');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: repo });
    expect(r.code).toBe(1);
    const rules = jsonOut(r.stdout).violations.map((v) => v.rule);
    expect(rules).toContain('protected-branch');
    expect(rules).toContain('primary-worktree');
  }, 60_000);

  it('passes in a task worktree on a feature branch', async () => {
    const repo = path.join(root, 'task-ok');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    const wt = path.join(root, 'task-ok-wt');
    await git(repo, 'worktree', 'add', '-b', 'work/task-a', wt);

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(0);
    const out = jsonOut(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.branch).toBe('work/task-a');
    expect(out.isPrimary).toBe(false);
  }, 60_000);

  it('fails on a protected branch inside a task worktree (main checked out there)', async () => {
    const repo = path.join(root, 'protected-in-wt');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    // Free main so a worktree can check it out.
    await git(repo, 'switch', '-c', 'work/elsewhere');
    const wt = path.join(root, 'protected-in-wt-wt');
    await git(repo, 'worktree', 'add', wt, 'main');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(1);
    const rules = jsonOut(r.stdout).violations.map((v) => v.rule);
    expect(rules).toEqual(['protected-branch']);
  }, 60_000);

  it('fails on a detached HEAD', async () => {
    const repo = path.join(root, 'detached');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    const wt = path.join(root, 'detached-wt');
    await git(repo, 'worktree', 'add', '--detach', wt, 'HEAD');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(1);
    const rules = jsonOut(r.stdout).violations.map((v) => v.rule);
    expect(rules).toEqual(['detached-head']);
  }, 60_000);

  it('fails outside any git repository', async () => {
    const dir = path.join(root, 'not-a-repo');
    fs.mkdirSync(dir, { recursive: true });
    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(jsonOut(r.stdout).violations.map((v) => v.rule)).toEqual(['not-a-repo']);
  }, 60_000);

  it('fails when a merge is in progress (unsafe state marker)', async () => {
    const repo = path.join(root, 'mid-merge');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    const wt = path.join(root, 'mid-merge-wt');
    await git(repo, 'worktree', 'add', '-b', 'work/mid-merge', wt);
    const gitDir = (await git(wt, 'rev-parse', '--absolute-git-dir')).trim();
    fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), '0000000000000000000000000000000000000000\n', 'utf-8');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(1);
    const rules = jsonOut(r.stdout).violations.map((v) => v.rule);
    expect(rules).toEqual(['unsafe-git-state']);
  }, 60_000);

  it('still passes in a dirty task worktree — dirtiness is not the guard\'s concern, and the guard must not mutate anything', async () => {
    const repo = path.join(root, 'dirty-ok');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    const wt = path.join(root, 'dirty-ok-wt');
    await git(repo, 'worktree', 'add', '-b', 'work/dirty', wt);
    fs.writeFileSync(path.join(wt, 'uncommitted.txt'), 'wip\n', 'utf-8');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(0);
    // Non-destruction negative control: the dirty file survives the guard run.
    expect(fs.existsSync(path.join(wt, 'uncommitted.txt'))).toBe(true);
    const status = await git(wt, 'status', '--porcelain');
    expect(status.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it('lets a human override the primary-worktree rule via PD_DEV_WORKTREE_ALLOW_PRIMARY=1 (AI agents must never set it)', async () => {
    const repo = path.join(root, 'override');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    await git(repo, 'switch', '-c', 'work/human');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], {
      cwd: repo,
      env: { PD_DEV_WORKTREE_ALLOW_PRIMARY: '1' },
    });
    expect(r.code).toBe(0);
    expect(jsonOut(r.stdout).ok).toBe(true);
  }, 60_000);

  it('the human override does NOT bypass the protected-branch rule', async () => {
    const repo = path.join(root, 'override-protected');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], {
      cwd: repo,
      env: { PD_DEV_WORKTREE_ALLOW_PRIMARY: '1' },
    });
    expect(r.code).toBe(1);
    expect(jsonOut(r.stdout).violations.map((v) => v.rule)).toEqual(['protected-branch']);
  }, 60_000);

  it('works from a subdirectory of a task worktree (git resolves upward)', async () => {
    const repo = path.join(root, 'subdir');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    const wt = path.join(root, 'subdir-wt');
    await git(repo, 'worktree', 'add', '-b', 'work/subdir', wt);
    const sub = path.join(wt, 'nested', 'deep');
    fs.mkdirSync(sub, { recursive: true });

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: sub });
    expect(r.code).toBe(0);
  }, 60_000);
});
