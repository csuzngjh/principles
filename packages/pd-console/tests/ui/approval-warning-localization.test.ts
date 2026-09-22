import { describe, expect, it } from 'vitest';
import { localizeApprovalWarning, type TranslateFn } from '../../src/ui/utils/approval-warning-localization.js';
import { validateApprovalsGrouped } from '../../src/ui/utils/validators.js';

// The exact live server text (ApprovalsConsoleModel.ts:244, PRI-890).
const BUDGET_WARNING =
  'injection_budget_excluded: the activation is committed but the prompt injection budget (2000c, FIFO by activated_at) is already filled by 3 earlier activation(s) — this principle will NOT enter agent behavior until older ones are deactivated. nextAction=review the activations page and deactivate superseded principles';

function fakeT(key: string, opts?: Record<string, unknown>): string {
  return opts !== undefined && Object.keys(opts).length > 0 ? `${key}?${JSON.stringify(opts)}` : key;
}

describe('localizeApprovalWarning (PRI-908)', () => {
  it('maps injection_budget_excluded to a localized title/body with parsed values', () => {
    const result = localizeApprovalWarning(BUDGET_WARNING, fakeT);
    expect(result.code).toBe('injection_budget_excluded');
    expect(result.title).toBe('pages.focus.approveWarning.budgetExcludedTitle');
    expect(result.body).toBe(
      `pages.focus.approveWarning.budgetExcludedBody?${JSON.stringify({ budget: 2000, earlierCount: 3 })}`,
    );
    expect(result.activationAction).toBe(true);
    // rc-9: the raw server text is preserved for the details line, never dropped.
    expect(result.detail).toBe(BUDGET_WARNING);
  });

  it('falls back to the placeholder-free body when values cannot be parsed (PRI-875 precedent)', () => {
    const result = localizeApprovalWarning('injection_budget_excluded: budget saturated', fakeT);
    expect(result.code).toBe('injection_budget_excluded');
    expect(result.body).toBe('pages.focus.approveWarning.budgetExcludedBodySimple');
  });

  it('localizes non-budget exclusion, check-failure and ledger warnings', () => {
    expect(localizeApprovalWarning('injection_excluded_non_budget: artifact resolution skipped it', fakeT)).toMatchObject({
      code: 'injection_excluded_non_budget',
      title: 'pages.focus.approveWarning.excludedTitle',
      body: 'pages.focus.approveWarning.excludedNonBudgetBody',
      activationAction: true,
    });
    expect(localizeApprovalWarning('injection_budget_check_failed: state.db locked', fakeT)).toMatchObject({
      code: 'injection_budget_check_failed',
      title: 'pages.focus.approveWarning.checkFailedTitle',
      activationAction: true,
    });
    expect(localizeApprovalWarning('ledger_activate_skipped: artifact x not found in artifact store', fakeT)).toMatchObject({
      code: 'ledger_activate_skipped',
      title: 'pages.focus.approveWarning.ledgerTitle',
      body: 'pages.focus.approveWarning.ledgerBody',
      activationAction: false,
    });
    expect(localizeApprovalWarning('ledger_activate_failed: Cannot update missing principle <title>', fakeT)).toMatchObject({
      code: 'ledger_activate_failed',
      activationAction: false,
    });
  });

  it('degrades unknown text to the raw server string verbatim (rc-9)', () => {
    const raw = 'something_unrecognized happened badly; nextAction=check server logs';
    const result = localizeApprovalWarning(raw, fakeT);
    expect(result.code).toBe('unknown');
    expect(result.title).toBe(raw);
    expect(result.body).toBeUndefined();
    expect(result.detail).toBe(raw);
    expect(result.activationAction).toBe(false);
  });
});

describe('validateApprovalsGrouped promptInjection (PRI-908)', () => {
  const base = { groups: [], generatedAt: '2026-09-23T00:00:00.000Z' };

  it('parses a well-formed budget status', () => {
    const result = validateApprovalsGrouped({ ...base, promptInjection: { budget: 2000, usedChars: 1940, truncated: true } });
    expect(result).not.toBeNull();
    expect(result?.promptInjection).toEqual({ budget: 2000, usedChars: 1940, truncated: true });
  });

  it('omits malformed or absent budget status instead of rejecting the payload', () => {
    expect(validateApprovalsGrouped({ ...base, promptInjection: { budget: -1, usedChars: 0, truncated: false } })?.promptInjection).toBeUndefined();
    expect(validateApprovalsGrouped({ ...base, promptInjection: { budget: 1.5, usedChars: 0, truncated: false } })?.promptInjection).toBeUndefined();
    expect(validateApprovalsGrouped({ ...base, promptInjection: { budget: 2000, usedChars: 'many', truncated: false } })?.promptInjection).toBeUndefined();
    expect(validateApprovalsGrouped({ ...base, promptInjection: 'saturated' })?.promptInjection).toBeUndefined();
    expect(validateApprovalsGrouped(base)?.promptInjection).toBeUndefined();
  });
});
