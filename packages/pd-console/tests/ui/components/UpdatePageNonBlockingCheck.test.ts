// @vitest-environment jsdom
/**
 * Update page: a slow or failed version check must not hold the page hostage.
 *
 * `/api/update/check` refreshes signed release metadata over the network and
 * can spend the server's whole request budget. These tests mount the REAL page
 * (real validators, real layout) with only the API module stubbed, and pin:
 *
 * 1. The first paint waits for local data only — history is readable while the
 *    check is still running, and nothing claims "up to date" before an answer.
 * 2. A failed first check shows its reason in place; history stays readable and
 *    the check can be retried.
 * 3. When an update finishes, its result stays on screen while data re-reads.
 * 4. Transaction polls never stack: one in flight at a time, each bounded by
 *    the production poll budget.
 * 5. A check that takes a while is explained in place (the page no longer sits
 *    on a skeleton that carried that explanation).
 * 6. After an update, a failed re-check does not leave the pre-update "update
 *    available" status on screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdatePage } from '../../../src/ui/pages/settings/UpdatePage.js';

const { tStub, i18nStub, api, toasts } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'common.loading': 'Loading…',
    'common.cancel': 'Cancel',
    'pages.update.title': 'Updates',
    'pages.update.currentVersion': 'Current Version',
    'pages.update.latestVersion': 'Latest Version',
    'pages.update.upToDate': 'Up to date',
    'pages.update.updateAvailable': 'Update available',
    'pages.update.checkForUpdates': 'Check for Updates',
    'pages.update.checking': 'Checking…',
    'pages.update.checkFailed': 'Update check failed. Please try again later.',
    'pages.update.loadError': 'Unable to load update data. You can try refreshing the page.',
    'pages.update.slowHint': 'Checking the installed version, available updates, and runtime state. This usually takes up to a minute.',
    'pages.update.history': 'Update History',
    'pages.update.noHistory': 'No update history available.',
    'pages.update.applyUpdate': 'Update Now',
    'pages.update.applyFullUpdate': 'Full Update',
    'pages.update.confirmFullUpdateTitle': 'Confirm Update',
    'pages.update.inProgressPanel': 'Update in progress',
    'pages.update.inProgressPhase': 'Current phase: {{phase}}',
    'pages.update.inProgressConfirmed': 'Update finished ({{version}}). Restart the console to load the new version.',
  };
  const t = (key: string, args?: Record<string, unknown>): string => {
    let text = translations[key] ?? key;
    for (const [name, value] of Object.entries(args ?? {})) {
      text = text.replace(`{{${name}}}`, String(value));
    }
    return text;
  };
  return {
    tStub: t,
    i18nStub: { language: 'en' },
    api: {
      fetchUpdateStatus: vi.fn(),
      fetchUpdateHistory: vi.fn(),
      fetchUpdateRecovery: vi.fn(),
      fetchUpdateTransaction: vi.fn(),
      applyFullUpdate: vi.fn(),
      pruneUpdateHistory: vi.fn(),
    },
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

vi.mock('../../../src/ui/api.js', () => ({
  fetchUpdateStatus: (...args: unknown[]) => api.fetchUpdateStatus(...args),
  fetchUpdateHistory: (...args: unknown[]) => api.fetchUpdateHistory(...args),
  fetchUpdateRecovery: (...args: unknown[]) => api.fetchUpdateRecovery(...args),
  fetchUpdateTransaction: (...args: unknown[]) => api.fetchUpdateTransaction(...args),
  applyFullUpdate: (...args: unknown[]) => api.applyFullUpdate(...args),
  pruneUpdateHistory: (...args: unknown[]) => api.pruneUpdateHistory(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('sonner', () => ({
  toast: { error: toasts.error, success: toasts.success, info: toasts.info },
}));

const HISTORY_ROW = '2.2.0 → 2.3.0';
const FINISHED_TEXT = 'Update finished (2.8.11). Restart the console to load the new version.';
/** The page's own poll budget (TRANSACTION_POLL_TIMEOUT_MS in UpdatePage). */
const PRODUCTION_POLL_TIMEOUT_MS = 15_000;
/** The page's own poll cadence (TRANSACTION_POLL_INTERVAL_MS in UpdatePage). */
const PRODUCTION_POLL_INTERVAL_MS = 3_000;
/** How long the page lets a check run before explaining it (CHECK_SLOW_AFTER_MS in UpdatePage). */
const PRODUCTION_CHECK_SLOW_AFTER_MS = 2_000;

type PollAnswer = { success: true; data: { transactionId: string; exists: boolean; lastState: string; terminal: boolean; productVersion?: string } };

function pollAnswer(lastState: string, terminal = false, productVersion?: string): PollAnswer {
  return {
    success: true,
    data: { transactionId: 'update-1', exists: true, lastState, terminal, ...(productVersion !== undefined ? { productVersion } : {}) },
  };
}

/** A request the server never answers. */
function pending(): Promise<never> {
  return new Promise<never>(() => {});
}

function serveLocalData(): void {
  api.fetchUpdateHistory.mockResolvedValue({
    success: true,
    data: [{
      id: 'update-1',
      timestamp: '2026-11-21T12:23:10.888Z',
      fromVersion: '2.2.0',
      toVersion: '2.3.0',
      success: true,
      kind: 'update',
    }],
  });
  api.fetchUpdateRecovery.mockResolvedValue({
    success: true,
    data: { needsRecovery: false, unfinished: [], superseded: [], broken: [], recoveryRequired: [] },
  });
}

function renderPage(): void {
  render(createElement(UpdatePage));
}

/** Let every already-queued promise continuation run, and commit what they changed. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  for (const mock of Object.values(toasts)) mock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UpdatePage — the version check never gates the page', () => {
  it('shows history while the first check is still running, and claims nothing about the version', async () => {
    api.fetchUpdateStatus.mockReturnValue(pending());
    serveLocalData();
    renderPage();

    expect(await screen.findByText(HISTORY_ROW)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true);
    // "No answer yet" is not "up to date".
    expect(screen.queryByText('Up to date')).toBeNull();
  });

  it('explains a long check in place, while the rest of the page is already readable', async () => {
    // Only the explanation timer is faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api.fetchUpdateStatus.mockReturnValue(pending());
    serveLocalData();
    renderPage();
    await settle();

    expect(screen.getByText(HISTORY_ROW)).toBeTruthy();
    expect(screen.queryByTestId('update-check-slow')).toBeNull();

    act(() => { vi.advanceTimersByTime(PRODUCTION_CHECK_SLOW_AFTER_MS); });
    await settle();

    expect(screen.getByTestId('update-check-slow')?.textContent).toContain('This usually takes up to a minute');
    expect(screen.getByText(HISTORY_ROW)).toBeTruthy();
  });

  it('shows a failed first check with its reason in place, keeps history readable, and allows a retry', async () => {
    api.fetchUpdateStatus.mockResolvedValue({ success: false, error: 'Request timeout', status: 504 });
    serveLocalData();
    renderPage();

    expect(await screen.findByText('Request timeout')).toBeTruthy();
    expect(screen.getByText('Unable to load update data. You can try refreshing the page.')).toBeTruthy();
    expect(screen.getByText(HISTORY_ROW)).toBeTruthy();
    expect(screen.queryByText('Up to date')).toBeNull();
    // The reason is on the page; a toast would say the same thing twice.
    expect(toasts.error).not.toHaveBeenCalled();

    api.fetchUpdateStatus.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.8.11', latestVersion: '2.8.11', hasUpdate: false, state: 'up_to_date' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

    expect(await screen.findByText('Up to date')).toBeTruthy();
    expect(screen.queryByText('Request timeout')).toBeNull();
  });

  it('keeps the finished-update result on screen while the page re-reads data', async () => {
    api.fetchUpdateStatus
      // Before the update: one is available.
      .mockResolvedValueOnce({
        success: true,
        data: { currentVersion: '2.8.10', latestVersion: '2.8.11', hasUpdate: true, state: 'update_available' },
      })
      // The re-read after the update never answers.
      .mockReturnValueOnce(pending());
    api.applyFullUpdate.mockResolvedValue({
      success: true,
      data: { state: 'update_in_progress', transactionId: 'update-1' },
    });
    api.fetchUpdateTransaction.mockResolvedValue(pollAnswer('confirmed', true, '2.8.11'));
    serveLocalData();
    renderPage();

    fireEvent.click(await screen.findByText('Update Now'));
    fireEvent.click(await screen.findByText('Full Update'));

    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
    // The re-read was asked for and is still outstanding...
    expect(api.fetchUpdateStatus).toHaveBeenCalledTimes(2);
    // ...yet nothing on screen gave way to a loading state.
    await settle();
    expect(screen.getByText(FINISHED_TEXT)).toBeTruthy();
    expect(screen.getByText(HISTORY_ROW)).toBeTruthy();
  });

  it('after an update, a failed re-check drops the pre-update status instead of still offering the update', async () => {
    api.fetchUpdateStatus
      // Before the update: one is available.
      .mockResolvedValueOnce({
        success: true,
        data: { currentVersion: '2.8.10', latestVersion: '2.8.11', hasUpdate: true, state: 'update_available' },
      })
      // The re-read after the update fails.
      .mockResolvedValueOnce({ success: false, error: 'Request timeout', status: 504 });
    api.applyFullUpdate.mockResolvedValue({
      success: true,
      data: { state: 'update_in_progress', transactionId: 'update-1' },
    });
    api.fetchUpdateTransaction.mockResolvedValue(pollAnswer('confirmed', true, '2.8.11'));
    serveLocalData();
    renderPage();

    fireEvent.click(await screen.findByText('Update Now'));
    fireEvent.click(await screen.findByText('Full Update'));

    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
    // The status on screen described the installation that was just replaced:
    // it must not survive the update as a still-offered "update available".
    await waitFor(() => expect(screen.queryByText('Update Now')).toBeNull());
    expect(screen.queryByText('Update available')).toBeNull();
    // The failed re-check is stated where the status would be, and announced.
    expect(await screen.findByText('Request timeout')).toBeTruthy();
    expect(toasts.error).toHaveBeenCalledWith('Update check failed. Please try again later.');
    expect(screen.getByText(FINISHED_TEXT)).toBeTruthy();
  });
});

describe('UpdatePage — transaction polls never stack', () => {
  beforeEach(() => {
    // Only the page's interval is faked; dialogs and focus management keep
    // the real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  async function startUpdate(firstPoll: () => Promise<unknown>): Promise<void> {
    api.fetchUpdateStatus.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.8.10', latestVersion: '2.8.11', hasUpdate: true, state: 'update_available' },
    });
    api.applyFullUpdate.mockResolvedValue({
      success: true,
      data: { state: 'update_in_progress', transactionId: 'update-1' },
    });
    api.fetchUpdateTransaction.mockImplementation(firstPoll);
    serveLocalData();
    renderPage();
    await settle();
    fireEvent.click(screen.getByText('Update Now'));
    await settle();
    fireEvent.click(screen.getByText('Full Update'));
    await settle();
    expect(screen.getByText('Update in progress')).toBeTruthy();
  }

  it('asks again only after the previous poll settled, and bounds every poll with the production budget', async () => {
    let answerFirstPoll: ((value: PollAnswer) => void) | undefined;
    await startUpdate(() => new Promise<PollAnswer>((resolve) => { answerFirstPoll = resolve; }));

    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(1);
    expect(api.fetchUpdateTransaction).toHaveBeenNthCalledWith(1, 'update-1', PRODUCTION_POLL_TIMEOUT_MS);

    // Three interval ticks pass while the first poll is still unanswered:
    // no second poll is sent behind it.
    act(() => { vi.advanceTimersByTime(PRODUCTION_POLL_INTERVAL_MS * 3); });
    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(1);

    api.fetchUpdateTransaction.mockResolvedValue(pollAnswer('downloaded'));
    answerFirstPoll?.(pollAnswer('planned'));
    await settle();
    expect(screen.getByText('Current phase: planned')).toBeTruthy();
    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(1);

    // The next tick finds the slot free and asks again.
    act(() => { vi.advanceTimersByTime(PRODUCTION_POLL_INTERVAL_MS); });
    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(2);
    expect(api.fetchUpdateTransaction).toHaveBeenNthCalledWith(2, 'update-1', PRODUCTION_POLL_TIMEOUT_MS);
    await settle();
    expect(screen.getByText('Current phase: downloaded')).toBeTruthy();
  });
});
