// Workspace cleanup sweep (PRI-691, extended by PRI-796) — the reliable EXIT of
// the task-worktree lifecycle (git-8-cleanup-after-merge), complementing the
// per-target cleanup-task-worktree.mjs.
//
// DRY-RUN BY DEFAULT: without --apply nothing is mutated — the tool only prints
// the evidence-backed plan. --apply executes exactly the printed actions, and
// each action re-verifies freshness immediately before mutating (SPEC §14.1):
// porcelain-clean, lease state, Git lock state and status readability are all
// re-read at apply time, because a snapshot from minutes ago is not evidence.
//
// Safety rules:
//   worktree removal = completion evidence (PR MERGED or ancestry to
//     origin/main) AND grace period exceeded AND porcelain clean AND not the
//     primary checkout AND no active write lease AND not Git-locked
//   branch deletion  = PR merged OR origin branch gone OR ancestry — and
//     restricted to task branches (ai/ prefix)
//   everything else  = SKIP with a printed reason (dirty, in grace, leased,
//     locked, orphaned, active PR, unknown evidence — fail closed)
//
// RESIDUE (SPEC §15/§16) is a separate, explicitly-acked path. A residue shell is
// a directory whose worktree admin metadata is gone: git cannot read its status,
// so its dirtiness is UNPROVABLE and it is NEVER part of the automatic sweep.
// Removing one requires naming it AND acknowledging the risk:
//
//   npm run dev:workspace:cleanup -- --residue "<path>" --ack-unknown --apply
//
// The deletion itself is junction-safe (lib/residue-delete.mjs): reparse points
// are detached, never traversed, and each link's external target is re-checked
// afterwards. Long deletions report progress inline — no daemon, no watcher.
//
// Mutations run under the repo mutation mutex (SPEC §4): removal, branch deletion
// and prune all write shared Git metadata.
//
// Usage:
//   node scripts/dev/workspace-cleanup.mjs [--apply] [--grace-days <n>] [--json] [--skip-gh]
//   node scripts/dev/workspace-cleanup.mjs --residue <path> --ack-unknown [--apply] [--json]
//   npm run dev:workspace:cleanup

import { assessWorktreePruneSafety, gitCommonDirAbsolute, listWorktrees, normalizeGitPath, runGit } from './lib/git.mjs';
import {
  GRACE_DAYS_DEFAULT,
  classifyRecords,
  collectWorkspaceState,
  planCleanup,
  readLeaseState,
} from './lib/workspace-lifecycle.mjs';
import { withMutationLock } from './lib/git-mutation-lock.mjs';
import { CODES } from './lib/preflight.mjs';
import { assertDeletableRoot, formatProgress, removeResidueTree, scanReparsePoints, classifyReparsePoints, detachInternalLinks, REMOVAL_REASONS } from './lib/residue-delete.mjs';
import { removeWorktreeSafely } from './lib/safe-worktree-remove.mjs';

function parseArgs(argv) {
  const args = { apply: false, json: false, graceDays: GRACE_DAYS_DEFAULT, skipGh: false, residue: null, ackUnknown: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--skip-gh') args.skipGh = true;
    else if (arg === '--ack-unknown') args.ackUnknown = true;
    else if (arg === '--residue') {
      args.residue = rest[++i];
      if (!args.residue) {
        console.error('--residue requires a path');
        process.exit(2);
      }
    } else if (arg === '--grace-days') {
      const value = Number(rest[++i]);
      if (!Number.isFinite(value) || value < 0) {
        console.error('--grace-days requires a non-negative number');
        process.exit(2);
      }
      args.graceDays = value;
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  return args;
}

function print(args, payload, lines) {
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(lines.join('\n'));
}

/** Never inline a path containing shell metacharacters into a paste-ready command. */
function shellPath(p) {
  const unsafeChars = process.platform === 'win32' ? '"&|%!^<>$`\'' : '\\"&|%!^<>$`\'';
  for (const ch of p) {
    if (unsafeChars.includes(ch) || ch === '\n' || ch === '\r') return '"<copy path from JSON output>"';
  }
  return '"' + p + '"';
}

function describeAction(action) {
  const lines = [];
  if (action.kind === 'remove-worktree') {
    lines.push('  worktree: ' + action.path);
    if (action.branch) lines.push('  branch:   ' + action.branch);
  } else {
    lines.push('  branch:   ' + action.branch + ' (no worktree)');
  }
  for (const item of action.evidence) lines.push('  evidence: ' + item);
  return lines;
}

/** Is `worktreePath` currently Git-locked? Reads the live worktree list. */
async function isLockedAtApplyTime(cwd, worktreePath) {
  const listed = await listWorktrees(cwd);
  const entry = listed.find((w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(worktreePath, cwd));
  return Boolean(entry && entry.locked);
}

/**
 * The explicitly-acked residue deletion path (SPEC §15.3/§16).
 *
 * Three separate gates, because each protects against a different mistake:
 *   1. the path must be a residue shell OUR OWN SCAN discovered — never taken on
 *      trust from the command line, so `--ack-unknown` cannot be aimed at an
 *      arbitrary directory;
 *   2. it must live under a residue root (the primary's parent, or the pool);
 *   3. `--ack-unknown` must be passed, and `--apply` for the deletion to happen.
 */
async function runResidueMode(args) {
  const state = await collectWorkspaceState({ cwd: process.cwd(), skipGh: args.skipGh, includeBranchSweep: false });
  const wanted = normalizeGitPath(args.residue, state.cwd);
  const entry = state.residue.find((r) => normalizeGitPath(r.path, state.cwd) === wanted);

  if (!entry) {
    print(
      args,
      {
        ok: false,
        code: CODES.CHECK_FAILED,
        error: 'the given path is not a discovered residue shell: ' + args.residue,
        discovered: state.residue.map((r) => r.path),
      },
      [
        '[workspace-cleanup] REFUSED — not a discovered residue shell: ' + args.residue,
        '  This tool only deletes directories its own scan classified as UNKNOWN residue.',
        '  Discovered residue shells (' + state.residue.length + '):',
        ...state.residue.map((r) => '    ' + r.path),
      ]
    );
    process.exit(1);
  }

  if (!args.ackUnknown) {
    print(
      args,
      { ok: false, code: CODES.CHECK_FAILED, error: 'missing --ack-unknown', target: entry.path },
      [
        '[workspace-cleanup] REFUSED — ' + entry.path + ' is UNKNOWN residue.',
        '',
        '  Its worktree metadata is gone, so git cannot report whether it holds uncommitted work:',
        ...entry.evidence.map((e) => '    evidence: ' + e),
        ...entry.reasons.map((r) => '    note: ' + r),
        '',
        '  Deleting it destroys any uncommitted work irrecoverably. If you have reviewed it and accept that:',
        '    npm run dev:workspace:cleanup -- --residue ' + shellPath(entry.path) + ' --ack-unknown --apply',
      ]
    );
    process.exit(1);
  }

  const rootGuard = assertDeletableRoot(entry.path, { primaryPath: state.primaryPath });
  if (!rootGuard.ok) {
    print(
      args,
      { ok: false, code: CODES.CHECK_FAILED, error: rootGuard.error, target: entry.path },
      ['[workspace-cleanup] REFUSED — ' + rootGuard.error]
    );
    process.exit(1);
    return;
  }
  const preflight = scanReparsePoints(rootGuard.resolved);
  if (preflight.unreadable.length > 0) {
    const unreadable = preflight.unreadable.slice(0, 20);
    print(
      args,
      {
        ok: false,
        code: CODES.CHECK_FAILED,
        error: 'residue scan incomplete; refusing before deleting any file or directory',
        target: entry.path,
        unreadable,
      },
      [
        '[workspace-cleanup] REFUSED — residue scan incomplete; nothing was deleted.',
        ...unreadable.map((item) => '  unreadable: ' + item.path + ' — ' + item.error),
      ]
    );
    process.exit(1);
    return;
  }
  const lines = ['[workspace-cleanup] residue target: ' + entry.path];
  lines.push('  class: ' + entry.residueClass + '  shape: ' + entry.residueShape);
  for (const e of entry.evidence) lines.push('  evidence: ' + e);
  lines.push(
    '  contents: ' + preflight.files + ' files, ' + preflight.dirs + ' dirs, ' + preflight.links.length + ' reparse points'
  );
  for (const link of preflight.links) {
    lines.push(
      '  link: ' + link.path + ' -> ' + (link.target || '(unreadable)') + (link.targetExists ? '' : '  [target already missing]')
    );
  }
  if (preflight.links.length > 0) {
    lines.push('  NOTE: reparse points are detached, never traversed; their external targets are re-checked afterwards.');
  }

  if (!args.apply) {
    lines.push('');
    lines.push('DRY-RUN — nothing was deleted. Re-run with --apply to delete.');
    print(
      args,
      {
        ok: true,
        mode: 'dry-run',
        target: entry.path,
        residueClass: entry.residueClass,
        residueShape: entry.residueShape,
        reparsePoints: preflight.links,
        counts: { files: preflight.files, dirs: preflight.dirs },
      },
      lines
    );
    return;
  }

  lines.push('');
  lines.push('  deleting (progress below)…');
  console.log(lines.join('\n'));

  const result = removeResidueTree(entry.path, {
    primaryPath: state.primaryPath,
    onProgress: (p) => console.log(formatProgress(p)),
  });

  if (result.ok) {
    console.log('');
    console.log(
      '  deleted: ' + result.removedFiles + ' files, ' + result.removedLinks + ' links, ' + result.dirs + ' dirs in ' +
        Math.round(result.elapsedMs / 1000) + 's'
    );
    for (const link of result.detachedLinks) {
      console.log(
        '  detached: ' + link.path + ' -> ' + (link.target || '?') + ' (external target still present: ' + link.targetStillExists + ')'
      );
    }
    console.log('  primary checkout untouched: ' + state.primaryPath);
  } else {
    console.error('[workspace-cleanup] FAILED to delete ' + entry.path + ': ' + result.error);
    for (const b of result.brokenTargets) console.error('  BROKEN TARGET: ' + b.path + ' -> ' + b.target);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.residue) {
    await runResidueMode(args);
    return;
  }

  const invocationCwd = process.cwd();
  const state = await collectWorkspaceState({ cwd: invocationCwd, skipGh: args.skipGh });
  // A batch may remove the worktree from which it was launched. All subsequent
  // Git operations therefore use the stable primary checkout as control plane.
  const cwd = state.primaryPath || invocationCwd;
  // A batch may remove its original cwd; release that directory handle first.
  process.chdir(cwd);
  const others = state.records.filter((r) => !(r.kind === 'worktree' && r.isPrimary));
  const classified = classifyRecords(others, { graceDays: args.graceDays, now: state.now });
  const plan = planCleanup(classified);
  const primaryPath = state.primaryPath;

  if (!args.apply) {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: 'dry-run',
            applyHint: 're-run with --apply to execute',
            actions: plan.actions,
            skipped: plan.skipped,
            residue: state.residue,
            notes: state.notes,
          },
          null,
          2
        )
      );
      return;
    }
    const lines = ['[workspace-cleanup] DRY-RUN — nothing was mutated (re-run with --apply to execute)'];
    if (plan.actions.length === 0) {
      lines.push('No cleanup candidates. Skipped: ' + plan.skipped.length);
    } else {
      lines.push('Cleanup candidates: ' + plan.actions.length);
      let current = null;
      for (const action of plan.actions) {
        const key = action.branch || action.path;
        if (key !== current) {
          lines.push('');
          lines.push(action.branch ? action.branch : action.path);
          current = key;
        }
        lines.push(...describeAction(action));
      }
    }
    lines.push('');
    lines.push('Skipped: ' + plan.skipped.length);
    for (const item of plan.skipped) {
      lines.push(
        '  ' + (item.target || '?') + ' — ' + item.status + (item.reasons.length ? ' (' + item.reasons.join('; ') + ')' : '')
      );
    }
    if (state.residue.length > 0) {
      lines.push('');
      lines.push('UNKNOWN residue (never swept automatically): ' + state.residue.length);
      for (const r of state.residue) {
        lines.push('  ' + r.path + '  [' + r.residueClass + ' / ' + r.residueShape + ']');
        if (r.recoveredBranch) lines.push('    task branch (recovered from lease): ' + r.recoveredBranch);
        for (const reason of r.reasons) lines.push('    note: ' + reason);
        lines.push('    to remove explicitly: npm run dev:workspace:cleanup -- --residue ' + shellPath(r.path) + ' --ack-unknown --apply');
      }
    }
    for (const note of state.notes) lines.push('Note: ' + note);
    console.log(lines.join('\n'));
    return;
  }

  // ---- apply mode: execute exactly the computed plan, re-verifying each. ----
  const applied = [];
  const refused = [];
  const blockedBranches = new Set();
  const refuseWorktree = (action, reason) => {
    refused.push({ action, reason });
    if (action.branch) blockedBranches.add(action.branch);
  };
  const notes = [...state.notes];
  const commonDir = await gitCommonDirAbsolute(cwd);

  for (const action of plan.actions) {
    if (action.kind === 'remove-worktree') {
      const worktreePath = action.path;
      if (normalizeGitPath(worktreePath, cwd) === normalizeGitPath(primaryPath, cwd)) {
        refuseWorktree(action, 'refusing the primary checkout');
        continue;
      }
      // SPEC §14.1 — re-verify freshness NOW, not at plan time.
      const status = await runGit(['status', '--porcelain'], { cwd: worktreePath, allowFailure: true });
      if (status === null) {
        refuseWorktree(action, 'worktree status unreadable at apply time');
        continue;
      }
      if (status.trim().length > 0) {
        refuseWorktree(action, 'worktree became dirty at apply time — unknown work preserved');
        continue;
      }
      if (await isLockedAtApplyTime(cwd, worktreePath)) {
        refuseWorktree(action, 'worktree is Git-locked at apply time — release the claim first (never auto-unlocked)');
        continue;
      }

      // The scan and all path mutations share the Git mutation lock. The actual
      // tree deletion is a no-follow filesystem walk in a quarantine sibling;
      // Git is used only for atomic move and metadata unregister, never recursive
      // deletion. Non-cooperating writers cannot make Git traverse a late junction.
      try {
        const verdict = await withMutationLock({ commonDir, operation: 'worktree-remove', target: worktreePath }, async () => {
          const lease = readLeaseState(worktreePath);
          if (lease.phase === 'active' || lease.phase === 'invalid') {
            return { ok: false, reason: 'worktree lease is ' + lease.phase + ' at apply time' };
          }
          let liveList = await listWorktrees(cwd);
          let liveEntry = liveList.find((w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(worktreePath, cwd));
          if (!liveEntry) return { ok: false, reason: 'worktree is no longer registered at apply time' };
          if (liveEntry.locked) return { ok: false, reason: 'worktree is Git-locked at apply time' };

          const currentLease = readLeaseState(worktreePath);
          const listed = await listWorktrees(cwd);
          const currentEntry = listed.find((w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(worktreePath, cwd));
          if (currentLease.phase === 'active' || currentLease.phase === 'invalid' || !currentEntry || currentEntry.locked) {
            return { ok: false, reason: 'worktree writer ownership changed inside mutation lock; refusing deletion' };
          }
          const linkScan = classifyReparsePoints(worktreePath);
          if (!linkScan.complete) {
            return {
              ok: false,
              reason:
                'the reparse-point scan could NOT prove the whole worktree is readable (' +
                linkScan.unreadable.length + ' unreadable directory/directories, first: ' +
                (linkScan.unreadable[0] ? linkScan.unreadable[0].path : 'worktree root') +
                ') — an unreadable directory may hide a junction pointing outside it (ERR-098); ' +
                REMOVAL_REASONS.SCAN_INCOMPLETE,
            };
          }
          const unsafeExternal = linkScan.external.filter((link) => link.unsafeReason !== 'cycle');
          if (unsafeExternal.length > 0) {
            const first = unsafeExternal[0];
            return {
              ok: false,
              reason:
                unsafeExternal.length +
                ' reparse point(s) must not be traversed (outside / unresolvable / non-lexical; internal ancestor cycles are detached safely) — first: ' +
                first.path + ' -> ' + (first.target || '<unreadable target>') +
                ' [' + (first.unsafeReason || 'outside') + ']; ' +
                REMOVAL_REASONS.EXTERNAL_LINKS_PRESENT +
                '; detach the links, then run: npm run dev:worktree:cleanup -- ' +
                shellPath(worktreePath) + ' --detach-external-links',
            };
          }

          const expectedDeletedPaths = [];
          const safeInternalLinks = [
            ...linkScan.internal,
            ...linkScan.external.filter((link) => link.unsafeReason === 'cycle'),
          ];
          if (safeInternalLinks.length > 0) {
            // A second ownership check is deliberately adjacent to the unlink.
            const leaseBeforeDetach = readLeaseState(worktreePath);
            if (leaseBeforeDetach.phase === 'active' || leaseBeforeDetach.phase === 'invalid') {
              return { ok: false, reason: 'worktree lease became ' + leaseBeforeDetach.phase + ' before internal-link detachment' };
            }
            liveList = await listWorktrees(cwd);
            liveEntry = liveList.find((w) => normalizeGitPath(w.path, cwd) === normalizeGitPath(worktreePath, cwd));
            if (!liveEntry || liveEntry.locked) {
              return { ok: false, reason: 'worktree ownership changed before internal-link detachment' };
            }
            const internal = detachInternalLinks(worktreePath);
            if (!internal.ok) {
              return {
                ok: false,
                reason: 'could not detach ' + safeInternalLinks.length + ' verified internal/cycle reparse point(s) before safe removal; ' +
                  (internal.complete ? REMOVAL_REASONS.EXTERNAL_LINKS_PRESENT : REMOVAL_REASONS.SCAN_INCOMPLETE),
              };
            }
            expectedDeletedPaths.push(...internal.detached.map((item) => item.path));
            notes.push('detached ' + internal.detached.length + ' verified internal/cycle reparse point(s) before safe removal');
          }

          const safeRemoval = await removeWorktreeSafely({
            cwd,
            worktreePath,
            primaryPath,
            expectedDeletedPaths,
            onProgress: args.json ? null : (progress) => console.log(formatProgress(progress)),
          });
          notes.push(...safeRemoval.notes);
          return {
            ok: safeRemoval.ok,
            reason: safeRemoval.reason,
            removedPath: safeRemoval.removedPath,
            quarantinePath: safeRemoval.quarantinePath,
            restoredPath: safeRemoval.restoredPath,
            adminDirPath: safeRemoval.adminDirPath,
            residueKind: safeRemoval.residueKind,
          };
        });
        if (verdict.ok) applied.push(action);
        else refuseWorktree(
          action,
          verdict.reason + (verdict.quarantinePath ? ' (quarantine: ' + verdict.quarantinePath + ')' : '')
        );
      } catch (err) {
        refuseWorktree(action, 'mutation lock unavailable: ' + (err && err.message ? err.message : String(err)));
      }
      continue;
    }

    // delete-branch
    const branch = action.branch;
    if (blockedBranches.has(branch)) {
      refused.push({ action, reason: 'worktree removal was refused or failed; branch deletion skipped' });
      continue;
    }
    const exists = (await runGit(['rev-parse', '--verify', 'refs/heads/' + branch], { cwd, allowFailure: true })) !== null;
    if (!exists) {
      notes.push('branch already gone: ' + branch);
      applied.push(action);
      continue;
    }
    try {
      await withMutationLock({ commonDir, operation: 'branch-delete', target: branch }, async () => {
        try {
          await runGit(['branch', '-d', branch], { cwd });
        } catch {
          // Completion evidence was proven during planning; -d only refuses
          // against the CURRENT head, so -D with the recorded justification
          // matches the per-target cleanup tool's established behavior.
          await runGit(['branch', '-D', branch], { cwd });
          notes.push("-d refused for '" + branch + "' (not merged into current HEAD); -D used after recorded completion evidence");
        }
      });
      applied.push(action);
    } catch (err) {
      refused.push({ action, reason: 'git branch delete failed: ' + (err && err.message ? err.message : String(err)) });
    }
  }

  // PRI-712: the global prune drops admin metadata of worktrees whose
  // directory git believes is gone — but a Windows lock race can make a LIVE
  // worktree transiently unreadable and get it misclassified as missing.
  // Prune runs only when every existing-dir worktree probes clean; otherwise
  // it is skipped with a note (prune is an opportunistic optimization).
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

  const summary = {
    ok: true,
    mode: 'apply',
    applied: applied.length,
    refused,
    skipped: plan.skipped,
    residueReported: state.residue.map((r) => ({ path: r.path, residueClass: r.residueClass, residueShape: r.residueShape })),
    pruned,
    notes,
    actions: applied,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const lines = [
    '[workspace-cleanup] applied ' + applied.length + ' action(s), refused ' + refused.length + ', skipped ' + plan.skipped.length,
  ];
  for (const action of applied) lines.push('  done: ' + action.kind + ' ' + (action.path || action.branch));
  for (const item of refused) {
    lines.push('  refused: ' + item.action.kind + ' ' + (item.action.path || item.action.branch) + ' — ' + item.reason);
  }
  for (const item of plan.skipped) {
    lines.push(
      '  skipped: ' + (item.target || '?') + ' — ' + item.status + (item.reasons.length ? ' (' + item.reasons.join('; ') + ')' : '')
    );
  }
  for (const note of notes) lines.push('  note: ' + note);
  console.log(lines.join('\n'));
}

const isMain = process.argv[1] && process.argv[1].endsWith('workspace-cleanup.mjs');
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  // cli-1: even an unexpected rejection must leave exactly one parseable JSON
  // object on stdout, never a bare stack trace.
  main().catch((err) => {
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
      console.error('[workspace-cleanup] UNEXPECTED FAILURE: ' + message);
    }
    process.exitCode = 1;
  });
}
