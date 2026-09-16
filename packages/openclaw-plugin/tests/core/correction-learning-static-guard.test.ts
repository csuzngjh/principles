/**
 * PRI-812 静态守卫：死能力不得复活，canonical detector 保持唯一。
 *
 * §9 要求用 architecture regression / static guard 固化，而非仅靠人工 grep：
 *  - CorrectionCueLearner 不得再定义 match()（幽灵第二检测算法）或
 *    recordHits()（hitCount 失真写者）——对剥离注释后的源码做断言；
 *  - 检测权威仍是 createSharedCorrectionKeywordStore → collectSync；
 *  - CorrectionObserver payload schema 不再携带 hitCount。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CorrectionObserverPayloadSchema } from '@principles/core/runtime-v2';

const pluginSrc = join(__dirname, '../../src');

/** 剥离块注释与行注释，避免守卫被说明文字误触。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('PRI-812 static guard: correction learning dead capabilities stay dead', () => {
  it('CorrectionCueLearner no longer defines match() or recordHits()', () => {
    const learnerSrc = stripComments(
      readFileSync(join(pluginSrc, 'core/correction-cue-learner.ts'), 'utf-8'),
    );
    expect(learnerSrc).not.toMatch(/\bmatch\s*\(/);
    expect(learnerSrc).not.toMatch(/\brecordHits\s*\(/);
    // TP/FP 反馈面（earned precision 证据源）必须保留
    expect(learnerSrc).toMatch(/\brecordTruePositive\s*\(/);
    expect(learnerSrc).toMatch(/\brecordFalsePositive\s*\(/);
  });

  it('canonical detection remains the shared keyword store → collectSync path', () => {
    const bridgeSrc = stripComments(
      readFileSync(join(pluginSrc, 'core/signal-keyword-store.ts'), 'utf-8'),
    );
    expect(bridgeSrc).toContain('createSharedCorrectionKeywordStore');

    const hostSrc = stripComments(
      readFileSync(join(pluginSrc, 'core/signal-collector-host.ts'), 'utf-8'),
    );
    expect(hostSrc).toContain('collectSync(');
  });

  it('CorrectionObserver payload schema no longer carries hitCount', () => {
    const termsSchema = (CorrectionObserverPayloadSchema as unknown as {
      properties: {
        keywordStoreSummary: {
          properties: { terms: { items: { properties: Record<string, unknown> } } };
        };
      };
    }).properties.keywordStoreSummary.properties.terms.items.properties;

    expect(termsSchema).toHaveProperty('term');
    expect(termsSchema).toHaveProperty('truePositiveCount');
    expect(termsSchema).toHaveProperty('falsePositiveCount');
    expect(termsSchema).not.toHaveProperty('hitCount');
  });
});
