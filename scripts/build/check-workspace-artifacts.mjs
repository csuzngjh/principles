// PRI-907 (RAH-3): repo-level release-hygiene scan — the backstop that does
// not depend on each package remembering to wire check-dist-hygiene into its
// own build (ERR-149 / EP-14). Scans every workspace package's dist plus the
// installer payload component directories (when present — they only exist
// after a bundle run) for compiled test artifacts. Vendored node_modules
// trees are out of contract (see test-artifacts.mjs).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTestArtifacts } from './test-artifacts.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, '..', '..');

const scanRoots = [];
const packagesDir = join(root, 'packages');
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = join(packagesDir, entry.name);
  const distDir = join(packageDir, 'dist');
  if (existsSync(distDir)) {
    scanRoots.push(distDir);
  }
  // Installer payload components: <installer>/<component>/{package.json,dist}
  if (entry.name === 'create-principles-disciple') {
    for (const child of readdirSync(packageDir, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name === 'node_modules') continue;
      const componentDir = join(packageDir, child.name);
      if (existsSync(join(componentDir, 'package.json')) && existsSync(join(componentDir, 'dist'))) {
        scanRoots.push(join(componentDir, 'dist'));
      }
    }
  }
}

if (scanRoots.length === 0) {
  console.error('[check-workspace-artifacts] no dist/ directories found — nothing built yet?');
  process.exit(1);
}

let totalHits = 0;
for (const distDir of scanRoots) {
  const hits = collectTestArtifacts(distDir);
  if (hits.length === 0) continue;
  totalHits += hits.length;
  console.error(`[check-workspace-artifacts] ${hits.length} test artifact(s) in ${distDir}:`);
  for (const hit of hits.slice(0, 10)) {
    console.error(`  - ${hit}`);
  }
  if (hits.length > 10) {
    console.error(`  ... and ${hits.length - 10} more`);
  }
}

if (totalHits > 0) {
  console.error(`[check-workspace-artifacts] FAILED: ${totalHits} compiled test artifact(s) across ${scanRoots.length} dist trees.`);
  process.exit(1);
}
console.log(`[check-workspace-artifacts] OK: ${scanRoots.length} dist trees contain no compiled test artifacts.`);
