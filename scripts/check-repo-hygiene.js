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
  // Add entries here if absolutely necessary, with clear justification
  // Example: 'packages/test/fixtures/.tmp/allowed.fixture'
]);

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
 * Main entry point.
 */
function main() {
  const mode = process.argv[2] || 'staged';
  const files = mode === 'all' ? getAllTrackedFiles() : getStagedFiles();

  const violations = [];

  for (const file of files) {
    const reason = checkFile(file);
    if (reason) {
      violations.push({ file, reason });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}