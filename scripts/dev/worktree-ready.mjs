// `npm run dev:worktree:ready [-- <path>] [--json]` (PRI-796, SPEC §8).
//
// Read-only readiness verdict for a worktree: L1 dependencies, L2 build,
// L3 runtime resolution, with PRIMARY_LEAKAGE as a hard gate. Fast enough to run
// on every branch switch (that is what the post-checkout hook does with it) and
// safe to run against another worktree without touching it.
//
// Exit codes: 0 = READY, 1 = NOT_READY, 2 = usage error.

import path from 'node:path';
import { getGitContext } from './lib/git.mjs';
import { checkReadiness, renderReadiness } from './lib/readiness.mjs';

function parseArgs(argv) {
  const args = { target: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/worktree-ready.mjs [<worktree-path>] [--json]');
      process.exit(0);
    } else if (arg.startsWith('-')) {
      console.error('Unknown argument: ' + arg);
      process.exit(2);
    } else if (args.target === null) {
      args.target = arg;
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Resolve the worktree root to inspect.
 * With an explicit path we must NOT require the caller to be inside it (the
 * snapshot and migration tools inspect other trees); we only need the directory
 * to look like a PD checkout.
 */
export async function resolveTargetRoot(target) {
  if (target) {
    return path.resolve(target);
  }
  const ctx = await getGitContext(process.cwd());
  return ctx.toplevel || ctx.cwd;
}

async function main() {
  const args = parseArgs(process.argv);
  let root;
  try {
    root = await resolveTargetRoot(args.target);
  } catch (err) {
    console.error('[worktree-ready] FAIL: not inside a git worktree: ' + String((err && err.message) || err));
    process.exit(2);
  }

  let primaryPath = null;
  try {
    const ctx = await getGitContext(process.cwd());
    primaryPath = ctx.isPrimary ? ctx.toplevel || ctx.cwd : primaryPath;
  } catch {
    // Running from outside any repo is fine — primary is only used for reporting.
  }

  let report;
  try {
    report = checkReadiness({ worktreeRoot: root, primaryPath });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (args.json) console.log(JSON.stringify({ ok: false, code: 'ENVIRONMENT_INVALID', error: message }, null, 2));
    else console.error('[worktree-ready] FAIL (ENVIRONMENT_INVALID): ' + message);
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReadiness(report));
  }
  process.exit(report.ok ? 0 : 1);
}

const isMain = process.argv[1] && process.argv[1].endsWith('worktree-ready.mjs');
if (isMain) {
  await main();
}
