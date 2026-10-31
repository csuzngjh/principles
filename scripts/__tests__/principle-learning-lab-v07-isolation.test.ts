import { describe, expect, it } from 'vitest';
import {
  verifyIsolationContract, collectOfflineStubLoadEvidence,
  EXPERIMENT_DESIGNS, ISOLATION_FROZEN_VARIABLES, HOST_PROBE_VARIABLES,
} from '../dev/principle-learning-lab/lib/challenge-isolation-contract.mjs';
import { hashOfCanonical } from '../dev/principle-learning-lab/lib/challenge-freeze.mjs';

const PRINCIPLE_HASH = 'b'.repeat(64);
const CONTEXT_HASH = 'c'.repeat(64);

const frozen = () => ({
  studyId: 'EXM-V07-STUDY', suiteHash: '1'.repeat(64), mappingHash: '2'.repeat(64),
  graderHash: '3'.repeat(64), principleContentHash: PRINCIPLE_HASH,
});

const armCheck = () => ({
  commonContextHash: CONTEXT_HASH,
  arms: {
    A: { delivery: { payloadText: '', payloadHash: null } },
    B: { delivery: { payloadText: '结论不得超越观察。', payloadHash: PRINCIPLE_HASH } },
  },
});

const executionOrder = () => ({ strategy: 'randomized', seed: 'lcg-7', order: ['T1/B/r1', 'T1/A/r1'] });

const declaredArms = () => {
  const shared = {
    model: 'gpt-test-1', host: 'openclaw', memory: 'empty-v1', hook: 'none',
    tools: 'readonly-set', initialState: 'seed-42', budget: '20-units',
    provider: 'test-provider', systemPrompt: 'shared-prompt', plugin: 'none', commonContext: 'ctx-v1',
  };
  return {
    control: { ...shared, targetPrinciple: 'OFF', targetRuleCode: 'OFF', sessionId: 'sess-A', workspaceId: 'ws-A' },
    treatment: { ...shared, targetPrinciple: 'ON', targetRuleCode: 'OFF', sessionId: 'sess-B', workspaceId: 'ws-B' },
  };
};

const validInput = () => ({
  design: 'principleOnly',
  arms: declaredArms(),
  actualLoad: collectOfflineStubLoadEvidence({ frozen: frozen(), armCheck: armCheck(), armBindings: { control: 'A', treatment: 'B' }, executionOrder: executionOrder() }),
  expectations: { principleHash: PRINCIPLE_HASH, commonContextHash: CONTEXT_HASH },
  execution: { orderStrategy: 'randomized', repetitionsPlanned: 2, preregistrationRef: 'preregistration.json#repetitions' },
  mode: 'offline-stub',
});

describe('EXAMINER v0.7 §4 isolation contract — definitions', () => {
  it('defines the three designs with the SPEC condition matrices', () => {
    expect(EXPERIMENT_DESIGNS.principleOnly.arms).toEqual({
      control: { targetPrinciple: 'OFF', targetRuleCode: 'OFF' },
      treatment: { targetPrinciple: 'ON', targetRuleCode: 'OFF' },
    });
    expect(EXPERIMENT_DESIGNS.ruleCodeOnly.arms.treatment).toEqual({ targetPrinciple: 'OFF', targetRuleCode: 'ON' });
    expect(Object.keys(EXPERIMENT_DESIGNS.factorial2x2.arms).sort()).toEqual(['P0R0', 'P0R1', 'P1R0', 'P1R1']);
  });
  it('freezes the full §4.5 variable list and the host-probe split', () => {
    for (const variable of ['model', 'host', 'memory', 'hook', 'tools', 'initialState', 'budget', 'provider', 'systemPrompt', 'plugin', 'commonContext']) {
      expect(ISOLATION_FROZEN_VARIABLES).toContain(variable);
    }
    for (const variable of ['model', 'systemPrompt', 'provider', 'plugin', 'tools', 'memory', 'hook', 'session', 'workspace']) {
      expect(HOST_PROBE_VARIABLES).toContain(variable);
    }
  });
});

describe('EXAMINER v0.7 §4 isolation contract — accept path (P1-1)', () => {
  it('verifies a fully evidenced offline contract with a SCOPED verdict', () => {
    const result = verifyIsolationContract(validInput());
    expect(result.status).toBe('ISOLATION_VERIFIED_OFFLINE_SCOPE');
    expect(result.problems).toEqual([]);
    // treatment/control load states are explicit
    expect(result.loadStates.treatment.principle).toBe('VERIFIED');
    expect(result.loadStates.control.principle).toBe('VERIFIED'); // verified as ABSENT
    expect(result.loadStates.control.ruleCode).toBe('VERIFIED');
    expect(result.loadStates.control.model).toBe('UNKNOWN'); // offline cannot observe — honest UNKNOWN
  });
  it('a real-host producer with full probe evidence reaches full ISOLATION_VERIFIED', () => {
    const input = validInput();
    input.mode = 'real-host';
    const core = {
      generatedBy: 'trusted-host-probe', studyId: 'EXM-V07-STUDY', suiteHash: '1'.repeat(64),
      mappingHash: '2'.repeat(64), graderHash: '3'.repeat(64), executionMode: 'F2-real-host',
      arms: {
        control: {
          resolvedPrincipleHash: null, resolvedPrincipleLoaded: false,
          actualRuleCodeState: 'OFF', actualRuleCodeStateBasis: 'HOST_PROBE', commonContextHash: CONTEXT_HASH,
          modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
          pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1',
          hookSetHash: 's'.repeat(64), sessionIdentity: 'host-sess-A', workspaceIdentity: 'host-ws-A',
        },
        treatment: {
          resolvedPrincipleHash: PRINCIPLE_HASH, resolvedPrincipleLoaded: true,
          actualRuleCodeState: 'OFF', actualRuleCodeStateBasis: 'HOST_PROBE', commonContextHash: CONTEXT_HASH,
          modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
          pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1',
          hookSetHash: 's'.repeat(64), sessionIdentity: 'host-sess-B', workspaceIdentity: 'host-ws-B',
        },
      },
      randomizationRecord: { strategy: 'randomized', seed: 'lcg-7', actualOrder: ['T1/B/r1', 'T1/A/r1'] },
    };
    input.actualLoad = { ...core, evidenceHash: hashOfCanonical(core) };
    input.expectations = {
      principleHash: PRINCIPLE_HASH, commonContextHash: CONTEXT_HASH,
      modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
      pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1', hookSetHash: 's'.repeat(64),
    };
    const result = verifyIsolationContract(input);
    expect(result.problems).toEqual([]);
    expect(result.status).toBe('ISOLATION_VERIFIED');
  });
  it('is a pure pre-execution gate — repeated calls, no mutation of inputs', () => {
    const input = validInput();
    const first = verifyIsolationContract(input);
    expect(verifyIsolationContract(input)).toEqual(first);
  });
  it('REGRESSION (red→green): a declaration-only input with no actual load evidence is refused — the pre-P1-1 gate accepted exactly this shape', () => {
    // Before the P1-1 repair, arms + non-empty per-arm evidence strings were
    // enough to reach ISOLATION_VERIFIED. The same declaration plane now
    // fails closed because no runner-produced load evidence exists.
    const input = validInput();
    delete input.actualLoad;
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain('no actual load evidence');
  });
});

describe('EXAMINER v0.7 §4 isolation contract — P1-1 fail-closed refusals', () => {
  const refuse = (mutate, fragment) => {
    const input = validInput();
    mutate(input);
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain(fragment);
    return result;
  };
  const rebuildEvidence = (input, mutateArms) => {
    const armCheckValue = armCheck();
    if (mutateArms) mutateArms(armCheckValue);
    input.actualLoad = collectOfflineStubLoadEvidence({ frozen: frozen(), armCheck: armCheckValue, armBindings: { control: 'A', treatment: 'B' }, executionOrder: executionOrder() });
    return input;
  };

  it('1. declared RuleCode OFF but actually loaded ON', () => {
    const input = validInput();
    input.actualLoad.arms.control.actualRuleCodeState = 'ON';
    input.actualLoad.evidenceHash = hashOfCanonical((({ evidenceHash: _h, ...core }) => core)(input.actualLoad));
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain("declared RuleCode OFF but the actually loaded state is 'ON'");
  });
  it('2. declared model A, loaded model B (real-host producer)', () => {
    const input = validInput();
    input.mode = 'real-host';
    const core = {
      generatedBy: 'trusted-host-probe', studyId: 'EXM-V07-STUDY', suiteHash: '1'.repeat(64),
      mappingHash: '2'.repeat(64), graderHash: '3'.repeat(64), executionMode: 'F2-real-host',
      arms: {
        control: {
          resolvedPrincipleHash: null, resolvedPrincipleLoaded: false, actualRuleCodeState: 'OFF',
          actualRuleCodeStateBasis: 'HOST_PROBE', commonContextHash: CONTEXT_HASH,
          modelIdentity: 'gpt-test-B@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
          pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1',
          hookSetHash: 's'.repeat(64), sessionIdentity: 'hs-A', workspaceIdentity: 'hw-A',
        },
        treatment: {
          resolvedPrincipleHash: PRINCIPLE_HASH, resolvedPrincipleLoaded: true, actualRuleCodeState: 'OFF',
          actualRuleCodeStateBasis: 'HOST_PROBE', commonContextHash: CONTEXT_HASH,
          modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
          pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1',
          hookSetHash: 's'.repeat(64), sessionIdentity: 'hs-B', workspaceIdentity: 'hw-B',
        },
      },
      randomizationRecord: { strategy: 'randomized', seed: 'lcg-7', actualOrder: ['T1/B/r1', 'T1/A/r1'] },
    };
    input.actualLoad = { ...core, evidenceHash: hashOfCanonical(core) };
    input.expectations = {
      principleHash: PRINCIPLE_HASH, commonContextHash: CONTEXT_HASH,
      modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
      pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1', hookSetHash: 's'.repeat(64),
    };
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain('does not match the frozen expectation');
  });
  it('3. identical sessionIdentity across arms (observed load state)', () => {
    const input = validInput();
    input.mode = 'real-host';
    const makeArm = (on: boolean, session: string) => ({
      resolvedPrincipleHash: on ? PRINCIPLE_HASH : null, resolvedPrincipleLoaded: on,
      actualRuleCodeState: 'OFF', actualRuleCodeStateBasis: 'HOST_PROBE', commonContextHash: CONTEXT_HASH,
      modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
      pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1',
      hookSetHash: 's'.repeat(64), sessionIdentity: session, workspaceIdentity: on ? 'hw-B' : 'hw-A',
    });
    const core = {
      generatedBy: 'trusted-host-probe', studyId: 'EXM-V07-STUDY', suiteHash: '1'.repeat(64),
      mappingHash: '2'.repeat(64), graderHash: '3'.repeat(64), executionMode: 'F2-real-host',
      arms: { control: makeArm(false, 'SAME-SESSION'), treatment: makeArm(true, 'SAME-SESSION') },
      randomizationRecord: { strategy: 'randomized', seed: 'lcg-7', actualOrder: ['T1/B/r1'] },
    };
    input.actualLoad = { ...core, evidenceHash: hashOfCanonical(core) };
    input.expectations = {
      principleHash: PRINCIPLE_HASH, commonContextHash: CONTEXT_HASH,
      modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
      pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1', hookSetHash: 's'.repeat(64),
    };
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain('sessionIdentity');
  });
  it('4a. commonContextHash drift from the frozen value refuses execution (the anti-drift reading of "shared context")', () => {
    refuse((i) => { i.expectations.commonContextHash = 'd'.repeat(64); }, 'does not re-bind to the frozen common context');
  });
  it('4b. cross-arm divergence of the loaded common context refuses execution', () => {
    const input = validInput();
    const load = input.actualLoad;
    load.arms.treatment.commonContextHash = 'e'.repeat(64);
    load.evidenceHash = hashOfCanonical((({ evidenceHash: _h, ...core }) => core)(load));
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain('does not re-bind to the frozen common context');
  });
  it('5. systemPromptHash drift (real-host producer)', () => {
    const input = validInput();
    input.mode = 'real-host';
    const makeArm = (on: boolean) => ({
      resolvedPrincipleHash: on ? PRINCIPLE_HASH : null, resolvedPrincipleLoaded: on,
      actualRuleCodeState: 'OFF', actualRuleCodeStateBasis: 'HOST_PROBE', commonContextHash: CONTEXT_HASH,
      modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'drifted'.padEnd(64, 'x'), providerIdentity: 'test-provider',
      pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1',
      hookSetHash: 's'.repeat(64), sessionIdentity: on ? 'hs-B' : 'hs-A', workspaceIdentity: on ? 'hw-B' : 'hw-A',
    });
    const core = {
      generatedBy: 'trusted-host-probe', studyId: 'EXM-V07-STUDY', suiteHash: '1'.repeat(64),
      mappingHash: '2'.repeat(64), graderHash: '3'.repeat(64), executionMode: 'F2-real-host',
      arms: { control: makeArm(false), treatment: makeArm(true) },
      randomizationRecord: { strategy: 'randomized', seed: 'lcg-7', actualOrder: ['T1/B/r1'] },
    };
    input.actualLoad = { ...core, evidenceHash: hashOfCanonical(core) };
    input.expectations = {
      principleHash: PRINCIPLE_HASH, commonContextHash: CONTEXT_HASH,
      modelIdentity: 'gpt-test-1@round1', systemPromptHash: 'p'.repeat(64), providerIdentity: 'test-provider',
      pluginSetHash: 'q'.repeat(64), toolsSetHash: 'r'.repeat(64), memoryIdentity: 'empty-v1', hookSetHash: 's'.repeat(64),
    };
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain('systemPromptHash');
  });
  it('6. missing actual load evidence (whole object and per-arm)', () => {
    refuse((i) => { delete i.actualLoad; }, 'no actual load evidence');
    refuse((i) => { i.actualLoad.arms = { control: i.actualLoad.arms.control }; }, 'no load evidence for arm treatment');
  });
  it('7. actor-forged / tampered evidence fails provenance or hash', () => {
    refuse((i) => { i.actualLoad.generatedBy = 'actor-self-report'; }, 'not a trusted producer');
    refuse((i) => {
      i.actualLoad.arms.control.resolvedPrincipleHash = 'f'.repeat(64);
      i.actualLoad.arms.control.resolvedPrincipleLoaded = true; // forged WITHOUT recomputing the hash
    }, 'hash mismatch');
  });
  it('8. randomization declared but never executed (no order record)', () => {
    refuse((i) => {
      const core = (({ evidenceHash: _h, randomizationRecord: _r, ...rest }) => rest)(i.actualLoad);
      i.actualLoad = { ...core, randomizationRecord: null, evidenceHash: hashOfCanonical(core) };
    }, 'no actual execution record');
    refuse((i) => {
      const core = (({ evidenceHash: _h, ...rest }) => rest)(i.actualLoad);
      core.randomizationRecord = { strategy: 'randomized', seed: '', actualOrder: [] };
      i.actualLoad = { ...core, evidenceHash: hashOfCanonical(core) };
    }, 'no actual execution record');
  });
  it('9a. principle leak into the control arm (OFF declared, payload loaded)', () => {
    refuse((i) => rebuildEvidence(i, (ac) => { ac.arms.A.delivery.payloadText = '结论不得超越观察。'; ac.arms.A.delivery.payloadHash = PRINCIPLE_HASH; }), 'Principle leak into the control arm');
  });
  it('9b. treatment arm missing its principle payload', () => {
    refuse((i) => rebuildEvidence(i, (ac) => { ac.arms.B.delivery.payloadText = ''; ac.arms.B.delivery.payloadHash = null; }), 'treatment was not verifiably injected');
  });
  it('declared-plane failures are still refused (model mismatch, frozen drift, shared declared ids)', () => {
    refuse((i) => { i.arms.treatment.model = 'gpt-test-2'; }, "'model' differs across arms");
    refuse((i) => { delete i.arms.treatment.memory; }, "'memory' missing on at least one arm");
    refuse((i) => { i.arms.treatment.sessionId = 'sess-A'; }, 'sessionId');
    refuse((i) => { i.arms.treatment.targetRuleCode = 'ON'; }, 'targetRuleCode must be OFF');
    refuse((i) => { i.execution.repetitionsPlanned = 0; }, 'preregistered');
    refuse((i) => { i.execution.orderStrategy = 'sequential'; }, 'randomized');
  });
  it('judge-side leak through actor inputs is refused when inputs are supplied', () => {
    const input = validInput();
    input.actorInputs = { control: '{"schema":"x"}', treatment: '{"goldTruth":true}' };
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain("leaks judge-side key 'goldTruth'");
  });
  it('real-host mode BLOCKS on missing probe evidence rather than accepting UNKNOWN', () => {
    const input = validInput();
    input.mode = 'real-host'; // offline-shaped evidence (host fields null) under a real declaration
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain('trusted host-probe proof is required');
  });
  it('throws on malformed input (unknown design / missing arms / bad mode)', () => {
    expect(() => verifyIsolationContract({ design: 'teleportOnly', arms: {}, actualLoad: null, expectations: {}, execution: {} } as any)).toThrow('unknown design');
    expect(() => verifyIsolationContract({ design: 'principleOnly', arms: { control: {} }, actualLoad: null, expectations: {}, execution: {} } as any)).toThrow('arms.treatment');
    expect(() => verifyIsolationContract({ ...validInput(), mode: 'quantum' } as any)).toThrow('mode');
  });
});
