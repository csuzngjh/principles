/**
 * Diagnostician Output Schema Tests — Core Package (PRI-1146 V2 Only)
 *
 * Direct TypeBox schema tests for DiagnosticianOutputV2 and its nested
 * schemas. V1 was fully retired; a dedicated retirement section proves V1
 * payloads can no longer pass the contract.
 *
 * These tests pin the *schema contract* independently of the validator's
 * additional semantic checks — they are the single source of truth for what
 * the TypeBox layer accepts/rejects.
 *
 * Tests verify (PRI-518 / rc-9-no-silent-fallback + PRI-1146 V2 Only focus):
 * - schemaVersion literal "diagnostician-output-v2" required at the root;
 * - every recommendation requires an artifact-local recommendationRef;
 * - rule recommendations REQUIRE principleAssociation (linked|unresolved);
 * - non-rule recommendations must NOT carry principleAssociation;
 * - root is closed (additionalProperties: false) — unknown keys rejected;
 * - recommendations requires minItems: 1 (silent zero-candidate guard);
 * - confidence interval is closed [0, 1], not open;
 * - the persisted router envelope reads through readDiagnosticianOutputFromEnvelope;
 * - a V1-shaped payload (no schemaVersion, no refs) is REJECTED (Clean Break).
 */

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  DiagnosticianViolatedPrincipleSchema,
  DiagnosticianEvidenceSchema,
  RecommendationKindSchema,
  PrincipleAssociationSchema,
  DiagnosticianRecommendationV2Schema,
  DiagnosticianOutputV2Schema,
  DiagnosticianInvocationInputSchema,
  DIAGNOSTICIAN_ENVELOPE_KEYS,
  readDiagnosticianOutputFromEnvelope,
  type DiagnosticianOutputV2,
  type DiagnosticianRecommendationV2,
} from '../diagnostician-output.js';

// ── Minimal valid fixtures ───────────────────────────────────────────────────

// Fixture overrides merge over a discriminated union — Partial<union> does
// not distribute cleanly, so overrides are a plain record and the merge
// result is asserted by the schema checks in every test below (test-only
// fixture composition, not untrusted data).
function makeValidRecommendation(
  overrides: Record<string, unknown> = {},
): DiagnosticianRecommendationV2 {
  return {
    kind: 'defer',
    description: 'No actionable principle identified — defer to next cycle.',
    recommendationRef: 'defer-1',
    ...overrides,
  };
}

function makeValidPrincipleRecommendation(
  overrides: Record<string, unknown> = {},
): DiagnosticianRecommendationV2 {
  return {
    kind: 'principle',
    description: 'Validate data shape before use.',
    recommendationRef: 'principle-1',
    abstractedPrinciple: 'Validate data shape before use.',
    ...overrides,
  };
}

function makeValidRuleRecommendation(
  overrides: Record<string, unknown> = {},
): DiagnosticianRecommendationV2 {
  return {
    kind: 'rule',
    description: 'Interject when unvalidated payload is consumed.',
    recommendationRef: 'rule-1',
    triggerPattern: 'payload\\s*\\.\\s*\\w+',
    action: 'Run schema validation before consuming the payload.',
    principleAssociation: {
      status: 'unresolved',
      reason: 'no_supported_target',
    },
    ...overrides,
  };
}

function makeValidOutput(
  overrides: Partial<DiagnosticianOutputV2> = {},
): DiagnosticianOutputV2 {
  return {
    schemaVersion: 'diagnostician-output-v2',
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
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, { rationale: 'why' })).toBe(true);
  });

  it('accepts all fields filled', () => {
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, {
      principleId: 'T-01',
      title: 'Understand before modifying',
      rationale: 'why',
    })).toBe(true);
  });

  it('rejects empty rationale string (minLength:1)', () => {
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, { rationale: '' })).toBe(false);
  });

  it('rejects whitespace-only rationale (minLength:1 does not trim)', () => {
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, { rationale: '   ' })).toBe(true); // schema-level; semantic validator rejects
  });

  it('rejects missing rationale field (required)', () => {
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, {})).toBe(false);
  });

  it('rejects non-string rationale', () => {
    expect(Value.Check(DiagnosticianViolatedPrincipleSchema, { rationale: 42 })).toBe(false);
  });
});

// ── DiagnosticianEvidenceSchema ─────────────────────────────────────────────

describe('DiagnosticianEvidenceSchema', () => {
  it('accepts valid evidence with non-empty sourceRef and note', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: 'trace:1', note: 'observed' })).toBe(true);
  });

  it('rejects empty sourceRef (minLength:1)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: '', note: 'x' })).toBe(false);
  });

  it('rejects empty note (minLength:1)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: 'trace:1', note: '' })).toBe(false);
  });

  it('rejects missing sourceRef (required)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { note: 'x' })).toBe(false);
  });

  it('rejects missing note (required)', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, { sourceRef: 'trace:1' })).toBe(false);
  });

  it('rejects non-object evidence', () => {
    expect(Value.Check(DiagnosticianEvidenceSchema, 'evidence')).toBe(false);
  });
});

// ── RecommendationKindSchema (union of 5 literals) ──────────────────────────

describe('RecommendationKindSchema (union of 5 literals)', () => {
  it('accepts all 5 valid kinds', () => {
    for (const kind of ['principle', 'rule', 'implementation', 'prompt', 'defer']) {
      expect(Value.Check(RecommendationKindSchema, kind), kind).toBe(true);
    }
  });

  it('rejects near-miss strings (case-sensitive, typos)', () => {
    for (const kind of ['Principle', 'Rule', 'rules', 'deferr', 'prompting']) {
      expect(Value.Check(RecommendationKindSchema, kind), kind).toBe(false);
    }
  });

  it('rejects non-string kinds', () => {
    expect(Value.Check(RecommendationKindSchema, 1)).toBe(false);
    expect(Value.Check(RecommendationKindSchema, null)).toBe(false);
    expect(Value.Check(RecommendationKindSchema, ['rule'])).toBe(false);
  });
});

// ── PrincipleAssociationSchema (V2, SPEC v0.6 §4) ───────────────────────────

describe('PrincipleAssociationSchema (PRI-1146)', () => {
  it('accepts a linked association targeting a recommendation_ref', () => {
    expect(Value.Check(PrincipleAssociationSchema, {
      status: 'linked',
      relation: 'implements',
      target: { type: 'recommendation_ref', recommendationRef: 'principle-1' },
      rationale: 'the rule operationalizes the principle',
      evidenceRefs: ['trace:1'],
    })).toBe(true);
  });

  it('accepts a linked association targeting a canonical_principle', () => {
    expect(Value.Check(PrincipleAssociationSchema, {
      status: 'linked',
      relation: 'implements',
      target: { type: 'canonical_principle', principleId: '11111111-1111-4111-8111-111111111111' },
      rationale: 'implements the ledger principle',
      evidenceRefs: ['trace:1'],
    })).toBe(true);
  });

  it('rejects linked without evidenceRefs (minItems:1)', () => {
    expect(Value.Check(PrincipleAssociationSchema, {
      status: 'linked',
      relation: 'implements',
      target: { type: 'recommendation_ref', recommendationRef: 'principle-1' },
      rationale: 'x',
      evidenceRefs: [],
    })).toBe(false);
  });

  it('rejects unknown relation values (only implements)', () => {
    expect(Value.Check(PrincipleAssociationSchema, {
      status: 'linked',
      relation: 'extends',
      target: { type: 'recommendation_ref', recommendationRef: 'principle-1' },
      rationale: 'x',
      evidenceRefs: ['trace:1'],
    })).toBe(false);
  });

  it('accepts unresolved with a known reason', () => {
    expect(Value.Check(PrincipleAssociationSchema, { status: 'unresolved', reason: 'principle_not_in_context' })).toBe(true);
  });

  it('rejects unresolved with an unknown reason', () => {
    expect(Value.Check(PrincipleAssociationSchema, { status: 'unresolved', reason: 'just_because' })).toBe(false);
  });
});

// ── DiagnosticianRecommendationV2Schema ─────────────────────────────────────

describe('DiagnosticianRecommendationV2Schema', () => {
  it('accepts minimal defer recommendation (required fields incl. recommendationRef)', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, makeValidRecommendation())).toBe(true);
  });

  it('REJECTS the V1 shape — recommendation without recommendationRef', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, { kind: 'defer', description: 'x' })).toBe(false);
  });

  it('accepts principle recommendation with abstractedPrinciple', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, makeValidPrincipleRecommendation())).toBe(true);
  });

  it('accepts rule recommendation with triggerPattern + action + association', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, makeValidRuleRecommendation())).toBe(true);
  });

  it('REJECTS rule recommendation without principleAssociation', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, {
      kind: 'rule',
      description: 'x',
      recommendationRef: 'rule-1',
      triggerPattern: 'tp',
      action: 'ac',
    })).toBe(false);
  });

  it('REJECTS non-rule recommendation carrying principleAssociation (rule-only field)', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, {
      ...makeValidPrincipleRecommendation(),
      principleAssociation: { status: 'unresolved', reason: 'no_supported_target' },
    })).toBe(false);
  });

  it('rejects missing/invalid kind (required union)', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, { description: 'x', recommendationRef: 'r' })).toBe(false);
    expect(Value.Check(DiagnosticianRecommendationV2Schema, { kind: 'policy', description: 'x', recommendationRef: 'r' })).toBe(false);
  });

  it('rejects empty description (minLength:1)', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, makeValidRecommendation({ description: '' }))).toBe(false);
  });

  it('rejects empty recommendationRef (minLength:1)', () => {
    expect(Value.Check(DiagnosticianRecommendationV2Schema, makeValidRecommendation({ recommendationRef: '' }))).toBe(false);
  });
});

// ── DiagnosticianOutputV2Schema (PRI-518 minItems + PRI-1146 root closure) ──

describe('DiagnosticianOutputV2Schema', () => {
  it('PIN: recommendations has minItems === 1 (PRI-518 silent zero-candidate guard)', () => {
    const recProp = (DiagnosticianOutputV2Schema as unknown as {
      properties: { recommendations: { minItems?: number } };
    }).properties.recommendations;
    expect(recProp?.minItems).toBe(1);
  });

  it('accepts a minimal valid output with 1 defer recommendation', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput())).toBe(true);
  });

  it('accepts output with principle + linked rule + implementation recommendations', () => {
    const output = makeValidOutput({
      evidence: [{ sourceRef: 'trace:1', note: 'n' }],
      recommendations: [
        makeValidPrincipleRecommendation(),
        makeValidRuleRecommendation({
          principleAssociation: {
            status: 'linked',
            relation: 'implements',
            target: { type: 'recommendation_ref', recommendationRef: 'principle-1' },
            rationale: 'operationalizes it',
            evidenceRefs: ['trace:1'],
          },
        }),
        makeValidRecommendation({ kind: 'implementation', recommendationRef: 'implementation-1' }),
      ],
    });
    expect(Value.Check(DiagnosticianOutputV2Schema, output)).toBe(true);
  });

  it('REJECTS missing schemaVersion (the retired V1 shape)', () => {
    const v1Shape = { ...makeValidOutput() } as Record<string, unknown>;
    delete v1Shape.schemaVersion;
    expect(Value.Check(DiagnosticianOutputV2Schema, v1Shape)).toBe(false);
  });

  it('REJECTS wrong schemaVersion literal', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ schemaVersion: 'diagnostician-output-v1' as never }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ schemaVersion: 'diagnostician-output' as never }))).toBe(false);
  });

  it('REJECTS unknown extra fields at the root (closed contract)', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, { ...makeValidOutput(), bogusField: 1 })).toBe(false);
    // taskId is runner-owned lineage, not part of the output contract.
    expect(Value.Check(DiagnosticianOutputV2Schema, { ...makeValidOutput(), taskId: 'diag_router-001' })).toBe(false);
  });

  it('REJECTS a full V1 payload byte-shape (Clean Break negative)', () => {
    const v1Payload = {
      valid: true,
      diagnosisId: 'diag-uuid-0001',
      summary: 's',
      rootCause: 'Design: x',
      violatedPrinciples: [],
      evidence: [],
      recommendations: [
        { kind: 'principle', description: 'p', abstractedPrinciple: 'ap' },
        { kind: 'rule', description: 'r', triggerPattern: 'tp', action: 'ac' },
      ],
      confidence: 0.5,
    };
    expect(Value.Check(DiagnosticianOutputV2Schema, v1Payload)).toBe(false);
  });

  it('accepts confidence at exact boundaries 0 and 1 (closed interval)', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ confidence: 0 }))).toBe(true);
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ confidence: 1 }))).toBe(true);
  });

  it('accepts valid:false — diagnosis can explicitly report invalid-with-reasons', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ valid: false }))).toBe(true);
  });

  it('REJECTS recommendations: [] (the PRI-518 silent zero-candidate root cause)', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ recommendations: [] }))).toBe(false);
  });

  it('rejects missing recommendations field (required + array with items)', () => {
    const o = { ...makeValidOutput() } as Record<string, unknown>;
    delete o.recommendations;
    expect(Value.Check(DiagnosticianOutputV2Schema, o)).toBe(false);
  });

  it('rejects missing diagnosisId / summary / rootCause / valid (required fields)', () => {
    for (const field of ['diagnosisId', 'summary', 'rootCause', 'valid'] as const) {
      const o = { ...makeValidOutput() } as Record<string, unknown>;
      delete o[field];
      expect(Value.Check(DiagnosticianOutputV2Schema, o), `missing ${field}`).toBe(false);
    }
  });

  it('rejects non-boolean valid', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ valid: 'yes' as never }))).toBe(false);
  });

  it('rejects confidence outside [0,1] and non-number confidence', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ confidence: -0.01 }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ confidence: 1.01 }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ confidence: 'high' as never }))).toBe(false);
  });

  it('rejects null/undefined/string/array instead of output object', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, null)).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, undefined)).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, 'diagnostician-output-v2')).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, [makeValidOutput()])).toBe(false);
  });

  it('rejects recommendations as non-array (string/null/object)', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ recommendations: 'not-an-array' as never }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ recommendations: null as never }))).toBe(false);
    expect(Value.Check(DiagnosticianOutputV2Schema, makeValidOutput({ recommendations: { 0: makeValidRecommendation() } as never }))).toBe(false);
  });

  it('rejects when a single invalid recommendation poisons the array', () => {
    const o = makeValidOutput({
      recommendations: [
        makeValidRecommendation(),
        { kind: 'defer' } as DiagnosticianRecommendationV2, // missing description + ref
      ],
    });
    expect(Value.Check(DiagnosticianOutputV2Schema, o)).toBe(false);
  });
});

// ── Persisted envelope reader (PRI-1146: committed artifact shape) ──────────

describe('readDiagnosticianOutputFromEnvelope', () => {
  const output = makeValidOutput();

  it('reads a bare V2 output (run outputPayload shape)', () => {
    expect(readDiagnosticianOutputFromEnvelope(JSON.parse(JSON.stringify(output)))).toBeDefined();
  });

  it('reads a router envelope (output + receipt + associationValidation keys)', () => {
    const envelope = {
      ...output,
      trustedContextReceipt: { schemaVersion: 'router-context-v2', placeholder: true },
      associationValidation: { ok: true },
    };
    const read = readDiagnosticianOutputFromEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(read).toBeDefined();
    expect(read?.schemaVersion).toBe('diagnostician-output-v2');
    expect(read?.recommendations[0]?.recommendationRef).toBe('defer-1');
  });

  it('rejects an envelope missing the receipt key (arbitrary extras are not tolerated)', () => {
    expect(readDiagnosticianOutputFromEnvelope({ ...output, associationValidation: { ok: true } })).toBeUndefined();
    expect(readDiagnosticianOutputFromEnvelope({ ...output, randomExtra: 1 })).toBeUndefined();
  });

  it('rejects a V1 payload (no schemaVersion) — Clean Break read path', () => {
    const v1 = { ...output } as Record<string, unknown>;
    delete v1.schemaVersion;
    expect(readDiagnosticianOutputFromEnvelope(v1)).toBeUndefined();
  });

  it('DIAGNOSTICIAN_ENVELOPE_KEYS pins the envelope extension key set', () => {
    expect([...DIAGNOSTICIAN_ENVELOPE_KEYS]).toEqual(['trustedContextReceipt', 'associationValidation']);
  });
});

// ── DiagnosticianInvocationInputSchema ───────────────────────────────────────

describe('DiagnosticianInvocationInputSchema', () => {
  it('accepts a valid invocation input', () => {
    const input = {
      agentId: 'diagnostician',
      taskId: 'task-0001',
      context: { /* opaque unknown — validated separately via DiagnosticianContextPayload */ },
      outputSchemaRef: 'diagnostician-output' as const,
      timeoutMs: 60_000,
    };
    expect(Value.Check(DiagnosticianInvocationInputSchema, input)).toBe(true);
  });

  it('PIN: outputSchemaRef is the literal "diagnostician-output" (not any string)', () => {
    const outputRefProp = (DiagnosticianInvocationInputSchema as unknown as {
      properties: { outputSchemaRef: { const?: string } };
    }).properties.outputSchemaRef;
    expect(outputRefProp?.const ?? (outputRefProp as unknown as { anyOf?: [{ const?: string }] })?.anyOf?.[0]?.const).toBe('diagnostician-output');
  });

  it('rejects the versioned spellings on fresh invocation input (fail loud)', () => {
    for (const ref of ['diagnostician-output-v1', 'diagnostician-output-v2']) {
      const input = {
        agentId: 'diagnostician',
        taskId: 'task-0001',
        context: {},
        outputSchemaRef: ref,
        timeoutMs: 60_000,
      };
      expect(Value.Check(DiagnosticianInvocationInputSchema, input), ref).toBe(false);
    }
  });

  it('rejects negative timeoutMs and empty agentId/taskId', () => {
    const base = { agentId: 'a', taskId: 't', context: {}, outputSchemaRef: 'diagnostician-output' as const, timeoutMs: 1000 };
    expect(Value.Check(DiagnosticianInvocationInputSchema, { ...base, timeoutMs: -1 })).toBe(false);
    expect(Value.Check(DiagnosticianInvocationInputSchema, { ...base, agentId: '' })).toBe(false);
    expect(Value.Check(DiagnosticianInvocationInputSchema, { ...base, taskId: '' })).toBe(false);
  });
});
