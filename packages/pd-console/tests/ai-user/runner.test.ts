/**
 * PRI-754 — Runner 循环边界辅助逻辑的单元测试。
 * isInfraFailure：LLM 零决策不可用 = 基础设施故障（退出码 1）的唯一判定，
 * 区别于「已产生决策后的中途失败」（有效 QA 观察，退出码 0）。
 */
import { describe, expect, it } from 'vitest';
import { isInfraFailure, type ScenarioRunResult } from './runner.js';
import { parseScenario } from './scenario.js';

const scenario = parseScenario({
  id: 'infra',
  persona: '测试用户',
  goal: '完成目标',
  success: ['条件'],
});

function runWith(overrides: Partial<ScenarioRunResult>): ScenarioRunResult {
  return {
    scenario,
    result: 'incomplete',
    finishReason: 'llm-error',
    problems: [],
    suggestions: [],
    steps: [],
    effectiveMaxSteps: 10,
    initialScreenshot: null,
    startedAt: '2026-09-12T00:00:00.000Z',
    finishedAt: '2026-09-12T00:01:00.000Z',
    model: 'test-model',
    baseUrlOrigin: 'http://127.0.0.1:3101',
    ...overrides,
  };
}

describe('isInfraFailure', () => {
  it('llm-error 且零决策 → 基础设施故障', () => {
    expect(isInfraFailure(runWith({}))).toBe(true);
  });

  it('llm-error 但已有决策 → 有效 QA 观察，非基础设施故障', () => {
    expect(
      isInfraFailure(
        runWith({
          steps: [
            {
              index: 1,
              thought: 't',
              action: { type: 'click', target: 'text=x' },
              execution: { ok: true },
              observation: { url: 'http://x/', title: '' },
              screenshot: null,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it.each(['max-steps-reached', 'user-finished-success', 'user-finished-failed'])(
    'finishReason=%s 非基础设施故障',
    finishReason => {
      expect(isInfraFailure(runWith({ finishReason }))).toBe(false);
    },
  );

  it('passed/failed 结果非基础设施故障', () => {
    expect(isInfraFailure(runWith({ result: 'passed', finishReason: 'user-finished-success' }))).toBe(false);
    expect(isInfraFailure(runWith({ result: 'failed', finishReason: 'user-finished-failed' }))).toBe(false);
  });
});
