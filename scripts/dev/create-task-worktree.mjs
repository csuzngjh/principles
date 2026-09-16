// Create an isolated task worktree for implementation work (AGENTS.md §23A
// git-1, git-10..git-12; PRI-796).
//
// One task = one worktree + one owned branch, based on the LATEST origin/main
// (never a possibly-stale local main). Git itself stays the ownership registry —
// this tool creates state, it does not track it in any database.
//
// PRI-796 changes the LIFECYCLE, not the ownership model:
//   * the worktree lands in the SHARED POOL derived from the primary checkout
//     (`<parent>/_worktrees/<repo>/<task>-<slug>`), never as an ad-hoc sibling —
//     no path is hardcoded, `PD_WORKTREE_ROOT` overrides the pool;
//   * directory name == task identity (no repeated repo/branch prefix) so
//     `Task -> Branch -> Worktree` is one stable mapping across AI IDEs;
//   * a Git-LFS preflight runs BEFORE git touches the filesystem, so a missing
//     toolchain cannot leave a half-filtered checkout behind;
//   * the base ref is PROVEN fresh (fetch result == remote-tracking ref) instead
//     of being trusted; an unexplainable disagreement is REF_INCONSISTENT;
//   * `git worktree add` runs under the repo mutation mutex — the one operation
//     here that writes shared Git metadata. The mutex is released before the
//     (minutes-long) bootstrap, which must never hold it;
//   * target conflicts are TAXONOMISED (registered worktree / residue / plain
//     directory / local branch / remote branch) instead of collapsing into
//     "already exists, pick another slug".
//
// Bootstrapping is delegated to bootstrap-worktree.mjs (which delegates to
// scripts/setup-worktree.mjs and then verifies readiness). A bootstrap failure
// never deletes the worktree it just created: the state is reported as
// CREATED_NOT_READY with an exact next action, because a half-built worktree is
// recoverable while a deleted one is not.
//
// Usage:
//   node scripts/dev/create-task-worktree.mjs <task-id> <slug> [--base <ref>] [--offline] [--skip-bootstrap] [--json]
//   npm run dev:worktree -- PRI-123 some-task
//
//   task-id  Linear id (e.g. PRI-123), or 'adhoc'
//   slug     lowercase [a-z0-9-] short description
//   --base   optional base ref (default: origin/main)
//   --offline  skip `git fetch` (use the cached origin refs; only when the
//              network is unavailable and a stale base is consciously accepted)
//   --skip-bootstrap  create + register only; bootstrap later
//
// Branch:   ai/<task-id>-<slug>   (adhoc: ai/adhoc-YYYYMMDD-<slug>-<rand6>)
// Worktree: <pool-root>/<task-id>-<slug>

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findPrimaryWorktree,
  gitCommonDirAbsolute,
  listWorktrees,
  runGit,
  sameGitPath,
} from './lib/git.mjs';
import { resolveTaskIdentity, resolveWorktreeRoot, worktreePathFor } from './lib/worktree-root.mjs';
import { withMutationLock } from './lib/git-mutation-lock.mjs';
import { CODES, assertRefFreshness, runToolchainPreflight } from './lib/preflight.mjs';

const DEFAULT_BASE = 'origin/main';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { task: null, slug: null, base: DEFAULT_BASE, offline: false, skipBootstrap: false, json: false };
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
    } else if (arg === '--skip-bootstrap') {
      args.skipBootstrap = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/dev/create-task-worktree.mjs <task-id> <slug> [--base <ref>] [--offline] [--skip-bootstrap] [--json]'
      );
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
    console.error('Usage: node scripts/dev/create-task-worktree.mjs <task-id> <slug> [--base <ref>] [--offline] [--skip-bootstrap] [--json]');
    console.error('Example: npm run dev:worktree -- PRI-123 some-task');
    process.exit(2);
  }
  return args;
}

function fail(args, code, message, nextAction) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, code, error: message, nextAction }, null, 2));
  } else {
    console.error('[create-task-worktree] FAIL (' + code + '): ' + message);
    if (nextAction) console.error('  next: ' + nextAction);
  }
  process.exit(1);
}

/**
 * Describe what already occupies the target path, so the operator gets a real
 * diagnosis instead of "already exists". SPEC §6.1 D.
 *
 * @returns {{kind: string, detail: string, nextAction: string}}
 */
export function classifyPathConflict(dir, { worktrees, primaryPath }) {
  if (!fs.existsSync(dir)) return { kind: 'free', detail: '', nextAction: '' };

  const registered = worktrees.find((w) => sameGitPath(w.path, dir));
  if (registered) {
    return {
      kind: 'registered-worktree',
      detail: 'the path is a registered worktree' + (registered.branch ? ' on ' + registered.branch : ''),
      nextAction:
        'Inspect it with `npm run dev:workspace:snapshot`; if that task is finished use ' +
        '`npm run dev:worktree:cleanup -- ' + (registered.branch || dir) + '`, otherwise pick a different slug.',
    };
  }

  if (sameGitPath(dir, primaryPath)) {
    return {
      kind: 'primary-checkout',
      detail: 'the path is the primary checkout',
      nextAction: 'The primary checkout is the control plane — choose a different task path.',
    };
  }

  // A worktree shell whose admin metadata is gone: `git worktree repair` cannot
  // recover it (PRI-796 Reality Audit §2.4) — report-and-ack only.
  const gitFile = path.join(dir, '.git');
  let isFile = false;
  try {
    isFile = fs.statSync(gitFile).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    let target = null;
    try {
      const match = /^\s*gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(gitFile, 'utf-8'));
      target = match ? match[1].trim() : null;
    } catch {
      target = null;
    }
    if (target && !fs.existsSync(target)) {
      return {
        kind: 'residue',
        detail: 'a worktree shell whose admin metadata is missing (dead gitdir: ' + target + ')',
        nextAction:
          'This is UNKNOWN residue and is never removed automatically. Review it with ' +
          '`npm run dev:workspace:snapshot`, then remove it explicitly with --ack-unknown, or pick a different slug.',
      };
    }
  }

  return {
    kind: 'plain-directory',
    detail: 'the path exists and is not a registered worktree or worktree shell',
    nextAction: 'Review its contents yourself; this tool never deletes an unclassified directory. Or pick a different slug.',
  };
}

async function main() {
  const args = parseArgs(process.argv);

  let identity;
  try {
    identity = resolveTaskIdentity({ task: args.task, slug: args.slug });
  } catch (err) {
    fail(args, CODES.ENVIRONMENT_INVALID, String((err && err.message) || err), null);
  }
  const { branch, dirName } = identity;

  const cwd = process.cwd();
  let primary;
  try {
    primary = await findPrimaryWorktree(cwd);
  } catch (err) {
    fail(
      args,
      CODES.ENVIRONMENT_INVALID,
      'Could not identify the primary worktree: ' + (err && err.message),
      'Run from any worktree of the PD repository.'
    );
  }

  const { root: poolRoot, source: poolSource } = resolveWorktreeRoot({ primaryPath: primary.path, env: process.env });
  const worktreePath = worktreePathFor({ root: poolRoot, dirName });

  // ---- Preflight: toolchain, BEFORE anything touches the filesystem ----
  const toolchain = await runToolchainPreflight({ repoRoot: primary.path, cwd });
  if (!toolchain.ok) {
    fail(args, toolchain.code, toolchain.error, toolchain.nextAction);
  }

  // ---- Preflight: base ref freshness ----
  let baseSha;
  let freshness;
  if (args.base === DEFAULT_BASE) {
    const fresh = await assertRefFreshness({ cwd, branch: 'main', offline: args.offline });
    if (!fresh.ok) {
      fail(args, fresh.code, fresh.error, fresh.nextAction);
    }
    baseSha = fresh.sha;
    freshness = fresh.freshness;
  } else {
    if (!args.offline) {
      const fetched = await runGit(['fetch', 'origin', '--prune'], { cwd, allowFailure: true });
      if (fetched === null) {
        fail(
          args,
          CODES.ENVIRONMENT_INVALID,
          'git fetch origin --prune failed — refusing to base a task worktree on a possibly stale view of origin.',
          'Fix network/credentials and retry, or pass --offline to consciously accept the cached origin refs.'
        );
      }
    }
    baseSha = (await runGit(['rev-parse', '--verify', args.base + '^{commit}'], { cwd, allowFailure: true }))?.trim();
    if (!baseSha) {
      fail(
        args,
        CODES.ENVIRONMENT_INVALID,
        "Base ref '" + args.base + "' does not resolve to a commit.",
        'Check the ref exists (git fetch first) or pass --base <ref>.'
      );
    }
    freshness = args.offline ? 'offline-cached' : 'fetched';
  }

  // ---- Conflict taxonomy: branch + path ----
  const worktrees = await listWorktrees(cwd);
  if ((await runGit(['rev-parse', '--verify', 'refs/heads/' + branch], { cwd, allowFailure: true })) !== null) {
    fail(
      args,
      CODES.CHECK_FAILED,
      "Branch '" + branch + "' already exists locally.",
      'Pick a different slug, or clean up the existing task: npm run dev:worktree:cleanup -- ' + branch
    );
  }
  if ((await runGit(['rev-parse', '--verify', 'refs/remotes/origin/' + branch], { cwd, allowFailure: true })) !== null) {
    fail(
      args,
      CODES.CHECK_FAILED,
      "Branch '" + branch + "' already exists on origin.",
      'That task already has history on the remote. Pick a different slug, or check out the existing branch instead of creating a new one.'
    );
  }

  const pathConflict = classifyPathConflict(worktreePath, { worktrees, primaryPath: primary.path });
  if (pathConflict.kind !== 'free') {
    fail(
      args,
      CODES.CHECK_FAILED,
      'Target path is not usable (' + pathConflict.kind + '): ' + worktreePath + '\n  ' + pathConflict.detail,
      pathConflict.nextAction
    );
  }

  // The pool is ours by design, so creating it is expected setup, not a surprise.
  try {
    fs.mkdirSync(poolRoot, { recursive: true });
  } catch (err) {
    fail(
      args,
      CODES.ENVIRONMENT_INVALID,
      'Could not create the worktree pool at ' + poolRoot + ': ' + String((err && err.message) || err),
      'Check permissions on ' + path.dirname(poolRoot) + ', or point PD_WORKTREE_ROOT at a writable directory.'
    );
  }

  // ---- The only shared-Git-metadata mutation: under the mutex ----
  const commonDir = await gitCommonDirAbsolute(cwd);
  let addError = '';
  try {
    await withMutationLock({ commonDir, operation: 'worktree-add', target: worktreePath }, async () => {
      // Re-check inside the critical section: another process may have won a race
      // between the taxonomy check above and the lock.
      if (fs.existsSync(worktreePath)) {
        throw new Error('target path appeared while waiting for the mutation lock: ' + worktreePath);
      }
      const raced = (await runGit(['rev-parse', '--verify', 'refs/heads/' + branch], { cwd, allowFailure: true })) !== null;
      if (raced) {
        throw new Error("branch '" + branch + "' was created while waiting for the mutation lock");
      }
      await runGit(['worktree', 'add', '-b', branch, worktreePath, baseSha], { cwd });
    });
  } catch (err) {
    addError = err && err.message ? err.message : String(err);
  }
  if (addError) {
    const partiallyCreated = fs.existsSync(worktreePath);
    fail(
      args,
      CODES.CHECK_FAILED,
      'git worktree add failed' +
        (partiallyCreated ? ' — the worktree may be partially created; inspect it manually' : '') +
        ':\n' + addError,
      'Resolve the git error above, then retry, or run: git worktree add -b ' + branch + ' ' + worktreePath + ' ' + baseSha
    );
  }

  // ---- Bootstrap (outside the mutex: minutes long, never held) ----
  let bootstrap;
  if (args.skipBootstrap) {
    bootstrap = { skipped: true };
  } else {
    const bootstrapScript = path.join(HERE, 'bootstrap-worktree.mjs');
    if (!fs.existsSync(bootstrapScript)) {
      bootstrap = { ran: false, ok: false, error: 'bootstrap-worktree.mjs not found next to this tool: ' + bootstrapScript };
    } else {
      const proc = spawnSync(process.execPath, [bootstrapScript, worktreePath, '--json'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let parsed = null;
      try {
        parsed = JSON.parse(proc.stdout || '');
      } catch {
        parsed = null;
      }
      bootstrap = { ran: true, ok: proc.status === 0 && Boolean(parsed?.ok), exitCode: proc.status };
    }
  }

  const state = args.skipBootstrap ? 'CREATED' : bootstrap.ok ? 'READY' : 'CREATED_NOT_READY';
  const summary = {
    ok: true,
    state,
    worktree: worktreePath,
    branch,
    base: baseSha,
    baseRef: args.base,
    freshness,
    pool: { root: poolRoot, source: poolSource },
    bootstrap,
    nextAction:
      state === 'CREATED_NOT_READY'
        ? 'npm run dev:worktree:bootstrap -- "' + worktreePath + '"  (then re-check with: npm run dev:worktree:ready)'
        : state === 'CREATED'
          ? 'npm run dev:worktree:bootstrap -- "' + worktreePath + '"'
          : null,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('[create-task-worktree] ' + state);
    console.log('  worktree:  ' + worktreePath);
    console.log('  branch:    ' + branch);
    console.log('  base:      ' + baseSha + ' (' + args.base + ', ' + freshness + ')');
    console.log('  pool root: ' + poolRoot + (poolSource === 'env' ? '  (from PD_WORKTREE_ROOT)' : ''));
    if (state === 'CREATED_NOT_READY') {
      console.log('  bootstrap: FAILED — the worktree was NOT deleted; finish it with the command below');
    }
    console.log('next steps:');
    console.log('  cd ' + worktreePath);
    console.log('  npm run dev:worktree:claim -- --writer <workbuddy|codex|zcode|trae|human|other>');
    if (summary.nextAction) console.log('  ' + summary.nextAction);
  }

  // Created-but-not-ready is a legitimate outcome to report, but the exit code
  // must not claim success.
  process.exit(state === 'CREATED_NOT_READY' ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1].endsWith('create-task-worktree.mjs');
if (isMain) {
  await main();
}
