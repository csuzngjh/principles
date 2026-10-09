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
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyRecord,
  classifyRecords,
  conflictCodes,
  planCleanup,
  collectPrIndex,
} from '../dev/lib/workspace-lifecycle.mjs';
import { normalizeGitPath } from '../dev/lib/git.mjs';
import {
  commitFile,
  git,
  removeFixture,
  runDevScript,
  setupOriginFixture,
  worktreeList,
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
  // PRI-796: --skip-bootstrap, because this suite exercises the lifecycle
  // classifier, not the (multi-minute) bootstrap → ready path, which has its own
  // coverage. Without it create reports CREATED_NOT_READY and exits non-zero.
  const r = await runDevScript('create-task-worktree.mjs', ['PRI-800', slug, '--skip-bootstrap', '--json'], { cwd: primary });
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

// ---------------------------------------------------------------------------
// collectPrIndex — request shape, indexing, conservative degradation.
//
// `runGh` is the module's only injection seam: exactly two implementations
// exist (the real `defaultRunGhPrList` and the fake below), which is the P7
// "real seam" heuristic. The price of a fake dependency is that CI never
// exercises the real `gh` invocation, so an unsupported flag (the PRI-950
// `--page` bug) can hide indefinitely. The flag-whitelist test at the end of
// this block is the mitigation for exactly that blind spot.
// ---------------------------------------------------------------------------
describe('collectPrIndex (full-history --limit)', () => {
  const pr = (n: number, headRefName: string, state = 'MERGED') => ({
    number: n, headRefName, state, url: `https://example/${n}`, mergedAt: '2026-01-01T00:00:00Z',
  });
  const stateOf = (args: string[]) => args[args.indexOf('--state') + 1];

  it('issues exactly one gh pr list call per state, with no --page and a full-history --limit', async () => {
    const calls: string[][] = [];
    const runGh = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify([]);
    };

    const idx = await collectPrIndex('.', { runGh });
    expect(idx.available).toBe(true);

    // One call for open + one for merged — no pagination loop.
    expect(calls.map(stateOf).sort()).toEqual(['merged', 'open']);

    for (const args of calls) {
      // Regression guard for PRI-950: `gh pr list` has no `--page` flag; the
      // old loop passed it and threw on the first REAL invocation, silently
      // degrading every consumer to git-only evidence.
      expect(args).not.toContain('--page');
      // `--limit` is a TOTAL count and must cover the full merged history
      // (1709 merged PRs measured against gh 2.86.0 on 2026-10-09). 2000 is
      // the verified working floor.
      const limit = Number(args[args.indexOf('--limit') + 1]);
      expect(limit).toBeGreaterThanOrEqual(2000);
    }
  });

  it('indexes open and merged PRs by headRefName, including a branch outside the old 300-item window', async () => {
    const runGh = async (args: string[]) => {
      if (stateOf(args) === 'open') {
        return JSON.stringify([pr(4242, 'ai/open-branch', 'OPEN')]);
      }
      // A recent PR plus #7 — far older than any 300-item window. The whole
      // merged response is indexed, not just its head.
      return JSON.stringify([pr(1966, 'ai/recent-merged'), pr(7, 'ai/old-merged-branch')]);
    };

    const idx = await collectPrIndex('.', { runGh });
    expect(idx.available).toBe(true);
    expect(idx.open.get('ai/open-branch')?.number).toBe(4242);
    expect(idx.merged.get('ai/recent-merged')?.number).toBe(1966);
    expect(idx.merged.get('ai/old-merged-branch')?.number).toBe(7);
  });

  it('keeps the conservative contract: a failing gh call yields available=false', async () => {
    const runGh = async () => {
      throw new Error('gh unavailable');
    };
    const idx = await collectPrIndex('.', { runGh });
    expect(idx.available).toBe(false);
  });

  // Read the real binary's advertised flags once. null ⇒ gh missing or
  // `--help` failed; the test then carries no signal and is skipped (not the
  // suite) so machines without gh/auth stay green.
  const ghListHelp = (() => {
    try {
      return execFileSync('gh', ['pr', 'list', '--help'], { encoding: 'utf-8' });
    } catch {
      return null;
    }
  })();

  it.skipIf(ghListHelp === null)(
    'every long flag this module passes to gh is advertised by the real `gh pr list --help`',
    async () => {
      // Why this exists: `runGh` is injected in every test above, so CI only
      // ever exercises the fake — the seam that hid PRI-950, where an
      // unsupported `--page` flag made the real call throw on first use. This
      // test drives the same arg-building code against the real binary's flag
      // list. It is a mitigation, not proof: it validates the flag surface,
      // not that a successful call returns the expected data.
      const passed = new Set<string>();
      const runGh = async (args: string[]) => {
        for (const a of args) if (a.startsWith('--')) passed.add(a);
        return '[]';
      };
      await collectPrIndex('.', { runGh });

      const advertised = new Set<string>(ghListHelp!.match(/--[a-z][a-z-]*/g) ?? []);
      expect(passed.size).toBeGreaterThan(0);
      for (const flag of passed) {
        expect(advertised.has(flag), `gh pr list does not advertise ${flag}`).toBe(true);
      }
    }
  );
});

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
    await expect(git(fixture.primary, 'rev-parse', '--verify', 'refs/heads/' + branch)).rejects.toThrow();
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

  it('apply still cleans its target but SKIPS the global prune while a sibling worktree is unreadable (PRI-712)', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'pruneguard');
    await mergeIntoMain(fixture.primary, branch);

    // Sibling: simulates the PRI-710 incident precondition — a live worktree
    // whose git probe currently fails (damaged .git pointer here; in the
    // wild: Windows lock races). Its admin metadata must survive the sweep.
    const sibling = await makeTask(fixture.primary, 'pruneguard-sibling');
    const siblingGitFile = path.join(sibling.wt, '.git');
    const gitPointer = fs.readFileSync(siblingGitFile, 'utf-8');
    fs.rmSync(siblingGitFile);

    try {
      const r = await runDevScript('workspace-cleanup.mjs', ['--apply', '--grace-days', '0', '--json'], { cwd: fixture.primary, env: SKIP_GH });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout) as { pruned: boolean; notes: string[] };
      expect(out.pruned).toBe(false);
      expect(out.notes.join(' ')).toContain('skipped global worktree prune');
      // The sanctioned target is still cleaned — the guard only defers the prune.
      expect(fs.existsSync(wt)).toBe(false);
      // Negative control: the sibling's admin entry AND its work survived.
      const list = await worktreeList(fixture.primary);
      expect(list.some((w) => normalizeGitPath(w.path) === normalizeGitPath(sibling.wt))).toBe(true);
      expect(fs.existsSync(path.join(sibling.wt, 'pruneguard-sibling.txt'))).toBe(true);
    } finally {
      // Fixture hygiene: restore the pointer so removeFixture can clean up.
      fs.writeFileSync(siblingGitFile, gitPointer, 'utf-8');
    }
  });
});

describe('workspace-cleanup prune safety (PRI-712)', () => {
  const fixture = { root: '', primary: '' };

  beforeAll(async () => {
    const f = await setupOriginFixture('pd-wslc-prune-');
    fixture.root = f.root;
    fixture.primary = f.primary;
  });
  afterAll(() => removeFixture(fixture.root));

  it('runs the global prune when every live worktree probes clean', async () => {
    const { wt, branch } = await makeTask(fixture.primary, 'allclean');
    await mergeIntoMain(fixture.primary, branch);

    const r = await runDevScript('workspace-cleanup.mjs', ['--apply', '--grace-days', '0', '--json'], { cwd: fixture.primary, env: SKIP_GH });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { pruned: boolean };
    expect(out.pruned).toBe(true);
    expect(fs.existsSync(wt)).toBe(false);
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
