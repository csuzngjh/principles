/**
 * Read-only source-declared-relation resolution (SPEC-PD-RULE-ASSOCIATION-005
 * v0.6 §6; PRI-1146).
 *
 * This module is the SHADOW half of rule→principle association: given the
 * persisted V2 artifact (with its trustedContextReceipt), the persisted
 * candidate rows of the same artifact, and the shared ledger identity ports,
 * it reconstructs each rule recommendation's declared relation and resolves it
 * to a canonical principleId — or a structured unresolved reason.
 *
 * Hard governance boundary (OD-01/02/03 pending):
 *   - every result carries `mode: 'shadow'` and `authorizesGeneration: false`;
 *   - a resolved result is a SYSTEM source declaration (`basis:
 *     'source_declared_relation'`), NEVER an Owner Identity Receipt;
 *   - callers must not write ruleCandidateBindings, start Scribe, or treat a
 *     `proposed` result as approval/activation authority.
 *
 * The pure structural core is `validateDiagnosticianAssociations`
 * (diagnostician-association-validation.ts); the ledger ports stay on
 * PrincipleTreeLedgerAdapter — this module only composes them.
 */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV2Schema, DiagnosticianRecommendationV2Schema, readDiagnosticianOutputFromEnvelope, type DiagnosticianRecommendationV2 } from './diagnostician-output.js';
import { validateDiagnosticianAssociations } from './diagnostician-association-validation.js';
import { readRouterContextReceipt } from './internalization/router-context-evidence.js';
import { isCanonicalBindingPrincipleId } from './principle-tree/rule-candidate-binding.js';

const CandidateRowsSchema = Type.Array(Type.Object({
  candidateId: Type.String({ minLength: 1 }), artifactId: Type.String({ minLength: 1 }),
  sourceRecommendation: DiagnosticianRecommendationV2Schema,
}, { additionalProperties: false }));
const IdentitySchema = Type.Object({ status: Type.Literal('resolved'), candidateId: Type.String({ minLength: 1 }), principleId: Type.String() });

export interface ShadowAssociationProposal {
  mode: 'shadow';
  recommendationRef: string;
  status: 'proposed' | 'unresolved';
  reason: string;
  targetCandidateId?: string;
  principleId?: string;
  authorizesGeneration: false;
}

/** Inputs shared by both resolver entry points. */
interface ShadowSources {
  artifactId: string;
  candidates: unknown;
  resolvePrincipleCandidate: (candidateId: string) => unknown;
}

/** Offline/read-only composition over a hand-assembled context. Kept for
 * callers that already hold a verified context (tests, replay tooling); the
 * production-facing envelope entry point is `resolveSourceDeclaredRelations`. */
export function proposeShadowAssociations(
  output: unknown,
  context: unknown,
  sources: ShadowSources,
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
      if (Value.Check(IdentitySchema, identity) && identity.candidateId === candidate.candidateId && isCanonicalBindingPrincipleId(identity.principleId)) {
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

// ── Envelope-driven source-declared-relation resolution (production shape) ───

/** One persisted candidate row of the artifact (loaded by the caller). */
export interface SourceRelationCandidateRow {
  candidateId: string;
  artifactId: string;
  recommendationKind: string;
  sourceRecommendation: DiagnosticianRecommendationV2;
}

/**
 * Read-only resolution of one rule candidate's source-declared relation
 * (SPEC v0.6 §6). `basis` appears only on `proposed` results and is always
 * `source_declared_relation` — a system source declaration, not an Owner
 * binding (OD-01 pending: shadow only).
 */
export type SourceDeclaredRelationResolution =
  | {
    mode: 'shadow';
    candidateId: string;
    recommendationRef: string;
    status: 'proposed';
    reason: 'canonical_identity_proposed';
    basis: 'source_declared_relation';
    principleId: string;
    targetCandidateId?: string;
    /** Structural validity only — semantics were NOT evaluated. */
    semanticCorrectness: 'not_evaluated';
    authorizesGeneration: false;
  }
  | {
    mode: 'shadow';
    candidateId: string;
    recommendationRef: string;
    status: 'unresolved';
    reason: string;
    nextAction: string;
    authorizesGeneration: false;
  };

export interface ResolveSourceDeclaredRelationsInput {
  /** The artifact envelope (artifact.contentJson) carrying trustedContextReceipt. */
  envelope: unknown;
  /** The same run's persisted output (run.outputPayload) — bare V2 output. */
  runOutput: unknown;
  /** The artifact's candidate rows as persisted (sourceRecommendation parsed). */
  candidates: readonly SourceRelationCandidateRow[];
  /** Lineage anchors for receipt verification. */
  taskId: string;
  runId: string;
  artifactId: string;
  /** Shared ledger port: principle-kind candidate → canonical identity. */
  resolvePrincipleCandidate: (candidateId: string) => unknown;
  /** Shared ledger port: canonical principle current eligibility. */
  resolveCanonicalEligibility: (principleId: string) => { eligible: true } | { eligible: false; reason: 'missing' | 'ineligible' };
}

/**
 * Resolve the source-declared relation for EVERY rule candidate of one
 * diagnostician artifact, strictly read-only:
 *
 *  1. read + lineage-verify the trustedContextReceipt from the envelope
 *     (the current Ledger is never a substitute for the historical exposure);
 *  2. validate the persisted output (V2) against the receipt's exposure;
 *  3. per rule candidate: reconstruct the persisted recommendation
 *     deterministically (same artifact, unique recommendationRef match,
 *     byte-equal sourceRecommendation), then resolve the declared target:
 *       - recommendation_ref → the target principle candidate row of the same
 *         artifact → shared principle-candidate identity resolution (fail on
 *         ambiguity/missing/corrupt, never first-match);
 *       - canonical_principle → receipt exposure + current ledger eligibility;
 *  4. anything unprovable stays a structured `unresolved` with nextAction.
 *
 * Semantic correctness is never claimed (`not_evaluated`).
 */
export function resolveSourceDeclaredRelations(
  input: ResolveSourceDeclaredRelationsInput,
): { ok: true; resolutions: SourceDeclaredRelationResolution[] } | { ok: false; reason: string; nextAction: string } {
  const { envelope, runOutput, candidates, taskId, runId, artifactId } = input;
  if (artifactId.trim() === '') {
    return { ok: false, reason: 'candidate_material_invalid', nextAction: 'Load the candidate rows with their source artifact id.' };
  }
  const receiptRead = readRouterContextReceipt(envelope, { taskId, runId });
  if (receiptRead.status !== 'available') {
    return { ok: false, reason: receiptRead.reason, nextAction: receiptRead.nextAction };
  }
  const {receipt} = receiptRead;
  const output = readDiagnosticianOutputFromEnvelope(envelope) ?? (Value.Check(DiagnosticianOutputV2Schema, runOutput) ? runOutput : undefined);
  if (output === undefined) {
    return { ok: false, reason: 'output_invalid', nextAction: 'The persisted artifact/run payload is not a valid DiagnosticianOutputV2; re-run the diagnosis.' };
  }
  if (receipt.canonicalPrinciples.status !== 'available') {
    return { ok: false, reason: 'context_invalid', nextAction: 'The trusted context exposure is not provable for this artifact; canonical associations stay unresolved.' };
  }
  const context = {
    principleIds: receipt.canonicalPrinciples.principles.map((p) => p.principleId),
    evidenceRefs: receipt.evidenceRefs,
  };
  const validation = validateDiagnosticianAssociations(output, context);
  if (!validation.ok) return validation;

  const checksByRef = new Map(validation.checks.map((check) => [check.recommendationRef, check]));
  const rowsByRef = new Map<string, SourceRelationCandidateRow>();
  for (const row of candidates) {
    if (row.artifactId !== artifactId || row.recommendationKind !== 'rule') continue;
    if (rowsByRef.has(row.sourceRecommendation.recommendationRef)) {
      return { ok: false, reason: 'candidate_material_invalid', nextAction: `Duplicate candidate rows for recommendationRef ${row.sourceRecommendation.recommendationRef} under artifact ${artifactId}.` };
    }
    rowsByRef.set(row.sourceRecommendation.recommendationRef, row);
  }

  const unresolved = (args: { candidateId: string; recommendationRef: string; reason: string; nextAction: string }): SourceDeclaredRelationResolution =>
    ({ mode: 'shadow', candidateId: args.candidateId, recommendationRef: args.recommendationRef, status: 'unresolved', reason: args.reason, nextAction: args.nextAction, authorizesGeneration: false });

  const resolutions: SourceDeclaredRelationResolution[] = [];
  for (const [recommendationRef, row] of rowsByRef) {
    const rule = output.recommendations.find((item) => item.recommendationRef === recommendationRef);
    if (rule?.kind !== 'rule' || rule.principleAssociation.status !== 'linked') {
      const check = checksByRef.get(recommendationRef);
      resolutions.push(unresolved({
        candidateId: row.candidateId, recommendationRef,
        reason: rule?.kind === 'rule' ? (rule.principleAssociation.status === 'unresolved' ? rule.principleAssociation.reason : 'source_relation_invalid') : (check?.reason ?? 'source_relation_invalid'),
        nextAction: 'Keep the candidate in the Owner exception queue; no Scribe call is authorized.',
      }));
      continue;
    }
    // Deterministic reconstruction: the persisted recommendation must be
    // byte-equal to the artifact's rule recommendation.
    if (!Value.Equal(row.sourceRecommendation, rule)) {
      resolutions.push(unresolved({
        candidateId: row.candidateId, recommendationRef, reason: 'source_relation_stale',
        nextAction: 'The persisted candidate recommendation no longer matches the artifact; keep both for audit and re-run the diagnosis.',
      }));
      continue;
    }
    const { target } = rule.principleAssociation;
    if (target.type === 'canonical_principle') {
      const eligibility = input.resolveCanonicalEligibility(target.principleId);
      if (!eligibility.eligible) {
        resolutions.push(unresolved({
          candidateId: row.candidateId, recommendationRef,
          reason: eligibility.reason === 'missing' ? 'target_missing' : 'target_ineligible',
          nextAction: 'Review the target principle in the Owner Console; it is missing or not in an eligible lifecycle state.',
        }));
        continue;
      }
      resolutions.push({
        mode: 'shadow', candidateId: row.candidateId, recommendationRef,
        status: 'proposed', reason: 'canonical_identity_proposed', basis: 'source_declared_relation',
        principleId: target.principleId, semanticCorrectness: 'not_evaluated', authorizesGeneration: false,
      });
      continue;
    }
    // recommendation_ref target: unique principle-kind candidate of the SAME artifact.
    const targetOutput = output.recommendations.find((item) => item.recommendationRef === target.recommendationRef);
    const targetRowsAll = candidates.filter((candidateRow) =>
      candidateRow.artifactId === artifactId && candidateRow.sourceRecommendation.recommendationRef === target.recommendationRef);
    const [targetRow] = targetRowsAll;
    if (targetRowsAll.length !== 1 || targetRow === undefined || targetOutput?.kind !== 'principle'
      || !Value.Equal(targetRow.sourceRecommendation, targetOutput)) {
      resolutions.push(unresolved({
        candidateId: row.candidateId, recommendationRef, reason: 'candidate_mapping_invalid',
        nextAction: 'The declared recommendation_ref target does not map to exactly one principle candidate of the same artifact.',
      }));
      continue;
    }
    let identity: unknown;
    try { identity = input.resolvePrincipleCandidate(targetRow.candidateId); } catch {
      resolutions.push(unresolved({
        candidateId: row.candidateId, recommendationRef, reason: 'identity_source_unavailable',
        nextAction: 'The ledger identity source threw; inspect the Principle Ledger and retry the read-only resolution.',
      }));
      continue;
    }
    if (Value.Check(IdentitySchema, identity) && identity.candidateId === targetRow.candidateId && isCanonicalBindingPrincipleId(identity.principleId)) {
      resolutions.push({
        mode: 'shadow', candidateId: row.candidateId, recommendationRef,
        status: 'proposed', reason: 'canonical_identity_proposed', basis: 'source_declared_relation',
        principleId: identity.principleId, targetCandidateId: targetRow.candidateId,
        semanticCorrectness: 'not_evaluated', authorizesGeneration: false,
      });
      continue;
    }
    const failureSchema = Type.Object({ status: Type.Literal('unresolved'), reason: Type.Union([
      Type.Literal('ledger_unavailable'), Type.Literal('ledger_corrupt'), Type.Literal('ambiguous'),
      Type.Literal('conflicting_authorities'), Type.Literal('target_missing'), Type.Literal('target_ineligible'),
      Type.Literal('missing'),
    ]) });
    resolutions.push(unresolved({
      candidateId: row.candidateId, recommendationRef,
      reason: Value.Check(failureSchema, identity) ? identity.reason : 'related_candidate_unresolved',
      nextAction: 'The target principle candidate has no canonical identity yet (reuse/create decision pending) or the ledger is unavailable.',
    }));
  }
  return { ok: true, resolutions };
}
