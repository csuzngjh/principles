import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV2Schema, DiagnosticianRecommendationV2Schema } from './diagnostician-output.js';
import { validateDiagnosticianAssociations } from './diagnostician-association-validation.js';
import { isCanonicalBindingPrincipleId } from './principle-tree/rule-candidate-binding.js';

const CandidateRowsSchema = Type.Array(Type.Object({
  candidateId: Type.String({ minLength: 1 }), artifactId: Type.String({ minLength: 1 }),
  sourceRecommendation: DiagnosticianRecommendationV2Schema,
}, { additionalProperties: false }));
const IdentitySchema = Type.Object({ status: Type.Literal('resolved'), principleId: Type.String() });

export interface ShadowAssociationProposal {
  mode: 'shadow';
  recommendationRef: string;
  status: 'proposed' | 'unresolved';
  reason: string;
  targetCandidateId?: string;
  principleId?: string;
  authorizesGeneration: false;
}

/** Offline/read-only composition. The callback must use the existing principle-only
 * canonical resolver. Proposals are never production identity receipts. */
export function proposeShadowAssociations(
  output: unknown,
  context: unknown,
  sources: { artifactId: string; candidates: unknown; resolvePrincipleCandidate: (candidateId: string) => unknown },
): { ok: true; proposals: ShadowAssociationProposal[] } | { ok: false; reason: string; nextAction: string } {
  const { artifactId, candidates, resolvePrincipleCandidate } = sources;
  const validation = validateDiagnosticianAssociations(output, context);
  if (!validation.ok) return validation;
  if (!Value.Check(DiagnosticianOutputV2Schema, output) || !Value.Check(CandidateRowsSchema, candidates) || artifactId.trim() === '') {
    return { ok: false, reason: 'candidate_material_invalid', nextAction: 'Inspect persisted candidate rows and their source artifact.' };
  }
  const proposed: ShadowAssociationProposal[] = [];
  for (const check of validation.checks) {
    const result: ShadowAssociationProposal = { mode: 'shadow', recommendationRef: check.recommendationRef,
      status: 'unresolved', reason: check.reason, authorizesGeneration: false };
    if (check.status !== 'linked') { proposed.push(result); continue; }
    const rule = output.recommendations.find((item) => item.recommendationRef === check.recommendationRef);
    if (rule?.kind !== 'rule' || rule.principleAssociation.status !== 'linked') { proposed.push(result); continue; }
    const ownRows = candidates.filter((row) => row.sourceRecommendation.recommendationRef === rule.recommendationRef);
    const [ownRow] = ownRows;
    if (ownRows.length !== 1 || ownRow === undefined || ownRow.artifactId !== artifactId || !Value.Equal(ownRow.sourceRecommendation, rule)) {
      result.reason = 'candidate_mapping_invalid';
      proposed.push(result);
      continue;
    }
    const { target } = rule.principleAssociation;
    if (target.type === 'canonical_principle') {
      result.reason = 'trusted_context_producer_unavailable';
      proposed.push(result);
      continue;
    }
    const targetOutput = output.recommendations.find((item) => item.recommendationRef === target.recommendationRef);
    const matching = candidates.filter((row) => {
      return row.sourceRecommendation.recommendationRef === target.recommendationRef;
    });
    const [candidate] = matching;
    if (matching.length !== 1 || candidate === undefined || candidate.artifactId !== artifactId
      || targetOutput?.kind !== 'principle' || !Value.Equal(candidate.sourceRecommendation, targetOutput)) {
      result.reason = 'candidate_mapping_invalid';
    } else {
      result.targetCandidateId = candidate.candidateId;
      let identity: unknown;
      try { identity = resolvePrincipleCandidate(candidate.candidateId); } catch {
        result.reason = 'identity_source_unavailable';
        proposed.push(result);
        continue;
      }
      if (Value.Check(IdentitySchema, identity) && isCanonicalBindingPrincipleId(identity.principleId)) {
        result.status = 'proposed';
        result.reason = 'canonical_identity_proposed';
        result.principleId = identity.principleId;
      } else {
        const failureSchema = Type.Object({ status: Type.Literal('unresolved'), reason: Type.Union([
          Type.Literal('ledger_unavailable'), Type.Literal('ledger_corrupt'), Type.Literal('ambiguous'),
          Type.Literal('conflicting_authorities'), Type.Literal('target_missing'), Type.Literal('target_ineligible'),
        ]) });
        result.reason = Value.Check(failureSchema, identity) ? identity.reason : 'related_candidate_unresolved';
      }
    }
    proposed.push(result);
  }
  return { ok: true, proposals: proposed };
}
