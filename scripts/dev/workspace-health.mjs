// Read-only workspace health report (PRI-691).
//
// Derives everything per run from git + GitHub (+ git-9 lease files); this
// tool never mutates anything — including the primary checkout, whose drift
// it only REPORTS (git-3; fixing drift is a human/session decision).
//
// Usage:
//   node scripts/dev/workspace-health.mjs [--json] [--grace-days <n>] [--skip-gh]
//   npm run dev:workspace:health

import {
  GRACE_DAYS_DEFAULT,
  classifyRecords,
  collectWorkspaceState,
  conflictCodes,
} from './lib/workspace-lifecycle.mjs';

function parseArgs(argv) {
  const args = { json: false, graceDays: GRACE_DAYS_DEFAULT, skipGh: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
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

function renderPrimary(primaryRecord) {
  const lines = [];
  const porcelain = primaryRecord.porcelain;
  const dirty = porcelain !== null && porcelain.trim().length > 0;
  const conflicts = conflictCodes(porcelain);
  const onMain = primaryRecord.branch === 'main';
  const warnings = [];
  if (!onMain) warnings.push("branch is '" + (primaryRecord.branch || 'detached') + "' — expected main (git-3 control plane)");
  if (conflicts.length > 0) warnings.push('unresolved merge conflict codes: ' + conflicts.join(', '));
  else if (dirty) warnings.push('uncommitted or untracked files present');
  const status = conflicts.length > 0 ? 'CONFLICT' : warnings.length > 0 ? 'WARNING' : 'OK';
  lines.push('Primary checkout');
  lines.push('  status:  ' + status);
  lines.push('  branch:  ' + (primaryRecord.branch || 'detached') + ' (expected: main)');
  lines.push('  dirty:   ' + (dirty ? 'yes' : 'no'));
  lines.push('  conflict: ' + (conflicts.length > 0 ? 'yes (' + conflicts.join(',') + ')' : 'no'));
  for (const w of warnings) lines.push('  warning: ' + w);
  return { status, dirty, conflicts, warnings, text: lines };
}

function renderRecord(entry) {
  const r = entry.record;
  const target = r.kind === 'worktree' ? r.path : r.branch + ' (no worktree)';
  const lines = [];
  lines.push('  ' + entry.status.padEnd(16) + ' ' + target);
  const detail = [];
  if (r.branch) detail.push('branch: ' + r.branch);
  if (entry.ageDays !== null) detail.push('age ' + Math.floor(entry.ageDays) + 'd');
  if (entry.evidence.length > 0) detail.push(entry.evidence.join('; '));
  for (const reason of entry.reasons) detail.push('note: ' + reason);
  for (const d of detail) lines.push('    ' + d);
  return lines;
}

async function main() {
  const args = parseArgs(process.argv);
  const state = await collectWorkspaceState({ cwd: process.cwd(), skipGh: args.skipGh });
  const others = state.records.filter((r) => !(r.kind === 'worktree' && r.isPrimary));
  const classified = classifyRecords(others, { graceDays: args.graceDays, now: state.now });
  const counts = {};
  for (const entry of classified) counts[entry.status] = (counts[entry.status] || 0) + 1;

  const primaryReport = state.primaryRecord
    ? renderPrimary(state.primaryRecord)
    : { status: 'ERROR', dirty: false, conflicts: [], warnings: ['primary worktree not found'], text: ['Primary checkout', '  status:  ERROR (not found)'] };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date(state.now).toISOString(),
          primary: { status: primaryReport.status, branch: state.primaryRecord?.branch ?? null, dirty: primaryReport.dirty, conflicts: primaryReport.conflicts, warnings: primaryReport.warnings },
          worktrees: classified,
          residue: state.residue,
          ghAvailable: state.ghAvailable,
          notes: state.notes,
          counts,
        },
        null,
        2
      )
    );
    return;
  }

  const lines = [];
  lines.push('[workspace-health] report @ ' + new Date(state.now).toISOString() + '  (grace ' + args.graceDays + 'd)');
  lines.push('');
  lines.push(...primaryReport.text);
  lines.push('');
  lines.push('Worktrees & task branches (' + classified.length + ' classified)');
  for (const entry of classified) lines.push(...renderRecord(entry));
  lines.push('');
  lines.push('Unregistered worktree shells: ' + state.residue.length);
  for (const item of state.residue) {
    lines.push('  ' + item.path);
    lines.push('    ' + item.reason + ': ' + item.gitdirTarget);
  }
  if (state.residue.length > 0) {
    lines.push('  (report only — remove manually after confirming: git worktree prune does not cover these)');
  }
  lines.push('');
  lines.push('Summary: ' + JSON.stringify(counts));
  for (const note of state.notes) lines.push('Note: ' + note);
  console.log(lines.join('\n'));
}

const isMain = process.argv[1] && process.argv[1].endsWith('workspace-health.mjs');
if (isMain) {
  await main();
}
