import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { DiagnosticianOutputV2Schema } from './diagnostician-output.js';

const AssociationContextSchema = Type.Object({
  principleIds: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  evidenceRefs: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
}, { additionalProperties: false });

export type AssociationCheck = {
  recommendationRef: string;
  status: 'linked' | 'unresolved';
  reason: string;
};
export type AssociationValidation =
  | { ok: false; reason: 'output_invalid' | 'context_invalid' | 'duplicate_recommendation_ref'; nextAction: string }
  | { ok: true; checks: AssociationCheck[]; semanticCorrectness: 'not_evaluated' };

/** Checks reference integrity only. The caller must authenticate the persisted input context;
 * a linked result does not authorize binding or prove the implements relationship. */
export function validateDiagnosticianAssociations(output: unknown, context: unknown): AssociationValidation {
  if (!Value.Check(DiagnosticianOutputV2Schema, output)) {
    return { ok: false, reason: 'output_invalid', nextAction: 'Inspect the V2 diagnosis schema errors before shadow analysis.' };
  }
  if (!Value.Check(AssociationContextSchema, context)) {
    return { ok: false, reason: 'context_invalid', nextAction: 'Restore the verified input context; do not substitute the current Ledger.' };
  }
  const refs = new Map(output.recommendations.map((item) => [item.recommendationRef, item]));
  if (refs.size !== output.recommendations.length) {
    return { ok: false, reason: 'duplicate_recommendation_ref', nextAction: 'Keep the artifact for inspection; do not select the first duplicate.' };
  }
  const principles = new Set(context.principleIds);
  const evidence = new Set(context.evidenceRefs);
  const violated = new Set(output.violatedPrinciples.map((item) => item.principleId));
  const checks: AssociationCheck[] = [];
  for (const item of output.recommendations) {
    if (item.kind !== 'rule') continue;
    const { principleAssociation: association } = item;
    let reason: string;
    if (association.status === 'unresolved') ({ reason } = association);
    else if (association.evidenceRefs.some((ref) => !evidence.has(ref))) reason = 'evidence_not_in_context';
    else if (association.target.type === 'recommendation_ref') {
      const target = refs.get(association.target.recommendationRef);
      reason = target?.kind === 'principle' ? 'references_valid' : 'recommendation_target_invalid';
    } else {
      reason = principles.has(association.target.principleId) && violated.has(association.target.principleId)
        ? 'references_valid' : 'principle_not_in_context';
    }
    checks.push({ recommendationRef: item.recommendationRef, status: reason === 'references_valid' ? 'linked' : 'unresolved', reason });
  }
  return { ok: true, checks, semanticCorrectness: 'not_evaluated' };
}
