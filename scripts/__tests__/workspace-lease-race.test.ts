// PRI-728 regression: a racing acquire LOSER must report the winner's
// conflict ("lease-locked by another writer"), never the transient
// "existing lease file is invalid: lease file is not valid JSON" that CI
// observed on PR #1600 — the loser re-read the lease file while the winner
// was mid-write and misparsed a truncated prefix as corruption.
//
// The real first-create window is sub-millisecond, so it cannot be staged
// deterministically through the CLI. These cases drive acquireLease directly
// with an injected retry delay that performs the winner's write mid-race —
// the exact interleaving CI hit. The two-real-CLI-process canary stays in
// workspace-lease.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEASE_FILENAME, acquireLease } from '../dev/lib/workspace-lease.mjs';
import { makeTempDir, removeFixture } from './dev-worktree-test-utils';

let root: string;

beforeEach(() => {
  root = makeTempDir('pd-lease-race-');
});

afterEach(() => {
  removeFixture(root);
});

function leasePath(dir: string): string {
  return path.join(dir, LEASE_FILENAME);
}

function winnerLeaseJson(dir: string, owner: string): string {
  return (
    JSON.stringify(
      {
        schema: 'pd-workspace-lease/1',
        workspace: dir,
        owner,
        branch: 'work/race',
        createdAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      null,
      2,
    ) + '\n'
  );
}

describe('acquire vs an in-flight lease write (PRI-728)', () => {
  it('loser re-reads past the winner mid-write and reports the conflict, not invalid-JSON', () => {
    // Stage the exact mid-write observation: the loser's first read sees a
    // truncated prefix of the winner's lease (what a non-atomic write exposes
    // between exclusive create and content flush).
    const winnerJson = winnerLeaseJson(root, 'agent-a/PRI-1');
    fs.writeFileSync(leasePath(root), winnerJson.slice(0, Math.floor(winnerJson.length / 2)), 'utf-8');

    let delayCalls = 0;
    const result = acquireLease(root, {
      owner: 'agent-b/PRI-2',
      branch: 'work/race',
      readRetryDelayFn: () => {
        delayCalls++;
        // The winner's write completes inside the loser's retry window.
        if (delayCalls === 1) fs.writeFileSync(leasePath(root), winnerJson, 'utf-8');
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('lease-locked by another writer');
      expect(result.conflict).toMatchObject({ owner: 'agent-a/PRI-1' });
    }
    expect(delayCalls).toBe(1);
  });

  it('a lease file that never becomes valid still fails loud after bounded retries', () => {
    fs.writeFileSync(leasePath(root), '{"schema": "pd-wor', 'utf-8');

    let delayCalls = 0;
    const result = acquireLease(root, {
      owner: 'agent-b/PRI-2',
      branch: 'work/race',
      readRetryDelayFn: () => {
        delayCalls++;
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('existing lease file is invalid: lease file is not valid JSON');
    }
    // Bounded, not an infinite loop: exactly LEASE_READ_RETRY_ATTEMPTS (3)
    // re-reads before the loud invalid-lease verdict.
    expect(delayCalls).toBe(3);
  });

  it('renewal writes go through temp+rename and leave no temp files behind', () => {
    const first = acquireLease(root, { owner: 'solo/session', branch: 'work/renew' });
    expect(first.ok).toBe(true);

    // First create uses the exclusive wx path (no rename); renewal must go
    // through an atomic temp+rename — assert the mechanism itself, not just
    // the absence of temp leftovers (PRI-728 review round).
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      const renewed = acquireLease(root, { owner: 'solo/session', branch: 'work/renew' });
      expect(renewed.ok).toBe(true);

      expect(renameSpy).toHaveBeenCalledTimes(1);
      const [from, to] = renameSpy.mock.calls[0];
      expect(String(from)).toContain('.tmp-');
      expect(String(to)).toBe(leasePath(root));
    } finally {
      renameSpy.mockRestore();
    }

    const entries = fs.readdirSync(root);
    expect(entries).toContain(LEASE_FILENAME);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });
});
