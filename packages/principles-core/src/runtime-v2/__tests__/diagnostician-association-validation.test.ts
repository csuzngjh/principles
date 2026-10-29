import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV1Schema, DiagnosticianOutputV2Schema } from '../diagnostician-output.js';
import { validateDiagnosticianAssociations } from '../diagnostician-association-validation.js';

function output(target: unknown = { type: 'recommendation_ref', recommendationRef: 'p' }) {
  return {
    schemaVersion: 'diagnostician-output-v2', valid: true, diagnosisId: 'd', summary: 's', rootCause: 'Design: s',
    violatedPrinciples: [{ principleId: '11111111-1111-4111-8111-111111111111', rationale: 'r' }], evidence: [{ sourceRef: 'e', note: 'n' }], confidence: 1,
    recommendations: [
      { kind: 'principle', recommendationRef: 'p', description: 'Principle', abstractedPrinciple: 'Keep scope bounded' },
      { kind: 'rule', recommendationRef: 'r', description: 'Rule', triggerPattern: 'write', action: 'check',
        principleAssociation: { status: 'linked', relation: 'implements', target, rationale: 'r', evidenceRefs: ['e'] } },
    ],
  };
}
const context = { principleIds: ['11111111-1111-4111-8111-111111111111'], evidenceRefs: ['e'] };

describe('opt-in V2 association reference checks', () => {
  it('keeps V1 readable while requiring explicit V2 opt-in', () => {
    const legacy = { valid: true, diagnosisId: 'd', summary: 's', rootCause: 'r', violatedPrinciples: [], evidence: [], confidence: 1,
      recommendations: [{ kind: 'defer', description: 'defer' }] };
    expect(Value.Check(DiagnosticianOutputV1Schema, legacy)).toBe(true);
    expect(Value.Check(DiagnosticianOutputV2Schema, legacy)).toBe(false);
    expect(validateDiagnosticianAssociations(legacy, context)).toMatchObject({ ok: false, reason: 'output_invalid' });
  });
  it('links only the same-output principle ref without claiming semantic truth', () => {
    expect(validateDiagnosticianAssociations(output(), context)).toEqual({ ok: true, semanticCorrectness: 'not_evaluated',
      checks: [{ recommendationRef: 'r', status: 'linked', reason: 'references_valid' }] });
  });
  it('requires a canonical ID both in trusted context and violatedPrinciples', () => {
    const canonical = output({ type: 'canonical_principle', principleId: '11111111-1111-4111-8111-111111111111' });
    expect(validateDiagnosticianAssociations(canonical, context)).toMatchObject({ ok: true, checks: [{ status: 'linked' }] });
    expect(validateDiagnosticianAssociations(canonical, { ...context, principleIds: ['newly-added'] })).toMatchObject({ checks: [{ reason: 'principle_not_in_context' }] });
    canonical.violatedPrinciples = [];
    expect(validateDiagnosticianAssociations(canonical, context)).toMatchObject({ checks: [{ reason: 'principle_not_in_context' }] });
  });
  it.each(['missing', 'r'])('rejects a missing or non-principle ref %s', (ref) => {
    expect(validateDiagnosticianAssociations(output({ type: 'recommendation_ref', recommendationRef: ref }), context))
      .toMatchObject({ checks: [{ status: 'unresolved', reason: 'recommendation_target_invalid' }] });
  });
  it('fails duplicate refs rather than choosing the first recommendation', () => {
    const value = output();
    const [, rule] = value.recommendations;
    if (rule === undefined) throw new Error('Fixture rule missing');
    rule.recommendationRef = 'p';
    expect(validateDiagnosticianAssociations(value, context)).toMatchObject({ ok: false, reason: 'duplicate_recommendation_ref' });
  });
  it('does not use confidence to rescue evidence outside the input', () => {
    expect(validateDiagnosticianAssociations(output(), { ...context, evidenceRefs: ['other'] }))
      .toMatchObject({ checks: [{ status: 'unresolved', reason: 'evidence_not_in_context' }] });
  });
  it('rejects fabricated noncanonical IDs even when both model and allowlist agree', () => {
    const value = output({ type: 'canonical_principle', principleId: 'fake' });
    value.violatedPrinciples = [{ principleId: 'fake', rationale: 'r' }];
    expect(validateDiagnosticianAssociations(value, { ...context, principleIds: ['fake'] })).toMatchObject({ checks: [{ status: 'unresolved' }] });
  });
  it('accepts unresolved as valid diagnosis data', () => {
    const value: unknown = { ...output(), recommendations: [{ kind: 'rule', recommendationRef: 'r', description: 'r', triggerPattern: 't', action: 'a',
      principleAssociation: { status: 'unresolved', reason: 'insufficient_evidence' } }] };
    expect(validateDiagnosticianAssociations(value, context)).toMatchObject({ ok: true, checks: [{ status: 'unresolved', reason: 'insufficient_evidence' }] });
  });
  it.each([null, {}, { principleIds: [1], evidenceRefs: ['e'] }])('fails malformed context %j', (value) => {
    expect(validateDiagnosticianAssociations(output(), value)).toMatchObject({ ok: false, reason: 'context_invalid' });
  });
  it('rejects malformed array elements and empty linked evidence', () => {
    expect(Value.Check(DiagnosticianOutputV2Schema, { ...output(), recommendations: [null] })).toBe(false);
    const value = output();
    const association = value.recommendations[1]?.principleAssociation;
    if (association === undefined) throw new Error('Fixture association missing');
    association.evidenceRefs = [];
    expect(Value.Check(DiagnosticianOutputV2Schema, value)).toBe(false);
  });
});
