// Workspace cleanup sweep (PRI-691) — the reliable EXIT of the task-worktree
// lifecycle (git-8-cleanup-after-merge), complementing the per-target
// cleanup-task-worktree.mjs which stays unchanged.
//
// DRY-RUN BY DEFAULT: without --apply nothing is mutated — the tool only
// prints the evidence-backed plan. --apply executes exactly the printed
// actions, and each action re-verifies freshness immediately before mutating:
// porcelain-clean at removal time, branch still present at delete time.
//
// Safety rules (see docs/architecture/workspace-lifecycle-guard-analysis.md):
//   worktree removal = completion evidence (PR MERGED or ancestry to
//     origin/main) AND grace period exceeded AND porcelain clean AND not the
//     primary checkout AND no active git-9 write lease
//   branch deletion  = PR merged OR origin branch gone OR ancestry — and
//     restricted to task branches (ai/ prefix); worktree removal for a
//     ready record also deletes its ai/ branch
//   everything else  = SKIP with a printed reason (dirty, in grace, leased,
//     orphaned, active PR, unknown evidence — fail closed)
//
// Removal uses `git worktree remove` (junction/reparse-point safe — ERR-098);
// a single --force retry is allowed ONLY after the porcelain-clean check
// passed (it can only override ignored build output). Double --force is never
// used.
//
// Usage:
//   node scripts/dev/workspace-cleanup.mjs [--apply] [--grace-days <n>] [--json] [--skip-gh]
//   npm run dev:workspace:cleanup

import { normalizeGitPath, runGit } from './lib/git.mjs';
import { GRACE_DAYS_DEFAULT, classifyRecords, collectWorkspaceState, planCleanup } from './lib/workspace-lifecycle.mjs';

function parseArgs(argv) {
  const args = { apply: false, json: false, graceDays: GRACE_DAYS_DEFAULT, skipGh: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--skip-gh') args.skipGh = true;
    else if (arg === '--grace-days') {
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

function fail(args, message, nextAction) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: message, nextAction }, null, 2));
  } else {
    console.error('[workspace-cleanup] FAIL: ' + message);
    if (nextAction) console.error('  next: ' + nextAction);
  }
  process.exit(1);
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

async function removeWorktree(cwd, path, notes) {
  let removeError = '';
  try {
    await runGit(['worktree', 'remove', path], { cwd });
  } catch (err) {
    removeError = err && err.message ? err.message : String(err);
  }
  if (!removeError) return true;
  // Porcelain was clean at apply time, so only ignored build output (e.g.
  // node_modules) can block removal; one --force retry is safe in exactly
  // that situation. Double --force is never used.
  try {
    await runGit(['worktree', 'remove', '--force', path], { cwd });
    notes.push('removal needed one --force pass for ignored build output (porcelain was clean)');
    return true;
  } catch (err2) {
    return err2 && err2.message ? err2.message : String(err2);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = process.cwd();

  const state = await collectWorkspaceState({ cwd, skipGh: args.skipGh });
  const others = state.records.filter((r) => !(r.kind === 'worktree' && r.isPrimary));
  const classified = classifyRecords(others, { graceDays: args.graceDays, now: state.now });
  const plan = planCleanup(classified);

  const primaryPath = state.primaryPath;

  if (!args.apply) {
    if (args.json) {
      console.log(JSON.stringify({ ok: true, mode: 'dry-run', applyHint: 're-run with --apply to execute', actions: plan.actions, skipped: plan.skipped, notes: state.notes }, null, 2));
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
      lines.push('  ' + (item.target || '?') + ' — ' + item.status + (item.reasons.length ? ' (' + item.reasons.join('; ') + ')' : ''));
    }
    for (const note of state.notes) lines.push('Note: ' + note);
    console.log(lines.join('\n'));
    return;
  }

  // ---- apply mode: execute exactly the computed plan, re-verifying each. ----
  const applied = [];
  const refused = [];
  const notes = [...state.notes];

  for (const action of plan.actions) {
    if (action.kind === 'remove-worktree') {
      const path = action.path;
      if (normalizeGitPath(path, cwd) === normalizeGitPath(primaryPath, cwd)) {
        refused.push({ action, reason: 'refusing the primary checkout' });
        continue;
      }
      const status = await runGit(['status', '--porcelain'], { cwd: path, allowFailure: true });
      if (status === null) {
        refused.push({ action, reason: 'worktree status unreadable at apply time' });
        continue;
      }
      if (status.trim().length > 0) {
        refused.push({ action, reason: 'worktree became dirty at apply time — unknown work preserved' });
        continue;
      }
      const result = await removeWorktree(cwd, path, notes);
      if (result === true) {
        applied.push(action);
      } else {
        refused.push({ action, reason: 'git worktree remove failed: ' + result });
      }
      continue;
    }
    // delete-branch
    const branch = action.branch;
    const exists = (await runGit(['rev-parse', '--verify', 'refs/heads/' + branch], { cwd, allowFailure: true })) !== null;
    if (!exists) {
      notes.push('branch already gone: ' + branch);
      applied.push(action);
      continue;
    }
    let delError = '';
    try {
      await runGit(['branch', '-d', branch], { cwd });
    } catch (err) {
      delError = err && err.message ? err.message : String(err);
    }
    if (delError) {
      // Completion evidence was proven during planning; -d only refuses
      // against the CURRENT head, so -D with the recorded justification
      // matches the per-target cleanup tool's established behavior.
      try {
        await runGit(['branch', '-D', branch], { cwd });
        notes.push("-d refused for '" + branch + "' (not merged into current HEAD); -D used after recorded completion evidence");
      } catch (err2) {
        refused.push({ action, reason: 'git branch delete failed: ' + (err2 && err2.message ? err2.message : String(err2)) });
        continue;
      }
    }
    applied.push(action);
  }

  await runGit(['worktree', 'prune'], { cwd, allowFailure: true });

  const summary = { ok: true, mode: 'apply', applied: applied.length, refused, skipped: plan.skipped, notes, actions: applied };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const lines = ['[workspace-cleanup] applied ' + applied.length + ' action(s), refused ' + refused.length + ', skipped ' + plan.skipped.length];
  for (const action of applied) {
    lines.push('  done: ' + action.kind + ' ' + (action.path || action.branch));
  }
  for (const item of refused) {
    lines.push('  refused: ' + item.action.kind + ' ' + (item.action.path || item.action.branch) + ' — ' + item.reason);
  }
  for (const item of plan.skipped) {
    lines.push('  skipped: ' + (item.target || '?') + ' — ' + item.status + (item.reasons.length ? ' (' + item.reasons.join('; ') + ')' : ''));
  }
  for (const note of notes) lines.push('  note: ' + note);
  console.log(lines.join('\n'));
}

const isMain = process.argv[1] && process.argv[1].endsWith('workspace-cleanup.mjs');
if (isMain) {
  await main();
}
