import { describe, expect, it } from 'vitest';
import {
  verifyIsolationContract, EXPERIMENT_DESIGNS, ISOLATION_FROZEN_VARIABLES,
} from '../dev/principle-learning-lab/lib/challenge-isolation-contract.mjs';

// A fully valid principle-only contract: identical frozen variables with load
// evidence, empty control payload, clean actor inputs, independent
// session/workspace, randomized order with evidence, preregistered reps.
function validContract() {
  const frozen = {
    model: 'gpt-test-1', host: 'openclaw', memory: 'empty-v1', hook: 'none',
    tools: 'readonly-set', initialState: 'seed-42', budget: '20-units',
    provider: 'test-provider', systemPrompt: 'shared-prompt', plugin: 'none', commonContext: 'ctx-v1',
  };
  return {
    design: 'principleOnly',
    arms: {
      control: { ...frozen, targetPrinciple: 'OFF', targetRuleCode: 'OFF', sessionId: 'sess-A', workspaceId: 'ws-A' },
      treatment: { ...frozen, targetPrinciple: 'ON', targetRuleCode: 'OFF', sessionId: 'sess-B', workspaceId: 'ws-B' },
    },
    evidence: {
      model: { control: 'observed:gpt-test-1@round1', treatment: 'observed:gpt-test-1@round1' },
      host: { control: 'exec-state:openclaw-1', treatment: 'exec-state:openclaw-2' },
      memory: { control: 'snapshot:empty-v1', treatment: 'snapshot:empty-v1' },
      hook: { control: 'hook-log:none', treatment: 'hook-log:none' },
      tools: { control: 'perm-set:readonly', treatment: 'perm-set:readonly' },
      principleDelivery: { treatmentPrincipleHash: 'a'.repeat(64), controlPayloadText: '', normativeMarkers: ['必须在变更前运行每项检查'] },
      actorInputs: {
        control: '{"schema":"claim-evidence-actor-visible.v3","taskText":"check the config"}',
        treatment: '{"schema":"claim-evidence-actor-visible.v3","taskText":"check the config"}',
      },
    },
    execution: { orderStrategy: 'randomized', orderEvidence: 'seed-record:lcg-7', repetitionsPlanned: 2, preregistrationRef: 'preregistration.json#repetitions' },
  };
}

describe('EXAMINER v0.7 §4 isolation contract — definitions', () => {
  it('defines the three designs with the SPEC condition matrices', () => {
    expect(EXPERIMENT_DESIGNS.principleOnly.arms).toEqual({
      control: { targetPrinciple: 'OFF', targetRuleCode: 'OFF' },
      treatment: { targetPrinciple: 'ON', targetRuleCode: 'OFF' },
    });
    expect(EXPERIMENT_DESIGNS.ruleCodeOnly.arms.treatment).toEqual({ targetPrinciple: 'OFF', targetRuleCode: 'ON' });
    expect(Object.keys(EXPERIMENT_DESIGNS.factorial2x2.arms).sort()).toEqual(['P0R0', 'P0R1', 'P1R0', 'P1R1']);
    expect(EXPERIMENT_DESIGNS.factorial2x2.rule).toContain('out of scope');
  });
  it('freezes the full §4.5 variable list', () => {
    for (const variable of ['model', 'host', 'memory', 'hook', 'tools', 'initialState', 'budget', 'provider', 'systemPrompt', 'plugin', 'commonContext']) {
      expect(ISOLATION_FROZEN_VARIABLES).toContain(variable);
    }
  });
});

describe('EXAMINER v0.7 §4 isolation contract — accept path', () => {
  it('verifies a fully evidenced contract', () => {
    const result = verifyIsolationContract(validContract());
    expect(result.status).toBe('ISOLATION_VERIFIED');
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });
  it('is a pure pre-execution gate — repeated calls, no mutation of inputs', () => {
    const input = validContract();
    const first = verifyIsolationContract(input);
    const second = verifyIsolationContract(input);
    expect(second).toEqual(first);
  });
});

describe('EXAMINER v0.7 §4 isolation contract — fail-closed refusals', () => {
  const refuse = (mutate, fragment) => {
    const input = validContract();
    mutate(input);
    const result = verifyIsolationContract(input);
    expect(result.status).toBe('EXPERIMENT_INVALID');
    expect(result.problems.join('\n')).toContain(fragment);
    return result;
  };

  it('refuses Principle leakage into the control arm', () => {
    refuse((i) => { i.evidence.principleDelivery.controlPayloadText = '变更前必须运行每项检查。'; }, 'control arm must not carry the target Principle');
  });
  it('refuses normative-marker leakage through paraphrase', () => {
    refuse((i) => { i.evidence.principleDelivery.controlPayloadText = '注意：必须在变更前运行每项检查后才能继续。'; }, 'normative marker');
  });
  it('refuses Gold leakage into actor inputs', () => {
    refuse((i) => { i.evidence.actorInputs.treatment = '{"goldTruth":true}'; }, "leaks judge-side key 'goldTruth'");
  });
  it('refuses principlePredicates leakage into actor inputs', () => {
    refuse((i) => { i.evidence.actorInputs.control = '{"principlePredicates":[]}'; }, 'principlePredicates');
  });
  it('refuses A/B model mismatch', () => {
    refuse((i) => { i.arms.treatment.model = 'gpt-test-2'; }, "'model' differs across arms");
  });
  it('refuses missing model identity binding (evidence does not attest the declared model)', () => {
    refuse((i) => { i.evidence.model.treatment = 'observed:some-other-model@round1'; }, 'does not attest the declared model');
  });
  it('refuses unverifiable hook/memory load (declaration without load evidence)', () => {
    refuse((i) => { delete i.evidence.hook; }, 'no actual-load evidence for \'hook\'');
    refuse((i) => { i.evidence.memory.control = ''; }, 'no actual-load evidence for \'memory\'');
  });
  it('refuses tool permission mismatch', () => {
    refuse((i) => { i.arms.control.tools = 'readonly-set'; i.arms.treatment.tools = 'write-set'; }, "'tools' differs across arms");
  });
  it('refuses unprovable host (missing host load evidence)', () => {
    refuse((i) => { i.evidence.host.control = undefined; }, 'no actual-load evidence for \'host\'');
  });
  it('refuses shared session across arms', () => {
    refuse((i) => { i.arms.treatment.sessionId = 'sess-A'; }, 'sessionId');
  });
  it('refuses shared workspace across arms', () => {
    refuse((i) => { i.arms.treatment.workspaceId = 'ws-A'; }, 'workspaceId');
  });
  it('refuses budget condition mismatch', () => {
    refuse((i) => { i.arms.treatment.budget = '40-units'; }, "'budget' differs across arms");
  });
  it('refuses an undeclared frozen variable (confound cannot be verified)', () => {
    refuse((i) => { delete i.arms.treatment.memory; }, "'memory' missing on at least one arm");
  });
  it('refuses a wrong treatment matrix (RuleCode ON in a principle-only control)', () => {
    refuse((i) => { i.arms.treatment.targetRuleCode = 'ON'; }, 'targetRuleCode must be OFF');
  });
  it('refuses neither-randomized-nor-balanced execution order', () => {
    refuse((i) => { i.execution.orderStrategy = 'sequential-as-issued'; }, 'randomized');
  });
  it('refuses randomized order declared without evidence', () => {
    refuse((i) => { i.execution.orderEvidence = ''; }, 'without evidence');
  });
  it('refuses non-preregistered repetitions (post-hoc sampling)', () => {
    refuse((i) => { i.execution.repetitionsPlanned = 0; }, 'preregistered');
    refuse((i) => { i.execution.preregistrationRef = ''; }, 'preregistered');
  });
  it('refuses an arm outside the design', () => {
    refuse((i) => { i.arms.C = { ...i.arms.control }; }, 'does not belong to design');
  });
  it('throws on malformed input (unknown design / missing arms)', () => {
    expect(() => verifyIsolationContract({ design: 'teleportOnly', arms: {}, evidence: {}, execution: {} })).toThrow('unknown design');
    expect(() => verifyIsolationContract({ design: 'principleOnly', arms: { control: {} }, evidence: {}, execution: {} })).toThrow('arms.treatment');
  });
});
