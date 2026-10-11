import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNestedString, parseJsonRecord } from './i18n-test-helper.js';

// PRI-572: presence ≠ effect. Source-contract tests for the Receipt UI
// semantics (mirrors principle-governance-projection.test.ts pattern —
// vitest runs in node env, no jsdom mounting).

// Resolve from this test file, not process.cwd(): vitest may run from the
// repo root, where cwd-relative 'src/...' paths do not exist (PRI-937).
const SRC_UI_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ui');

const page = fs.readFileSync(path.join(SRC_UI_ROOT, 'pages/principles/PrincipleDetailPage.tsx'), 'utf8');
const activationPage = fs.readFileSync(path.join(SRC_UI_ROOT, 'pages/activation/ActivationPage.tsx'), 'utf8');
const coverageComponent = fs.readFileSync(path.join(SRC_UI_ROOT, 'components/receipts/ReceiptCoverageDisclosure.tsx'), 'utf8');
const en = parseJsonRecord(fs.readFileSync(path.join(SRC_UI_ROOT, 'i18n/en.json'), 'utf8'));
const zh = parseJsonRecord(fs.readFileSync(path.join(SRC_UI_ROOT, 'i18n/zh-CN.json'), 'utf8'));

describe('PRI-572 receipt presence/effect semantic separation', () => {
  it('selects the owner-visible receipt presentation from BOTH verified counts (SPEC-PD-UIUX-001 R1)', async () => {
    const pageModule: Record<string, unknown> = await import('../../src/ui/pages/principles/PrincipleDetailPage.js');
    const getReceiptPresentation = pageModule['getReceiptPresentation'];
    expect(typeof getReceiptPresentation).toBe('function');
    if (typeof getReceiptPresentation !== 'function') return;

    // R1 state matrix — each verified data combination maps to one intent:
    // ok + Presence=0 + Effect=0 → "nothing observed in retention window"
    expect(getReceiptPresentation(0, 0)).toEqual({
      headlineKey: 'principles.detail.receipts.headlineNone',
      presenceMissing: false,
      showZeroEffectExplanation: true,
    });
    // ok + Presence>0 + Effect=0 → "injections recorded, no effects yet"
    expect(getReceiptPresentation(0, 3)).toEqual({
      headlineKey: 'principles.detail.receipts.headlinePresence',
      presenceMissing: false,
      showZeroEffectExplanation: true,
    });
    // ok + Effect>0 + Presence>0 → effect headline, no fabrication needed
    expect(getReceiptPresentation(2, 5)).toEqual({
      headlineKey: 'principles.detail.receipts.headline',
      presenceMissing: false,
      showZeroEffectExplanation: false,
    });
    // ok + Effect>0 + Presence=0 → effects stand alone; note the missing
    // presence records instead of inventing them
    expect(getReceiptPresentation(2, 0)).toEqual({
      headlineKey: 'principles.detail.receipts.headline',
      presenceMissing: true,
      showZeroEffectExplanation: false,
    });
  });

  it('never maps zero-presence-zero-effect onto the "already in context" headline', async () => {
    const pageModule: Record<string, unknown> = await import('../../src/ui/pages/principles/PrincipleDetailPage.js');
    const getReceiptPresentation = pageModule['getReceiptPresentation'] as (e: number, p: number) => { headlineKey: string };
    // The 0/0 combination must not claim the principle entered the context.
    expect(getReceiptPresentation(0, 0).headlineKey).not.toBe('principles.detail.receipts.headlinePresence');
    expect(getReceiptPresentation(0, 0).headlineKey).not.toBe('principles.detail.receipts.headline');
  });

  it('explains the zero-effect state instead of leaving an unexplained counter', () => {
    expect(page).toContain('data-testid="receipt-history-zero-effect"');
    expect(page).toContain('receiptPresentation?.showZeroEffectExplanation');
    // The zero-effect copy is chosen from the presence count so the 0/0 and
    // presence-only states get different, truthful explanations.
    expect(page).toContain("'principles.detail.receipts.zeroEffectPresence'");
    expect(page).toContain("'principles.detail.receipts.zeroEffectNone'");
  });

  it('notes missing presence records when effects exist without injections (no fabricated presence)', () => {
    expect(page).toContain('data-testid="receipt-history-presence-missing"');
    expect(page).toContain('receiptPresentation?.presenceMissing');
    expect(page).toContain("'principles.detail.receipts.presenceMissingNote'");
  });

  it('keeps the data contract intact: counts, timeline and degraded block are unchanged', () => {
    expect(page).toContain('data-testid="receipt-history-counts"');
    expect(page).toContain("t('principles.detail.receipts.counts', { effectCount: receipts.effectCount, presenceCount: receipts.presenceCount })");
    expect(page).toContain('data-testid="receipt-history-degraded"');
  });

  it('ships matching receipts keys in both locales, including the R1 state matrix copy', () => {
    for (const locale of [en, zh]) {
      const counts = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'counts']);
      const headlinePresence = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'headlinePresence']);
      const headlineNone = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'headlineNone']);
      const zeroEffectPresence = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'zeroEffectPresence']);
      const zeroEffectNone = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'zeroEffectNone']);
      const presenceMissingNote = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'presenceMissingNote']);
      expect(counts).toContain('{{effectCount}}');
      expect(counts).toContain('{{presenceCount}}');
      expect(headlinePresence.length).toBeGreaterThan(0);
      expect(headlineNone.length).toBeGreaterThan(0);
      expect(zeroEffectPresence.length).toBeGreaterThan(0);
      expect(zeroEffectNone.length).toBeGreaterThan(0);
      expect(presenceMissingNote.length).toBeGreaterThan(0);
    }
  });

  it('keeps the zero-count headlines honest in both locales (no contradiction with the numbers)', () => {
    // The presence-only headline states injections were recorded — wording
    // must not claim the principle currently influences decisions.
    for (const locale of [en, zh]) {
      const headlinePresence = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'headlinePresence']);
      expect(headlinePresence).not.toMatch(/已进入|part of the agent/i);
      const headlineNone = getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'headlineNone']);
      // The none headline must scope the claim to the retention window.
      expect(headlineNone).toMatch(/保留范围|retention window/i);
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
      // Review round 2: owner-facing copy must not interpolate the raw
      // snake_case reasonCode — verdict lines are self-contained sentences.
      expect(c('validationPartial')).not.toContain('{{reasonCode}}');
      expect(c('validationMalformed')).not.toContain('{{reasonCode}}');
    }
  });

  it('localizes known reasonCodes in both locales (no technical codes leaked to owners)', () => {
    for (const locale of [en, zh]) {
      const rc = (key: string) =>
        getNestedString(locale, ['pages', 'principles', 'detail', 'receipts', 'coverage', 'reasonCodes', key]);
      expect(rc('receiptRowsDropped').length).toBeGreaterThan(0);
      expect(rc('ledgerLevelInvalid').length).toBeGreaterThan(0);
      expect(rc('ledgerCountsUnreadable').length).toBeGreaterThan(0);
    }
    // The component resolves reasonCodes through a Map lookup (no prototype
    // chain for API-payload keys) with a raw-code fallback — never interpolated
    // into a sentence.
    expect(coverageComponent).toContain('REASON_CODE_LABEL_KEYS.get(');
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
