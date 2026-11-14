// @vitest-environment jsdom
/**
 * PR #2641 review — evidence tri-state must reach the RENDERED card.
 *
 * These mount the real section with a mocked transport, so the assertions are
 * about rendered behaviour (what the Owner sees), not source text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdaptiveActivationViewData } from '../../../src/ui/utils/validators.js';

const fetchAdaptiveActivation = vi.fn();
const updateAdaptiveActivation = vi.fn();

vi.mock('../../../src/ui/api.js', () => ({
  fetchAdaptiveActivation: (...args: unknown[]) => fetchAdaptiveActivation(...args),
  updateAdaptiveActivation: (...args: unknown[]) => updateAdaptiveActivation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Resolve keys to their last segment so assertions stay locale-independent.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
    i18n: { language: 'en' },
  }),
}));

import { AdaptiveActivationSection } from '../../../src/ui/pages/settings/AdaptiveActivationSection.js';

function makeView(overrides: Partial<AdaptiveActivationViewData> = {}): AdaptiveActivationViewData {
  return {
    workspaceDir: 'D:/ws-a',
    codex: { enabled: false, serviceConfigured: false, saved: false },
    service: {
      presetId: 'decisions-openrouter-respan',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: 'respan/span-01-lite:free',
      provider: 'Respan',
      responseModels: [],
      apiKeyEnv: 'OPENROUTER_API_KEY',
      credentialSeenInConsoleProcess: false,
    },
    replaceableActivationIds: [],
    appendOnlyEligible: true,
    otherHostAaEnabled: [],
    candidates: { validCount: 1, blockingWarnings: [], aborted: false, emptyState: 'ok' },
    lastRecord: null,
    evidence: { status: 'not_observed', reason: 'no_adaptive_fact', parseFailures: 0, logFilesRead: 0 },
    ...overrides,
  };
}

function renderSection() {
  return render(createElement(MemoryRouter, null, createElement(AdaptiveActivationSection)));
}

beforeEach(() => {
  fetchAdaptiveActivation.mockReset();
  updateAdaptiveActivation.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('AdaptiveActivationSection evidence states', () => {
  it('renders OBSERVED with the appended record', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({
        codex: { enabled: true, serviceConfigured: true, saved: true },
        evidence: { status: 'observed', reason: 'observed', parseFailures: 0, logFilesRead: 1 },
        lastRecord: {
          ts: '2026-11-14T01:00:00.000Z',
          runId: 't-1',
          sessionId: 's-1',
          resultCode: 'selected:selected',
          scored: true,
          appendedActivationId: 'act-GOOD',
          activationIds: ['act-GOOD'],
        },
      }),
    });
    renderSection();
    const badge = await screen.findByTestId('adaptive-observed');
    expect(badge.getAttribute('data-evidence-status')).toBe('observed');
    expect(screen.getByTestId('adaptive-observed-text').textContent).toBe('observedYes');
    expect(screen.getByText('lastAppended')).toBeTruthy();
  });

  it('renders NOT_OBSERVED as "no host call yet" only for proven absence', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({ codex: { enabled: true, serviceConfigured: true, saved: true } }),
    });
    renderSection();
    const badge = await screen.findByTestId('adaptive-observed');
    expect(badge.getAttribute('data-evidence-status')).toBe('not_observed');
    expect(screen.getByTestId('adaptive-observed-text').textContent).toBe('observedNo');
    // Proven absence is the ONLY case where "waiting for an opportunity" shows.
    expect(screen.getByText('statusNoOpportunity')).toBeTruthy();
  });

  it('renders UNKNOWN without claiming "no call", "no opportunity" or "healthy"', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({
        codex: { enabled: true, serviceConfigured: true, saved: true },
        evidence: { status: 'unknown', reason: 'logs_unreadable', parseFailures: 0, logFilesRead: 0 },
      }),
    });
    renderSection();
    const badge = await screen.findByTestId('adaptive-observed');
    expect(badge.getAttribute('data-evidence-status')).toBe('unknown');
    expect(screen.getByTestId('adaptive-observed-text').textContent).toBe('observedUnknown');

    expect(screen.getByTestId('adaptive-status-unknown')).toBeTruthy();
    expect(screen.getByText('evidenceUnknownCheckLogs')).toBeTruthy();
    expect(screen.getByText('evidenceUnknownRerun')).toBeTruthy();
    // The three forbidden claims must be absent.
    expect(screen.queryByText('statusNoOpportunity')).toBeNull();
    expect(screen.queryByText('statusHealthy')).toBeNull();
    expect(screen.queryByText('observedNo')).toBeNull();
  });

  it('renders UNKNOWN on a broken-record log without inventing a record', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({
        evidence: { status: 'unknown', reason: 'records_unreadable', parseFailures: 3, logFilesRead: 1 },
      }),
    });
    renderSection();
    await screen.findByTestId('adaptive-status-unknown');
    expect(screen.getByTestId('adaptive-last-empty')).toBeTruthy();
  });

  it('warns that evidence is incomplete when OBSERVED has parse failures', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({
        evidence: { status: 'observed', reason: 'observed_partial', parseFailures: 2, logFilesRead: 1 },
        lastRecord: {
          ts: '2026-11-14T01:00:00.000Z',
          runId: 't-1',
          sessionId: 's-1',
          resultCode: 'skipped:budget_too_small',
          scored: false,
          appendedActivationId: null,
          activationIds: [],
        },
      }),
    });
    renderSection();
    await screen.findByTestId('adaptive-evidence-partial');
    expect(screen.getByText('last_skipped')).toBeTruthy();
  });

  it('offers a retry that re-reads when evidence is unknown', async () => {
    fetchAdaptiveActivation
      .mockResolvedValueOnce({
        success: true,
        data: makeView({ evidence: { status: 'unknown', reason: 'logs_unreadable', parseFailures: 0, logFilesRead: 0 } }),
      })
      .mockResolvedValueOnce({
        success: true,
        data: makeView({ evidence: { status: 'not_observed', reason: 'no_adaptive_fact', parseFailures: 0, logFilesRead: 1 } }),
      });
    renderSection();
    await screen.findByTestId('adaptive-status-unknown');
    (await screen.findByText('retry')).click();
    await waitFor(() => expect(fetchAdaptiveActivation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('adaptive-status-unknown')).toBeNull());
  });
});

describe('AdaptiveActivationSection priority branches and actions', () => {
  it('shows the replacement-mode notice and still allows disable', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({
        codex: { enabled: true, serviceConfigured: true, saved: true },
        replaceableActivationIds: ['act-legacy'],
        appendOnlyEligible: false,
      }),
    });
    updateAdaptiveActivation.mockResolvedValue({ success: true, data: makeView({ codex: { enabled: false, serviceConfigured: true, saved: false }, replaceableActivationIds: ['act-legacy'], appendOnlyEligible: false }) });
    renderSection();
    expect(await screen.findByText('statusReplacement')).toBeTruthy();
    const toggle = screen.getByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    toggle.click();
    await waitFor(() => expect(updateAdaptiveActivation).toHaveBeenCalledWith({ enabled: false }));
  });

  it('shows the blocking-warning state with the activation link', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({ candidates: { validCount: 1, blockingWarnings: ['artifact_not_found: x'], aborted: false, emptyState: 'ok' } }),
    });
    renderSection();
    expect(await screen.findByText('statusBlocked')).toBeTruthy();
    expect(screen.getByText('goActivation')).toBeTruthy();
  });

  it('explains each zero-candidate reason', async () => {
    const cases: Array<[AdaptiveActivationViewData['candidates']['emptyState'], string]> = [
      ['zero', 'reasonZero'],
      ['prompt_disabled', 'reasonPromptDisabled'],
      ['db_missing', 'reasonDbMissing'],
      ['read_failed', 'reasonReadFailed'],
    ];
    for (const [emptyState, expected] of cases) {
      cleanup();
      fetchAdaptiveActivation.mockResolvedValue({
        success: true,
        data: makeView({ candidates: { validCount: 0, blockingWarnings: [], aborted: false, emptyState } }),
      });
      renderSection();
      expect(await screen.findByText(expected)).toBeTruthy();
    }
  });

  it('saves the fixed service preset, then enables the switch', async () => {
    fetchAdaptiveActivation.mockResolvedValue({ success: true, data: makeView() });
    updateAdaptiveActivation
      .mockResolvedValueOnce({ success: true, data: makeView({ codex: { enabled: false, serviceConfigured: true, saved: false } }) })
      .mockResolvedValueOnce({ success: true, data: makeView({ codex: { enabled: true, serviceConfigured: true, saved: true } }) });
    renderSection();

    (await screen.findByText('serviceSave')).click();
    await waitFor(() => expect(updateAdaptiveActivation).toHaveBeenCalledWith({ service: 'decisions-openrouter-respan' }));
    expect(await screen.findByText('serviceSaved')).toBeTruthy();

    (await screen.findByRole('switch')).click();
    await waitFor(() => expect(updateAdaptiveActivation).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(screen.getByTestId('adaptive-saved').textContent).toBe('savedLabel'));
  });

  it('shows the shared-service lock and disables the service save', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView({ otherHostAaEnabled: ['openclaw'] }),
    });
    renderSection();
    expect(await screen.findByTestId('adaptive-shared-lock')).toBeTruthy();
    // The entry must not be able to rewrite the shared service config.
    expect((screen.getByText('serviceSave') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a save failure with its next action', async () => {
    const { toast } = await import('sonner');
    fetchAdaptiveActivation.mockResolvedValue({ success: true, data: makeView() });
    updateAdaptiveActivation.mockResolvedValue({ success: false, error: 'append_only_conflict', nextAction: 'fix-config' });
    renderSection();
    (await screen.findByText('serviceSave')).click();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('renders the load-failure state with a retry', async () => {
    fetchAdaptiveActivation.mockResolvedValue({ success: false, error: 'boom' });
    renderSection();
    expect(await screen.findByText('loadFailed')).toBeTruthy();
    expect(screen.getByText('retry')).toBeTruthy();
  });

  it('renders every last-result kind distinctly', async () => {
    const kinds: Array<[string, boolean, string | null, string]> = [
      ['selected:selected', true, 'act-1', 'lastAppended'],
      ['skipped:budget_too_small', false, null, 'last_skipped'],
      ['none:NO_SELECTION', true, null, 'last_abstain'],
      ['unavailable:timeout', true, null, 'last_abstain'],
      ['failed:transport', false, null, 'last_failed'],
      ['selected:selected', true, null, 'last_selected_not_applied'],
      ['needs_setup:missing', false, null, 'last_setup'],
    ];
    for (const [resultCode, scored, appendedActivationId, expected] of kinds) {
      cleanup();
      fetchAdaptiveActivation.mockResolvedValue({
        success: true,
        data: makeView({
          evidence: { status: 'observed', reason: 'observed', parseFailures: 0, logFilesRead: 1 },
          lastRecord: {
            ts: '2026-11-14T01:00:00.000Z',
            runId: 't-1',
            sessionId: 's-1',
            resultCode,
            scored,
            appendedActivationId,
            activationIds: [],
          },
        }),
      });
      renderSection();
      expect(await screen.findByText(expected)).toBeTruthy();
    }
  });
});
