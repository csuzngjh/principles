// `npm run dev:worktree:claim [-- <path>] --writer <label>` (PRI-796, SPEC §10).
//
// Declares "this AI (or human) is the current writer of this task slot".
// Takes the PD write lease AND the Git-native worktree lock, so both PD sessions
// and stock git commands respect the claim.
//
// Writer labels are a closed set — workbuddy | codex | zcode | trae | human | other —
// because the slot's identity is `Task -> Branch -> Worktree` and only the
// CURRENT WRITER may change (SPEC D4). Nothing here depends on an IDE session id.
//
// Exit codes: 0 = claimed, 1 = refused/conflict, 2 = usage error.

import { claimWriter, resolveSlot } from './lib/writer-claim.mjs';
import { DEFAULT_TTL_MS, WRITER_LABELS } from './lib/workspace-lease.mjs';

function parseArgs(argv) {
  const args = { target: null, writer: null, ttlHours: null, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--writer') {
      const value = rest[++i];
      // PRI-796 review: `--writer --json` must be a usage error (exit 2), not
      // silently consuming the next flag as the label.
      if (!value || value.startsWith('--')) {
        console.error('--writer requires a label (' + WRITER_LABELS.join('|') + ')');
        process.exit(2);
      }
      args.writer = value;
    } else if (arg === '--ttl-hours') {
      const rawValue = rest[++i];
      const value = rawValue && !rawValue.startsWith('--') ? Number(rawValue) : Number.NaN;
      if (!Number.isFinite(value) || value <= 0) {
        console.error('--ttl-hours requires a positive number');
        process.exit(2);
      }
      args.ttlHours = value;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/worktree-claim.mjs [<worktree-path>] --writer <' + WRITER_LABELS.join('|') + '> [--ttl-hours <n>] [--json]');
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
  if (!args.writer) {
    console.error('Usage: node scripts/dev/worktree-claim.mjs [<worktree-path>] --writer <' + WRITER_LABELS.join('|') + '> [--ttl-hours <n>] [--json]');
    console.error('Example: npm run dev:worktree:claim -- --writer workbuddy');
    process.exit(2);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  let slot;
  try {
    slot = await resolveSlot({ target: args.target });
  } catch (err) {
    const message = 'not inside a resolvable git worktree: ' + String((err && err.message) || err);
    if (args.json) console.log(JSON.stringify({ ok: false, code: 'ENVIRONMENT_INVALID', error: message }, null, 2));
    else console.error('[worktree-claim] FAIL (ENVIRONMENT_INVALID): ' + message);
    process.exit(1);
  }

  const ttlMs = args.ttlHours !== null ? args.ttlHours * 60 * 60 * 1000 : DEFAULT_TTL_MS;
  const result = await claimWriter({ slot, writer: args.writer, ttlMs });

  if (!result.ok) {
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.error('[worktree-claim] FAIL: ' + result.error);
      if (result.nextAction) console.error('  next: ' + result.nextAction);
    }
    process.exit(1);
  }

  const payload = {
    ok: true,
    action: result.action,
    owner: result.owner,
    writer: args.writer,
    task: slot.task,
    worktree: slot.root,
    branch: slot.branch,
    locked: true,
    lockReason: result.lock.reason,
    lockReasserted: Boolean(result.lock.reasserted),
    expiresAt: result.lease.expiresAt,
  };
  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('[worktree-claim] ' + result.action + ': owner=' + result.owner);
    console.log('  worktree: ' + slot.root);
    console.log('  branch:   ' + slot.branch);
    console.log('  git lock: held (' + result.lock.reason + ')');
    console.log('  expires:  ' + result.lease.expiresAt);
    console.log('  release:  npm run dev:worktree:release' + (args.target ? ' -- ' + args.target : ''));
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('worktree-claim.mjs');
if (isMain) {
  await main();
}
