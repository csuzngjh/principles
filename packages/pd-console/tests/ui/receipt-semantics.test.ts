import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getNestedString, parseJsonRecord } from './i18n-test-helper.js';

// PRI-572: presence ≠ effect. Source-contract tests for the Receipt UI
// semantics (mirrors principle-governance-projection.test.ts pattern —
// vitest runs in node env, no jsdom mounting).

const page = fs.readFileSync(path.resolve('src/ui/pages/principles/PrincipleDetailPage.tsx'), 'utf8');
const activationPage = fs.readFileSync(path.resolve('src/ui/pages/activation/ActivationPage.tsx'), 'utf8');
const coverageComponent = fs.readFileSync(path.resolve('src/ui/components/receipts/ReceiptCoverageDisclosure.tsx'), 'utf8');
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

describe('PRI-590 receipt evidence coverage disclosure', () => {
  it('renders the coverage disclosure on both existing receipt surfaces', () => {
    // Detail page receipt section renders the shared component with the response coverage.
    expect(page).toContain('<ReceiptCoverageDisclosure coverage={receipts.coverage} />');
    expect(activationPage).toContain('<ReceiptCoverageDisclosure coverage={receiptCoverage} />');
    // The disclosure block itself lives in the shared component.
    expect(coverageComponent).toContain('data-testid="receipt-coverage"');
    // Activation page page-level context for the counts.
    expect(activationPage).toContain('data-testid="receipt-counts-coverage"');
  });

  it('labels the disabled/unavailable zero-states from the coverage sourceStatus, not from reason text', () => {
    // Both pages derive the localized zero-state headline from coverage.
    expect(page).toContain('getReceiptSourceStatusLabelKey(receipts.coverage.sourceStatus)');
    expect(activationPage).toContain('getReceiptSourceStatusLabelKey(receiptCoverage.sourceStatus)');
  });

  it('maps every sourceStatus/validationStatus member via exhaustive Records (ERR-106)', () => {
    expect(coverageComponent).toContain(': Record<ReceiptSourceStatusData, string>');
    expect(coverageComponent).toContain(': Record<ReceiptValidationStatusData, string | null>');
  });

  it('discloses observed range, retention and the completeness limitation in both locales', () => {
    for (const locale of [en, zh]) {
      const c = (key: string) => getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'coverage', key]);
      expect(c('label').length).toBeGreaterThan(0);
      expect(c('statusAvailable').length).toBeGreaterThan(0);
      expect(c('statusDisabled').length).toBeGreaterThan(0);
      expect(c('statusUnavailable').length).toBeGreaterThan(0);
      expect(c('observedSince')).toContain('{{date}}');
      expect(c('observedSinceEmpty').length).toBeGreaterThan(0);
      expect(c('asOf')).toContain('{{date}}');
      expect(c('retention')).toContain('{{days}}');
      expect(c('limitation').length).toBeGreaterThan(0);
      expect(c('validationPartial')).toContain('{{reasonCode}}');
      expect(c('validationMalformed')).toContain('{{reasonCode}}');
    }
  });

  it('never renders event-level internals in the coverage disclosure', () => {
    // The disclosure block renders only coverage metadata; it must not access
    // event-level fields (property access pattern, doc comments excluded).
    expect(coverageComponent).not.toMatch(/\.(filePath|digest|toolName|sessionId)\b/);
  });

  it('suppresses per-card count rows when the ledger verdict is malformed (unknown ≠ zero)', () => {
    // PRI-594: a malformed ledger must not render 0/0 rows as if they were a
    // true zero — the page-level coverage block carries the recovery verdict.
    expect(activationPage).toContain('receiptCountsUntrustworthy');
    expect(activationPage).toContain('receiptCoverage.validationStatus === "malformed"');
  });
});
