// Workspace write lease — the cooperative write-intent guard for PD checkouts
// (AGENTS.md §23A, git-9-lease-before-write).
//
// Why this exists: the worktree-guard judges GIT state at commit/push time,
// but git cannot see filesystem mutation. During PRI-634-F a concurrent
// session wrote into an occupied checkout (stash pops, branch switches, file
// edits) and none of it touched a commit boundary until a UU conflict was
// already sitting in the working tree (PRI-663).
//
// The lease closes that gap at WRITE-INTENT time: a session acquires the
// lease before writing in a checkout; any other session that tries to
// acquire while it is active fails loudly with the holder's identity.
//
// Deliberate constraints — this is NOT a permission system:
//   - cooperative only: the lease is one plain JSON file a human may delete;
//   - worktree-local: one file per checkout, gitignored, never in CI;
//   - self-healing: leases expire (TTL) so a crashed holder never locks a
//     checkout forever;
//   - state does not depend on git (git cannot sense FS mutation), though
//     acquire records the branch so the commit-time guard can flag drift
//     (active lease + different checked-out branch = contamination signature).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const LEASE_FILENAME = '.workspace-lease.json';
export const LEASE_SCHEMA = 'pd-workspace-lease/1';
export const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4h — long enough for one
// working session, short enough that a crashed holder self-clears quickly.

export function leaseFilePath(root) {
  return path.join(root, LEASE_FILENAME);
}

/** A readable, unique-by-default owner string for the acquiring process. */
export function defaultOwner() {
  let user = 'unknown-user';
  try {
    user = os.userInfo().username;
  } catch {
    // userInfo can throw on exotic platforms — keep going with the fallback.
  }
  const host = os.hostname() || 'unknown-host';
  return user + '@' + host + ' pid=' + process.pid;
}

/**
 * Read and validate the lease file in `root`.
 * Returns one of:
 *   { exists: false }
 *   { exists: true, valid: false, error }          — present but malformed
 *   { exists: true, valid: true, lease }           — parsed lease record
 */
export function readLease(root) {
  const file = leaseFilePath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, valid: false, error: 'lease file is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { exists: true, valid: false, error: 'lease file is not a JSON object' };
  }
  if (parsed.schema !== LEASE_SCHEMA) {
    return { exists: true, valid: false, error: "unexpected schema '" + String(parsed.schema) + "' (expected " + LEASE_SCHEMA + ')' };
  }
  for (const field of ['workspace', 'owner', 'branch']) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      return { exists: true, valid: false, error: "field '" + field + "' must be a non-empty string" };
    }
  }
  for (const field of ['createdAt', 'expiresAt']) {
    if (typeof parsed[field] !== 'string' || Number.isNaN(Date.parse(parsed[field]))) {
      return { exists: true, valid: false, error: "field '" + field + "' must be an ISO date string" };
    }
  }
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)) {
    return { exists: true, valid: false, error: 'expiresAt must be after createdAt' };
  }
  return { exists: true, valid: true, lease: parsed };
}

/** 'active' | 'expired' — for a valid lease record. */
export function leasePhase(lease, now = Date.now()) {
  return Date.parse(lease.expiresAt) > now ? 'active' : 'expired';
}

function writeLease(root, lease) {
  fs.writeFileSync(leaseFilePath(root), JSON.stringify(lease, null, 2) + '\n', 'utf-8');
}

/**
 * Create the FIRST lease atomically: flag 'wx' (O_EXCL) makes the create
 * exclusive across processes, so of two racing acquires exactly one wins and
 * the loser re-reads the winner's ACTIVE lease and reports the conflict
 * instead of silently overwriting it. Renewal of an EXISTING lease keeps the
 * plain write (the holder already passed the same-owner check; a full
 * compare-and-swap protocol would exceed this tool's cooperative scope).
 */
function createLeaseAtomically(root, lease) {
  try {
    fs.writeFileSync(leaseFilePath(root), JSON.stringify(lease, null, 2) + '\n', { flag: 'wx' });
    return null;
  } catch (err) {
    if (err && err.code === 'EEXIST') return 'EEXIST';
    throw err;
  }
}

/**
 * Acquire (or renew) the write lease for `root`.
 * Succeeds when: no lease exists, the existing lease is expired, or the
 * existing ACTIVE lease has the same owner (renewal by the holding session).
 * Fails loudly when an ACTIVE lease is held by a different owner.
 */
export function acquireLease(root, { owner, branch, ttlMs = DEFAULT_TTL_MS, now = Date.now() }) {
  // Racing first-acquires are serialized by the exclusive create below: the
  // loser of the create re-reads and re-evaluates against the winner's lease.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = readLease(root);
    if (current.exists && !current.valid) {
      return {
        ok: false,
        error: 'existing lease file is invalid: ' + current.error,
        nextAction: 'Delete ' + leaseFilePath(root) + ' (or fix it) and retry.',
      };
    }
    if (current.exists && leasePhase(current.lease, now) === 'active' && current.lease.owner !== owner) {
      return {
        ok: false,
        error:
          'workspace is lease-locked by another writer:\n' +
          '    owner:     ' + current.lease.owner + '\n' +
          '    branch:    ' + current.lease.branch + '\n' +
          '    expiresAt: ' + current.lease.expiresAt,
        nextAction:
          'Do NOT write into this checkout (AGENTS.md §23A git-2). Coordinate with the holder, ' +
          'wait for expiry, or — if you are human and have confirmed the holder is gone — delete ' +
          leaseFilePath(root) + '. ' +
          'Note: the DEFAULT owner is per-process (includes the pid) — pass the same --owner you ' +
          'acquired with, or delete the lease file, when re-acquiring your own earlier session.',
        conflict: current.lease,
      };
    }
    const renewed = current.exists === true;
    const lease = {
      schema: LEASE_SCHEMA,
      workspace: root,
      owner,
      branch,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    if (!renewed) {
      const lostCreate = createLeaseAtomically(root, lease);
      if (lostCreate !== null) {
        continue; // A racing process created the lease first — re-read and re-evaluate.
      }
      return { ok: true, action: 'acquired', lease };
    }
    writeLease(root, lease);
    return { ok: true, action: 'renewed', lease };
  }
  // Unreachable in practice: three consecutive lost exclusive-creates mean
  // three processes raced within microseconds. Fail loud rather than loop.
  return {
    ok: false,
    error: 'could not acquire the lease: another process kept winning the exclusive create',
    nextAction: 'Re-run acquire — the winner is now the active holder you will conflict with loudly.',
  };
}

/** Release the lease (idempotent — releasing an unleased workspace is ok). */
export function releaseLease(root) {
  const file = leaseFilePath(root);
  let removed = false;
  try {
    fs.unlinkSync(file);
    removed = true;
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  return { ok: true, removed };
}

/**
 * Guard-side evaluation (check-dev-worktree.mjs). Never blocks on expiry —
 * an expired lease means its holder is gone; only structural drift fails:
 *   lease-invalid         — file present but malformed (tampering/garbage)
 *   lease-branch-mismatch — ACTIVE lease + a different branch checked out,
 *                           the exact PRI-663 contamination signature.
 */
export function evaluateLeaseForGuard(root, currentBranch) {
  const current = readLease(root);
  if (!current.exists) {
    return { violations: [], summary: { state: 'none', file: leaseFilePath(root) } };
  }
  if (!current.valid) {
    return {
      violations: [
        {
          rule: 'lease-invalid',
          message: 'The workspace lease file is malformed: ' + current.error,
          nextAction: 'Delete ' + leaseFilePath(root) + ' or re-acquire with: npm run dev:lease -- acquire',
        },
      ],
      summary: { state: 'invalid', file: leaseFilePath(root) },
    };
  }
  const phase = leasePhase(current.lease);
  const summary = {
    state: phase,
    owner: current.lease.owner,
    branch: current.lease.branch,
    expiresAt: current.lease.expiresAt,
    file: leaseFilePath(root),
  };
  if (phase === 'active' && currentBranch && current.lease.branch !== currentBranch) {
    return {
      violations: [
        {
          rule: 'lease-branch-mismatch',
          message:
            "An ACTIVE write lease is held by '" + current.lease.owner + "' for branch '" +
            current.lease.branch + "' but this checkout is on '" + currentBranch +
            "' — the branch was switched under a live writer (AGENTS.md §23A git-1/git-2).",
          nextAction:
            'Coordinate with the lease holder; if the holder is gone, delete ' + leaseFilePath(root) + '.',
        },
      ],
      summary,
    };
  }
  return { violations: [], summary };
}
