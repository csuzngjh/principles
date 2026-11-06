/**
 * IntentTension A/B evaluation dataset — fixture shape guard (SPEC §23.5–23.8).
 *
 * Consolidated in PRI-891 (Test Diet 2.2-B1): this file previously
 * re-validated the dataset against IntentTensionSchema and re-checked
 * per-category semantics that duplicate the real TypeBox accept/reject
 * matrix in diagnostician/__tests__/intent-tension-schema.test.ts. A fixture
 * test only proves the fixture is healthy; it does not re-prove the
 * production schema. What remains is dataset integrity + labeling contract:
 *   - composition: 10 cases = 4 positive + 4 negative + 2 intent_suspect
 *   - unique case ids
 *   - labeling: positives/suspects expect a tension, negatives expect null
 *   - flag-off diagnoses never carry intentTension (SPEC §3)
 *   - no expected tension carries `confidence` (SPEC §16.3)
 */
import { describe, it, expect } from 'vitest';
import {
  INTENT_TENSION_CASES,
} from './__fixtures__/intent-tension-cases.js';

describe('IntentTension A/B evaluation dataset (SPEC §23.5)', () => {
  it('dataset integrity: 10 cases = 4 positive + 4 negative + 2 intent_suspect, unique ids', () => {
    expect(INTENT_TENSION_CASES).toHaveLength(10);
    const counts = { positive: 0, negative: 0, intent_suspect: 0 };
    for (const c of INTENT_TENSION_CASES) {
      counts[c.category] += 1;
    }
    expect(counts).toEqual({ positive: 4, negative: 4, intent_suspect: 2 });

    const ids = INTENT_TENSION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('labeling contract: flag-off never carries tension; positives/suspects expect one, negatives expect null; no confidence field', () => {
    for (const c of INTENT_TENSION_CASES) {
      // SPEC §3: no new output when flag off.
      expect(c.flagOffDiagnosis.intentTension, `case ${c.id}`).toBeUndefined();

      if (c.category === 'negative') {
        expect(c.flagOnExpectedIntentTension, `case ${c.id}`).toBeNull();
        continue;
      }
      const tension = c.flagOnExpectedIntentTension;
      expect(tension, `case ${c.id}`).not.toBeNull();
      if (!tension) continue; // type narrowing after assertion
      // SPEC §16.3: tension data must not carry a confidence field.
      expect(Object.hasOwn(tension as unknown as object, 'confidence'), `case ${c.id} must not carry confidence`).toBe(false);
    }
  });
});
