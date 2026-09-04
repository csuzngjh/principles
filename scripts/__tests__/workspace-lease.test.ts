// Real-git integration tests for the workspace write lease (AGENTS.md §23A,
// git-9-lease-before-write): scripts/dev/workspace-lease.mjs CLI + the lease
// rules added to scripts/dev/check-dev-worktree.mjs. Every case drives the
// real CLIs against a real temporary repository — no internal-helper tests.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEV_SCRIPTS_DIR,
  commitFile,
  git,
  initRepo,
  makeTempDir,
  removeFixture,
  runDevScript,
} from './dev-worktree-test-utils';

let root: string;

beforeAll(() => {
  root = makeTempDir('pd-lease-test-');
});

afterAll(() => {
  removeFixture(root);
});

/** Resolve a fixture child path with an explicit root-boundary check. */
function fixturePath(name: string): string {
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('fixture path escapes the temp root: ' + name);
  }
  return target;
}

function leaseFile(dir: string): string {
  return path.join(dir, '.workspace-lease.json');
}

function readLeaseJson(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(leaseFile(dir), 'utf-8')) as Record<string, unknown>;
}

function jsonOut(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** Path-form tolerant comparison (git reports expanded/forward-slash forms on
 *  Windows while os.tmpdir() may hand back 8.3 short names — ERR-090 class). */
function samePath(a: string, b: string): boolean {
  const normalize = (p: string): string => {
    let resolved = path.resolve(p);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // Path does not exist (yet) — resolved form is the best comparable.
    }
    return (process.platform === 'win32' ? resolved.toLowerCase() : resolved).replaceAll('\\', '/');
  };
  return normalize(a) === normalize(b);
}

/** Deterministic expired-lease fixture (direct file write — the file IS the contract). */
function writeExpiredLease(dir: string, branch: string, owner = 'ghost-session'): void {
  fs.writeFileSync(
    leaseFile(dir),
    JSON.stringify(
      {
        schema: 'pd-workspace-lease/1',
        workspace: dir,
        owner,
        branch,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

async function makeTaskWorktree(name: string, branch: string): Promise<{ repo: string; wt: string }> {
  const repo = fixturePath(name);
  await initRepo(repo);
  await commitFile(repo, 'a.txt');
  const wt = fixturePath(name + '-wt');
  await git(repo, 'worktree', 'add', '-b', branch, wt);
  return { repo, wt };
}

describe('workspace-lease CLI', () => {
  it('Case A: acquire creates the lease in a task worktree', async () => {
    const { wt } = await makeTaskWorktree('acquire-ok', 'work/acquire-ok');
    const r = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    expect(r.code).toBe(0);
    const out = jsonOut(r.stdout) as { ok: boolean; action: string; lease: Record<string, string> };
    expect(out.ok).toBe(true);
    expect(out.action).toBe('acquired');
    expect(out.lease.owner).toBe('agent-a/PRI-1');
    expect(out.lease.branch).toBe('work/acquire-ok');
    expect(samePath(out.lease.workspace, wt)).toBe(true);
    expect(Date.parse(out.lease.expiresAt)).toBeGreaterThan(Date.now());
    expect(fs.existsSync(leaseFile(wt))).toBe(true);
  }, 60_000);

  it('Case B: a second owner CANNOT acquire while the lease is active — fails loudly with holder identity', async () => {
    const { wt } = await makeTaskWorktree('conflict', 'work/conflict');
    const a = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    expect(a.code).toBe(0);

    const b = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-b/PRI-2', '--json'], { cwd: wt });
    expect(b.code).toBe(1);
    const out = jsonOut(b.stdout) as { ok: boolean; error: string; nextAction: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('agent-a/PRI-1');
    expect(out.error).toContain('work/conflict');
    expect(out.nextAction).toContain('.workspace-lease.json');
    // The winner's lease is untouched.
    expect(readLeaseJson(wt).owner).toBe('agent-a/PRI-1');
  }, 60_000);

  it('same-owner acquire renews (extends expiresAt)', async () => {
    const { wt } = await makeTaskWorktree('renew', 'work/renew');
    const first = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--ttl-hours', '1', '--json'], { cwd: wt });
    expect(first.code).toBe(0);
    const before = Date.parse((jsonOut(first.stdout) as { lease: { expiresAt: string } }).lease.expiresAt);

    const second = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--ttl-hours', '3', '--json'], { cwd: wt });
    expect(second.code).toBe(0);
    const out = jsonOut(second.stdout) as { action: string; lease: { expiresAt: string } };
    expect(out.action).toBe('renewed');
    expect(Date.parse(out.lease.expiresAt)).toBeGreaterThan(before);
  }, 60_000);

  it('an expired lease self-clears: a new owner can acquire', async () => {
    const { wt } = await makeTaskWorktree('expired', 'work/expired');
    writeExpiredLease(wt, 'work/expired');
    const r = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-b/PRI-2', '--json'], { cwd: wt });
    expect(r.code).toBe(0);
    expect(readLeaseJson(wt).owner).toBe('agent-b/PRI-2');
  }, 60_000);

  it('release removes the file and is idempotent', async () => {
    const { wt } = await makeTaskWorktree('release', 'work/release');
    const a = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    expect(a.code).toBe(0);
    const first = await runDevScript('workspace-lease.mjs', ['release', '--json'], { cwd: wt });
    expect(first.code).toBe(0);
    expect(jsonOut(first.stdout)).toEqual({ ok: true, removed: true });
    expect(fs.existsSync(leaseFile(wt))).toBe(false);
    const second = await runDevScript('workspace-lease.mjs', ['release', '--json'], { cwd: wt });
    expect(second.code).toBe(0);
    expect(jsonOut(second.stdout)).toEqual({ ok: true, removed: false });
  }, 60_000);

  it('status reports none → active → expired over the lease lifecycle', async () => {
    const { wt } = await makeTaskWorktree('status', 'work/status');
    const none = await runDevScript('workspace-lease.mjs', ['status', '--json'], { cwd: wt });
    expect(jsonOut(none.stdout)).toMatchObject({ ok: true, lease: { state: 'none' } });

    await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    const active = await runDevScript('workspace-lease.mjs', ['status', '--json'], { cwd: wt });
    expect(jsonOut(active.stdout)).toMatchObject({ ok: true, lease: { state: 'active', owner: 'agent-a/PRI-1' } });

    writeExpiredLease(wt, 'work/status', 'agent-a/PRI-1');
    const expired = await runDevScript('workspace-lease.mjs', ['status', '--json'], { cwd: wt });
    expect(jsonOut(expired.stdout)).toMatchObject({ ok: true, lease: { state: 'expired', owner: 'agent-a/PRI-1' } });
  }, 60_000);

  it('refuses to lease the PRIMARY checkout (control plane is read-only)', async () => {
    const repo = fixturePath('primary-refused');
    await initRepo(repo);
    await commitFile(repo, 'a.txt');
    await git(repo, 'switch', '-c', 'work/some-task');

    const r = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: repo });
    expect(r.code).toBe(1);
    const out = jsonOut(r.stdout) as { ok: boolean; nextAction: string };
    expect(out.ok).toBe(false);
    expect(out.nextAction).toContain('PD_DEV_WORKTREE_ALLOW_PRIMARY');
    expect(fs.existsSync(leaseFile(repo))).toBe(false);
  }, 60_000);

  it('a malformed lease file blocks acquire with a repair action', async () => {
    const { wt } = await makeTaskWorktree('malformed', 'work/malformed');
    fs.writeFileSync(leaseFile(wt), '{not json', 'utf-8');
    const r = await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    expect(r.code).toBe(1);
    const out = jsonOut(r.stdout) as { ok: boolean; error: string; nextAction: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('invalid');
    expect(out.nextAction).toContain('.workspace-lease.json');
  }, 60_000);

  it('status resolves the checkout root when run from a subdirectory', async () => {
    const { wt } = await makeTaskWorktree('subdir', 'work/subdir');
    await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    const sub = path.join(wt, 'nested');
    fs.mkdirSync(sub, { recursive: true });
    const r = await runDevScript('workspace-lease.mjs', ['status', '--json'], { cwd: sub });
    expect(r.code).toBe(0);
    expect(jsonOut(r.stdout)).toMatchObject({ ok: true, lease: { state: 'active', owner: 'agent-a/PRI-1' } });
  }, 60_000);
});

describe('worktree guard lease rules (check-dev-worktree.mjs)', () => {
  it('passes with an active lease on the SAME branch and reports it in JSON', async () => {
    const { wt } = await makeTaskWorktree('guard-same', 'work/guard-same');
    await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(0);
    const out = jsonOut(r.stdout) as { ok: boolean; lease: { state: string; owner: string }; violations: unknown[] };
    expect(out.ok).toBe(true);
    expect(out.lease.state).toBe('active');
    expect(out.lease.owner).toBe('agent-a/PRI-1');
    expect(out.violations).toEqual([]);
  }, 60_000);

  it('fails with lease-branch-mismatch when the branch was switched under an active lease (PRI-663 signature)', async () => {
    const { wt } = await makeTaskWorktree('guard-mismatch', 'work/guard-mismatch');
    await runDevScript('workspace-lease.mjs', ['acquire', '--owner', 'agent-a/PRI-1', '--json'], { cwd: wt });
    // A foreign session switches the worktree to another branch...
    await git(wt, 'switch', '-c', 'work/foreign-takeover');

    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(1);
    const out = jsonOut(r.stdout) as { ok: boolean; violations: Array<{ rule: string; message: string; nextAction: string }> };
    expect(out.ok).toBe(false);
    const violation = out.violations.find((v) => v.rule === 'lease-branch-mismatch');
    expect(violation).toBeDefined();
    expect(violation!.message).toContain('agent-a/PRI-1');
    expect(violation!.message).toContain('guard-mismatch');
    expect(violation!.nextAction).toContain('.workspace-lease.json');
    // Cleanup: return the fixture worktree to its created branch.
    await git(wt, 'switch', 'work/guard-mismatch');
  }, 60_000);

  it('an EXPIRED lease with a branch mismatch does not block (holder is gone)', async () => {
    const { wt } = await makeTaskWorktree('guard-expired', 'work/guard-expired');
    writeExpiredLease(wt, 'work/some-other-branch');
    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(0);
    const out = jsonOut(r.stdout) as { ok: boolean; lease: { state: string } };
    expect(out.ok).toBe(true);
    expect(out.lease.state).toBe('expired');
  }, 60_000);

  it('fails with lease-invalid on a malformed lease file', async () => {
    const { wt } = await makeTaskWorktree('guard-invalid', 'work/guard-invalid');
    fs.writeFileSync(leaseFile(wt), 'garbage', 'utf-8');
    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(1);
    const out = jsonOut(r.stdout) as { violations: Array<{ rule: string }> };
    expect(out.violations.map((v) => v.rule)).toContain('lease-invalid');
  }, 60_000);

  it('no lease file → guard unchanged (normal dev / CI unaffected)', async () => {
    const { wt } = await makeTaskWorktree('guard-none', 'work/guard-none');
    const r = await runDevScript('check-dev-worktree.mjs', ['--json'], { cwd: wt });
    expect(r.code).toBe(0);
    const out = jsonOut(r.stdout) as { ok: boolean; lease: { state: string } };
    expect(out.ok).toBe(true);
    expect(out.lease.state).toBe('none');
  }, 60_000);
});

describe('concurrent acquire (review R2: atomic first-create)', () => {
  it('two racing CLI processes → exactly ONE wins the lease, the loser reports the conflict', async () => {
    const { execFile } = await import('node:child_process');
    const { wt } = await makeTaskWorktree('race', 'work/race');

    const spawnAcquire = (owner: string): Promise<{ code: number; stdout: string }> =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(DEV_SCRIPTS_DIR, 'workspace-lease.mjs'), 'acquire', '--owner', owner, '--json'],
          { cwd: wt, encoding: 'utf-8' },
          (err, stdout) => {
            const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
            resolve({ code, stdout: String(stdout ?? '') });
          },
        );
      });

    // Launch BOTH processes before awaiting either, so they truly race.
    const [a, b] = await Promise.all([spawnAcquire('agent-a/PRI-1'), spawnAcquire('agent-b/PRI-2')]);

    const winners = [a, b].filter((r) => r.code === 0);
    expect(winners).toHaveLength(1);
    expect([a, b].filter((r) => r.code !== 0)).toHaveLength(1);

    const loser = a.code !== 0 ? a : b;
    const loserOut = jsonOut(loser.stdout) as { ok: boolean; error: string };
    expect(loserOut.ok).toBe(false);
    expect(loserOut.error).toContain('lease-locked by another writer');

    // The file holds the WINNER's lease, never a clobbered mixture.
    const holder = readLeaseJson(wt).owner as string;
    expect(holder === 'agent-a/PRI-1' || holder === 'agent-b/PRI-2').toBe(true);
    const winnerName = holder === 'agent-a/PRI-1' ? 'agent-a/PRI-1' : 'agent-b/PRI-2';
    expect(winners[0].stdout).toContain(winnerName);
  }, 60_000);
});
