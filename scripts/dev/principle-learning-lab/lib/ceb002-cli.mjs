// CEB-002 CLI argument resolution — pure, zero-side-effect utility.
// Extracted from build-ceb002-suite.mjs (2026-10-27 safety round) so the
// contract tests can import and test the parsing logic WITHOUT importing
// the builder script (which has top-level build side effects when run
// via CLI). This module must never touch the filesystem.

import path from 'node:path';

/**
 * FAIL-CLOSED output-directory resolution.
 * Returns an absolute path. Rules:
 *   - No `--output-dir` in argv → returns defaultDir (normal build flow).
 *   - `--output-dir <path>` present exactly once with a non-empty, non-flag
 *     path → returns path.resolve(path).
 *   - `--output-dir` missing its path argument, given an empty string,
 *     followed by another option, or appearing more than once → THROWS
 *     (the caller must exit BEFORE any directory creation, file write, or
 *     ledger truncation — never silently falls back to the real study
 *     directory).
 */
export function resolveOutputDir(argv, defaultDir) {
  if (!Array.isArray(argv)) throw new Error('resolveOutputDir: argv must be an array');
  const indices = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output-dir') indices.push(i);
  }
  if (indices.length === 0) return defaultDir;
  if (indices.length > 1) throw new Error(`resolveOutputDir: --output-dir given ${indices.length} times — exactly one is required; refusing to guess (no files written)`);
  const value = argv[indices[0] + 1];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('resolveOutputDir: --output-dir requires a non-empty path argument — refusing to fall back to the default study directory (no files written)');
  }
  if (value.startsWith('--')) {
    throw new Error(`resolveOutputDir: --output-dir must be followed by a path, not another option ('${value}') — no files written`);
  }
  return path.resolve(value);
}
