// `npm run dev:worktree:release [-- <path>]` (PRI-796, SPEC §10.2).
//
// Ends the writer claim on a task slot: releases the PD write lease and removes
// the Git-native worktree lock. Idempotent — running it twice, or against a slot
// that was never claimed, is a success that reports "nothing to change".
//
// Idempotence is the point: a crashed or interrupted session must not need a
// special recovery path just to hand a slot back.
//
// Exit codes: 0 = released (or nothing to release), 1 = refused, 2 = usage error.

import { releaseWriter, resolveSlot } from './lib/writer-claim.mjs';

function parseArgs(argv) {
  const args = { target: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/worktree-release.mjs [<worktree-path>] [--json]');
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

async function main() {
  const args = parseArgs(process.argv);

  let slot;
  try {
    slot = await resolveSlot({ target: args.target });
  } catch (err) {
    // A broken worktree shell cannot be released through git. Refusing is the
    // safe answer: its `.workspace-lease.json` is the last record of which task
    // branch the directory belonged to, and deleting it would destroy the
    // evidence the residue workflow needs.
    const message = 'not inside a resolvable git worktree: ' + String((err && err.message) || err);
    const nextAction =
      'If this directory is UNKNOWN residue (broken worktree metadata), do not "release" it — inspect it with ' +
      '`npm run dev:workspace:snapshot`. Its lease file is the only surviving record of its task branch.';
    if (args.json) console.log(JSON.stringify({ ok: false, code: 'ENVIRONMENT_INVALID', error: message, nextAction }, null, 2));
    else {
      console.error('[worktree-release] FAIL (ENVIRONMENT_INVALID): ' + message);
      console.error('  next: ' + nextAction);
    }
    process.exit(1);
  }

  const result = await releaseWriter({ slot });
  if (!result.ok) {
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.error('[worktree-release] FAIL: ' + result.error);
      if (result.nextAction) console.error('  next: ' + result.nextAction);
    }
    process.exit(1);
  }

  const changed = result.leaseRemoved || result.gitUnlocked;
  const payload = {
    ok: true,
    action: changed ? 'released' : 'no-op',
    worktree: slot.root,
    branch: slot.branch,
    previousOwner: result.owner,
    leaseStateBefore: result.leaseStateBefore,
    leaseRemoved: result.leaseRemoved,
    gitUnlocked: result.gitUnlocked,
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (changed) {
    console.log('[worktree-release] released');
    console.log('  worktree: ' + slot.root);
    console.log('  lease:    ' + (result.leaseRemoved ? 'removed' : 'nothing to remove'));
    console.log('  git lock: ' + (result.gitUnlocked ? 'removed' : 'was not locked'));
  } else {
    console.log('[worktree-release] no-op — this slot held no lease and no git lock');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('worktree-release.mjs');
if (isMain) {
  await main();
}
