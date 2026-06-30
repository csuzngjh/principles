import { describe, it, expect } from 'vitest';
import { buildLlmPrompt, parseLlmClassification } from '../llm-stage.js';

describe('buildLlmPrompt', () => {
  it('produces a prompt containing the user message and JSON format spec', () => {
    const prompt = buildLlmPrompt('你又自作主张了，这是错的！');
    expect(prompt).toContain('你又自作主张了，这是错的！');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('correction');
    expect(prompt).toContain('empathy');
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
