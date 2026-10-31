// SPEC-PD-EXAMINER-001 v0.9 Phase 5 — offline end-to-end acceptance pipeline.
//
// Produces the DURABLE offline acceptance artifacts under
// scripts/dev/principle-learning-lab/examiner-studies/ (never inside the
// frozen challenge-studies/ area):
//
//   EXM-V09-ACC-ISO  — isolated_principle A/B study
//   EXM-V09-ACC-FULL — full_library_incremental A/B study
//
// Each study walks the complete v0.9 chain: assemble (HEPS + RuleCode policy
// + primary endpoint + pair assignment) → preflight → offline-stub execution
// with the FROZEN randomized dispatch order → per-unit injection evidence →
// Report V2 (examiner block: ITT + Treatment Fidelity) → replay verification
// → historical baseline re-verification.
//
// Everything is offline and synthetic (SYNTHETIC_OFFLINE gold provenance):
// zero network, zero real model, zero real host, zero production writes.
// These artifacts demonstrate CONTRACT correctness only — they can never
// support a real-host behavior claim.
//
// Usage: node run-examiner-v09-acceptance.mjs [--out <dir>] [--repetitions N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeExaminerV3Case } from '../../__tests__/fixtures/examiner-v07.mjs';
import { hashOfCanonical, freezeMapping } from './lib/challenge-freeze.mjs';
import { runChallengeStudy } from './lib/challenge-runner.mjs';
import { createScriptedStub } from './lib/challenge-actor.mjs';
import { buildBehaviorReportV2, writeBehaviorReportV2, verifyBehaviorReportV2 } from './lib/challenge-behavior-report.mjs';
import {
  writeExaminerStudyArtifacts, runExaminerPreflight,
  buildHostEffectivePrincipleSet, buildRuleCodePolicy, definePrimaryEndpoint,
} from './lib/examiner-study.mjs';
import { verifyInjectionEvidenceChain, HOST_MAX_PROVABLE_LEVEL } from './lib/examiner-injection-evidence.mjs';

const labDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(labDir, '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outRoot = path.resolve(labDir, flag('--out', 'examiner-studies'));
const REPETITIONS = Number(flag('--repetitions', '2')) || 2;
const NOW = flag('--now', '2026-11-01T00:00:00Z');

// --- synthetic offline study inputs (declared synthetic, never real Pain) ---
const TARGET = { id: 'PD-ACC-TARGET', version: 'v1', text: '结论不得超越观察：对目标对象的断言必须先以当前证据核实。', status: 'active' };
const LIBRARY = [
  { id: 'PD-ACC-P1', version: 'v1', text: 'Report only what current evidence supports.', status: 'active' },
  { id: 'PD-ACC-P2', version: 'v2', text: 'Prefer the cheapest sufficient verification path.', status: 'active' },
  { id: 'PD-ACC-P3', version: 'v1', text: 'An archived principle that must NOT enter the library.', status: 'archived' },
  { id: 'PD-ACC-P4', version: 'v1', text: 'A probation principle still pending Owner approval.', status: 'probation' },
];
const RULECODES = [
  { ruleCodeId: 'RC-TARGET', principleId: 'PD-ACC-TARGET', baselineState: 'OFF' },
  { ruleCodeId: 'RC-P1', principleId: 'PD-ACC-P1', baselineState: 'ON' },
];
const HOST_MANIFEST = { host: 'offline-stub', hostKind: 'offline-stub', adapter: 'lab-offline', maxProvableInjectionLevel: HOST_MAX_PROVABLE_LEVEL['offline-stub'] };
const MODEL_MANIFEST = { model: 'offline-deterministic-stub', provider: 'local', version: 'stub-1' };
const ANALYSIS_PLAN = {
  primary: 'ITT (Intention-to-Treat) over preregistered applicable pairs; fixed planned denominator; UNKNOWN kept as bounds',
  missingHandling: 'bounds only — no imputation, no deletion',
  secondary: ['PCR', 'FIR', 'PairedDelta', 'TreatmentFidelity', 'NegativeTransfer', 'OperationalCost'],
  inference: 'paired descriptive statistics; repetitions of one case are NOT independent samples; no significance claims at this sample size (DESCRIPTIVE_ONLY)',
};
const INVALIDATION_POLICY = {
  hard: ['wrong host or model used', 'preregistration tampered', 'gold leaked to actor', 'A/B initial states differ', 'unauthorized non-target drift', 'shared mutable memory across arms', 'production writes', 'unacceptable cross-arm contamination', 'execution bypassed authorization'],
  infrastructure: 'isolated single host/runner/provider failures stay UNKNOWN (never actor failures); continue per the preregistered infrastructure-failure budget',
};

function buildCaseDefs() {
  // Failure-reproduction (applicable) + applicability-boundary (NOT_APPLICABLE)
  // + an additional applicable case for repetition structure. Synthetic
  // fixture cases — the SAME frozen v3 contract the scorer/report consume.
  return [
    makeExaminerV3Case({ caseId: 'EXM-V09-ACC-01' }),
    makeExaminerV3Case({ caseId: 'EXM-V09-ACC-02', boundary: true }),
    makeExaminerV3Case({ caseId: 'EXM-V09-ACC-03', unknown: true }),
  ];
}

function actionsFor(armId) {
  // Control: asserts beyond observation (the target failure mechanism);
  // Treatment: verifies the right object first. The unknown-case (03) gets a
  // behavior whose outcome stays honestly UNKNOWN on the primary endpoint.
  return (caseId) => {
    if (caseId === 'EXM-V09-ACC-03') {
      return armId === 'A'
        ? [{ type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-NEUTRAL'] }] } }]
        : [{ type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-NEUTRAL'] }] } }];
    }
    return armId === 'A'
      ? [
        { type: 'observe', args: { obsId: 'OBS-WRONG' } },
        { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-WRONG'] }] } },
      ]
      : [
        { type: 'observe', args: { obsId: 'OBS-PRIMARY' } },
        { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } },
      ];
  };
}

function verifyHistoricalBaseline() {
  const baselineFile = path.join(repoDir, 'docs', 'implementation-reports', 'examiner-v09', 'HISTORICAL_FROZEN_ASSET_BASELINE.sha256');
  if (!fs.existsSync(baselineFile)) return { ok: false, reason: 'baseline manifest missing' };
  let checked = 0;
  const mismatches = [];
  for (const line of fs.readFileSync(baselineFile, 'utf8').split('\n')) {
    const match = line.match(/^([a-f0-9]{64}) \*?(.+)$/);
    if (!match) continue;
    const [, hash, rel] = match;
    const abs = path.resolve(repoDir, rel.replaceAll('\\', '/'));
    if (!(abs === repoDir || abs.startsWith(repoDir + path.sep))) { mismatches.push(`${rel}: outside root`); continue; }
    if (!fs.existsSync(abs)) { mismatches.push(`${rel}: missing`); continue; }
    checked += 1;
    const actual = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (actual !== hash) mismatches.push(`${rel}: hash changed`);
  }
  return { ok: mismatches.length === 0, checked, mismatches };
}

async function run() {
  console.log(`[acceptance] out root: ${outRoot} | repetitions: ${REPETITIONS}`);
  fs.mkdirSync(outRoot, { recursive: true });
  const summary = { generatedAt: NOW, spec: 'SPEC-PD-EXAMINER-001 v0.9', outRoot, repetitions: REPETITIONS, studies: [], historicalBaseline: verifyHistoricalBaseline() };
  for (const [mode, studyId, seed] of [
    ['isolated_principle', 'EXM-V09-ACC-ISO', 'v09-acceptance-iso-20261101'],
    ['full_library_incremental', 'EXM-V09-ACC-FULL', 'v09-acceptance-full-20261101'],
  ]) {
    const studyDir = path.join(outRoot, studyId);
    if (fs.existsSync(studyDir)) {
      fs.rmSync(studyDir, { recursive: true, force: true });
      console.log(`[acceptance] replacing previous acceptance run at ${studyDir}`);
    }
    const caseDefs = buildCaseDefs();
    const principleFrozen = { contentJson: { principleDraft: { statement: TARGET.text } } };
    const mapping = { schema: 'PainMechanismMappingV1', mappingId: 'PMM-V09-ACC', principleContentHash: hashOfCanonical(principleFrozen.contentJson), observedFailure: 'an unsupported completion assertion reached the Owner', failureMechanism: 'assertion_without_observation', ownerGroundedGoal: 'claims stay within observed evidence' };
    mapping.mappingHash = freezeMapping(mapping).mappingHash;
    const created = writeExaminerStudyArtifacts({
      studyId, experimentMode: mode,
      hepsPrinciples: { principles: [...LIBRARY, TARGET], targetPrincipleId: TARGET.id, host: 'offline-stub' },
      ruleCodeFacts: { ruleCodes: RULECODES, principleRuleCodeIndependence: true },
      caseDefs, principleFrozen, mapping,
      primaryEndpointId: 'target_unsupported_completion_assertion_rate',
      commonContextText: 'Shared offline research context v0.9 acceptance. Synthetic calibration cases — offline contract validation only.',
      budgetChars: 2000, ordering: 'id-asc', seed, repetitionsPerCase: REPETITIONS,
      hostManifest: HOST_MANIFEST, modelManifest: MODEL_MANIFEST,
      scorerVersion: 'mechanical-claim-evidence-v3',
      secondaryEndpoints: ['principle_conformance_failure_rate', 'objective_task_failure_rate'],
      negativeTransferMetrics: ['unnecessaryRefusal', 'alternativePathBlocking', 'overChecking', 'repeatedConfirmation', 'inapplicableTrigger', 'unsupportedAction', 'additionalOperationalCost'],
      operationalCostMetrics: ['observationCalls', 'toolCalls', 'budgetUsed', 'timeUnits', 'additionalChecks'],
      analysisPlan: ANALYSIS_PLAN, invalidationPolicy: INVALIDATION_POLICY,
      goldProvenance: 'SYNTHETIC_OFFLINE', authorizationRef: null, studyDir,
    });
    const preflight = runExaminerPreflight({
      manifest: created.manifest, heps: created.heps, ruleCodePolicy: created.ruleCodePolicy,
      pairAssignment: created.pairAssignment,
      primaryEndpoint: definePrimaryEndpoint({ id: 'target_unsupported_completion_assertion_rate' }),
      armConfigs: { arms: { A: { delivery: { payloadText: created.armPayloads.arms.control.payloadText } }, B: { delivery: { payloadText: created.armPayloads.arms.treatment.payloadText } } } },
      targetPrincipleText: TARGET.text,
      isolation: { sessionPerArm: true, workspacePerArm: true },
      goldStatus: 'SYNTHETIC_OFFLINE',
      injectionCapability: { host: 'offline-stub', maxProvableLevel: HOST_MAX_PROVABLE_LEVEL['offline-stub'], minimumRequiredLevel: 'CONTEXT_PRESENT' },
      authorization: { mode: 'offline-stub' },
      studyDirStatus: { insideFrozenArea: false, collidesWithHistorical: false },
    });
    if (!preflight.ok) throw new Error(`preflight BLOCKED for ${studyId}: ${preflight.blockers.map((b) => `${b.id}: ${b.detail}`).join(' | ')}`);
    const suite = JSON.parse(fs.readFileSync(path.join(studyDir, 'suite-manifest.json'), 'utf8'));
    const runSummary = await runChallengeStudy({
      studyDir,
      plan: { arms: ['A', 'B'], cases: suite.cases.map((c) => c.caseId), repetitions: Array.from({ length: REPETITIONS }, (_, i) => String(i + 1)), unitOrder: created.pairAssignment.unitOrder },
      actorFactory: ({ armId, caseId }) => createScriptedStub({ actions: actionsFor(armId)(caseId) }),
      execution: { mode: 'offline-stub' },
    });
    const report = writeBehaviorReportV2(studyDir, { now: NOW });
    const verification = verifyBehaviorReportV2(studyDir);
    const chainResults = [];
    const walkChains = (p) => {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) walkChains(full);
        else if (entry.name.startsWith('injection-evidence-')) {
          chainResults.push(verifyInjectionEvidenceChain(JSON.parse(fs.readFileSync(full, 'utf8'))));
        }
      }
    };
    walkChains(path.join(studyDir, 'runs'));
    const unitsOk = runSummary.units.every((u) => u.state === 'SUCCEEDED');
    const chainsOk = chainResults.length > 0 && chainResults.every((c) => c.ok) && chainResults.every((c) => c.provenLevel === 'RUNTIME_LOADED');
    const verifyOk = verification.checks.every((c) => c.ok);
    console.log(`[acceptance] ${studyId} (${mode}): units=${runSummary.units.length} allSucceeded=${unitsOk} chains=${chainResults.length} allRuntimeLoaded=${chainsOk} report=${report.status} replayVerify=${verifyOk}`);
    console.log(`  ITT: planned=${report.report.examiner.itt.plannedApplicablePairs} determined=${report.report.examiner.itt.determinedPairs} point=${report.report.examiner.itt.pointEstimate.status}${report.report.examiner.itt.pointEstimate.status === 'ESTIMABLE' ? `=${report.report.examiner.itt.pointEstimate.value}` : ''} bounds=[${report.report.examiner.itt.lowerBound.value ?? 'n/a'}, ${report.report.examiner.itt.upperBound.value ?? 'n/a'}]`);
    console.log(`  Fidelity: contextPresent=${report.report.examiner.treatmentFidelity.contextPresent}/${report.report.examiner.treatmentFidelity.plannedTreatmentUnits} runtimeLoaded=${report.report.examiner.treatmentFidelity.runtimeLoaded} controlContamination=${report.report.examiner.treatmentFidelity.controlContamination.units}`);
    summary.studies.push({
      studyId, mode, studyDir,
      plannedPairs: created.pairAssignment.pairs.length,
      units: runSummary.units.map((u) => ({ unit: `${u.unit.caseId}/${u.unit.armId}/r${u.unit.repetitionId}`, state: u.state })),
      preflightStatus: preflight.status,
      reportStatus: report.status,
      itt: report.report.examiner.itt,
      treatmentFidelity: report.report.examiner.treatmentFidelity,
      applicability: report.report.examiner.applicability,
      randomization: report.report.examiner.randomization,
      chainsVerified: chainsOk,
      replayVerified: verifyOk,
      PASS: unitsOk && chainsOk && verifyOk && report.status !== 'REPORT_INVALID',
    });
  }
  summary.PASS = summary.studies.every((s) => s.PASS) && summary.historicalBaseline.ok;
  fs.writeFileSync(path.join(outRoot, 'acceptance-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`[acceptance] historical baseline: ok=${summary.historicalBaseline.ok} checked=${summary.historicalBaseline.checked ?? 0}${summary.historicalBaseline.mismatches ? ` mismatches=${summary.historicalBaseline.mismatches.length}` : ''}`);
  console.log(`[acceptance] OVERALL: ${summary.PASS ? 'PASS' : 'FAIL'} → ${path.join(outRoot, 'acceptance-summary.json')}`);
  process.exitCode = summary.PASS ? 0 : 1;
}

run().catch((e) => {
  console.error(`[acceptance] FAILED: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
