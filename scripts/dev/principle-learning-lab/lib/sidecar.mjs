// PRI-969 — research sidecar data contract + validator.
//
// The sidecar is a RESEARCH VIEW ONLY (SPEC §6): it references facts, it
// never becomes a second authority for Principle lifecycle, approvals,
// activation or identity. No Ledger, Approval or Activation records are
// fabricated here; simulated arms carry pipelineReachability=NOT_REACHED.
//
// Contracts:
//   principle-study.v1  — study metadata, claims registry, arms (with frozen
//                         candidates), assignment, memory manifests
//   adjudication.v0.1   — one row per (arm, opportunity) via evaluator
//
// validateSidecar() enforces the shape invariants AND the SPEC's hard
// negative tests:
//   NT-01 gold leak into actor input                    (scanGoldLeak basis)
//   NT-02 foreign leakage-group pairing                 (assembleActorInput basis)
//   NT-03 same-episode history→future is NOT a leak     (must stay legal)
//   NT-04 no-PD-activation arm still scored             (NOT_REACHED + graded)
//   NT-05 NOT_REACHED must not equal behavior failure   (reason-code guard)
//   NT-06 no principleId fabrication by title           (id registry guard)
//   NT-07 no post-cutoff evidence in early labels       (occurredAt guard)
//   NT-08 antiPatterns ≠ non-applicability              (NA reason allowlist)

import { canonicalJson, sha256 } from './fixture.mjs';

export const STUDY_SCHEMA = 'principle-study.v1';
export const ADJUDICATION_SCHEMA = 'adjudication.v0.1';

export const CLAIM_STATUS_VALUES = [
  'METHOD_VALIDATED_ONLY',
  'NOT_ESTIMABLE',
  'PARTIALLY_OBSERVABLE',
  'NOT_SUPPORTED',
];
export const PIPELINE_REACHABILITY_VALUES = ['NOT_REACHED', 'REACHED', 'UNKNOWN'];
export const ACTOR_RUN_STATUS_VALUES = ['COMPLETED', 'FAILED', 'NO_RESPONSE', 'INTERRUPTED', 'UNKNOWN'];
export const OBJECTIVE_TASK_STATUS_VALUES = ['PASS', 'FAIL', 'UNKNOWN'];
export const PRINCIPLE_ALIGNMENT_VALUES = ['ALIGNED', 'ACCEPTABLE', 'MISALIGNED', 'INCONCLUSIVE', 'NOT_APPLICABLE'];
export const DATA_QUALITY_FLAGS = ['VALID', 'INVALID_PROTOCOL', 'UNCERTAIN'];
const NA_REASON_ALLOWLIST = ['no_principle_in_force', 'opportunity_out_of_scope'];

/**
 * PRI-971 G2 freeze interface (also used by G1 simulated arms): freeze a
 * candidate's exact bytes + hash + delivery representation. The same function
 * will freeze real I0/I1 outputs in G2 — real runs differ only in where the
 * policyText bytes come from, never in the freeze mechanics.
 */
export function freezeCandidate({ policyText, sourceStage, deliveredRepresentation }) {
  if (typeof policyText !== 'string' || policyText.length === 0) {
    throw new Error('freezeCandidate: policyText must be a non-empty string');
  }
  return {
    policyText,
    contentHash: sha256(policyText),
    byteLength: Buffer.byteLength(policyText, 'utf8'),
    sourceStage,
    deliveredRepresentation,
    // G1 has no real Principle identity; NT-06 forbids inventing one.
    principleId: null,
    principleIdStatus: 'UNKNOWN',
  };
}

/** Build the principle-study sidecar for a completed pilot run. */
export function buildStudySidecar({ dataset, studyId, arms, claims, assignment, runtime }) {
  return {
    schemaVersion: STUDY_SCHEMA,
    studyId,
    specRef: dataset.manifest.specRef,
    dataset: {
      datasetId: dataset.manifest.datasetId,
      datasetVersion: dataset.manifest.datasetVersion,
      fixtureHash: dataset.fixtureHash,
    },
    claims,
    arms,
    assignment,
    runtime,
    authorityNote:
      'Research view only. Runtime facts (if any) remain owned by the production stores; this sidecar fabricates no governance records.',
  };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a study + adjudications against the loaded dataset and the recorded
 * actor inputs. Returns problems[]; empty = valid. rc-1/rc-3/rc-4 discipline:
 * every field is checked loudly, element types included.
 */
export function validateSidecar({ dataset, study, adjudications, actorInputs, knownStrategyIds }) {
  const problems = [];
  const p = (msg) => problems.push(msg);

  if (!isPlainObject(study)) {
    return ['study must be a JSON object'];
  }
  if (study.schemaVersion !== STUDY_SCHEMA) p(`study.schemaVersion must be ${STUDY_SCHEMA}`);
  if (typeof study.studyId !== 'string' || study.studyId === '') p('study.studyId must be a non-empty string');
  if (!isPlainObject(study.dataset)) p('study.dataset must be an object');
  else {
    if (study.dataset.fixtureHash !== dataset.fixtureHash) {
      p(`study.dataset.fixtureHash ${study.dataset.fixtureHash} does not match the loaded fixture ${dataset.fixtureHash}`);
    }
    if (study.dataset.datasetId !== dataset.manifest.datasetId) p('study.dataset.datasetId mismatch');
  }

  // Claims registry.
  if (!Array.isArray(study.claims) || study.claims.length === 0) p('study.claims must be a non-empty array');
  else {
    for (const c of study.claims) {
      if (!isPlainObject(c)) p('study.claims entries must be objects');
      else {
        if (typeof c.claimId !== 'string' || c.claimId === '') p('claim.claimId must be a non-empty string');
        if (typeof c.contrastId !== 'string' || c.contrastId === '') p(`claim ${c.claimId} must carry contrastId`);
        if (!Array.isArray(c.competingExplanations) || c.competingExplanations.length === 0) {
          p(`claim ${c.claimId} must list at least one competing explanation`);
        }
        if (typeof c.analysisUnit !== 'string') p(`claim ${c.claimId} must carry analysisUnit`);
        if (!CLAIM_STATUS_VALUES.includes(c.status)) {
          p(`claim ${c.claimId} status must be one of ${CLAIM_STATUS_VALUES.join('/')}`);
        }
      }
    }
  }

  // Arms.
  if (!Array.isArray(study.arms) || study.arms.length === 0) p('study.arms must be a non-empty array');
  const armIds = new Set();
  for (const arm of study.arms ?? []) {
    if (!isPlainObject(arm)) {
      p('study.arms entries must be objects');
      continue;
    }
    if (typeof arm.armId !== 'string' || arm.armId === '') p('arm.armId must be a non-empty string');
    if (armIds.has(arm.armId)) p(`duplicate armId ${arm.armId}`);
    armIds.add(arm.armId);
    if (!dataset.histories[arm.historyId]) p(`arm ${arm.armId} references unknown history ${arm.historyId}`);
    if (!knownStrategyIds.has(arm.strategyId)) p(`arm ${arm.armId} references unknown strategy ${arm.strategyId}`);
    if (!isPlainObject(arm.initialMemoryManifest)) {
      p(`arm ${arm.armId} must carry initialMemoryManifest`);
    }
    const fc = arm.frozenCandidate;
    if (!isPlainObject(fc)) {
      p(`arm ${arm.armId} must carry frozenCandidate`);
    } else {
      if (fc.contentHash !== sha256(fc.policyText ?? '')) {
        p(`arm ${arm.armId} frozenCandidate.contentHash does not match sha256(policyText)`);
      }
      // NT-06: no fabricated Principle identity (title-guessed ids included).
      if (fc.principleId !== null && fc.principleId !== undefined) {
        p(`arm ${arm.armId} fabricates principleId '${fc.principleId}' — G1 has no real Principle identity (NT-06)`);
      }
      // 'model-summary' and 'raw-history' are the C-A contrast conditions
      // (prereg real-candidate-vs-summary-vs-raw-vs-none): same freeze
      // mechanics, source stage names what produced the delivered bytes.
      const SOURCE_STAGES = ['simulated-learn', 'i0-reflection', 'i1-pipeline', 'model-summary', 'raw-history'];
      if (!SOURCE_STAGES.includes(fc.sourceStage)) {
        p(`arm ${arm.armId} frozenCandidate.sourceStage must be ${SOURCE_STAGES.join('|')}`);
      }
    }
  }

  // Adjudications: element-wise shape + enum + coverage.
  if (!Array.isArray(adjudications) || adjudications.length === 0) p('adjudications must be a non-empty array');
  const seen = new Map();
  for (const row of adjudications ?? []) {
    if (!isPlainObject(row)) {
      p('adjudication rows must be objects');
      continue;
    }
    const key = `${row.armId}|${row.opportunityId}`;
    if (seen.has(key)) p(`duplicate adjudication for ${key}`);
    seen.set(key, row);
    if (row.schemaVersion !== ADJUDICATION_SCHEMA) p(`adjudication ${key} schemaVersion must be ${ADJUDICATION_SCHEMA}`);
    if (row.studyId !== study.studyId) p(`adjudication ${key} studyId mismatch`);
    if (!PIPELINE_REACHABILITY_VALUES.includes(row.pipelineReachability)) p(`adjudication ${key} bad pipelineReachability`);
    if (!ACTOR_RUN_STATUS_VALUES.includes(row.actorRunStatus)) p(`adjudication ${key} bad actorRunStatus`);
    if (!OBJECTIVE_TASK_STATUS_VALUES.includes(row.objectiveTaskStatus)) p(`adjudication ${key} bad objectiveTaskStatus`);
    if (!PRINCIPLE_ALIGNMENT_VALUES.includes(row.principleAlignment)) p(`adjudication ${key} bad principleAlignment`);
    if (!DATA_QUALITY_FLAGS.includes(row.dataQualityFlag)) p(`adjudication ${key} bad dataQualityFlag`);
    if (row.preTaskEligibility !== 'eligible') p(`adjudication ${key} must record preTaskEligibility`);
    // NT-04: a NOT_REACHED row must still be graded.
    if (row.pipelineReachability === 'NOT_REACHED') {
      if (row.objectiveTaskStatus === 'UNKNOWN' && row.actorRunStatus === 'COMPLETED') {
        p(`adjudication ${key}: pipeline NOT_REACHED but the completed actor run was not graded (NT-04)`);
      }
    }
    // NT-05: pipeline reachability must never be the REASON for a task FAIL.
    if (
      row.objectiveTaskStatus === 'FAIL'
      && typeof row.judge?.decisionRationale === 'string'
      && /pipeline[ _-]?not[ _-]?reached/i.test(row.judge.decisionRationale)
    ) {
      p(`adjudication ${key}: objectiveTaskStatus FAIL is justified by pipeline NOT_REACHED — reachability must not masquerade as behavior failure (NT-05)`);
    }
    // NT-08: NOT_APPLICABLE needs an allowlisted reason; anti-pattern matches
    // never establish non-applicability.
    if (row.principleAlignment === 'NOT_APPLICABLE') {
      const reason = row.alignmentReasonCode ?? row.judge?.decisionRationale ?? '';
      if (/anti[ _-]?pattern/i.test(reason)) {
        p(`adjudication ${key}: NOT_APPLICABLE justified by an antiPattern match (NT-08)`);
      }
      if (!NA_REASON_ALLOWLIST.includes(row.alignmentReasonCode)) {
        p(`adjudication ${key}: NOT_APPLICABLE requires alignmentReasonCode in ${NA_REASON_ALLOWLIST.join('|')}`);
      }
    }
    if (!Array.isArray(row.realOutcomes?.checksRun)) p(`adjudication ${key} realOutcomes.checksRun must be an array`);
    if (!isPlainObject(row.ownerCost)) p(`adjudication ${key} ownerCost must be an object`);
    if (row.judge?.judgeType !== 'mechanical') p(`adjudication ${key} G1 judge must be mechanical`);
  }

  // Coverage: every (arm × opportunity) exactly once.
  for (const arm of study.arms ?? []) {
    for (const probeId of Object.keys(dataset.probes)) {
      const probe = dataset.probes[probeId];
      const oppIds = (probe.opportunities ?? [{ opportunityId: probeId }]).map((o) => o.opportunityId);
      for (const oppId of oppIds) {
        const key = `${arm.armId}|${oppId}`;
        if (!seen.has(key)) p(`missing adjudication for ${key}`);
      }
    }
  }
  for (const key of seen.keys()) {
    const [armId] = key.split('|');
    if (!armIds.has(armId)) p(`adjudication references unknown arm ${armId}`);
  }

  // NT-01 / NT-03 basis: recorded actor inputs must be canary-clean, and the
  // recorded history→future pairing must be same-leakage-group.
  if (actorInputs) {
    for (const input of actorInputs) {
      if (!isPlainObject(input)) {
        p('actorInputs entries must be objects');
        continue;
      }
      if (input.historySynthetic !== true) p(`actorInput ${input.historyId}/${input.opportunityId} must record synthetic history`);
      const g = dataset.gold.gold[input.probeId];
      const record = g.phases ? { canaryStrings: g.phases[input.opportunityId]?.canaryStrings ?? [] } : g;
      for (const canary of record.canaryStrings ?? []) {
        if (input.visibleText?.includes(canary)) {
          p(`canary '${canary}' leaked into actor input ${input.historyId}/${input.opportunityId} (NT-01)`);
        }
      }
      if (input.leakageGroupId !== dataset.manifest.leakageGroupId) {
        p(`actorInput ${input.historyId}/${input.opportunityId} leakage group mismatch`);
      }
    }
  }

  // NT-07: episode initial-decision evidence must respect the cutoff.
  const cutoff = Date.parse(dataset.episode.informationCutoff);
  for (const ref of dataset.episode.evidenceRefs) {
    const occurred = Date.parse(ref.occurredAt);
    if (!Number.isNaN(occurred) && occurred > cutoff) {
      p(`evidenceRef ${ref.sourceExactRef} post-cutoff evidence used before the decision (NT-07)`);
    }
  }

  return problems;
}

/** Serialize adjudications as JSONL (deterministic field order via JSON.parse identity). */
export function adjudicationsToJsonl(adjudications) {
  return adjudications.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Canonical study hash — the replay-identity of the whole run. */
export function studyHash(study, adjudications) {
  return sha256(canonicalJson(study) + '\n' + adjudicationsToJsonl(adjudications));
}
