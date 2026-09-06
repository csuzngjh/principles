// Tests for the workspace lifecycle guard (PRI-691).
//
// Two layers, mirroring the repo's testing doctrine:
//   1. Hermetic unit tests over the PURE classifier/planner
//      (lib/workspace-lifecycle.mjs) — synthetic records, fixed clock.
//   2. Real-git integration tests through the real CLIs using the shared
//      origin+primary fixture (gh is deliberately disabled via
//      PD_WORKSPACE_SKIP_GH=1 so the git-ancestry evidence path is exercised).

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyRecord,
  classifyRecords,
  conflictCodes,
  planCleanup,
} from '../dev/lib/workspace-lifecycle.mjs';
import { normalizeGitPath } from '../dev/lib/git.mjs';
import {
  commitFile,
  git,
  removeFixture,
  runDevScript,
  setupOriginFixture,
} from './dev-worktree-test-utils';

/** Path equality that survives Windows 8.3 short names (ERR-090 class). */
function samePath(a: string | null | undefined, b: string | null | undefined, cwd: string): boolean {
  if (!a || !b) return false;
  return normalizeGitPath(a, cwd) === normalizeGitPath(b, cwd);
}

const NOW = Date.parse('2026-09-06T00:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function wtRecord(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'worktree',
    path: 'D:/wt/task',
    branch: 'ai/PRI-800-task',
    isPrimary: false,
    bare: false,
    detached: false,
    porcelain: '',
    branchExists: true,
    pr: null,
    ancestry: false,
    remoteExists: false,
    tipDate: null,
    leasePhase: 'none',
    leaseOwner: null,
    ...overrides,
  };
}

const CLASSIFY_OPTS = { graceDays: 7, now: NOW };

describe('classifyRecord (pure)', () => {
  it('ACTIVE wins while a PR is open, even when the tip is already merged', () => {
    const r = classifyRecord(
      wtRecord({ pr: { number: 9, state: 'OPEN' }, ancestry: true, tipDate: daysAgo(20) }),
      CLASSIFY_OPTS
    );
    expect(r.status).toBe('ACTIVE');
  });

  it('CLEANUP_READY via GitHub PR MERGED (squash merge — tip NOT an ancestor)', () => {
    const r = classifyRecord(
      wtRecord({ pr: { number: 1515, state: 'MERGED', mergedAt: daysAgo(14) }, ancestry: false, tipDate: daysAgo(20) }),
      CLASSIFY_OPTS
    );
    expect(r.status).toBe('CLEANUP_READY');
    expect(r.ageSource).toBe('pr-mergedAt');
    expect(r.evidence.join(' ')).toContain('PR #1515 MERGED');
  });

  it('CLEANUP_READY via ancestry when GitHub is unavailable', () => {
    const r = classifyRecord(wtRecord({ ancestry: true, tipDate: daysAgo(14) }), CLASSIFY_OPTS);
    expect(r.status).toBe('CLEANUP_READY');
    expect(r.ageSource).toBe('branch-tip-commit-date');
  });

  it('CLEANUP_PENDING while inside the grace period', () => {
    const r = classifyRecord(wtRecord({ ancestry: true, tipDate: daysAgo(2) }), CLASSIFY_OPTS);
    expect(r.status).toBe('CLEANUP_PENDING');
    expect(r.reasons.join(' ')).toContain('grace-period-active');
  });

  it('CLEANUP_PENDING when the worktree is dirty, even if aged out', () => {
    const r = classifyRecord(
      wtRecord({ ancestry: true, tipDate: daysAgo(30), porcelain: ' M notes.md\n' }),
      CLASSIFY_OPTS
    );
    expect(r.status).toBe('CLEANUP_PENDING');
    expect(r.reasons.join(' ')).toContain('dirty-worktree');
  });

  it('CLEANUP_PENDING while an active git-9 write lease is held', () => {
    const r = classifyRecord(
      wtRecord({ ancestry: true, tipDate: daysAgo(30), leasePhase: 'active', leaseOwner: 'agent-x' }),
      CLASSIFY_OPTS
    );
    expect(r.status).toBe('CLEANUP_PENDING');
    expect(r.reasons.join(' ')).toContain('active write lease');
  });

  it('CLEANUP_PENDING when merge age cannot be determined (fail closed)', () => {
    const r = classifyRecord(wtRecord({ pr: { number: 5, state: 'MERGED', mergedAt: null } }), CLASSIFY_OPTS);
    expect(r.status).toBe('CLEANUP_PENDING');
    expect(r.reasons.join(' ')).toContain('merge-age-unknown');
  });

  it('ORPHAN: no PR and not merged (possibly active work — report only)', () => {
    const r = classifyRecord(wtRecord({ ancestry: false, tipDate: daysAgo(1) }), CLASSIFY_OPTS);
    expect(r.status).toBe('ORPHAN');
    expect(r.reasons).toContain('no-pr-found');
  });

  it('ORPHAN: PR closed without merge', () => {
    const r = classifyRecord(wtRecord({ pr: { number: 6, state: 'CLOSED' } }), CLASSIFY_OPTS);
    expect(r.status).toBe('ORPHAN');
    expect(r.reasons).toContain('pr-closed-unmerged');
  });

  it('ORPHAN: detached HEAD and unreadable status are metadata anomalies', () => {
    expect(classifyRecord(wtRecord({ detached: true, branch: null, branchExists: false }), CLASSIFY_OPTS).status).toBe('ORPHAN');
    expect(classifyRecord(wtRecord({ ancestry: true, tipDate: daysAgo(30), porcelain: null }), CLASSIFY_OPTS).status).toBe('ORPHAN');
  });

  it('infrastructure records are never candidates', () => {
    expect(classifyRecord(wtRecord({ isPrimary: true }), CLASSIFY_OPTS).status).toBe('PRIMARY');
    expect(classifyRecord(wtRecord({ bare: true }), CLASSIFY_OPTS).status).toBe('BARE');
    expect(classifyRecord(wtRecord({ branch: 'main' }), CLASSIFY_OPTS).status).toBe('MAIN_CHECKOUT');
  });
});

describe('planCleanup (pure)', () => {
  it('emits remove-worktree + delete-branch for a READY worktree, skips everything else', () => {
    const records = [
      wtRecord({ path: 'D:/wt/ready', branch: 'ai/PRI-800-ready', pr: { number: 10, state: 'MERGED', mergedAt: daysAgo(14) } }),
      wtRecord({ path: 'D:/wt/dirty', branch: 'ai/PRI-800-dirty', ancestry: true, tipDate: daysAgo(30), porcelain: ' M x\n' }),
      wtRecord({ path: 'D:/wt/orphan', branch: 'ai/PRI-800-orphan', ancestry: false }),
      wtRecord({ path: 'D:/wt/active', branch: 'ai/PRI-800-active', pr: { number: 11, state: 'OPEN' } }),
      { ...wtRecord({ path: 'D:/wt/primary', branch: 'main' }), isPrimary: true },
    ];
    const plan = planCleanup(classifyRecords(records, CLASSIFY_OPTS));
    expect(plan.actions).toEqual([
      { kind: 'remove-worktree', path: 'D:/wt/ready', branch: 'ai/PRI-800-ready', evidence: expect.any(Array) },
      { kind: 'delete-branch', branch: 'ai/PRI-800-ready', evidence: expect.any(Array) },
    ]);
    const skippedTargets = plan.skipped.map((s) => s.target);
    expect(skippedTargets).toContain('D:/wt/dirty');
    expect(skippedTargets).toContain('D:/wt/orphan');
    expect(plan.skipped.find((s) => s.target === 'D:/wt/dirty')?.reasons.join(' ')).toContain('dirty-worktree');
  });

  it('branch-only records produce delete-branch, but non-task branches are skipped by namespace', () => {
    const records = [
      { kind: 'branch-only', path: null, branch: 'ai/PRI-800-old', isPrimary: false, bare: false, detached: false, porcelain: null, branchExists: true, pr: { number: 12, state: 'MERGED', mergedAt: daysAgo(30) }, ancestry: false, remoteExists: false, tipDate: daysAgo(40), leasePhase: 'none', leaseOwner: null },
      { kind: 'branch-only', path: null, branch: 'release-keep', isPrimary: false, bare: false, detached: false, porcelain: null, branchExists: true, pr: { number: 13, state: 'MERGED', mergedAt: daysAgo(30) }, ancestry: false, remoteExists: false, tipDate: daysAgo(40), leasePhase: 'none', leaseOwner: null },
    ];
    const plan = planCleanup(classifyRecords(records, CLASSIFY_OPTS));
    expect(plan.actions).toEqual([{ kind: 'delete-branch', branch: 'ai/PRI-800-old', evidence: expect.any(Array) }]);
    expect(plan.skipped[0].reasons.join(' ')).toContain('outside task namespace');
  });
});

describe('conflictCodes (pure)', () => {
  it('extracts only unresolved-conflict XY codes', () => {
    expect(conflictCodes('UU a.txt\nAA b.txt\n M c.txt\n?? d.txt')).toEqual(['UU', 'AA']);
    expect(conflictCodes('')).toEqual([]);
    expect(conflictCodes(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real-git integration through the CLIs (gh disabled → ancestry evidence).
// ---------------------------------------------------------------------------

const SKIP_GH = { PD_WORKSPACE_SKIP_GH: '1' };

async function makeTask(primary: string, slug: string): Promise<{ wt: string; branch: string }> {
  const r = await runDevScript('create-task-worktree.mjs', ['PRI-800', slug, '--json'], { cwd: primary });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout) as { worktree: string; branch: string };
  await commitFile(out.worktree, slug + '.txt', 'x\n', 'task commit ' + slug);
  return { wt: out.worktree, branch: out.branch };
}

async function mergeIntoMain(primary: string, branch: string): Promise<void> {
  await git(primary, 'fetch', 'origin');
  await git(primary, 'switch', 'main');
  await git(primary, 'pull', '--ff-only', 'origin', 'main');
  await git(primary, 'merge', '--no-ff', '-m', 'Merge task ' + branch, branch);
  await git(primary, 'push', 'origin', 'main');
}

describe('workspace-cleanup (integration)', () => {
  const fixture = { root: '', primary: '' };

  beforeAll(async () => {
    const f = await setupOriginFixture('pd-wslc-apply-');
    fixture.root = f.root;
    fixture.primary = f.primary;
  });
  afterAll(() => removeFixture(fixture.root));

  it('dry-run lists evidence-backed candidates and mutates nothing', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'dryrun');
    await mergeIntoMain(fixture.primary, branch);

    const r = await runDevScript('workspace-cleanup.mjs', ['--grace-days', '0', '--json'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { mode: string; actions: Array<{ kind: string; path?: string; branch?: string }> };
    expect(out.mode).toBe('dry-run');
    const removeAction = out.actions.find((a) => a.kind === 'remove-worktree');
    expect(removeAction && samePath(removeAction.path, wt, fixture.primary)).toBe(true);
    expect(out.actions).toContainEqual(expect.objectContaining({ kind: 'delete-branch', branch }));
    // Nothing was mutated.
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(wt, 'dryrun.txt'))).toBe(true);
  });

  it('apply removes the worktree and the task branch, then prunes', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'apply');
    await mergeIntoMain(fixture.primary, branch);

    const r = await runDevScript('workspace-cleanup.mjs', ['--apply', '--grace-days', '0', '--json'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { applied: number; refused: unknown[] };
    expect(out.applied).toBeGreaterThanOrEqual(2);
    expect(out.refused).toEqual([]);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(fixture.primary, 'rev-parse', '--verify', 'refs/heads/' + branch)).rejects.toThrow();
  });

  it('default grace period keeps a freshly merged worktree alive', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'grace');
    await mergeIntoMain(fixture.primary, branch);

    const r = await runDevScript('workspace-cleanup.mjs', ['--apply', '--json'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { skipped: Array<{ target?: string; reasons: string[] }> };
    const skipped = out.skipped.find((s) => samePath(s.target, wt, fixture.primary));
    expect(skipped?.reasons.join(' ')).toContain('grace-period-active');
    expect(fs.existsSync(wt)).toBe(true);
    const health = await runDevScript('workspace-health.mjs', ['--json'], { cwd: fixture.primary, env: SKIP_GH });
    const parsed = JSON.parse(health.stdout) as { worktrees: Array<{ record: { branch?: string }; status: string }> };
    const entry = parsed.worktrees.find((w) => w.record.branch === branch);
    expect(entry?.status).toBe('CLEANUP_PENDING');
  });

  it('refuses a dirty worktree at apply time and preserves the unknown work', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'dirty');
    await mergeIntoMain(fixture.primary, branch);
    fs.writeFileSync(path.join(wt, 'uncommitted.txt'), 'unknown work\n', 'utf-8');

    const r = await runDevScript('workspace-cleanup.mjs', ['--apply', '--grace-days', '0', '--json'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { skipped: Array<{ target?: string; reasons: string[] }> };
    const skipped = out.skipped.find((s) => samePath(s.target, wt, fixture.primary));
    expect(skipped?.reasons.join(' ')).toContain('dirty-worktree');
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(wt, 'uncommitted.txt'))).toBe(true);
    const stillThere = await git(fixture.primary, 'for-each-ref', 'refs/heads/' + branch, '--format=%(refname:short)');
    expect(stillThere.trim()).toBe(branch);
  });

  it('skips a clean but unmerged worktree (no completion evidence)', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'unmerged');

    const r = await runDevScript('workspace-cleanup.mjs', ['--apply', '--grace-days', '0', '--json'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { actions: Array<{ kind: string; path?: string }>; skipped: Array<{ target?: string; reasons: string[] }> };
    const removeForWt = out.actions.find((a) => a.kind === 'remove-worktree' && samePath(a.path, wt, fixture.primary));
    expect(removeForWt).toBeUndefined();
    const skipped = out.skipped.find((s) => samePath(s.target, wt, fixture.primary));
    expect(skipped?.reasons.join(' ')).toContain('no-pr-found');
    expect(fs.existsSync(wt)).toBe(true);
    const stillThere = await git(fixture.primary, 'for-each-ref', 'refs/heads/' + branch, '--format=%(refname:short)');
    expect(stillThere.trim()).toBe(branch);
  });
});

describe('workspace-health (integration)', () => {
  const fixture = { root: '', primary: '' };

  beforeAll(async () => {
    const f = await setupOriginFixture('pd-wslc-health-');
    fixture.root = f.root;
    fixture.primary = f.primary;
    // The harness clones BEFORE pinning core.autocrlf=false, so on machines
    // with a global autocrlf=true the checked-out .gitignore is CRLF on disk
    // and git reports it modified. Re-checkout under the pinned config to
    // restore a genuinely clean primary.
    await git(fixture.primary, 'checkout', '--', '.gitignore');
  });
  afterAll(() => removeFixture(fixture.root));

  it('reports primary OK on clean main and classifies merged vs unmerged tasks', async () => {
    const merged = await makeTask(fixture.primary, 'merged');
    await mergeIntoMain(fixture.primary, merged.branch);
    const unmerged = await makeTask(fixture.primary, 'unmerged');

    const r = await runDevScript('workspace-health.mjs', ['--json', '--grace-days', '0'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      primary: { status: string; branch: string | null; dirty: boolean; conflicts: string[]; warnings: string[] };
      worktrees: Array<{ record: { branch?: string; kind: string }; status: string; reasons: string[] }>;
      residue: unknown[];
      ghAvailable: boolean;
    };
    expect(out.primary.status).toBe('OK');
    expect(out.primary.branch).toBe('main');
    expect(out.ghAvailable).toBe(false);

    const ready = out.worktrees.find((w) => w.record.branch === merged.branch);
    expect(ready?.status).toBe('CLEANUP_READY');
    const orphan = out.worktrees.find((w) => w.record.branch === unmerged.branch);
    expect(orphan?.status).toBe('ORPHAN');
    expect(orphan?.reasons).toContain('no-pr-found');
    expect(out.residue).toEqual([]);
  });
});
