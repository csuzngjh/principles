/**
 * PRI-468 — IntentTensionSchema unit tests (SPEC §23.3).
 *
 * Validates the TypeBox schema for the optional `intentTension` field added
 * to DiagRootCauseOutputV1Schema. The schema must:
 *   - accept all four `source` enum values (SPEC §16.5)
 *   - accept all three `evidenceStrength` values
 *   - accept all five `relatedIntentFields` values
 *   - accept all six `suggestedOwnerAction` values (SPEC §21)
 *   - cap `evidence` at 3 items (SPEC §16.4)
 *   - reject `confidence` (SPEC §16.3 — intentTension.confidence is forbidden;
 *     existing rootCause-level confidence is untouched)
 *   - treat `intentDocHash` as optional (SPEC §16.2)
 *
 * TDD: this test is written BEFORE the schema exists. Run to confirm RED.
 */

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  IntentTensionSchema,
  IntentTensionSourceSchema,
  EvidenceStrengthSchema,
  IntentRelatedFieldSchema,
  SuggestedOwnerActionSchema,
  type IntentTension,
} from '../diag-rootcause-output.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const validIntentTension: IntentTension = {
  source: 'action_drift',
  evidenceStrength: 'moderate',
  relatedIntentFields: ['current_strategic_focus', 'non_negotiables'],
  evidence: [
    'INTENT says current focus is validating the smallest Pain → Principle loop.',
    'Agent designed a heavy dashboard.',
    'Owner correction says the result increased review burden.',
  ],
  explanation:
    'The work may be useful later, but it optimized presentation completeness before validating the current learning loop.',
  suggestedOwnerAction: 'confirm_drift',
  intentDocHash: 'sha256:abc123',
};

// ── Schema existence ─────────────────────────────────────────────────────────

describe('IntentTensionSchema — existence', () => {
  it('exports IntentTensionSchema', () => {
    expect(IntentTensionSchema).toBeDefined();
  });

  it('exports sub-literal schemas', () => {
    expect(IntentTensionSourceSchema).toBeDefined();
    expect(EvidenceStrengthSchema).toBeDefined();
    expect(IntentRelatedFieldSchema).toBeDefined();
    expect(SuggestedOwnerActionSchema).toBeDefined();
  });
});

// ── §23.3.1 — source enum validity ──────────────────────────────────────────

describe('IntentTensionSchema — source enum (SPEC §16.5)', () => {
  const SOURCES = ['none', 'action_drift', 'intent_suspect', 'healthy_tension'] as const;

  for (const source of SOURCES) {
    it(`accepts source="${source}"`, () => {
      const obj = { ...validIntentTension, source };
      expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
    });
  }

  it('rejects unknown source value', () => {
    const obj = { ...validIntentTension, source: 'definitely_drift' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects missing source', () => {
    const { source: _source, ...obj } = validIntentTension;
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── §23.3.2 — evidenceStrength enum validity ────────────────────────────────

describe('IntentTensionSchema — evidenceStrength enum', () => {
  const STRENGTHS = ['weak', 'moderate', 'strong'] as const;

  for (const evidenceStrength of STRENGTHS) {
    it(`accepts evidenceStrength="${evidenceStrength}"`, () => {
      const obj = { ...validIntentTension, evidenceStrength };
      expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
    });
  }

  it('rejects unknown evidenceStrength value', () => {
    const obj = { ...validIntentTension, evidenceStrength: 'very_strong' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects numeric evidenceStrength', () => {
    const obj = { ...validIntentTension, evidenceStrength: 0.8 };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── §23.3.3 — relatedIntentFields enum validity ─────────────────────────────

describe('IntentTensionSchema — relatedIntentFields enum', () => {
  const FIELDS = [
    'why',
    'desired_outcome',
    'non_negotiables',
    'stop_escalation',
    'current_strategic_focus',
  ] as const;

  for (const field of FIELDS) {
    it(`accepts relatedIntentFields=["${field}"]`, () => {
      const obj = { ...validIntentTension, relatedIntentFields: [field] };
      expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
    });
  }

  it('accepts multiple relatedIntentFields', () => {
    const obj = { ...validIntentTension, relatedIntentFields: [...FIELDS] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('accepts empty relatedIntentFields array', () => {
    const obj = { ...validIntentTension, relatedIntentFields: [] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('rejects unknown relatedIntentFields value', () => {
    const obj = { ...validIntentTension, relatedIntentFields: ['unknown_field'] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects non-array relatedIntentFields', () => {
    const obj = { ...validIntentTension, relatedIntentFields: 'current_strategic_focus' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── §23.3.4 — suggestedOwnerAction enum validity ────────────────────────────

describe('IntentTensionSchema — suggestedOwnerAction enum (SPEC §21)', () => {
  const ACTIONS = [
    'confirm_drift',
    'revise_intent',
    'observe',
    'dismiss',
    'promote_to_principle',
    'promote_to_rulehost',
  ] as const;

  for (const suggestedOwnerAction of ACTIONS) {
    it(`accepts suggestedOwnerAction="${suggestedOwnerAction}"`, () => {
      const obj = { ...validIntentTension, suggestedOwnerAction };
      expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
    });
  }

  it('rejects unknown suggestedOwnerAction value', () => {
    const obj = { ...validIntentTension, suggestedOwnerAction: 'ignore' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── §23.3.5 — evidence max 3 items (SPEC §16.4) ─────────────────────────────

describe('IntentTensionSchema — evidence maxItems: 3 (SPEC §16.4)', () => {
  it('accepts evidence with 0 items', () => {
    const obj = { ...validIntentTension, evidence: [] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('accepts evidence with 1 item', () => {
    const obj = { ...validIntentTension, evidence: ['one'] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('accepts evidence with exactly 3 items', () => {
    const obj = { ...validIntentTension, evidence: ['one', 'two', 'three'] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('rejects evidence with 4 items', () => {
    const obj = { ...validIntentTension, evidence: ['one', 'two', 'three', 'four'] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects evidence with 10 items', () => {
    const obj = { ...validIntentTension, evidence: Array.from({ length: 10 }, (_, i) => `evidence-${i}`) };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects non-array evidence', () => {
    const obj = { ...validIntentTension, evidence: 'single string' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects evidence array with non-string elements', () => {
    const obj = { ...validIntentTension, evidence: ['ok', 42, 'bad'] };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── §23.3.6 — confidence is rejected (SPEC §16.3) ───────────────────────────

describe('IntentTensionSchema — confidence forbidden (SPEC §16.3)', () => {
  it('rejects intentTension.confidence: number', () => {
    const obj = { ...validIntentTension, confidence: 0.8 };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects intentTension.confidence: 0', () => {
    const obj = { ...validIntentTension, confidence: 0 };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects intentTension.confidence: 1', () => {
    const obj = { ...validIntentTension, confidence: 1 };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('Value.Clean strips confidence from intentTension', () => {
    const obj = { ...validIntentTension, confidence: 0.8 };
    const cleaned = Value.Clean(IntentTensionSchema, obj) as Record<string, unknown>;
    expect(Object.hasOwn(cleaned, 'confidence')).toBe(false);
  });

  it('Value.Errors reports confidence as additional property', () => {
    const obj = { ...validIntentTension, confidence: 0.8 };
    const errors = [...Value.Errors(IntentTensionSchema, obj)];
    expect(errors.some((e) => e.path.includes('confidence') || e.message.includes('Additional'))).toBe(true);
  });
});

// ── §23.3.7 — intentDocHash is optional (SPEC §16.2) ────────────────────────

describe('IntentTensionSchema — intentDocHash optional', () => {
  it('accepts intentTension with intentDocHash', () => {
    const obj = { ...validIntentTension, intentDocHash: 'sha256:abc123' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('accepts intentTension without intentDocHash', () => {
    const { intentDocHash: _hash, ...obj } = validIntentTension;
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('accepts intentTension with empty intentDocHash', () => {
    const obj = { ...validIntentTension, intentDocHash: '' };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(true);
  });

  it('rejects non-string intentDocHash', () => {
    const obj = { ...validIntentTension, intentDocHash: 123 };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── §16.4 — explanation is required non-empty string ────────────────────────

describe('IntentTensionSchema — explanation required', () => {
  it('rejects missing explanation', () => {
    const { explanation: _exp, ...obj } = validIntentTension;
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });

  it('rejects non-string explanation', () => {
    const obj = { ...validIntentTension, explanation: 42 };
    expect(Value.Check(IntentTensionSchema, obj)).toBe(false);
  });
});

// ── Full valid object ────────────────────────────────────────────────────────

describe('IntentTensionSchema — full valid object', () => {
  it('accepts the canonical valid intentTension', () => {
    expect(Value.Check(IntentTensionSchema, validIntentTension)).toBe(true);
  });

  it('Value.Clean returns a clean object with all valid fields', () => {
    const withExtra = { ...validIntentTension, extraField: 'should be removed' };
    const cleaned = Value.Clean(IntentTensionSchema, withExtra) as Record<string, unknown>;
    expect(Object.hasOwn(cleaned, 'extraField')).toBe(false);
    expect(Object.hasOwn(cleaned, 'source')).toBe(true);
    expect(Object.hasOwn(cleaned, 'evidenceStrength')).toBe(true);
    expect(Object.hasOwn(cleaned, 'relatedIntentFields')).toBe(true);
    expect(Object.hasOwn(cleaned, 'evidence')).toBe(true);
    expect(Object.hasOwn(cleaned, 'explanation')).toBe(true);
    expect(Object.hasOwn(cleaned, 'suggestedOwnerAction')).toBe(true);
    expect(Object.hasOwn(cleaned, 'intentDocHash')).toBe(true);
  });

  it('rejects empty object', () => {
    expect(Value.Check(IntentTensionSchema, {})).toBe(false);
  });

  it('rejects null', () => {
    expect(Value.Check(IntentTensionSchema, null)).toBe(false);
  });

  it('rejects array', () => {
    expect(Value.Check(IntentTensionSchema, [])).toBe(false);
  });

  it('rejects string', () => {
    expect(Value.Check(IntentTensionSchema, 'not an object')).toBe(false);
  });
});
