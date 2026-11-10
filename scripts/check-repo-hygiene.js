#!/usr/bin/env node
/**
 * Repository Hygiene Gate — PRI-379
 *
 * Fails when tracked changes include:
 * - Temporary files (.tmp/**)
 * - Linear comment drafts (*linear-comment*.md)
 * - PD runtime databases/state artifacts
 *
 * In `all`/merge mode it additionally checks the working tree itself:
 * - tracked files that vanished from disk
 * - untracked real files piled up at the checkout root
 *
 * ERR-002: Fail loud with reason and nextAction.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LEASE_FILENAME } from './dev/lib/workspace-lease.mjs';

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
 * Root entries that are legitimately real files but never tracked.
 * REQUIRE: a comment explaining why each one is local-only.
 */
export const ROOT_LOCAL_FILES = new Set([
  // Conventional per-worktree ignore file; a local dev worktree may carry
  // private ignores that must not be committed.
  '.gitignore',
  // ZCode CLI tool state, auto-synced from .gitignore by that tool on every
  // run. Deleting it only makes the tool rewrite it, so it is exempt, not junk.
  '.zcodeignore',
  // opencode CLI project config. Untracked on purpose: its `plugin` entry
  // points at `.opencode/plugins/`, which is ignored, so a tracked copy is a
  // dangling config for anyone cloning the repo. Existing checkouts that still
  // have a local copy must not be punished for it.
  'opencode.json',
  // The git-9 workspace write lease: PD's own multi-agent coordination state,
  // created at the checkout root by `npm run dev:lease` / worktree claim.
  // Name imported from the lease module so the two can never drift apart.
  LEASE_FILENAME,
]);

/**
 * Root-scruff check — the working-tree hole the other two rules cannot see.
 *
 * `ls-files` (mode all) and `diff --cached` (mode staged) only ever look at
 * files git tracks, so an agent's redirected run output (`npm run … > some.log`)
 * lands at the checkout root, matches a `*.log` ignore rule, and passes every
 * existing gate forever. See ERR-151 for the incident that exposed this.
 *
 * The invariant: the checkout root may only contain files this repository
 * actually tracks. A real file there that git does not track is somebody's
 * scratch output, no matter what .gitignore says about it.
 *
 * Directories are out of scope — local scratch/state roots (`.tmp/`,
 * `node_modules/`, `.pd/`) legitimately live at the root and are policed by
 * their own rules. Entries in ROOT_LOCAL_FILES are exempt: real local-only
 * tool state, not junk.
 *
 * Returns `{ scruffFiles: string[] }` of root entry names; empty means healthy.
 * Both git queries run at the toplevel so the tracked set and the directory
 * enumeration always describe the same base.
 *
 * A failed git or filesystem query throws (rc-9: no silent fallback — swallowing
 * it would make the merge gate pass in exactly the state being guarded against).
 */
export function checkRootScruffFiles({ cwd } = {}) {
  const gitOpts = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...(cwd ? { cwd } : {}) };
  const run = (args, opts = gitOpts) => execFileSync('git', args, opts);

  // Fail loudly if this is not a queryable repo; empty output means "no files",
  // which must never be produced by a broken query.
  const toplevel = run(['rev-parse', '--show-toplevel']).trim();
  if (toplevel.length === 0) {
    throw new Error('git rev-parse --show-toplevel returned no path');
  }

  const tracked = new Set(
    run(['ls-files'], { ...gitOpts, cwd: toplevel })
      .split(/\r?\n/u)
      .filter((line) => line.length > 0 && !line.includes('/')),
  );

  const scruffFiles = [];
  for (const entry of readdirSync(toplevel)) {
    // In a linked worktree `.git` is a gitdir POINTER FILE, not a directory;
    // the directory skip below would never see it and statSync would read the
    // pointer. It is git's own metadata and can never be somebody's scratch.
    if (entry === '.git') continue;
    if (tracked.has(entry) || ROOT_LOCAL_FILES.has(entry)) continue;
    if (statSync(join(toplevel, entry)).isDirectory()) continue;
    scruffFiles.push(entry);
  }

  return { scruffFiles };
}

// ── Adapter-layer test convention (see packages/principles-core/src/runtime/
//    adapter/__tests__/README.md) ────────────────────────────────────────────
// Adapter tests default to the Pi faux provider: the real stream runs against a
// scripted model. Mocking a chain module instead asserts the config object the
// adapter built, not what the provider received — the exact blind spot that let
// a dropped `maxTokens` pass 8/8 mocked tests. The mock itself is allowed (some
// contracts cannot be observed through faux), but only with a written reason:
//
//   // adapter-chain-mock-exempt: <why faux cannot cover this contract>
//
// This is a content rule, not a new gate: it runs inside the existing
// repo-hygiene check, which pre-commit and verify:merge already invoke.

/** Directory whose tests are held to the faux-by-default convention. */
export const ADAPTER_TEST_DIR = 'packages/principles-core/src/runtime/adapter/__tests__/';

const ADAPTER_TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/;

/** Modules whose wholesale mock replaces the real model chain. */
export const MODEL_CHAIN_MODULES = ['@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-agent-core'];

/** The harness factory that keeps the real module and redirects catalog lookups only. */
const HARNESS_FACTORY_MARKER = 'fauxCompatMockFactory';

export const CHAIN_EXEMPT_MARKER_RE = /adapter-chain-mock-exempt:/;
export const CHAIN_EXEMPT_RE = /adapter-chain-mock-exempt:[ \t]*(\S.*?)(?:\*\/|\}?)?[ \t]*$/m;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const CHAIN_MOCK_RE = new RegExp(
  String.raw`\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*['"](?:${MODEL_CHAIN_MODULES.map(escapeRegExp).join('|')})['"]`,
);

/** Line number (1-based) of a character offset. */
function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * Check one adapter test file against the faux-by-default convention.
 *
 * Pure (file content in, finding out) so it is unit-testable; the caller does
 * the I/O. Returns null when the file is compliant or out of scope.
 *
 * Fail-loud rules (rc-3): a marker without a reason is reported as its own
 * finding rather than silently accepted.
 *
 * @param {string} filePath - repository-relative path
 * @param {string} content - file contents
 * @returns {{ line: number, reason: string } | null}
 */
export function checkAdapterChainMock(filePath, content) {
  const normalized = normalizePath(filePath);
  if (!normalized.startsWith(ADAPTER_TEST_DIR) || !ADAPTER_TEST_FILE_RE.test(normalized)) return null;
  if (typeof content !== 'string') return null;

  const firstMock = CHAIN_MOCK_RE.exec(content);
  if (!firstMock) return null;

  if (CHAIN_EXEMPT_MARKER_RE.test(content)) {
    const markerIndex = content.search(CHAIN_EXEMPT_MARKER_RE);
    const markerLine = content.slice(markerIndex).split('\n')[0];
    const reasonMatch = CHAIN_EXEMPT_RE.exec(markerLine);
    if (!reasonMatch) {
      return {
        line: lineAt(content, markerIndex),
        reason: 'adapter-chain-mock-exempt marker has no reason; write why faux cannot cover this contract',
      };
    }
    return null;
  }

  // The harness factory is the sanctioned shape: real module kept, only
  // getModel/getProviders redirected. It may sit on a following line because
  // the factory is often a multi-line arrow.
  const window = content.slice(firstMock.index, firstMock.index + 400);
  if (window.includes(HARNESS_FACTORY_MARKER)) return null;

  const moduleName = firstMock[0].match(/['"]([^'"]+)['"]/u)?.[1] ?? 'a model chain module';
  return {
    line: lineAt(content, firstMock.index),
    reason:
      `mocks "${moduleName}" instead of running the real stream against the faux provider ` +
      '(packages/principles-core/src/runtime/adapter/__tests__/README.md)',
  };
}

/**
 * Check every adapter test in `files` (already scoped by the caller's mode).
 * A tracked-but-deleted file is skipped here (worktree integrity reports it);
 * any other unreadable file throws, because a silent skip would make the gate
 * pass vacuously (rc-9).
 */
function checkAdapterTests(files) {
  const findings = [];
  for (const file of files) {
    const normalized = normalizePath(file);
    if (!normalized.startsWith(ADAPTER_TEST_DIR) || !ADAPTER_TEST_FILE_RE.test(normalized)) continue;
    if (!existsSync(join(process.cwd(), file))) continue;
    const content = readFileSync(join(process.cwd(), file), 'utf8');
    const finding = checkAdapterChainMock(file, content);
    if (finding) findings.push({ file, ...finding });
  }
  return findings;
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

  // 4. Root scruff — untracked real files at the checkout root (all/merge mode).
  //    Catches agent run output that .gitignore hides from every other rule.
  if (mode === 'all') {
    let scruffFiles;
    try {
      ({ scruffFiles } = checkRootScruffFiles());
    } catch (error) {
      console.error('[REPO HYGIENE] Failed - root scruff check did not complete\n');
      console.error(`Reason: ${error.message}`);
      console.error('\nNext action: this check needs git and read access to the checkout root.');
      console.error('  Verify `git status` and `ls` work here, then re-run.');
      process.exit(1);
    }
    if (scruffFiles.length > 0) {
      console.error(`[REPO HYGIENE] Failed - ${scruffFiles.length} untracked file(s) at the checkout root\n`);
      console.error('Reason: The repository root may only contain tracked files.');
      for (const file of scruffFiles) {
        console.error(`  - ${file}`);
      }
      console.error('\nNext action (never deletes anything you did not author this session):');
      console.error('  1. Confirm what produced the file (run header/tail, check your own task).');
      console.error('  2. If it is yours: move it into the gitignored scratch root and re-run from there:');
      console.error('       mkdir -p .tmp && mv <file> .tmp/');
      console.error('     Redirect future run output the same way: `npm run <x> > .tmp/<name>.log 2>&1`.');
      console.error('  3. If it is meant to be committed: git add <file> && git commit.');
      console.error('  4. If it is someone else\'s work or its origin is unknown: stop and ask the Owner.');
      process.exit(1);
    }
  }

  // 5. Adapter-layer test convention — a chain-wide mock must state its reason
  //    (both modes: staged commits and the full merge gate).
  let adapterFindings;
  try {
    adapterFindings = checkAdapterTests(files);
  } catch (error) {
    console.error('[REPO HYGIENE] Failed - adapter test convention check did not complete\n');
    console.error(`Reason: ${error.message}`);
    console.error('\nNext action: the check needs read access to the adapter test files it was given.');
    process.exit(1);
    return;
  }
  if (adapterFindings.length > 0) {
    console.error(`[REPO HYGIENE] Failed - ${adapterFindings.length} adapter test(s) bypass the real model chain\n`);
    console.error('Reason: These tests mock a pi-ai chain module instead of running the real stream against');
    console.error('the faux provider, so they observe the config object the adapter built rather than what the');
    console.error('provider received. Mocking is allowed when faux genuinely cannot observe the contract, but');
    console.error('the reason must be written down.\n');
    console.error('Offending locations:');
    for (const finding of adapterFindings) {
      console.error(`  - ${finding.file}:${finding.line}`);
      console.error(`    Reason: ${finding.reason}`);
    }
    console.error('\nNext action (see packages/principles-core/src/runtime/adapter/__tests__/README.md):');
    console.error('  1. Preferred: run the real stream against the faux provider (fauxCompatMockFactory).');
    console.error('  2. If the contract is genuinely outside faux, add one comment:');
    console.error('       // adapter-chain-mock-exempt: <why faux cannot cover this contract>');
    process.exit(1);
    return;
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