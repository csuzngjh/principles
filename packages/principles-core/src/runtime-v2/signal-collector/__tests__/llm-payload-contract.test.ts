import { describe, it, expect } from 'vitest';
import {
  resolveLlmClassificationPayload,
  buildLlmPrompt,
} from '../llm-stage.js';
import { SignalClassificationOutputV1Schema } from '../types.js';
import { Value } from '@sinclair/typebox/value';

/**
 * Stage2 typed runtime contract (MVP_CORE_LOOP_CONTRACT INV-01)。
 *
 * 审计背景 (ISSUE-001): 修复前 fetchOutput 的无-schema Path 3 返回已解析对象,
 * 而分类器只接受 string → 模型返回完美 JSON 分类 (confidence 0.97) 仍被判
 * invalid → SIGNAL_LLM_PARSE_FAIL。本文件锁定修复后的 payload contract。
 */
describe('resolveLlmClassificationPayload', () => {
  it('canonical: adapter-validated structured object resolves via structured path', () => {
    // 审计隔离实验 Phase 2 探针捕获的真实 payload 形状 (llama.cpp 返回)
    const payload = {
      is_feedback: true,
      type: 'correction',
      confidence: 0.97,
      reason: '用户明确指出AI不应直接替其做决定',
    };
    const result = resolveLlmClassificationPayload(payload);
    expect(result.path).toBe('structured');
    expect(result.value).toEqual(payload);
  });

  it('canonical: non-feedback none classification also resolves', () => {
    const result = resolveLlmClassificationPayload({
      is_feedback: false,
      type: 'none',
      confidence: 0.9,
      reason: '普通任务指令',
    });
    expect(result.path).toBe('structured');
    expect(result.value?.type).toBe('none');
  });

  it('legacy: raw JSON string payload parses via legacy_string', () => {
    const result = resolveLlmClassificationPayload(
      '{"is_feedback":true,"type":"empathy","confidence":0.8,"reason":"挫败情绪"}',
    );
    expect(result.path).toBe('legacy_string');
    expect(result.value?.type).toBe('empathy');
  });

  it('legacy: {output: string} envelope parses via legacy_envelope', () => {
    const result = resolveLlmClassificationPayload({
      output: '{"is_feedback":true,"type":"correction","confidence":0.9,"reason":"纠正"}',
    });
    expect(result.path).toBe('legacy_envelope');
    expect(result.value?.is_feedback).toBe(true);
  });

  it('malformed: structurally wrong object → invalid (fail-soft with discriminator)', () => {
    const result = resolveLlmClassificationPayload({ is_feedback: 'yes', type: 'correction' });
    expect(result.path).toBe('invalid');
    expect(result.value).toBeNull();
  });

  it('malformed: out-of-range confidence → invalid', () => {
    const result = resolveLlmClassificationPayload({
      is_feedback: true,
      type: 'correction',
      confidence: 1.5,
      reason: 'x',
    });
    expect(result.path).toBe('invalid');
  });

  it('malformed: empty string → invalid (修复前 JSON.parse(\'\') 抛出的路径)', () => {
    const result = resolveLlmClassificationPayload('');
    expect(result.path).toBe('invalid');
    expect(result.value).toBeNull();
  });

  it('malformed: null / undefined / number → invalid, 不抛异常', () => {
    expect(resolveLlmClassificationPayload(null).path).toBe('invalid');
    expect(resolveLlmClassificationPayload(undefined).path).toBe('invalid');
    expect(resolveLlmClassificationPayload(42).path).toBe('invalid');
  });

  it('malformed: string 内非 JSON → invalid', () => {
    expect(resolveLlmClassificationPayload('这不是JSON').path).toBe('invalid');
  });

  it('envelope with non-string output → invalid (不误走信封路径)', () => {
    const result = resolveLlmClassificationPayload({ output: { nested: true } });
    expect(result.path).toBe('invalid');
  });
});

describe('SignalClassificationOutputV1Schema (registered as signal-classification-output-v1)', () => {
  it('接受 prompt 承诺的精确形状', () => {
    const ok = Value.Check(SignalClassificationOutputV1Schema, {
      is_feedback: true,
      type: 'correction',
      confidence: 0.97,
      reason: '用户明确指出错误',
    });
    expect(ok).toBe(true);
  });

  it('拒绝缺字段 / 错类型 / 越界 confidence', () => {
    expect(Value.Check(SignalClassificationOutputV1Schema, { is_feedback: true })).toBe(false);
    expect(Value.Check(SignalClassificationOutputV1Schema, {
      is_feedback: 'true', type: 'correction', confidence: 0.5, reason: 'x',
    })).toBe(false);
    expect(Value.Check(SignalClassificationOutputV1Schema, {
      is_feedback: true, type: 'other', confidence: 0.5, reason: 'x',
    })).toBe(false);
    expect(Value.Check(SignalClassificationOutputV1Schema, {
      is_feedback: true, type: 'correction', confidence: 2, reason: 'x',
    })).toBe(false);
  });

  it('schema 与 validateLlmClassification 对相同样本集判定一致 (单一契约,防漂移)', () => {
    const valid = [
      { is_feedback: true, type: 'correction', confidence: 0.97, reason: 'a' },
      { is_feedback: false, type: 'none', confidence: 0, reason: '' },
      { is_feedback: true, type: 'empathy', confidence: 1, reason: 'b' },
    ];
    const invalid: unknown[] = [
      { is_feedback: true, type: 'correction', confidence: 1.5, reason: 'c' },
      { is_feedback: true, type: 'wrong', confidence: 0.5, reason: 'd' },
      null,
      { is_feedback: 'true', type: 'correction', confidence: 0.5, reason: 'x' },
    ];
    for (const s of valid) {
      expect(Value.Check(SignalClassificationOutputV1Schema, s)).toBe(true);
      expect(resolveLlmClassificationPayload(s).path).toBe('structured');
    }
    for (const s of invalid) {
      expect(Value.Check(SignalClassificationOutputV1Schema, s)).toBe(false);
      expect(resolveLlmClassificationPayload(s).path).not.toBe('structured');
    }
  });

  it('buildLlmPrompt 声明的字段与 schema 字段一致', () => {
    const prompt = buildLlmPrompt('测试消息');
    expect(prompt).toContain('"is_feedback"');
    expect(prompt).toContain('"type"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"reason"');
  });
});
