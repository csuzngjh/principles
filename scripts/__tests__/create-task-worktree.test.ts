// Real-git integration tests for scripts/dev/create-task-worktree.mjs.
// Fixtures use a local bare "origin" so the fetch/base logic runs for real.
//
// PRI-796 updated the PATH contract (git-10) and the adhoc identity (git-11):
// worktrees now land in the derived pool, and adhoc tasks carry a random suffix.
// Cases that only care about creation pass --skip-bootstrap, because the
// bootstrap → ready path has its own dedicated coverage and would otherwise run
// a multi-minute npm install inside every one of these tests.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGitPath } from '../dev/lib/git.mjs';
import {
  commitFile,
  git,
  poolRootFor,
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
  it('creates a task worktree + ai/ branch based on the latest origin/main, inside the pool', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-999', 'fix-thing', '--skip-bootstrap', '--json'], {
      cwd: primary,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      ok: boolean;
      state: string;
      worktree: string;
      branch: string;
      base: string;
      pool: { root: string };
    };
    expect(out.ok).toBe(true);
    expect(out.state).toBe('CREATED');
    expect(out.branch).toBe('ai/PRI-999-fix-thing');

    // git-10: the pool is DERIVED from the primary, and the directory name does
    // not repeat the repo or branch namespace. (Both sides go through
    // normalizeGitPath: os.tmpdir() can hand back an 8.3 short name while the
    // tool reports the expanded one — the ERR-090 class.)
    const pool = poolRootFor(primary);
    expect(normalizeGitPath(out.pool.root)).toBe(normalizeGitPath(pool));
    expect(normalizeGitPath(out.worktree)).toBe(normalizeGitPath(path.join(pool, 'PRI-999-fix-thing')));
    // The legacy sibling layout must no longer be produced.
    expect(normalizeGitPath(out.worktree)).not.toBe(
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

  it('honours PD_WORKTREE_ROOT as an override for the pool', async () => {
    const custom = path.join(root, 'custom-pool');
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-960', 'custom-pool', '--skip-bootstrap', '--json'], {
      cwd: primary,
      env: { PD_WORKTREE_ROOT: custom },
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { worktree: string; pool: { root: string; source: string } };
    expect(out.pool.source).toBe('env');
    expect(normalizeGitPath(out.pool.root)).toBe(normalizeGitPath(custom));
    expect(normalizeGitPath(out.worktree)).toBe(normalizeGitPath(path.join(custom, 'PRI-960-custom-pool')));
    expect(fs.existsSync(out.worktree)).toBe(true);
  }, 120_000);

  it('refuses a duplicate branch name (branch collision)', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-999', 'fix-thing', '--skip-bootstrap', '--json'], {
      cwd: primary,
    });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('already exists');
  }, 60_000);

  it('classifies an existing plain directory instead of collapsing to "already exists"', async () => {
    // SPEC §6.1 D: the operator must get a real diagnosis. The directory is
    // created where the tool would put the worktree — inside the pool.
    const collision = path.join(poolRootFor(primary), 'PRI-998-path-clash');
    fs.mkdirSync(collision, { recursive: true });
    fs.writeFileSync(path.join(collision, 'something-of-mine.txt'), 'not yours\n', 'utf-8');

    const r = await runDevScript('create-task-worktree.mjs', ['PRI-998', 'path-clash', '--skip-bootstrap', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string; nextAction: string };
    expect(out.error).toContain('plain-directory');
    // The pre-existing directory is untouched.
    expect(fs.readFileSync(path.join(collision, 'something-of-mine.txt'), 'utf-8')).toBe('not yours\n');
  }, 60_000);

  it('classifies a residue shell and points at the ack workflow', async () => {
    const residue = path.join(poolRootFor(primary), 'PRI-997-residue-clash');
    fs.mkdirSync(residue, { recursive: true });
    fs.writeFileSync(path.join(residue, '.git'), 'gitdir: ' + path.join(primary, '.git', 'worktrees', 'gone') + '\n', 'utf-8');

    const r = await runDevScript('create-task-worktree.mjs', ['PRI-997', 'residue-clash', '--skip-bootstrap', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('residue');
    expect(out.nextAction).toContain('--ack-unknown');
    // Nothing was deleted.
    expect(fs.existsSync(residue)).toBe(true);
  }, 60_000);

  it('gives adhoc tasks a dated identity with a random suffix so same-day agents cannot collide', async () => {
    const a = await runDevScript('create-task-worktree.mjs', ['adhoc', 'spike', '--skip-bootstrap', '--json'], { cwd: primary });
    expect(a.code).toBe(0);
    const out = JSON.parse(a.stdout) as { branch: string; worktree: string };
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(out.branch).toMatch(new RegExp('^ai/adhoc-' + today + '-spike-[0-9a-f]{6}$'));
    // Branch and directory stay the same identity.
    expect(path.basename(out.worktree)).toBe(out.branch.replace(/^ai\//, ''));
  }, 60_000);

  it('rejects invalid slugs (must be lowercase dir-safe)', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-996', 'Bad_Slug', '--skip-bootstrap', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(out.error).toContain('Invalid slug');
  }, 60_000);

  it('fails loudly when the base ref cannot be resolved', async () => {
    const r = await runDevScript(
      'create-task-worktree.mjs',
      ['PRI-995', 'missing-base', '--base', 'origin/nope', '--offline', '--skip-bootstrap', '--json'],
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

    const r = await runDevScript('create-task-worktree.mjs', ['PRI-994', 'no-fetch', '--skip-bootstrap', '--json'], { cwd: brokenRemote });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string; code: string };
    expect(out.error).toContain('fetch');
    expect(out.nextAction).toContain('--offline');
    // A network/credential failure is an ENVIRONMENT problem, not a check
    // failure — the taxonomy exists so this is not mistaken for a bad change.
    expect(out.code).toBe('ENVIRONMENT_INVALID');

    await git(brokenRemote, 'remote', 'add', 'origin', origin);
  }, 60_000);

  it('creates a second concurrent task without disturbing the first (isolation)', async () => {
    const r = await runDevScript('create-task-worktree.mjs', ['PRI-993', 'second', '--skip-bootstrap', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { worktree: string };

    // First task's worktree is untouched and still registered.
    const first = path.join(poolRootFor(primary), 'PRI-999-fix-thing');
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
