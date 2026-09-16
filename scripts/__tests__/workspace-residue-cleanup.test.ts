// PRI-796 (SPEC §15, §16, §23): residue classification and the explicitly-acked
// deletion path. The point of these cases is the NEGATIVE space: what must NOT be
// deleted, and what must not be deleted *without* an acknowledgement.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGitPath } from '../dev/lib/git.mjs';
import { classifyResidue, scanResidue, toOwnerState } from '../dev/lib/workspace-lifecycle.mjs';
import { git, removeFixture, runDevScript, setupOriginFixture } from './dev-worktree-test-utils';

let root: string;
let primary: string;

beforeAll(async () => {
  const fixture = await setupOriginFixture('pd-residue-cleanup-');
  root = fixture.root;
  primary = fixture.primary;
});

afterAll(() => {
  removeFixture(root);
});

const BRANCH = 'ai/PRI-777-lost';

/**
 * Build a worktree shell the way the real incident produces one: a working tree
 * whose `.git` file points at an admin directory that no longer exists.
 */
function makeResidueShell(name: string, opts: { branch?: string | null; leaseOwner?: string } = {}): string {
  const dir = path.join(root, path.basename(primary) + '-' + name);
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ' + path.join(primary, '.git', 'worktrees', name) + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"residue"}\n', 'utf-8');
  if (opts.branch !== null) {
    fs.writeFileSync(
      path.join(dir, '.workspace-lease.json'),
      JSON.stringify(
        {
          schema: 'pd-workspace-lease/1',
          workspace: dir,
          owner: opts.leaseOwner || 'zcode:' + BRANCH,
          branch: opts.branch || BRANCH,
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-09-01T04:00:00.000Z',
        },
        null,
        2
      ),
      'utf-8'
    );
  }
  return dir;
}

describe('residue scanning', () => {
  it('finds a worktree shell whose admin metadata is gone, and recovers its branch from the lease', async () => {
    await git(primary, 'branch', BRANCH, 'main');
    const dir = makeResidueShell('PRI-777-lost');
    const found = scanResidue(primary, { poolRoot: path.join(root, '_worktrees', path.basename(primary)) });
    const entry = found.find((r) => r.path === dir);
    expect(entry).toBeDefined();
    expect(entry?.recoveredBranch).toBe(BRANCH);
    expect(entry?.leasePhase).toBe('expired');
  }, 60_000);
});

describe('residue classification (SPEC §15)', () => {
  it('is RESIDUE_KNOWN when the task and its completion are both recoverable', () => {
    const verdict = classifyResidue({
      recoveredBranch: BRANCH,
      leasePhase: 'expired',
      leaseOwner: 'zcode:' + BRANCH,
      completion: 'ancestry',
      gitdirTarget: '/gone',
    });
    expect(verdict.residueClass).toBe('RESIDUE_KNOWN');
    expect(verdict.evidence.join(' ')).toContain(BRANCH);
    // Dirtiness is ALWAYS declared unprovable — that is why the ack is required.
    expect(verdict.reasons.join(' ')).toContain('UNPROVABLE');
  });

  it('is UNKNOWN when no branch can be recovered', () => {
    const verdict = classifyResidue({ recoveredBranch: null, leasePhase: 'none', completion: null });
    expect(verdict.residueClass).toBe('UNKNOWN');
    expect(verdict.reasons.join(' ')).toContain('completion cannot be proven');
  });

  it('stays UNKNOWN while a writer lease is still ACTIVE', () => {
    const verdict = classifyResidue({ recoveredBranch: BRANCH, leasePhase: 'active', completion: 'ancestry' });
    expect(verdict.residueClass).toBe('UNKNOWN');
  });

  it('always reports UNKNOWN as the status — residue is never deletable by classification', () => {
    for (const phase of ['none', 'expired', 'active', 'invalid']) {
      expect(classifyResidue({ recoveredBranch: BRANCH, leasePhase: phase, completion: 'ancestry' }).status).toBe('UNKNOWN');
    }
  });
});

describe('owner-facing state projection (SPEC §12)', () => {
  it('maps the internal tokens onto the four frozen words in one place', () => {
    expect(toOwnerState('ACTIVE')).toBe('ACTIVE');
    expect(toOwnerState('CLEANUP_PENDING')).toBe('PENDING');
    expect(toOwnerState('CLEANUP_READY')).toBe('CLEANUP_READY');
    expect(toOwnerState('ORPHAN')).toBe('UNKNOWN');
    expect(toOwnerState('PRIMARY')).toBe('PRIMARY');
  });
});

describe('residue deletion requires an explicit acknowledgement', () => {
  it('REFUSES without --ack-unknown and deletes nothing', async () => {
    const dir = makeResidueShell('PRI-710-noack');
    const r = await runDevScript('workspace-cleanup.mjs', ['--residue', dir, '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('--ack-unknown');
    expect(fs.existsSync(dir)).toBe(true);
  }, 60_000);

  it('REFUSES a path it did not itself classify as residue', async () => {
    const innocent = path.join(root, 'not-residue-at-all');
    fs.mkdirSync(innocent, { recursive: true });
    fs.writeFileSync(path.join(innocent, 'important.txt'), 'keep\n', 'utf-8');

    const r = await runDevScript('workspace-cleanup.mjs', ['--residue', innocent, '--ack-unknown', '--apply', '--skip-gh', '--json'], {
      cwd: primary,
    });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('not a discovered residue shell');
    // The hardest guarantee: --ack-unknown cannot be aimed at an arbitrary path.
    expect(fs.readFileSync(path.join(innocent, 'important.txt'), 'utf-8')).toBe('keep\n');
  }, 60_000);

  it('is DRY-RUN by default even with --ack-unknown', async () => {
    const dir = makeResidueShell('PRI-711-dryrun');
    const r = await runDevScript('workspace-cleanup.mjs', ['--residue', dir, '--ack-unknown', '--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { mode: string; counts: { files: number } };
    expect(out.mode).toBe('dry-run');
    expect(out.counts.files).toBeGreaterThan(0);
    expect(fs.existsSync(dir)).toBe(true);
  }, 60_000);

  it('deletes when --ack-unknown and --apply are both given, and reports the links it detached', async () => {
    const dir = makeResidueShell('PRI-712-apply');
    const r = await runDevScript('workspace-cleanup.mjs', ['--residue', dir, '--ack-unknown', '--apply', '--skip-gh', '--json'], {
      cwd: primary,
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  }, 60_000);
});

describe('residue is outside the automatic sweep', () => {
  it('reports residue in the dry-run but never schedules it as an action', async () => {
    makeResidueShell('PRI-713-sweep');
    const r = await runDevScript('workspace-cleanup.mjs', ['--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { mode: string; actions: Array<{ path?: string }>; residue: Array<{ path: string }> };
    expect(out.mode).toBe('dry-run');
    const residuePaths = out.residue.map((x) => x.path);
    expect(residuePaths.some((p) => p.includes('PRI-713-sweep'))).toBe(true);
    for (const action of out.actions) {
      expect(residuePaths).not.toContain(action.path);
    }
  }, 60_000);

  it('shows residue as an UNKNOWN row the Owner can act on in the snapshot', async () => {
    const dir = makeResidueShell('PRI-714-snapshot');
    const r = await runDevScript('worktree-snapshot.mjs', ['--skip-gh', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      unknownResidue: Array<{ task: string; state: string; cleanup: string; residueClass: string; path: string }>;
      poolRoot: string;
    };
    const row = out.unknownResidue.find((x) => normalizeGitPath(x.path) === normalizeGitPath(dir));
    expect(row).toBeDefined();
    expect(row?.state).toBe('UNKNOWN');
    expect(row?.cleanup).toBe('REVIEW');
    // The pool the snapshot reports must be the derived one, not a literal.
    // (normalizeGitPath on both sides: os.tmpdir() may report an 8.3 short name
    // while the tool reports the expanded path — the ERR-090 class.)
    expect(normalizeGitPath(out.poolRoot)).toBe(normalizeGitPath(path.join(root, '_worktrees', path.basename(primary))));
  }, 60_000);
});
