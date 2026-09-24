// PRI-907 (RAH-3): single definition of "compiled test artifact" shared by
// every release-hygiene gate — per-package build assertions
// (check-dist-hygiene.mjs), installer payload filtering + assertion
// (create-principles-disciple/scripts/bundle-plugin.mjs) and the repo-level
// workspace scan (check-workspace-artifacts.mjs).
//
// Deliberately NOT matched: production modules whose name merely contains
// "fixtures" (e.g. runtime-v2/internalization/golden-dogfood-fixtures.ts,
// runtime-v2/adapter/split-pipeline-fixtures.ts) — both are imported from
// production barrels and must stay in dist (ERR-149 / EP-14).
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const TEST_BASENAME = /(^|\.)test\.|(^|\.)spec\.|\.snap$/;
export const TEST_DIR_SEGMENT = /(^|[\\/])__(tests|snapshots|fixtures)__([\\/]|$)/;

export function isTestArtifact(absolutePath) {
  const basename = absolutePath.split(/[\\/]/).pop() ?? '';
  return TEST_BASENAME.test(basename) || TEST_DIR_SEGMENT.test(absolutePath);
}

// Directory filter for fs.cpSync({ filter }) — returning false skips the
// entry (file or directory subtree) from the copy.
export function skipTestArtifacts(sourcePath) {
  return !isTestArtifact(sourcePath);
}

// --- PRI-918 release-artifact hygiene contract ---------------------------
// The RAH gates above assert the narrowest class (compiled test output).
// PRI-918 widens it for the release-artifact checker ONLY: inside an
// artifact root (packages/*/dist, installer payload, npm tarball listing)
// a non-published test shape is a violation even when it would be legal in
// the source tree. Deliberately NOT used by skipTestArtifacts /
// check-dist-hygiene so bundle-copy semantics stay unchanged (PRI-918
// adds checks, never pipeline behaviour).
//
// Still deliberately NOT matched (see docs/release/artifact-hygiene-gate-audit.md §4):
// production modules named *-fixtures.ts or test-double-*.js (basename forms
// stay legal; only DIRECTORY segments are judged), samples/, and root
// data files shipped via files[] whitelists (trust/root.json, …).
const WIDE_TEST_BASENAME = TEST_BASENAME;
// A violation directory must appear as a real path segment followed by a
// separator — callers pass directories with a trailing '/' (see
// classifyEntry in check-release-artifact-hygiene.mjs). A plain FILE named
// `test` or `coverage` is therefore NOT a directory violation.
const WIDE_TEST_DIR_SEGMENT =
  /(^|[\\/])(__tests__|__snapshots__|__fixtures__|tests|test|snapshots|fixtures|coverage|\.vitest)([\\/])/;

/**
 * Classify a path relative to an artifact root (dist dir, payload component,
 * or npm tarball entry). Returns the violated rule id, or null when clean.
 */
export function classifyArtifactViolation(relativePath) {
  const normalized = relativePath.split(/[\\/]/).join('/');
  const basename = normalized.split('/').pop() ?? '';
  if (WIDE_TEST_BASENAME.test(basename)) return 'NO_TEST_FILES';
  if (WIDE_TEST_DIR_SEGMENT.test(normalized)) return 'NO_TEST_DIRECTORIES';
  return null;
}

export function collectTestArtifacts(root, dir = root, hits = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Vendored dependency trees (self-contained release assets npm-install
      // into payload components) carry third-party test files that are not
      // PD's build output — out of contract for this gate.
      if (entry.name === 'node_modules') continue;
      collectTestArtifacts(root, path, hits);
      continue;
    }
    if (isTestArtifact(path)) {
      hits.push(relative(root, path).split(sep).join('/'));
    }
  }
  return hits;
}
