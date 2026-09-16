// PRI-796 round-2 review: the value of these tools is "multiple AI agents
// working at once", so the concurrency proof must be CROSS-PROCESS — real
// Node children racing through a start-file barrier, not an in-process
// Promise.all over helpers.
//
// Covered here:
//   1. mutation mutex: two processes acquire concurrently → exactly one wins
//      (the create-then-verify election of v2, under real OS scheduling);
//   2. writer claim: two processes claim the same stale/expired slot →
//      exactly one final owner;
//   3. release vs claim: the two transitions never interleave → the final
//      state is atomic: either fully unowned, or git lock + lease both naming
//      the same writer. The forbidden half-states are asserted away.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_SCRIPTS_DIR, makeTempDir, removeFixture, runDevScript, setupOriginFixture, worktreeEntry } from './dev-worktree-test-utils';

const MUTEX_MODULE_URL = pathToFileURL(path.join(DEV_SCRIPTS_DIR, 'lib', 'git-mutation-lock.mjs')).href;

let root: string;
let primary: string;

beforeAll(async () => {
  const fixture = await setupOriginFixture('pd-concurrency-test-');
  root = fixture.root;
  primary = fixture.primary;
});

afterAll(() => {
  removeFixture(root);
});

async function makeSlot(slug: string): Promise<{ worktree: string; branch: string }> {
  const r = await runDevScript('create-task-worktree.mjs', ['PRI-902', slug, '--skip-bootstrap', '--json'], { cwd: primary });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as { worktree: string; branch: string };
}

function leaseOf(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.workspace-lease.json'), 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Spawn two children that both busy-wait on `startFile`, then run.
 * The barrier is what turns sequential test code into an actual race.
 */
function writeRaceScript(file: string, body: string): string {
  fs.writeFileSync(
    file,
    [
      'import fs from "node:fs";',
      'const [,, startFile, ...argv] = process.argv;',
      'while (!fs.existsSync(startFile)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); }',
      body,
    ].join('\n'),
    'utf-8'
  );
  return file;
}

function racePair(scripts: string[], startDir: string): Promise<{ code: number; stdout: string; stderr: string }[]> {
  // A unique barrier file per race (a leftover from an earlier test would
  // release the next pair before both children spawn). The name is generated
  // here — never caller input — and bound-checked to the fixture root.
  const barrierName = 'GO-' + crypto.randomBytes(8).toString('hex');
  const barrierRoot = path.resolve(startDir) + path.sep;
  const startFile = path.resolve(startDir, barrierName);
  if (!startFile.startsWith(barrierRoot)) {
    throw new Error('fixture bug: barrier escaped the fixture root');
  }
  const children = scripts.map((script) =>
    import('node:child_process').then(
      ({ spawn }) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, [script, startFile], { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => { stdout += d; });
          child.stderr.on('data', (d) => { stderr += d; });
          child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        })
    )
  );
  // Release both children at once.
  fs.writeFileSync(startFile, 'go');
  return Promise.all(children);
}

describe('mutation mutex — real two-process race', () => {
  it('exactly one of two concurrent acquirers wins; the loser names the winner', async () => {
    const arena = makeTempDir('pd-mutex-race-');
    try {
      const body = (
        'const { acquireMutationLock } = await import(process.env.PD_MUTEX_MODULE);\n' +
        'const r = acquireMutationLock({ commonDir: process.env.PD_RACE_DIR, operation: "worktree-add", target: "race" });\n' +
        'if (!r.ok) { console.log("LOSE " + r.code + " " + (r.holder || "")); process.exit(0); }\n' +
        'console.log("WIN " + r.record.token);\n' +
        'setTimeout(() => { r.release(); process.exit(0); }, 800);'
      );
      const s1 = writeRaceScript(path.join(arena, 'racer-1.mjs'), body);
      const s2 = writeRaceScript(path.join(arena, 'racer-2.mjs'), body);
      const env = { PD_MUTEX_MODULE: MUTEX_MODULE_URL, PD_RACE_DIR: arena };
      // Both children read the env; embed via the script's own env — racePair
      // spawns with inherited env, so set it through process env here.
      process.env.PD_MUTEX_MODULE = MUTEX_MODULE_URL;
      process.env.PD_RACE_DIR = arena;
      try {
        const results = await racePair([s1, s2], arena);
        const all = results.map((r) => r.stdout);
        const winners = all.filter((o) => o.includes('WIN'));
        const losers = all.filter((o) => o.includes('LOSE'));
        // One of the two MUST win; the loser must never also win.
        expect(winners.length).toBe(1);
        expect(losers.length).toBe(1);
        // The loser's message identifies the winner by operation — an operator
        // can tell who to wait for.
        expect(losers[0]).toContain('worktree-add');
        // The winner's release freed the arena (both children exited).
        const after = (await import('../dev/lib/git-mutation-lock.mjs')).acquireMutationLock({ commonDir: arena, operation: 'after' });
        expect(after.ok).toBe(true);
        if (after.ok) after.release();
      } finally {
        delete process.env.PD_MUTEX_MODULE;
        delete process.env.PD_RACE_DIR;
        void env;
      }
    } finally {
      removeFixture(arena);
    }
  }, 90_000);
});

describe('writer claim — real two-process race (one final owner)', () => {
  it('two processes claiming a stale-expired slot end in exactly one owner', async () => {
    const created = await makeSlot('race-claim');
    const wt = created.worktree;
    // A departed third writer: expired lease, no git lock.
    fs.writeFileSync(
      path.join(wt, '.workspace-lease.json'),
      JSON.stringify({
        schema: 'pd-workspace-lease/1',
        workspace: wt,
        owner: 'trae:PRI-902-race-claim',
        branch: created.branch,
        claimId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      }, null, 2),
      'utf-8'
    );

    const script = (writer: string) =>
      writeRaceScript(
        path.join(root, 'claim-race-' + writer + '.mjs'),
        'const { spawnSync } = await import("node:child_process");\n' +
        'const r = spawnSync(process.execPath, ["' + path.join(DEV_SCRIPTS_DIR, 'worktree-claim.mjs').replaceAll('\\', '/') + '", "' + wt.replaceAll('\\', '/') + '", "--writer", "' + writer + '", "--json"], { cwd: "' + primary.replaceAll('\\', '/') + '", encoding: "utf-8" });\n' +
        'console.log("OUT:" + (r.stdout || "").trim());\n' +
        'process.exit(r.status ?? 1);'
      );
    const results = await racePair([script('codex'), script('zcode')], root);
    const oks = results.filter((r) => r.stdout.includes('"ok": true'));
    expect(oks.length).toBe(1);

    const lease = leaseOf(wt);
    expect(lease).not.toBeNull();
    const entry = await worktreeEntry(primary, wt);
    const winner = String(lease.owner).split(':')[0];
    // The final state is ONE era: git lock and lease name the same writer,
    // and the lease carries the claimId the winner minted.
    expect(entry?.locked).toBe(true);
    expect(entry?.lockReason).toBe('writer=' + winner + ' task=PRI-902-race-claim');
    expect(typeof lease.claimId).toBe('string');
  }, 180_000);
});

describe('release vs claim — the transition is atomic', () => {
  it('never leaves git-lock-without-lease or lease-without-lock', async () => {
    const created = await makeSlot('race-release');
    const wt = created.worktree;
    const claim = await runDevScript('worktree-claim.mjs', [wt, '--writer', 'workbuddy', '--json'], { cwd: primary });
    expect(claim.code).toBe(0);
    // Age the lease (keeping it structurally VALID) so the racing claimant is
    // legitimately eligible for a takeover — an INVALID lease would short-run
    // the claim at readLease instead of exercising the transition race.
    const lease = leaseOf(wt);
    lease.createdAt = '2020-01-01T00:00:00.000Z';
    lease.expiresAt = '2020-01-02T00:00:00.000Z';
    fs.writeFileSync(path.join(wt, '.workspace-lease.json'), JSON.stringify(lease, null, 2), 'utf-8');

    const releaser = writeRaceScript(
      path.join(root, 'release-racer.mjs'),
      'const { spawnSync } = await import("node:child_process");\n' +
      'const r = spawnSync(process.execPath, ["' + path.join(DEV_SCRIPTS_DIR, 'worktree-release.mjs').replaceAll('\\', '/') + '", "' + wt.replaceAll('\\', '/') + '", "--json"], { cwd: "' + primary.replaceAll('\\', '/') + '", encoding: "utf-8" });\n' +
      'console.log("REL:" + (r.stdout || "").trim());'
    );
    const claimer = writeRaceScript(
      path.join(root, 'claim-racer.mjs'),
      'const { spawnSync } = await import("node:child_process");\n' +
      'const r = spawnSync(process.execPath, ["' + path.join(DEV_SCRIPTS_DIR, 'worktree-claim.mjs').replaceAll('\\', '/') + '", "' + wt.replaceAll('\\', '/') + '", "--writer", "codex", "--json"], { cwd: "' + primary.replaceAll('\\', '/') + '", encoding: "utf-8" });\n' +
      'console.log("CLM:" + (r.stdout || "").trim());'
    );
    await racePair([releaser, claimer], root);

    // Whatever order the two transitions took, the END state is atomic:
    // both halves agree or neither exists. The forbidden half-state — git
    // lock held with no lease — is exactly what the mutex + claimId prevent.
    const entry = await worktreeEntry(primary, wt);
    const after = leaseOf(wt);
    if (entry?.locked) {
      expect(after, 'git lock present requires a lease present').not.toBeNull();
      const winner = String(after.owner).split(':')[0];
      expect(entry.lockReason).toBe('writer=' + winner + ' task=PRI-902-race-release');
    } else {
      expect(after, 'no git lock may not coexist with a writer lease').toBeNull();
    }
  }, 180_000);

  it('an old releaser that bypasses the transition order cannot delete a successor-era lease', () => {
    // Unit half of the same invariant, with the mutex deliberately NOT
    // involved: conditional release by claimId. This is the "loser/old
    // releaser cannot delete successor lease" contract.
    return import('../dev/lib/workspace-lease.mjs').then(({ acquireLease, releaseLease, readLease }) => {
      const dir = makeTempDir('pd-lease-era-');
      try {
        const a = acquireLease(dir, { owner: 'codex:PRI-902-era', branch: 'ai/PRI-902-era' });
        expect(a.ok).toBe(true);
        const aClaimId = readLease(dir).lease.claimId;

      // Successor era: same owner after expiry is a NEW acquisition.
      const cur = readLease(dir).lease;
      cur.createdAt = '2020-01-01T00:00:00.000Z';
      cur.expiresAt = '2020-01-02T00:00:00.000Z';
      fs.writeFileSync(path.join(dir, '.workspace-lease.json'), JSON.stringify(cur, null, 2), 'utf-8');
        const b = acquireLease(dir, { owner: 'codex:PRI-902-era', branch: 'ai/PRI-902-era', now: Date.now() });
        expect(b.ok).toBe(true);
        const bClaimId = readLease(dir).lease.claimId;
        expect(bClaimId).not.toBe(aClaimId);

        // The straggler's old release.
        const r = releaseLease(dir, { expectedClaimId: aClaimId });
        expect(r.removed).toBe(false);
        expect(r.reason).toBe('ownership-changed');
        expect(readLease(dir).exists).toBe(true);

        // The holder's own release works.
        const ok = releaseLease(dir, { expectedClaimId: bClaimId });
        expect(ok.removed).toBe(true);
        expect(readLease(dir).exists).toBe(false);
      } finally {
        removeFixture(dir);
      }
    });
  });
});
