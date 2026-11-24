#!/usr/bin/env node

// Guards the installer's nested package-lock.json against spec drift from its
// own package.json. Dependabot resolves "current version" from this lockfile —
// when it drifted (recorded ^0.8.2 while the manifest declared ^0.10.0), the
// bot produced a downgrade PR that overwrote the newer spec (PR #2758).
// The check is intentionally static (pure JSON + semver) so it can run inside
// verify:merge without staging.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const installerRoot = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = join(installerRoot, 'package.json');
const lockPath = join(installerRoot, 'package-lock.json');

let semver;
try {
  semver = createRequire(join(installerRoot, 'package.json'))('semver');
} catch {
  console.error('[check-installer-lock-specs] FAIL: the `semver` package is unavailable — run `npm ci` at the repository root first.');
  process.exit(1);
}

if (!existsSync(manifestPath) || !existsSync(lockPath)) {
  console.error(`[check-installer-lock-specs] FAIL: expected ${manifestPath} and ${lockPath} to exist.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
const lockRoot = lock.packages?.[''];
if (!lockRoot) {
  console.error('[check-installer-lock-specs] FAIL: lockfile has no root packages[""] record — regenerate with `npm install --package-lock-only`.');
  process.exit(1);
}

// Workspace-internal deps whose manifest spec is only satisfiable by a version
// materialized in the SAME release cohort (the sibling package.json was bumped
// by `changeset version`, but nothing matching can exist on the registry until
// that cohort publishes): the nested lockfile cannot be regenerated during the
// Version Packages window, so the drift is expected and skipped. Once the
// cohort ships, the lock regen restores a real registry entry.
const workspaceVersions = (() => {
  const map = new Map();
  for (const dir of readdirSync(join(installerRoot, '..'))) {
    const pkgPath = join(installerRoot, '..', dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (typeof pkg?.name === 'string' && typeof pkg?.version === 'string') {
        map.set(pkg.name, pkg.version);
      }
    } catch {
      // unreadable sibling manifest — not a workspace package we track
    }
  }
  return map;
})();

const isSameCohortInternalBump = (name, spec) => {
  const wsVersion = workspaceVersions.get(name);
  return (
    wsVersion !== undefined
    && semver.validRange(spec)
    && semver.satisfies(wsVersion, spec, { includePrerelease: true })
  );
};

const problems = [];
const cohortTolerated = new Set();
const sections = ['dependencies', 'devDependencies'];

for (const section of sections) {
  const manifestDeps = manifest[section] ?? {};
  const lockDeps = lockRoot[section] ?? {};
  for (const [name, spec] of Object.entries(manifestDeps)) {
    const cohortBump = isSameCohortInternalBump(name, spec);
    if (!(name in lockDeps)) {
      if (cohortBump) { cohortTolerated.add(`${section}.${name}`); continue; }
      problems.push(`${section}.${name}: manifest spec "${spec}" is missing from the lock root record`);
      continue;
    }
    if (lockDeps[name] !== spec) {
      if (cohortBump) { cohortTolerated.add(`${section}.${name}`); continue; }
      problems.push(`${section}.${name}: manifest spec "${spec}" != lock spec "${lockDeps[name]}"`);
    }
  }
  for (const name of Object.keys(lockDeps)) {
    if (!(name in manifestDeps)) {
      problems.push(`${section}.${name}: lock root records "${lockDeps[name]}" but the manifest no longer declares it`);
    }
  }
}

// Locked versions must satisfy the manifest spec — a spec match with a stale
// resolution is still a dependabot-shaped input. Registry range specs only;
// file:/link:/workspace: deps are verified by the staging npm ci instead.
for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
  if (!semver.validRange(spec)) continue;
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.version) continue;
  if (!semver.satisfies(entry.version, spec, { includePrerelease: true })) {
    if (isSameCohortInternalBump(name, spec)) { cohortTolerated.add(`dependencies.${name}`); continue; }
    problems.push(`dependencies.${name}: locked ${entry.version} does not satisfy manifest spec "${spec}"`);
  }
}

if (problems.length > 0) {
  console.error('[check-installer-lock-specs] FAIL: installer package-lock.json is out of sync with package.json:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('  nextAction: regenerate with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` inside packages/create-principles-disciple (outside workspace context) and commit the result. Stale lock records feed dependabot a wrong "current version" and produced a downgrade PR before (PR #2758).');
  process.exit(1);
}

if (cohortTolerated.size > 0) {
  console.log(`[check-installer-lock-specs] OK (cohort-tolerated: ${[...cohortTolerated].join(', ')} — spec only satisfiable by an unreleased workspace version; regenerate the lock after the cohort publishes).`);
} else {
  console.log('[check-installer-lock-specs] OK: installer package-lock.json root specs match package.json and locked versions satisfy them.');
}
