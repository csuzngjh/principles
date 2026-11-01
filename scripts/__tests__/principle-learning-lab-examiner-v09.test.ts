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
import { createScriptedStub, buildOfflineRuntimeReceipt } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';
import { buildBehaviorReportV2, writeBehaviorReportV2, verifyBehaviorReportV2, renderBehaviorReportV2Json, renderBehaviorReportV2Markdown } from '../dev/principle-learning-lab/lib/challenge-behavior-report.mjs';
import { computeITT, computeTreatmentFidelity } from '../dev/principle-learning-lab/lib/challenge-statistics.mjs';
import {
  buildHostEffectivePrincipleSet, verifyHostEffectivePrincipleSet,
  buildRuleCodePolicy, verifyRuleCodePolicy,
  definePrimaryEndpoint, evaluatePrimaryEndpointF,
  assignPairs, verifyPairAssignment,
  buildExaminerStudyManifest, verifyExaminerManifest,
  buildDualModeArmPayloads, writeExaminerStudyArtifacts, runExaminerPreflight,
  computeExaminerStudyBindings, verifyExaminerStudyBindings,
  LIBRARY_SELECTION_RULE, renderLibraryPayload,
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

function assembleStudyInputs({ mode, repetitionsPerCase = 1, caseDefs = null, ruleCodes = [] as any[], independence = true, studyId = 'EXM-V09-STUDY' } = {}) {
  const caseList = caseDefs || [makeExaminerV3Case({ caseId: 'EXM-V09-T1' }), makeExaminerV3Case({ caseId: 'EXM-V09-T2', boundary: true })];
  const principleFrozen = { contentJson: { principleDraft: { statement: TARGET.text } } };
  const mapping: any = { schema: 'PainMechanismMappingV1', mappingId: 'PMM-V09', principleContentHash: hashOfCanonical(principleFrozen.contentJson), observedFailure: 'f', failureMechanism: 'assertion_without_observation', ownerGroundedGoal: 'g' };
  mapping.mappingHash = freezeMapping(mapping).mappingHash;
  return {
    studyId,
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
  const P = 'b'.repeat(64);
  const R = 'c'.repeat(64);
  // v2 chains are BOUND to one attempt: without these an attribution cannot be
  // made (a sidecar's directory is never attribution evidence).
  const BINDING = { studyId: 'EXM-V09-STUDY', caseId: 'EXM-V09-T1', armId: 'B', repetitionId: '1', attemptId: 'a1' };
  const UNIT = { caseId: 'EXM-V09-T1', armId: 'B', repetitionId: '1', attemptId: 'a1' };

  it('provenLevel is the highest CONSECUTIVE evidenced level; SUBMITTED is never RUNTIME_LOADED', () => {
    const submitted = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', ...BINDING, principleHash: H, promptHash: P, configured: validStage('cfg'), selected: validStage('sel'), submitted: validStage('sub') });
    expect(submitted.provenLevel).toBe('SUBMITTED');
    const full = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', ...BINDING, principleHash: H, promptHash: P, receiptHash: R, configured: validStage('cfg'), selected: validStage('sel'), submitted: validStage('sub'), hostAccepted: validStage('acc'), contextPresent: validStage('ctx'), runtimeLoaded: validStage('run') });
    expect(full.provenLevel).toBe('RUNTIME_LOADED');
    expect(verifyInjectionEvidenceChain(full, { requireLevel: 'RUNTIME_LOADED' }).ok).toBe(true);
  });

  it('a gapped chain is refused (each level presupposes its predecessor)', () => {
    expect(() => buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', ...BINDING, principleHash: H, promptHash: P, receiptHash: R, runtimeLoaded: validStage('run') })).toThrow(/gap/);
  });

  it('declaration-only evidence (no evidenceRef) is refused at construction', () => {
    expect(() => buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', ...BINDING, principleHash: H, configured: { note: 'declared true' } as any })).toThrow(/not evidence/);
  });

  it('RUNTIME_LOADED without the runtime receipt is refused by construction and unprovable in verification', () => {
    // builder: cannot be expressed at all
    expect(() => buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', ...BINDING, principleHash: H, promptHash: P, configured: validStage('cfg'), selected: validStage('sel'), submitted: validStage('sub'), hostAccepted: validStage('acc') })).toThrow(/runtime's own load receipt/);
    // verifier: a legacy v1 chain that claimed it anyway is NOT_PROVEN
    const legacy = { schema: 'examiner-injection-evidence.v1', producedBy: 'runner-offline-stub', scope: 'offline-stub', armId: 'B', principleHash: H, stages: { RUNTIME_LOADED: validStage('run') }, provenLevel: 'RUNTIME_LOADED' };
    const v1 = { ...legacy, chainHash: hashOfCanonical(legacy) };
    expect(verifyInjectionEvidenceChain(v1).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(v1).problems.join(' ')).toContain('without a runtime load receipt');
  });

  it('actor-produced chains are refused by producer whitelist; tampering breaks the chainHash', () => {
    const chain = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', ...BINDING, principleHash: H, configured: validStage('cfg') });
    const forged = { ...chain, producedBy: 'the-actor-itself' };
    expect(verifyInjectionEvidenceChain(forged).ok).toBe(false);
    const tampered = { ...chain, provenLevel: 'RUNTIME_LOADED' };
    expect(verifyInjectionEvidenceChain(tampered).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain, { requireLevel: 'RUNTIME_LOADED' }).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain).ok).toBe(true);
  });

  it('producer ↔ scope is bound: an offline producer can never mint (or satisfy) a real-host chain', () => {
    const chain = buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', scope: 'offline-stub', ...BINDING, principleHash: H, configured: validStage('cfg') });
    expect(verifyInjectionEvidenceChain(chain, { requireScope: 'real-host' }).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain, { requireScope: 'real-host' }).problems[0]).toContain('offline-stub chain can never prove a real-host');
    expect(() => buildInjectionEvidenceChain({ producedBy: 'runner-offline-stub', scope: 'real-host', ...BINDING, principleHash: H, configured: validStage('cfg') })).toThrow(/must mint scope 'offline-stub'/);
    expect(() => buildInjectionEvidenceChain({ producedBy: 'trusted-host-probe', scope: 'offline-stub', ...BINDING, principleHash: H, configured: validStage('cfg') })).toThrow(/never the offline-stub scope/);
  });

  it('the offline collector binds the full chain to the runtime receipt of the SAME prompt', () => {
    const arm = { delivery: { payloadText: 'PAYLOAD-TEXT', payloadHash: 'e'.repeat(64) } };
    const armPrompt = 'task\n--- applied context ---\nPAYLOAD-TEXT';
    const receipt = buildOfflineRuntimeReceipt(armPrompt);
    const chain = collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt, receipt, attemptRef: 'runs/x/B/r1/a1.json' });
    expect(chain.provenLevel).toBe('RUNTIME_LOADED');
    expect(INJECTION_EVIDENCE_LEVELS).toContain(chain.provenLevel);
    expect(chain.receiptHash).toBe(receipt.receiptHash);
    expect(chain.stages.RUNTIME_LOADED.evidenceRef).toContain('trace.runtimeReceipt');
    const expected = { studyId: 'EXM-V09-STUDY', unitId: 'EXM-V09-T1/B/r1', caseId: 'EXM-V09-T1', armId: 'B', repetitionId: '1', attemptId: 'a1', promptHash: chain.promptHash };
    expect(verifyInjectionEvidenceChain(chain, { requireLevel: 'RUNTIME_LOADED', expected }).ok).toBe(true);
    // attribution is bound, not directory-inferred: the same chain cannot be
    // re-attributed to another attempt.
    expect(verifyInjectionEvidenceChain(chain, { expected: { ...expected, attemptId: 'a2' } }).ok).toBe(false);
    expect(verifyInjectionEvidenceChain(chain, { expected: { ...expected, studyId: 'EXM-OTHER' } }).ok).toBe(false);
  });

  it('without a runtime receipt the collector stops at SELECTED — never SUBMITTED, never LOADED', () => {
    const arm = { delivery: { payloadText: 'PAYLOAD-TEXT', payloadHash: 'e'.repeat(64) } };
    const chain = collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt: 'task\n--- applied context ---\nPAYLOAD-TEXT', attemptRef: 'runs/x/B/r1/a1.json' });
    expect(chain.provenLevel).toBe('SELECTED');
    expect(verifyInjectionEvidenceChain(chain, { requireLevel: 'SUBMITTED' }).ok).toBe(false);
  });

  it('a receipt for a DIFFERENT prompt, a forged receipt, or a payload that is not present are all refused', () => {
    const arm = { delivery: { payloadText: 'PAYLOAD-TEXT', payloadHash: 'e'.repeat(64) } };
    const armPrompt = 'task\n--- applied context ---\nPAYLOAD-TEXT';
    const missingPrompt = 'task without the payload';
    expect(() => collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt: missingPrompt, receipt: buildOfflineRuntimeReceipt(missingPrompt), attemptRef: 'r' })).toThrow(/CONTEXT_PRESENT failed/);
    const otherReceipt = buildOfflineRuntimeReceipt('a completely different prompt');
    expect(() => collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt, receipt: otherReceipt, attemptRef: 'r' })).toThrow(/DIFFERENT prompt/);
    const forged = { ...buildOfflineRuntimeReceipt(armPrompt), receivedPromptHash: 'f'.repeat(64) };
    expect(() => collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt, receipt: forged, attemptRef: 'r' })).toThrow(/receipt invalid/);
  });

  it('the actor runtime issues its own receipt and refuses a second, different prompt', () => {
    const actor = createScriptedStub({ actions: [], armPrompt: null });
    const receipt = actor.loadArmPrompt('PROMPT-ONE');
    expect(receipt.loaded).toBe(true);
    expect(receipt.receivedPromptHash).not.toBe('PROMPT-ONE');
    expect(actor.runtimeReceipt.receiptHash).toBe(receipt.receiptHash);
    expect(actor.loadArmPrompt('PROMPT-ONE').receiptHash).toBe(receipt.receiptHash); // idempotent
    expect(() => actor.loadArmPrompt('PROMPT-TWO')).toThrow(/DIFFERENT prompt/);
  });

  it('forbiddenContent contamination is recorded honestly on full-library controls', () => {
    const arm = { delivery: { payloadText: 'LIBRARY', payloadHash: 'e'.repeat(64) } };
    const prompt = 'task\n--- applied context ---\nLIBRARY';
    const clean = collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt: prompt, receipt: buildOfflineRuntimeReceipt(prompt), attemptRef: 'r', forbiddenContent: '结论不得超越观察' });
    expect(clean.stages.CONTEXT_PRESENT.forbiddenContentPresent).toBe(false);
    const contaminatedPrompt = 'task\n--- applied context ---\nLIBRARY\n结论不得超越观察';
    const contaminated = collectOfflineStubInjectionEvidence({ studyId: 'EXM-V09-STUDY', unit: UNIT, arm, armPrompt: contaminatedPrompt, receipt: buildOfflineRuntimeReceipt(contaminatedPrompt), attemptRef: 'r', forbiddenContent: '结论不得超越观察' });
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
    const arms = buildDualModeArmPayloads({ mode: 'full_library_incremental', heps: heavyHeps, targetPrinciple: heavy[2], principleFacts: heavy, budgetChars: 1000 });
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

  it('writeBehaviorReportV2 checks write permission BEFORE any generation, lock or file write', async () => {
    const parent = mkdtemp('v09-write-refused');
    const dir = path.join(parent, 'EXM-V09-R');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const before = fs.readdirSync(dir).sort();
    let permissionChecks = 0;
    expect(() => writeBehaviorReportV2(dir, {
      now: NOW,
      canWrite: () => {
        permissionChecks += 1;
        return { ok: false, reason: 'study was not created by this server' };
      },
    })).toThrow(/REPORT_WRITE_REFUSED: study was not created by this server/);
    expect(permissionChecks).toBe(1);
    // nothing was generated, locked or appended: the refusal is not a
    // post-generation rollback
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'behavior-report-v2.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'runs', 'writer.lock'))).toBe(false);

    // a throwing permission probe also fails closed
    expect(() => writeBehaviorReportV2(dir, {
      now: NOW,
      canWrite: () => {
        throw new Error('ownership probe unavailable');
      },
    })).toThrow(/ownership probe unavailable/);
    expect(fs.existsSync(path.join(dir, 'behavior-report-v2.json'))).toBe(false);

    // and a granted permission still produces the report
    const written = writeBehaviorReportV2(dir, { now: NOW, canWrite: () => ({ ok: true }) });
    expect(written.written).toBe(true);
    expect(fs.existsSync(path.join(dir, 'behavior-report-v2.json'))).toBe(true);
  });

  it('historical frozen assets stay byte-identical (baseline re-verification, root-bounded)', () => {
    const baselineFile = path.join(repoRoot, 'docs', 'implementation-reports', 'examiner-v09', 'HISTORICAL_FROZEN_ASSET_BASELINE.sha256');
    if (!fs.existsSync(baselineFile)) return;
    const mismatches: string[] = [];
    let entries = 0;
    for (const line of fs.readFileSync(baselineFile, 'utf8').split('\n')) {
      // A checkout may use CRLF; trimming keeps the entry count honest instead
      // of silently matching nothing.
      const match = line.trim().match(/^([a-f0-9]{64}) \*?(.+)$/);
      if (!match) continue;
      entries += 1;
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
    expect(entries).toBeGreaterThan(500);
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P2-2 — runner write-lock lifecycle (an invalid plan must not leak the lock)
// ---------------------------------------------------------------------------
describe('v0.9 runner write-lock lifecycle', () => {
  it('an invalid unitOrder rejects BEFORE the lock: no lock file, no RUN_STARTED, no budget, next legal run acquires and releases', async () => {
    const parent = mkdtemp('v09-lock-lifecycle');
    const dir = path.join(parent, 'EXM-V09-LOCK');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    const suite = JSON.parse(fs.readFileSync(path.join(dir, 'suite-manifest.json'), 'utf8'));
    const actorFactory = () => createScriptedStub({
      actions: [{ type: 'report', args: { claims: [{ factId: 'F1', verdict: 'verified_true', evidenceRefs: ['OBS-PRIMARY'] }] } }],
    });
    await expect(runChallengeStudy({
      studyDir: dir,
      plan: {
        arms: ['A', 'B'],
        cases: suite.cases.map((c: any) => c.caseId),
        repetitions: ['1'],
        // one unit short of the planned set — refused by resolveDispatchUnits
        unitOrder: [{ caseId: suite.cases[0].caseId, armId: 'A', repetitionId: '1' }],
      },
      actorFactory,
      execution: { mode: 'offline-stub' },
    })).rejects.toThrow(/omits planned unit/);
    expect(fs.existsSync(path.join(dir, 'runs', 'writer.lock'))).toBe(false);
    const eventsFile = path.join(dir, 'events.jsonl');
    const eventTypes = fs.existsSync(eventsFile)
      ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line).type)
      : [];
    expect(eventTypes).not.toContain('RUN_STARTED');
    expect(fs.existsSync(path.join(dir, 'budget-ledger.jsonl'))).toBe(false);
    // The same study is still usable: the rejection never wedged the lock.
    const summary = await runExaminerStudy(dir);
    expect(summary.units.every((u: any) => u.state === 'SUCCEEDED')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'runs', 'writer.lock'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-2 — report-side injection evidence binding (duplicates / missing / drift)
// ---------------------------------------------------------------------------
describe('v0.9 §7 bound injection evidence in Report V2', () => {
  async function ranStudy(tag: string) {
    const parent = mkdtemp(tag);
    const dir = path.join(parent, 'EXM-V09-INJ');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    return dir;
  }
  const repDir = (dir: string, caseId: string, armId: string) => path.join(dir, 'runs', caseId, armId, 'r1');

  it('a duplicated attempt sidecar is counted as a duplicate and never inflates Treatment Fidelity', async () => {
    const dir = await ranStudy('v09-inj-duplicate');
    const base = repDir(dir, 'EXM-V09-T1', 'B');
    fs.copyFileSync(path.join(base, 'injection-evidence-a1.json'), path.join(base, 'injection-evidence-a2.json'));
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner.injectionEvidence.duplicateAttemptSidecars).toBe(1);
    expect(report.examiner.injectionEvidence.treatmentChains).toBe(2);
    expect(report.examiner.treatmentFidelity.contextPresent).toBe(2);
    expect(report.examiner.treatmentFidelity.runtimeLoaded).toBe(2);
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_injection_duplicate_attempts' && f.severity === 'warning')).toBe(true);
    expect(report.status).not.toBe('REPORT_INVALID');
  });

  it('a missing evidence sidecar leaves the unit UNKNOWN (PARTIAL_UNKNOWN coverage), never "not injected"', async () => {
    const dir = await ranStudy('v09-inj-missing');
    fs.rmSync(path.join(repDir(dir, 'EXM-V09-T1', 'B'), 'injection-evidence-a1.json'));
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner.injectionEvidence.treatmentChains).toBe(1);
    expect(report.examiner.injectionEvidence.unresolvedTreatmentUnits).toBe(1);
    expect(report.examiner.treatmentFidelity.contextPresent).toBe(1);
    expect(report.examiner.treatmentFidelity.unresolvedTreatmentUnits).toBe(1);
    expect(report.examiner.treatmentFidelity.coverage.status).toBe('PARTIAL_UNKNOWN');
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_injection_evidence_missing' && f.severity === 'warning')).toBe(true);
    expect(report.status).not.toBe('REPORT_INVALID');
  });

  it('a treatment sidecar copied into the control directory is a critical binding mismatch', async () => {
    const dir = await ranStudy('v09-inj-crossarm');
    fs.copyFileSync(
      path.join(repDir(dir, 'EXM-V09-T1', 'B'), 'injection-evidence-a1.json'),
      path.join(repDir(dir, 'EXM-V09-T1', 'A'), 'injection-evidence-a1.json'),
    );
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_injection_binding_mismatch' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
  });

  it('a tampered attempt trace (receipt for a different prompt) invalidates the evidence attribution', async () => {
    const dir = await ranStudy('v09-inj-receipt');
    const attemptPath = path.join(repDir(dir, 'EXM-V09-T2', 'B'), 'a1.json');
    const attempt = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
    attempt.trace.runtimeReceipt.receivedPromptHash = 'f'.repeat(64);
    fs.writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_injection_binding_mismatch' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// P1-3 — cross-file preregistration binding + immutable anchor
// ---------------------------------------------------------------------------
describe('v0.9 §13.D preregistration binding and immutable anchor', () => {
  const readJson = (dir: string, rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
  const writeJson = (dir: string, rel: string, value: unknown) => fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);

  /** Recompute manifestHash + the two pointer records that carry it, so the
   *  rewrite is INTERNALLY consistent — only the anchor can catch it. */
  function repinManifest(dir: string, mutate: (manifest: any) => void) {
    const manifest = readJson(dir, 'examiner-manifest.json');
    mutate(manifest);
    const { manifestHash, ...core } = manifest;
    manifest.manifestHash = hashOfCanonical(core);
    writeJson(dir, 'examiner-manifest.json', manifest);
    const prereg = readJson(dir, 'preregistration.json');
    prereg.examiner.manifestHash = manifest.manifestHash;
    writeJson(dir, 'preregistration.json', prereg);
    const hashes = readJson(dir, 'hashes.json');
    hashes.examinerManifestHash.value = manifest.manifestHash;
    hashes.preregistrationHash.value = hashOfCanonical(prereg);
    writeJson(dir, 'hashes.json', hashes);
    return manifest;
  }

  it('a seed change regenerated with a 4-way consistent assignment is still refused by the anchor', () => {
    const parent = mkdtemp('v09-bind-seed');
    const dirA = path.join(parent, 'A');
    const dirB = path.join(parent, 'B');
    const a = writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dirA });
    const b = writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), seed: 'v09-seed-2', studyDir: dirB });
    expect(b.bindingHash).not.toBe(a.bindingHash);
    // pair-assignment hash + manifest.pairAssignmentHash/randomizationSeed +
    // preregistration.examiner.pairAssignmentHash + hashes.pairAssignmentHash
    for (const rel of ['pair-assignment.json', 'examiner-manifest.json', 'preregistration.json', 'hashes.json']) {
      fs.copyFileSync(path.join(dirB, rel), path.join(dirA, rel));
    }
    const computed = computeExaminerStudyBindings(dirA);
    expect(computed.problems).toEqual([]);
    expect(computed.bindingHash).toBe(b.bindingHash);
    const verified = verifyExaminerStudyBindings(dirA);
    expect(verified.ok).toBe(false);
    expect(verified.anchor).toBe('MISMATCH');
    expect(verified.problems.join(' ')).toContain('rewritten after the anchor');
    // and the report refuses to certify it
    const report = buildBehaviorReportV2(dirA, { now: NOW });
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_binding_drift' && f.severity === 'critical')).toBe(true);
  });

  it('a manifest rewritten with a recomputed manifestHash (scorer change) cannot move the anchor', () => {
    const dir = path.join(mkdtemp('v09-bind-manifest'), 'EXM-V09-M');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    repinManifest(dir, (manifest) => { manifest.scorerVersion = 'forged-scorer-v9'; });
    expect(computeExaminerStudyBindings(dir).problems).toEqual([]);
    const verified = verifyExaminerStudyBindings(dir);
    expect(verified.anchor).toBe('MISMATCH');
    expect(verified.ok).toBe(false);
  });

  it('a consistently rewritten primary endpoint is caught (the anchor pins the endpoint hash)', () => {
    const dir = path.join(mkdtemp('v09-bind-endpoint'), 'EXM-V09-E');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    const before = computeExaminerStudyBindings(dir);
    repinManifest(dir, (manifest) => { manifest.primaryEndpoint.id = 'principle_conformance_failure_rate'; });
    const after = computeExaminerStudyBindings(dir);
    expect(after.problems).toEqual([]);
    expect(after.binding.primaryEndpointHash).not.toBe(before.binding.primaryEndpointHash);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISMATCH');
  });

  it('HEPS + arm payloads + manifest rewritten together are internally consistent but cannot move the anchor', () => {
    const dir = path.join(mkdtemp('v09-bind-heps'), 'EXM-V09-H');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    const hepsInput = readJson(dir, 'heps-principles.json');
    const rewritten = hepsInput.principles.map((p: any) => (p.id === 'PD-P1' ? { ...p, text: 'A rewritten non-target principle statement.' } : p));
    writeJson(dir, 'heps-principles.json', { ...hepsInput, principles: rewritten });
    const heps = buildHostEffectivePrincipleSet({ principles: rewritten, targetPrincipleId: hepsInput.targetPrincipleId, host: hepsInput.host });
    const arms = buildDualModeArmPayloads({
      mode: 'full_library_incremental',
      heps,
      targetPrinciple: rewritten.find((p: any) => p.id === hepsInput.targetPrincipleId),
      principleFacts: rewritten,
      budgetChars: readJson(dir, 'examiner-arm-configs.json').budgetChars,
    });
    writeJson(dir, 'examiner-arm-configs.json', arms);
    repinManifest(dir, (manifest) => {
      manifest.principleSetSnapshotHash = heps.snapshotHash;
      manifest.armPayloadHashes = { control: arms.arms.control.payloadHash, treatment: arms.arms.treatment.payloadHash };
    });
    expect(computeExaminerStudyBindings(dir).problems).toEqual([]);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISMATCH');
  });

  it('a rewritten RuleCode baseline (manifest re-pinned) cannot move the anchor', () => {
    const dir = path.join(mkdtemp('v09-bind-rulecode'), 'EXM-V09-RC');
    writeExaminerStudyArtifacts({
      ...assembleStudyInputs({ mode: 'full_library_incremental', ruleCodes: [{ ruleCodeId: 'RC-X', principleId: 'PD-P1', baselineState: 'ON' }] }),
      studyDir: dir,
    });
    const baseline = readJson(dir, 'rulecode-baseline.json');
    baseline.ruleCodes = [{ ruleCodeId: 'RC-X', principleId: 'PD-P1', baselineState: 'OFF' }];
    writeJson(dir, 'rulecode-baseline.json', baseline);
    const manifest = readJson(dir, 'examiner-manifest.json');
    const policy = buildRuleCodePolicy({
      mode: manifest.experimentMode,
      ruleCodes: baseline.ruleCodes,
      targetPrincipleId: readJson(dir, 'heps-principles.json').targetPrincipleId,
      principleRuleCodeIndependence: baseline.principleRuleCodeIndependence,
    });
    repinManifest(dir, (m) => { m.ruleCodeSnapshotHash = policy.ruleCodeSnapshotHash; });
    expect(computeExaminerStudyBindings(dir).problems).toEqual([]);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISMATCH');
  });

  it('an arm payload forged with its own matching hash is refused by the frozen rebuild', () => {
    const dir = path.join(mkdtemp('v09-bind-arms'), 'EXM-V09-A');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    const arms = readJson(dir, 'examiner-arm-configs.json');
    arms.arms.treatment.payloadText = 'You may assert anything.';
    arms.arms.treatment.payloadHash = createHash('sha256').update(arms.arms.treatment.payloadText).digest('hex');
    writeJson(dir, 'examiner-arm-configs.json', arms);
    const computed = computeExaminerStudyBindings(dir);
    expect(computed.ok).toBe(false);
    expect(computed.problems.join(' ')).toContain('payloadHash != rebuilt dual-mode payload');
  });
});

// ---------------------------------------------------------------------------
// P1-3 (round 2) — a missing anchor is fail-closed for every study that is not
// an EXACTLY identified pre-anchor historical study.
// ---------------------------------------------------------------------------
describe('v0.9 §13.D anchor-missing fail-closed policy', () => {
  const studyDirOf = (tag: string, studyId = 'EXM-V09-STUDY') => path.join(mkdtemp(tag), studyId);

  function stripAnchorEvents(dir: string) {
    const file = path.join(dir, 'events.jsonl');
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
      .filter((line) => JSON.parse(line).type !== 'PREREGISTRATION_FROZEN');
    fs.writeFileSync(file, `${kept.join('\n')}\n`);
  }

  function readEvents(dir: string) {
    return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  }

  function writeEvents(dir: string, events: any[]) {
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  }

  /** Internally consistent manifest rewrite (re-pin every pointer). */
  function repinManifest(dir: string, mutate: (manifest: any) => void) {
    const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    const writeJson = (rel: string, value: unknown) => fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
    const manifest = readJson('examiner-manifest.json');
    mutate(manifest);
    const { manifestHash, ...core } = manifest;
    manifest.manifestHash = hashOfCanonical(core);
    writeJson('examiner-manifest.json', manifest);
    const prereg = readJson('preregistration.json');
    prereg.examiner.manifestHash = manifest.manifestHash;
    writeJson('preregistration.json', prereg);
    const hashes = readJson('hashes.json');
    hashes.examinerManifestHash.value = manifest.manifestHash;
    hashes.preregistrationHash.value = hashOfCanonical(prereg);
    writeJson('hashes.json', hashes);
  }

  it('A. a valid anchored study keeps binding + capacity + attributable fidelity', async () => {
    const dir = studyDirOf('v09-p13-anchored', 'EXM-V09-ANCHORED');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    await runExaminerStudy(dir);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner.preregistrationBinding).toEqual({
      bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      anchor: 'VERIFIED',
    });
    expect(report.examiner.capacity).toBeDefined();
    expect(report.examiner.treatmentFidelity.status).toBeUndefined();
    expect(report.examiner.treatmentFidelity.contextPresent).toBe(2);
    expect(report.examiner.treatmentFidelity.runtimeLoaded).toBe(2);
    expect(report.examiner.injectionEvidence.treatmentChains).toBe(2);
    expect(report.bindings.verified).toBe(true);
    expect(report.status).not.toBe('REPORT_INVALID');
  });

  it('B. deleting the anchor makes a new study UNTRUSTED: critical finding, INVALID, no legacy scan, no zero-disguised evidence', async () => {
    const dir = studyDirOf('v09-p13-missing', 'EXM-V09-NOANCHOR');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    await runExaminerStudy(dir);
    // The run produced real sidecars: if legacy scanning were used they would
    // be counted, so a null count proves the fallback did not happen.
    const sidecars: string[] = [];
    const walk = (p: string) => {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.startsWith('injection-evidence-')) sidecars.push(full);
      }
    };
    walk(path.join(dir, 'runs'));
    expect(sidecars.length).toBeGreaterThan(0);

    stripAnchorEvents(dir);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISSING');

    const report = buildBehaviorReportV2(dir, { now: NOW });
    const finding = report.integrity.findings.find((f: any) => f.id === 'examiner_preregistration_anchor_missing');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.bindings.verified).toBe(false);
    expect(report.examiner.preregistrationBinding).toBeUndefined();
    expect(report.examiner.capacity).toBeUndefined();
    // Unknown is reported as UNKNOWN, never as 0.
    expect(report.examiner.treatmentFidelity.status).toBe('UNKNOWN');
    expect(report.examiner.treatmentFidelity.contextPresent).toBeNull();
    expect(report.examiner.treatmentFidelity.evidencedChains).toBeNull();
    expect(report.examiner.treatmentFidelity.unresolvedTreatmentUnits).toBe(2);
    expect(report.examiner.treatmentFidelity.nonTargetRetention.eligible).toBeNull();
    expect(report.examiner.injectionEvidence.treatmentChains).toBeUndefined();
    expect(report.examiner.injectionEvidence.controlChains).toBeUndefined();
    // No legacy sidecar scan findings either.
    expect(report.integrity.findings.some((f: any) => String(f.id).startsWith('examiner_injection_'))).toBe(false);
    expect(renderBehaviorReportV2Markdown(report)).toContain('treatment fidelity: UNKNOWN');
  });

  it('C1. a tampered anchor bindingHash is a critical drift finding and never falls back to legacy', async () => {
    const dir = studyDirOf('v09-p13-anchor-hash', 'EXM-V09-AHASH');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const events = readEvents(dir);
    const anchor = events.find((e: any) => e.type === 'PREREGISTRATION_FROZEN');
    anchor.bindingHash = 'f'.repeat(64);
    writeEvents(dir, events);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISMATCH');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_binding_drift' && f.severity === 'critical')).toBe(true);
    expect(report.examiner.preregistrationBinding).toBeUndefined();
    expect(report.examiner.treatmentFidelity.status).toBe('UNKNOWN');
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.bindings.verified).toBe(false);
  });

  it('C2. a structurally broken anchor event is rejected', async () => {
    const dir = studyDirOf('v09-p13-anchor-structure', 'EXM-V09-ASTRUCT');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const events = readEvents(dir);
    const anchor = events.find((e: any) => e.type === 'PREREGISTRATION_FROZEN');
    delete anchor.binding;
    writeEvents(dir, events);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISMATCH');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_binding_drift' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
  });

  it('C3. a bound manifest modified after freezing is rejected (binding unreadable, INVALID)', async () => {
    const dir = studyDirOf('v09-p13-manifest-tamper', 'EXM-V09-MTAMPER');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const manifestPath = path.join(dir, 'examiner-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scorerVersion = 'forged-scorer-v9';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('NOT_CHECKED');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_binding_unreadable' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.examiner.preregistrationBinding).toBeUndefined();
    expect(report.examiner.treatmentFidelity.status).toBe('UNKNOWN');
  });

  it('C4. a modified preregistration hash pointer is rejected', async () => {
    const dir = studyDirOf('v09-p13-prereg-hash', 'EXM-V09-PHASH');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const hashesPath = path.join(dir, 'hashes.json');
    const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
    hashes.preregistrationHash.value = 'f'.repeat(64);
    fs.writeFileSync(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`);
    const verified = verifyExaminerStudyBindings(dir);
    expect(verified.ok).toBe(false);
    expect(verified.anchor).toBe('NOT_CHECKED');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.bindings.verified).toBe(false);
  });

  it('D. exactly identified pre-anchor historical studies keep the legacy path and their stored reports are untouched', () => {
    for (const studyId of ['EXM-V09-ACC-ISO', 'EXM-V09-ACC-FULL']) {
      const dir = path.join(labRoot, 'examiner-studies', studyId);
      const storedJson = fs.readFileSync(path.join(dir, 'behavior-report-v2.json'));
      const storedMd = fs.readFileSync(path.join(dir, 'behavior-report-v2.md'));
      const stored = JSON.parse(storedJson.toString('utf8'));
      const report = buildBehaviorReportV2(dir, { now: stored.generatedAt });
      // Recognised historical identity: no anchor-missing failure, and the
      // pre-anchor evidence path (not the UNKNOWN shape) is retained.
      expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_anchor_missing')).toBe(false);
      expect(report.examiner.preregistrationBinding).toBeUndefined();
      expect(report.examiner.treatmentFidelity.status).toBeUndefined();
      expect(typeof report.examiner.treatmentFidelity.contextPresent).toBe('number');
      expect(report.examiner.capacity).toBeUndefined();
      // Status and the finding set are unchanged from the pre-fix report.
      expect(report.status).toBe('REPORT_INVALID');
      expect(report.integrity.findings.map((f: any) => `${f.severity}:${f.id}`))
        .toEqual(['critical:denominator_unverifiable', 'critical:examiner_preregistration_binding_unreadable', 'critical:frozen_binding_drift']);
      // Deterministic recomputation; the stored historical report files are
      // never rewritten by report generation.
      const again = buildBehaviorReportV2(dir, { now: stored.generatedAt });
      expect(renderBehaviorReportV2Json(again)).toBe(renderBehaviorReportV2Json(report));
      expect(renderBehaviorReportV2Markdown(again)).toBe(renderBehaviorReportV2Markdown(report));
      expect(fs.readFileSync(path.join(dir, 'behavior-report-v2.json')).equals(storedJson)).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'behavior-report-v2.md')).equals(storedMd)).toBe(true);
    }
  });

  it('D2. a custom pre-anchor study with a current-contract binding must not be treated as historical', () => {
    const parent = mkdtemp('v09-p13-custom-legacy');
    const dir = path.join(parent, 'EXM-V09-CUSTOM');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    stripAnchorEvents(dir);
    // bindings recompute cleanly under the current implementation, but the
    // study is NOT in the exact historical identity table → fail closed.
    expect(computeExaminerStudyBindings(dir).ok).toBe(true);
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('MISSING');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_anchor_missing' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
  });

  it('E. a study that only looks historical (EXM-V09-ACC-* prefix) without an anchor is rejected', () => {
    const dir = studyDirOf('v09-p13-prefix-forge', 'EXM-V09-ACC-FORGED');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle', studyId: 'EXM-V09-ACC-FORGED' }), studyDir: dir });
    stripAnchorEvents(dir);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_preregistration_anchor_missing' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.bindings.verified).toBe(false);
  });

  it('E2. an unknown manifest version is fail-closed even with a consistent re-pin and an anchor', () => {
    const dir = studyDirOf('v09-p13-unknown-version', 'EXM-V09-VUNKNOWN');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    repinManifest(dir, (manifest) => { manifest.schema = 'examiner-study-manifest.v999'; });
    expect(verifyExaminerStudyBindings(dir).anchor).toBe('NOT_CHECKED');
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.bindings.verified).toBe(false);
    expect(report.examiner.preregistrationBinding).toBeUndefined();
    expect(report.examiner.treatmentFidelity.status).toBe('UNKNOWN');
  });

  it('F. the write gate never marks an unanchored study READY, and repeated writes cannot bypass it', async () => {
    const dir = studyDirOf('v09-p13-write-gate', 'EXM-V09-WGATE');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    stripAnchorEvents(dir);
    const first = writeBehaviorReportV2(dir, { now: NOW });
    expect(first.status).toBe('REPORT_INVALID');
    expect(first.eventAppended).toBe(false);
    const reportPath = path.join(dir, 'behavior-report-v2.json');
    const firstRaw = fs.readFileSync(reportPath, 'utf8');
    expect(JSON.parse(firstRaw).status).toBe('REPORT_INVALID');
    expect(readEvents(dir).some((e: any) => e.type === 'REPORT_READY_V2')).toBe(false);
    const second = writeBehaviorReportV2(dir, { now: NOW });
    expect(second.status).toBe('REPORT_INVALID');
    expect(second.eventAppended).toBe(false);
    expect(fs.readFileSync(reportPath, 'utf8')).toBe(firstRaw);
    expect(readEvents(dir).some((e: any) => e.type === 'REPORT_READY_V2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-3.1 — deleting the whole examiner-manifest.json must not be a cheaper
// bypass than deleting the anchor. A study that still carries v0.9 identity
// markers cannot be downgraded to a plain Report V2; a genuine pre-v0.9 study
// (no markers at all) keeps the original optional-block behaviour.
// ---------------------------------------------------------------------------
describe('v0.9 §13.D manifest deletion cannot downgrade an examiner study', () => {
  const eventsOf = (dir: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));

  it('deleting examiner-manifest.json keeps the block, raises a critical finding and REPORT_INVALID', async () => {
    const parent = mkdtemp('v09-p31-manifest-delete');
    const dir = path.join(parent, 'EXM-V09-NOMANIFEST');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    await runExaminerStudy(dir);
    fs.rmSync(path.join(dir, 'examiner-manifest.json'), { force: true });

    const report = buildBehaviorReportV2(dir, { now: NOW });
    const finding = report.integrity.findings.find((f: any) => f.id === 'examiner_manifest_missing');
    expect(finding).toBeDefined();
    expect(finding.severity).toBe('critical');
    expect(report.status).toBe('REPORT_INVALID');
    expect(report.bindings.verified).toBe(false);
    // The block is NOT silently dropped: it states why it cannot be computed.
    expect(report.examiner).toBeDefined();
    expect(report.examiner.error).toBe('examiner_manifest_missing');
    expect(report.examiner.preregistrationBinding).toBeUndefined();
    expect(report.examiner.capacity).toBeUndefined();
    // Unknown is reported as UNKNOWN, never as 0, and no legacy scan runs.
    expect(report.examiner.treatmentFidelity.status).toBe('UNKNOWN');
    expect(report.examiner.treatmentFidelity.contextPresent).toBeNull();
    expect(report.examiner.treatmentFidelity.unresolvedTreatmentUnits).toBe(2);
    expect(report.examiner.injectionEvidence.treatmentChains).toBeUndefined();
    expect(report.integrity.findings.some((f: any) => String(f.id).startsWith('examiner_injection_'))).toBe(false);
    expect(renderBehaviorReportV2Markdown(report)).toContain('treatment fidelity: UNKNOWN');

    // The write gate must refuse to mark it READY even when called twice.
    const first = writeBehaviorReportV2(dir, { now: NOW });
    expect(first.status).toBe('REPORT_INVALID');
    expect(first.eventAppended).toBe(false);
    const second = writeBehaviorReportV2(dir, { now: NOW });
    expect(second.status).toBe('REPORT_INVALID');
    expect(second.eventAppended).toBe(false);
    expect(eventsOf(dir).some((e: any) => e.type === 'REPORT_READY_V2')).toBe(false);
  });

  it('a study without any v0.9 identity marker keeps the original behaviour (no examiner block, no finding)', () => {
    const parent = mkdtemp('v09-p31-pre-v09');
    const dir = path.join(parent, 'CEB-LEGACY-SHAPE');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    for (const file of ['examiner-manifest.json', 'pair-assignment.json', 'examiner-arm-configs.json', 'heps-principles.json']) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
    const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    const writeJson = (rel: string, value: unknown) => fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
    const prereg = readJson('preregistration.json');
    delete prereg.examiner;
    writeJson('preregistration.json', prereg);
    const hashes = readJson('hashes.json');
    delete hashes.examinerManifestHash;
    hashes.preregistrationHash.value = hashOfCanonical(prereg);
    writeJson('hashes.json', hashes);

    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner).toBeUndefined();
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_manifest_missing')).toBe(false);
    expect(report.integrity.findings.some((f: any) => String(f.id).startsWith('examiner_'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-5 — RuleCode intervention identifiability (no default independence)
// ---------------------------------------------------------------------------
describe('v0.9 §2 RuleCode identifiability', () => {
  const TARGET_RC = [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'ON' }];

  it('baseline OFF + proven independence is principle_only and executable', () => {
    const policy = buildRuleCodePolicy({
      mode: 'isolated_principle',
      ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'OFF' }],
      targetPrincipleId: TARGET.id,
      principleRuleCodeIndependence: true,
    });
    expect(policy.interventionType).toBe('principle_only');
    expect(policy.identifiability).toBe('IDENTIFIABLE');
    expect(policy.executable).toBe(true);
  });

  it('baseline ON + proven independence is still principle_only (the baseline is preserved, not switched)', () => {
    const policy = buildRuleCodePolicy({
      mode: 'full_library_incremental', ruleCodes: TARGET_RC, targetPrincipleId: TARGET.id, principleRuleCodeIndependence: true,
    });
    expect(policy.interventionType).toBe('principle_only');
    expect(policy.executable).toBe(true);
    expect(policy.arms.treatment.targetRuleCode).toBe('BASELINE_ON');
  });

  it('baseline OFF/ON without independence is NOT identifiable and never assumed', () => {
    for (const baselineState of ['OFF', 'ON']) {
      const policy = buildRuleCodePolicy({
        mode: 'full_library_incremental',
        ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState }],
        targetPrincipleId: TARGET.id,
        principleRuleCodeIndependence: undefined,
      });
      expect(policy.executable).toBe(false);
      expect(policy.identifiability).toBe('INTERVENTION_NOT_IDENTIFIABLE');
      expect(policy.unresolvedEvidence).toContain('Principle/RuleCode independence');
    }
  });

  it('independence = false is NOT identifiable (a bundle the frozen arms cannot deliver is refused)', () => {
    const policy = buildRuleCodePolicy({
      mode: 'full_library_incremental', ruleCodes: TARGET_RC, targetPrincipleId: TARGET.id, principleRuleCodeIndependence: false,
    });
    expect(policy.executable).toBe(false);
    expect(policy.identifiability).toBe('INTERVENTION_NOT_IDENTIFIABLE');
    expect(policy.couplingReason).toContain('cannot be controlled independently');
  });

  it('unresolved target RuleCode evidence is UNKNOWN, not zero', () => {
    const policy = buildRuleCodePolicy({
      mode: 'full_library_incremental',
      ruleCodes: [{ ruleCodeId: 'RC-T', principleId: TARGET.id, baselineState: 'ON' }],
      targetPrincipleId: TARGET.id,
      principleRuleCodeIndependence: true,
      targetRuleCodeCount: 2,
    });
    expect(policy.executable).toBe(false);
    expect(policy.unresolvedEvidence).toContain('target RuleCode baseline state');
  });

  it('relabelling a coupled intervention as an executable bundle is refused (label != implementation)', () => {
    const policy = buildRuleCodePolicy({
      mode: 'full_library_incremental', ruleCodes: TARGET_RC, targetPrincipleId: TARGET.id, principleRuleCodeIndependence: true,
    });
    expect(policy.executable).toBe(true);
    const forgedCore = { ...policy, interventionType: 'bundled_intervention' };
    delete (forgedCore as any).ruleCodeSnapshotHash;
    const forged = { ...forgedCore, ruleCodeSnapshotHash: hashOfCanonical(forgedCore) };
    const check = verifyRuleCodePolicy(forged);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('relabelling the report is not implementing the bundle');
    // and the frozen arm configuration shows no coupled switch at all
    expect(policy.arms.control.targetRuleCode).toBe('BASELINE_ON');
    expect(policy.arms.treatment.targetRuleCode).toBe('BASELINE_ON');
  });

  it('a target smuggled into the non-target library fails the arm isolation audit', () => {
    const principles = [
      { id: 'PD-P1', version: 'v1', text: `not target — ${TARGET.text}`, status: 'active' },
      { id: TARGET.id, version: TARGET.version, text: TARGET.text, status: 'active' },
    ];
    const heps = buildHostEffectivePrincipleSet({ principles, targetPrincipleId: TARGET.id, host: 'offline-stub' });
    const arms = buildDualModeArmPayloads({ mode: 'full_library_incremental', heps, targetPrinciple: principles[1], principleFacts: principles, budgetChars: 4000 });
    expect(arms.isolationAudit.ok).toBe(false);
    expect(arms.isolationAudit.problems.join(' ')).toContain('control payload contains the target principle text');
  });

  it('study creation refuses an intervention that cannot be delivered', () => {
    const dir = path.join(mkdtemp('v09-rulecode-refusal'), 'EXM-V09-NI');
    const inputs = assembleStudyInputs({ mode: 'full_library_incremental', ruleCodes: TARGET_RC });
    // independence evidence truly absent (not defaulted to "true")
    inputs.ruleCodeFacts = { ruleCodes: TARGET_RC, principleRuleCodeIndependence: undefined };
    expect(() => writeExaminerStudyArtifacts({ ...inputs, studyDir: dir })).toThrow(/INTERVENTION_NOT_IDENTIFIABLE/);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-6 — capacity competition enters the report (three-state, never a fake 0)
// ---------------------------------------------------------------------------
describe('v0.9 §2.2.5 capacity competition in Report V2', () => {
  it('the library selection rule is honestly named and skip-and-continue is real', () => {
    expect(LIBRARY_SELECTION_RULE).toBe('skip_and_continue_v1');
    const out = renderLibraryPayload({
      orderedPrinciples: [
        { id: 'PD-P1', version: 'v1', text: 'x'.repeat(900) },
        { id: 'PD-P2', version: 'v1', text: 'small' },
      ],
      budgetChars: 200,
    });
    // the first candidate cannot fit, but the later small one still ships —
    // a prefix policy would have stopped here
    expect(out.evicted.map((p: any) => p.id)).toEqual(['PD-P1']);
    expect(out.delivered.map((p: any) => p.id)).toEqual(['PD-P2']);
  });

  it('isolated mode has no capacity competition (NOT_APPLICABLE, not 0)', async () => {
    const dir = path.join(mkdtemp('v09-cap-isolated'), 'EXM-V09-CAPI');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'isolated_principle' }), studyDir: dir });
    await runExaminerStudy(dir);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner.capacity.status).toBe('NOT_APPLICABLE');
  });

  it('a full-library study with room for everything records a REAL zero, not a missing value', async () => {
    const dir = path.join(mkdtemp('v09-cap-zero'), 'EXM-V09-CAP0');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    await runExaminerStudy(dir);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    const capacity = report.examiner.capacity;
    expect(capacity.status).toBe('RECORDED');
    expect(capacity.control.evictedIds).toEqual([]);
    expect(capacity.treatment.evictedIds).toEqual([]);
    expect(report.examiner.treatmentFidelity.capacityEvictions.units).toBe(0);
    expect(capacity.storedRecordAgrees).toBe(true);
  });

  it('tight budget: eligible/delivered/evicted/target/non-target retention are recomputed and reported', async () => {
    const longText = 'x'.repeat(500);
    const target = { id: 'PD-P0', version: 'v1', text: TARGET.text, status: 'active' };
    const principles = [
      target,
      { id: 'PD-P1', version: 'v1', text: longText, status: 'active' },
      { id: 'PD-P2', version: 'v1', text: longText, status: 'active' },
    ];
    const dir = path.join(mkdtemp('v09-cap-tight'), 'EXM-V09-CAP');
    writeExaminerStudyArtifacts({
      ...assembleStudyInputs({ mode: 'full_library_incremental' }),
      hepsPrinciples: { principles, targetPrincipleId: target.id, host: 'offline-stub' },
      principleFrozen: { contentJson: { principleDraft: { statement: target.text } } },
      budgetChars: 900,
      studyDir: dir,
    });
    await runExaminerStudy(dir);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    const capacity = report.examiner.capacity;
    expect(capacity.status).toBe('RECORDED');
    expect(capacity.budgetChars).toBe(900);
    expect(capacity.control.eligibleCount).toBe(2);
    expect(capacity.control.deliveredIds).toEqual(['PD-P1']);
    expect(capacity.control.evictedIds).toEqual(['PD-P2']);
    expect(capacity.treatment.eligibleCount).toBe(3);
    expect(capacity.treatment.deliveredIds).toEqual(['PD-P0', 'PD-P1']);
    expect(capacity.treatment.evictedIds).toEqual(['PD-P2']);
    expect(capacity.treatment.targetDelivered).toBe(true);
    expect(capacity.nonTargetRetention).toEqual({ eligible: 2, deliveredInControl: 1, deliveredInTreatment: 1 });
    expect(capacity.storedRecordAgrees).toBe(true);
    const fidelity = report.examiner.treatmentFidelity;
    expect(fidelity.capacityEvictions.units).toBe(2);
    expect(fidelity.capacityEvictions.details.map((e: any) => e.armId).sort()).toEqual(['A', 'B']);
    expect(fidelity.nonTargetRetention.treatmentRetentionRate).toBe(0.5);
    expect(report.status).not.toBe('REPORT_INVALID');
  });

  it('a tampered stored capacity record becomes a critical finding (the recomputation is the authority)', async () => {
    const dir = path.join(mkdtemp('v09-cap-drift'), 'EXM-V09-CAPD');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    await runExaminerStudy(dir);
    const armsPath = path.join(dir, 'examiner-arm-configs.json');
    const arms = JSON.parse(fs.readFileSync(armsPath, 'utf8'));
    // self-consistent edit (policy + matching recordHash) — only the frozen
    // rebuild can expose it
    const { recordHash: _ignoredHash, armId: _ignoredArm, ...core } = arms.capacity.control;
    core.policy = 'fifo_prefix_v1';
    arms.capacity.control = { ...core, armId: 'A', recordHash: hashOfCanonical(core) };
    fs.writeFileSync(armsPath, `${JSON.stringify(arms, null, 2)}\n`);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.examiner.capacity.status).toBe('RECORDED');
    expect(report.examiner.capacity.storedRecordAgrees).toBe(false);
    expect(report.integrity.findings.some((f: any) => f.id === 'examiner_capacity_record_drift' && f.severity === 'critical')).toBe(true);
    expect(report.status).toBe('REPORT_INVALID');
  });

  it('missing capacity data is never read as "zero evictions"', async () => {
    const dir = path.join(mkdtemp('v09-cap-missing'), 'EXM-V09-CAPX');
    writeExaminerStudyArtifacts({ ...assembleStudyInputs({ mode: 'full_library_incremental' }), studyDir: dir });
    await runExaminerStudy(dir);
    const armsPath = path.join(dir, 'examiner-arm-configs.json');
    const arms = JSON.parse(fs.readFileSync(armsPath, 'utf8'));
    delete arms.capacity;
    fs.writeFileSync(armsPath, `${JSON.stringify(arms, null, 2)}\n`);
    const report = buildBehaviorReportV2(dir, { now: NOW });
    expect(report.status).toBe('REPORT_INVALID');
    // either the binding gate or the capacity recomputation must flag it; a
    // numeric 0 eviction claim is never produced from missing data
    expect(report.integrity.findings.some((f: any) => f.severity === 'critical')).toBe(true);
    if (report.examiner.capacity) {
      expect(report.examiner.capacity.storedRecordAgrees).toBe(false);
    }
  });

  it('a target principle that does not fit the budget is refused, not silently evicted', () => {
    const principles = [
      { id: 'PD-P1', version: 'v1', text: 'x'.repeat(500), status: 'active' },
      { id: TARGET.id, version: TARGET.version, text: TARGET.text, status: 'active' },
    ];
    const heps = buildHostEffectivePrincipleSet({ principles, targetPrincipleId: TARGET.id, host: 'offline-stub' });
    expect(() => buildDualModeArmPayloads({
      mode: 'full_library_incremental', heps, targetPrinciple: principles[1], principleFacts: principles, budgetChars: 50,
    })).toThrow(/target principle does not fit the budget/);
  });

  it('a HEPS entry without resolvable text is refused rather than rendered as undefined', () => {
    const principles = [
      { id: 'PD-P1', version: 'v1', text: 'Library principle.', status: 'active' },
      { id: TARGET.id, version: TARGET.version, text: TARGET.text, status: 'active' },
    ];
    const heps = buildHostEffectivePrincipleSet({ principles, targetPrincipleId: TARGET.id, host: 'offline-stub' });
    expect(() => buildDualModeArmPayloads({
      mode: 'full_library_incremental', heps, targetPrinciple: principles[1], budgetChars: 4000,
    })).toThrow(/no frozen text for library principle 'PD-P1'/);
  });
});
