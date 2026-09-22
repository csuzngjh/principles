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
