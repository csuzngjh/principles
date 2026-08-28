#!/usr/bin/env node
/**
 * scripts/doctor.mjs — one-shot worktree health diagnosis.
 *
 * Run it before any substantial work or whenever you suspect files may have
 * vanished from disk:
 *
 *   node scripts/doctor.mjs        # or: npm run doctor
 *
 * It reports (without mutating anything):
 *   1. Tracked files present in the index but missing on disk
 *      (the "N files vanished" accident class) — FAIL loud with nextAction.
 *   2. Private-docs directory reachability
 *      (PD_PRIVATE_DOCS_DIR or ~/principles-private/docs) — INFO/ok.
 *   3. Interactive / core settings sanity — INFO only.
 *   4. Main-worktree safety hint against destructive git commands.
 *
 * Read-only by design: it never writes, deletes, or restores files. Recovery
 * guidance is printed, not executed.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkWorktreeIntegrity } from './check-repo-hygiene.js';
import { resolvePrivateDocsTarget, validateTarget } from './setup-private-docs-symlink.mjs';

/** Resolve the repo top-level from the current directory. */
function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** True when a custom hooks path is configured (post-checkout worktree setup). */
function hooksInstalled(root) {
  try {
    const hook = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
    }).trim();
    return hook.length > 0;
  } catch {
    return false;
  }
}

function main() {
  const root = repoRoot();
  if (!root) {
    console.error('[doctor] Not inside a git repository.');
    process.exit(1);
  }
  console.log(`[doctor] Diagnosing worktree: ${root}\n`);

  // --- 1. Tracked files present in the index but missing on disk ------------
  const { missingFiles } = checkWorktreeIntegrity();
  if (missingFiles.length > 0) {
    console.error(`[FAIL] ${missingFiles.length} tracked files are missing from disk:`);
    for (const f of missingFiles.slice(0, 20)) console.error(`  - ${f}`);
    if (missingFiles.length > 20) console.error(`  …and ${missingFiles.length - 20} more`);
    console.error('\nNext action (writes real files, never deletes):');
    console.error('  git restore <path>        # restore specific paths');
    console.error('  git restore -- packages/  # restore a whole tree');
    console.error('\nDo NOT run git clean -fdx / reset --hard / checkout -f to "fix" this.');
    process.exit(1);
  }
  console.log('[ok] All tracked files are present on disk.');

  // --- 2. Private-docs directory reachability ---------------------------------
  const privateDocsTarget = resolvePrivateDocsTarget();
  const validation = validateTarget(privateDocsTarget);
  if (validation.ok) {
    console.log(`[ok] Private docs reachable: ${privateDocsTarget}`);
  } else {
    console.warn(`[WARN] Private docs not reachable: ${validation.reason}`);
    console.warn('       Private docs are accessed DIRECTLY from the independent repo.');
    console.warn('       Next action: set PD_PRIVATE_DOCS_DIR env var, or clone so that');
    console.warn('       ~/principles-private/docs exists (default fallback).');
    console.warn('       There is no docs/.private junction — that model was retired in Aug 2026.');
  }

  // --- 3. Worktree-safe hooks ------------------------------------------------
  if (hooksInstalled(root)) {
    console.log('[ok] custom hooks path configured.');
  } else {
    console.warn('[WARN] no custom core.hooksPath configured; post-checkout worktree setup may not auto-run.');
  }

  // --- 4. Destructive-command safety hint -----------------------------------
  console.log(`\nReminder (never run in the main worktree):`);
  console.log('  git clean -fdx | git stash -a | git checkout -f | git reset --hard');
  console.log('These can orphan or delete tracked files on disk.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}