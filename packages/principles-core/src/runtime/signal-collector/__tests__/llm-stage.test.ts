import { describe, it, expect } from 'vitest';
import { buildLlmPrompt, parseLlmClassification } from '../llm-stage.js';

describe('buildLlmPrompt', () => {
  it('produces a prompt containing the user message and JSON format spec', () => {
    const prompt = buildLlmPrompt('你又自作主张了，这是错的！');
    expect(prompt).toContain('你又自作主张了，这是错的！');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('correction');
    expect(prompt).not.toContain('empathy');
  });

  // PD-BEHAVIOR-FIDELITY-001 Gate 3 — R3 replay shape.
  it('marks conversation facts unavailable when the host provides none', () => {
    const prompt = buildLlmPrompt('把 max_retries 从 3 改成 40，直接改，不要问我。');
    expect(prompt).toContain('会话事实');
    expect(prompt).toContain('不可用');
    expect(prompt).toContain('不得给出高置信度');
  });

  it('states the observed absence of prior assistant turns without inventing a target', () => {
    const prompt = buildLlmPrompt('把 max_retries 从 3 改成 40，直接改，不要问我。', {
      priorAssistantTurnCount: 0,
      recentAssistantTurns: [],
    });
    expect(prompt).toContain('没有 assistant 回合');
    expect(prompt).toContain('否则判 none');
    expect(prompt).not.toContain('最近 assistant 回合');
  });

  it('renders prior assistant turns and marks the anchored one', () => {
    const prompt = buildLlmPrompt('不对，你刚才没有实测依据。', {
      priorAssistantTurnCount: 2,
      recentAssistantTurns: [
        { summary: '直接修改了 config/app.yaml', referenced: true },
        { summary: '解释了自己为什么先改后说', referenced: false },
      ],
      referencedAssistantTurnId: 41,
    });
    expect(prompt).toContain('有 2 个 assistant 回合');
    expect(prompt).toContain('[用户回指此回合] 直接修改了 config/app.yaml');
    expect(prompt).toContain('assistant turn id=41');
  });
});

describe('parseLlmClassification', () => {
  it('parses valid JSON into LlmClassificationResult', () => {
    const raw = '{"is_feedback": true, "type": "correction", "confidence": 0.9, "reason": "用户明确指出错误"}';
    const result = parseLlmClassification(raw);
    expect(result.valid).toBe(true);
    expect(result.value?.type).toBe('correction');
    expect(result.value?.confidence).toBe(0.9);
  });

  it('rejects malformed JSON', () => {
    const result = parseLlmClassification('not json at all');
    expect(result.valid).toBe(false);
    expect(result.value).toBeNull();
  });

  it('rejects valid JSON with wrong schema (missing fields)', () => {
    const result = parseLlmClassification('{"foo": "bar"}');
    expect(result.valid).toBe(false);
  });

  it('rejects confidence out of range', () => {
    const result = parseLlmClassification('{"is_feedback": true, "type": "correction", "confidence": 1.5, "reason": "x"}');
    expect(result.valid).toBe(false);
  });
});
