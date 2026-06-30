import { describe, it, expect } from 'vitest';
import { collectSync, mapLlmResultToOutput, buildEvidence } from '../signal-collector.js';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '../types.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  },
};

const config: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

describe('collectSync', () => {
  it('high-precision hit → STRONG correction, no LLM', () => {
    const out = collectSync('这是错的', 'sess1', store, config);
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('STRONG');
    expect(out.type).toBe('correction');
    expect(out.detectionSource).toBe('keyword');
    expect(out.needsLlmConfirmation).toBe(false);
  });

  it('ambiguous hit → pending, needs LLM, strength null', () => {
    const out = collectSync('这个不对', 'sess1', store, config);
    expect(out.isSignal).toBe(false);
    expect(out.strength).toBeNull();
    expect(out.needsLlmConfirmation).toBe(true);
  });

  it('no hit → pending LLM, strength null', () => {
    const out = collectSync('请修复PR', 'sess1', store, config);
    expect(out.isSignal).toBe(false);
    expect(out.needsLlmConfirmation).toBe(true);
  });
});

describe('mapLlmResultToOutput', () => {
  it('LLM says correction → STRONG', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.9, reason: '明确纠错' },
      'text', 'sess1', config,
    );
    expect(out.strength).toBe('STRONG');
    expect(out.llmReason).toBe('明确纠错');
    expect(out.detectionSource).toBe('llm');
  });

  it('LLM says empathy → WEAK', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'empathy', confidence: 0.7, reason: '挫败情绪' },
      'text', 'sess1', config,
    );
    expect(out.strength).toBe('WEAK');
  });

  it('LLM says none → not a signal', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: false, type: 'none', confidence: 0.95, reason: '正常指令' },
      'text', 'sess1', config,
    );
    expect(out.isSignal).toBe(false);
    expect(out.strength).toBeNull();
  });
});

describe('buildEvidence', () => {
  it('truncates excerpt to 200 chars', () => {
    const long = 'x'.repeat(300);
    const ev = buildEvidence(long);
    expect(ev.excerpt.length).toBe(200);
  });
});
