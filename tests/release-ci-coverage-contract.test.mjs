/**
 * Contract: the release-asset smoke evidence lives in exactly one place.
 *
 * 2026-11-12 (CI slimming) removed the `Test release asset smoke` CI job
 * because it ran the SAME test file (`tests/release-asset-smoke.test.ts`) on
 * the same artifact construction that the release-reproducibility Tier-1
 * quick-check already runs. That deletion is only safe while these facts hold:
 *
 *   1. Tier-1 triggers on the WHOLE release-asset component closure — every
 *      release-reachable directory plus every workspace package it depends on
 *      (e.g. workbuddy-adapter reaches the asset only via pd-cli);
 *   2. the trigger is a DIRECTORY wildcard, not a file list, so a newly added
 *      asset input cannot silently lose its evidence;
 *   3. the root-level release-construction inputs that used to arrive through
 *      impact.mjs's `broad` classification are covered by a narrow fallback;
 *   4. Tier-1 actually runs `release-asset-smoke.test.ts`.
 *
 * A follow-up review of the removal (P2-1) found facts 1-3 broken: the
 * installer was listed file-by-file (missing `trust/root.json`),
 * workbuddy-adapter was absent, and root changes had no fallback. This test
 * now pins all of them.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as yamlPkg from 'js-yaml';
import { RELEASE_ASSET_REACHABLE_DIRS } from '../scripts/ci/impact.mjs';

const load = yamlPkg.load ?? yamlPkg.default?.load;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tier1WorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release-reproducibility.yml');
const tier1Text = readFileSync(tier1WorkflowPath, 'utf8');

// Root inputs that can change the built asset bytes. Mirrors the narrow
// fallback block in the Tier-1 `paths` filter; both must move together.
const REQUIRED_ROOT_TRIGGERS = [
  'package.json',
  'package-lock.json',
  'tsconfig*.json',
  '.npmrc',
  'scripts/release/**',
  'scripts/build/**',
  'scripts/resolve-product-version.mjs',
];

function tier1Paths() {
  const doc = load(tier1Text);
  // js-yaml resolves `on` as the string key in YAML 1.2; older interop can
  // surface it as the boolean `true`. Accept both, never silently undefined.
  const triggers = doc.on ?? doc[true];
  const paths = triggers?.pull_request?.paths;
  expect(Array.isArray(paths), 'Tier-1 must declare pull_request.paths').toBe(true);
  return paths;
}

/** name -> directory, for every workspace package under packages/. */
function workspacePackages() {
  const byName = new Map();
  for (const dir of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = path.join(repoRoot, 'packages', dir.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name) byName.set(manifest.name, { dir: dir.name, manifest });
  }
  return byName;
}

/**
 * Release-reachable dirs plus the transitive workspace dependencies of each.
 * This is the set whose bytes can end up inside the asset.
 */
function releaseComponentClosure() {
  const byName = workspacePackages();
  const closure = new Set(RELEASE_ASSET_REACHABLE_DIRS);
  const queue = [...closure];
  while (queue.length > 0) {
    const dir = queue.pop();
    const entry = [...byName.values()].find((p) => p.dir === dir);
    if (!entry) continue;
    const deps = { ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies };
    for (const depName of Object.keys(deps)) {
      const dep = byName.get(depName);
      if (dep && !closure.has(dep.dir)) {
        closure.add(dep.dir);
        queue.push(dep.dir);
      }
    }
  }
  return closure;
}

describe('release CI coverage contract', () => {
  it('Tier-1 covers every release-asset component directory with a directory wildcard', () => {
    const paths = tier1Paths();
    const closure = releaseComponentClosure();
    const problems = [];
    for (const dir of [...closure].sort()) {
      const expected = 'packages/' + dir + '/**';
      if (!paths.includes(expected)) {
        // A narrower file-level pattern is NOT enough: it lets a new asset
        // input inside the same directory escape the gate.
        const narrower = paths.filter((p) => p.startsWith('packages/' + dir + '/'));
        problems.push(expected + (narrower.length ? ' (only have: ' + narrower.join(', ') + ')' : ''));
      }
    }
    expect(problems, 'release-asset components without a directory-wide Tier-1 trigger').toEqual([]);
  });

  it('Tier-1 covers the narrow root-level release-construction fallback', () => {
    const paths = tier1Paths();
    const missing = REQUIRED_ROOT_TRIGGERS.filter((p) => !paths.includes(p));
    expect(missing, 'root release-construction inputs without a Tier-1 trigger').toEqual([]);
  });

  it('Tier-1 runs the same release-asset smoke test the removed CI job ran', () => {
    expect(tier1Text).toContain('tests/release-asset-smoke.test.ts');
  });
});
