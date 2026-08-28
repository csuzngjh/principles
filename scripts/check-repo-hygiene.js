#!/usr/bin/env node
/**
 * Repository Hygiene Gate — PRI-379
 *
 * Fails when tracked changes include:
 * - Temporary files (.tmp/**)
 * - Linear comment drafts (*linear-comment*.md)
 * - PD runtime databases/state artifacts
 *
 * ERR-002: Fail loud with reason and nextAction.
 */

import { execFileSync } from 'node:child_process';

// Denylist patterns that should never be committed
// Order matters: more specific patterns first
export const DENYLIST = [
  {
    pattern: /.*linear-comment.*\.md$/,
    reason: 'Linear comment drafts must not be committed',
  },
  {
    pattern: /^\.tmp\/.*/,
    reason: 'Temporary files must not be committed',
  },
  {
    pattern: /\.state\//,
    reason: 'Runtime state directories must not be committed',
  },
  {
    pattern: /\.pd\/state\.db$/,
    reason: 'PD runtime state database must not be committed',
  },
  {
    pattern: /\.pd\/trajectory\.db$/,
    reason: 'PD runtime trajectory database must not be committed',
  },
  {
    pattern: /\.pd\/pd-store\.db$/,
    reason: 'PD runtime store database must not be committed',
  },
  {
    pattern: /\.pd\/sessions\.db$/,
    reason: 'PD runtime sessions database must not be committed',
  },
  {
    pattern: /\.hygiene-quarantine/,
    reason: 'Hygiene quarantine directories must not be committed',
  },
];

// Allowlist for legitimate fixtures that match denylist patterns
// REQUIRE: Comment explaining why this is allowed
export const ALLOWLIST = new Set([
  // Template seed file: empty WORKBOARD scaffolded by `pd init` into user workspace .state/.
  // Referenced by paths.ts (WORKBOARD path constant), path-resolver.ts, and init-refactor.test.ts.
  // Not a runtime artifact — this is the *template* that gets copied, not a live DB.
  'packages/openclaw-plugin/templates/workspace/.state/WORKBOARD.json',
]);

// Large file detection — files exceeding this size (in bytes) are rejected
// unless they match LFS tracking patterns (see LFS_PATTERNS below).
// Rationale: prevent accidental commits of build artifacts, binaries, media.
export const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

// File patterns managed by Git LFS — exempt from large file rejection.
// Keep in sync with .gitattributes LFS filter lines.
export const LFS_PATTERNS = [
  /\.mp4$/i,
  /\.webm$/i,
  /\.webp$/i,
  /\.png$/i,  // website assets, may be large
  /\.mp3$/i,
  /\.wav$/i,
];

function gitLines(args) {
  try {
    const output = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
    return output.length === 0 ? [] : output.split(/\r?\n/u);
  } catch (error) {
    // If git command fails (e.g., no staged files), return empty
    return [];
  }
}

/**
 * Get staged files that will be included in the next commit.
 * This is the right scope for pre-commit and pre-push hooks.
 */
function getStagedFiles() {
  // Get all staged files (added, copied, modified, renamed)
  return gitLines(['diff', '--name-only', '--cached', '--diff-filter=ACMR']);
}

/**
 * Get all tracked files for CI/PR verification.
 * This is the right scope for npm run verify:merge.
 */
function getAllTrackedFiles() {
  return gitLines(['ls-files']);
}

/**
 * Normalize path separators to forward slashes for consistent matching.
 */
function normalizePath(path) {
  return path.replace(/\\/g, '/');
}

/**
 * Check if a file violates any denylist rule.
 * Returns the violation reason or null if allowed.
 */
export function checkFile(filePath) {
  const normalized = normalizePath(filePath);

  // Check allowlist first
  if (ALLOWLIST.has(normalized)) {
    return null;
  }

  // Check denylist
  for (const rule of DENYLIST) {
    if (rule.pattern.test(normalized)) {
      return rule.reason;
    }
  }

  return null;
}

/**
 * Check if a file path matches Git LFS tracking patterns.
 * LFS-tracked files are exempt from the large file size check.
 */
function isLfsTracked(filePath) {
  const normalized = normalizePath(filePath);
  return LFS_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Get the size (in bytes) of a staged file's blob in the index.
 * Uses `git cat-file -s :0:<file>` to read the staged blob size.
 * Returns 0 if the file is not in the index or size cannot be determined.
 */
function getStagedFileSize(filePath) {
  try {
    const output = execFileSync('git', ['cat-file', '-s', `:0:${filePath}`], {
      encoding: 'utf8',
      maxBuffer: 1024,
    }).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check staged files for large non-LFS files.
 * Returns an array of violations: { file, sizeMB, reason }.
 *
 * ERR-002: Fail loud with reason and nextAction.
 */
export function checkLargeFiles(stagedFiles) {
  const violations = [];

  for (const file of stagedFiles) {
    // Skip LFS-tracked files (they are stored as pointers, not full blobs)
    if (isLfsTracked(file)) {
      continue;
    }

    const sizeBytes = getStagedFileSize(file);
    if (sizeBytes > LARGE_FILE_THRESHOLD) {
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
      violations.push({
        file,
        sizeMB,
        reason: `File is ${sizeMB} MB (exceeds ${LARGE_FILE_THRESHOLD / (1024 * 1024)} MB limit). Use Git LFS or remove from commit.`,
      });
    }
  }

  return violations;
}

/**
 * Worktree file integrity check — ERR-002 (fail loud).
 *
 * Detects the large-scale accident class we hit: tracked files present in the
 * index but absent on disk (`git ls-files -d`). This is the regression guard
 * that surfaces "N tracked files vanished" style incidents at the merge gate
 * instead of letting them pass silently. Also invoked by `npm run doctor`.
 *
 * Returns `{ missingFiles: string[] }`; an empty array means healthy.
 *
 * Unlike the gitLines() helper above (which intentionally swallows failures for
 * informational queries), this guard MUST distinguish "query completed, nothing
 * missing" from "query could not run". A swallowed failure here would make the
 * merge gate silently pass in exactly the states we are guarding against, so a
 * failed `git ls-files -d` throws and the caller reports it (rc-9: no silent
 * fallback). Optional `cwd` lets tests run the check in an isolated repo.
 */
export function checkWorktreeIntegrity({ cwd } = {}) {
  const output = execFileSync('git', ['ls-files', '-d'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  const trimmed = output.trim();
  return { missingFiles: trimmed.length === 0 ? [] : trimmed.split(/\r?\n/u) };
}

/**
 * Main entry point.
 */
function main() {
  const mode = process.argv[2] || 'staged';
  const files = mode === 'all' ? getAllTrackedFiles() : getStagedFiles();

  const violations = [];

  // 1. Denylist check (temp files, runtime DBs, etc.)
  for (const file of files) {
    const reason = checkFile(file);
    if (reason) {
      violations.push({ file, reason });
    }
  }

  // 2. Large file check (only for staged files — "all" mode is informational)
  if (mode === 'staged' && files.length > 0) {
    const largeViolations = checkLargeFiles(files);
    violations.push(...largeViolations);
  }

  // 3. Worktree integrity — fail loud on missing tracked files (all/merge mode).
  //    Guards against "N tracked files vanished from disk" accidents: the index
  //    still lists them, so a normal commit would silently break the tree.
  if (mode === 'all') {
    let missingFiles;
    try {
      ({ missingFiles } = checkWorktreeIntegrity());
    } catch (error) {
      console.error('[REPO HYGIENE] Failed - worktree integrity query did not complete\n');
      console.error(`Reason: ${error.message}`);
      console.error('\nNext action: verify git works in this checkout (git status), then re-run.');
      process.exit(1);
    }
    if (missingFiles.length > 0) {
      console.error(`[REPO HYGIENE] Failed - ${missingFiles.length} tracked files are missing from disk\n`);
      console.error('Reason: Files are present in the git index but absent on disk.');
      console.error('Sample of missing paths:');
      for (const file of missingFiles.slice(0, 20)) {
        console.error(`  - ${file}`);
      }
      if (missingFiles.length > 20) {
        console.error(`  …and ${missingFiles.length - 20} more`);
      }
      console.error('\nNext action: restore from the index (writes real files, never deletes):');
      console.error('  git restore <path>        # restore specific paths');
      console.error('  git restore -- packages/  # restore a whole tree');
      console.error('\nFull diagnosis entrypoint: npm run doctor');
      process.exit(1);
    }
  }

  if (violations.length > 0) {
    console.error('[REPO HYGIENE] Failed - forbidden files detected\n');
    console.error('Reason: These files should not be committed to the repository.\n');
    console.error('Offending paths:');
    for (const violation of violations) {
      console.error(`  - ${violation.file}`);
      console.error(`    Reason: ${violation.reason}`);
    }
    console.error('\nNext action: Remove these files from staging/commit:');
    console.error('  git restore --staged <file>');
    console.error('  git rm <file>  (if tracked)');
    console.error('\nOr if these are legitimate fixtures, add them to the ALLOWLIST with a clear justification comment.');
    process.exit(1);
  }

  console.log('[REPO HYGIENE] Passed - no forbidden files detected.');
}

if (process.argv[1] && process.argv[1].endsWith('check-repo-hygiene.js')) {
  main();
}