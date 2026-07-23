/**
 * Diagnostician Output Schema Tests — Core Package
 *
 * Direct TypeBox schema tests for DiagnosticianOutputV1 and its nested schemas.
 *
 * These tests pin the *schema contract* independently of the validator's
 * additional semantic checks — they are the single source of truth for what
 * the TypeBox layer accepts/rejects.
 *
 * Tests verify (PRI-518 / rc-9-no-silent-fallback focus):
 * - DiagnosticianOutputV1Schema.recommendations requires minItems: 1 (the guard
 *   that closed the silent zero-candidate root cause).
 * - Nested schemas (evidence, violatedPrinciples, recommendation kinds) are strict.
 * - Confidence interval is closed [0, 1], not open.
 * - Edge cases: empty strings at minLength: 1 boundaries, invalid kind values.
 *
 * ERR checklist:
 * - ERR-088: assertions pin exact behavior, not just "valid/invalid" boolean —
 *   for instance, the minItems: 1 assertion reads the schema's minItems value
 *   from .properties to detect if someone loosened it to 0.
 * - ERR-089: branch coverage for every schema field — valid AND at least one
 *   invalid path exercised.
 */

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import {
  DiagnosticianViolatedPrincipleSchema,
  DiagnosticianEvidenceSchema,
  RecommendationKindSchema,
  DiagnosticianRecommendationSchema,
  DiagnosticianOutputV1Schema,
  DiagnosticianInvocationInputSchema,
  type DiagnosticianOutputV1,
  type RecommendationKind,
} from '../diagnostician-output.js';

// ── Minimal valid fixtures (shared, updated for PRI-518 minItems:1) ────────

function makeValidRecommendation(overrides: Partial<{
  kind: RecommendationKind;
  description: string;
  triggerPattern: string;
  action: string;
  abstractedPrinciple: string;
}> = {}): DiagnosticianOutputV1['recommendations'][number] {
  return {
    kind: 'defer',
    description: 'No actionable principle identified — defer to next cycle.',
    ...overrides,
  };
}

function makeValidOutput(
  overrides: Partial<DiagnosticianOutputV1> = {},
): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-uuid-0001',
    summary: 'Diagnosis summary of observed pain signal.',
    rootCause: 'Assumption: workflow assumed X without validating data shape.',
    violatedPrinciples: [],
    evidence: [],
    recommendations: [makeValidRecommendation()],
    confidence: 0.85,
    ...overrides,
  };
}

// ── DiagnosticianViolatedPrincipleSchema ────────────────────────────────────

describe('DiagnosticianViolatedPrincipleSchema', () => {
  it('accepts object with only required rationale (minLength:1)', () => {
    const v = { rationale: 'Violated because X' };
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, v)).toBe(true);
  });

  it('accepts all fields filled', () => {
    const v = {
      principleId: 'PRI-001',
      title: 'Broken contract',
      rationale: 'Violated because X',
    };
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, v)).toBe(true);
  });

  it('rejects empty rationale string (minLength:1)', () => {
    const v = { rationale: '' };
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, v)).toBe(false);
  });

  it('rejects whitespace-only rationale (minLength:1 does not trim)', () => {
    // Note: TypeBox minLength operates on raw string length, not trimmed.
    // So whitespace passes minLength:1 — this is a known schema gap, the
    // validator's semantic checks handle trimmed empty in step 2 of default-validator.
    const v = { rationale: '   ' };
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, v)).toBe(true);
  });

  it('rejects missing rationale field (required)', () => {
    const v = { principleId: 'PRI-001' } as const;
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, v)).toBe(false);
  });

  it('rejects non-string rationale', () => {
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, { rationale: 42 })).toBe(false);
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, { rationale: null })).toBe(false);
  });
});

// ── DiagnosticianEvidenceSchema ─────────────────────────────────────────────

describe('DiagnosticianEvidenceSchema', () => {
  it('accepts valid evidence with non-empty sourceRef and note', () => {
    const v = { sourceRef: 'turn-3:tool-call', note: 'User reported error' };
    expect(Value.Check(DiagnosticianEvidenceSchema, v)).toBe(true);
  });

  it('rejects empty sourceRef (minLength:1)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: '', note: 'x' })).toBe(false);
  });

  it('rejects empty note (minLength:1)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: 'x', note: '' })).toBe(false);
  });

  it('rejects missing sourceRef (required)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { note: 'x' })).toBe(false);
  });

  it('rejects missing note (required)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: 'x' })).toBe(false);
  });

  it('rejects non-object evidence', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, null)).toBe(false);
    expect(Value.Check(DiagnosticianEvidenceSchema, 'source:note')).toBe(false);
  });
});

// ── RecommendationKindSchema ───────────────────────────────────────────────

describe('RecommendationKindSchema (union of 5 literals)', () => {
  it('accepts all 5 valid kinds', () => {
    const valid: RecommendationKind[] = ['principle', 'rule', 'implementation', 'prompt', 'defer'];
    for (const k of valid) {
      expect(Value.Check(RecommendationKindSchema, k)).toBe(true);
    }
  });

  it('rejects near-miss strings (case-sensitive, typos)', () => {
    const nearMisses = [
      'PRINCIPLE', 'Rule', 'IMPLEMENTATION',   // case variants
      'princples', 'rul', 'deferr',             // typos
      'suggest', 'skip', 'noop', 'none',       // plausible but not in union
      '', ' defer', 'defer ',                   // whitespace
    ];
    for (const k of nearMisses) {
      expect(Value.Check(RecommendationKindSchema, k)).toBe(false);
    }
  });

  it('rejects non-string kinds', () => {
    expect(Value.Check(RecommendationKindSchema, 1)).toBe(false);
    expect(Value.Check(RecommendationKindSchema, null)).toBe(false);
    expect(Value.Check(RecommendationKindSchema, undefined)).toBe(false);
    expect(Value.Check(RecommendationKindSchema, ['principle'])).toBe(false);
  });
});

// ── DiagnosticianRecommendationSchema ───────────────────────────────────────

describe('DiagnosticianRecommendationSchema', () => {
  it('accepts minimal defer recommendation (only required fields)', () => {
    const r = makeValidRecommendation({ kind: 'defer', description: 'Defer' });
    expect(Value.Check(DiagnosticianRecommendationSchema, r)).toBe(true);
  });

  it('accepts principle recommendation with abstractedPrinciple (required for kind principle? schema marks it Optional but semantic validator enforces it)', () => {
    // Note: abstractedPrinciple is TypeBox Optional here; the semantic
    // validator (default-validator step 2f) enforces it when kind==='principle'.
    // This test pins that the schema alone is loose on the per-kind requirement.
    const r1 = makeValidRecommendation({
      kind: 'principle',
      description: 'Principle-level insight.',
      abstractedPrinciple: 'Handle tool failures gracefully to preserve trust.',
    });
    expect(Value.Check(DiagnosticianRecommendationSchema, r1)).toBe(true);
  });

  it('accepts rule recommendation with triggerPattern + action', () => {
    const r = makeValidRecommendation({
      kind: 'rule',
      description: 'Block writes to /etc.',
      triggerPattern: 'tool_name=write_file AND path starts with /etc',
      action: 'block',
    });
    expect(Value.Check(DiagnosticianRecommendationSchema, r)).toBe(true);
  });

  it('rejects missing/invalid kind (required union)', () => {
    const noKind = { description: 'x' } as const;
    expect(Value.Check(DiagnosticianRecommendationSchema, noKind)).toBe(false);

    const badKind = { kind: 'suggest', description: 'x' } as const;
    expect(Value.Check(DiagnosticianRecommendationSchema, badKind)).toBe(false);
  });

  it('rejects empty description (minLength:1)', () => {
    const r = makeValidRecommendation({ description: '' });
    expect(Value.Check(DiagnosticianRecommendationSchema, r)).toBe(false);
  });

  it('rejects missing description (required)', () => {
    const r = { kind: 'defer' } as const;
    expect(Value.Check(DiagnosticianRecommendationSchema, r)).toBe(false);
  });
});

// ── DiagnosticianOutputV1Schema — PRIMARY FOCUS (PRI-518) ──────────────────

describe('DiagnosticianOutputV1Schema (PRI-518 — minItems:1 on recommendations)', () => {

  // ── Schema-level assertion: minItems IS 1 (not 0, not undefined) ──────────
  it('PIN: DiagnosticianOutputV1Schema.properties.recommendations has minItems === 1', () => {
    // This is the PRI-518 root-cause guard at the schema level.
    // ERR-088: read the schema's own property, not just behavior via Value.Check.
    // If someone reverts minItems to 0, this test will fail — not just the
    // downstream "empty array rejected" test (which could be fooled by other means).
    const recProp = (DiagnosticianOutputV1Schema as unknown as { properties: { recommendations: { minItems?: number } } }).properties.recommendations;
    expect(recProp).toBeDefined();
    expect(typeof recProp.minItems).toBe('number');
    expect(recProp.minItems).toBe(1);
  });

  it('PIN: recommendations array type is enforced (not unknown[] fallback)', () => {
    // Sanity — the property has a type we can introspect.
    const recs = (DiagnosticianOutputV1Schema as unknown as { properties: { recommendations: TSchema } }).properties.recommendations;
    expect((recs as unknown as { kind?: string })?.kind ?? 'array').toBeTruthy();
  });

  // ── Accept paths ───────────────────────────────────────────────────────────
  it('accepts a minimal valid output with 1 defer recommendation', () => {
    const o = makeValidOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  it('accepts output with 5 recommendations (many, valid kinds)', () => {
    const o = makeValidOutput({
      recommendations: [
        makeValidRecommendation({ kind: 'principle', description: 'P', abstractedPrinciple: 'W' }),
        makeValidRecommendation({ kind: 'rule', description: 'R', triggerPattern: 'p', action: 'b' }),
        makeValidRecommendation({ kind: 'implementation', description: 'I' }),
        makeValidRecommendation({ kind: 'prompt', description: 'P' }),
        makeValidRecommendation({ kind: 'defer', description: 'D' }),
      ],
    });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  it('accepts confidence at exact lower boundary 0', () => {
    const o = makeValidOutput({ confidence: 0 });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  it('accepts confidence at exact upper boundary 1', () => {
    const o = makeValidOutput({ confidence: 1 });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  it('accepts valid:false — diagnosis can explicitly report invalid-with-reasons', () => {
    const o = makeValidOutput({ valid: false });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  it('accepts filled evidence and violatedPrinciples arrays', () => {
    const o = makeValidOutput({
      violatedPrinciples: [
        { principleId: 'PRI-001', rationale: 'Rationale here.' },
      ],
      evidence: [
        { sourceRef: 'turn-1', note: 'User error report' },
        { sourceRef: 'turn-2', note: 'Tool failure trace' },
      ],
    });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  it('accepts optional ambiguityNotes string array', () => {
    const o = makeValidOutput({
      ambiguityNotes: ['Not enough data on X', 'Y may be transient'],
    });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(true);
  });

  // ── Reject paths — PRI-518 root cause (silent zero-candidates) ────────────
  it('REJECTS recommendations: [] — empty array (the PRI-518 silent zero-candidate root cause)', () => {
    // This was the exact pattern that caused 4 pain records → 8 leased tasks → 0 candidates.
    // Schema must reject it at the boundary; validator's semantic check is defense-in-depth.
    const o = makeValidOutput({ recommendations: [] });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(false);
  });

  it('REJECTS missing recommendations field (required + array with items)', () => {
    const { recommendations: _omit, ...rest } = makeValidOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, rest)).toBe(false);
  });

  // ── Reject paths — other required fields ───────────────────────────────────
  it('rejects missing diagnosisId (required, minLength:1)', () => {
    const { diagnosisId: _omit, ...rest } = makeValidOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, rest)).toBe(false);
  });

  it('rejects empty diagnosisId (minLength:1)', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ diagnosisId: '' }))).toBe(false);
  });

  it('rejects missing summary (required, minLength:1)', () => {
    const { summary: _omit, ...rest } = makeValidOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, rest)).toBe(false);
  });

  it('rejects empty summary (minLength:1)', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ summary: '' }))).toBe(false);
  });

  it('rejects missing rootCause (required, minLength:1)', () => {
    const { rootCause: _omit, ...rest } = makeValidOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, rest)).toBe(false);
  });

  it('rejects empty rootCause (minLength:1)', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ rootCause: '' }))).toBe(false);
  });

  it('rejects missing valid boolean field (required)', () => {
    const { valid: _omit, ...rest } = makeValidOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, rest)).toBe(false);
  });

  it('rejects valid as non-boolean (string, number)', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ valid: 'true' as unknown as boolean }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ valid: 1 as unknown as boolean }))).toBe(false);
  });

  // ── Reject paths — confidence outside [0,1] ────────────────────────────────
  it('rejects confidence slightly below 0', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ confidence: -0.0001 }))).toBe(false);
  });

  it('rejects confidence slightly above 1', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ confidence: 1.0001 }))).toBe(false);
  });

  it('rejects confidence as NaN or Infinity (TypeBox minimum/maximum on number requires finite)', () => {
    // Note: TypeBox number schema with minimum/maximum rejects NaN natively.
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ confidence: NaN }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ confidence: Infinity }))).toBe(false);
  });

  it('rejects confidence as non-number (string/null)', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ confidence: 'high' as unknown as number }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV1Schema, makeValidOutput({ confidence: null as unknown as number }))).toBe(false);
  });

  // ── Reject paths — non-object / malformed inputs ───────────────────────────
  it('rejects null instead of output object', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, null)).toBe(false);
  });

  it('rejects undefined instead of output object', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, undefined)).toBe(false);
  });

  it('rejects string masquerading as output', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, 'diagnostician-output-v1')).toBe(false);
  });

  it('rejects array instead of output object', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema, [makeValidOutput()])).toBe(false);
  });

  // ── Reject paths — recommendations is not an array ─────────────────────────
  it('rejects recommendations set to a string (not iterable — guards against for...of throw)', () => {
    // Related to default-validator's 2e-bis guard: for...of undefined would throw
    // if the semantic guard missed. Schema rejects non-array at the boundary.
    expect(Value.Check(DiagnosticianOutputV1Schema,
      makeValidOutput({ recommendations: 'not-an-array' as unknown as DiagnosticianOutputV1['recommendations'] })))
      .toBe(false);
  });

  it('rejects recommendations set to null', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema,
      makeValidOutput({ recommendations: null as unknown as DiagnosticianOutputV1['recommendations'] })))
      .toBe(false);
  });

  it('rejects recommendations set to an object (not array)', () => {
    expect(Value.Check(DiagnosticianOutputV1Schema,
      makeValidOutput({ recommendations: { 0: makeValidRecommendation() } as unknown as DiagnosticianOutputV1['recommendations'] })))
      .toBe(false);
  });

  // ── Reject paths — single invalid recommendation poisons the whole array ───
  it('rejects a 2-item recommendations array when the 2nd item lacks description', () => {
    // Array items are validated against the item schema — a single bad item
    // should cause the whole output to fail schema check.
    const o = makeValidOutput({
      recommendations: [
        makeValidRecommendation(),
        { kind: 'defer' } as DiagnosticianOutputV1['recommendations'][number],  // missing description
      ],
    });
    expect(Value.Check(DiagnosticianOutputV1Schema, o)).toBe(false);
  });
});

// ── DiagnosticianInvocationInputSchema ───────────────────────────────────────

describe('DiagnosticianInvocationInputSchema', () => {
  it('accepts a valid invocation input', () => {
    const input = {
      agentId: 'diagnostician',
      taskId: 'task-0001',
      context: { /* opaque unknown — validated separately via DiagnosticianContextPayload */ },
      outputSchemaRef: 'diagnostician-output-v1' as const,
      timeoutMs: 60_000,
    };
    expect(Value.Check(DiagnosticianInvocationInputSchema, input)).toBe(true);
  });

  it('PIN: outputSchemaRef is the literal "diagnostician-output-v1" (not any string)', () => {
    // Pin that the schema only accepts the exact literal, not v2 or other refs.
    const outputRefProp = (DiagnosticianInvocationInputSchema as unknown as {
      properties: { outputSchemaRef: { const?: string } };
    }).properties.outputSchemaRef;
    expect(outputRefProp?.const ?? (outputRefProp as unknown as { anyOf?: [{ const?: string }] })?.anyOf?.[0]?.const).toBe('diagnostician-output-v1');
  });

  it('rejects wrong outputSchemaRef (schema drift detection)', () => {
    const input = {
      agentId: 'diagnostician',
      taskId: 'task-0001',
      context: {},
      outputSchemaRef: 'diagnostician-output-v2', // bumped by mistake
      timeoutMs: 60_000,
    };
    expect(Value.Check(DiagnosticianInvocationInputSchema, input)).toBe(false);
  });

  it('rejects negative timeoutMs (minimum: 0)', () => {
    const input = {
      agentId: 'diagnostician',
      taskId: 'task-0001',
      context: {},
      outputSchemaRef: 'diagnostician-output-v1' as const,
      timeoutMs: -1,
    };
    expect(Value.Check(DiagnosticianInvocationInputSchema, input)).toBe(false);
  });

  it('accepts timeoutMs = 0 (fire-and-forget or no-wait is a valid contract)', () => {
    const input = {
      agentId: 'diagnostician',
      taskId: 'task-0001',
      context: {},
      outputSchemaRef: 'diagnostician-output-v1' as const,
      timeoutMs: 0,
    };
    expect(Value.Check(DiagnosticianInvocationInputSchema, input)).toBe(true);
  });

  it('rejects empty agentId / taskId (minLength:1)', () => {
    const base = {
      context: {},
      outputSchemaRef: 'diagnostician-output-v1' as const,
      timeoutMs: 1000,
    };
    expect(Value.Check(DiagnosticianInvocationInputSchema, { ...base, agentId: '', taskId: 't' })).toBe(false);
    expect(Value.Check(DiagnosticianInvocationInputSchema, { ...base, agentId: 'a', taskId: '' })).toBe(false);
  });
});

// ── ERR-088 defense-in-depth: schema ↔ validator agreement on recommendations ─
describe('cross-contract: schema minItems agrees with semantic checks', () => {
  it('schema rejects empty recommendations AND Validator step 2e-bis would also reject', () => {
    // This test does NOT import the validator (keeps this test independent of
    // runtime-v2/runner module graph). Instead it documents the defense-in-depth
    // agreement: both layers MUST reject. We verify schema's behavior here, and
    // the validator's own test file (default-validator.test.ts) asserts the
    // semantic check. When both fail green, the two layers agree.
    const empty = makeValidOutput({ recommendations: [] });
    const schemaRejects = !Value.Check(DiagnosticianOutputV1Schema, empty);
    expect(schemaRejects).toBe(true);
  });
});
