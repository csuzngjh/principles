#!/usr/bin/env node
// CEB-003-P freeze preparation — assembles challenge-studies/CEB-003-P/ for
// the EXISTING freeze-challenge-study.mjs tool (committed, reproducible
// equivalent of the uncommitted prepare-ceb002-freeze.mjs used for CEB-002).
//
// Sources (all read-only):
//  - CEB-001 frozen shared assets (input-manifest / principle-frozen /
//    pain-mechanism-mapping / scoring-contract — same research object,
//    verbatim reuse exactly as CEB-002 did);
//  - CEB-002 DRAFT judge-only caseDefs (committed on main) — the EXACT build
//    input that prepare-ceb002-freeze.mjs compiled into CEB-002's frozen
//    suite. Recompiling here MUST reproduce CEB-002's frozen per-case
//    inputHash/goldHash (embedded EXPECTED_CASE_HASHES below) — the machine
//    proof that CEB-003-P reuses the 16 established questions byte-identically
//    (no new cases, no Gold edits);
//  - CEB-003 C' v1.1.0 narrative payload (arm C = C-prime, natural experience
//    narrative control) — text SHA-256 asserted equal to
//    116fbaea48061848ecc8e70bcdf17ff4f191c30b1d61bc4c77990cf1434c1df4, and
//    the v1.0.0 original asserted unmodified, BEFORE anything is written.
//
// FAIL-CLOSED ordering: every hash assertion (C' payloads + all 16 compiled
// cases) runs BEFORE the first output file is written. The script REFUSES an
// existing output directory (a frozen/executed study is never rebuilt).
//
// Zero network, no clock, deterministic. Optional --output-dir (resolved via
// the shared fail-closed resolver in lib/ceb002-cli.mjs) for determinism
// rehearsals into scratch copies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './lib/challenge-freeze.mjs';
import { compileCase } from './lib/challenge-compile.mjs';
import { resolveOutputDir } from './lib/ceb002-cli.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studiesRoot = path.join(labRoot, 'challenge-studies');

const STUDY = 'CEB-003-P';
const C_PRIME_V1_1_TEXT_SHA256 = '116fbaea48061848ecc8e70bcdf17ff4f191c30b1d61bc4c77990cf1434c1df4';

// CEB-002 frozen suite-manifest per-case hashes (study executed 2026-10-27;
// frozen suiteHash 02cbc15c…). Byte-identity of every reused question
// is proven by recompilation equality below. The table is loaded from
// CEB-003/expected-ceb002-frozen-case-hashes.json — extracted
// programmatically from the CEB-002 frozen manifest, never hand-copied
// (a hand-transcription typo was caught by this very assertion on first run).

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function fail(message) {
  console.error(`prepare-ceb003p-freeze: FAIL — ${message}`);
  process.exit(1);
}

const out = resolveOutputDir(process.argv.slice(2), path.join(studiesRoot, STUDY));
if (fs.existsSync(out)) fail(`output directory already exists (${out}) — a study directory is built exactly once; a frozen/executed study is never rebuilt`);

// Expected CEB-002 frozen per-case hashes — programmatic extraction, see header.
const EXPECTED = readJson(path.join(studiesRoot, 'CEB-003', 'expected-ceb002-frozen-case-hashes.json'));
if (EXPECTED.sourceSuiteHash !== '02cbc15cfd9cf8a8b9e986950fdf722fcda6632604f4e62d4bd50ea0950d04f5') fail('expected-hash table sourceSuiteHash mismatch — refusing to trust the table');

// ── 1. C' payload verification (BEFORE any write) ──────────────────────────
const ceb003Dir = path.join(studiesRoot, 'CEB-003');
const cPrimeV11 = readJson(path.join(ceb003Dir, 'arm-payload-matched-summary-v1.1.json'));
const cPrimeV10 = readJson(path.join(ceb003Dir, 'arm-payload-matched-summary.json'));
if (cPrimeV11.version !== 'c-prime-v1.1.0') fail(`C' v1.1 file version field is '${cPrimeV11.version}'`);
const v11Hash = sha256(cPrimeV11.text);
if (v11Hash !== C_PRIME_V1_1_TEXT_SHA256) fail(`C' v1.1.0 text SHA-256 ${v11Hash} != expected ${C_PRIME_V1_1_TEXT_SHA256}`);
const v10Hash = sha256(cPrimeV10.text);
if (sha256(cPrimeV10.text) !== cPrimeV11.v1_0_0_sha256) fail(`C' v1.0.0 original text SHA-256 ${v10Hash} != v1.1 file's recorded v1_0_0_sha256 ${cPrimeV11.v1_0_0_sha256} (v1.0.0 original must be intact)`);
console.log(`C' v1.1.0 text sha256 = ${v11Hash} (verified); v1.0.0 original intact (${v10Hash.slice(0, 8)}…)`);

// ── 2. Case set verification (BEFORE any write) ────────────────────────────
const ceb2Dir = path.join(studiesRoot, 'CEB-002');
const ceb2DraftManifest = readJson(path.join(ceb2Dir, 'suite-manifest.json'));
const tierPlan = readJson(path.join(ceb2Dir, 'difficulty-tier-plan.json'));
const caseDefs = [];
const drafts = [];
const provenanceCases = [];
for (const mc of ceb2DraftManifest.cases) {
  const caseDef = readJson(path.join(ceb2Dir, 'judge-only', `${mc.caseId}.json`));
  const compiled = compileCase(caseDef);
  const expected = EXPECTED.cases[caseDef.caseId];
  if (!expected) fail(`case ${caseDef.caseId} is not in the expected CEB-002 frozen hash table`);
  if (compiled.inputHash !== expected.inputHash) fail(`case ${caseDef.caseId}: compiled inputHash ${compiled.inputHash} != CEB-002 frozen ${expected.inputHash} — question identity broken`);
  if (compiled.goldHash !== expected.goldHash) fail(`case ${caseDef.caseId}: compiled goldHash ${compiled.goldHash} != CEB-002 frozen ${expected.goldHash} — Gold identity broken`);
  const seq = Number(caseDef.caseId.split('-')[3]);
  const tierEntry = tierPlan.tiers[seq - 1];
  caseDefs.push(caseDef);
  drafts.push({
    scenarioId: caseDef.caseId,
    family: caseDef.family,
    templateId: 'T-CLAIM-EVIDENCE-BINDING-V1',
    templateVersion: '1.0.0',
    parameters: { caseId: caseDef.caseId, tier: tierEntry.tier, budgetSlack: tierEntry.slack, deadline: tierEntry.deadline },
    sourceMechanismRef: 'CEB-001#assertion_without_observation (case set = CEB-002 frozen suite reused byte-identically for CEB-003-P)',
    rationaleForDesigner: `CEB-003-P reuse of CEB-002 frozen case ${caseDef.caseId} (tier ${tierEntry.tier}); inputHash/goldHash asserted equal to the CEB-002 frozen manifest`,
  });
  provenanceCases.push({ caseId: caseDef.caseId, sourceCaseId: caseDef.caseId, inputHash: expected.inputHash, goldHash: expected.goldHash });
}
console.log(`case identity: all ${caseDefs.length} compiled cases match CEB-002 frozen inputHash/goldHash (byte-identical reuse)`);

// ── 3. Write the study directory ───────────────────────────────────────────
fs.mkdirSync(out, { recursive: true });
const ceb1Dir = path.join(studiesRoot, 'CEB-001');
for (const f of ['input-manifest.json', 'principle-frozen.json', 'pain-mechanism-mapping.json', 'scoring-contract.json']) {
  fs.copyFileSync(path.join(ceb1Dir, f), path.join(out, f));
  console.log(`copied shared frozen asset: ${f}`);
}

// Arm-C payload: the generic freeze tool reads `text` +
// `normativeMarkersThatMustNotAppear` from arm-payload-experience-summary.json.
// For CEB-003-P this file carries the C-prime v1.1.0 NATURAL EXPERIENCE
// NARRATIVE (not a summary, not a matched payload — no matching criterion is
// claimed; see OWNER-REVIEW-PILOT-CONTRACT.md).
fs.writeFileSync(path.join(out, 'arm-payload-experience-summary.json'), `${JSON.stringify({
  schema: 'ceb003p-arm-c-prime-narrative-payload.v1',
  studyId: STUDY,
  armId: 'C',
  formalName: 'C-prime (natural experience narrative control)',
  sourceFile: 'challenge-studies/CEB-003/arm-payload-matched-summary-v1.1.json',
  sourceVersion: 'c-prime-v1.1.0',
  text: cPrimeV11.text,
  textSha256: v11Hash,
  normativeMarkersThatMustNotAppear: cPrimeV11.normativeMarkersThatMustNotAppear,
  note: 'Machine filename retains the generic freeze-tool name (arm-payload-experience-summary.json). The CONTRACT payload of arm C in CEB-003-P is the C-prime natural experience narrative v1.1.0 — NOT a matched summary; no matching criterion is claimed or satisfied (sentence ratio 2:5, instruction words 3:0, normative terms 3:0 — the manipulation variable itself).',
}, null, 2)}\n`);
console.log('wrote arm-payload-experience-summary.json (C-prime v1.1.0 narrative)');

fs.writeFileSync(path.join(out, 'challenge-suite.draft.json'), `${JSON.stringify({ schema: 'challenge-suite-draft.v1', studyId: STUDY, drafts, cases: caseDefs }, null, 2)}\n`);
console.log(`challenge-suite.draft.json: ${caseDefs.length} cases`);

// Preregistration draft: CEB-001 structural fields + the CEB-003-P pilot
// contract (machine-readable source: CEB-003/preregistration-pilot-draft.json,
// closed per OWNER-REVIEW-PILOT-CONTRACT.md v1.0.0).
const ceb1Prereg = readJson(path.join(ceb1Dir, 'preregistration.json'));
const pilotContract = readJson(path.join(ceb003Dir, 'preregistration-pilot-draft.json'));
const merged = {
  schema: 'challenge-preregistration.v1',
  studyId: STUDY,
  status: 'DRAFT',
  frozenAt: null,
  positioning: 'PILOT — operational feasibility validation only. NO hypothesis testing. Results are NOT pooled into any confirmatory sample; no confirmatory sample size may be adjusted based on pilot effect direction or significance.',
  pilotGoals: pilotContract.pilotGoals,
  nonGoals: pilotContract.nonGoals,
  armNaming: {
    formal: {
      A: 'A (baseline — no injection)',
      B: 'B (target principle — CEB-001 frozen statement verbatim, SHA ae275f0f…)',
      C: 'C-prime (natural experience narrative control) — CEB-003 C\' v1.1.0 (SHA 116fbaea…)',
    },
    machineLabelNote: "arm-configs.json names arm C 'EXPERIENCE_SUMMARY' — an inherited label of the generic freeze tool. The CONTRACT name of arm C in this study is 'C-prime (natural experience narrative control)'. The retired mislabel 'matched summary control' must never be used; C' passed no matching criterion and none is claimed.",
  },
  arms: [
    { ...ceb1Prereg.arms[0] },
    { ...ceb1Prereg.arms[1] },
    {
      armId: 'C',
      name: 'NATURAL_EXPERIENCE_NARRATIVE_CONTROL',
      contentMode: 'summary',
      payloadRef: "challenge-studies/CEB-003/arm-payload-matched-summary-v1.1.json text (C-prime v1.1.0, frozen verbatim)",
      payloadHash: null,
      note: "C-prime arm: a natural experience narrative (pure event account + post-hoc correction, ZERO prescriptive language). NOT a matched summary — sentence count 2:5, instruction words 3:0, normative terms 3:0 vs B; these differences are the manipulation variable itself (principle abstraction vs experience narrative). payloadHash is filled by the freeze tool with sha256(C' text).",
    },
  ],
  commonContext: { ...ceb1Prereg.commonContext },
  delivery: { ...ceb1Prereg.delivery },
  armIsolation: { ...ceb1Prereg.armIsolation },
  design: {
    cases: 'CEB-002 frozen 16-case set (L1×3 / L2×4 / L3×4 / B×5) reused BYTE-IDENTICALLY — per-case inputHash/goldHash asserted equal to the CEB-002 frozen suite-manifest (see case-reuse-provenance.json); no new cases, no Gold edits',
    repetitions: 2,
    totalUnits: 96,
    arms: ['A', 'B', 'C'],
  },
  repetitions: {
    planned: 2,
    seedPolicy: 'pre-registered deterministic order (same discipline as CEB-001/CEB-002)',
    status: 'NOT_RUN',
  },
  denominator: {
    assignedUnits: '16 cases × 3 arms × 2 repetitions = 96 execution units',
    boundaryCasesKept: 'B-tier (5 boundary situations) retained in the denominator',
    note: 'CEB-003-P pilot: A / B / C-prime over the CEB-002 difficulty-graded set',
  },
  stoppingConditions: [
    'consecutiveUnknown: 2 (halt new dispatch after 2 consecutive RESULT_UNKNOWN units — enforced by the orchestrator per unit, stricter than the runner-internal backstop of 3)',
    'batchUnknownRateNotEvaluable: 0.40 (batch UNKNOWN rate > 40% → study NOT_EVALUABLE)',
    'identityAnomaly: halt immediately',
    'hashDrift: halt immediately',
    'ledgerInconsistency: halt immediately',
    'budgetBreach: halt immediately (96 attempts / 960 requests / per-unit 1 attempt / per-attempt request accounting)',
    'missingData: retained in denominator, never attributed to behavior',
  ],
  preregisteredConfound: pilotContract.preregisteredConfound,
  confirmatoryRequirement: pilotContract.confirmatoryRequirement,
  notAuthorized: {
    realModelCalls: 0,
    realHostExperiments: 0,
    stageG: 'N/A (CEB-003-P has no Examiner generation stage)',
    stageR: 'NOT_AUTHORIZED (run-authorization.json is a fail-closed placeholder until the Owner-issued record replaces it)',
  },
  freezeRequirement: 'Owner approval required for: (1) CEB-003-P suite freeze, (2) this preregistration in force, (3) execution authorization. Granted 2026-10-28 by the Owner Goal instruction (CEB-003-P three-in-one: freeze + preregistration in force + 96-unit execution, one-time).',
};
fs.writeFileSync(path.join(out, 'preregistration.draft.json'), `${JSON.stringify(merged, null, 2)}\n`);
console.log('preregistration.draft.json: structural + pilot contract merged');

fs.writeFileSync(path.join(out, 'case-reuse-provenance.json'), `${JSON.stringify({
  schema: 'ceb003p-case-reuse-provenance.v1',
  studyId: STUDY,
  sourceStudy: 'CEB-002 (frozen suite, executed 2026-10-27)',
  sourceSuiteHash: '02cbc15cfd9cf8a8b9e986950fdf722fcda6632604f4e62d4bd50ea0950d04f5',
  buildInput: 'CEB-002 DRAFT judge-only caseDefs committed on main — the exact input prepare-ceb002-freeze.mjs compiled into the CEB-002 frozen suite',
  identityRule: 'compileCase(caseDef).inputHash/goldHash must equal the CEB-002 frozen suite-manifest values (asserted by prepare-ceb003p-freeze.mjs before any write)',
  cases: provenanceCases,
}, null, 2)}\n`);
console.log('case-reuse-provenance.json written');

fs.writeFileSync(path.join(out, 'run-authorization.json'), `${JSON.stringify({
  schema: 'challenge-stage-authorization.v1', stage: 'R', studyId: STUDY, status: 'NOT_AUTHORIZED',
  note: 'CEB-003-P is a DRAFT study — not frozen, not preregistered in force, not authorized. Real execution requires the Owner-issued APPROVED record bound to this study\'s frozen hashes.',
}, null, 2)}\n`);

console.log(`\nCEB-003-P freeze preparation complete (${caseDefs.length} cases, C-prime v1.1.0 arm C). Next:`);
console.log('  node freeze-challenge-study.mjs --study CEB-003-P');
