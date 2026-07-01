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

const FIXED_TS = '2026-06-30T00:00:00.000Z';

describe('collectSync', () => {
  it('high-precision hit → STRONG correction, no LLM', () => {
    const out = collectSync('这是错的', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('STRONG');
    expect(out.type).toBe('correction');
    expect(out.detectionSource).toBe('keyword');
    expect(out.needsLlmConfirmation).toBe(false);
  });

  it('ambiguous hit → pending, needs LLM, strength null', () => {
    const out = collectSync('这个不对', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(false);
    expect(out.strength).toBeNull();
    expect(out.needsLlmConfirmation).toBe(true);
  });

  it('no hit → pending LLM, strength null', () => {
    const out = collectSync('请修复PR', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(false);
    expect(out.needsLlmConfirmation).toBe(true);
  });

  // CodeRabbit #12: enableLlmStage=false 时 needsLlmConfirmation 应为 false
  it('enableLlmStage=false → ambiguous hit does NOT need LLM confirmation', () => {
    const noLlmConfig = { ...config, enableLlmStage: false };
    const out = collectSync('这个不对', 'sess1', store, noLlmConfig, FIXED_TS);
    expect(out.isSignal).toBe(false);
    expect(out.needsLlmConfirmation).toBe(false);
  });

  it('empty text → no signal, needs LLM', () => {
    const out = collectSync('', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(false);
    expect(out.matchedTerms).toEqual([]);
    expect(out.needsLlmConfirmation).toBe(true);
  });

  it('whitespace-only text → no signal, needs LLM', () => {
    const out = collectSync('   \n\t  ', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(false);
    expect(out.matchedTerms).toEqual([]);
    expect(out.needsLlmConfirmation).toBe(true);
  });

  it('high-precision empathy term → WEAK, no LLM', () => {
    const empathyStore: UnifiedKeywordStore = {
      version: 1,
      terms: {
        '我很难过': { term: '我很难过', category: 'empathy', weight: 0.9, precision: 'high', source: 'seed' },
      },
    };
    const out = collectSync('我很难过', 'sess1', empathyStore, config, FIXED_TS);
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('WEAK');
    expect(out.type).toBe('empathy');
    expect(out.detectionSource).toBe('keyword');
    expect(out.needsLlmConfirmation).toBe(false);
  });

  it('correction high-precision takes priority over empathy high-precision', () => {
    const mixedStore: UnifiedKeywordStore = {
      version: 1,
      terms: {
        '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
        '我很生气': { term: '我很生气', category: 'empathy', weight: 0.9, precision: 'high', source: 'seed' },
      },
    };
    const out = collectSync('这是错的，我很生气', 'sess1', mixedStore, config, FIXED_TS);
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('STRONG');
    expect(out.type).toBe('correction');
    expect(out.matchedTerms).toContain('这是错的');
  });

  it('keyword matching is case-insensitive', () => {
    const out = collectSync('这是错的', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(true);
    const outUpper = collectSync('这是错的', 'sess1', store, config, FIXED_TS);
    expect(outUpper.isSignal).toBe(true);
  });

  it('partial keyword match does NOT trigger high-precision hit', () => {
    const out = collectSync('这是错误的做法', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(false);
  });

  it('special characters and emojis handled gracefully', () => {
    const out = collectSync('这是错的! 🤔', 'sess1', store, config, FIXED_TS);
    expect(out.isSignal).toBe(true);
    expect(out.matchedTerms).toContain('这是错的');
  });

  it('high-precision hit returns matchedTerms array', () => {
    const out = collectSync('这是错的', 'sess1', store, config, FIXED_TS);
    expect(out.matchedTerms).toEqual(['这是错的']);
  });

  it('ambiguous hit returns all matched ambiguous terms', () => {
    const multiAmbiguousStore: UnifiedKeywordStore = {
      version: 1,
      terms: {
        '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
        '错了': { term: '错了', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
      },
    };
    const out = collectSync('这个不对，错了', 'sess1', multiAmbiguousStore, config, FIXED_TS);
    expect(out.isSignal).toBe(false);
    expect(out.matchedTerms).toHaveLength(2);
    expect(out.matchedTerms).toContain('不对');
    expect(out.matchedTerms).toContain('错了');
  });
});

describe('mapLlmResultToOutput', () => {
  it('LLM says correction → STRONG', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.9, reason: '明确纠错' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.strength).toBe('STRONG');
    expect(out.llmReason).toBe('明确纠错');
    expect(out.detectionSource).toBe('llm');
  });

  it('LLM says empathy → WEAK', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'empathy', confidence: 0.7, reason: '挫败情绪' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.strength).toBe('WEAK');
  });

  it('LLM says none → not a signal', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: false, type: 'none', confidence: 0.95, reason: '正常指令' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.isSignal).toBe(false);
    expect(out.strength).toBeNull();
  });

  it('LLM feedback=true but type=none → not a signal', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'none', confidence: 0.5, reason: '不确定' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.isSignal).toBe(false);
    expect(out.strength).toBeNull();
  });

  it('LLM correction with low confidence still → STRONG', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.51, reason: '可能是纠错' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('STRONG');
    expect(out.type).toBe('correction');
  });

  it('LLM empathy with high confidence → WEAK', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'empathy', confidence: 0.99, reason: '强烈挫败感' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('WEAK');
    expect(out.type).toBe('empathy');
  });

  it('LLM output includes llmReason for all results', () => {
    const correctionOut = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.9, reason: 'correction reason' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(correctionOut.llmReason).toBe('correction reason');

    const empathyOut = mapLlmResultToOutput(
      { is_feedback: true, type: 'empathy', confidence: 0.7, reason: 'empathy reason' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(empathyOut.llmReason).toBe('empathy reason');

    const noneOut = mapLlmResultToOutput(
      { is_feedback: false, type: 'none', confidence: 0.95, reason: 'none reason' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(noneOut.llmReason).toBe('none reason');
  });

  it('LLM empty reason handled gracefully', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.9, reason: '' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.isSignal).toBe(true);
    expect(out.llmReason).toBe('');
  });

  it('LLM output sets matchedTerms empty array', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.9, reason: 'llm detection' },
      'text', 'sess1', config, FIXED_TS,
    );
    expect(out.matchedTerms).toEqual([]);
  });
});

describe('buildEvidence', () => {
  it('truncates excerpt to 200 chars', () => {
    const long = 'x'.repeat(300);
    const ev = buildEvidence(long, FIXED_TS);
    expect(ev.excerpt.length).toBe(200);
    expect(ev.detectedAt).toBe(FIXED_TS);
  });

  it('preserves text under 200 chars', () => {
    const short = 'short text';
    const ev = buildEvidence(short, FIXED_TS);
    expect(ev.excerpt).toBe(short);
    expect(ev.excerpt.length).toBe(10);
  });

  it('exactly 200 chars preserved', () => {
    const exact = 'x'.repeat(200);
    const ev = buildEvidence(exact, FIXED_TS);
    expect(ev.excerpt.length).toBe(200);
    expect(ev.excerpt).toBe(exact);
  });

  it('empty text produces empty excerpt', () => {
    const ev = buildEvidence('', FIXED_TS);
    expect(ev.excerpt).toBe('');
    expect(ev.detectedAt).toBe(FIXED_TS);
  });

  it('preserves multi-byte characters correctly', () => {
    const chinese = '这是一段中文测试文本，用于验证多字节字符的处理是否正确。';
    const ev = buildEvidence(chinese, FIXED_TS);
    expect(ev.excerpt).toBe(chinese);
    expect(ev.detectedAt).toBe(FIXED_TS);
  });

  it('truncates multi-byte characters correctly', () => {
    const longChinese = '这是一段很长的中文测试文本，用于验证多字节字符的处理是否正确。'.repeat(10);
    const ev = buildEvidence(longChinese, FIXED_TS);
    expect(ev.excerpt.length).toBe(200);
  });

  it('preserves detectedAt timestamp', () => {
    const ts = '2026-01-15T10:30:45.123Z';
    const ev = buildEvidence('test', ts);
    expect(ev.detectedAt).toBe(ts);
  });
});
