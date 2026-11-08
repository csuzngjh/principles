import { describe, expect, it } from 'vitest';
import {
  OUTPUT_SCHEMA_REF_ALIASES,
  OUTPUT_SCHEMA_REGISTRY,
  resolveOutputSchema,
} from '../adapter/output-schema-registry.js';

/**
 * PRI-1104 Stage 0 (expand).
 *
 * The single-version convergence switches `outputSchemaRef` values from
 * versioned names (`*-v1` / `*-v2`) to version-neutral names in PR-6. For that
 * PR to be independently revertible, the READ side must accept both shapes
 * BEFORE any writer changes. These assertions pin that contract against the
 * real registry (no mocks).
 */
const CONTRACTS: readonly (readonly [string, string])[] = [
  ['diagnostician-output', 'diagnostician-output-v1'],
  ['diag-rootcause-output', 'diag-rootcause-output-v1'],
  ['diag-distiller-output', 'diag-distiller-output-v1'],
  ['dreamer-output', 'dreamer-output-v1'],
  ['philosopher-output', 'philosopher-output-v1'],
  ['scribe-output', 'scribe-output-v1'],
  ['artificer-rule-output', 'artificer-rule-output-v2'],
  ['evaluator-output', 'evaluator-output-v1'],
  ['rollout-reviewer-output', 'rollout-reviewer-output-v1'],
  ['correction-observer-output', 'correction-observer-output-v1'],
  ['signal-classification-output', 'signal-classification-output-v2'],
  ['reuse-evaluation-output', 'reuse-evaluation-output-v1'],
  ['learning-lab-actor-action', 'learning-lab-actor-action-v1'],
];

describe('PRI-1104 output schema ref aliases', () => {
  it('PRI-1139 cutover: registry owns exactly the 13 version-neutral canonical keys', () => {
    expect(OUTPUT_SCHEMA_REGISTRY.size).toBe(CONTRACTS.length);
    for (const [neutral, versioned] of CONTRACTS) {
      expect(OUTPUT_SCHEMA_REGISTRY.has(neutral), neutral).toBe(true);
      // The versioned spelling is compat-read-only: it resolves through the
      // alias table, never through an exact registry hit.
      expect(OUTPUT_SCHEMA_REGISTRY.has(versioned), versioned).toBe(false);
    }
  });

  it('the alias table has exactly one forward and one reverse entry per contract — no stray refs', () => {
    // Regression (PR #2367 review M2): without the exact-key assertion, adding
    // a brand-new alias pair silently widens the set of accepted refs and
    // weakens the fail-loud `Unknown outputSchemaRef` contract.
    expect(OUTPUT_SCHEMA_REF_ALIASES.size).toBe(CONTRACTS.length * 2);
    const expectedKeys = new Set(CONTRACTS.flatMap(([neutral, versioned]) => [neutral, versioned]));
    expect(new Set(OUTPUT_SCHEMA_REF_ALIASES.keys())).toEqual(expectedKeys);
  });

  for (const [neutral, versioned] of CONTRACTS) {
    it(`resolves ${neutral} to the same schema as ${versioned}`, () => {
      const expected = resolveOutputSchema(versioned);
      expect(expected).toBeDefined();
      expect(resolveOutputSchema(neutral)).toBe(expected);
    });

    it(`keeps the ${neutral} ↔ ${versioned} alias bidirectional`, () => {
      expect(OUTPUT_SCHEMA_REF_ALIASES.get(neutral)).toBe(versioned);
      expect(OUTPUT_SCHEMA_REF_ALIASES.get(versioned)).toBe(neutral);
    });
  }

  it('a retired v1 classification ref stays unresolvable (fail-loud contract preserved)', () => {
    expect(OUTPUT_SCHEMA_REF_ALIASES.has('signal-classification-output-v1')).toBe(false);
    expect(resolveOutputSchema('signal-classification-output-v1')).toBeUndefined();
  });

  it('unknown, absent and empty refs still resolve to undefined', () => {
    expect(resolveOutputSchema('no-such-contract')).toBeUndefined();
    expect(resolveOutputSchema('')).toBeUndefined();
    expect(resolveOutputSchema(null)).toBeUndefined();
    expect(resolveOutputSchema(undefined)).toBeUndefined();
  });
});
