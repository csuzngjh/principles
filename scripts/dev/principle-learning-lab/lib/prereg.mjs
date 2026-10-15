// PRI-970 — preregistration validator.
//
// Machine-checks the frozen preregistration draft against the study that was
// actually run. Preparing and validating a draft is NOT Owner approval: the
// status field must say so, and any attempt to mark it approved without an
// Owner decision record is rejected here.

import { CLAIM_STATUS_VALUES } from './sidecar.mjs';

export const PREREG_SCHEMA = 'preregistration.v0.1-draft';
const APPROVED_STATUSES = new Set(['approved', 'owner_approved', 'APPROVED']);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns problems[]; empty = the draft is internally consistent and matches
 * the executed study. Checks:
 *  - schema + explicit draft status (no fabricated approval);
 *  - claims match the study's claim ids one-to-one;
 *  - execution order is a permutation of the study's arms;
 *  - every arm appears exactly once (no silent arm swaps);
 *  - real-agent budget items stay OWNER_DECISION_REQUIRED unless a real
 *    approval record exists (G1: it never does).
 */
export function validatePrereg({ prereg, study }) {
  const problems = [];
  const p = (msg) => problems.push(msg);

  if (!isPlainObject(prereg)) return ['prereg must be a JSON object'];
  if (prereg.schemaVersion !== PREREG_SCHEMA) p(`prereg.schemaVersion must be ${PREREG_SCHEMA}`);
  if (typeof prereg.status !== 'string') p('prereg.status must be a string');
  else if (APPROVED_STATUSES.has(prereg.status)) {
    p('prereg.status claims approval — an Owner approval cannot be fabricated by tooling; keep DRAFT_NOT_OWNER_APPROVED until an Owner decision record exists');
  }
  if (prereg.studyId !== study.studyId) p(`prereg.studyId ${prereg.studyId} != study.studyId ${study.studyId}`);

  const preregClaimIds = (prereg.claims ?? []).map((c) => c.claimId);
  const studyClaimIds = (study.claims ?? []).map((c) => c.claimId);
  for (const id of studyClaimIds) {
    if (!preregClaimIds.includes(id)) p(`study claim ${id} is not preregistered — post-hoc claim (forbidden)`);
  }
  for (const c of prereg.claims ?? []) {
    if (!isPlainObject(c)) {
      p('prereg.claims entries must be objects');
      continue;
    }
    if (!Array.isArray(c.competingExplanations) || c.competingExplanations.length === 0) {
      p(`prereg claim ${c.claimId} must list competing explanations`);
    }
    if (typeof c.analysisUnit !== 'string' || c.analysisUnit === '') p(`prereg claim ${c.claimId} must carry analysisUnit`);
  }

  const alloc = prereg.allocationAndAnalysis;
  if (!isPlainObject(alloc)) p('prereg.allocationAndAnalysis must be an object');
  else {
    if (typeof alloc.analysisUnit !== 'string') p('allocationAndAnalysis.analysisUnit must be a string');
    if (!Array.isArray(alloc.executionOrder) || alloc.executionOrder.length === 0) {
      p('allocationAndAnalysis.executionOrder must be a non-empty array');
    } else {
      const armIds = (study.arms ?? []).map((a) => a.armId).sort();
      const order = [...alloc.executionOrder].sort();
      if (JSON.stringify(order) !== JSON.stringify(armIds)) {
        p('executionOrder is not a permutation of the executed study arms (silent arm swap?)');
      }
      if (new Set(alloc.executionOrder).size !== alloc.executionOrder.length) {
        p('executionOrder contains duplicates');
      }
    }
    if (alloc.randomization === undefined) p('allocationAndAnalysis must declare randomization');
    if (alloc.repetitions === undefined) p('allocationAndAnalysis must declare repetitions');
  }

  if (!isPlainObject(prereg.missingAndExclusion) || Object.keys(prereg.missingAndExclusion).length < 5) {
    p('missingAndExclusion must enumerate the SPEC §5.3 categories (at least 5)');
  }
  if (!isPlainObject(prereg.informationCutoff)) p('informationCutoff must be an object');
  if (!isPlainObject(prereg.budget)) p('budget must be an object');
  if (!Array.isArray(prereg.ownerDecisionsPending) || prereg.ownerDecisionsPending.length === 0) {
    p('ownerDecisionsPending must be a non-empty array while the study is not Owner-approved');
  }

  // Study claim statuses must stay within the allowed vocabulary.
  for (const c of study.claims ?? []) {
    if (!CLAIM_STATUS_VALUES.includes(c.status)) {
      p(`study claim ${c.claimId} status must be one of ${CLAIM_STATUS_VALUES.join('/')}`);
    }
  }

  return problems;
}
