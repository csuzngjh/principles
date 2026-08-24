import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getNestedString, parseJsonRecord } from './i18n-test-helper.js';

// PRI-572: presence ≠ effect. Source-contract tests for the Receipt UI
// semantics (mirrors principle-governance-projection.test.ts pattern —
// vitest runs in node env, no jsdom mounting).

const page = fs.readFileSync(path.resolve('src/ui/pages/principles/PrincipleDetailPage.tsx'), 'utf8');
const en = parseJsonRecord(fs.readFileSync(path.resolve('src/ui/i18n/en.json'), 'utf8'));
const zh = parseJsonRecord(fs.readFileSync(path.resolve('src/ui/i18n/zh-CN.json'), 'utf8'));

describe('PRI-572 receipt presence/effect semantic separation', () => {
  it('selects the owner-visible receipt presentation from effect evidence', async () => {
    const pageModule: Record<string, unknown> = await import('../../src/ui/pages/principles/PrincipleDetailPage.js');
    const getReceiptPresentation = pageModule['getReceiptPresentation'];
    expect(typeof getReceiptPresentation).toBe('function');
    if (typeof getReceiptPresentation !== 'function') return;

    expect(getReceiptPresentation(0)).toEqual({
      headlineKey: 'principles.detail.receipts.headlinePresence',
      showZeroEffectExplanation: true,
    });
    expect(getReceiptPresentation(2)).toEqual({
      headlineKey: 'principles.detail.receipts.headline',
      showZeroEffectExplanation: false,
    });
  });

  it('explains the zero-effect state instead of leaving an unexplained counter', () => {
    expect(page).toContain('data-testid="receipt-history-zero-effect"');
    expect(page).toContain('receiptPresentation?.showZeroEffectExplanation');
    expect(page).toContain('principles.detail.receipts.zeroEffect');
  });

  it('keeps the data contract intact: counts, timeline and degraded block are unchanged', () => {
    expect(page).toContain('data-testid="receipt-history-counts"');
    expect(page).toContain("t('principles.detail.receipts.counts', { effectCount: receipts.effectCount, presenceCount: receipts.presenceCount })");
    expect(page).toContain('data-testid="receipt-history-degraded"');
  });

  it('ships matching receipts keys in both locales, including the new presence-only copy', () => {
    for (const locale of [en, zh]) {
      const counts = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'counts']);
      const headlinePresence = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'headlinePresence']);
      const zeroEffect = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'zeroEffect']);
      expect(counts).toContain('{{effectCount}}');
      expect(counts).toContain('{{presenceCount}}');
      expect(headlinePresence.length).toBeGreaterThan(0);
      expect(zeroEffect.length).toBeGreaterThan(0);
    }
  });

  it('labels the activation-page counts row with the same two-level wording', () => {
    const enValue = getNestedString(en, ['pages', 'activation', 'receiptsValue']);
    const zhValue = getNestedString(zh, ['pages', 'activation', 'receiptsValue']);
    expect(enValue).toContain('{{effect}}');
    expect(enValue).toContain('behavior effect(s)');
    expect(enValue).toContain('context injection(s)');
    expect(zhValue).toContain('{{effect}}');
    expect(zhValue).toContain('行为生效');
    expect(zhValue).toContain('参与上下文');
  });

  it('keeps the honesty note naming both levels and the presence≠effect rule', () => {
    const noteEn = getNestedString(en, ['pages', 'principles', 'detail', 'receipts', 'note']);
    const noteZh = getNestedString(zh, ['pages', 'principles', 'detail', 'receipts', 'note']);
    expect(noteEn).toContain('Effect');
    expect(noteEn).toContain('Presence');
    expect(noteZh).toContain('Effect（行为生效）');
    expect(noteZh).toContain('Presence（参与上下文）');
    expect(noteZh).toContain('参与决策 ≠ 已改变行为');
  });
});
