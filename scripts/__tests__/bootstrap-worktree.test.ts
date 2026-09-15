// PRI-796 round-2 (Blocker 4): bootstrap must mutate ONLY a real worktree
// root. The acceptance hazards are concrete: a COPIED source tree (package.json
// + scripts/ but no git), and a NESTED subdirectory of a real worktree — both
// of which `git rev-parse --is-inside-work-tree` (or a package.json probe)
// would wave through. Bootstrap must refuse BOTH before running anything, and
// accept the actual root.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, initRepo, makeTempDir, removeFixture, runDevScript } from './dev-worktree-test-utils';

let root: string;

beforeEach(() => {
  root = makeTempDir('pd-bootstrap-');
});

afterEach(() => {
  removeFixture(root);
});

/**
 * A setup-worktree stub that RECORDS that it ran: the refusals must happen
 * BEFORE it, acceptance must reach it.
 */
function seedTree(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', version: '1.0.0', workspaces: [], scripts: {} }, null, 2),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(dir, 'scripts', 'setup-worktree.mjs'),
    "import fs from 'node:fs';\nfs.writeFileSync('SETUP-RAN', 'yes');\n",
    'utf-8'
  );
}

function setupRan(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SETUP-RAN'));
}

describe('bootstrap-worktree root validation', () => {
  it('refuses a copied source tree that is not inside any git worktree', () => {
    const copy = path.join(root, 'copied-src');
    seedTree(copy);
    const r = runDevScript('bootstrap-worktree.mjs', [copy, '--json'], { cwd: root });
    return r.then((res) => {
      expect(res.code).toBe(2); // ENVIRONMENT_INVALID refusal, exit 2
      expect(res.stdout + res.stderr).toMatch(/not inside a git worktree/);
      expect(setupRan(copy)).toBe(false); // refused BEFORE mutating anything
    });
  });

  it('refuses a nested subdirectory of a real worktree even though git says it is inside a worktree', async () => {
    const main = path.join(root, 'main');
    await initRepo(main);
    seedTree(main);
    await git(main, 'add', '-A');
    await git(main, 'commit', '-m', 'init');
    const wt = path.join(root, 'task-wt');
    await git(main, 'worktree', 'add', '-b', 'ai/PRI-903-nested', wt);

    // The nested dir: a copy of package.json + scripts under a real worktree.
    // `git -C <nested> rev-parse --is-inside-work-tree` says TRUE there —
    // only the toplevel comparison can catch this.
    const nested = path.join(wt, 'packages', 'foo');
    seedTree(nested);
    const r = await runDevScript('bootstrap-worktree.mjs', [nested, '--json'], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/is not the worktree root/);
    expect(setupRan(nested)).toBe(false);
  }, 120_000);

  it('accepts the actual worktree root and reaches the setup script', async () => {
    const main = path.join(root, 'main2');
    await initRepo(main);
    seedTree(main);
    await git(main, 'add', '-A');
    await git(main, 'commit', '-m', 'init');
    const wt = path.join(root, 'task-wt2');
    await git(main, 'worktree', 'add', '-b', 'ai/PRI-903-root', wt);

    const r = await runDevScript('bootstrap-worktree.mjs', [wt, '--skip-install', '--skip-build', '--json'], { cwd: root });
    // The precondition passed: the stub ran. Readiness still fails (there is
    // no real workspace here) — exit 1 with a NOT_READY payload, NOT exit 2.
    expect(r.code, 'stdout: ' + r.stdout + '\nstderr: ' + r.stderr).not.toBe(2);
    expect(setupRan(wt)).toBe(true);
    const out = JSON.parse(r.stdout) as { ok: boolean; worktreeRoot: string; setupExitCode: number };
    expect(out.setupExitCode).toBe(0);
    expect(path.resolve(out.worktreeRoot)).toBe(path.resolve(wt));
  }, 120_000);
});
