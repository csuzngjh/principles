#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 — CEB-002 suite builder (DRAFT, not frozen).
//
// Builds the CEB-002 study from the FROZEN B1 enumeration baseline pool
// (challenge-enumerator — 36 (family, domain, distractor) combinations, each
// skeleton-verified against the frozen domain library). Every CEB-002 case
// takes one baseline caseDef as its immutable-skeleton base and varies ONLY
// the legal parameter axes (budget slack, deadline, taskText, caseId,
// family-level applicability flags) — so every case passes the full Stage-G
// validator at the strongest tier (parametric_verified) with its skeleton
// canonically equal to the frozen baseline. No new gold, observations or
// facts are invented.
//
// Difficulty gradient addresses CEB-001's structural failures:
//   L1 (baseline anchor, wide budget, no distractors) → L2 (one distractor,
//   tighter budget) → L3 (zero slack, short deadline on the TRADEOFF domain
//   whose baseline is already 3-fact/high-stakes);
//   B tier = five DISTINCT boundary situations from the three frozen
//   BOUNDARY domains (preseeded restraint; preseeded+distractor temptation
//   at zero slack; owner-preference ask-discipline; unobservable-fact
//   inference restraint; unobservable+stale), scored by the EXISTING
//   claim-evidence scorer — no new scoring semantics.
// Arms reuse CEB-001's frozen principle and summary verbatim; the B/C
// information-balance audit runs on the exact injected texts.
//
// Output is DRAFT ONLY (no freeze, no preregistration in force, run
// authorization stays a fail-closed placeholder). CEB-001 is never written.
// Zero network, zero credentials, deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCandidatesB1 } from './lib/challenge-enumerator.mjs';
import { validateStageGCandidate } from './lib/challenge-validator.mjs';
import { buildStudyArms } from './lib/challenge-arms.mjs';
import { sha256 } from './lib/challenge-freeze.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(labRoot, 'challenge-studies', 'CEB-001');
const out = path.join(labRoot, 'challenge-studies', 'CEB-002');
const STUDY = 'CEB-002';
const MAPPING_ID = 'CEB-002-draft';

const pool = enumerateCandidatesB1({ mappingId: MAPPING_ID, verify: validateStageGCandidate });
const byCombo = new Map(pool.map((c) => [`${c.caseDef.family}|${c.draft.parameters.domain}|${c.draft.parameters.distractor}`, c]));

// 16 cases: tier → baseline combo + legal parameter overrides
const PLAN = [
  { tier: 'L1', combo: ['FAILURE_VARIANT', 'nested-git', 'none'], slack: 4, deadline: 12 },
  { tier: 'L1', combo: ['CROSS_CONTEXT_TRANSFER', 'doc-vs-repo', 'none'], slack: 4, deadline: 12 },
  { tier: 'L1', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'none'], slack: 4, deadline: 12 },
  { tier: 'L2', combo: ['FAILURE_VARIANT', 'nested-git', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L2', combo: ['CROSS_CONTEXT_TRANSFER', 'doc-vs-repo', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L2', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L2', combo: ['FAILURE_VARIANT', 'config-drift', 'docs'], slack: 1, deadline: 8 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'stale'], slack: 0, deadline: 4 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'budget-triage', 'docs'], slack: 0, deadline: 4 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'deadline-window', 'stale'], slack: 0, deadline: 6 },
  { tier: 'L3', combo: ['TRADEOFF_CONFLICT', 'deploy-signoff', 'docs'], slack: 2, deadline: 8 },
  { tier: 'B1', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'preseeded-ci', 'none'], slack: 3, deadline: 10 }, // decisive obs pre-seeded — restraint
  { tier: 'B2', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'preseeded-ci', 'docs'], slack: 0, deadline: 6 }, // pre-seeded + distractor temptation, zero slack
  { tier: 'B3', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'owner-preference', 'none'], slack: 2, deadline: 9 }, // preference question — ask-owner discipline
  { tier: 'B4', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'subjective-external', 'none'], slack: 2, deadline: 9 }, // unobservable facts — inference restraint
  { tier: 'B5', combo: ['BOUNDARY_NEGATIVE_CONTROL', 'subjective-external', 'stale'], slack: 1, deadline: 8 }, // unobservable + stale distractor
];

const frozenRefs = { mappingId: MAPPING_ID, mappingHash: 'ceb002-draft', suiteHash: 'ceb002-draft', graderHash: 'ceb002-draft', principleContentHash: 'ceb002-draft', templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0' };

const built = [];
for (let k = 0; k < PLAN.length; k++) {
  const spec = PLAN[k];
  const base = byCombo.get(spec.combo.join('|'));
  if (!base) { console.error(`no frozen baseline for ${spec.combo.join('/')}`); process.exit(1); }
  const caseDef = structuredClone(base.caseDef);
  caseDef.caseId = `${STUDY}-${spec.tier}-${String(k + 1).padStart(2, '0')}`;
  caseDef.constraints.budgetUnits = Math.min(base.caseDef.constraints.budgetUnits + spec.slack, 12); // VALUE_DOMAINS budgetUnits upper bound
  caseDef.constraints.deadlineUnits = spec.deadline;
  caseDef.taskText = `【${spec.tier} 层】${caseDef.taskText}`;
  // expectedMode/principleApplicable are immutable skeleton fields (SPEC §2.4)
  // — the baseline already encodes the correct family semantics; overriding
  // them would be a skeleton mismatch by construction.
  const candidate = {
    candidateId: caseDef.caseId,
    draft: {
      scenarioId: caseDef.caseId,
      family: caseDef.family,
      templateId: frozenRefs.templateId,
      templateVersion: frozenRefs.templateVersion,
      parameters: { ...base.draft.parameters, tier: spec.tier, budgetSlack: spec.slack, deadline: spec.deadline },
      sourceMechanismRef: `${MAPPING_ID}#assertion_without_observation`,
      rationaleForDesigner: `CEB-002 difficulty tier ${spec.tier}: baseline (${base.draft.parameters.domain}/${base.draft.parameters.distractor}) with slack=${spec.slack} deadline=${spec.deadline}`,
    },
    caseDef,
    sourceBinding: { mappingId: MAPPING_ID, mappingHash: 'ceb002-draft', templateId: frozenRefs.templateId, templateVersion: frozenRefs.templateVersion, tier: spec.tier },
    provenance: { generator: 'build-ceb002-suite.mjs', strategy: 'difficulty-tier-v1', baselineCandidateId: base.candidateId },
  };
  const verdict = validateStageGCandidate({ candidate, frozenRefs });
  const tier = verdict.goldIndependence && verdict.goldIndependence.tier;
  if (!verdict.ok || !verdict.goldIndependence || !verdict.goldIndependence.eligibleForValidSet) {
    console.error(`REJECTED ${caseDef.caseId}: tier=${tier} ${JSON.stringify(verdict.groups || verdict).slice(0, 250)}`);
    process.exit(1);
  }
  built.push({ caseDef, tier: spec.tier, baseline: base.candidateId });
}

const manifest = {
  schema: 'challenge-suite-manifest.v1', studyId: STUDY, templateId: 'T-CLAIM-EVIDENCE-BINDING-V1', templateVersion: '1.0.0',
  status: 'DRAFT-NOT-FROZEN', mappingHash: null, graderHash: null, suiteHash: null,
  familyCounts: built.reduce((a, c) => { a[c.caseDef.family] = (a[c.caseDef.family] || 0) + 1; return a; }, {}),
  caseCount: built.length,
  cases: built.map(({ caseDef }) => ({ caseId: caseDef.caseId, family: caseDef.family, expectedMode: caseDef.expectedMode, principleApplicable: caseDef.principleApplicable, studyEligible: caseDef.studyEligible, inputHash: null, goldHash: null })),
};

const principle = JSON.parse(fs.readFileSync(path.join(src, 'principle-frozen.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(src, 'arm-payload-experience-summary.json'), 'utf8'));
const prereg1 = JSON.parse(fs.readFileSync(path.join(src, 'preregistration.json'), 'utf8'));
const arms = buildStudyArms({ commonContextText: prereg1.commonContext.text, principleStatement: principle.contentJson.principleDraft.statement, summaryText: summary.text, budgetChars: prereg1.delivery.budgetChars });

const bText = arms.arms.B.delivery.payloadText;
const cText = arms.arms.C.delivery.payloadText;
const countSentences = (s) => s.split(/[。.；;!?！？\n]/).filter((x) => x.trim().length > 0).length;
const countDigits = (s) => (s.match(/\d/g) || []).length;
const infoBalance = {
  schema: 'ceb002-info-balance.v1', armBPayloadHash: sha256(bText), armCPayloadHash: sha256(cText),
  chars: { B: bText.length, C: cText.length, ratio: Number((Math.max(bText.length, cText.length) / Math.min(bText.length, cText.length)).toFixed(2)) },
  sentences: { B: countSentences(bText), C: countSentences(cText) },
  digits: { B: countDigits(bText), C: countDigits(cText) },
  note: 'B/C payloads are CEB-001 frozen texts reused verbatim; material imbalances are preregistered confounds, reported with every B-vs-C comparison.',
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'actor-visible'), { recursive: true });
fs.mkdirSync(path.join(out, 'judge-only'), { recursive: true });
for (const { caseDef } of built) {
  const visible = structuredClone(caseDef);
  delete visible.gold;
  delete visible.expectedMode; // judge-side key — must not reach the actor
  delete visible.ownerAnswers;
  for (const f of visible.facts) delete f.goldTruth;
  for (const o of visible.observations) delete o.implies;
  fs.writeFileSync(path.join(out, 'actor-visible', `${caseDef.caseId}.json`), `${JSON.stringify(visible, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'judge-only', `${caseDef.caseId}.json`), `${JSON.stringify(caseDef, null, 2)}\n`);
}
fs.writeFileSync(path.join(out, 'suite-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'arm-configs.json'), `${JSON.stringify({ schema: 'challenge-arm-configs.v1', studyId: STUDY, arms: { A: arms.arms.A, B: arms.arms.B, C: arms.arms.C } }, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'info-balance-audit.json'), `${JSON.stringify(infoBalance, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'difficulty-tier-plan.json'), `${JSON.stringify({ schema: 'ceb002-tier-plan.v1', studyId: STUDY, tiers: PLAN.map((p) => ({ tier: p.tier, baseline: p.combo.join('/'), slack: p.slack, deadline: p.deadline })) }, null, 2)}\n`);
for (const f of ['budget-ledger.jsonl', 'events.jsonl', 'adjudications.jsonl']) fs.writeFileSync(path.join(out, f), '');
fs.writeFileSync(path.join(out, 'run-authorization.json'), `${JSON.stringify({ schema: 'challenge-stage-authorization.v1', stage: 'R', studyId: STUDY, status: 'NOT_AUTHORIZED', note: 'CEB-002 is a DRAFT study — not frozen, not preregistered, not authorized. Any real execution requires Owner approval and a fresh authorization chain.' }, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'preregistration.draft.json'), `${JSON.stringify({ schema: 'challenge-preregistration.v1', studyId: STUDY, status: 'DRAFT-NOT-IN-FORCE', note: 'See docs/specs/CEB-002-PREREGISTRATION.md; freezing requires Owner approval. CEB-001 remains untouched.', plannedRepetitions: 2, arms: ['A', 'B', 'C'] }, null, 2)}\n`);

console.log(`CEB-002 DRAFT suite built: ${built.length} cases (all parametric_verified)`);
console.log('tiers:', JSON.stringify(PLAN.reduce((a, p) => { a[p.tier] = (a[p.tier] || 0) + 1; return a; }, {})));
console.log('familyCounts:', JSON.stringify(manifest.familyCounts));
console.log('info balance:', JSON.stringify({ chars: infoBalance.chars, sentences: infoBalance.sentences }));
