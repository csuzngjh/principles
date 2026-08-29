// Create an isolated task worktree for implementation work (AGENTS.md §23A).
//
// One task = one worktree + one owned branch, based on the LATEST origin/main
// (never a possibly-stale local main). Git itself stays the ownership
// registry — this tool creates state, it does not track it in any database.
//
// Bootstrapping (PATH fix, private docs, npm install, build) stays owned by
// scripts/setup-worktree.mjs; this tool prints the follow-up command.
//
// Usage:
//   node scripts/dev/create-task-worktree.mjs <task-id> <slug> [--base <ref>] [--offline] [--json]
//   npm run dev:worktree -- PRI-123 some-task
//
//   task-id  Linear id (e.g. PRI-123), or 'adhoc' → adhoc-YYYYMMDD prefix
//   slug     lowercase [a-z0-9-] short description
//   --base   optional base ref (default: origin/main)
//   --offline  skip `git fetch` (use the cached origin/* refs; only when the
//              network is unavailable and a stale base is consciously accepted)
//
// Branch:  ai/<task-id>-<slug>
// Worktree: <sibling-of-primary>/<repo>-<task-id>-<slug>

import fs from 'node:fs';
import path from 'node:path';
import { findPrimaryWorktree, runGit } from './lib/git.mjs';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseArgs(argv) {
  const args = { task: null, slug: null, base: 'origin/main', offline: false, json: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--base') {
      args.base = rest[++i];
      if (!args.base) {
        console.error('--base requires a ref argument');
        process.exit(2);
      }
    } else if (arg === '--offline') {
      args.offline = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/dev/create-task-worktree.mjs <task-id> <slug> [--base <ref>] [--offline] [--json]');
      process.exit(0);
    } else if (args.task === null) {
      args.task = arg;
    } else if (args.slug === null) {
      args.slug = arg;
    } else {
      console.error('Unexpected argument: ' + arg);
      process.exit(2);
    }
  }
  if (!args.task || !args.slug) {
    console.error('Usage: node scripts/dev/create-task-worktree.mjs <task-id> <slug> [--base <ref>] [--offline] [--json]');
    console.error('Example: npm run dev:worktree -- PRI-123 some-task');
    process.exit(2);
  }
  return args;
}

function fail(args, message, nextAction) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: message, nextAction }, null, 2));
  } else {
    console.error('[create-task-worktree] FAIL: ' + message);
    if (nextAction) console.error('  next: ' + nextAction);
  }
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!TASK_ID_RE.test(args.task)) {
    fail(args, "Invalid task id '" + args.task + "' (allowed: letters, digits, '.', '_', '-').", null);
  }
  if (!SLUG_RE.test(args.slug)) {
    fail(args, "Invalid slug '" + args.slug + "' (allowed: lowercase letters, digits, '-').", null);
  }

  const taskPart = args.task === 'adhoc' ? 'adhoc-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') : args.task;
  const branch = 'ai/' + taskPart + '-' + args.slug;

  const cwd = process.cwd();
  let primary;
  try {
    primary = await findPrimaryWorktree(cwd);
  } catch (err) {
    fail(args, 'Could not identify the primary worktree: ' + (err && err.message), 'Run from any worktree of the PD repository.');
  }

  if (!args.offline) {
    const fetchOut = await runGit(['fetch', 'origin', '--prune'], { cwd, allowFailure: true });
    if (fetchOut === null) {
      fail(
        args,
        'git fetch origin --prune failed — refusing to base a task worktree on a possibly stale view of origin.',
        'Fix network/credentials and retry, or pass --offline to consciously accept the cached origin refs.'
      );
    }
  }

  const baseSha = (await runGit(['rev-parse', '--verify', args.base + '^{commit}'], { cwd, allowFailure: true }))?.trim();
  if (!baseSha) {
    fail(args, "Base ref '" + args.base + "' does not resolve to a commit.", 'Check the ref exists (git fetch first) or pass --base <ref>.');
  }

  const existingBranch = await runGit(['rev-parse', '--verify', 'refs/heads/' + branch], { cwd, allowFailure: true });
  if (existingBranch !== null) {
    fail(args, "Branch '" + branch + "' already exists.", 'Pick a different slug, or clean up the existing task: npm run dev:worktree:cleanup -- ' + branch);
  }

  const worktreePath = path.join(path.dirname(primary.path), path.basename(primary.path) + '-' + taskPart + '-' + args.slug);
  if (fs.existsSync(worktreePath)) {
    fail(
      args,
      'Worktree path already exists: ' + worktreePath,
      'Remove the unneeded directory manually after reviewing its contents, or pick a different slug.'
    );
  }

  // Validate the target parent directory is writable before asking git to
  // create anything there (fail before mutation, not after).
  const parentDir = path.dirname(worktreePath);
  if (!fs.existsSync(parentDir)) {
    fail(args, 'Parent directory does not exist: ' + parentDir, 'Create the task worktree next to the primary checkout.');
  }

  let addError = '';
  try {
    await runGit(['worktree', 'add', '-b', branch, worktreePath, baseSha], { cwd });
  } catch (err) {
    addError = err && err.message ? err.message : String(err);
  }
  if (addError) {
    const partiallyCreated = fs.existsSync(worktreePath);
    fail(
      args,
      'git worktree add failed' + (partiallyCreated ? ' — worktree may be partially created; inspect it manually' : '') + ':\n' + addError,
      'Resolve the git error above, then retry, or run: git worktree add -b ' + branch + ' ' + worktreePath + ' ' + baseSha
    );
  }

  const summary = {
    ok: true,
    worktree: worktreePath,
    branch,
    base: baseSha,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('[create-task-worktree] ok');
    console.log('  worktree: ' + summary.worktree);
    console.log('  branch:   ' + summary.branch);
    console.log('  base:     ' + summary.base + ' (' + args.base + ')');
    console.log('next steps:');
    console.log('  cd ' + summary.worktree);
    console.log('  node scripts/setup-worktree.mjs   # PATH/private-docs/npm install/build bootstrap');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('create-task-worktree.mjs');
if (isMain) {
  await main();
}
