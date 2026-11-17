/**
 * PRI-1252 (PD-Lab v0.3, HANDOFF T2) — pre-refactor characterization of the
 * Prompt V2 A/B harness behaviors that the T3 config-decoupling refactor
 * (PRI-1253/PRI-1254) MUST preserve.
 *
 * Characterization principle: these assertions pin the CURRENT implemented
 * behavior (verified against the live exports on a clean checkout), not the
 * behavior we wish the harness had. If T3 needs to change one of these
 * outcomes, that is an intentional, Owner-visible contract change — update
 * this file in the same PR with an explanation, never silently.
 *
 * Subjects (both exported from experiment/prompt-v2/scripts/ab/ab-lib.mjs):
 *  - childEnv(): builds the child-process environment for every harness-spawned
 *    pd-cli invocation. It must strip all five workspace/state pointer env
 *    vars so an inherited production pointer (the 2026-11-12 incident class)
 *    can never outrank the explicit --workspace flag.
 *  - armOrderFor(runId, sampleIndex, arms): the deterministic per-sample arm
 *    interleave (SPEC PD-SPEC-001 section 4.7). Pairing fairness depends on
 *    this staying stable for a frozen (runId, sampleIndex, arms) triple.
 *
 * Quirk pinned as-is (documented in TECH v0.3 section 2.1): ab-run.mjs feeds
 * armOrderFor the SHARD-LOCAL sample index, so the same logical sample can get
 * a different arm order in different shard splits. T3 (CF-12) moves ordering
 * to the global sample index with a frozen seed — until then, this test only
 * pins the function's own determinism per input, not the caller's index
 * policy.
 *
 * Run: npm run test:scripts -- pd-lab-harness-characterization
 */
import { describe, expect, it } from 'vitest';
import { armOrderFor, childEnv } from '../../experiment/prompt-v2/scripts/ab/ab-lib.mjs';

/**
 * The five workspace/state pointer variables childEnv() must delete. Kept in
 * the exact order they appear in ab-lib.mjs. This list is load-bearing: if a
 * sixth pointer var is ever added to the harness strip list, this test must
 * grow with it (and T3's config-driven rewrite must strip the same set).
 */
const POINTER_ENV_VARS = [
  'PD_WORKSPACE_DIR',
  'OPENCLAW_WORKSPACE',
  'OPENCLAW_WORKSPACE_DIR',
  'PD_STATE_DIR',
  'OPENCLAW_HOME',
];

describe('PD-SPEC-001 harness characterization — childEnv()', () => {
  it('deletes all five workspace/state pointer vars even when the parent shell carries them', () => {
    const saved: Record<string, string | undefined> = {};
    try {
      // Plant every pointer with a production-looking value, exactly like the
      // hazard the 2026-11-12 incident documented for this machine's shell.
      for (const name of POINTER_ENV_VARS) {
        saved[name] = process.env[name];
        process.env[name] = `D:/.openclaw/workspace/pointer-${name}`;
      }
      // Control: an unrelated inherited var must SURVIVE the strip, proving
      // the deletion is a targeted allow-no-pointer rule, not a wipe.
      saved['PD_CHAR_TEST_CONTROL'] = process.env['PD_CHAR_TEST_CONTROL'];
      process.env['PD_CHAR_TEST_CONTROL'] = 'survives';

      const env = childEnv();

      for (const name of POINTER_ENV_VARS) {
        expect(
          Object.hasOwn(env, name),
          `childEnv() must not carry pointer var ${name}`,
        ).toBe(false);
      }
      expect(Object.hasOwn(env, 'PD_CHAR_TEST_CONTROL')).toBe(true);
      expect(env['PD_CHAR_TEST_CONTROL']).toBe('survives');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('strips the five pointer vars from a clean parent env too (absence stays absence)', () => {
    const saved: Record<string, string | undefined> = {};
    try {
      for (const name of POINTER_ENV_VARS) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
      const env = childEnv();
      for (const name of POINTER_ENV_VARS) {
        expect(Object.hasOwn(env, name)).toBe(false);
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('re-injects the extra override AFTER stripping — runPd relies on this to point PD_WORKSPACE_DIR inside the experiment root', () => {
    const saved = process.env['PD_WORKSPACE_DIR'];
    try {
      process.env['PD_WORKSPACE_DIR'] = 'D:/.openclaw/workspace/inherited-production-pointer';
      const env = childEnv({ PD_WORKSPACE_DIR: 'D:/exp-root/workspaces/v1' });
      // The extra wins over both the stripped inheritance and the strip rule
      // itself: the single surviving PD_WORKSPACE_DIR is the injected one.
      expect(env['PD_WORKSPACE_DIR']).toBe('D:/exp-root/workspaces/v1');
      // The other four pointers stay stripped even when extra re-injects one.
      expect(Object.hasOwn(env, 'OPENCLAW_HOME')).toBe(false);
      expect(Object.hasOwn(env, 'PD_STATE_DIR')).toBe(false);
    } finally {
      if (saved === undefined) {
        delete process.env['PD_WORKSPACE_DIR'];
      } else {
        process.env['PD_WORKSPACE_DIR'] = saved;
      }
    }
  });

  it('does not mutate the live process.env while building the child env', () => {
    const saved = process.env['PD_WORKSPACE_DIR'];
    try {
      process.env['PD_WORKSPACE_DIR'] = 'D:/.openclaw/workspace/must-stay';
      const env = childEnv();
      // The returned env is a copy: stripping happens on the copy only.
      expect(Object.hasOwn(env, 'PD_WORKSPACE_DIR')).toBe(false);
      expect(process.env['PD_WORKSPACE_DIR']).toBe('D:/.openclaw/workspace/must-stay');
    } finally {
      if (saved === undefined) {
        delete process.env['PD_WORKSPACE_DIR'];
      } else {
        process.env['PD_WORKSPACE_DIR'] = saved;
      }
    }
  });
});

describe('PD-SPEC-001 harness characterization — armOrderFor()', () => {
  // Expected orders below were generated by running the CURRENT ab-lib.mjs
  // implementation on a clean checkout (node -e against the live export) and
  // copying its literal outputs. The derived offset per runId is
  // parseInt(sha256(runId).slice(0, 8), 16) % 2; order flips per sample index.
  // runId 'grid-canary'  -> offset parity 0 (index 0 => arms as given)
  // runId 'paired-2'     -> offset parity 1 (index 0 => reversed)
  // runId 'grid-3'       -> offset parity 1
  // runId 'solo-gate0'   -> offset parity 0

  it('returns the pinned deterministic order for fixed (runId, sampleIndex) pairs with default arms', () => {
    expect(armOrderFor('grid-canary', 0)).toEqual(['v1', 'v2']);
    expect(armOrderFor('grid-canary', 1)).toEqual(['v2', 'v1']);
    expect(armOrderFor('grid-canary', 2)).toEqual(['v1', 'v2']);
    expect(armOrderFor('grid-canary', 3)).toEqual(['v2', 'v1']);

    expect(armOrderFor('paired-2', 0)).toEqual(['v2', 'v1']);
    expect(armOrderFor('paired-2', 1)).toEqual(['v1', 'v2']);
    expect(armOrderFor('paired-2', 2)).toEqual(['v2', 'v1']);

    expect(armOrderFor('grid-3', 0)).toEqual(['v2', 'v1']);
    expect(armOrderFor('grid-3', 1)).toEqual(['v1', 'v2']);

    expect(armOrderFor('solo-gate0', 0)).toEqual(['v1', 'v2']);
    expect(armOrderFor('solo-gate0', 3)).toEqual(['v2', 'v1']);
    expect(armOrderFor('solo-gate0', 4)).toEqual(['v1', 'v2']);
  });

  it('honors a custom arms array by parity-reversing exactly the given order', () => {
    // Dreamer V2.1 round-2 arm pair.
    expect(armOrderFor('paired-2', 0, ['v21', 'v2c'])).toEqual(['v2c', 'v21']);
    expect(armOrderFor('paired-2', 1, ['v21', 'v2c'])).toEqual(['v21', 'v2c']);
    // The T6 intent pilot arm pair shape (baseline first when not flipped).
    expect(armOrderFor('grid-canary', 0, ['off', 'on'])).toEqual(['off', 'on']);
    expect(armOrderFor('grid-canary', 1, ['off', 'on'])).toEqual(['on', 'off']);
  });

  it('is a pure function of its inputs — repeated calls give identical output', () => {
    for (const runId of ['grid-canary', 'paired-2', 'grid-3', 'solo-gate0']) {
      for (let si = 0; si < 5; si++) {
        const first = armOrderFor(runId, si);
        const second = armOrderFor(runId, si);
        expect(second).toEqual(first);
      }
    }
  });

  it('never mutates the caller-provided arms array and returns a fresh array per call', () => {
    const arms = ['v1', 'v2'];
    const a = armOrderFor('grid-canary', 0, arms);
    const b = armOrderFor('grid-canary', 0, arms);
    expect(arms).toEqual(['v1', 'v2']); // input untouched
    expect(a).not.toBe(b); // fresh array per call
    expect(a).toEqual(b); // ...with identical content
    // Mutating one result must not poison the input or later results.
    a.push('poison');
    expect(arms).toEqual(['v1', 'v2']);
    expect(armOrderFor('grid-canary', 0, arms)).toEqual(['v1', 'v2']);
  });
});
