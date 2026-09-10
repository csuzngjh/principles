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
  partitionV2OutOfScopeFailures,
  v2TemplateOracleExpectedDecision,
  resolveRequiresContextVersionFromArtifact,
  V2_TEMPLATE_CASE_IDS,
  type FailureLayer,
} from '../rule-reliability-validation.js';
import { generateV2ContextAdversarialCases } from '../v2-adversarial-cases.js';
import { ArtificerPromptBuilder } from '../artificer-prompt-builder.js';
import {
  DefaultArtificerValidator,
} from '../artificer-output.js';
import { parseLastValidatorErrors, isFreshForNextAttempt, parsePITaskMetadata } from '../pitask-metadata.js';

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
    const { promptInput, systemPrompt } = builder.buildPrompt({
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
    expect(systemPrompt).toContain('OWNER INTENT CONTRACT');
    expect(systemPrompt).toContain('intentContract wins');
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
  // Round-2 R1 (Owner 口径 b): 出界判定按「oracle 期望决策 + 逐 case 验证」，
  // 不按模板名单断言。expectedDecision 的分类真值 = 编译期模板 oracle
  // (generateV2ContextAdversarialCases 定义)；沙箱回带值仅作一致性比对
  // (防 caseId 冒名)，绝非判定来源。

  it('Case B: pure context-only allow-template failures against a v1 rule ARE out-of-scope (Episode-001 death loop breaker preserved)', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined, // v1 action-only rule
      failedCases: [
        { caseId: 'v2-unavailable', expectedDecision: 'allow' },
        { caseId: 'v2-truncated', expectedDecision: 'allow' },
        { caseId: 'v2-alias', expectedDecision: 'allow' },
      ],
    });
    expect(partition.isPureOutOfScope).toBe(true);
    expect(partition.outOfScope).toEqual(['v2-unavailable', 'v2-truncated', 'v2-alias']);
    expect(partition.inScope).toEqual([]);
    expect(attributionFromLayer('test')).toBe('FAILED_TEST');
  });

  it('Case A: a rule that violates an explicit block requirement MUST reach repair — block-expecting v2 templates are never out-of-scope', () => {
    // R1 复现回归：原则禁止写危险文件，规则输出 allow，v2-combination
    // (期望 block) 失败——必须进 Rule 修复，禁止被 NHR 豁免。
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined,
      failedCases: [{ caseId: 'v2-combination', expectedDecision: 'block' }],
    });
    expect(partition.isPureOutOfScope).toBe(false);
    expect(partition.outOfScope).toEqual([]);
    expect(partition.inScope).toEqual(['v2-combination']);
    // path-boundary 同理：期望 block 的模板 v1 完全可实现
    const boundaryPartition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined,
      failedCases: [
        { caseId: 'v2-path-boundary', expectedDecision: 'block' },
        { caseId: 'v2-unavailable', expectedDecision: 'allow' },
      ],
    });
    expect(boundaryPartition.isPureOutOfScope).toBe(false);
    expect(boundaryPartition.inScope).toEqual(['v2-path-boundary']);
    expect(boundaryPartition.outOfScope).toEqual(['v2-unavailable']);
  });

  it('Case C: expectedDecision missing or mismatched → fail-closed IN SCOPE (never exempts the rule)', () => {
    const missing = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined,
      failedCases: [
        { caseId: 'v2-unavailable' },
        { caseId: 'v2-alias', expectedDecision: 'block' }, // 冒名/不一致 → in-scope
      ],
    });
    expect(missing.isPureOutOfScope).toBe(false);
    expect(missing.outOfScope).toEqual([]);
    expect(missing.inScope).toEqual(['v2-unavailable', 'v2-alias']);
  });

  it('the same v2 cases against a v2 rule are in scope (the channel CAN express them)', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: 2,
      failedCases: [
        { caseId: 'v2-unavailable', expectedDecision: 'allow' },
        { caseId: 'v2-truncated', expectedDecision: 'allow' },
        { caseId: 'case-ordinary-1', expectedDecision: 'block' },
      ],
    });
    expect(partition.isPureOutOfScope).toBe(false);
    expect(partition.outOfScope).toEqual([]);
    expect(partition.inScope).toEqual(['v2-unavailable', 'v2-truncated', 'case-ordinary-1']);
  });

  it('mixed failures on a v1 rule: ordinary cases stay in-scope (real rule defect)', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined,
      failedCases: [
        { caseId: 'case-ordinary-1', expectedDecision: 'block' },
        { caseId: 'v2-unavailable', expectedDecision: 'allow' },
      ],
    });
    expect(partition.isPureOutOfScope).toBe(false);
    expect(partition.inScope).toEqual(['case-ordinary-1']);
    expect(partition.outOfScope).toEqual(['v2-unavailable']);
  });

  it('a v1 rule failing ONLY on custom v2-* ids stays IN SCOPE (no false test-out-of-scope routing)', () => {
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: undefined,
      failedCases: [
        { caseId: 'v2-business-boundary', expectedDecision: 'block' },
        { caseId: 'v2-custom-2', expectedDecision: 'allow' },
      ],
    });
    expect(partition.isPureOutOfScope).toBe(false);
    expect(partition.inScope).toEqual(['v2-business-boundary', 'v2-custom-2']);
    expect(partition.outOfScope).toEqual([]);
  });

  it('v2TemplateOracleExpectedDecision reflects the compile-time template definitions (block templates are never context-only)', () => {
    expect(v2TemplateOracleExpectedDecision('v2-unavailable')).toBe('allow');
    expect(v2TemplateOracleExpectedDecision('v2-truncated')).toBe('allow');
    expect(v2TemplateOracleExpectedDecision('v2-alias')).toBe('allow');
    expect(v2TemplateOracleExpectedDecision('v2-path-boundary')).toBe('block');
    expect(v2TemplateOracleExpectedDecision('v2-combination')).toBe('block');
    expect(v2TemplateOracleExpectedDecision('v2-business-boundary')).toBeNull();
    expect(v2TemplateOracleExpectedDecision('negative-1')).toBeNull();
  });

  it('attributionFromLayer maps the full stage-answer taxonomy onto one vocabulary', () => {
    const expected: [FailureLayer, string][] = [
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

  it('resolveRequiresContextVersionFromArtifact distinguishes v1 (key-absent) from unresolvable — the out-of-scope wiring regression', () => {
    // 评审 P1 回归：key-absent on a PARSED artifact is deterministically v1
    // (artificer schema only ever writes literal 2)。此前 runner 把它折叠成
    // null，导致 partition 在生产中永远不运行——出界路由的全部目标人群
    // (v1 规则) 被接线断点排除。
    expect(resolveRequiresContextVersionFromArtifact('{"title":"t","statement":"s"}')).toBeUndefined();
    expect(resolveRequiresContextVersionFromArtifact('{"requiresContextVersion":2}')).toBe(2);
    // unresolvable (fail-open) cases must stay null, never v1:
    expect(resolveRequiresContextVersionFromArtifact(null)).toBeNull();
    expect(resolveRequiresContextVersionFromArtifact(undefined)).toBeNull();
    expect(resolveRequiresContextVersionFromArtifact('')).toBeNull();
    expect(resolveRequiresContextVersionFromArtifact('not json')).toBeNull();
    expect(resolveRequiresContextVersionFromArtifact('[1,2]')).toBeNull();
    expect(resolveRequiresContextVersionFromArtifact('{"requiresContextVersion":"2"}')).toBeNull();
  });

  it('WIRING: a resolved v1 artifact whose replay failures are all oracle-verified allow templates routes pure out-of-scope', () => {
    const v1ArtifactContentJson = '{"taskId":"a","ruleCode":"...","statement":"s"}';
    const resolved = resolveRequiresContextVersionFromArtifact(v1ArtifactContentJson);
    expect(resolved).toBeUndefined();
    const partition = partitionV2OutOfScopeFailures({
      requiresContextVersion: resolved === 2 ? 2 : undefined,
      failedCases: [
        { caseId: 'v2-unavailable', expectedDecision: 'allow' },
        { caseId: 'v2-alias', expectedDecision: 'allow' },
      ],
    });
    expect(partition.isPureOutOfScope).toBe(true);
    expect(partition.outOfScope).toEqual(['v2-unavailable', 'v2-alias']);
    expect(partition.inScope).toEqual([]);
  });

  it('V2_TEMPLATE_CASE_IDS stays equivalent to the generator output (drift would silently re-open the death loop)', () => {
    const generated = generateV2ContextAdversarialCases({
      toolName: 'write_file',
      targetPath: '/workspace/report.md',
      canonicalKind: 'write',
    });
    const generatedIds = new Set(generated.map((c) => c.caseId));
    expect(generatedIds.size).toBe(5);
    expect([...generatedIds].sort()).toEqual([...V2_TEMPLATE_CASE_IDS].sort());
    // Round-2 R1: the oracle-expected decision per generated template must
    // match the partition's oracle map — generator drift in expectations is
    // caught here, not silently in production routing.
    for (const c of generated) {
      const oracle = v2TemplateOracleExpectedDecision(c.caseId);
      expect(oracle).not.toBeNull();
      expect(oracle).toBe(c.expectedDecision);
    }
  });
});

describe('3. Repair feedback circuit — PRI-700 factors B + C', () => {
  it('priorValidatorErrors reaches the serialized artificer prompt (the dead loop is broken)', () => {
    const builder = new ArtificerPromptBuilder();
    const { promptInput, message, systemPrompt } = builder.buildPrompt({
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
        // 评审修正: prompt fixture 是"本 attempt 将回喂上一轮"的形态——
        // base runner 泄漏面按 attempt-1 新鲜度判定
        sourceAttemptCount: 1,
      },
    });
    expect(promptInput.priorValidatorErrors?.errors).toHaveLength(2);
    // The verbatim rejection reasons are IN the prompt the repair LLM sees —
    // attempt N+1 is no longer a zero-information retry.
    expect(message).toContain('expectedDecision \'propose_correction\' is forbidden');
    expect(systemPrompt).toContain('PRIOR OUTPUT-CONTRACT REJECTIONS');
  });

  it('the case-id vocabulary note is part of the prompt contract (factor C)', () => {
    const builder = new ArtificerPromptBuilder();
    const { systemPrompt } = builder.buildPrompt({
      contextMode: 'v1',
      taskId: 'artificer-repair-r1',
      contextHash: 'hash-r1',
      sourceScribeArtifactId: 'pi-art-scribe-1',
      scribeArtifact: scribeOutputWithContract(),
      repairFeedback: 'Required changes:\n1. allow the evidence-availability boundary cases (v2-unavailable, v2-truncated, v2-alias)',
    });
    expect(systemPrompt).toContain('ADVERSARIAL CASE VOCABULARY NOTE');
    expect(systemPrompt).toContain('v2-*');
    expect(systemPrompt).toContain('NEVER respond to a case id by declaring');
  });

  it('parseLastValidatorErrors guards the trust boundary (malformed data → null, never a crash)', () => {
    expect(parseLastValidatorErrors(null)).toBeNull();
    expect(parseLastValidatorErrors('')).toBeNull();
    expect(parseLastValidatorErrors('not json')).toBeNull();
    expect(parseLastValidatorErrors('{"other":1}')).toBeNull();
    expect(parseLastValidatorErrors('{"lastValidatorErrors":{}}')).toBeNull();
    expect(parseLastValidatorErrors('{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":[]}}')).toBeNull();
    // legacy shape without sourceAttemptCount → null (宁可少回喂一次，不回喂
    // 来源不明的旧错误 — 评审 P1)
    expect(parseLastValidatorErrors('{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":["e1"]}}')).toBeNull();
    expect(parseLastValidatorErrors('{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":["e1"],"sourceAttemptCount":-1}}')).toBeNull();
    const valid = parseLastValidatorErrors(
      '{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":["e1"],"sourceAttemptCount":3}}',
    );
    expect(valid?.errors).toEqual(['e1']);
    expect(valid?.sourceAttemptCount).toBe(3);
  });

  it('parseLastValidatorErrors bounds the re-fed error payload (rc-8: echoed LLM output must not overflow the prompt budget)', () => {
    const longError = 'x'.repeat(1200);
    const parsed = parseLastValidatorErrors(
      `{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":["${longError}"],"sourceAttemptCount":2}}`,
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.errors[0]?.length).toBeLessThanOrEqual(500 + '…[truncated]'.length);
    expect(parsed?.errors[0]).toContain('…[truncated]');
    // >10 errors: first 10 kept, remainder collapsed into a visible marker
    const many = Array.from({ length: 15 }, (_, i) => `e${i}`);
    const capped = parseLastValidatorErrors(
      `{"lastValidatorErrors":{"recordedAt":"t","errorCategory":"output_invalid","errors":${JSON.stringify(many)},"sourceAttemptCount":2}}`,
    );
    expect(capped?.errors).toHaveLength(11);
    expect(capped?.errors[9]).toBe('e9');
    expect(capped?.errors[10]).toBe('[+5 more validation error(s) omitted for prompt budget]');
  });

  it('isFreshForNextAttempt: only the immediately-preceding attempt\'s record is re-fed (rc-7, restart-safe)', () => {
    const record = { recordedAt: 't', errorCategory: 'output_invalid', errors: ['e1'], sourceAttemptCount: 2 };
    // fresh: attempt 3 follows the failed attempt 2
    expect(isFreshForNextAttempt(record, 3)).toBe(true);
    // stale: attempt 4 after a runtime-error attempt 3 did not clear the record
    expect(isFreshForNextAttempt(record, 4)).toBe(false);
    // no lease context (non-leased invocation) → suppress, never guess
    expect(isFreshForNextAttempt(record, undefined)).toBe(false);
    // same attempt re-reading its own just-written record (source === current)
    expect(isFreshForNextAttempt(record, 2)).toBe(false);
  });

  it('extractIntentContract returns null on the FOCUSED (flattened) manifest shape — documents why capture-before-narrowing is load-bearing', () => {
    // The focused manifest resolves scribeArtifactInput to resolved.fields —
    // flat summary strings with no root intentContract object. Extraction
    // must yield null there; artificer-runner therefore captures the FULL
    // artifact before resolveContextInjectionAsync (评审 P1 wiring fix).
    const flattenedSummaryShape = {
      summary: '…',
      intentOwner: 'avoid guessing config contracts',
      intentForbidden: 'inferring field existence from examples',
      intentValidation: 'absent consumer evidence surfaces as risk',
    };
    expect(extractIntentContract(flattenedSummaryShape)).toBeNull();
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
