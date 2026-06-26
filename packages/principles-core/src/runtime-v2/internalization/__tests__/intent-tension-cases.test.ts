/**
 * A/B Evaluation Cases fixtures test (SPEC §23.5–§23.8).
 *
 * Validates the offline evaluation dataset:
 *   - 10 total cases (4 positive + 4 negative + 2 intent_suspect)
 *   - Positive cases: source ∈ {action_drift, healthy_tension}, strength ≥ moderate
 *   - Negative cases: no intentTension expected (null)
 *   - intent_suspect cases: source = intent_suspect, action = revise_intent
 *   - All expected intentTension values pass the IntentTensionSchema
 *   - No case carries a `confidence` field (SPEC §16.3)
 *
 * ERR entries considered:
 *   - EP-01 / ERR-001: fixtures validated against TypeBox schema at runtime
 *   - EP-02 / ERR-009: composition counts asserted fail-loud
 *   - EP-03 / ERR-002: negative cases explicitly assert null (no silent skip)
 */
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { IntentTensionSchema } from '../../diagnostician/diag-rootcause-output.js';
import {
  INTENT_TENSION_CASES,
  INTENT_TENSION_CASE_COUNTS,
} from './__fixtures__/intent-tension-cases.js';

describe('IntentTension A/B evaluation cases (SPEC §23.5)', () => {
  it('has the required composition: 4 positive + 4 negative + 2 intent_suspect = 10', () => {
    expect(INTENT_TENSION_CASE_COUNTS.total).toBe(10);
    expect(INTENT_TENSION_CASE_COUNTS.positive).toBe(4);
    expect(INTENT_TENSION_CASE_COUNTS.negative).toBe(4);
    expect(INTENT_TENSION_CASE_COUNTS.intent_suspect).toBe(2);
  });

  it('every case id is unique', () => {
    const ids = INTENT_TENSION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every flag-off diagnosis has intentTension === undefined (SPEC §3: no new output when flag off)', () => {
    for (const c of INTENT_TENSION_CASES) {
      expect(c.flagOffDiagnosis.intentTension).toBeUndefined();
    }
  });

  describe('positive cases (§23.6)', () => {
    const positives = INTENT_TENSION_CASES.filter((c) => c.category === 'positive');
    it('all have expected intentTension (not null)', () => {
      for (const c of positives) {
        expect(c.flagOnExpectedIntentTension, `case ${c.id}`).not.toBeNull();
      }
    });
    it('source is action_drift or healthy_tension', () => {
      for (const c of positives) {
        const src = c.flagOnExpectedIntentTension?.source;
        expect(src, `case ${c.id}`).toMatch(/^(action_drift|healthy_tension)$/);
      }
    });
    it('evidenceStrength is at least moderate', () => {
      for (const c of positives) {
        const strength = c.flagOnExpectedIntentTension?.evidenceStrength;
        expect(strength, `case ${c.id}`).toMatch(/^(moderate|strong)$/);
      }
    });
    it('all expected intentTension values pass IntentTensionSchema', () => {
      for (const c of positives) {
        const tension = c.flagOnExpectedIntentTension;
        expect(tension, `case ${c.id}`).toBeDefined();
        if (!tension) continue; // type narrowing after assertion
        expect(Value.Check(IntentTensionSchema, tension), `case ${c.id}`).toBe(true);
      }
    });
  });

  describe('negative cases (§23.7)', () => {
    const negatives = INTENT_TENSION_CASES.filter((c) => c.category === 'negative');
    it('all expect NO intentTension even with flag on (null)', () => {
      for (const c of negatives) {
        expect(c.flagOnExpectedIntentTension, `case ${c.id}`).toBeNull();
      }
    });
  });

  describe('intent_suspect cases (§23.8)', () => {
    const suspects = INTENT_TENSION_CASES.filter((c) => c.category === 'intent_suspect');
    it('all have source = intent_suspect', () => {
      for (const c of suspects) {
        expect(c.flagOnExpectedIntentTension?.source, `case ${c.id}`).toBe('intent_suspect');
      }
    });
    it('all suggest revise_intent', () => {
      for (const c of suspects) {
        expect(c.flagOnExpectedIntentTension?.suggestedOwnerAction, `case ${c.id}`).toBe('revise_intent');
      }
    });
    it('all expected intentTension values pass IntentTensionSchema', () => {
      for (const c of suspects) {
        const tension = c.flagOnExpectedIntentTension;
        expect(tension, `case ${c.id}`).toBeDefined();
        if (!tension) continue; // type narrowing after assertion
        expect(Value.Check(IntentTensionSchema, tension), `case ${c.id}`).toBe(true);
      }
    });
  });

  it('no expected intentTension carries a `confidence` field (SPEC §16.3)', () => {
    for (const c of INTENT_TENSION_CASES) {
      const tension = c.flagOnExpectedIntentTension;
      if (tension === null) continue;
      expect(
        Object.hasOwn(tension as unknown as object, 'confidence'),
        `case ${c.id} must not carry confidence`,
      ).toBe(false);
    }
  });

  it('all non-null expected intentTension values pass the schema (cross-cut)', () => {
    for (const c of INTENT_TENSION_CASES) {
      const tension = c.flagOnExpectedIntentTension;
      if (tension === null) continue;
      expect(Value.Check(IntentTensionSchema, tension), `case ${c.id}`).toBe(true);
    }
  });
});
