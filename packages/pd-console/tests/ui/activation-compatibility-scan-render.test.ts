// @vitest-environment jsdom
/**
 * 5B-F: the rule compatibility scan block must reach the rendered page.
 *
 * The endpoint existing is not the fix — the Owner's bar is "data on screen".
 * These mount the REAL ActivationPage and the REAL wire validator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivationPage } from '../../src/ui/pages/activation/ActivationPage.js';

const { mockFetchCompatibilityScan, tStub, i18nStub } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'pages.activation.compatibilityScanTitle': 'Rule compatibility scan',
    'pages.activation.compatibilityScanStatus': 'status: {{status}} · scanned {{scanned}} active rule(s)',
    'pages.activation.compatibilityScanState.incomplete': 'scan incomplete',
    'pages.activation.compatibilityScanSample': '(sample: {{ids}})',
    'pages.activation.compatibilityScanUnscannableTitle': 'Unscannable active rules (compatibility unverified):',
    'pages.activation.compatibilityScanEmpty': 'No unscannable rows were found.',
    'pages.activation.compatibilityScanUnavailable': 'Rule compatibility scan unavailable: {{reason}}',
  };
  const t = (key: string, options?: Record<string, unknown>) => {
    const template = translations[key] ?? (options?.['defaultValue'] as string | undefined) ?? key;
    return Object.entries(options ?? {}).reduce(
      (acc, [name, value]) => (name === 'defaultValue' ? acc : acc.replaceAll(`{{${name}}}`, String(value))),
      template,
    );
  };
  return { mockFetchCompatibilityScan: vi.fn(), tStub: t, i18nStub: { language: 'en' } };
});

vi.mock('../../src/ui/api.js', () => ({
  fetchAllActivations: vi.fn(async () => ({ success: true, data: { activations: [], status: 'ok' } })),
  fetchReceiptCounts: vi.fn(async () => ({ success: false, error: 'mock: receipts' })),
  fetchLifecycleMetrics: vi.fn(async () => ({ success: false, error: 'mock: lifecycle' })),
  fetchCompatibilityScan: (...args: unknown[]) => mockFetchCompatibilityScan(...args),
  disableActivation: vi.fn(),
  fetchRuleCodeOwnerReview: vi.fn(async () => ({ success: true, data: null })),
  fetchApprovedRuleRevisionPreview: vi.fn(),
  reviseApprovedRuleOnce: vi.fn(),
  proposePromptRevision: vi.fn(),
  ruleCodeDecision: vi.fn(),
  pauseAllRuleCode: vi.fn(),
  releaseRuleCodePause: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
}));

afterEach(cleanup);

beforeEach(() => {
  // jsdom ships no `matchMedia`; ShinyText calls it inside an effect, and an
  // effect that throws unmounts the whole tree (the page then renders empty).
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
  mockFetchCompatibilityScan.mockReset();
});

function renderPage() {
  return render(createElement(MemoryRouter, null, createElement(ActivationPage)));
}

describe('ActivationPage — rule compatibility scan block (5B-F)', () => {
  it('renders the scan status and the reason-granular unscannable list', async () => {
    mockFetchCompatibilityScan.mockResolvedValue({
      success: true,
      data: {
        status: 'incomplete',
        scannedActivations: 3,
        unscannable: [{ reason: 'invalid_content_json', count: 2, sampleActivationIds: ['act-a', 'act-b'] }],
        findingsTotal: 0,
      },
    });
    renderPage();
    const block = await screen.findByTestId('compatibility-scan');
    expect(block.textContent).toContain('Rule compatibility scan');
    expect(screen.getByTestId('compatibility-scan-status').textContent).toContain('status: scan incomplete');
    expect(screen.getByTestId('compatibility-scan-status').textContent).toContain('scanned 3');
    expect(screen.getByTestId('compatibility-scan-unscannable-invalid_content_json').textContent).toContain(
      'invalid_content_json=2 (sample: act-a, act-b)',
    );
    expect(screen.queryByTestId('compatibility-scan-empty')).toBeNull();
  });

  it('shows an explicit empty state — never a blank block — when every row was scanned', async () => {
    mockFetchCompatibilityScan.mockResolvedValue({
      success: true,
      data: { status: 'clean', scannedActivations: 4, unscannable: [], findingsTotal: 0 },
    });
    renderPage();
    await screen.findByTestId('compatibility-scan');
    expect(screen.getByTestId('compatibility-scan-empty').textContent).toContain('No unscannable rows were found.');
  });

  it('degrades with a visible reason when the endpoint fails', async () => {
    mockFetchCompatibilityScan.mockResolvedValue({ success: false, error: 'compatibility_scan_failed' });
    renderPage();
    const degraded = await screen.findByTestId('compatibility-scan-degraded');
    expect(degraded.textContent).toContain('compatibility_scan_failed');
  });
});
