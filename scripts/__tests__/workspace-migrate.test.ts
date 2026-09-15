// PRI-796 (SPEC §19, §20, §23): migrating existing legacy-layout worktrees into
// the shared pool, dry-run first, refusing anything a live writer might still be
// using.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGitPath } from '../dev/lib/git.mjs';
import { poolRootFor, removeFixture, runDevScript, setupOriginFixture, worktreeList } from './dev-worktree-test-utils';

let root: string;
let primary: string;
let poolRoot: string;

beforeAll(async () => {
  const fixture = await setupOriginFixture('pd-migrate-');
  root = fixture.root;
  primary = fixture.primary;
  poolRoot = poolRootFor(primary);
});

afterAll(() => {
  removeFixture(root);
});

/** A worktree in the OLD sibling layout: `<parent>/<repo>-<task>-<slug>`. */
async function makeLegacySlot(task: string, slug: string) {
  const { git } = await import('./dev-worktree-test-utils');
  const branch = 'ai/' + task + '-' + slug;
  const dir = path.join(path.dirname(primary), path.basename(primary) + '-' + task + '-' + slug);
  await git(primary, 'worktree', 'add', '-b', branch, dir, 'main');
  return { dir, branch };
}

describe('workspace migration', () => {
  it('REPORTS what it would move, and moves nothing, without --apply', async () => {
    const slot = await makeLegacySlot('PRI-902', 'legacy-one');

    const r = await runDevScript('workspace-migrate.mjs', ['--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      mode: string;
      poolRoot: string;
      wouldMove: Array<{ path: string; target: string }>;
    };
    expect(out.mode).toBe('dry-run');
    expect(normalizeGitPath(out.poolRoot)).toBe(normalizeGitPath(poolRoot));

    const planned = out.wouldMove.find((m) => normalizeGitPath(m.path) === normalizeGitPath(slot.dir));
    expect(planned).toBeDefined();
    expect(normalizeGitPath(planned?.target ?? '')).toBe(normalizeGitPath(path.join(poolRoot, 'PRI-902-legacy-one')));

    // Nothing moved.
    expect(fs.existsSync(slot.dir)).toBe(true);
    expect(fs.existsSync(path.join(poolRoot, 'PRI-902-legacy-one'))).toBe(false);
  }, 120_000);

  it('moves a registered, clean, inactive worktree and keeps git metadata correct', async () => {
    const slot = await makeLegacySlot('PRI-903', 'legacy-two');

    const r = await runDevScript('workspace-migrate.mjs', ['--apply', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { mode: string; moved: Array<{ path: string; target: string }> };
    expect(out.mode).toBe('apply');

    const target = path.join(poolRoot, 'PRI-903-legacy-two');
    expect(fs.existsSync(slot.dir)).toBe(false);
    expect(fs.existsSync(target)).toBe(true);

    // Git still knows where it is, and the branch is unchanged.
    const list = await worktreeList(primary);
    const entry = list.find((w) => w.path.replace(/\\/g, '/').endsWith('PRI-903-legacy-two'));
    expect(entry).toBeDefined();
    expect(entry?.branch).toBe('refs/heads/' + slot.branch);

    // The worktree is usable in its new home.
    const { git } = await import('./dev-worktree-test-utils');
    const status = await git(target, 'status', '--porcelain');
    expect(status.trim()).toBe('');
    expect((await git(target, 'branch', '--show-current')).trim()).toBe(slot.branch);
  }, 120_000);

  it('REFUSES to move a slot with an ACTIVE writer claim', async () => {
    const slot = await makeLegacySlot('PRI-904', 'legacy-active');
    const claim = await runDevScript('worktree-claim.mjs', [slot.dir, '--writer', 'zcode', '--json'], { cwd: primary });
    expect(claim.code).toBe(0);

    const r = await runDevScript('workspace-migrate.mjs', ['--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { wouldMove: Array<{ path: string }>; skipped: Array<{ path: string; state: string; reasons: string[] }> };

    expect(out.wouldMove.some((m) => normalizeGitPath(m.path) === normalizeGitPath(slot.dir))).toBe(false);
    const skipped = out.skipped.find((s) => normalizeGitPath(s.path) === normalizeGitPath(slot.dir));
    expect(skipped?.state).toBe('ACTIVE');
    expect(skipped?.reasons.join(' ')).toContain('ACTIVE write lease');

    // And --apply must not move it either.
    const applied = await runDevScript('workspace-migrate.mjs', ['--apply', '--skip-gh', '--json'], { cwd: primary });
    expect(applied.code).toBe(0);
    expect(fs.existsSync(slot.dir)).toBe(true);
  }, 120_000);

  it('never treats UNKNOWN residue as a migration candidate', async () => {
    const residue = path.join(path.dirname(primary), path.basename(primary) + '-PRI-905-residue');
    fs.mkdirSync(residue, { recursive: true });
    fs.writeFileSync(path.join(residue, '.git'), 'gitdir: ' + path.join(primary, '.git', 'worktrees', 'gone') + '\n', 'utf-8');
    fs.writeFileSync(path.join(residue, 'wip.txt'), 'unknown work\n', 'utf-8');

    const r = await runDevScript('workspace-migrate.mjs', ['--apply', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    // Not moved, not deleted, still holding its unknown work.
    expect(fs.existsSync(residue)).toBe(true);
    expect(fs.readFileSync(path.join(residue, 'wip.txt'), 'utf-8')).toBe('unknown work\n');
    const out = JSON.parse(r.stdout) as { moved: Array<{ path: string }>; skipped: Array<{ path: string }> };
    expect(out.moved.some((m) => normalizeGitPath(m.path) === normalizeGitPath(residue))).toBe(false);
    expect(out.skipped.some((s) => normalizeGitPath(s.path) === normalizeGitPath(residue))).toBe(false);

    // And it IS reported by the snapshot as UNKNOWN.
    const snap = await runDevScript('worktree-snapshot.mjs', ['--skip-gh', '--json'], { cwd: primary });
    const snapOut = JSON.parse(snap.stdout) as { unknownResidue: Array<{ path: string }> };
    expect(snapOut.unknownResidue.some((x) => normalizeGitPath(x.path) === normalizeGitPath(residue))).toBe(true);
  }, 120_000);
});
