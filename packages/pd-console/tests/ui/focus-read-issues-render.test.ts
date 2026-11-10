// @vitest-environment jsdom
/**
 * 5B-E: the owner-decision list's read failures must reach the rendered page.
 *
 * PR #2480 made the server return `readIssues` (rows it could not read), but
 * the browser parser rebuilt the payload without that field, so "nothing to
 * decide" and "could not read" rendered identically. This mounts the REAL
 * FocusPage with the REAL wire parser and asserts the block is on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FocusPage } from '../../src/ui/pages/focus/FocusPage.js';

const { mockFetchOwnerDecisions, tStub, i18nStub } = vi.hoisted(() => ({
  mockFetchOwnerDecisions: vi.fn(),
  // MUST be module-stable: FocusPage's loadData depends on `t`, so a fresh
  // closure per render re-runs the effect forever (worker OOM in practice).
  tStub: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  i18nStub: { language: 'en' },
}));

vi.mock('../../src/ui/api.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Only the decisions source is stubbed cleanly; the rest degrade (the
    // section still renders, which is exactly where an incomplete list shows).
    fetchOwnerDecisions: (...args: unknown[]) => mockFetchOwnerDecisions(...args),
    fetchGovernanceQueue: vi.fn(async () => ({ success: false, error: 'mock: queue' })),
    fetchApprovalsGrouped: vi.fn(async () => ({ success: false, error: 'mock: grouped' })),
    fetchAllActivations: vi.fn(async () => ({ success: false, error: 'mock: activations' })),
    fetchRuleBindingQueue: vi.fn(async () => ({ success: false, error: 'mock: bindings' })),
    fetchGovernanceExperience: vi.fn(async () => ({ success: false, error: 'mock: experience' })),
    fetchOwnerDecisionInbox: vi.fn(async () => ({ success: false, reason: 'feature_disabled', error: 'mock: inbox' })),
  };
});

// Copy is irrelevant to reachability: resolve keys to their defaultValue.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
}));

afterEach(cleanup);

beforeEach(() => {
  // jsdom does not implement matchMedia; ShinyText reads it on mount.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  mockFetchOwnerDecisions.mockResolvedValue({
    success: true,
    data: {
      items: [],
      total: 0,
      generatedAt: '2026-11-10T00:00:00.000Z',
      readIssues: [
        {
          scope: 'rulecode_shadow',
          reason: 'owner_review_read_failed',
          count: 2,
          sampleActivationIds: ['act-a', 'act-b'],
          detail: 'database is locked',
        },
      ],
    },
  });
});

describe('FocusPage — owner decision read issues (5B-E)', () => {
  it('renders the read-issue block with reason, count, samples and detail', async () => {
    render(createElement(MemoryRouter, null, createElement(FocusPage, { featureFlags: {} })));
    const block = await screen.findByTestId('owner-decisions-read-issues');
    expect(block.getAttribute('role')).toBe('status');
    const row = await screen.findByTestId('owner-decision-read-issue-owner_review_read_failed');
    expect(row.textContent).toContain('owner_review_read_failed=2');
    expect(row.textContent).toContain('sample: act-a, act-b');
    expect(row.textContent).toContain('database is locked');
    // Keys resolve to themselves in this harness; assert the key is used.
    expect(block.textContent).toContain('pages.focus.ownerDecision.readIssuesTitle');
  });

  it('renders no read-issue block when the server reports full coverage', async () => {
    mockFetchOwnerDecisions.mockResolvedValue({
      success: true,
      data: { items: [], total: 0, generatedAt: '2026-11-10T00:00:00.000Z', readIssues: [] },
    });
    render(createElement(MemoryRouter, null, createElement(FocusPage, { featureFlags: {} })));
    await screen.findByTestId('owner-decisions-section');
    expect(screen.queryByTestId('owner-decisions-read-issues')).toBeNull();
  });
});
