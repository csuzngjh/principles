// PRI-796 (SPEC §10, §23): stable writer identity, the two halves of ownership
// (PD lease + `git worktree lock`), release idempotence and STALE_LOCK.
//
// Every case drives the real CLIs against a real repository, because the point of
// the change is that ownership survives ACROSS PROCESSES — an in-process test
// would not exercise the pid-independence this replaced.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyLockAgainstLease } from '../dev/lib/worktree-lock.mjs';
import { parseWriterOwner, composeWriterOwner, WRITER_LABELS } from '../dev/lib/workspace-lease.mjs';
import { git, removeFixture, runDevScript, setupOriginFixture, worktreeEntry } from './dev-worktree-test-utils';

let root: string;
let primary: string;

beforeAll(async () => {
  const fixture = await setupOriginFixture('pd-claim-test-');
  root = fixture.root;
  primary = fixture.primary;
});

afterAll(() => {
  removeFixture(root);
});

async function makeSlot(slug: string): Promise<{ worktree: string; branch: string }> {
  const r = await runDevScript('create-task-worktree.mjs', ['PRI-901', slug, '--skip-bootstrap', '--json'], { cwd: primary });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as { worktree: string; branch: string };
}

function leaseOf(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, '.workspace-lease.json'), 'utf-8'));
}

describe('writer claim (git-11)', () => {
  it('takes the PD lease AND the git worktree lock', async () => {
    const created = await makeSlot('claim-basic');
    const wt = created.worktree;

    const r = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'workbuddy', '--json'], { cwd: primary });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; owner: string; task: string; locked: boolean };
    expect(out.ok).toBe(true);
    expect(out.owner).toBe('workbuddy:PRI-901-claim-basic');
    expect(out.task).toBe('PRI-901-claim-basic');
    expect(out.locked).toBe(true);

    // Git itself now protects the slot.
    const entry = await worktreeEntry(primary, wt);
    expect(entry?.locked).toBe(true);
    expect(entry?.lockReason).toBe('writer=workbuddy task=PRI-901-claim-basic');

    // The lease records writer/task plus pid/host as DEBUG metadata.
    const lease = leaseOf(wt);
    expect(lease.owner).toBe('workbuddy:PRI-901-claim-basic');
    const writer = lease.writer as Record<string, unknown>;
    expect(writer.label).toBe('workbuddy');
    expect(writer.task).toBe('PRI-901-claim-basic');
    expect(typeof writer.pid).toBe('number');
  }, 120_000);

  it('renews for the SAME writer across a different process (pid is not the identity)', async () => {
    const created = await makeSlot('claim-renew');
    const wt = created.worktree;

    const first = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'codex', '--json'], { cwd: primary });
    expect(first.code).toBe(0);
    const firstPid = (leaseOf(wt).writer as Record<string, unknown>).pid;

    // A brand-new process, same writer + task → renewal, not a conflict.
    const second = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'codex', '--json'], { cwd: primary });
    expect(second.code).toBe(0);
    const out = JSON.parse(second.stdout) as { action: string; ok: boolean };
    expect(out.ok).toBe(true);
    expect(out.action).toBe('renewed');
    expect((leaseOf(wt).writer as Record<string, unknown>).pid).not.toBe(firstPid);
    // The git lock was already ours, so the re-claim re-asserts it rather than
    // failing: `git worktree lock` refuses an already-locked worktree.
    const entry = await worktreeEntry(primary, wt);
    expect(entry?.lockReason).toBe('writer=codex task=PRI-901-claim-renew');
  }, 120_000);

  it('refuses when a FOREIGN git lock occupies the slot, and rolls the lease back', async () => {
    const created = await makeSlot('claim-foreign-lock');
    const wt = created.worktree;
    // A lock naming a different writer, with no matching lease — e.g. a previous
    // session that died after locking.
    await git(primary, 'worktree', 'lock', '--reason', 'writer=trae task=PRI-999-someone-else', wt);

    const r = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'workbuddy', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { ok: boolean; error: string; nextAction: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('writer=trae task=PRI-999-someone-else');
    expect(out.nextAction).toContain('never unlocks a foreign claim');

    // Half-claim avoided: no lease was left behind, and the foreign lock stands.
    expect(fs.existsSync(path.join(wt, '.workspace-lease.json'))).toBe(false);
    expect((await worktreeEntry(primary, wt))?.locked).toBe(true);
  }, 120_000);

  it('refuses a DIFFERENT writer on an occupied slot', async () => {    const created = await makeSlot('claim-conflict');
    const wt = created.worktree;

    const first = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'trae', '--json'], { cwd: primary });
    expect(first.code).toBe(0);

    const second = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'zcode', '--json'], { cwd: primary });
    expect(second.code).toBe(1);
    const out = JSON.parse(second.stdout) as { ok: boolean; error: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain('trae');

    // The holder's lease is untouched.
    expect(leaseOf(wt).owner).toBe('trae:PRI-901-claim-conflict');
  }, 120_000);

  it('rejects an unknown writer label instead of inventing a second owner namespace', async () => {
    const created = await makeSlot('claim-badlabel');
    const r = await runDevScript('worktree-claim.mjs', [created.worktree, '--writer', 'some-ide', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.error).toContain('unknown writer label');
    for (const label of WRITER_LABELS) expect(out.nextAction).toContain(label);
  }, 120_000);

  it('refuses to claim the primary checkout (git-3)', async () => {
    const r = await runDevScript('worktree-claim.mjs', [primary, '--writer', 'human', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('PRIMARY');
  }, 60_000);

  it('refuses on a non-task branch — a work branch is not a claimable slot', async () => {
    const other = path.join(root, 'work-branch-slot');
    await git(primary, 'worktree', 'add', '-b', 'work/not-a-task', other);
    const r = await runDevScript('worktree-claim.mjs', [other, '--writer', 'human', '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string };
    expect(out.error).toContain('not a task branch');
  }, 60_000);
});

describe('writer release (git-11)', () => {
  it('releases both halves and is idempotent', async () => {
    const created = await makeSlot('release-basic');
    const wt = created.worktree;
    await runDevScript('worktree-claim.mjs', [wt, '--writer', 'human', '--json'], { cwd: primary });

    const first = await runDevScript('worktree-release.mjs', [wt, '--json'], { cwd: primary });
    expect(first.code).toBe(0);
    const out = JSON.parse(first.stdout) as { action: string; leaseRemoved: boolean; gitUnlocked: boolean };
    expect(out.action).toBe('released');
    expect(out.leaseRemoved).toBe(true);
    expect(out.gitUnlocked).toBe(true);
    expect(fs.existsSync(path.join(wt, '.workspace-lease.json'))).toBe(false);
    // Only THIS worktree is unlocked — sibling slots keep their own claims
    // (git worktree lock is per-worktree, and a substring check over the whole
    // list would pass for the wrong reason).
    const released = await worktreeEntry(primary, wt);
    expect(released?.locked ?? false).toBe(false);

    // Second release: a clean no-op, not an error.
    const second = await runDevScript('worktree-release.mjs', [wt, '--json'], { cwd: primary });
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as { action: string }).action).toBe('no-op');
  }, 120_000);

  it('refuses to "release" a directory that is no longer a resolvable worktree', async () => {
    // A residue shell: its admin metadata is gone, so it has no git view at all.
    // Its lease file is the last record of the task branch and must survive.
    const dir = path.join(root, 'principles-residue-release');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: ' + path.join(primary, '.git', 'worktrees', 'gone') + '\n', 'utf-8');
    fs.writeFileSync(
      path.join(dir, '.workspace-lease.json'),
      JSON.stringify(
        {
          schema: 'pd-workspace-lease/1',
          workspace: dir,
          owner: 'zcode:ai/PRI-777-lost',
          branch: 'ai/PRI-777-lost',
          createdAt: '2026-09-01T00:00:00.000Z',
          expiresAt: '2026-09-01T04:00:00.000Z',
        },
        null,
        2
      ),
      'utf-8'
    );

    const r = await runDevScript('worktree-release.mjs', [dir, '--json'], { cwd: primary });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as { error: string; nextAction: string };
    expect(out.nextAction).toContain('residue');
    // Evidence preserved.
    expect(fs.existsSync(path.join(dir, '.workspace-lease.json'))).toBe(true);
  }, 60_000);
});

describe('writer identity helpers', () => {
  it('round-trips owner strings and rejects non-writer owners', () => {
    expect(composeWriterOwner('codex', 'PRI-1-x')).toBe('codex:PRI-1-x');
    expect(parseWriterOwner('codex:PRI-1-x')).toEqual({ writer: 'codex', task: 'PRI-1-x' });
    expect(parseWriterOwner('agent-a/PRI-1')).toBeNull();
    expect(parseWriterOwner('nonsense:task')).toBeNull();
  });
});

describe('STALE_LOCK classification (SPEC §10.3)', () => {
  it('reports a lock whose writer lease is gone, and never proposes unlocking automatically', () => {
    const stale = classifyLockAgainstLease({ locked: true, leasePhase: 'expired', leaseOwner: 'zcode:PRI-1-x', path: 'X:/slot' });
    expect(stale.state).toBe('stale');
    expect(stale.detail).toContain('STALE_LOCK');
    // The recovery is a PRINTED command, not an action.
    expect(stale.nextAction).toContain('git worktree unlock');
  });

  it('treats an active writer as a normal lock, and no lock as none', () => {
    expect(classifyLockAgainstLease({ locked: true, leasePhase: 'active', leaseOwner: 'a', path: 'X' }).state).toBe('locked');
    expect(classifyLockAgainstLease({ locked: false, leasePhase: 'none', path: 'X' }).state).toBe('none');
  });
});
