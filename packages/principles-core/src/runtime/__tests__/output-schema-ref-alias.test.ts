import { describe, expect, it } from 'vitest';
import {
  OUTPUT_SCHEMA_REF_ALIASES,
  OUTPUT_SCHEMA_REGISTRY,
  resolveOutputSchema,
} from '../adapter/output-schema-registry.js';
import { DiagnosticianOutputV2Schema } from '../diagnostician-output.js';

/**
 * PRI-1104 Stage 0 (expand) → PRI-1139 (PR-6 neutral keys) → PRI-1146
 * (Diagnostician V2 Only / Clean Break).
 *
 * The alias table historically carried every stage's neutral↔versioned pair.
 * PRI-1146 removed ONLY Diagnostician's pair: `diagnostician-output` maps to
 * the V2 schema and `diagnostician-output-v1` must NOT resolve (fail-loud).
 * Every other stage keeps its bidirectional alias. These assertions pin that
 * contract against the real registry (no mocks).
 */
const CONTRACTS: readonly (readonly [string, string])[] = [
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
  it('PRI-1139/PRI-1146: registry owns exactly the 13 version-neutral canonical keys', () => {
    expect(OUTPUT_SCHEMA_REGISTRY.size).toBe(CONTRACTS.length + 1);
    for (const [neutral, versioned] of CONTRACTS) {
      expect(OUTPUT_SCHEMA_REGISTRY.has(neutral), neutral).toBe(true);
      // The versioned spelling is compat-read-only: it resolves through the
      // alias table, never through an exact registry hit.
      expect(OUTPUT_SCHEMA_REGISTRY.has(versioned), versioned).toBe(false);
    }
    expect(OUTPUT_SCHEMA_REGISTRY.has('diagnostician-output')).toBe(true);
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

  it('PRI-1146 Clean Break: diagnostician-output resolves to the V2 schema, diagnostician-output-v1 does not resolve at all', () => {
    expect(resolveOutputSchema('diagnostician-output')).toBe(DiagnosticianOutputV2Schema);
    expect(OUTPUT_SCHEMA_REF_ALIASES.has('diagnostician-output-v1')).toBe(false);
    expect(OUTPUT_SCHEMA_REF_ALIASES.get('diagnostician-output')).toBeUndefined();
    expect(resolveOutputSchema('diagnostician-output-v1')).toBeUndefined();
  });

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
