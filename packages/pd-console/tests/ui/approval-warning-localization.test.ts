import { describe, expect, it } from 'vitest';
import { localizeApprovalWarning, splitApprovalWarnings, type TranslateFn } from '../../src/ui/utils/approval-warning-localization.js';
import { validateApprovalsGrouped } from '../../src/ui/utils/validators.js';
import { validateApprovalsGroupedData } from '../../src/ui/pages/focus/focus-validation.js';

// The exact live server text (ApprovalsConsoleModel.ts, PRI-890 wording as
// corrected by PR-1894 — the copy no longer asserts a bare FIFO prefix).
const BUDGET_WARNING =
  'injection_budget_excluded: the activation is committed but the prompt injection budget (2000c) is full and this activation is not reachable under the current production selection policy (legacy_fifo_prefix_v1; 3/11 eligible injected, FIFO by activated_at) — this principle will NOT enter agent behavior until capacity frees up. nextAction=review the activations page and deactivate superseded principles';

// PR-1894: the live workspace case — a fair-rotation route where the new
// activation is merely rotated out of the current window.
const QUEUED_WARNING =
  'injection_budget_queued: the activation is committed but sits outside the CURRENT prompt injection window (2000c; 7 of 19 eligible activations injected this round; production selection policy fair_rotation_v1). Fair rotation advances the window by one position per recorded user turn, so this principle WILL enter agent behavior within at most 19 consecutive user turns of a continuously advancing session — deactivating older principles is NOT required. nextAction=none; verify presence via the activations page or the prompt injection telemetry';

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

  it('maps injection_budget_queued to rotation-aware copy and offers NO deactivation CTA (PR-1894)', () => {
    const result = localizeApprovalWarning(QUEUED_WARNING, fakeT);
    expect(result.code).toBe('injection_budget_queued');
    expect(result.title).toBe('pages.focus.approveWarning.queuedTitle');
    expect(result.body).toBe(
      `pages.focus.approveWarning.queuedBody?${JSON.stringify({ budget: 2000, turns: 19 })}`,
    );
    // Rotation means the principle arrives on its own — sending the Owner to
    // deactivate healthy older principles here is the exact defect PR-1894 fixes.
    expect(result.activationAction).toBe(false);
    expect(result.detail).toBe(QUEUED_WARNING);
  });

  it('degrades injection_budget_queued to placeholder-free copy when the turn bound is unparseable', () => {
    const result = localizeApprovalWarning('injection_budget_queued: queued behind rotation', fakeT);
    expect(result.code).toBe('injection_budget_queued');
    expect(result.body).toBe('pages.focus.approveWarning.queuedBodySimple');
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

  // PD_PROMPT_CAPACITY_V1 AC-02/R-A3: oversized is an independent fact — its
  // own code, its own copy, with the cost parsed when present.
  it('maps injection_oversized to oversized copy with the parsed cost', () => {
    const raw = 'injection_oversized: the activation is committed but its own list entry exceeds the cap (2000 chars, measured in UTF-16 units on the legacy_trim route) — it can never enter the prompt as written, regardless of rotation or free capacity. nextAction=shorten the statement';
    const result = localizeApprovalWarning(raw, fakeT);
    expect(result.code).toBe('injection_oversized');
    expect(result.title).toBe('pages.focus.approveWarning.oversizedTitle');
    expect(result.body).toBe(
      `pages.focus.approveWarning.oversizedBody?${JSON.stringify({ cost: 2000 })}`,
    );
    expect(result.activationAction).toBe(true);
    expect(result.detail).toBe(raw);
  });

  it('degrades injection_oversized to placeholder-free copy when the cost is unparseable', () => {
    const result = localizeApprovalWarning('injection_oversized: this principle alone is oversized', fakeT);
    expect(result.code).toBe('injection_oversized');
    expect(result.body).toBe('pages.focus.approveWarning.oversizedBodySimple');
  });

  it('maps injection_capacity_unconfirmed to the unconfirmed copy (AC-01)', () => {
    const raw = 'injection_capacity_unconfirmed: the activation is committed but this workspace\'s effective injection route cannot be confirmed (multi_host_routes_differ); per-host forecasts: openclaw=legacy_trim (1855c, truncated); codex=shared_render (1980c, truncated). nextAction=pass an explicit target host (openclaw|codex)';
    const result = localizeApprovalWarning(raw, fakeT);
    expect(result.code).toBe('injection_capacity_unconfirmed');
    expect(result.title).toBe('pages.focus.approveWarning.capacityUnconfirmedTitle');
    expect(result.body).toBe('pages.focus.approveWarning.capacityUnconfirmedBody');
    expect(result.activationAction).toBe(true);
    expect(result.detail).toBe(raw);
  });
});

describe('validateApprovalsGrouped promptInjection (PRI-908)', () => {
  const base = { groups: [], generatedAt: '2026-09-23T00:00:00.000Z' };

  it('parses a well-formed budget status', () => {
    const result = validateApprovalsGrouped({ ...base, promptInjection: { budget: 2000, usedChars: 1940, truncated: true } });
    expect(result).not.toBeNull();
    expect(result?.promptInjection).toEqual({ budget: 2000, usedChars: 1940, truncated: true });
  });

  it('carries fitsPromptBudget through when it is a real boolean (PR-1894 review fix)', () => {
    const withFits = validateApprovalsGrouped({
      ...base,
      groups: [{ principleId: 'P1', principleTitle: 't', status: 'pending', records: [], fitsPromptBudget: true }],
    });
    expect(withFits?.groups[0]?.fitsPromptBudget).toBe(true);

    // Absent stays undefined → the badge promises nothing.
    const withoutFits = validateApprovalsGrouped({
      ...base,
      groups: [{ principleId: 'P1', principleTitle: 't', status: 'pending', records: [] }],
    });
    expect(withoutFits?.groups[0]?.fitsPromptBudget).toBeUndefined();
  });

  it('drops a present-but-non-boolean fitsPromptBudget instead of propagating it (rc-1/rc-2)', () => {
    const result = validateApprovalsGrouped({
      ...base,
      groups: [{ principleId: 'P1', principleTitle: 't', status: 'pending', records: [], fitsPromptBudget: 'yes' }],
    });
    expect(result).not.toBeNull();
    expect(result?.groups[0]?.fitsPromptBudget).toBeUndefined();
  });

  it('carries the PR-1894 rotation facts when present (productionRotates drives truthful badge copy)', () => {
    const result = validateApprovalsGrouped({
      ...base,
      promptInjection: { budget: 2000, usedChars: 1947, truncated: true, productionRotates: true, eligibleCount: 19 },
    });
    expect(result?.promptInjection).toEqual({
      budget: 2000, usedChars: 1947, truncated: true, productionRotates: true, eligibleCount: 19,
    });
  });

  it('drops a present-but-invalid rotation flag instead of propagating it (rc-1/rc-2)', () => {
    // An unverified policy claim must never reach the copy branch; the UI then
    // renders the policy-agnostic badge rather than asserting rotation.
    const result = validateApprovalsGrouped({
      ...base,
      promptInjection: { budget: 2000, usedChars: 1940, truncated: true, productionRotates: 'yes', eligibleCount: -3 },
    });
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

describe('splitApprovalWarnings (PRI-908 review fix)', () => {
  it('splits server-joined warnings at each "code:" boundary', () => {
    const joined = 'ledger_activate_skipped: artifact x not found in artifact store; injection_budget_queued: the activation is committed but sits outside the CURRENT prompt injection window (2000c; 7 of 19 eligible activations injected this round)';
    const segments = splitApprovalWarnings(joined);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatch(/^ledger_activate_skipped:/);
    expect(segments[1]).toMatch(/^injection_budget_queued:/);
  });

  it('does NOT split inside a message body that contains "; the activation ..." prose', () => {
    const checkFailed = 'injection_budget_check_failed: could not recompute the prompt injection projection (boom); the activation is committed but its injection status is unverified. nextAction=check .pd/state.db readability';
    expect(splitApprovalWarnings(checkFailed)).toHaveLength(1);
  });

  it('keeps free text without any code boundary as one segment', () => {
    expect(splitApprovalWarnings('something went wrong; badly')).toEqual(['something went wrong; badly']);
  });
});

describe('FocusPage page-local validateApprovalsGroupedData (PRI-908 review fix)', () => {
  const base = { groups: [], generatedAt: '2026-09-23T00:00:00.000Z' };

  it('carries the forecast through to the page state — without this the queue badge can never render', () => {
    const result = validateApprovalsGroupedData({ ...base, promptInjection: { budget: 2000, usedChars: 1940, truncated: true } });
    expect(result).not.toBeNull();
    expect(result?.promptInjection).toEqual({ budget: 2000, usedChars: 1940, truncated: true });
  });

  it('degrades a malformed forecast to absent instead of rejecting the payload', () => {
    const malformed = validateApprovalsGroupedData({ ...base, promptInjection: { budget: 0 } });
    expect(malformed).not.toBeNull();
    expect(malformed?.promptInjection).toBeUndefined();
    expect(validateApprovalsGroupedData(base)?.promptInjection).toBeUndefined();
  });
});
