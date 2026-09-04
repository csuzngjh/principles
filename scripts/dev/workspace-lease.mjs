// Workspace write lease CLI (AGENTS.md §23A, git-9-lease-before-write).
//
// Acquire before writing in a checkout; release when done; status anytime:
//   npm run dev:lease -- acquire [--owner <text>] [--ttl-hours <n>] [--json]
//   npm run dev:lease -- status  [--json]
//   npm run dev:lease -- release [--json]
//
// acquire fails loudly when an ACTIVE lease is held by another owner, refuses
// the primary checkout (same PD_DEV_WORKTREE_ALLOW_PRIMARY emergency hatch as
// the worktree-guard) and is idempotent for the SAME owner (renewal).
// The lease is one gitignored JSON file — a human may always delete it.
//
// Exit codes: 0 = ok, 1 = conflict/refusal, 2 = usage error.

import { getGitContext } from './lib/git.mjs';
import {
  DEFAULT_TTL_MS,
  acquireLease,
  defaultOwner,
  leaseFilePath,
  leasePhase,
  readLease,
  releaseLease,
} from './lib/workspace-lease.mjs';

function parseArgs(argv) {
  const args = { command: null, owner: null, ttlHours: null, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/workspace-lease.mjs <acquire|status|release> [--owner <text>] [--ttl-hours <n>] [--json]');
      process.exit(0);
    } else if (arg === '--owner') {
      args.owner = rest[++i];
      if (!args.owner || args.owner.length === 0) {
        console.error('--owner requires a non-empty argument');
        process.exit(2);
      }
    } else if (arg === '--ttl-hours') {
      const value = Number(rest[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        console.error('--ttl-hours requires a positive number');
        process.exit(2);
      }
      args.ttlHours = value;
    } else if (args.command === null && ['acquire', 'status', 'release'].includes(arg)) {
      args.command = arg;
    } else {
      console.error('Unknown argument: ' + arg);
      process.exit(2);
    }
  }
  if (!args.command) {
    console.error('Usage: node scripts/dev/workspace-lease.mjs <acquire|status|release> [--owner <text>] [--ttl-hours <n>] [--json]');
    console.error('Example: npm run dev:lease -- acquire --owner "zcode/PRI-123 session"');
    process.exit(2);
  }
  return args;
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const ctx = await getGitContext(process.cwd());
  const root = ctx.toplevel || ctx.cwd;

  if (args.command === 'acquire') {
    if (ctx.isPrimary && process.env.PD_DEV_WORKTREE_ALLOW_PRIMARY !== '1') {
      const payload = {
        ok: false,
        error:
          'This is the PRIMARY checkout (' + ctx.cwd + ') — the repository control plane. ' +
          'Implementation writing belongs in a task worktree; refusing to grant a write lease here.',
        nextAction:
          'npm run dev:worktree -- <task> <slug>  (creates an isolated worktree). ' +
          'Human emergency override: PD_DEV_WORKTREE_ALLOW_PRIMARY=1 (AI agents must never set this).',
      };
      if (args.json) printJson(payload);
      else {
        console.error('[workspace-lease] FAIL: ' + payload.error);
        console.error('  next: ' + payload.nextAction);
      }
      process.exit(1);
    }
    const ttlMs = args.ttlHours !== null ? args.ttlHours * 60 * 60 * 1000 : DEFAULT_TTL_MS;
    const result = acquireLease(root, {
      owner: args.owner || defaultOwner(),
      branch: ctx.branch,
      ttlMs,
    });
    if (!result.ok) {
      if (args.json) printJson(result);
      else {
        console.error('[workspace-lease] FAIL: ' + result.error);
        console.error('  next: ' + result.nextAction);
      }
      process.exit(1);
    }
    if (args.json) printJson({ ok: true, action: result.action, lease: result.lease });
    else {
      console.log('[workspace-lease] ' + result.action + ': owner=' + result.lease.owner + ' branch=' + result.lease.branch);
      console.log('  expires: ' + result.lease.expiresAt);
      console.log('  file:    ' + leaseFilePath(root));
    }
    return;
  }

  if (args.command === 'status') {
    const current = readLease(root);
    let payload;
    if (!current.exists) {
      payload = { ok: true, lease: { state: 'none', file: leaseFilePath(root) } };
    } else if (!current.valid) {
      payload = { ok: true, lease: { state: 'invalid', file: leaseFilePath(root), error: current.error } };
    } else {
      const state = leasePhase(current.lease);
      payload = { ok: true, lease: { state, ...current.lease } };
    }
    if (args.json) printJson(payload);
    else console.log('[workspace-lease] state=' + payload.lease.state + (payload.lease.owner ? ' owner=' + payload.lease.owner : '') + (payload.lease.expiresAt ? ' expires=' + payload.lease.expiresAt : ''));
    return;
  }

  // release
  const result = releaseLease(root);
  if (args.json) printJson(result);
  else console.log('[workspace-lease] ' + (result.removed ? 'released (' + leaseFilePath(root) + ')' : 'no lease to release'));
}

const isMain = process.argv[1] && process.argv[1].endsWith('workspace-lease.mjs');
if (isMain) {
  await main();
}
