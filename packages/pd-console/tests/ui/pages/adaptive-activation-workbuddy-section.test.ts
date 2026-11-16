// @vitest-environment jsdom
/**
 * PRI-1127 — rendered behaviour of the host-scoped Adaptive Activation card.
 *
 * Mounts the REAL section with a mocked transport, so these assertions are
 * about what the Owner sees: workspace + host labelling, a toggle that writes
 * only the selected host, and result fields that come from the FINAL ASSEMBLY
 * (never from a "the model selected it" claim).
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

// Resolve keys to their last segment; surface interpolation values so the
// assertion can prove the REAL appended id reaches the page.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { id?: string }) =>
      (key.split('.').pop() ?? key) + (options?.id === undefined ? '' : `:${options.id}`),
    i18n: { language: 'en' },
  }),
}));

import { AdaptiveActivationSection } from '../../../src/ui/pages/settings/AdaptiveActivationSection.js';

function makeView(host: 'codex' | 'workbuddy', overrides: Partial<AdaptiveActivationViewData> = {}): AdaptiveActivationViewData {
  return {
    workspaceDir: 'D:/wb-workspace',
    host: {
      kind: host,
      flag: `host.${host}.adaptive_activation`,
      enabled: false,
      serviceConfigured: true,
      saved: false,
    },
    codex: { enabled: false, serviceConfigured: true, saved: false, timing: 'sync' },
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
    lastRound: null,
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

describe('AdaptiveActivationSection host scoping (PRI-1127)', () => {
  it('labels workspace + host, and switching re-reads ONLY the WorkBuddy host', async () => {
    fetchAdaptiveActivation.mockImplementation((host?: string) => Promise.resolve({
      success: true,
      data: makeView(host === 'workbuddy' ? 'workbuddy' : 'codex'),
    }));
    renderSection();

    expect(await screen.findByTestId('adaptive-workspace')).toBeTruthy();
    expect(screen.getByTestId('adaptive-workspace').textContent).toBe('D:/wb-workspace');
    expect(screen.getByTestId('adaptive-host-flag').textContent).toBe('host.codex.adaptive_activation');

    screen.getByTestId('adaptive-host-workbuddy').click();
    await waitFor(() => expect(fetchAdaptiveActivation).toHaveBeenCalledWith('workbuddy'));
    await waitFor(() => expect(screen.getByTestId('adaptive-host-flag').textContent).toBe('host.workbuddy.adaptive_activation'));
    expect(screen.getByTestId('adaptive-host-workbuddy').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('adaptive-timing')).toBeNull();
    expect(screen.getByTestId('adaptive-host-codex').getAttribute('aria-pressed')).toBe('false');
  });

  it('explains a disabled WorkBuddy integration and blocks turning AA on', async () => {
    vi.mocked(fetchAdaptiveActivation).mockImplementation(async (host) => ({
      success: true,
      data: host === 'workbuddy' ? makeView('workbuddy', {
        host: {kind: 'workbuddy', flag: 'host.workbuddy.adaptive_activation', enabled: false,
          serviceConfigured: true, saved: false, integrationEnabled: false},
      }) : makeView('codex'),
    }));
    renderSection();
    (await screen.findByTestId('adaptive-host-workbuddy')).click();
    await screen.findByTestId('adaptive-host-disabled');
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
    expect(updateAdaptiveActivation).not.toHaveBeenCalled();
  });

  it('a WorkBuddy toggle writes host=workbuddy; a Codex toggle keeps the original payload', async () => {
    const wbView = makeView('workbuddy', {
      host: { kind: 'workbuddy', flag: 'host.workbuddy.adaptive_activation', enabled: true, serviceConfigured: true, saved: true },
    });
    fetchAdaptiveActivation.mockImplementation((host?: string) => Promise.resolve({
      success: true, data: host === 'workbuddy' ? wbView : makeView('codex'),
    }));
    updateAdaptiveActivation.mockResolvedValue({ success: true, data: wbView });
    renderSection();

    (await screen.findByTestId('adaptive-host-workbuddy')).click();
    await waitFor(() => expect(screen.getByTestId('adaptive-host-flag').textContent).toBe('host.workbuddy.adaptive_activation'));
    screen.getByRole('switch').click();
    await waitFor(() => expect(updateAdaptiveActivation).toHaveBeenCalledWith({ enabled: false, host: 'workbuddy' }));

    updateAdaptiveActivation.mockClear();
    screen.getByTestId('adaptive-host-codex').click();
    await waitFor(() => expect(screen.getByTestId('adaptive-host-flag').textContent).toBe('host.codex.adaptive_activation'));
    screen.getByRole('switch').click();
    await waitFor(() => expect(updateAdaptiveActivation).toHaveBeenCalledWith({ enabled: true }));
    // No accidental WorkBuddy field on the Codex path.
    const calls = updateAdaptiveActivation.mock.calls as unknown as Record<string, unknown>[][];
    expect(calls.every((args) => args[0]?.host === undefined)).toBe(true);
  });

  it('shows appended / same-turn / independent-request fields from the FINAL ASSEMBLY', async () => {
    fetchAdaptiveActivation.mockResolvedValue({
      success: true,
      data: makeView('workbuddy', {
        host: { kind: 'workbuddy', flag: 'host.workbuddy.adaptive_activation', enabled: true, serviceConfigured: true, saved: true },
        evidence: { status: 'observed', reason: 'observed', parseFailures: 0, logFilesRead: 1 },
        lastRecord: {
          ts: '2026-11-15T02:00:00.000Z',
          runId: '01a1d4c0f7a54b0e9d2c8a6f3b5e7012',
          sessionId: 's-1',
          resultCode: 'selected:selected',
          scored: true,
          appendedActivationId: 'act-WB_DELIVERY',
          activationIds: ['act-WB_NATIVE_SCOPE', 'act-WB_DELIVERY'],
        },
        lastRound: {
          runId: '01a1d4c0f7a54b0e9d2c8a6f3b5e7012',
          appendedActivationId: 'act-WB_DELIVERY',
          activationIds: ['act-WB_NATIVE_SCOPE', 'act-WB_DELIVERY'],
          independentRequestSent: true,
          matchedBy: ['workspace', 'host', 'turn'],
        },
      }),
    });
    renderSection();

    expect(await screen.findByText('lastAppended')).toBeTruthy();
    expect(screen.getByTestId('adaptive-last-run').textContent).toBe('01a1d4c0f7a54b0e9d2c8a6f3b5e7012');
    expect(screen.getByTestId('adaptive-last-assembly').textContent).toBe('lastAssemblyAppended:act-WB_DELIVERY');
    expect(screen.getByTestId('adaptive-last-order').textContent).toBe('act-WB_NATIVE_SCOPE → act-WB_DELIVERY');
    expect(screen.getByTestId('adaptive-last-independent-request').textContent).toBe('lastIndependentRequestYes');
    // Delivery is explicitly NOT claimed by the page.
    expect(screen.getByTestId('adaptive-delivery-note').textContent).toBe('deliveryNote');
  });

  it('never shows a Codex result when the WorkBuddy host has no observation', async () => {
    fetchAdaptiveActivation.mockImplementation((host?: string) => Promise.resolve({
      success: true,
      data: host === 'workbuddy'
        ? makeView('workbuddy')
        : makeView('codex', {
            evidence: { status: 'observed', reason: 'observed', parseFailures: 0, logFilesRead: 1 },
            lastRecord: {
              ts: '2026-11-15T01:00:00.000Z', runId: 'codex-turn', sessionId: 's-1',
              resultCode: 'selected:selected', scored: true,
              appendedActivationId: 'act-CODEX', activationIds: ['act-CODEX'],
            },
          }),
    }));
    renderSection();
    expect(await screen.findByText('lastAppended')).toBeTruthy(); // Codex view has a result
    screen.getByTestId('adaptive-host-workbuddy').click();
    await waitFor(() => expect(screen.getByTestId('adaptive-last-empty')).toBeTruthy());
    expect(screen.queryByTestId('adaptive-last-run')).toBeNull();
  });

  // ── Review fixes: host-switch race conditions ────────────────────────────
  it('never renders the PREVIOUS host switch while the new host is loading', async () => {
    fetchAdaptiveActivation
      .mockResolvedValueOnce({ success: true, data: makeView('codex') })
      .mockReturnValueOnce(new Promise(() => {})); // WorkBuddy read never settles
    renderSection();

    expect((await screen.findByTestId('adaptive-host-flag')).textContent).toBe('host.codex.adaptive_activation');
    screen.getByTestId('adaptive-host-workbuddy').click();
    // The old view must be dropped IN THE SAME batch as the host change.
    await waitFor(() => expect(screen.queryByTestId('adaptive-workspace')).toBeNull());
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByTestId('adaptive-host-flag')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('locks host switching while a write is pending', async () => {
    fetchAdaptiveActivation.mockResolvedValue({ success: true, data: makeView('codex') });
    updateAdaptiveActivation.mockReturnValue(new Promise(() => {})); // write never settles
    renderSection();

    await screen.findByTestId('adaptive-host-workbuddy');
    expect(screen.getByTestId('adaptive-host-workbuddy').hasAttribute('disabled')).toBe(false);
    screen.getByRole('switch').click();
    await waitFor(() => expect(screen.getByTestId('adaptive-host-workbuddy').hasAttribute('disabled')).toBe(true));
    expect(updateAdaptiveActivation).toHaveBeenCalled();
    expect(screen.getByTestId('adaptive-host-codex').hasAttribute('disabled')).toBe(true);
  });
});
