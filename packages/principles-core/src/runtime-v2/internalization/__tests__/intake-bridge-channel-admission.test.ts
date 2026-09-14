/**
 * PRI-720 C6 — code 渠道准入纪律的确定性判据（AC10）。
 *
 * rule 推荐只有在自带完整机械触发证据（triggerPattern + 可观察 action 声明）
 * 时才允许进入 code_tool_hook 渠道；声明不全的认知型行为原则降级为 prompt
 * 渠道。判定是纯字段检查——绝不引入 LLM 现场判断。
 */
import { describe, it, expect } from 'vitest';
import {
  computeBridgeDecision,
  hasRuleMechanicalEvidence,
  buildDreamerSeedFromCandidate,
  type IntakeToInternalizationBridgeInput,
} from '../intake-to-internalization-bridge.js';
import type { CandidateRecord } from '../../store/candidate/candidate-store.js';

function bridgeInput(overrides: Partial<IntakeToInternalizationBridgeInput> = {}): IntakeToInternalizationBridgeInput {
  return {
    candidateId: 'cand-c6-1',
    recommendationKind: 'rule',
    route: 'rule-candidate',
    ready: true,
    ...overrides,
  };
}

function candidate(sourceRecommendationJson: string): CandidateRecord {
  return {
    candidateId: 'cand-c6-candidate',
    artifactId: 'art-c6',
    taskId: 'diag-c6',
    sourceRunId: 'run-c6',
    title: 't',
    description: 'd',
    confidence: 0.9,
    sourceRecommendationJson,
    recommendationKind: 'rule',
    status: 'pending',
    createdAt: '2026-09-15T00:00:00.000Z',
  };
}

describe('hasRuleMechanicalEvidence — 确定性字段检查 (rc-1/rc-3)', () => {
  it('triggerPattern + action 齐全 → true', () => {
    expect(hasRuleMechanicalEvidence({ triggerPattern: 'edit .pd/**', action: 'block' })).toBe(true);
  });

  it('缺失/空白/非字符串/非对象 → false', () => {
    expect(hasRuleMechanicalEvidence({ triggerPattern: 'edit .pd/**' })).toBe(false);
    expect(hasRuleMechanicalEvidence({ action: 'block' })).toBe(false);
    expect(hasRuleMechanicalEvidence({ triggerPattern: '   ', action: 'block' })).toBe(false);
    expect(hasRuleMechanicalEvidence({ triggerPattern: 1, action: 'block' })).toBe(false);
    expect(hasRuleMechanicalEvidence('not an object')).toBe(false);
    expect(hasRuleMechanicalEvidence(undefined)).toBe(false);
  });
});

describe('computeBridgeDecision — rule 渠道准入 (AC10)', () => {
  it('机械证据齐全 → code_tool_hook 渠道原样', () => {
    const decision = computeBridgeDecision(bridgeInput({
      recommendation: { triggerPattern: 'edit .pd/**', action: 'block' },
    }));
    expect(decision.decision === 'seeded' && decision.channel === 'code_tool_hook').toBe(true);
    expect(decision.decision === 'seeded' && decision.demotedFromChannel === undefined).toBe(true);
    expect(decision.decision === 'seeded' && decision.taskId.endsWith('-code_tool_hook')).toBe(true);
  });

  it('证据缺失 → 降级 prompt 渠道（demotedFromChannel 可观测）', () => {
    const decision = computeBridgeDecision(bridgeInput({
      recommendation: { triggerPattern: 'edit .pd/**' },
    }));
    expect(decision.decision === 'seeded' && decision.channel === 'prompt').toBe(true);
    expect(decision.decision === 'seeded' && decision.demotedFromChannel === 'code_tool_hook').toBe(true);
    expect(decision.decision === 'seeded' && decision.taskId.endsWith('-prompt')).toBe(true);
  });

  it('未提供 recommendation（legacy 调用方）→ 降级 prompt（保守默认）', () => {
    const decision = computeBridgeDecision(bridgeInput());
    expect(decision.decision === 'seeded' && decision.channel === 'prompt').toBe(true);
  });
});

describe('buildDreamerSeedFromCandidate — C6 集成', () => {
  it('解析 sourceRecommendationJson 并降级证据不全的 rule 候选', () => {
    const seed = buildDreamerSeedFromCandidate(
      candidate(JSON.stringify({ kind: 'rule', title: '先调查再修改', description: '认知型行为原则' })),
      { route: 'rule-candidate', ready: true },
    );
    if (!('decision' in seed)) {
      expect(seed.channel).toBe('prompt');
      expect(seed.demotedFromChannel).toBe('code_tool_hook');
      expect(seed.taskId.endsWith('-prompt')).toBe(true);
    } else {
      throw new Error(`expected seeded, got ${JSON.stringify(seed)}`);
    }
  });

  it('证据齐全的 rule 候选保留 code_tool_hook 渠道', () => {
    const seed = buildDreamerSeedFromCandidate(
      candidate(JSON.stringify({ kind: 'rule', triggerPattern: 'edit .pd/**', action: 'block' })),
      { route: 'rule-candidate', ready: true },
    );
    if (!('decision' in seed)) {
      expect(seed.channel).toBe('code_tool_hook');
      expect(seed.demotedFromChannel).toBeUndefined();
    } else {
      throw new Error(`expected seeded, got ${JSON.stringify(seed)}`);
    }
  });

  it('不可解析的 recommendation JSON 视为无证据（降级，不抛异常）', () => {
    const seed = buildDreamerSeedFromCandidate(
      candidate('{not valid json'),
      { route: 'rule-candidate', ready: true },
    );
    if (!('decision' in seed)) {
      expect(seed.channel).toBe('prompt');
    } else {
      throw new Error(`expected seeded, got ${JSON.stringify(seed)}`);
    }
  });
});
