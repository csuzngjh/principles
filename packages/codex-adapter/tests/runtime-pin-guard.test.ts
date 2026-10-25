/**
 * PRI-1040 installed-runtime cohort guard.
 *
 * Two layers, by design:
 *  1. THIS test (hermetic, runs in every unit CI pass): the pin file must
 *     contain exact semver identities, and the packaged capability probe
 *     must exist. Version tuples are derived from release authority by the
 *     ordinary maintenance PR workflow, rather than frozen in unit tests.
 *  2. `codex-plugin-bundle.test.ts` first-run flow + the repo's
 *     `check:runtime-pin` script (real packaged evidence): install the pinned
 *     bytes and exercise Owner controls, unavailable Codex V2 context, and
 *     DesignGate fact validation.
 *
 * Historical Owner-control evidence (PRI-807 Phase 0 NEW-E1 / PRI-810):
 *  - host-runtime@0.1.0 ignores `global_rulecode_pauses` and
 *    `activation_control_states` and EXECUTES retired-contract RuleCode.
 *  - host-runtime@0.1.1 introduced those guards (commit 41cf97ee / 19df0f9c
 *    lineage, 2026-08-21). Verified by npm pack: 0.1.0 has 0 references to
 *    global_rulecode_pauses/activation_control_states in
 *    dist/production-rulehost-gate.js; 0.1.1+ has 1/1.
 *  - core@1.252.0 (the previous pin) predates the activation_control_states
 *    schema in its bootstrap entirely.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGIN_ROOT = path.join(repoRoot, 'plugins', 'principles-disciple');

describe('PRI-1040 installed-runtime cohort guard', () => {
  const pinsPath = path.join(PLUGIN_ROOT, 'runtime-version.json');

  it('runtime-version.json exists and pins all three runtime packages with plain semver', () => {
    const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8')) as { codexAdapter: string; hostRuntime: string; core: string };
    for (const key of ['codexAdapter', 'hostRuntime', 'core'] as const) {
      expect(pins[key], `pin ${key} must be present`).toBeTruthy();
      expect(pins[key], `pin ${key} must be exact semver (no ranges): ${pins[key]}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  // The release train derives each next cohort from the existing Version PR
  // authority, then verifies published identities and capabilities. A frozen
  // version tuple here would reject every legitimate maintenance PR.

  it('the packaged behavioral capability probe ships with the plugin', () => {
    const probe = path.join(PLUGIN_ROOT, 'scripts', 'verify-pinned-runtime-capability.cjs');
    expect(fs.existsSync(probe), 'verify-pinned-runtime-capability.cjs must ship with the plugin — it is the behavioral half of this guard').toBe(true);
  });
});
