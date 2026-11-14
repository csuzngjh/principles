// @vitest-environment jsdom
/**
 * PRI-1210: the durable degraded-enforcement marker must reach the page.
 *
 * The reader existing is not the fix — the Owner's bar is "state on screen,
 * and an unreadable marker is never rendered as healthy". These mount the REAL
 * ActivationPage and the REAL wire validator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ActivationPage } from '../../src/ui/pages/activation/ActivationPage.js';

const { mockFetchAllActivations, tStub, i18nStub } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'pages.activation.enforcement.healthy': 'Rule enforcement: normal — no degraded-enforcement marker for this workspace.',
    'pages.activation.enforcement.degradedTitle': 'Rule enforcement is degraded (recorded)',
    'pages.activation.enforcement.degradedBody': 'The RuleHost gate fail-opened for this workspace.',
    'pages.activation.enforcement.unknownTitle': 'Rule enforcement state is unknown',
    'pages.activation.enforcement.unknownBody': 'The degraded-enforcement marker exists but could not be read.',
    'pages.activation.enforcement.unknownNoData': 'The server did not report the enforcement state.',
    'pages.activation.enforcement.reason': 'Reason',
    'pages.activation.enforcement.firstSeenAt': 'First recorded',
    'pages.activation.enforcement.lastSeenAt': 'Last recorded',
    'pages.activation.enforcement.occurrences': 'Recorded occurrences',
    'pages.activation.enforcement.unreadableReason': 'Marker unreadable',
    'pages.activation.enforcement.nextAction': 'Next action',
    'pages.activation.enforcement.markerPath': 'Marker file',
  };
  const t = (key: string, options?: Record<string, unknown>) => {
    const template = translations[key] ?? (options?.['defaultValue'] as string | undefined) ?? key;
    return Object.entries(options ?? {}).reduce(
      (acc, [name, value]) => (name === 'defaultValue' ? acc : acc.replaceAll(`{{${name}}}`, String(value))),
      template,
    );
  };
  return { mockFetchAllActivations: vi.fn(), tStub: t, i18nStub: { language: 'en' } };
});

vi.mock('../../src/ui/api.js', () => ({
  fetchAllActivations: (...args: unknown[]) => mockFetchAllActivations(...args),
  fetchReceiptCounts: vi.fn(async () => ({ success: false, error: 'mock: receipts' })),
  fetchLifecycleMetrics: vi.fn(async () => ({ success: false, error: 'mock: lifecycle' })),
  fetchOwnerDecisionLibrary: vi.fn(async () => ({ success: false, error: 'mock: library' })),
  fetchCompatibilityScan: vi.fn(async () => ({ success: false, error: 'mock: scan' })),
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
  mockFetchAllActivations.mockReset();
});

function renderPage() {
  return render(createElement(MemoryRouter, null, createElement(ActivationPage)));
}

describe('ActivationPage — enforcement state panel (PRI-1210)', () => {
  it('renders a healthy workspace explicitly (not by omission)', async () => {
    mockFetchAllActivations.mockResolvedValue({
      success: true,
      data: { activations: [], status: 'ok', enforcement: { state: 'healthy', markerPath: '/home/.pd/enforcement-health/degraded-x.json' } },
    });
    renderPage();
    const panel = await screen.findByTestId('enforcement-status-healthy');
    expect(panel.textContent).toContain('Rule enforcement: normal');
  });

  it('renders the recorded reason and timing for a degraded workspace', async () => {
    mockFetchAllActivations.mockResolvedValue({
      success: true,
      data: {
        activations: [],
        status: 'ok',
        enforcement: {
          state: 'degraded',
          markerPath: '/home/.pd/enforcement-health/degraded-x.json',
          reason: 'activation_db_not_found',
          firstSeenAt: '2026-09-23T00:00:00.000Z',
          lastSeenAt: '2026-09-23T01:00:00.000Z',
          occurrences: 3,
        },
      },
    });
    renderPage();
    const panel = await screen.findByTestId('enforcement-status-degraded');
    expect(panel.textContent).toContain('Rule enforcement is degraded (recorded)');
    expect(panel.textContent).toContain('activation_db_not_found');
    expect(panel.textContent).toContain('2026-09-23T00:00:00.000Z');
    expect(panel.textContent).toContain('2026-09-23T01:00:00.000Z');
    expect(panel.textContent).toContain('3');
  });

  it('renders an unreadable marker as UNKNOWN with its reason — never as healthy', async () => {
    mockFetchAllActivations.mockResolvedValue({
      success: true,
      data: {
        activations: [],
        status: 'ok',
        enforcement: {
          state: 'unknown',
          markerPath: '/home/.pd/enforcement-health/degraded-x.json',
          unreadableReason: 'marker_malformed_json',
        },
      },
    });
    renderPage();
    const panel = await screen.findByTestId('enforcement-status-unknown');
    expect(panel.textContent).toContain('Rule enforcement state is unknown');
    expect(panel.textContent).toContain('marker_malformed_json');
    expect(screen.queryByTestId('enforcement-status-healthy')).toBeNull();
  });

  it('renders UNKNOWN when the payload omits the field entirely — never healthy by absence', async () => {
    mockFetchAllActivations.mockResolvedValue({
      success: true,
      data: { activations: [], status: 'ok' },
    });
    renderPage();
    const panel = await screen.findByTestId('enforcement-status-unknown');
    expect(panel.textContent).toContain('The server did not report the enforcement state.');
    expect(screen.queryByTestId('enforcement-status-healthy')).toBeNull();
  });
});
