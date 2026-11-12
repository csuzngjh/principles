/**
 * Contract: the release-asset smoke evidence lives in exactly one place.
 *
 * 2026-11-12 (CI slimming) removed the `Test release asset smoke` CI job
 * because it ran the SAME test file
 * (`tests/release-asset-smoke.test.ts`) on the same artifact construction that
 * the release-reproducibility Tier-1 quick-check already runs. That deletion is
 * only safe while these two facts hold:
 *
 *   1. every release-asset component directory (RELEASE_ASSET_REACHABLE_DIRS,
 *      the authority for `scopes.release`) is covered by the Tier-1 `paths`
 *      filter — otherwise a change could skip BOTH gates;
 *   2. Tier-1 actually runs `release-asset-smoke.test.ts` — otherwise the
 *      surviving gate is not the one being relied on.
 *
 * This test fails loudly if either half drifts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as yamlPkg from 'js-yaml';
import { RELEASE_ASSET_REACHABLE_DIRS } from '../scripts/ci/impact.mjs';

const load = yamlPkg.load ?? yamlPkg.default?.load;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tier1WorkflowPath = path.join(repoRoot, '.github', 'workflows', 'release-reproducibility.yml');
const tier1Text = readFileSync(tier1WorkflowPath, 'utf8');

function tier1Paths() {
  const doc = load(tier1Text);
  // js-yaml resolves `on` as the string key in YAML 1.2; older interop can
  // surface it as the boolean `true`. Accept both, never silently undefined.
  const triggers = doc.on ?? doc[true];
  const paths = triggers?.pull_request?.paths;
  expect(Array.isArray(paths), 'Tier-1 must declare pull_request.paths').toBe(true);
  return paths;
}

describe('release CI coverage contract', () => {
  it('Tier-1 paths cover every release-asset component directory', () => {
    const paths = tier1Paths();
    const uncovered = [...RELEASE_ASSET_REACHABLE_DIRS].filter(
      (dir) => !paths.some((pattern) => pattern.startsWith('packages/' + dir + '/')),
    );
    expect(
      uncovered,
      'these release-asset components would bypass BOTH the Tier-1 quick-check and the removed CI smoke job',
    ).toEqual([]);
  });

  it('Tier-1 paths cover the root lockfile', () => {
    expect(tier1Paths()).toContain('package-lock.json');
  });

  it('Tier-1 runs the same release-asset smoke test the removed CI job ran', () => {
    expect(tier1Text).toContain('tests/release-asset-smoke.test.ts');
  });
});
