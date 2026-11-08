// Safely remove a completed task worktree (AGENTS.md §23A, git-8-cleanup-after-merge).
//
// Never destroys unknown work (git-4): a dirty worktree, an unproven task
// branch, an active writer, or the primary checkout all cause a refusal — this
// tool never resets, cleans, stashes, or force-deletes anything with unreviewed
// content.
//
// Completion proof (git-8 / PRI-796 SPEC §13): GitHub `PR MERGED` is consulted
// FIRST because it is the only evidence that covers squash merges (where the
// branch tip can never be an ancestor of origin/main); ancestry is the fallback
// when GitHub is unavailable. A clean-but-unproven worktree is REFUSED —
// removing it would destroy another agent's working directory even though no
// code would be lost.
//
// PRI-796 additions, all of them REFUSALS (SPEC §14, §14.1-§14.3):
//   * an ACTIVE write lease -> refuse, identical to the batch sweep's behaviour;
//   * a Git-locked worktree -> refuse, and NEVER auto-unlock first (unlocking is
//     the first step of destroying a claim, so it is a human decision);
//   * a PR still OPEN -> refuse, because a review in flight outranks any
//     ancestry that happens to be present;
//   * removal, branch deletion and prune all run under the repo mutation mutex,
//     because each writes shared Git metadata.
//
// Usage:
//   node scripts/dev/cleanup-task-worktree.mjs <branch-or-path> [--delete-branch] [--skip-gh] [--detach-external-links] [--json]
//   npm run dev:worktree:cleanup -- ai/PRI-123-some-task
//
// ERR-098 / PRI-1143 — `git worktree remove` is NOT junction-safe on Windows.
// The recurrence OCC-20261106T025529Z-g9kvsgn43c proved it: two MERGED worktrees
// held junctions (gitignored fixtures) pointing at the real global OpenClaw
// install, git recursed through them on the FIRST non-forced removal, and deleted
// files outside the worktree until MAX_PATH stopped it. So no removal runs without
// a reparse-point preflight: any link whose target lies outside the worktree is a
// REFUSAL, unless --detach-external-links explicitly detaches those links first
// (detaching removes only the link, never the target). A single retry with one
// --force is allowed ONLY after the porcelain-clean check passed and no external
// link remains, so the only thing it can override is ignored build output
// (node_modules). Double --force is never used. Scan, decision and removal share
// one mutation-lock span; every external target is fingerprinted before and after
// (not merely checked for existence — the incident deleted files INSIDE a target
// that was still present), and internal links are detached too, because git can
// report exit 0 while leaving a junction directory behind.

import fs from 'node:fs';
import path from 'node:path';
import {
  assessWorktreePruneSafety,
  gitCommonDirAbsolute,
  listWorktrees,
  normalizeGitPath,
  runGit,
} from './lib/git.mjs';
import { collectPrIndex, readLeaseState } from './lib/workspace-lifecycle.mjs';
import { withMutationLock } from './lib/git-mutation-lock.mjs';
import { classifyReparsePoints, detachExternalLinks, detachInternalLinks, REMOVAL_REASONS } from './lib/residue-delete.mjs';
import { CODES } from './lib/preflight.mjs';

function parseArgs(argv) {
  const args = { target: null, deleteBranch: false, skipGh: false, json: false, detachExternalLinks: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--delete-branch') args.deleteBranch = true;
    else if (arg === '--skip-gh') args.skipGh = true;
    else if (arg === '--detach-external-links') args.detachExternalLinks = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/dev/cleanup-task-worktree.mjs <branch-or-path> [--delete-branch] [--skip-gh] [--detach-external-links] [--json]'
      );
      console.log('  --detach-external-links   detach junctions/symlinks that point outside the worktree, then remove it.');
      console.log('                            Without it, such a worktree is REFUSED (ERR-098: git follows those links).');
      process.exit(0);
    } else if (args.target === null) {
      args.target = arg;
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  if (!args.target) {
    console.error('Usage: node scripts/dev/cleanup-task-worktree.mjs <branch-or-path> [--delete-branch] [--skip-gh] [--detach-external-links] [--json]');
    process.exit(2);
  }
  return args;
}

/** A failure already reported by fail(); the top-level handler must stay silent. */
class ReportedFailure extends Error {}

/** A refusal raised INSIDE the mutation lock, so the lock can unwind first. */
class PreflightRefusal extends Error {
  constructor(message, nextAction, payload) {
    super(message);
    this.name = 'PreflightRefusal';
    this.nextAction = nextAction;
    this.payload = payload || {};
  }
}

function fail(args, code, message, nextAction, extra) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, code, error: message, nextAction, ...(extra || {}) }, null, 2));
  } else {
    console.error('[cleanup-task-worktree] FAIL (' + code + '): ' + message);
    if (nextAction) console.error('  next: ' + nextAction);
  }
  process.exit(1);
  // cli-2: never rely on process.exit() alone. If it is stubbed (tests) or this
  // function is wrapped later, execution must NOT continue into the deletion.
  throw new ReportedFailure('fail() reported: ' + code);
}

/** Paths containing shell metacharacters are never inlined into a paste-ready command. */
const UNSAFE_SHELL_CHARS = /["&|%!^<>$`'\r\n]/;
// On POSIX a trailing backslash escapes the closing quote of a double-quoted
// argument; on Windows it is an ordinary path separator.
const UNSAFE_POSIX_PATH_CHARS = /[\\"&|%!^<>$`'\r\n]/;
function shellPath(p) {
  const unsafe = process.platform === 'win32' ? UNSAFE_SHELL_CHARS : UNSAFE_POSIX_PATH_CHARS;
  return unsafe.test(p) ? '"<copy path from JSON output; it contains shell metacharacters>"' : '"' + p + '"';
}

/** Format the first few unsafe links so the operator sees the danger, not a count. */
function describeLinks(links, limit = 8) {
  return links
    .slice(0, limit)
    .map(
      (l) =>
        '    ' + l.path + '  ->  ' + (l.target || '<unreadable target>') +
        '  [' + (l.unsafeReason || 'outside') + ']' +
        (l.targetExists ? '' : '  [target missing]')
    )
    .join('\n') + (links.length > limit ? '\n    …and ' + (links.length - limit) + ' more' : '');
}

/**
 * Content-level fingerprint of an external target. The 2026-11-06 incident
 * deleted FILES INSIDE the target while leaving the directory itself in place,
 * so `existsSync` alone would have reported success. Relative path + byte size
 * detects that shape without hashing every byte of a large install.
 */
function fingerprintExternalTarget(dir) {
  const rows = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      rows.push('UNREADABLE:' + path.relative(dir, current));
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        rows.push('d:' + rel);
        walk(full);
      } else if (entry.isSymbolicLink()) {
        rows.push('l:' + rel);
      } else {
        let size = -1;
        try { size = fs.statSync(full).size; } catch { /* unreadable file */ }
        rows.push('f:' + rel + ':' + size);
      }
    }
  };
  walk(dir);
  return rows.sort().join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  const worktrees = await listWorktrees(cwd);
  const primary = worktrees.find((w) => !w.bare);
  if (!primary) {
    fail(args, CODES.ENVIRONMENT_INVALID, 'Could not identify the primary worktree.', 'Run from any worktree of the PD repository.');
  }

  // Resolve the target: exact path match, or the worktree whose checked-out
  // branch matches (accept both 'ai/foo' and 'refs/heads/ai/foo').
  const target = worktrees.find(
    (w) =>
      normalizeGitPath(w.path, cwd) === normalizeGitPath(args.target, cwd) ||
      w.branch === args.target ||
      w.branch === 'refs/heads/' + args.target
  );

  const branchName = target && target.branch ? target.branch.replace(/^refs\/heads\//, '') : args.target.replace(/^refs\/heads\//, '');
  const branchExists =
    (await runGit(['rev-parse', '--verify', 'refs/heads/' + branchName], { cwd, allowFailure: true })) !== null;

  if (!target && !branchExists) {
    fail(
      args,
      CODES.CHECK_FAILED,
      "No worktree or branch matches '" + args.target + "'.",
      'List tasks with: npm run dev:workspace:snapshot'
    );
  }

  if (target && normalizeGitPath(target.path, cwd) === normalizeGitPath(primary.path, cwd)) {
    fail(
      args,
      CODES.CHECK_FAILED,
      'Refusing to remove the PRIMARY worktree (' + primary.path + ').',
      'The primary checkout is the repository control plane.'
    );
  }

  const notes = [];

  // ---- PRI-796 §14.3: a Git-locked worktree is REFUSED, never auto-unlocked ----
  if (target && target.locked) {
    fail(
      args,
      CODES.CHECK_FAILED,
      'The worktree is held by a Git worktree lock' + (target.lockReason ? ' (' + target.lockReason + ')' : '') + ' — refusing to remove it.',
      'A lock means an active writer claimed this slot. If that writer is gone, release it deliberately first: ' +
        'npm run dev:worktree:release -- "' + target.path + '"   (or: git worktree unlock "' + target.path + '"). ' +
        'This tool never unlocks a claim for you.'
    );
  }

  // ---- PRI-796 §14.2: an ACTIVE write lease is REFUSED (batch-sweep parity) ----
  if (target) {
    const lease = readLeaseState(target.path);
    if (lease.phase === 'active') {
      fail(
        args,
        CODES.CHECK_FAILED,
        'An ACTIVE write lease is held' + (lease.owner ? ' by ' + lease.owner : '') + ' — refusing to remove this worktree.',
        'Coordinate with the holder, wait for expiry, or release it explicitly: npm run dev:worktree:release -- "' + target.path + '"'
      );
    }
    if (lease.phase === 'invalid') {
      fail(
        args,
        CODES.CHECK_FAILED,
        'The workspace lease file is unreadable — refusing to remove a worktree whose writer state cannot be established.',
        'Inspect ' + target.path + '/.workspace-lease.json and remove it yourself if it is garbage.'
      );
    }
    if (lease.phase === 'expired') {
      notes.push('an expired write lease was present' + (lease.owner ? ' (last writer ' + lease.owner + ')' : ''));
    }
  }

  // ---- Completion proof BEFORE any mutation (fail loud, nothing destroyed) ----
  const refreshed = await runGit(['fetch', 'origin', '--prune'], { cwd, allowFailure: true });
  if (refreshed === null) {
    notes.push('origin refresh failed — merge proof uses the cached origin/main (run git fetch origin and retry for a fresh verdict)');
  }
  const mainSha = (await runGit(['rev-parse', '--verify', 'origin/main^{commit}'], { cwd, allowFailure: true }))?.trim();
  if (!mainSha) {
    fail(
      args,
      CODES.ENVIRONMENT_INVALID,
      'Merge completion proof requires a resolvable origin/main.',
      'git fetch origin and retry, or remove the worktree manually after confirming its PR is merged/closed.'
    );
  }
  if (!branchExists) {
    notes.push("branch '" + branchName + "' does not exist — completion can only be judged from the worktree itself");
  }

  const gh = args.skipGh ? { available: false, merged: new Map(), open: new Map() } : await collectPrIndex(cwd);
  if (!gh.available) notes.push('GitHub PR evidence unavailable — completion proof uses git ancestry only');

  const pr = gh.open.get(branchName) || gh.merged.get(branchName) || null;
  if (pr && pr.state === 'OPEN') {
    fail(
      args,
      CODES.CHECK_FAILED,
      'PR #' + pr.number + ' is still OPEN — a review in flight is never swept, even when the branch already reaches origin/main.',
      'Wait for the PR to be merged or closed, or close it deliberately first.'
    );
  }

  const ancestry =
    branchExists && (await runGit(['merge-base', '--is-ancestor', branchName, 'origin/main'], { cwd, allowFailure: true })) !== null;
  const prMerged = Boolean(pr && pr.state === 'MERGED');

  if (!prMerged && !ancestry) {
    const why =
      pr && pr.state === 'CLOSED' ? 'PR #' + pr.number + ' is CLOSED without being merged' : 'its PR could not be confirmed as MERGED';
    fail(
      args,
      CODES.CHECK_FAILED,
      "Branch '" + branchName + "' is NOT an ancestor of origin/main and " + why + ' — cannot prove the task completed. Worktree was not removed.',
      'Confirm the PR is closed/squash-merged, then remove manually: git worktree remove ' +
        (target ? target.path : '<worktree-path>') +
        '. (A squash-merged branch can never be an ancestor — the PR MERGED evidence above is authoritative.)'
    );
  }
  notes.push(prMerged ? 'completion proven by PR #' + pr.number + ' MERGED' : 'completion proven by ancestry to origin/main');

  const commonDir = await gitCommonDirAbsolute(cwd);

  let removedWorktree = null;
  let deletedBranch = null;
  let detachedLinks = [];

  // ---- Removal + branch deletion: the shared-Git-metadata mutations ----
  if (target) {
    const status = await runGit(['status', '--porcelain'], { cwd: target.path, allowFailure: true });
    if (status === null) {
      fail(args, CODES.CHECK_FAILED, 'Could not inspect worktree status: ' + target.path, 'Run git status there manually.');
    }
    if (status.trim().length > 0) {
      const preview = status
        .split(/\r?\n/)
        .slice(0, 5)
        .map((l) => '    ' + l)
        .join('\n');
      fail(
        args,
        CODES.CHECK_FAILED,
        'Worktree has uncommitted or untracked files — refusing to destroy unknown work:\n' + preview,
        'Review and commit (WIP commit is fine) or remove the files yourself; then retry cleanup.'
      );
    }

    // ---- ERR-098 preflight: SCAN, DECIDE and DELETE under ONE exclusive lock ----
    // CodeRabbit / PRI-1143 review: a scan outside the lock leaves an ownership
    // gap — an editor, installer or CI job can create a junction after the scan
    // and before git recurses into the tree. The whole span now runs inside
    // withMutationLock. The lock is held for a read-only directory walk plus one
    // git command, never across an install/build/test run (git-12).
    //
    // Nothing inside the lock calls fail(): it calls process.exit, which would
    // skip the lock's finally and leave a stale claim. Refusals are thrown out
    // and reported only after the lock has been released.
    let detached = null;
    let targetSnapshots = [];
    try {
      await withMutationLock({ commonDir, operation: 'worktree-remove', target: target.path }, async () => {
        // Re-check ownership INSIDE the lock, immediately before any mutation.
        const liveLease = readLeaseState(target.path);
        if (liveLease.phase === 'active' || liveLease.phase === 'invalid') {
          throw new PreflightRefusal(
            'A write lease became ' + liveLease.phase + ' after the pre-lock check; refusing to detach links or remove the worktree.',
            'Coordinate with the lease holder and retry once it is released.',
            { reason: REMOVAL_REASONS.OWNERSHIP_CHANGED, leasePhase: liveLease.phase }
          );
        }
        const liveList = await listWorktrees(cwd);
        const liveEntry = liveList.find((w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(target.path, cwd));
        if (liveEntry && liveEntry.locked) {
          throw new PreflightRefusal(
            'The worktree became Git-locked after the pre-lock check; refusing to detach links or remove it.',
            'Release the claim deliberately, then retry.',
            { reason: REMOVAL_REASONS.OWNERSHIP_CHANGED }
          );
        }
        const linkScan = classifyReparsePoints(target.path);

        if (!linkScan.complete) {
          throw new PreflightRefusal(
            'The reparse-point scan could NOT prove the whole worktree is readable; ' +
              linkScan.unreadable.length +
              ' directory/directories could not be enumerated. An unreadable directory may hide a junction pointing outside the tree (ERR-098), so nothing was removed:\n' +
              linkScan.unreadable.slice(0, 8).map((u) => '    ' + u.path + ' — ' + u.error).join('\n'),
            'Fix the permission or long-path problem and retry. Never fall back to a recursive delete or a bare `git worktree remove`.',
            {
              reason: REMOVAL_REASONS.SCAN_INCOMPLETE,
              unreadable: linkScan.unreadable.slice(0, 20),
              externalLinks: linkScan.external.slice(0, 20),
            }
          );
        }

        if (linkScan.external.length > 0 && !args.detachExternalLinks) {
          throw new PreflightRefusal(
            'The worktree holds ' +
              linkScan.external.length +
              ' reparse point(s) the deleter must not traverse (target OUTSIDE the tree, unresolvable, non-lexical or cyclic). `git worktree remove` recurses through such links (ERR-098), which would delete files this worktree has no claim on. Nothing was removed:\n' +
              describeLinks(linkScan.external),
            'Detach them yourself — removing a link never touches its target — then retry. On Windows a directory junction detaches with: cmd /c rmdir ' +
              shellPath(linkScan.external[0].path) +
              '   (or pass --detach-external-links to let this tool detach exactly these links and re-verify each target). Every path is also listed in `externalLinks`.',
            {
              reason: REMOVAL_REASONS.EXTERNAL_LINKS_PRESENT,
              externalLinks: linkScan.external.slice(0, 20),
              externalLinkCount: linkScan.external.length,
            }
          );
        }

        if (linkScan.external.length > 0) {
          detached = detachExternalLinks(target.path);
          detachedLinks = detached.detached;
          if (detached.brokenTargets.length > 0) {
            throw new PreflightRefusal(
              'Detaching an unsafe reparse point destroyed its target — the link WAS followed. Nothing more was removed:\n' +
                detached.brokenTargets.map((b) => '    ' + b.path + '  ->  ' + b.target).join('\n'),
              'Restore the target from a backup or its package tarball before continuing, then re-run: npm run check:error-handbook',
              {
                reason: REMOVAL_REASONS.EXTERNAL_TARGET_LOST,
                detachedLinks: detached.detached,
                brokenTargets: detached.brokenTargets,
              }
            );
          }
          if (!detached.ok) {
            throw new PreflightRefusal(
              'Could not detach every unsafe reparse point; refusing to hand this tree to git:\n' +
                detached.failedToDetach.map((f) => '    unlink failed: ' + f.path + ' — ' + f.error).join('\n') +
                (detached.remainingExternal.length > 0 ? '\n' + describeLinks(detached.remainingExternal) : '') +
                (detached.unreadable.length > 0
                  ? '\n' + detached.unreadable.slice(0, 8).map((u) => '    unreadable: ' + u.path).join('\n')
                  : ''),
              'Remove the leftovers manually (removing a link never touches its target), then retry. Do NOT fall back to a recursive delete.',
              {
                reason: detached.complete ? REMOVAL_REASONS.EXTERNAL_LINKS_PRESENT : REMOVAL_REASONS.SCAN_INCOMPLETE,
                detachedLinks: detached.detached,
                remainingExternal: detached.remainingExternal,
                unreadable: detached.unreadable,
              }
            );
          }
          notes.push(
            'detached ' + detached.detached.length + ' unsafe reparse point(s) before removal; every target re-verified present (ERR-098)'
          );
        }
        // git must not traverse ANY reparse point, not even one proven internal:
        // on Windows it can return exit 0 and still leave the junction directory
        // (and its parent) behind — a NO_GIT_MARKER residue shell. Detach
        // internal links unconditionally; their targets die with the tree anyway.
        if (linkScan.internal.length > 0) {
          const internal = detachInternalLinks(target.path);
          if (!internal.ok) {
            throw new PreflightRefusal(
              'Could not detach every internal reparse point; refusing to let git traverse a link:\n' +
                internal.failedToDetach.map((f) => '    unlink failed: ' + f.path + ' — ' + f.error).join('\n') +
                '\n    remaining links: ' + internal.remainingLinks,
              'Resolve the unreadable/undetachable link, then retry. Never fall back to a recursive delete.',
              {
                reason: internal.complete ? REMOVAL_REASONS.EXTERNAL_LINKS_PRESENT : REMOVAL_REASONS.SCAN_INCOMPLETE,
                internalLinks: linkScan.internal.slice(0, 20),
              }
            );
          }
          notes.push(
            'detached ' + internal.detached.length + ' internal reparse point(s) before removal so git never traverses a link'
          );
        }

        // Snapshot EVERY external target before deletion, remembering which ones
        // existed. A dangling link must not be reported as "lost" afterwards
        // (CodeRabbit), and existsSync alone cannot detect the 2026-11-06 shape
        // where files INSIDE the target were deleted while the directory stayed.
        targetSnapshots = linkScan.external
          // Only targets genuinely OUTSIDE the tree. A cyclic link points at the
          // worktree itself, which is expected to disappear with it.
          .filter((l) => l.canonicalTarget && l.unsafeReason === 'outside')
          .map((l) => {
            const existedBefore = fs.existsSync(l.canonicalTarget);
            return {
              path: l.canonicalTarget,
              existedBefore,
              fingerprint: existedBefore ? fingerprintExternalTarget(l.canonicalTarget) : null,
            };
          });

        let removeError = '';
        try {
          await runGit(['worktree', 'remove', target.path], { cwd });
        } catch (err) {
          removeError = err && err.message ? err.message : String(err);
        }
        if (removeError) {
          // Never force past a NEW untracked file created after our first
          // porcelain check: re-prove cleanliness, or stop instead of retrying.
          const freshStatus = await runGit(['status', '--porcelain'], { cwd: target.path, allowFailure: true });
          if (freshStatus === null || freshStatus.trim().length > 0) {
            const changed = new Error(
              'git worktree remove refused and the worktree changed during the run (porcelain no longer clean); NOT retrying with --force'
            );
            changed.reason = REMOVAL_REASONS.REMOVAL_FAILED;
            throw changed;
          }
          await runGit(['worktree', 'remove', '--force', target.path], { cwd });
          notes.push('removal needed one --force pass for ignored build output (porcelain was clean)');
        }

        // git can report success while a junction-derived directory survives.
        if (fs.existsSync(target.path)) {
          const residueError = new Error(
            'git worktree remove returned success but ' + target.path + ' is still on disk — this is a NO_GIT_MARKER residue shell'
          );
          residueError.reason = REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL;
          throw residueError;
        }
        removedWorktree = target.path;
      });
    } catch (err) {
      if (err instanceof PreflightRefusal) {
        fail(args, CODES.CHECK_FAILED, err.message, err.nextAction, err.payload);
        return;
      }
      if (err && err.reason === REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL) {
        fail(
          args,
          CODES.CHECK_FAILED,
          String(err.message),
          'Do NOT delete it with a recursive delete. The junction-safe, explicitly acked residue path is the only authorised removal: npm run dev:workspace:cleanup -- --residue ' +
            shellPath(target.path) +
            ' --ack-unknown --apply . NOTE: --residue only accepts shells the tool discovered inside its pool roots; an OUT-OF-POOL worktree is not discoverable and re-running the snapshot does not change that. This PR deliberately adds no bypass — preserve the directory and escalate for an Owner decision. Never weaken the discovery or --ack-unknown gates.',
          { reason: REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL, removedWorktree: null }
        );
        return;
      }
      if (err && err.code === 'GIT_MUTATION_LOCKED') {
        fail(
          args,
          CODES.CHECK_FAILED,
          'The exclusive Git mutation lock could not be acquired; no scan or removal ran:\n' + (err.message || String(err)),
          (err.nextAction || 'Retry once the other writer has released its claim.') +
            ' Never remove the worktree by hand: a manual `git worktree remove` skips the ERR-098 preflight.',
          { reason: REMOVAL_REASONS.MUTATION_LOCK_UNAVAILABLE, holder: err.holder || null }
        );
        return;
      }
      // Did the failure leave a directory git no longer has admin metadata for?
      // That is a NO_GIT_MARKER residue shell (git-14): unprovable dirtiness, so
      // only the explicitly acked residue path may delete it.
      let stillRegistered = false;
      try {
        const stillListed = await listWorktrees(cwd);
        stillRegistered = stillListed.some(
          (w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(target.path, cwd)
        );
      } catch {
        /* the original failure is the useful signal */
      }
      const shellRemains = fs.existsSync(target.path) && !stillRegistered;
      fail(
        args,
        CODES.CHECK_FAILED,
        'git worktree remove failed (porcelain was clean, preflight proved no unsafe reparse point):\n' +
          (err && err.message ? err.message : String(err)) +
          (shellRemains
            ? '\n' + target.path + ' is still on disk but git has no admin metadata for it any more: it is now a NO_GIT_MARKER residue shell.'
            : ''),
        shellRemains
          ? 'Do NOT delete it with a recursive delete. The junction-safe residue path is the only authorised removal: npm run dev:workspace:cleanup -- --residue ' +
            shellPath(target.path) +
            ' --ack-unknown --apply . NOTE: --residue only accepts shells the tool discovered inside its pool roots; an OUT-OF-POOL worktree is not discoverable and re-running the snapshot does not change that. This PR deliberately adds no bypass — preserve the directory and escalate for an Owner decision. Never weaken the discovery or --ack-unknown gates.'
          : 'Do NOT retry with a bare `git worktree remove` — it skips the ERR-098 preflight. Re-run npm run dev:worktree:cleanup -- ' +
            shellPath(args.target) + ' after resolving the error above.',
        {
          reason: shellRemains ? REMOVAL_REASONS.REMOVAL_FAILED_RESIDUE_SHELL : REMOVAL_REASONS.REMOVAL_FAILED,
          ...(detached ? { detachedLinks } : {}),
        }
      );
    }

    // Tripwire: git removed the tree — did every external target survive WHOLE?
    if (removedWorktree && targetSnapshots.length > 0) {
      const lost = targetSnapshots
        .filter((s) => s.existedBefore && (!fs.existsSync(s.path) || fingerprintExternalTarget(s.path) !== s.fingerprint))
        .map((s) => s.path);
      if (lost.length > 0) {
        fail(
          args,
          CODES.CHECK_FAILED,
          'The worktree is gone, but ' +
            lost.length +
            ' external target(s) of reparse points inside it disappeared or changed — something traversed a link:\n' +
            lost.map((t) => '    ' + t).join('\n'),
          'Restore them (npm pack <pkg> + sha512 check is how the 2026-11-06 incident was repaired) before running anything else.',
          { reason: REMOVAL_REASONS.EXTERNAL_TARGET_LOST, removedWorktree, lostTargets: lost, detachedLinks }
        );
      }
    }
  }

  if (args.deleteBranch && branchExists) {
    try {
      await withMutationLock({ commonDir, operation: 'branch-delete', target: branchName }, async () => {
        // Completion was already proven above; -d still refuses when the branch
        // is not merged into the CURRENT head, so fall back to -D with the
        // recorded justification (same behaviour as before PRI-796).
        try {
          await runGit(['branch', '-d', branchName], { cwd });
        } catch {
          await runGit(['branch', '-D', branchName], { cwd });
          notes.push('-d refused (not merged into current HEAD); -D used after proving completion');
        }
        deletedBranch = branchName;
      });
    } catch (err) {
      fail(
        args,
        CODES.CHECK_FAILED,
        "git branch delete failed for '" + branchName + "' (completion was already proven):\n" + (err && err.message ? err.message : String(err)),
        'Delete manually: git branch -D ' + branchName
      );
    }
  }

  // PRI-712: the global prune drops admin metadata of worktrees whose directory
  // git believes is gone — but a Windows lock race can make a LIVE worktree
  // transiently unreadable and get it misclassified as missing. Prune runs only
  // when every existing-dir worktree probes clean; otherwise it is skipped with
  // a note (prune is an opportunistic optimization).
  const pruneSafety = await assessWorktreePruneSafety(cwd);
  let pruned = false;
  if (pruneSafety.safe) {
    try {
      await withMutationLock({ commonDir, operation: 'worktree-prune', target: 'global' }, async () => {
        await runGit(['worktree', 'prune'], { cwd, allowFailure: true });
      });
      pruned = true;
    } catch (err) {
      notes.push('global prune skipped: ' + (err && err.message ? err.message : String(err)));
    }
  } else {
    const detail = pruneSafety.blocked.map((b) => b.path + ' (' + b.reason + ')').join(', ');
    notes.push('skipped global worktree prune — live worktrees with unknown work must not risk metadata loss: ' + detail);
  }

  const summary = { ok: true, removedWorktree, deletedBranch, detachedExternalLinks: detachedLinks.length, pruned, notes };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('[cleanup-task-worktree] ok');
    if (removedWorktree) console.log('  removed worktree: ' + removedWorktree);
    if (deletedBranch) console.log('  deleted branch:   ' + deletedBranch);
    if (detachedLinks.length > 0) {
      console.log('  detached links:   ' + detachedLinks.length + ' external reparse point(s), every target still present');
    }
    for (const note of notes) console.log('  note: ' + note);
    if (pruned) console.log('  pruned stale worktree metadata');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('cleanup-task-worktree.mjs');
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  // cli-1: even an unexpected rejection must leave exactly one parseable JSON
  // object on stdout, never a bare stack trace.
  main().catch((err) => {
    // fail() already emitted the operator-facing payload; do not print twice.
    if (err instanceof ReportedFailure) {
      process.exitCode = 1;
      return;
    }
    const message = String((err && err.message) || err);
    if (jsonMode) {
      console.log(JSON.stringify({
        ok: false,
        code: CODES.CHECK_FAILED,
        error: message,
        reason: REMOVAL_REASONS.UNEXPECTED_ERROR,
        nextAction: 'Inspect the error above; do not fall back to a recursive delete or a bare `git worktree remove`.',
      }, null, 2));
    } else {
      console.error('[cleanup-task-worktree] UNEXPECTED FAILURE: ' + message);
    }
    process.exitCode = 1;
  });
}
