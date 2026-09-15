// `npm run dev:workspace:migrate [--apply]` (PRI-796, SPEC §19/§20).
//
// Moves EXISTING, still-registered task worktrees from the legacy sibling layout
// (`<parent>/<repo>-<task>-<slug>`) into the shared pool
// (`<parent>/_worktrees/<repo>/<task>-<slug>`), so a machine that predates the
// convention can converge without hand surgery.
//
// DRY-RUN BY DEFAULT. Without `--apply` this only prints what it WOULD do.
//
// What may move:
//   registered + not primary + clean + no active write lease + not Git-locked
// What never moves, and is reported instead:
//   ACTIVE   — a live writer must not have its working directory yanked out from
//              under it. Re-run after the task releases its claim (SPEC §19.3).
//   UNKNOWN  — a directory git cannot account for. `--apply` never deletes it and
//              never moves it: `git worktree move` requires the worktree to be
//              registered, so a residue shell is not even a candidate.
//   dirty / locked / leased → reported with the reason.
//
// All moves run under the repo mutation mutex, because `git worktree move`
// rewrites both the worktree's `.git` pointer and its admin entry — shared Git
// metadata.
//
// Usage:
//   node scripts/dev/workspace-migrate.mjs [--apply] [--json] [--skip-gh]

import fs from 'node:fs';
import path from 'node:path';
import { gitCommonDirAbsolute, listWorktrees, runGit, sameGitPath } from './lib/git.mjs';
import { collectPrIndex, readLeaseState } from './lib/workspace-lifecycle.mjs';
import { resolveWorktreeRoot, taskIdentityFromBranch } from './lib/worktree-root.mjs';
import { withMutationLock } from './lib/git-mutation-lock.mjs';

function parseArgs(argv) {
  const args = { apply: false, json: false, skipGh: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--skip-gh') args.skipGh = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/workspace-migrate.mjs [--apply] [--json] [--skip-gh]');
      process.exit(0);
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  const worktrees = await listWorktrees(cwd);
  const primary = worktrees.find((w) => !w.bare);
  if (!primary) {
    console.error('[workspace-migrate] FAIL (ENVIRONMENT_INVALID): no non-bare worktree found.');
    process.exit(1);
  }

  const { root: poolRoot } = resolveWorktreeRoot({ primaryPath: primary.path, env: process.env });
  const gh = args.skipGh ? { available: false, merged: new Map(), open: new Map() } : await collectPrIndex(cwd);

  const wouldMove = [];
  const skipped = [];

  for (const wt of worktrees) {
    if (wt.bare) continue;
    if (sameGitPath(wt.path, primary.path, cwd)) continue; // control plane stays put

    const branch = wt.branch ? wt.branch.replace(/^refs\/heads\//, '') : null;
    const identity = taskIdentityFromBranch(branch);

    if (!identity) {
      skipped.push({ path: wt.path, branch, state: 'SKIP', reasons: ['not a task branch (ai/<task>) — outside the migration contract'] });
      continue;
    }

    const alreadyInPool = sameGitPath(path.dirname(wt.path), poolRoot, cwd);
    if (alreadyInPool) {
      skipped.push({ path: wt.path, branch, state: 'ALREADY_IN_POOL', reasons: ['already in the shared pool'] });
      continue;
    }

    const target = path.join(poolRoot, identity);
    const reasons = [];

    if (wt.locked) reasons.push('Git-locked' + (wt.lockReason ? ' (' + wt.lockReason + ')' : ''));
    const lease = readLeaseState(wt.path);
    if (lease.phase === 'active') reasons.push('ACTIVE write lease' + (lease.owner ? ' held by ' + lease.owner : ''));
    if (lease.phase === 'invalid') reasons.push('lease file unreadable');

    const status = await runGit(['status', '--porcelain'], { cwd: wt.path, allowFailure: true });
    if (status === null) reasons.push('worktree status unreadable');
    else if (status.trim().length > 0) reasons.push('dirty — uncommitted work present');

    if (fs.existsSync(target)) reasons.push('target path already exists: ' + target);

    const pr = branch ? gh.open.get(branch) || gh.merged.get(branch) || null : null;
    if (pr && pr.state === 'OPEN') reasons.push('PR #' + pr.number + ' still OPEN');

    if (reasons.length > 0) {
      skipped.push({ path: wt.path, branch, state: lease.phase === 'active' ? 'ACTIVE' : 'SKIP', reasons, target });
      continue;
    }

    wouldMove.push({ path: wt.path, branch, target, identity });
  }

  if (!args.apply) {
    const payload = {
      ok: true,
      mode: 'dry-run',
      applyHint: 're-run with --apply to move the WOULD MOVE entries',
      poolRoot,
      wouldMove,
      skipped,
      note: 'UNKNOWN residue shells are never touched by this tool.',
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const lines = ['[workspace-migrate] DRY-RUN — nothing was moved'];
    lines.push('  pool: ' + poolRoot);
    lines.push('');
    lines.push('WOULD MOVE (' + wouldMove.length + ')');
    for (const m of wouldMove) {
      lines.push('  ' + m.path);
      lines.push('    -> ' + m.target);
      lines.push('    branch: ' + m.branch);
    }
    lines.push('');
    lines.push('WOULD SKIP (' + skipped.length + ')');
    for (const s of skipped) {
      lines.push('  ' + s.path + ' — ' + s.state + ' (' + s.reasons.join('; ') + ')');
    }
    lines.push('');
    lines.push('NOTE: UNKNOWN residue shells are not migration candidates — `git worktree move` requires a registered worktree.');
    console.log(lines.join('\n'));
    return;
  }

  // ---- apply: move exactly the planned entries, re-verifying each ----
  const moved = [];
  const refused = [];
  const notes = [];
  const commonDir = await gitCommonDirAbsolute(cwd);

  try {
    fs.mkdirSync(poolRoot, { recursive: true });
  } catch (err) {
    console.error('[workspace-migrate] FAIL (ENVIRONMENT_INVALID): cannot create pool ' + poolRoot + ': ' + String((err && err.message) || err));
    process.exit(1);
  }

  for (const entry of wouldMove) {
    // Re-verify freshness at apply time: a snapshot from seconds ago said clean,
    // but a writer may have started since.
    const status = await runGit(['status', '--porcelain'], { cwd: entry.path, allowFailure: true });
    if (status === null || status.trim().length > 0) {
      refused.push({ ...entry, reason: 'became dirty or unreadable at apply time' });
      continue;
    }
    const lease = readLeaseState(entry.path);
    if (lease.phase === 'active' || lease.phase === 'invalid') {
      refused.push({ ...entry, reason: 'write lease became ' + lease.phase + ' at apply time' });
      continue;
    }
    const live = (await listWorktrees(cwd)).find((w) => sameGitPath(w.path, entry.path, cwd));
    if (!live) {
      refused.push({ ...entry, reason: 'no longer a registered worktree' });
      continue;
    }
    if (live.locked) {
      refused.push({ ...entry, reason: 'is Git-locked at apply time' });
      continue;
    }
    if (fs.existsSync(entry.target)) {
      refused.push({ ...entry, reason: 'target path appeared at apply time: ' + entry.target });
      continue;
    }

    try {
      await withMutationLock({ commonDir, operation: 'worktree-move', target: entry.path }, async () => {
        await runGit(['worktree', 'move', entry.path, entry.target], { cwd });
      });
      moved.push(entry);
    } catch (err) {
      refused.push({ ...entry, reason: 'git worktree move failed: ' + (err && err.message ? err.message : String(err)) });
    }
  }

  const payload = { ok: true, mode: 'apply', moved, refused, skipped, poolRoot, notes };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    // PRI-796 review: --json must exit non-zero on refusals exactly like the
    // text path below — callers branch on the exit code.
    if (refused.length > 0) process.exit(1);
    return;
  }
  const lines = ['[workspace-migrate] moved ' + moved.length + ', refused ' + refused.length + ', skipped ' + skipped.length];
  for (const m of moved) lines.push('  moved: ' + m.path + ' -> ' + m.target);
  for (const r of refused) lines.push('  refused: ' + r.path + ' — ' + r.reason);
  for (const s of skipped) lines.push('  skipped: ' + s.path + ' — ' + s.state + ' (' + s.reasons.join('; ') + ')');
  for (const note of notes) lines.push('  note: ' + note);
  console.log(lines.join('\n'));

  if (moved.length > 0) {
    console.log('');
    console.log('Verify with: git worktree list   and   npm run dev:workspace:snapshot');
  }
  if (refused.length > 0) process.exit(1);
}

const isMain = process.argv[1] && process.argv[1].endsWith('workspace-migrate.mjs');
if (isMain) {
  await main();
}
