#!/usr/bin/env node
// PRI-918 (Release Reliability Guardrails): release-artifact hygiene gate.
//
// Asserts that no test-owned artifact shape enters anything a user can
// download, across ALL THREE release surfaces:
//   1. packages/*/dist            (build output of every workspace package)
//   2. installer payload components (create-principles-disciple/<component>/)
//   3. npm tarball listings         (npm pack --dry-run --json --ignore-scripts
//                                 for every non-private package — the listing
//                                 IS the publish surface; --ignore-scripts
//                                 keeps prepack (build+bundle) out of the gate)
//
// Contract lives in scripts/build/test-artifacts.mjs (classifyArtifactViolation)
// — the single SSoT shared with the RAH gates (ERR-149/EP-14 lineage).
// Checks only: this gate never mutates, filters copies, or changes topology.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyArtifactViolation } from './build/test-artifacts.mjs';

const REASONS = {
  NO_TEST_FILES: 'test artifact inside a release artifact',
  NO_TEST_DIRECTORIES: 'test-owned directory inside a release artifact',
};

/** Scan one artifact tree (path-classification only; never reads content,
 *  never follows symlinks — PRI-913 lesson: directory walks branch on
 *  readdirSync(withFileTypes) Dirent types, no lstat→use race window). */
export function scanArtifactTree(label, root) {
  const violations = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        violations.push(...classifyEntry(label, root, path, entry.isDirectory()));
        walk(path);
        continue;
      }
      scanned += 1;
      violations.push(...classifyEntry(label, root, path, false));
    }
  };
  walk(root);
  return { scanned, violations };
}

function classifyEntry(label, root, absolutePath, isDirectory) {
  const rel = relative(root, absolutePath).split(sep).join('/');
  const suffix = isDirectory ? '/' : '';
  const rule = classifyArtifactViolation(`${rel}${suffix}`);
  if (!rule) return [];
  return [{ artifact: `${label}/${rel}${suffix}`, rule }];
}

/** Classify an npm tarball listing (entries[].path, '/'-separated). */
export function scanTarballEntries(label, entries) {
  const violations = [];
  for (const entry of entries) {
    const rule = classifyArtifactViolation(entry.path);
    if (rule) violations.push({ artifact: `${label}!/${entry.path}`, rule });
  }
  return { scanned: entries.length, violations };
}

export function listWorkspacePackages(repoRoot) {
  const packagesDir = join(repoRoot, 'packages');
  const packages = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    packages.push({ dir: join(packagesDir, entry.name), name: manifest.name ?? entry.name, private: manifest.private === true });
  }
  return packages;
}

/** `npm pack --dry-run --json --ignore-scripts` → { name, version, paths[] }. */
export function packDryRunListing(pkgDir) {
  // One fixed literal command string through the shell — node ≥26 refuses to
  // spawn npm.cmd directly (CVE-2024-27980 guard) and DEP0190-warns on
  // shell:true + argv arrays. Nothing here is interpolated.
  const stdout = execSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: pkgDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  // npm >= 10 emits the per-file listing under `files` ([{path,size,mode}]).
  const listing = entry?.files;
  if (!Array.isArray(listing)) {
    throw new Error(`npm pack --dry-run --json returned no file listing for ${pkgDir}: ${JSON.stringify(entry)?.slice(0, 200)}`);
  }
  return {
    name: entry.name,
    version: entry.version,
    paths: listing.map((f) => ({ path: f.path })),
  };
}

export function runReleaseArtifactHygiene(repoRoot) {
  const results = [];
  const merge = (r) => results.push(r);

  // Leg 1 — every workspace package's dist.
  for (const pkg of listWorkspacePackages(repoRoot)) {
    const distDir = join(pkg.dir, 'dist');
    if (existsSync(distDir)) {
      merge(scanArtifactTree(`packages/${pkg.dir.split(/[\\/]/).pop()}/dist`, distDir));
    }
  }

  // Leg 2 — installer payload components (empty package.json-only dirs at PR
  // time, fully materialised after a bundle run; scanned either way so a
  // dirty local payload tree can never pass silently — PRI-913/G2 lesson).
  const installerDir = join(repoRoot, 'packages', 'create-principles-disciple');
  if (existsSync(installerDir)) {
    for (const entry of readdirSync(installerDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['node_modules', 'dist', 'src', 'tests', 'scripts', 'release-locks'].includes(entry.name)) continue;
      const componentDir = join(installerDir, entry.name);
      if (!existsSync(join(componentDir, 'package.json'))) continue;
      merge(scanArtifactTree(`packages/create-principles-disciple/${entry.name}`, componentDir));
    }
  }

  // Leg 3 — npm tarball listings for every publishable (non-private) package.
  const tarballs = [];
  for (const pkg of listWorkspacePackages(repoRoot)) {
    if (pkg.private) continue;
    const listing = packDryRunListing(pkg.dir);
    const label = `tarball:${listing.name}@${listing.version}`;
    merge(scanTarballEntries(label, listing.paths));
    tarballs.push(label);
  }

  const scanned = results.reduce((sum, r) => sum + r.scanned, 0);
  const violations = results.flatMap((r) => r.violations);
  return { scanned, violations, tarballLegs: tarballs };
}

function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const { scanned, violations, tarballLegs } = runReleaseArtifactHygiene(repoRoot);
  if (violations.length === 0) {
    console.log('Release artifact hygiene PASS');
    console.log(`scanned:\n  ${scanned} files (${tarballLegs.length} npm tarball listings)`);
    console.log('violations:\n  0');
    return;
  }
  console.error('Release artifact hygiene FAIL');
  console.error(`scanned:\n  ${scanned} files (${tarballLegs.length} npm tarball listings)`);
  console.error(`violations:\n  ${violations.length}`);
  for (const v of violations) {
    console.error(`\n${v.artifact}\n\nreason:\n${REASONS[v.rule]}\n\nrule violated:\n${v.rule}`);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
