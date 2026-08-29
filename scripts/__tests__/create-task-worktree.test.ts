// Real-git integration tests for scripts/dev/create-task-worktree.mjs.
// Fixtures use a local bare "origin" so the fetch/base logic runs for real.

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
let origin: string;

beforeAll(async () => {
  const fixture = await setupOriginFixture('pd-create-wt-test-');
  root = fixture.root;
  primary = fixture.primary;
  origin = fixture.origin;
});

afterAll(() => {
  removeFixture(root);
});

describe('create-task-worktree', () => {
  it('creates a task worktree + ai/ branch based on the latest origin/main', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-999', 'fix-thing', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; worktree: string; branch: string; base: string };
    expect(out.ok).toBe(true);
    expect(out.branch).toBe('ai/PRI-999-fix-thing');
    expect(normalizeGitPath(out.worktree)).toBe(
      normalizeGitPath(path.join(path.dirname(primary), path.basename(primary) + '-PRI-999-fix-thing'))
    );

    // The worktree really exists and is registered.
    expect(fs.existsSync(out.worktree)).toBe(true);
    const list = await worktreeList(primary);
    expect(list.some((w) => normalizeGitPath(w.path) === normalizeGitPath(out.worktree))).toBe(true);

    // The branch base is exactly origin/main.
    const mainSha = (await git(primary, 'rev-parse', 'origin/main')).trim();
    expect(out.base).toBe(mainSha);
    const headInWorktree = (await git(out.worktree, 'rev-parse', 'HEAD')).trim();
    expect(headInWorktree).toBe(mainSha);
  }, 120_000);

  it('refuses a duplicate branch name (branch collision)', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-999', 'fix-thing', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('already exists');
  }, 60_000);

  it('refuses when the target worktree path already exists', async () => {
    const collision = path.join(path.dirname(primary), path.basename(primary) + '-PRI-998-path-clash');
    fs.mkdirSync(collision, { recursive: true });
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-998', 'path-clash', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(out.error).toContain('already exists');
    // The pre-existing directory is untouched.
    expect(fs.existsSync(collision)).toBe(true);
  }, 60_000);

  it('maps the adhoc task id to a dated branch prefix', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['adhoc', 'spike', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { branch: string };
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(out.branch).toBe('ai/adhoc-' + today + '-spike');
  }, 60_000);

  it('rejects invalid slugs (must be lowercase dir-safe)', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-997', 'Bad_Slug', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(out.error).toContain('Invalid slug');
  }, 60_000);

  it('fails loudly when the base ref cannot be resolved', async () => {
    const r = await runDevScript(
      'create-task-worktree.mjs',
      ['PRI-996', 'missing-base', '--base', 'origin/nope', '--offline', '--json'],
      { cwd: primary }
    );
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('does not resolve');
  }, 60_000);

  it('fails loudly when git fetch fails, with --offline as the documented escape', async () => {
    const brokenRemote = path.join(root, 'broken-primary');
    await git(primary, 'worktree', 'add', '-b', 'work/broken-remote', brokenRemote);
    // NOTE: remote config is REPO-GLOBAL (shared by all worktrees) — restore
    // it afterwards or every later test in this fixture loses its origin.
    await git(brokenRemote, 'remote', 'remove', 'origin');

    const r = await runDevScript('create-task-worktree.mjs', ['PRI-995', 'no-fetch', '--json'], { cwd: brokenRemote });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('fetch');
    expect(out.nextAction).toContain('--offline');

    await git(brokenRemote, 'remote', 'add', 'origin', origin);
  }, 60_000);

  it('creates a second concurrent task without disturbing the first (isolation)', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-994', 'second', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { worktree: string };

    // First task's worktree is untouched and still registered.
    const first = path.join(path.dirname(primary), path.basename(primary) + '-PRI-999-fix-thing');
    expect(fs.existsSync(first)).toBe(true);
    await commitFile(first, 'task-a.txt', 'a\n', 'task A commit');
    const branchA = (await git(first, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    expect(branchA).toBe('ai/PRI-999-fix-thing');

    // And a dirty file in task A survives creating task B (non-destruction).
    fs.writeFileSync(path.join(first, 'wip.txt'), 'wip\n', 'utf-8');
    const list = await worktreeList(primary);
    expect(list.some((w) => normalizeGitPath(w.path) === normalizeGitPath(out.worktree))).toBe(true);
    expect(fs.existsSync(path.join(first, 'wip.txt'))).toBe(true);
  }, 120_000);
});
