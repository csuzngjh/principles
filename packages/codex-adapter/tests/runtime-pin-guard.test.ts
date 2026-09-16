/**
 * PRI-810 regression guard — the Codex installed-runtime pin must never
 * regress below the Owner-control minimum contract.
 *
 * Two layers, by design:
 *  1. THIS test (hermetic, runs in every unit CI pass): the pin file must
 *     satisfy the version floor at which the Owner emergency-control guards
 *     landed, and the packaged capability probe must exist.
 *  2. `codex-plugin-bundle.test.ts` first-run flow + the repo's
 *     `check:runtime-pin` script (real packaged evidence): install the pinned
 *     bytes and BEHAVE them — global pause honored, safety isolation honored,
 *     retired-contract RuleCode skipped. The version floor here is derived
 *     from that behavioral contract, not the other way around.
 *
 * Floor rationale (PRI-807 Phase 0 NEW-E1 / PRI-810):
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

/** Earliest published @principles/host-runtime that honors Owner emergency control. */
const HOST_RUNTIME_FLOOR = '0.1.1';

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(SEMVER_PATTERN);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function atLeast(version: string, floor: string): boolean {
  const v = parseSemver(version);
  const f = parseSemver(floor);
  if (!v || !f) return false;
  if (v.major !== f.major) return v.major > f.major;
  if (v.minor !== f.minor) return v.minor > f.minor;
  return v.patch >= f.patch;
}

describe('PRI-810 installed-runtime pin guard', () => {
  const pinsPath = path.join(PLUGIN_ROOT, 'runtime-version.json');

  it('runtime-version.json exists and pins all three runtime packages with plain semver', () => {
    const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8')) as { codexAdapter: string; hostRuntime: string; core: string };
    for (const key of ['codexAdapter', 'hostRuntime', 'core'] as const) {
      expect(pins[key], `pin ${key} must be present`).toBeTruthy();
      expect(pins[key], `pin ${key} must be exact semver (no ranges): ${pins[key]}`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('hostRuntime pin is at or above the Owner-control floor (' + HOST_RUNTIME_FLOOR + ')', () => {
    const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8')) as { hostRuntime: string };
    const message = [
      `hostRuntime pin ${pins.hostRuntime} is below the Owner-control floor ${HOST_RUNTIME_FLOOR} — versions below 0.1.1 ignore global_rulecode_pauses and activation_control_states and execute retired-contract RuleCode (PRI-810).`,
      'If you are lowering this floor deliberately, first run the repo check:runtime-pin script against the candidate and attach the behavioral evidence to the PR.',
    ].join(' ');
    expect(atLeast(pins.hostRuntime, HOST_RUNTIME_FLOOR), message).toBe(true);
  });

  it('the packaged behavioral capability probe ships with the plugin', () => {
    const probe = path.join(PLUGIN_ROOT, 'scripts', 'verify-pinned-runtime-capability.cjs');
    expect(fs.existsSync(probe), 'verify-pinned-runtime-capability.cjs must ship with the plugin — it is the behavioral half of this guard').toBe(true);
  });
});
