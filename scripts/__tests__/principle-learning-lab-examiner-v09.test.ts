// SPEC-PD-EXAMINER-001 v0.9 — dual-mode contract, injection evidence, ITT,
// Treatment Fidelity and the Report V2 examiner block. Red→green coverage for
// the SPEC §13 checklist; every scenario is offline (zero network/clock).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeExaminerV3Case } from './fixtures/examiner-v07.mjs';
import { hashOfCanonical, freezeMapping } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';
import { runChallengeStudy, verifyExaminerArmConfigsFrozen, resolveDispatchUnits } from '../dev/principle-learning-lab/lib/challenge-runner.mjs';
import { createScriptedStub } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';
import { buildBehaviorReportV2, writeBehaviorReportV2, verifyBehaviorReportV2 } from '../dev/principle-learning-lab/lib/challenge-behavior-report.mjs';
import { computeITT, computeTreatmentFidelity } from '../dev/principle-learning-lab/lib/challenge-statistics.mjs';
import {
  buildHostEffectivePrincipleSet, verifyHostEffectivePrincipleSet,
  buildRuleCodePolicy, verifyRuleCodePolicy,
  definePrimaryEndpoint, evaluatePrimaryEndpointF,
  assignPairs, verifyPairAssignment,
  buildExaminerStudyManifest, verifyExaminerManifest,
  buildDualModeArmPayloads, writeExaminerStudyArtifacts, runExaminerPreflight,
} from '../dev/principle-learning-lab/lib/examiner-study.mjs';
import {
  buildInjectionEvidenceChain, verifyInjectionEvidenceChain, collectOfflineStubInjectionEvidence,
  HOST_MAX_PROVABLE_LEVEL, INJECTION_EVIDENCE_LEVELS,
} from '../dev/principle-learning-lab/lib/examiner-injection-evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const labRoot = path.resolve(here, '../dev/principle-learning-lab');
const repoRoot = path.resolve(labRoot, '..', '..', '..');
const tmpRoot = path.join(repoRoot, '.tmp', 'examiner-v09-tests');
const NOW = '2026-11-01T00:00:00Z';

const PRINCIPLES = [
  { id: 'PD-P1', version: 'v1', text: 'Report only what current evidence supports.', status: 'active' },
  { id: 'PD-P2', version: 'v2', text: 'Prefer the cheapest sufficient verification path.', status: 'active' },
  { id: 'PD-P3', version: 'v1', text: 'A retired principle.', status: 'archived' },
  { id: 'PD-PT', version: 'v3', text: '结论不得超越观察：对目标对象的断言必须先以当前证据核实。', status: 'active' },
];
const TARGET = PRINCIPLES[3];
const HOST_MANIFEST = { host: 'offline-stub', hostKind: 'offline-stub', adapter: 'lab-offline', maxProvableInjectionLevel: HOST_MAX_PROVABLE_LEVEL['offline-stub'] };
const MODEL_MANIFEST = { model: 'offline-deterministic-stub', provider: 'local', version: 'stub-1' };
const ANALYSIS_PLAN = { primary: 'ITT over preregistered applicable pairs with UNKNOWN bounds; fixed planned denominator', missingHandling: 'bounds only — no imputation', secondary: ['PCR', 'FIR', 'TreatmentFidelity'] };
const INVALIDATION_POLICY = { hard: ['preregistration tampered', 'gold leak to actor', 'shared mutable memory across arms', 'unauthorized non-target drift'], infra: 'single infrastructure failures stay UNKNOWN and never become actor failures' };

function mkdtemp(tag: string): string {
  const dir = path.join(tmpRoot, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assembleStudyInputs({ mode, repetitionsPerCase = 1, caseDefs = null, ruleCodes = [] as any[], independence = true } = {}) {
  const caseList = caseDefs || [makeExaminerV3Case({ caseId: 'EXM-V09-T1' }), makeExaminerV3Case({ caseId: 'EXM-V09-T2', boundary: true })];
  const principleFrozen = { contentJson: { principleDraft: { statement: TARGET.text } } };
  const mapping: any = { schema: 'PainMechanismMappingV1', mappingId: 'PMM-V09', principleContentHash: hashOfCanonical(principleFrozen.contentJson), observedFailure: 'f', failureMechanism: 'assertion_without_observation', ownerGroundedGoal: 'g' };
  mapping.mappingHash = freezeMapping(mapping).mappingHash;
  return {
    studyId: 'EXM-V09-STUDY',
    experimentMode: mode,
    hepsPrinciples: { principles: PRINCIPLES, targetPrincipleId: TARGET.id, host: 'offline-stub' },
    ruleCodeFacts: { ruleCodes, principleRuleCodeIndependence: independence },
    caseDefs: caseList,
    principleFrozen,
    mapping,
    primaryEndpointId: 'target_unsupported_completion_assertion_rate',
    commonContextText: 'Shared offline research context v0.9.',
    budgetChars: 2000,
    seed: 'v09-seed-1',
    repetitionsPerCase,
    hostManifest: HOST_MANIFEST,
    modelManifest: MODEL_MANIFEST,
    scorerVersion: 'mechanical-claim-evidence-v3',
    analysisPlan: ANALYSIS_PLAN,
    invalidationPolicy: INVALIDATION_POLICY,
    goldProvenance: 'SYNTHETIC_OFFLINE',
  };
}

// A(control) behaves badly: wrong-object observation then a claim beyond it;
// B(treatment) verifies the right object first — only B has supporting
// evidence, so evidenceAlignment (the primary endpoint dimension) FAILs on A.
async function runExaminerStudy(dir: string, { useUnitOrder = true } = {}) {
  const pairAssignment = JSON.parse(fs.readFileSync(path.join(dir, 'pair-assignment.json'), 'utf8'));
  const suite = JSON.parse(fs.readFileSync(path.join(dir, 'suite-manifest.json'), 'utf8'));
  return runChallengeStudy({
    studyDir: dir,
    plan: {
      arms: ['A', 'B'],
      cases: suite.cases.map((c: any) => c.caseId),
      repetitions: ['1'],
      ...(useUnitOrder ? { unitOrder: pairAssignment.unitOrder } : {}),
    },
    actorFactory: ({ armId, caseId }: any) => createScriptedStub({
      actions: armId === 'A'
        ? [
          { type: 'observe', args: { obsId: 'OBS-WRONG' } },
          { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-WRONG'] }] } },
        ]
        : [
          { type: 'observe', args: { obsId: 'OBS-PRIMARY' } },
          { type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } },
        ],
    }),
    execution: { mode: 'offline-stub' },
  });
}

// ---------------------------------------------------------------------------
// §13.A 实验配置
// ---------------------------------------------------------------------------
describe('v0.9 §13.A experiment configuration', () => {
  it('isolated mode: control payload is EMPTY — no extra principle may ride along', () => {
    const heps = buildHostEffectivePrincipleSet({ principles: PRINCIPLES, targetPrincipleId: TARGET.id, host: 'offline-stub' });
    const arms = buildDualModeArmPayloads({ mode: 'isolated_principle', heps, targetPrinciple: TARGET, budgetChars: 2000 });
    expect(arms.arms.control.payloadText).toBe('');
    expect(arms.arms.control.contentMode).toBe('none');
    expect(arms.arms.treatment.payloadText).toContain(TARGET.text);
    expect(arms.arms.treatment.deliveredIds).toEqual([TARGET.id]);
    expect(arms.isolationAudit.ok).toBe(true);
  });

  it('isolated mode: every PD RuleCode is OFF in BOTH arms (no RuleCode leak)', () => {
    const policy = buildRuleCodePolicy({
      mode: 'isolated_principle',
      ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'ON' }, { ruleCodeId: 'RC-X', principleId: 'PD-P1', baselineState: 'ON' }],
      targetPrincipleId: TARGET.id,
      principleRuleCodeIndependence: true,
    });
    expect(policy.arms.control).toMatchObject({ targetPrinciple: 'OFF', targetRuleCode: 'OFF', otherRuleCodes: 'ALL_OFF' });
    expect(policy.arms.treatment).toMatchObject({ targetPrinciple: 'ON', targetRuleCode: 'OFF', otherRuleCodes: 'ALL_OFF' });
    const tampered = { ...policy, arms: { ...policy.arms, treatment: { ...policy.arms.treatment, targetRuleCode: 'ON' } } };
    expect(verifyRuleCodePolicy(tampered).ok).toBe(false);
  });

  it('isolated mode with uncontrollable baseline-ON RuleCode is NOT executable (refused, not faked)', () => {
    const policy = buildRuleCodePolicy({
      mode: 'isolated_principle',
      ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'ON' }],
      targetPrincipleId: TARGET.id,
      principleRuleCodeIndependence: false,
    });
    expect(policy.executable).toBe(false);
    expect(policy.interventionType).toBe('bundled_intervention');
  });

  it('full-library mode: target RuleCode keeps its BASELINE (never switched off for the study)', () => {
    const policy = buildRuleCodePolicy({
      mode: 'full_library_incremental',
      ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'ON' }],
      targetPrincipleId: TARGET.id,
      principleRuleCodeIndependence: true,
    });
    expect(policy.arms.control.targetRuleCode).toBe('BASELINE_ON');
    expect(policy.arms.treatment.targetRuleCode).toBe('BASELINE_ON');
    expect(policy.arms.treatment.otherRuleCodes).toBe('BASELINE_FROZEN');
    expect(policy.interventionType).toBe('principle_only');
  });

  it('full-library mode with uncontrollable coupling is declared bundled_intervention', () => {
    const policy = buildRuleCodePolicy({
      mode: 'full_library_incremental',
      ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'ON' }],
      targetPrincipleId: TARGET.id,
      principleRuleCodeIndependence: false,
    });
    expect(policy.interventionType).toBe('bundled_intervention');
    expect(policy.couplingReason).toContain('cannot be controlled independently');
  });

  it('HEPS excludes non-active/non-applicable principles and detects snapshot tampering', () => {
    const heps = buildHostEffectivePrincipleSet({ principles: PRINCIPLES, targetPrincipleId: TARGET.id, host: 'offline-stub' });
    expect(heps.baseLibrary.map((p) => p.id)).toEqual(['PD-P1', 'PD-P2']);
    expect(heps.excluded).toEqual([{ id: 'PD-P3', status: 'archived', reason: 'status:INELIGIBLE_ARCHIVED' }]);
    expect(heps.target.qualifies).toBe(true);
    expect(verifyHostEffectivePrincipleSet(heps).ok).toBe(true);
    const tampered = { ...heps, baseLibrary: [...heps.baseLibrary, { id: 'SMUGGLED', version: 'v1', contentHash: '0'.repeat(64) }] };
    expect(verifyHostEffectivePrincipleSet(tampered).ok).toBe(false);
  });

  it('probation/candidate principles are NOT host-effective (PD five-state mapping)', () => {
    const heps = buildHostEffectivePrincipleSet({
      principles: [...PRINCIPLES, { id: 'PD-PROB', version: 'v1', text: 'x', status: 'probation' }, { id: 'PD-CAND', version: 'v1', text: 'y', status: 'candidate' }],
      targetPrincipleId: TARGET.id,
      host: 'offline-stub',
    });
    const excludedIds = heps.excluded.map((e) => e.id);
    expect(excludedIds).toContain('PD-PROB');
    expect(excludedIds).toContain('PD-CAND');
  });

  it('study directory creation refuses existing dirs and the frozen studies area', () => {
    const parent = mkdtemp('v09-create-guard');
    const inputs = assembleStudyInputs({ mode: 'isolated_principle' });
    const dirA = path.join(parent, 'S1');
    writeExaminerStudyArtifacts({ ...inputs, studyDir: dirA });
    expect(() => writeExaminerStudyArtifacts({ ...inputs, studyDir: dirA })).toThrow(/already exists/);
    expect(() => writeExaminerStudyArtifacts({ ...inputs, studyDir: path.join(labRoot, 'challenge-studies', 'SNEAKY') })).toThrow(/frozen studies area/);
  });

  it('full-library arm verification detects non-target principle drift', () => {
    const parent = mkdtemp('v09-heps-drift');
    const dir = path.join(parent, 'S1');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    expect(() => verifyExaminerArmConfigsFrozen(dir)).not.toThrow();
    const hepsFile = path.join(dir, 'heps-principles.json');
    const hepsInput = JSON.parse(fs.readFileSync(hepsFile, 'utf8'));
    hepsInput.principles = hepsInput.principles.filter((p: any) => p.id !== 'PD-P2');
    fs.writeFileSync(hepsFile, `${JSON.stringify(hepsInput, null, 2)}\n`);
    expect(() => verifyExaminerArmConfigsFrozen(dir)).toThrow(/HEPS snapshot hash/);
  });

  it('tampered arm payload is detected by the examiner arm verifier', () => {
    const parent = mkdtemp('v09-arm-drift');
    const dir = path.join(parent, 'S1');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    const file = path.join(dir, 'examiner-arm-configs.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.arms.control.payloadText = cfg.arms.treatment.payloadText;
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    expect(() => verifyExaminerArmConfigsFrozen(dir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §13.B 隔离与随机化
// ---------------------------------------------------------------------------
describe('v0.9 §13.B isolation and randomization', () => {
  it('pair assignment is reproducible from its seed and tamper-evident', () => {
    const a = assignPairs({ cases: ['C1', 'C2', 'C3'], repetitionsPerCase: 3, seed: 's-1' });
    const b = assignPairs({ cases: ['C1', 'C2', 'C3'], repetitionsPerCase: 3, seed: 's-1' });
    expect(a.assignmentHash).toBe(b.assignmentHash);
    expect(verifyPairAssignment(a).ok).toBe(true);
    const tampered = { ...a, unitOrder: [...a.unitOrder.slice(1), a.unitOrder[0]] };
    expect(verifyPairAssignment(tampered).ok).toBe(false);
    const reseeded = { ...a, seed: 's-2' };
    expect(verifyPairAssignment(reseeded).ok).toBe(false);
  });

  it('balanced randomization keeps control-first/treatment-first counts within one', () => {
    const a = assignPairs({ cases: ['C1', 'C2', 'C3', 'C4'], repetitionsPerCase: 5, seed: 'balance' });
    expect(a.pairs.length).toBe(20);
    expect(Math.abs(a.balance.controlFirst - a.balance.treatmentFirst)).toBeLessThanOrEqual(1);
    for (const pair of a.pairs) {
      expect(new Set(pair.armOrder).size).toBe(2);
    }
    expect(new Set(a.unitOrder.map((u) => `${u.caseId}/${u.armId}/r${u.repetitionId}`)).size).toBe(40);
  });

  it('runner rejects a unitOrder that skips, duplicates or smuggles units', () => {
    const plan = { arms: ['A', 'B'], cases: ['C1', 'C2'], repetitions: ['1'] };
    expect(resolveDispatchUnits(plan)).toHaveLength(4);
    expect(() => resolveDispatchUnits({ ...plan, unitOrder: [{ caseId: 'C1', armId: 'A', repetitionId: '1' }] })).toThrow(/omits planned unit/);
    expect(() => resolveDispatchUnits({ ...plan, unitOrder: [
      { caseId: 'C1', armId: 'A', repetitionId: '1' }, { caseId: 'C1', armId: 'A', repetitionId: '1' },
      { caseId: 'C1', armId: 'B', repetitionId: '1' }, { caseId: 'C2', armId: 'A', repetitionId: '1' },
    ] })).toThrow(/more than once/);
    expect(() => resolveDispatchUnits({ ...plan, unitOrder: [{ caseId: 'C9', armId: 'A', repetitionId: '1' }] })).toThrow(/NOT in the planned unit set/);
  });

  it('preflight blocks missing isolation, frozen-area writes and unauthorized real execution', () => {
    const heps = buildHostEffectivePrincipleSet({ principles: PRINCIPLES, targetPrincipleId: TARGET.id, host: 'offline-stub' });
    const policy = buildRuleCodePolicy({ mode: 'isolated_principle', ruleCodes: [], targetPrincipleId: TARGET.id });
    const pairs = assignPairs({ cases: ['C1'], repetitionsPerCase: 1, seed: 's' });
    const endpoint = definePrimaryEndpoint({ id: 'target_unsupported_completion_assertion_rate' });
    const manifest = buildExaminerStudyManifest({
      studyId: 'EXM-V09-PREFLIGHT', targetPrinciple: { id: TARGET.id, version: TARGET.version, contentHash: 'a'.repeat(64) },
      experimentMode: 'isolated_principle', heps, ruleCodePolicy: policy, hostManifest: HOST_MANIFEST, modelManifest: MODEL_MANIFEST,
      challengeSuiteHash: 'b'.repeat(64), goldSnapshotHash: 'c'.repeat(64), scorerVersion: 'v3', primaryEndpoint: endpoint,
      secondaryEndpoints: [], negativeTransferMetrics: [], operationalCostMetrics: [], pairAssignment: pairs,
      analysisPlan: ANALYSIS_PLAN, invalidationPolicy: INVALIDATION_POLICY,
    });
    const base = {
      manifest, heps, ruleCodePolicy: policy, pairAssignment: pairs, primaryEndpoint: endpoint,
      armConfigs: { arms: { A: { delivery: { payloadText: '' } }, B: { delivery: { payloadText: TARGET.text } } } },
      goldStatus: 'SYNTHETIC_OFFLINE',
      injectionCapability: { host: 'offline-stub', maxProvableLevel: 'RUNTIME_LOADED', minimumRequiredLevel: 'CONTEXT_PRESENT' },
      authorization: { mode: 'offline-stub' },
      studyDirStatus: { insideFrozenArea: false, collidesWithHistorical: false },
    };
    const ok = runExaminerPreflight({ ...base, isolation: { sessionPerArm: true, workspacePerArm: true } });
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe('READY_FOR_OFFLINE_EXECUTION');
    const noIsolation = runExaminerPreflight({ ...base, isolation: { sessionPerArm: false, workspacePerArm: false } });
    expect(noIsolation.ok).toBe(false);
    expect(noIsolation.blockers.map((b) => b.id)).toEqual(expect.arrayContaining(['isolation_sessions', 'isolation_workspaces']));
    const frozenDir = runExaminerPreflight({ ...base, isolation: { sessionPerArm: true, workspacePerArm: true }, studyDirStatus: { insideFrozenArea: true, collidesWithHistorical: false } });
    expect(frozenDir.blockers.map((b) => b.id)).toContain('study_dir_protection');
    const realMode = runExaminerPreflight({ ...base, isolation: { sessionPerArm: true, workspacePerArm: true }, authorization: { mode: 'F2-real-host' } });
    expect(realMode.blockers.map((b) => b.id)).toContain('authorization');
  });
});

// ---------------------------------------------------------------------------
// §13.C 注入证据链
// ---------------------------------------------------------------------------
describe('v0.9 §7 injection evidence chain', () => {
  const validStage = (ref: string) => ({ evidenceRef: ref, contentHash: 'd'.repeat(64) });
  const H = 'a'.repeat(64);

  it('provenLevel is the highest CONSECUTIVE evidenced level; SUBMITTED is never RUNTIME_LOADED', () => {
    const submitted = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', armId: 'A', principleHash: H, configured: validStage('cfg'), selected: validStage('sel'), submitted: validStage('sub') });
    expect(submitted.provenLevel).toBe('SUBMITTED');
    const full = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', armId: 'B', principleHash: H, configured: validStage('cfg'), selected: validStage('sel'), submitted: validStage('sub'), hostAccepted: validStage('acc'), contextPresent: validStage('ctx'), runtimeLoaded: validStage('run') });
    expect(full.provenLevel).toBe('RUNTIME_LOADED');
  });

  it('a gapped chain is refused (each level presupposes its predecessor)', () => {
    expect(() => buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', armId: 'A', principleHash: H, runtimeLoaded: validStage('run') })).toThrow(/gap/);
  });

  it('declaration-only evidence (no evidenceRef) is refused at construction', () => {
    expect(() => buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', armId: 'A', principleHash: H, configured: { note: 'declared true' } as any })).toThrow(/not evidence/);
  });

  it('actor-produced chains are refused by producer whitelist; tampering breaks the chainHash', () => {
    const chain = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', armId: 'A', principleHash: H, configured: validStage('cfg') });
    const forged = { ...chain, producedBy: 'the-actor-itself' };
    expect(verifyInjectionEvidenceChain(forged).ok).toBe(false);
    const tampered = { ...chain, provenLevel: 'RUNTIME_LOADED' };
    expect(verifyInjectionEvidenceChain(tampered).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain, { requireLevel: 'RUNTIME_LOADED' }).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain).ok).toBe(true);
  });

  it('offline scope separation: an offline chain never satisfies a real-host requirement', () => {
    const chain = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', scope: 'offline-stub', armId: 'B', principleHash: H, configured: validStage('cfg') });
    expect(verifyInjectionEvidenceChain(chain, { requireScope: 'real-host' }).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain, { requireScope: 'real-host' }).problems[0]).toContain('offline-stub chain can never prove a real-host');
  });

  it('the offline collector proves the full chain about its own pipeline and refuses false presence', () => {
    const arm = { delivery: { payloadText: 'PAYLOAD-TEXT', payloadHash: 'e'.repeat(64) } };
    const chain = collectOfflineStubInjectionEvidence({ armId: 'B', arm, armPrompt: 'task\n--- applied context ---\nPAYLOAD-TEXT', attemptRef: 'runs/x/B/r1/a1.json' });
    expect(chain.provenLevel).toBe('RUNTIME_LOADED');
    expect(INJECTION_EVIDENCE_LEVELS).toContain(chain.provenLevel);
    expect(() => collectOfflineStubInjectionEvidence({ armId: 'B', arm, armPrompt: 'task without the payload', attemptRef: 'r' })).toThrow(/CONTEXT_PRESENT failed/);
    const control = collectOfflineStubInjectionEvidence({ armId: 'A', arm: { delivery: { payloadText: '', payloadHash: 'f'.repeat(64) } }, armPrompt: 'task\n--- applied context ---\n', attemptRef: 'r' });
    expect(control.provenLevel).toBe('RUNTIME_LOADED');
  });

  it('forbiddenContent contamination is recorded honestly on full-library controls', () => {
    const arm = { delivery: { payloadText: 'LIBRARY', payloadHash: 'e'.repeat(64) } };
    const clean = collectOfflineStubInjectionEvidence({ armId: 'A', arm, armPrompt: 'task\n--- applied context ---\nLIBRARY', attemptRef: 'r', forbiddenContent: '结论不得超越观察' });
    expect(clean.stages.CONTEXT_PRESENT.forbiddenContentPresent).toBe(false);
    const contaminated = collectOfflineStubInjectionEvidence({ armId: 'A', arm, armPrompt: 'task\n--- applied context ---\nLIBRARY\n结论不得超越观察', attemptRef: 'r', forbiddenContent: '结论不得超越观察' });
    expect(contaminated.stages.CONTEXT_PRESENT.forbiddenContentPresent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §13.C/D ITT 与 Fidelity 统计
// ---------------------------------------------------------------------------
describe('v0.9 §5.5 ITT statistics', () => {
  it('fully determined pairs produce the four-cell table and a point estimate', () => {
    const itt = computeITT([
      { pairKey: 'p1', controlF: 1, treatmentF: 0 },
      { pairKey: 'p2', controlF: 0, treatmentF: 1 },
      { pairKey: 'p3', controlF: 1, treatmentF: 1 },
      { pairKey: 'p4', controlF: 0, treatmentF: 0 },
    ]);
    expect(itt.plannedApplicablePairs).toBe(4);
    expect(itt.cells).toEqual({ controlFailedTreatmentCorrected: 1, controlOkTreatmentFailed: 1, bothFailed: 1, bothOk: 1 });
    expect(itt.pointEstimate.status).toBe('ESTIMABLE');
    expect(itt.pointEstimate.value).toBe(0);
    expect(itt.lowerBound.value).toBe(0);
    expect(itt.upperBound.value).toBe(0);
    expect(JSON.stringify(itt)).not.toMatch(/pValue|significan/i);
  });

  it.each([
    ['both UNKNOWN → [−1,+1]', { controlF: 'UNKNOWN', treatmentF: 'UNKNOWN' }, -1, 1],
    ['C FAIL, T UNKNOWN → [0,+1]', { controlF: 1, treatmentF: 'UNKNOWN' }, 0, 1],
    ['C PASS, T UNKNOWN → [−1,0]', { controlF: 0, treatmentF: 'UNKNOWN' }, -1, 0],
    ['C UNKNOWN, T FAIL → [−1,0]', { controlF: 'UNKNOWN', treatmentF: 1 }, -1, 0],
    ['C UNKNOWN, T PASS → [0,+1]', { controlF: 'UNKNOWN', treatmentF: 0 }, 0, 1],
  ])('UNKNOWN range case: %s', (_name, sides, lower, upper) => {
    const itt = computeITT([{ pairKey: 'p1', ...sides }]);
    expect(itt.pointEstimate.status).toBe('BOUNDED_ONLY');
    expect(itt.lowerBound.value).toBe(lower);
    expect(itt.upperBound.value).toBe(upper);
    expect(itt.unknownPairs).toBe(1);
    expect(itt.plannedApplicablePairs).toBe(1);
  });

  it('treatment injection failure stays IN the ITT denominator (strategy failure is not noise)', () => {
    const itt = computeITT([
      { pairKey: 'ok', controlF: 1, treatmentF: 0 },
      { pairKey: 'inj-failed', controlF: 1, treatmentF: 'UNKNOWN', treatmentExecutionValid: false },
    ]);
    expect(itt.plannedApplicablePairs).toBe(2);
    expect(itt.pointEstimate.status).toBe('BOUNDED_ONLY');
    expect(itt.lowerBound.value).toBe(0.5); // pair1 +1 exact; pair2 c=1,t∈{0,1} → [0,1] ⇒ [1,2]/2
    expect(itt.upperBound.value).toBe(1);
  });

  it('zero denominator is NOT_ESTIMABLE, never 0%', () => {
    const itt = computeITT([]);
    expect(itt.lowerBound.status).toBe('NOT_ESTIMABLE');
    expect(itt.pointEstimate.status).toBe('BOUNDED_ONLY');
  });
});

describe('v0.9 §5.4 Treatment Fidelity', () => {
  it('counts injection levels, never conflates SUBMITTED with injected, and reports contamination', () => {
    const chain = (level: string, extra: any = {}) => ({ ok: true, provenLevel: level, principleHash: 'a'.repeat(64), ...extra });
    const fid = computeTreatmentFidelity({
      plannedTreatmentUnits: 4,
      chains: [chain('SUBMITTED'), chain('CONTEXT_PRESENT'), chain('RUNTIME_LOADED'), chain('NONE')],
      controlChains: [chain('CONTEXT_PRESENT', { forbiddenContentPresent: true }), chain('CONTEXT_PRESENT', { forbiddenContentPresent: false })],
    });
    expect(fid.plannedTreatmentUnits).toBe(4);
    expect(fid.submitted).toBe(3);
    expect(fid.contextPresent).toBe(2);
    expect(fid.runtimeLoaded).toBe(1);
    expect(fid.actualInjectionRate.value).toBe(0.5);
    expect(fid.controlContamination.units).toBe(1);
  });

  it('fallback contamination rule: a control proving a NON-absence payload is contaminated', () => {
    const fid = computeTreatmentFidelity({
      plannedTreatmentUnits: 1,
      chains: [{ ok: true, provenLevel: 'CONTEXT_PRESENT', principleHash: 'b'.repeat(64) }],
      controlChains: [{ ok: true, provenLevel: 'CONTEXT_PRESENT', principleHash: 'deadbeef' }],
    });
    expect(fid.controlContamination.units).toBe(1);
  });

  it('fidelity is a separate record — no field of it can replace ITT counts', () => {
    const fid = computeTreatmentFidelity({ plannedTreatmentUnits: 2, chains: [], controlChains: [] });
    expect(fid.rule).toContain('NEVER replace the ITT');
    expect(fid.actualInjectionRate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Primary endpoint evaluation
// ---------------------------------------------------------------------------
describe('v0.9 §5.1 primary endpoint', () => {
  it('F mapping binds the frozen Scorer V3 dimension; NOT_APPLICABLE never enters the denominator', () => {
    const endpoint = definePrimaryEndpoint({ id: 'target_unsupported_completion_assertion_rate' });
    expect(endpoint.reduction.dimension).toBe('evidenceAlignment');
    expect(evaluatePrimaryEndpointF({ endpoint, adjudication: { dimensions: { evidenceAlignment: { status: 'FAIL' } } } as any, caseDef: { principleApplicable: true } })).toBe(1);
    expect(evaluatePrimaryEndpointF({ endpoint, adjudication: { dimensions: { evidenceAlignment: { status: 'PASS' } } } as any, caseDef: { principleApplicable: true } })).toBe(0);
    expect(evaluatePrimaryEndpointF({ endpoint, adjudication: { dimensions: { evidenceAlignment: { status: 'UNKNOWN' } } } as any, caseDef: { principleApplicable: true } })).toBe('UNKNOWN');
    expect(evaluatePrimaryEndpointF({ endpoint, adjudication: { dimensions: { evidenceAlignment: { status: 'FAIL' } } } as any, caseDef: { principleApplicable: false } })).toBe('NOT_APPLICABLE');
  });

  it('the endpoint registry is closed — inventing metrics is refused', () => {
    expect(() => definePrimaryEndpoint({ id: 'custom_metric_language' })).toThrow(/registry is closed/);
  });
});

// ---------------------------------------------------------------------------
// §13.F 端到端：双模式离线 study → runner → Report V2 examiner block → replay
// ---------------------------------------------------------------------------
describe('v0.9 end-to-end offline studies', () => {
  it('isolated mode: run with randomized dispatch, injection sidecars, ITT in Report V2, replay-verified', async () => {
    const parent = mkdtemp('v09-e2e-isolated');
    const dir = path.join(parent, 'EXM-V09-ISO');
    const created = writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    expect(created.manifest.experimentMode).toBe('isolated_principle');
    expect(verifyExaminerManifest(created.manifest).ok).toBe(true);

    const summary = await runExaminerStudy(dir);
    expect(summary.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    const sidecarFiles: string[] = [];
    const walk = (p: string) => {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.startsWith('injection-evidence-')) sidecarFiles.push(full);
      }
    };
    walk(path.join(dir, 'runs'));
    expect(sidecarFiles.length).toBe(4);
    for (const file of sidecarFiles) {
      const chain = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(chain.provenLevel).toBe('RUNTIME_LOADED');
      expect(verifyInjectionEvidenceChain(chain).ok).toBe(true);
    }

    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner).toBeDefined();
    expect(report.examiner.experimentMode).toBe('isolated_principle');
    expect(report.examiner.randomization.verified).toBe(true);
    // T1 is applicable (F derived from evidenceAlignment: A FAIL / B PASS);
    // T2 is the boundary case — Gold-frozen NOT_APPLICABLE, excluded from the
    // ITT denominator and counted separately (§5.8), never as PASS.
    expect(report.examiner.applicability).toEqual({ applicablePairs: 1, notApplicablePairs: 1 });
    expect(report.examiner.itt.plannedApplicablePairs).toBe(1);
    expect(report.examiner.itt.cells.controlFailedTreatmentCorrected).toBe(1);
    expect(report.examiner.itt.pointEstimate.status).toBe('ESTIMABLE');
    expect(report.examiner.itt.pointEstimate.value).toBe(1);
    expect(report.examiner.treatmentFidelity.contextPresent).toBe(2);
    expect(report.examiner.treatmentFidelity.runtimeLoaded).toBe(2);
    expect(report.examiner.treatmentFidelity.controlContamination.units).toBe(0);
    expect(report.status).toBe('REPORT_PENDING');
    const verification = verifyBehaviorReportV2(dir);
    expect(verification.checks.every((c: any) => c.ok)).toBe(true);
  });

  it('full-library mode: non-target library rides in BOTH arms; ITT reflects the incremental contrast', async () => {
    const parent = mkdtemp('v09-e2e-full');
    const dir = path.join(parent, 'EXM-V09-FULL');
    const created = writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    expect(created.armPayloads.arms.control.payloadText).toContain('PD-P1');
    expect(created.armPayloads.arms.control.payloadText).toContain('PD-P2');
    expect(created.armPayloads.arms.control.payloadText).not.toContain(TARGET.text);
    expect(created.armPayloads.arms.treatment.payloadText).toContain(TARGET.text);

    const summary = await runExaminerStudy(dir);
    expect(summary.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner.experimentMode).toBe('full_library_incremental');
    expect(report.examiner.itt.pointEstimate.value).toBe(1);
    expect(report.examiner.treatmentFidelity.controlContamination.units).toBe(0);
  });

  it('capacity eviction under a tight budget is recorded with the evicted principle ids', () => {
    const longText = 'x'.repeat(600);
    const heavy = [
      { id: 'PD-P1', version: 'v1', text: longText, status: 'active' },
      { id: 'PD-P2', version: 'v1', text: longText, status: 'active' },
      { id: 'PD-PT', version: 'v1', text: TARGET.text, status: 'active' },
    ];
    const heavyHeps = buildHostEffectivePrincipleSet({ principles: heavy, targetPrincipleId: 'PD-PT', host: 'offline-stub' });
    const arms = buildDualModeArmPayloads({ mode: 'full_library_incremental', heps: heavyHeps, targetPrinciple: heavy[2], budgetChars: 1000 });
    expect(arms.capacity.control.evicted.length + arms.capacity.control.delivered.length).toBe(2);
    expect(arms.capacity.treatment.targetDelivered).toBe(true);
    expect(arms.arms.treatment.deliveredIds).toContain('PD-PT');
  });

  it('primary endpoint drift after freezing becomes a critical report finding', async () => {
    const parent = mkdtemp('v09-endpoint-drift');
    const dir = path.join(parent, 'EXM-V09-EP');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const file = path.join(dir, 'examiner-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.primaryEndpoint.id = 'principle_conformance_failure_rate';
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_manifest_drift' || f.id === 'examiner_endpoint_drift')).toBe(true);
  });

  it('pair-assignment tampering after freezing becomes a critical report finding', async () => {
    const parent = mkdtemp('v09-pair-drift');
    const dir = path.join(parent, 'EXM-V09-PA');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    const file = path.join(dir, 'pair-assignment.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.unitOrder = [...record.unitOrder.slice(2), ...record.unitOrder.slice(0, 2)];
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_pair_assignment_drift')).toBe(true);
  });

  it('writeBehaviorReportV2 recomputation is byte-stable and READY protection is honored', async () => {
    const parent = mkdtemp('v09-write-idempotent');
    const dir = path.join(parent, 'EXM-V09-W');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    // PENDING reports (synthetic gold) are recomputed as the study settles:
    // the recomputation must be byte-identical — a differing recompute is a
    // contract violation, and once READY the report becomes immutable.
    writeBehaviorReportV2(dir, { now: NOW });
    const afterFirst = fs.readFileSync(path.join(dir, 'behavior-report-v2.json'), 'utf8');
    writeBehaviorReportV2(dir, { now: NOW });
    const afterSecond = fs.readFileSync(path.join(dir, 'behavior-report-v2.json'), 'utf8');
    expect(afterSecond).toBe(afterFirst);
    const reparsed = JSON.parse(afterSecond);
    expect(reparsed.examiner.itt.pointEstimate.value).toBe(1);
    expect(reparsed.status).toBe('REPORT_PENDING');
    // no READY event may exist for a pending report
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.some((e: any) => e.type === 'REPORT_READY_V2')).toBe(false);
  });

  it('historical frozen assets stay byte-identical (baseline re-verification, root-bounded)', () => {
    const baselineFile = path.join(repoRoot, 'docs', 'implementation-reports', 'examiner-v09', 'HISTORICAL_FROZEN_ASSET_BASELINE.sha256');
    if (!fs.existsSync(baselineFile)) return;
    const mismatches: string[] = [];
    for (const line of fs.readFileSync(baselineFile, 'utf8').split('\n')) {
      const match = line.match(/^([a-f0-9]{64}) \*?(.+)$/);
      if (!match) continue;
      const [, hash, rel] = match;
      const abs = path.resolve(repoRoot, rel.replaceAll('\\', '/'));
      // root boundary: every baseline entry must stay INSIDE the repository
      if (!(abs === repoRoot || abs.startsWith(repoRoot + path.sep))) {
        mismatches.push(`${rel}: outside repository root`);
        continue;
      }
      if (!fs.existsSync(abs)) { mismatches.push(`${rel}: missing`); continue; }
      const actual = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (actual !== hash) mismatches.push(`${rel}: hash changed`);
    }
    expect(mismatches).toEqual([]);
  });
});
