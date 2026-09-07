/**
 * PRI-703 / PRI-705 / PRI-700 — Evolution Alignment contract tests
 * (Owner decision 2026-09-07, task §8 test requirements).
 *
 * Covers the four required test classes:
 *   1. Intent Consistency — the intent contract flows scribe → prompt → rule
 *      artifact without mutation (same principle ⇒ same contract).
 *   2. Failure Attribution — partitionV2OutOfScopeFailures classifies
 *      rule-error / test-error / infra scenarios correctly (v2×v1 out-of-scope
 *      is the Episode-001 PRI-700 shape).
 *   3. Repair feedback circuit — priorValidatorErrors reaches the artificer
 *      prompt (PRI-700 factor B) and the case-id vocabulary note is present
 *      (factor C).
 *   4. Scribe contract validation — intentContract present-but-malformed is
 *      a hard rejection; absent stays valid (backward compatibility).
 */

import { describe, expect, it } from 'vitest';
import {
  extractIntentContract,
  isValidIntentContractV1,
  type IntentContractV1,
} from '../intent-contract.js';
import { DefaultScribeValidator } from '../scribe-output.js';
import {
  attributionFromLayer,
  isV2ContextCase,
  partitionV2OutOfScopeFailures,
  type FailureLayer,
} from '../rule-reliability-validation.js';
import { ArtificerPromptBuilder } from '../artificer-prompt-builder.js';
import {
  DefaultArtificerValidator,
} from '../artificer-output.js';
import { parseLastValidatorErrors, parsePITaskMetadata } from '../pitask-metadata.js';

const VALID_CONTRACT: IntentContractV1 = {
  ownerIntent: 'avoid the agent guessing configuration contracts from example files',
  targetBehavior: 'verify a config field has a real consumer before writing it',
  forbiddenBehavior: 'inferring field existence from example files or naming conventions',
  evidenceSource: 'pain manual_1788707211638 (invented config fields, 4th recurrence)',
  validationExpectation: 'absent consumer evidence must surface as an explicit risk',
};

function scribeOutputWithContract(overrides: Partial<IntentContractV1> = {}) {
  return {
    taskId: 'scribe-1',
    sourcePhilosopherArtifactId: 'pi-art-phil-1',
    principleDraft: {
      title: 'No config field without a verified consumer',
      statement: 'A config field must not be written unless a real consumer is verified.',
      rationale: 'Invented fields from example files caused repeated failures.',
      applicability: ['config', 'env', 'api payloads'],
      antiPatterns: ['copying fields from deploy.example.yml'],
      confidence: 0.86,
    },
    intentContract: { ...VALID_CONTRACT, ...overrides },
    sourceTrace: { philosopherArtifactId: 'pi-art-phil-1' },
    risks: [],
    generatedAt: '2026-09-07T00:00:00.000Z',
  };
}

describe('1. Intent Consistency — contract flows scribe → prompt → rule artifact unchanged', () => {
  it('extractIntentContract round-trips the validated contract verbatim (no field drift)', () => {
    const artifact = scribeOutputWithContract();
    const extracted = extractIntentContract(artifact);
    expect(extracted).not.toBeNull();
    expect(extracted).toEqual(artifact.intentContract);
  });

  it('the artificer prompt carries the exact contract the scribe produced (byte-identical intent anchor)', () => {
    const builder = new ArtificerPromptBuilder();
    const { promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'artificer-1',
      contextHash: 'hash-1',
      sourceScribeArtifactId: 'pi-art-scribe-1',
      scribeArtifact: scribeOutputWithContract(),
      intentContract: VALID_CONTRACT,
    });
    expect(promptInput.intentContract).toEqual(VALID_CONTRACT);
    const message = JSON.stringify(promptInput);
    expect(message).toContain('avoid the agent guessing configuration contracts');
    // The intent anchor block must instruct contract precedence over repair
    // instructions — the alignment rule itself is part of the contract.
    expect(promptInput.artificerInstruction).toContain('OWNER INTENT CONTRACT');
    expect(promptInput.artificerInstruction).toContain('intentContract wins');
  });

  it('pre-contract scribe artifacts produce prompts WITHOUT the contract key (backward compatible)', () => {
    const builder = new ArtificerPromptBuilder();
    const legacyArtifact = scribeOutputWithContract();
    delete (legacyArtifact as Record<string, unknown>).intentContract;
    const { promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'artificer-2',
      contextHash: 'hash-2',
      sourceScribeArtifactId: 'pi-art-scribe-2',
      scribeArtifact: legacyArtifact,
    });
    expect(promptInput).not.toHaveProperty('intentContract');
  });

  it('the scribe validator requires all five contract fields to be non-empty strings', async () => {
    const validator = new DefaultScribeValidator();
    // any single missing/empty field → hard rejection (a corrupted anchor is
    // worse than none)
    for (const field of Object.keys(VALID_CONTRACT) as (keyof IntentContractV1)[]) {
      const bad = scribeOutputWithContract({ [field]: '' });
      const result = await validator.validate(bad, 'scribe-1', 'pi-art-phil-1');
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toContain('intentContract');
    }
  });

  it('absent intentContract stays valid (pre-contract outputs pass unchanged)', async () => {
    const validator = new DefaultScribeValidator();
    const legacy = scribeOutputWithContract() as Record<string, unknown>;
    delete legacy.intentContract;
    const result = await validator.validate(legacy, 'scribe-1', 'pi-art-phil-1');
    expect(result.valid).toBe(true);
  });
});

describe('2. Failure Attribution — where/why/what-next classification', () => {
  it('pure v2-context failures judging a v1 rule are test-out-of-scope (FAILED_TEST), not rule defects', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined, // v1 action-only rule
      failedCaseIds: ['v2-unavailable', 'v2-truncated', 'v2-alias'],
    });
    expect(partition.isPureOutOfScope).toBe(true);
    expect(partition.outOfScope).toEqual(['v2-unavailable', 'v2-truncated', 'v2-alias']);
    expect(partition.inScope).toEqual([]);
    expect(attributionFromLayer('test')).toBe('FAILED_TEST');
  });

  it('the same v2 cases against a v2 rule are in scope (the channel CAN express them)', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: 2,
      failedCaseIds: ['v2-unavailable', 'v2-truncated', 'case-ordinary-1'],
    });
    expect(partition.isPureOutOfScope).toBe(false);
    expect(partition.outOfScope).toEqual([]);
    expect(partition.inScope).toEqual(['v2-unavailable', 'v2-truncated', 'case-ordinary-1']);
  });

  it('mixed failures on a v1 rule: ordinary cases stay in-scope (real rule defect)', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined,
      failedCaseIds: ['case-ordinary-1', 'v2-unavailable'],
    });
    expect(partition.isPureOutOfScope).toBe(false);
    expect(partition.inScope).toEqual(['case-ordinary-1']);
    expect(partition.outOfScope).toEqual(['v2-unavailable']);
  });

  it('isV2ContextCase matches only the v2- prefix', () => {
    expect(isV2ContextCase('v2-unavailable')).toBe(true);
    expect(isV2ContextCase('v2-combination')).toBe(true);
    expect(isV2ContextCase('negative-1')).toBe(false);
    expect(isV2ContextCase('adv-v2')).toBe(false);
  });

  it('attributionFromLayer maps the full stage-answer taxonomy onto one vocabulary', () => {
    const expected: Array<[FailureLayer, string]> = [
      ['principle', 'FAILED_PRINCIPLE'],
      ['rule', 'FAILED_RULE'],
      ['evaluation', 'FAILED_EVALUATION'],
      ['test', 'FAILED_TEST'],
      ['runtime', 'INFRA_BLOCKED'],
      ['adapter', 'UNKNOWN'],
      ['unknown', 'UNKNOWN'],
    ];
    for (const [layer, attribution] of expected) {
      expect(attributionFromLayer(layer)).toBe(attribution);
    }
  });
});

describe('3. Repair feedback circuit — PRI-700 factors B + C', () => {
  it('priorValidatorErrors reaches the serialized artificer prompt (the dead loop is broken)', () => {
    const builder = new ArtificerPromptBuilder();
    const { promptInput, message } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'artificer-repair-r1',
      contextHash: 'hash-r1',
      sourceScribeArtifactId: 'pi-art-scribe-1',
      scribeArtifact: scribeOutputWithContract(),
      repairFeedback: 'Previous attempt scored 0.7 (needs_revision).\nEvaluator concerns:\nRequired changes:\n1. handle unavailable context\nFix ALL the above.',
      priorValidatorErrors: {
        recordedAt: '2026-09-07T01:00:00.000Z',
        errorCategory: 'output_invalid',
        errors: [
          'goldenTraceCases[0].ruleContext is required when requiresContextVersion: 2 is declared',
          "expectedDecision 'propose_correction' is forbidden in v2 seed rules",
        ],
      },
    });
    expect(promptInput.priorValidatorErrors?.errors).toHaveLength(2);
    // The verbatim rejection reasons are IN the prompt the repair LLM sees —
    // attempt N+1 is no longer a zero-information retry.
    expect(message).toContain('expectedDecision \'propose_correction\' is forbidden');
    expect(promptInput.artificerInstruction).toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
  });

  it('the case-id vocabulary note is part of the prompt contract (factor C)', () => {
    const builder = new ArtificerPromptBuilder();
    const { promptInput } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'artificer-repair-r1',
      contextHash: 'hash-r1',
      sourceScribeArtifactId: 'pi-art-scribe-1',
      scribeArtifact: scribeOutputWithContract(),
      repairFeedback: 'Required changes:\n1. allow the evidence-availability boundary cases (v2-unavailable, v2-truncated, v2-alias)',
    });
    expect(promptInput.artificerInstruction).toContain('ADVERSARIAL CASE VOCABULARY NOTE');
    expect(promptInput.artificerInstruction).toContain('v2-*');
    expect(promptInput.artificerInstruction).toContain('NEVER respond to a case id by declaring');
  });

  it('parseLastValidatorErrors guards the trust boundary (malformed data → null, never a crash)', () => {
    expect(parseLastValidatorErrors(null)).toBeNull();
    expect(parseLastValidatorErrors('')).toBeNull();
    expect(parseLastValidatorErrors('not json')).toBeNull();
    expect(parseLastValidatorErrors('{"other":1}')).toBeNull();
    expect(parseLastValidatorErrors('{"lastValidatorErrors":{}}')).toBeNull();
    expect(parseLastValidatorErrors('{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":[]}}')).toBeNull();
    const valid = parseLastValidatorErrors(
      '{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":["e1"]}}',
    );
    expect(valid?.errors).toEqual(['e1']);
  });

  it('the artificer validator still rejects the forbidden v2 declarations that killed 18/18 attempts', async () => {
    // The gate that CORRECTLY rejected Episode-001 outputs must stay closed —
    // the fix feeds errors back, it does not weaken the contract.
    const validator = new DefaultArtificerValidator();
    const violatingOutput = {
      taskId: 'artificer-repair-r1',
      sourceScribeArtifactId: 'pi-art-scribe-1',
      implementationSummary: 'x',
      sourceTrace: { scribeArtifactId: 'pi-art-scribe-1' },
      risks: [],
      implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "r" }; }',
      goldenTraceCases: [
        { caseId: 'v2-unavailable', kind: 'negative', toolName: 'write_file', params: { path: '/w/f' }, expectedDecision: 'propose_correction', ruleContext: {} },
      ],
      affectedTools: ['write_file'],
      generatedAt: '2026-09-07T00:00:00.000Z',
      requiresContextVersion: 2,
    };
    const result = await validator.validate(violatingOutput, 'artificer-repair-r1', 'pi-art-scribe-1');
    expect(result.valid).toBe(false);
    const joined = result.errors.join(' ');
    expect(joined).toContain('propose_correction');
  });
});

describe('4. Scribe contract — trust boundary on the intent contract', () => {
  it('isValidIntentContractV1 accepts only the five non-empty string fields', () => {
    expect(isValidIntentContractV1(VALID_CONTRACT)).toBe(true);
    expect(isValidIntentContractV1({ ...VALID_CONTRACT, evidenceSource: '  ' })).toBe(false);
    expect(isValidIntentContractV1({ ...VALID_CONTRACT, extra: 'x' })).toBe(true); // additive keys tolerated
    expect(isValidIntentContractV1(null)).toBe(false);
    expect(isValidIntentContractV1('contract')).toBe(false);
  });
});

describe('2b. Failure Attribution — RepairPayload carries attribution context', () => {
  it('failureAttribution validates at the metadata trust boundary (malformed → whole metadata invalid)', () => {
    const baseMeta = {
      dependencyTaskIds: ['scribe-1'],
      channel: 'prompt',
      timeoutMs: 300000,
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      repairPayload: {
        requiredChanges: ['fix the ordinary case'],
        concerns: [],
        previousScore: 0.7,
        repairIteration: 1,
        sourceArtificerArtifactId: 'pi-art-art-1',
        sourceEvaluatorTaskId: 'evaluator-1',
      },
    };
    // Valid payload with attribution hydrates
    const valid = parsePITaskMetadata(JSON.stringify({
      pi_metadata: {
        ...baseMeta,
        repairPayload: {
          ...baseMeta.repairPayload,
          failureAttribution: {
            attribution: 'FAILED_RULE',
            outOfScopeCaseIds: ['v2-unavailable'],
            reason: 'mixed failures: ordinary in-scope case + channel-limitation v2 case',
          },
        },
      },
    }));
    expect(valid).not.toBeNull();
    expect(valid?.repairPayload?.failureAttribution?.attribution).toBe('FAILED_RULE');

    // Base payload without attribution still valid (backward compatible)
    const legacy = parsePITaskMetadata(JSON.stringify({ pi_metadata: baseMeta }));
    expect(legacy).not.toBeNull();
    expect(legacy?.repairPayload?.failureAttribution).toBeUndefined();

    // Malformed attribution invalidates the WHOLE metadata (rc-3 fail loud) —
    // a corrupted attribution must never silently steer the repair prompt
    const emptyAttribution = parsePITaskMetadata(JSON.stringify({
      pi_metadata: {
        ...baseMeta,
        repairPayload: {
          ...baseMeta.repairPayload,
          failureAttribution: { attribution: '', reason: 'x' },
        },
      },
    }));
    expect(emptyAttribution).toBeNull();

    const badCaseId = parsePITaskMetadata(JSON.stringify({
      pi_metadata: {
        ...baseMeta,
        repairPayload: {
          ...baseMeta.repairPayload,
          failureAttribution: { attribution: 'FAILED_TEST', reason: 'x', outOfScopeCaseIds: ['ok', 42] },
        },
      },
    }));
    expect(badCaseId).toBeNull();
  });
});
