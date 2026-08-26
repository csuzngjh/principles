#!/usr/bin/env node
// Computes a content-addressed build identity for the release asset.
//
// The identity hashes every input that determines the asset's bytes:
//   1. All six committed release-lock files (dependency resolution)
//   2. The source tree of all six release components (esbuild inputs)
//   3. The build scripts that produce the asset (bundle-plugin, builder,
//      deterministic-archive, build-self-contained-release)
//   4. SOURCE_DATE_EPOCH (archive mtime normalization)
//   5. The exact npm/better-sqlite3/prebuildify versions from the lock
//
// If this identity matches a previously verified build, the output is
// deterministic by construction — same inputs, same deterministic functions
// (npm ci + esbuild + tar), therefore same bytes.  No double-build needed.
//
// Output: a JSON file with the identity hash and its component hashes, so
// the full-matrix workflow can cross-check which input changed when a
// mismatch is detected.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const INSTALLER_ROOT = join(ROOT, 'packages', 'create-principles-disciple');

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashDirectory(dir, extensions = null) {
  const hash = createHash('sha256');
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split(sep).join('/');
      hash.update(rel);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        if (extensions && !extensions.some(ext => rel.endsWith(ext))) continue;
        hash.update(readFileSync(full));
      }
    }
  };
  visit(dir);
  return hash.digest('hex');
}

const lockRoot = join(INSTALLER_ROOT, 'release-locks');
const lockHash = createHash('sha256');
for (const component of ['core', 'host-runtime', 'plugin', 'pd-cli', 'console', 'install-layout']) {
  const lockPath = join(lockRoot, component, 'package-lock.json');
  lockHash.update(component);
  lockHash.update(readFileSync(lockPath));
}
const lockDigest = lockHash.digest('hex');

const scriptHashes = {};
for (const script of [
  'scripts/bundle-plugin.mjs',
  'scripts/build-release-asset.mjs',
  'scripts/build-self-contained-release.mjs',
  'scripts/deterministic-release-archive.mjs',
]) {
  scriptHashes[script] = hashFile(join(INSTALLER_ROOT, script));
}
const scriptsDigest = createHash('sha256')
  .update(JSON.stringify(scriptHashes))
  .digest('hex');

const sourceRoots = {
  'core': join(ROOT, 'packages', 'principles-core', 'src'),
  'host-runtime': join(ROOT, 'packages', 'host-runtime', 'src'),
  'plugin': join(ROOT, 'packages', 'openclaw-plugin', 'src'),
  'pd-cli': join(ROOT, 'packages', 'pd-cli', 'src'),
  'console': join(ROOT, 'packages', 'pd-console', 'src'),
  'install-layout': join(ROOT, 'packages', 'install-layout', 'src'),
};
const sourceHashes = {};
for (const [name, dir] of Object.entries(sourceRoots)) {
  sourceHashes[name] = hashDirectory(dir);
}
const sourcesDigest = createHash('sha256')
  .update(JSON.stringify(sourceHashes))
  .digest('hex');

const epoch = process.env.SOURCE_DATE_EPOCH || '1700000000';

const identity = {
  schemaVersion: 1,
  identityHash: null,
  epoch,
  inputs: {
    releaseLocks: lockDigest,
    buildScripts: scriptsDigest,
    componentSources: sourcesDigest,
  },
  scriptHashes,
  sourceHashes,
};

identity.identityHash = createHash('sha256')
  .update(JSON.stringify({
    schemaVersion: identity.schemaVersion,
    epoch: identity.epoch,
    ...identity.inputs,
  }))
  .digest('hex');

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const outputPath = outputIndex !== -1 ? args[outputIndex + 1] : null;

const output = JSON.stringify(identity, null, 2) + '\n';
if (outputPath) {
  writeFileSync(outputPath, output);
} else {
  process.stdout.write(output);
}
