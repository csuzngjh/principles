// `npm run dev:workspace:snapshot [--json] [--size]` (PRI-796, SPEC §11).
//
// The Owner's single entry point for "what is on this machine right now".
// One command answers all of:
//
//   which task is in which directory     -> TASK
//   which AI/human currently owns it     -> WRITER
//   is it live, finished, or unknown     -> STATE      (ACTIVE/PENDING/CLEANUP_READY/UNKNOWN)
//   does it hold uncommitted work        -> DIRTY
//   what happened to its PR              -> PR
//   is git itself holding it             -> LOCK
//   can it actually be developed in      -> READY
//   may it be deleted                    -> CLEANUP
//
// `--size` adds FILES/SIZE on demand — a full recursive scan of several hundred
// thousand files is never the default (SPEC §11.1).
//
// Everything is derived per run from git + GitHub + the lease/lock files.
// Nothing is persisted; there is no registry and no cache.
//
// Usage:
//   node scripts/dev/worktree-snapshot.mjs [--json] [--size] [--grace-days <n>] [--skip-gh]
//   npm run dev:workspace:snapshot

import fs from 'node:fs';
import path from 'node:path';
import {
  GRACE_DAYS_DEFAULT,
  classifyRecords,
  collectWorkspaceState,
  toOwnerState,
} from './lib/workspace-lifecycle.mjs';
import { parseWriterOwner } from './lib/workspace-lease.mjs';
import { classifyLockAgainstLease } from './lib/worktree-lock.mjs';
import { taskIdentityFromBranch } from './lib/worktree-root.mjs';

function parseArgs(argv) {
  const args = { json: false, size: false, graceDays: GRACE_DAYS_DEFAULT, skipGh: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--size') args.size = true;
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

/** Files + bytes under a directory, never descending into a reparse point. */
function measureTree(root) {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // count the link's bytes, not its target's tree
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        bytes += fs.statSync(full).size;
        files += 1;
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return { files, bytes };
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(0) + ' MB';
}

function shortTask(branch, dirName) {
  const identity = branch ? taskIdentityFromBranch(branch) : null;
  if (identity) return identity;
  return dirName || (branch || '?');
}

function dirtyLabel(porcelain) {
  if (porcelain === null || porcelain === undefined) return '?';
  return porcelain.trim().length > 0 ? 'yes' : 'no';
}

function prLabel(pr) {
  if (!pr) return '-';
  if (pr.state === 'MERGED') return '#' + pr.number + ' MERGED';
  if (pr.state === 'OPEN') return '#' + pr.number + ' OPEN';
  return '#' + pr.number + ' ' + pr.state;
}

/**
 * Readiness for one worktree root, degrading to '?' when the directory is not a
 * PD checkout or cannot be evaluated. Imported lazily so the snapshot stays fast
 * for callers that only need git/lock state (and so a broken tree cannot crash
 * the whole report).
 */
async function readyLabel(root) {
  if (!fs.existsSync(path.join(root, 'package.json'))) return '?';
  try {
    const { checkReadiness } = await import('./lib/readiness.mjs');
    return checkReadiness({ worktreeRoot: root }).ok ? 'yes' : 'no';
  } catch {
    return '?';
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const state = await collectWorkspaceState({ cwd: process.cwd(), skipGh: args.skipGh });
  const others = state.records.filter((r) => !(r.kind === 'worktree' && r.isPrimary));
  const classified = classifyRecords(others, { graceDays: args.graceDays, now: state.now });

  const rows = [];
  for (const entry of classified) {
    const r = entry.record;
    const writer = r.leaseOwner ? parseWriterOwner(r.leaseOwner)?.writer || r.leaseOwner : '-';
    const lock = classifyLockAgainstLease({
      locked: r.locked,
      leasePhase: r.leasePhase,
      leaseOwner: r.leaseOwner,
      path: r.path,
    });
    const row = {
      task: shortTask(r.branch, r.path ? path.basename(r.path) : null),
      kind: r.kind,
      writer,
      state: toOwnerState(entry.status),
      internalState: entry.status,
      dirty: r.kind === 'worktree' ? dirtyLabel(r.porcelain) : '-',
      pr: prLabel(r.pr),
      lock: lock.state === 'stale' ? 'STALE' : lock.state === 'locked' ? 'yes' : 'no',
      lockDetail: lock.detail,
      lockNextAction: lock.nextAction,
      ready: r.kind === 'worktree' ? await readyLabel(r.path) : '?',
      cleanup: entry.status === 'CLEANUP_READY' ? 'YES' : entry.status === 'ACTIVE' ? 'NO' : 'NO',
      branch: r.branch,
      path: r.path,
      evidence: entry.evidence,
      reasons: entry.reasons,
      ageDays: entry.ageDays,
    };
    if (args.size && r.kind === 'worktree') {
      const measured = measureTree(r.path);
      row.files = measured.files;
      row.sizeBytes = measured.bytes;
      row.size = humanSize(measured.bytes);
    }
    rows.push(row);
  }

  const residueRows = state.residue.map((entry) => {
    const measured = args.size ? measureTree(entry.path) : null;
    // PRI-796 review: taskIdentityFromBranch returns null for a non-ai/ branch
    // (e.g. a manually recovered name) — never surface `null` as the task cell;
    // fall back to the recovered branch itself, then the residue directory.
    const identity = entry.recoveredBranch ? taskIdentityFromBranch(entry.recoveredBranch) : null;
    return {
      task: identity || entry.recoveredBranch || path.basename(entry.path),
      kind: 'residue',
      writer: entry.leaseOwner ? parseWriterOwner(entry.leaseOwner)?.writer || entry.leaseOwner : '-',
      state: 'UNKNOWN',
      residueClass: entry.residueClass,
      dirty: '?',
      pr: entry.pr ? '#' + entry.pr.number + ' ' + entry.pr.state : '-',
      lock: '?',
      ready: '?',
      cleanup: 'REVIEW',
      branch: entry.recoveredBranch || null,
      path: entry.path,
      evidence: entry.evidence,
      reasons: entry.reasons,
      ...(measured ? { files: measured.files, sizeBytes: measured.bytes, size: humanSize(measured.bytes) } : {}),
    };
  });

  const primary = state.primaryRecord;
  const primaryView = primary
    ? {
        status: primary.porcelain === null ? 'ERROR' : primary.porcelain.trim().length > 0 ? 'DIRTY' : 'OK',
        branch: primary.branch,
        dirty: dirtyLabel(primary.porcelain),
      }
    : { status: 'ERROR', branch: null, dirty: '?' };

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date(state.now).toISOString(),
          primary: primaryView,
          poolRoot: state.poolRoot,
          slots: rows,
          unknownResidue: residueRows,
          counts: rows.reduce((acc, r) => {
            acc[r.internalState] = (acc[r.internalState] || 0) + 1;
            return acc;
          }, {}),
          ghAvailable: state.ghAvailable,
          notes: state.notes,
        },
        null,
        2
      )
    );
    return;
  }

  const lines = [];
  lines.push('PD WORKSPACE SNAPSHOT   ' + new Date(state.now).toISOString());
  lines.push('primary: ' + state.primaryPath + '  [' + primaryView.status + ', branch ' + (primaryView.branch || 'detached') + ']');
  lines.push('pool:    ' + state.poolRoot);
  lines.push('');

  const header = ['TASK', 'WRITER', 'STATE', 'DIRTY', 'PR', 'LOCK', 'READY', 'CLEANUP'];
  if (args.size) header.push('FILES', 'SIZE');
  const table = rows.map((r) => {
    const cells = [r.task, r.writer, r.state, r.dirty, r.pr, r.lock, r.ready, r.cleanup];
    if (args.size) cells.push(String(r.files ?? ''), String(r.size ?? ''));
    return cells;
  });
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length), 0));
  const renderRow = (cells) => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  lines.push(renderRow(header));
  for (const row of table) lines.push(renderRow(row));
  lines.push('');

  if (residueRows.length > 0) {
    lines.push('UNKNOWN residue — report only, never removed automatically (' + residueRows.length + ')');
    for (const r of residueRows) {
      lines.push('  ' + r.task + '  [' + r.residueClass + ']');
      lines.push('    path: ' + r.path);
      if (r.branch) lines.push('    branch (recovered from lease): ' + r.branch);
      for (const e of r.evidence) lines.push('    evidence: ' + e);
      for (const reason of r.reasons) lines.push('    note: ' + reason);
      if (r.size) lines.push('    size: ' + r.files + ' files, ' + r.size);
      lines.push('    delete: npm run dev:workspace:cleanup -- --residue "' + r.path + '" --ack-unknown --apply');
    }
    lines.push('');
  }

  lines.push('legend: STATE — ACTIVE (live) | PENDING (completion proven, blocked) | CLEANUP_READY (safe to delete) | UNKNOWN (never auto-deleted)');
  for (const row of rows) {
    if (row.lock === 'STALE' && row.lockNextAction) {
      lines.push('lock: ' + row.task + ' — ' + row.lockDetail);
      lines.push('  next: ' + row.lockNextAction);
    }
  }
  for (const note of state.notes) lines.push('Note: ' + note);
  console.log(lines.join('\n'));
}

const isMain = process.argv[1] && process.argv[1].endsWith('worktree-snapshot.mjs');
if (isMain) {
  await main();
}
