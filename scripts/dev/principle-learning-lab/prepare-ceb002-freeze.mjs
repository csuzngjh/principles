#!/usr/bin/env node
// CEB-002 freeze preparation — copies shared CEB-001 frozen assets and
// constructs challenge-suite.draft.json from CEB-002's 16 cases, preparing
// the study directory for the EXISTING freeze-challenge-study.mjs tool.
//
// CEB-002 shares CEB-001's principle, mechanism mapping, scoring contract,
// and arm payloads verbatim (same research object, different case set with
// a difficulty gradient). The freeze tool then computes CEB-002's own
// mappingHash/suiteHash/graderHash/preregistrationHash over the CEB-002
// object graphs.
//
// Zero network, deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(labRoot, 'challenge-studies', 'CEB-001');
const dst = path.join(labRoot, 'challenge-studies', 'CEB-002');

// 1. Copy shared frozen assets from CEB-001 (verbatim — these ARE the same
//    research materials; CEB-002 reuses the principle/mapping/scoring)
const sharedFiles = [
  'input-manifest.json',
  'principle-frozen.json',
  'pain-mechanism-mapping.json',
  'scoring-contract.json',
  'arm-payload-experience-summary.json',
];
for (const f of sharedFiles) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  console.log(`copied: ${f}`);
}

// 2. Build challenge-suite.draft.json from CEB-002's 16 judge-only cases
const manifest = JSON.parse(fs.readFileSync(path.join(dst, 'suite-manifest.json'), 'utf8'));
const tierPlan = JSON.parse(fs.readFileSync(path.join(dst, 'difficulty-tier-plan.json'), 'utf8'));
const caseDefs = [];
const drafts = [];
for (const mc of manifest.cases) {
  const caseDef = JSON.parse(fs.readFileSync(path.join(dst, 'judge-only', `${mc.caseId}.json`), 'utf8'));
  caseDefs.push(caseDef);
  const seq = Number(mc.caseId.split('-')[3]);
  const tierEntry = tierPlan.tiers[seq - 1];
  drafts.push({
    scenarioId: mc.caseId,
    family: mc.family,
    templateId: 'T-CLAIM-EVIDENCE-BINDING-V1',
    templateVersion: '1.0.0',
    parameters: { caseId: mc.caseId, tier: tierEntry.tier, budgetSlack: tierEntry.slack, deadline: tierEntry.deadline },
    sourceMechanismRef: 'CEB-001#assertion_without_observation (same mechanism, difficulty-graded case selection)',
    rationaleForDesigner: `CEB-002 difficulty tier ${tierEntry.tier}: baseline (${tierEntry.baseline})`,
  });
}
const draftDoc = { schema: 'challenge-suite-draft.v1', studyId: 'CEB-002', drafts, cases: caseDefs };
fs.writeFileSync(path.join(dst, 'challenge-suite.draft.json'), `${JSON.stringify(draftDoc, null, 2)}\n`);
console.log(`challenge-suite.draft.json: ${caseDefs.length} cases`);

// 3. Merge preregistration: the freeze tool expects commonContext/delivery/
//    arms structure. CEB-002's contract adds the statistical closeout fields.
//    Merge: take CEB-001's structural fields (commonContext etc.), overlay
//    CEB-002's statistical contract.
const ceb1Prereg = JSON.parse(fs.readFileSync(path.join(src, 'preregistration.json'), 'utf8'));
const ceb2Contract = JSON.parse(fs.readFileSync(path.join(dst, 'preregistration.draft.json'), 'utf8'));

const merged = {
  // structural fields the freeze tool reads/writes
  schema: 'challenge-preregistration.v1',
  studyId: 'CEB-002',
  status: 'DRAFT',
  frozenAt: null, // set by the freeze tool
  hypotheses: ceb1Prereg.hypotheses,
  arms: ceb1Prereg.arms.map((a) => ({ ...a })),
  commonContext: { ...ceb1Prereg.commonContext },
  delivery: { ...ceb1Prereg.delivery },
  armIsolation: { ...ceb1Prereg.armIsolation },
  repetitions: {
    planned: 2,
    seedPolicy: 'pre-registered deterministic order (same discipline as CEB-001)',
    status: 'NOT_RUN',
  },
  denominator: {
    assignedUnits: '16 cases × 3 arms × 2 repetitions = 96 execution units',
    boundaryCasesKept: 'B-tier (5 boundary situations) retained in the negative-transfer denominator',
    note: 'CEB-002 difficulty-graded design: L1×3 anchor / L2×4 / L3×4 discriminative / B×5 boundary',
  },
  stoppingConditions: [
    'consecutiveUnknown: 2 (halt immediately after 2 consecutive RESULT_UNKNOWN units)',
    'batchUnknownRateNotEvaluable: 0.40 (batch UNKNOWN rate > 40% → study NOT_EVALUABLE)',
    'identityAnomaly: halt immediately',
    'hashDrift: halt immediately',
    'ledgerInconsistency: halt immediately',
    'budgetBreach: halt immediately',
    'missingData: retained in denominator, never attributed to behavior',
  ],
  notAuthorized: {
    realModelCalls: 0,
    realHostExperiments: 0,
    stageG: 'N/A (CEB-002 has no Examiner generation stage)',
    stageR: 'NOT_AUTHORIZED (run-authorization.json is a fail-closed placeholder)',
  },

  // CEB-002 statistical closeout contract (from the machine-readable draft)
  positioning: ceb2Contract.design.positioning,
  primaryAnalysis: ceb2Contract.primaryAnalysis,
  referenceViews: ceb2Contract.referenceViews,
  escalation: ceb2Contract.escalation,
  confounds: ceb2Contract.confounds,
  claimBoundary: ceb2Contract.claimBoundary,
  freezeRequirement: ceb2Contract.freezeRequirement,
};
fs.writeFileSync(path.join(dst, 'preregistration.draft.json'), `${JSON.stringify(merged, null, 2)}\n`);
console.log('preregistration.draft.json: merged structural + statistical contract');

console.log('\nCEB-002 freeze preparation complete. Run:');
console.log('  node freeze-challenge-study.mjs --study CEB-002');
