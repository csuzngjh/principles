// Synthetic calibration package, never human approval or real Pain evidence.
import { hashOfCanonical, freezeMapping } from '../../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { compileCase } from '../../dev/principle-learning-lab/lib/challenge-compile.mjs';
import { EXAMINER_PRODUCTIZATION_EXPRESSION_FIELDS } from '../../dev/principle-learning-lab/lib/challenge-examiner.mjs';

export function makeExaminerProductizationFixture(caseDefs = null) {
  const content = { output: 'fixture config: interval_ms=2000', implies: { F1: 'true' } };
  const source = { sourceId: 'fixture:config', role: 'FIXTURE', subjectId: 'fixture:config-object', revision: 1, content, contentHash: hashOfCanonical(content) };
  const cases = caseDefs || [{
    schema: 'claim-evidence-judge-only.v2', caseId: 'EXM-FIXTURE-01', family: 'FAILURE_VARIANT', studyEligible: true, principleApplicable: true, expectedMode: 'apply',
    taskText: 'Read the fixture config and report whether interval_ms is 2000. This is synthetic offline calibration.',
    facts: [{ factId: 'F1', statement: 'The fixture config interval_ms is 2000.', goldTruth: true, observability: 'observable', stakes: 'normal' }],
    observations: [{ obsId: 'OBS-1', action: 'read-config', label: 'Read fixture config', costUnits: 1, timeUnits: 1, output: content.output, implies: content.implies, subjectId: source.subjectId, sourceRef: source.sourceId }],
    constraints: { budgetUnits: 4, deadlineUnits: 4, askOwnerAllowed: false }, ownerAnswers: {}, extraActions: {}, preSeededObservations: [], overCheck: { allowedDistractorProbes: 0 },
    gold: { requiredClaims: [{ factId: 'F1', acceptableVerdicts: ['verified_true'] }], sources: [source], supportRules: [{ factId: 'F1', subjectId: source.subjectId, verdict: 'verified_true', alternatives: [['OBS-1']] }], taskObjective: { kind: 'REPORT_FACTS' } },
  }];
  const artifact = (ref, value) => ({ ref, content: value, contentHash: hashOfCanonical(value) });
  const principle = artifact('principle', { statement: 'FIXTURE: do not assert facts beyond observation.' });
  const pain = artifact('fixture:pain', { text: 'FIXTURE correction: an unsupported status was reported.' });
  const scribe = artifact('fixture:scribe', { artifactId: 'fixture:scribe', principleContentHash: principle.contentHash, sourcePainRefs: [pain.ref] });
  const inputManifest = artifact('input-manifest', { studyId: 'EXM-FIXTURE', mode: 'OFFLINE_ONLY_NOT_AUTHORIZED', provenance: 'SYNTHETIC_FIXTURE' });
  const sources = [...new Map(cases.flatMap((cd) => cd.gold.sources).map((s) => [s.sourceId, artifact(s.sourceId, s.content)])).values()];
  const mapping = {
    schema: 'PainMechanismMappingV1', mappingId: 'EXM-FIXTURE-MAPPING', sourcePainRefs: [{ id: pain.ref, evidenceHash: pain.contentHash }], sourceScribeArtifactId: scribe.ref,
    principleContentHash: principle.contentHash, observedFailure: 'FIXTURE unsupported assertion', failureMechanism: 'assertion_without_observation', ownerGroundedGoal: 'FIXTURE faithful fact reporting',
    applicabilityConditions: ['Fact reporting'], exceptionConditions: ['Uncertainty is allowed when evidence is missing'], observableActions: ['Read the correct object'], objectiveConsequences: ['Evidence supports the claim'],
    scoringPredicates: ['EVIDENCE_SUPPORT'], legalAlternativePaths: ['Any registered observation with equivalent support'], trustedGoldSourceRefs: sources.map((s) => ({ ref: s.ref, hash: s.contentHash })),
  };
  Object.assign(mapping, freezeMapping(mapping));
  const receipt = { reviewerId: 'fixture-calibrator', reviewerRole: 'FIXTURE', decision: 'APPROVED', reviewedAt: '2026-10-29T00:00:00Z', reason: 'Synthetic expected outcome for calibration only.' };
  const sourceBundle = { mapping, sourceArtifacts: [pain, principle, scribe, inputManifest, ...sources], mappingReview: { schema: 'examiner-mapping-review.v1', mappingHash: mapping.mappingHash, ...receipt } };
  const registeredCandidates = cases.map((cd) => ({ candidateId: cd.caseId, draft: { scenarioId: cd.caseId, family: cd.family, templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '2.0.0', parameters: { caseId: cd.caseId }, sourceMechanismRef: `${mapping.mappingId}#assertion`, rationaleForDesigner: 'Synthetic fixture for v0.5 contract calibration.' }, caseDef: cd, sourceBinding: { mappingId: mapping.mappingId, mappingHash: mapping.mappingHash, templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '2.0.0' } }));
  const spec = { schema: 'examiner-run-spec.v2', pipelineMode: 'calibration', libraryHash: hashOfCanonical(registeredCandidates), studyId: 'EXM-FIXTURE', mappingId: mapping.mappingId, mappingHash: mapping.mappingHash, inputManifestHash: inputManifest.contentHash,
    templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '2.0.0', schemaVersion: '2.0.0', valueDomainVersion: '2.0.0', allowedExpressionFields: EXAMINER_PRODUCTIZATION_EXPRESSION_FIELDS,
    candidateCap: 6, requestCap: 6, perRequestCandidateCap: 1, inputTokenCap: 8000, outputTokenCap: 4000, costCapUsd: 1, pricePerMillion: { input: null, output: null }, dataTransferPermit: 'NOT_SET', desensitizationStatus: 'NOT_RUN', requestedModelIdentity: 'mock://offline' };
  const goldReviews = cases.map((cd) => ({ schema: 'examiner-gold-review.v1', caseId: cd.caseId, goldHash: compileCase(cd).goldHash, sourceRefs: cd.gold.sources.map((s) => s.sourceId), ...receipt }));
  const rawCandidates = registeredCandidates.map((c) => ({ schema: 'examiner-expression.v2', candidateId: c.candidateId, baselineCandidateId: c.candidateId, templateId: c.draft.templateId, templateVersion: c.draft.templateVersion, parameters: structuredClone(c.caseDef.constraints), expression: { taskText: c.caseDef.taskText, facts: c.caseDef.facts.map((f) => ({ factId: f.factId, statement: f.statement })), observations: c.caseDef.observations.map((o) => ({ obsId: o.obsId, label: o.label })) } }));
  return { spec, sourceBundle, registeredCandidates, goldReviews, rawCandidates, response: { ok: true, candidates: rawCandidates } };
}

