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
// (node_modules). Double --force is never used. Every external target found by
// the preflight is re-verified after the removal; if one vanished, this run failed
// to contain the damage and exits non-zero.

import fs from 'node:fs';
import {
  assessWorktreePruneSafety,
  gitCommonDirAbsolute,
  listWorktrees,
  normalizeGitPath,
  runGit,
} from './lib/git.mjs';
import { collectPrIndex, readLeaseState } from './lib/workspace-lifecycle.mjs';
import { withMutationLock } from './lib/git-mutation-lock.mjs';
import { classifyReparsePoints, detachExternalLinks } from './lib/residue-delete.mjs';
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

function fail(args, code, message, nextAction, extra) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, code, error: message, nextAction, ...(extra || {}) }, null, 2));
  } else {
    console.error('[cleanup-task-worktree] FAIL (' + code + '): ' + message);
    if (nextAction) console.error('  next: ' + nextAction);
  }
  process.exit(1);
}

/** Format the first few external links so the operator sees the danger, not a count. */
function describeLinks(links, limit = 8) {
  return links
    .slice(0, limit)
    .map((l) => '    ' + l.path + '  ->  ' + (l.target || '<unreadable target>') + (l.targetExists ? '' : '  [target missing]'))
    .join('\n') + (links.length > limit ? '\n    …and ' + (links.length - limit) + ' more' : '');
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

    // ---- ERR-098 preflight: enumerate reparse points BEFORE git touches them ----
    // Read-only, and deliberately OUTSIDE the mutation lock (git-12 says keep that
    // lock short: never across an install/build/test run, and a 500k-file walk is
    // in that cost class). An active lease (above) is what stops another writer
    // changing this tree mid-run; the post-removal target check below is the
    // tripwire if that assumption is ever wrong.
    const linkScan = classifyReparsePoints(target.path);
    const externalTargets = linkScan.external.map((l) => l.resolvedTarget).filter(Boolean);
    if (linkScan.external.length > 0 && !args.detachExternalLinks) {
      fail(
        args,
        CODES.CHECK_FAILED,
        'The worktree holds ' +
          linkScan.external.length +
          ' reparse point(s) pointing OUTSIDE it. `git worktree remove` recurses through such links (ERR-098), which would delete files this worktree has no claim on. Nothing was removed:\n' +
          describeLinks(linkScan.external),
        'Detach them yourself — removing a link never touches its target — then retry. On Windows a directory junction detaches with: cmd /c rmdir "' +
          linkScan.external[0].path +
          '"   (or pass --detach-external-links to let this tool detach exactly the external links and re-verify each target).',
        { reason: 'EXTERNAL_LINKS_PRESENT', externalLinks: linkScan.external.slice(0, 20), externalLinkCount: linkScan.external.length }
      );
    }
    if (linkScan.external.length > 0) {
      const detached = detachExternalLinks(target.path);
      detachedLinks = detached.detached;
      if (detached.brokenTargets.length > 0) {
        fail(
          args,
          CODES.CHECK_FAILED,
          'Detaching an external reparse point destroyed its target — the link WAS followed. Nothing more was removed:\n' +
            detached.brokenTargets.map((b) => '    ' + b.path + '  ->  ' + b.target).join('\n'),
          'Restore the target from a backup or its package tarball before continuing, then re-run: npm run check:error-handbook',
          { reason: 'EXTERNAL_TARGET_LOST', detachedLinks: detached.detached, brokenTargets: detached.brokenTargets }
        );
      }
      if (detached.failedToDetach.length > 0 || detached.remainingExternal.length > 0) {
        fail(
          args,
          CODES.CHECK_FAILED,
          'Could not detach every external reparse point; refusing to hand this tree to git:\n' +
            detached.failedToDetach.map((f) => '    unlink failed: ' + f.path + ' — ' + f.error).join('\n') +
            (detached.remainingExternal.length > 0 ? '\n' + describeLinks(detached.remainingExternal) : ''),
          'Remove the leftovers manually (removing a link never touches its target), then retry.',
          { reason: 'EXTERNAL_LINKS_PRESENT', detachedLinks: detached.detached, remainingExternal: detached.remainingExternal }
        );
      }
      notes.push(
        'detached ' + detached.detached.length + ' external reparse point(s) before removal; every target re-verified present (ERR-098)'
      );
    }
    if (linkScan.internal.length > 0) {
      notes.push(linkScan.internal.length + ' internal reparse point(s) left for git to traverse (targets inside this worktree only)');
    }

    try {
      await withMutationLock({ commonDir, operation: 'worktree-remove', target: target.path }, async () => {
        let removeError = '';
        try {
          await runGit(['worktree', 'remove', target.path], { cwd });
        } catch (err) {
          removeError = err && err.message ? err.message : String(err);
        }
        if (removeError) {
          // Porcelain was clean AND no external reparse point remains, so only
          // ignored build output (e.g. node_modules) can be blocking the removal.
          // One --force retry is safe in exactly this situation; it cannot touch
          // tracked/dirty content we did not already refuse above. Double --force
          // is never used. (ERR-098 note: before the preflight above, this retry
          // was NOT safe — the real incident traversed a junction on the FIRST,
          // non-forced removal, so a clean porcelain was never evidence.)
          await runGit(['worktree', 'remove', '--force', target.path], { cwd });
          notes.push('removal needed one --force pass for ignored build output (porcelain was clean)');
        }
        removedWorktree = target.path;
      });
    } catch (err) {
      // Did the failure leave a directory git no longer has admin metadata for?
      // That is a NO_GIT_MARKER residue shell (git-14): unprovable dirtiness, so
      // only the explicitly acked residue path may delete it.
      const stillListed = await listWorktrees(cwd);
      const stillRegistered = stillListed.some(
        (w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(target.path, cwd)
      );
      const shellRemains = fs.existsSync(target.path) && !stillRegistered;
      fail(
        args,
        CODES.CHECK_FAILED,
        'git worktree remove failed (porcelain was clean' +
          (linkScan.external.length === 0 ? ', no external reparse points' : '') +
          '):\n' +
          (err && err.message ? err.message : String(err)) +
          (shellRemains
            ? '\n' + target.path + ' is still on disk but git has no admin metadata for it any more: it is now a NO_GIT_MARKER residue shell.'
            : ''),
        shellRemains
          ? 'Do NOT delete it with a recursive delete. This tool\'s own junction-safe residue path is the only thing allowed to remove it: npm run dev:workspace:cleanup -- --residue "' +
            target.path +
            '" --ack-unknown --apply'
          : 'Inspect manually: git worktree remove ' + target.path,
        { reason: shellRemains ? 'REMOVAL_FAILED_RESIDUE_SHELL' : 'REMOVAL_FAILED' }
      );
    }

    // Tripwire: git removed the tree — did every external target survive? (ERR-098)
    if (removedWorktree && externalTargets.length > 0) {
      const lost = externalTargets.filter((t) => !fs.existsSync(t));
      if (lost.length > 0) {
        fail(
          args,
          CODES.CHECK_FAILED,
          'The worktree is gone, but ' +
            lost.length +
            ' external target(s) of reparse points inside it disappeared with it — something traversed a link:\n' +
            lost.map((t) => '    ' + t).join('\n'),
          'Restore them (npm pack <pkg> + sha512 check is how the 2026-11-06 incident was repaired) before running anything else.',
          { reason: 'EXTERNAL_TARGET_LOST', removedWorktree, lostTargets: lost, detachedLinks }
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
  await main();
}
