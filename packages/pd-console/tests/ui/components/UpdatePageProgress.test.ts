// @vitest-environment jsdom
/**
 * Update page: an update in flight is narrated, never left to look hung, and
 * its end is handled without the Owner's hand.
 *
 * These tests mount the REAL page (real validators, real layout) with only the
 * API module and the page reload stubbed, the clock under test control, and pin:
 *
 * 1. The panel speaks in stages — download, verify, deploy, finish — with a
 *    progress number and the elapsed time. The journal's own state names never
 *    reach the reading path; the installer's step stays with the other
 *    technical facts, collapsed.
 * 2. A long healthy update is tracked for as long as it takes. The page's
 *    "give up" counts answers it could NOT read, not elapsed time — a
 *    10-minute update is not a timeout.
 * 3. When the transaction cannot be read for a long stretch, the page says it
 *    lost contact and offers to look again; it does not declare the update
 *    failed. A lost answer now and then is "reconnecting".
 * 4. Once the update is confirmed, who switches the console to the new release
 *    is the server's `handover`, and the page waits only for what will really
 *    happen: the console's own successor (requests that fail while it boots
 *    are not errors), the Companion on its 30-second beat, or — when nobody
 *    will — nothing: it asks for a restart at once, yet still follows one by
 *    hand. If the promised switch never comes, it asks for a restart instead
 *    of waiting forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UpdatePage } from '../../../src/ui/pages/settings/UpdatePage.js';
import { reloadPage } from '../../../src/ui/utils/page-reload.js';

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
    'pages.update.history': 'Update History',
    'pages.update.applyUpdate': 'Update Now',
    'pages.update.applyFullUpdate': 'Full Update',
    'common.technicalDetails': 'Technical details',
    'pages.update.inProgressPanel': 'Update in progress',
    'pages.update.progressPending': 'Getting the progress…',
    'pages.update.reconnecting': 'Reconnecting to the console…',
    'pages.update.retryProgress': 'Get the progress again',
    'pages.update.inProgressTimeout': 'Progress cannot be read right now.',
    'pages.update.elapsed': 'elapsed {{time}}',
    'pages.update.backgroundNote': 'The update runs in the background. You can leave this page.',
    'pages.update.backgroundNoteRestart': 'The update runs in the background. The console needs a restart afterwards.',
    'pages.update.stage.download': 'Download',
    'pages.update.stage.verify': 'Verify',
    'pages.update.stage.deploy': 'Deploy',
    'pages.update.stage.finalize': 'Finish',
    'pages.update.stageTitle.download': 'Downloading the release',
    'pages.update.stageTitle.verify': 'Verifying the release',
    'pages.update.stageTitle.deploy': 'Deploying the new version',
    'pages.update.stageTitle.finalize': 'Verifying and finishing',
    'pages.update.stageHint.download': 'This depends on your network.',
    'pages.update.stageHint.verify': 'Unpacking the release and checking its integrity.',
    'pages.update.stageHint.deploy': 'Replacing the PD components.',
    'pages.update.stageHint.finalize': 'Starting the new version for verification.',
    'pages.update.downloadReceived': '{{received}} / {{total}}',
    'pages.update.downloadRate': '{{rate}}/s',
    'pages.update.downloadRemaining': 'about {{time}} left',
    'pages.update.stepLabel': 'Installer step',
    'pages.update.switchingTitle': 'Update finished — switching to the new version',
    'pages.update.switchingHint': 'The console is restarting on the new version.',
    'pages.update.switchingCompanionTitle': 'Update finished — Companion is restarting the console',
    'pages.update.switchingCompanionHint': 'Companion restarts the console within about half a minute.',
    'pages.update.inProgressConfirmed': 'Update finished ({{version}}). Restart the console to load the new version.',
    'pages.update.fullUpdateRestartPrompt': 'The update finished, but the console is still running the previous version. Restart it.',
    'pages.update.inProgressEnded': 'Update transaction ended: {{state}}',
    'pages.update.fullUpdateSuccess': 'Full update completed.',
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
vi.mock('../../../src/ui/utils/page-reload.js', () => ({ reloadPage: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tStub, i18n: i18nStub }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('sonner', () => ({
  toast: { error: toasts.error, success: toasts.success, info: toasts.info },
}));

// ── The page's own constants (UpdatePage.tsx) ────────────────────────────────
const POLL_INTERVAL_MS = 3_000;
const UNREADABLE_POLL_CEILING = 200;
const HANDOVER_POLL_INTERVAL_MS = 1_000;
const HANDOVER_POLL_LIMIT = 30;
const COMPANION_HANDOVER_POLL_LIMIT = 90;
const MANUAL_HANDOVER_POLL_INTERVAL_MS = 3_000;
const MANUAL_HANDOVER_POLL_LIMIT = 100;

const MB = 1024 * 1024;
const PREDECESSOR = 111;
const SUCCESSOR = 222;
const SWITCHING_TEXT = 'Update finished — switching to the new version';
const COMPANION_TEXT = 'Update finished — Companion is restarting the console';
const FINISHED_TEXT = 'Update finished (2.8.11). Restart the console to load the new version.';
const RESTART_PROMPT = 'The update finished, but the console is still running the previous version. Restart it.';
const BACKGROUND_NOTE = 'The update runs in the background. You can leave this page.';
const BACKGROUND_NOTE_RESTART = 'The update runs in the background. The console needs a restart afterwards.';

type Handover = 'console' | 'companion' | 'manual';

type Answer = {
  success: true;
  data: {
    transactionId: string;
    exists: boolean;
    lastState: string;
    terminal: boolean;
    startedAt?: string;
    lastAt?: string;
    productVersion?: string;
    serverPid?: number;
    handover?: Handover;
    progress?: { at: string; step?: string; percent?: number; bytesReceived?: number; bytesTotal?: number } | null;
  };
};

const UNREADABLE: Answer = { success: true, data: { transactionId: 'update-1', exists: false, lastState: '', terminal: false } };
const REQUEST_FAILED = { success: false as const, error: 'fetch failed', status: 0 };

function answer(state: string, extra: Partial<Answer['data']> = {}): Answer {
  return { success: true, data: { transactionId: 'update-1', exists: true, lastState: state, terminal: false, ...extra } };
}

/** A confirmed update, by default on a console that hands itself over. */
function confirmed(extra: Partial<Answer['data']> = {}): Answer {
  return answer('confirmed', { terminal: true, productVersion: '2.8.11', handover: 'console', ...extra });
}

/** The journal's own timestamps for an update that began 3:27 ago. */
function journalTimes(clockMs: number): Pick<Answer['data'], 'startedAt' | 'lastAt'> {
  return {
    startedAt: new Date(clockMs - 207_000).toISOString(),
    lastAt: new Date(clockMs - 200_000).toISOString(),
  };
}

/** Let every already-queued promise continuation run, and commit what they changed. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
}

/** `count` poll intervals pass, and the page answers each of them. */
async function passPolls(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    act(() => { vi.advanceTimersByTime(POLL_INTERVAL_MS); });
    await settle();
  }
}

/** `count` handover looks pass, and the page takes each of them. */
async function passHandoverLooks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    act(() => { vi.advanceTimersByTime(HANDOVER_POLL_INTERVAL_MS); });
    await settle();
  }
}

/** `count` of the slow looks the page takes when nobody switches on its own. */
async function passManualLooks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    act(() => { vi.advanceTimersByTime(MANUAL_HANDOVER_POLL_INTERVAL_MS); });
    await settle();
  }
}

/**
 * Mounts the page and starts an update, with `transaction` answering the
 * transaction polls from the very first one. Resolves with the clock at the
 * moment the update was accepted.
 */
async function startUpdate(transaction: () => Promise<Answer>): Promise<number> {
  api.fetchUpdateStatus.mockResolvedValue({
    success: true,
    data: { currentVersion: '2.8.10', latestVersion: '2.8.11', hasUpdate: true, state: 'update_available' },
  });
  api.fetchUpdateHistory.mockResolvedValue({ success: true, data: [] });
  api.fetchUpdateRecovery.mockResolvedValue({ success: true, data: { needsRecovery: false, unfinished: [], superseded: [], broken: [], recoveryRequired: [] } });
  api.applyFullUpdate.mockResolvedValue({ success: true, data: { state: 'update_in_progress', transactionId: 'update-1' } });
  api.fetchUpdateTransaction.mockImplementation(transaction);
  const acceptedAt = Date.now();
  render(createElement(UpdatePage));
  fireEvent.click(await screen.findByText('Update Now'));
  await settle();
  fireEvent.click(screen.getByText('Full Update'));
  await settle();
  expect(api.applyFullUpdate).toHaveBeenCalledTimes(1);
  return acceptedAt;
}

const stagePosition = (stage: string): string | null | undefined =>
  screen.getByTestId('update-progress-stages').querySelector(`[data-stage="${stage}"]`)?.getAttribute('data-position');

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  for (const mock of Object.values(toasts)) mock.mockReset();
  vi.mocked(reloadPage).mockReset();
  // Intervals and the clock are the page's; dialogs and focus management keep real timers.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UpdatePage — an update in flight is narrated', () => {
  it("speaks in stages with a progress number and the elapsed time, never in the journal's state names", async () => {
    // The fake clock only moves when the test moves it, so "now" is still now
    // when the page has started the update.
    const acceptedAt = Date.now();
    let received = 0;
    await startUpdate(async () => {
      received += 12 * MB;
      return answer('planned', {
        ...journalTimes(acceptedAt),
        serverPid: PREDECESSOR,
        progress: { at: new Date().toISOString(), step: 'Downloading the release asset…', bytesReceived: received, bytesTotal: 96 * MB },
      });
    });
    await settle();

    expect(screen.getByText('Downloading the release')).toBeTruthy();
    // Four stages; the first is running, the rest are still ahead.
    expect(stagePosition('download')).toBe('current');
    expect(stagePosition('verify')).toBe('todo');
    expect(stagePosition('deploy')).toBe('todo');
    expect(stagePosition('finalize')).toBe('todo');
    expect(screen.getByText(BACKGROUND_NOTE)).toBeTruthy();
    // 12 of 96 MB, 3:27 in, and no rate yet (one sample is no sample).
    expect(screen.getByTestId('update-progress-percent').textContent).toBe('12%');
    expect(screen.getByTestId('update-progress-detail').textContent).toBe('12.0 MB / 96.0 MB');
    expect(screen.getByTestId('update-progress-elapsed').textContent).toBe('elapsed 03:27');

    // The journal's vocabulary and the installer's step are not in the reading path.
    expect(screen.queryByText(/\bplanned\b/)).toBeNull();
    const technical = screen.getByTestId('technical-details');
    expect((technical as HTMLDetailsElement).open).toBe(false);
    expect(technical.textContent).toContain('Downloading the release asset…');
    expect(technical.textContent).toContain('update-1');

    // One poll later, against the previous sample: 24 of 96 MB, 4 MB/s, 18 s left, 3:30 in.
    await passPolls();
    expect(screen.getByTestId('update-progress-percent').textContent).toBe('25%');
    expect(screen.getByTestId('update-progress-detail').textContent).toBe('24.0 MB / 96.0 MB · 4.0 MB/s · about 00:18 left');
    expect(screen.getByTestId('update-progress-elapsed').textContent).toBe('elapsed 03:30');
  });

  it('a download an older executor cannot count shows no number it does not have', async () => {
    await startUpdate(async () => answer('planned', { ...journalTimes(Date.now()), serverPid: PREDECESSOR, progress: null }));
    await settle();

    expect(screen.getByText('Downloading the release')).toBeTruthy();
    expect(screen.queryByTestId('update-progress-percent')).toBeNull();
    // What it says instead: what the stage is and why it takes the time it takes.
    expect(screen.getByTestId('update-progress-detail').textContent).toBe('This depends on your network.');
  });

  it('moves through the stages as the journal announces them, showing only what each stage can measure', async () => {
    const script = [
      answer('downloaded', { serverPid: PREDECESSOR, progress: { at: new Date().toISOString(), step: 'Extracting the release asset…' } }),
      answer('verified', { serverPid: PREDECESSOR, progress: { at: new Date().toISOString(), step: 'Installing pd-console...', percent: 61.6 } }),
      answer('activated', { serverPid: PREDECESSOR, progress: { at: new Date().toISOString(), step: 'Refreshing codex host binding...', percent: 88 } }),
    ];
    await startUpdate(async () => script.shift() ?? answer('activated', { serverPid: PREDECESSOR }));
    await settle();

    // Verifying: not measurable, so no number is invented — and still visibly alive.
    expect(screen.getByText('Verifying the release')).toBeTruthy();
    expect(screen.queryByTestId('update-progress-percent')).toBeNull();
    expect(stagePosition('download')).toBe('done');
    expect(stagePosition('verify')).toBe('current');

    await passPolls();
    expect(screen.getByText('Deploying the new version')).toBeTruthy();
    expect(screen.getByTestId('update-progress-percent').textContent).toBe('61%');

    await passPolls();
    expect(screen.getByText('Verifying and finishing')).toBeTruthy();
    expect(screen.getByTestId('update-progress-percent').textContent).toBe('88%');
    expect(stagePosition('deploy')).toBe('done');
    expect(stagePosition('finalize')).toBe('current');
  });

  it('says only that it is getting the progress until the transaction can be read', async () => {
    await startUpdate(async () => UNREADABLE);
    await settle();

    expect(screen.getByText('Update in progress')).toBeTruthy();
    expect(screen.getByText('Getting the progress…')).toBeTruthy();
    expect(screen.queryByTestId('update-progress-stages')).toBeNull();
  });
});

describe('UpdatePage — a long update is not a timeout', () => {
  it('keeps tracking a healthy update for as long as it takes, far past 200 polls', async () => {
    let percent = 0;
    await startUpdate(async () => {
      percent = Math.min(99, percent + 1);
      return answer('verified', { serverPid: PREDECESSOR, progress: { at: new Date().toISOString(), step: 'Installing pd-console...', percent } });
    });
    await settle();

    await passPolls(UNREADABLE_POLL_CEILING + 5);

    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(UNREADABLE_POLL_CEILING + 6);
    expect(screen.getByText('Deploying the new version')).toBeTruthy();
    expect(screen.queryByText('Progress cannot be read right now.')).toBeNull();
    expect(screen.queryByText(/Update transaction ended/)).toBeNull();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('after a long stretch of unreadable answers it says it lost contact — not that the update failed — and looks again on request', async () => {
    await startUpdate(async () => answer('planned', { serverPid: PREDECESSOR }));
    await settle();
    expect(screen.getByText('Downloading the release')).toBeTruthy();

    api.fetchUpdateTransaction.mockResolvedValue(UNREADABLE);
    await passPolls(UNREADABLE_POLL_CEILING);

    expect(screen.getByTestId('update-progress-unavailable').textContent).toBe('Progress cannot be read right now.');
    // Not a verdict on the update: no failure text, no error toast, and the
    // update is still considered in flight (a second one cannot be started).
    expect(screen.queryByText(/Update transaction ended/)).toBeNull();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Update Now' })).toHaveProperty('disabled', true);

    // Polling stopped on its own…
    const pollsBefore = api.fetchUpdateTransaction.mock.calls.length;
    await passPolls(3);
    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(pollsBefore);

    // …and resumes when the Owner asks.
    fireEvent.click(screen.getByRole('button', { name: 'Get the progress again' }));
    await settle();
    expect(api.fetchUpdateTransaction).toHaveBeenCalledTimes(pollsBefore + 1);
    expect(screen.queryByTestId('update-progress-unavailable')).toBeNull();
  });

  it('a lost answer now and then reads as reconnecting, and recovers by itself', async () => {
    const script = [
      answer('verified', { serverPid: PREDECESSOR }),
      UNREADABLE,
      answer('verified', { serverPid: PREDECESSOR }),
    ];
    await startUpdate(async () => script.shift() ?? answer('verified', { serverPid: PREDECESSOR }));
    await settle();
    expect(screen.getByTestId('update-progress-detail').textContent).toBe('Replacing the PD components.');

    await passPolls();
    expect(screen.getByTestId('update-progress-detail').textContent).toBe('Reconnecting to the console…');
    // The stage it last knew is still on screen: contact lost is not progress lost.
    expect(screen.getByText('Deploying the new version')).toBeTruthy();

    await passPolls();
    expect(screen.getByTestId('update-progress-detail').textContent).toBe('Replacing the PD components.');
  });
});

describe('UpdatePage — the end of an update needs no hand', () => {
  /** Starts an update whose second poll confirms it, with `predecessor` still answering. */
  async function confirmUpdate(predecessor: Answer): Promise<void> {
    const script = [answer('planned', { serverPid: PREDECESSOR }), confirmed({ serverPid: PREDECESSOR }), predecessor];
    await startUpdate(async () => script.shift() ?? predecessor);
    await settle();
    await passPolls();
    expect(await screen.findByText(SWITCHING_TEXT)).toBeTruthy();
  }

  it("once confirmed, waits for the console's successor and reloads into it", async () => {
    const script = [confirmed({ serverPid: PREDECESSOR }), confirmed({ serverPid: PREDECESSOR }), confirmed({ serverPid: SUCCESSOR })];
    await confirmUpdate(script.shift() ?? confirmed({ serverPid: PREDECESSOR }));
    api.fetchUpdateTransaction.mockImplementation(async () => script.shift() ?? confirmed({ serverPid: SUCCESSOR }));
    await passHandoverLooks(1);
    // While the same console keeps answering, the page waits.
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();

    await passHandoverLooks(1);
    // A different console process answered for the same transaction: that is
    // the new version, and the page goes there.
    expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(FINISHED_TEXT)).toBeNull();
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Update Now' })).toHaveProperty('disabled', true);
  });

  it('requests that fail while the successor boots are not errors', async () => {
    const script = [REQUEST_FAILED, REQUEST_FAILED, REQUEST_FAILED, confirmed({ serverPid: SUCCESSOR })];
    await confirmUpdate(script.shift() ?? REQUEST_FAILED);
    api.fetchUpdateTransaction.mockImplementation(async () => script.shift() ?? confirmed({ serverPid: SUCCESSOR }));

    await passHandoverLooks(2);
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(screen.getByText(SWITCHING_TEXT)).toBeTruthy();

    await passHandoverLooks(1);
    expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();
  });

  it('if the console never hands over, says so and asks for a restart instead of waiting forever', async () => {
    await confirmUpdate(confirmed({ serverPid: PREDECESSOR }));
    api.fetchUpdateStatus.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.8.11', latestVersion: '2.8.11', hasUpdate: false, state: 'up_to_date' },
    });

    await passHandoverLooks(HANDOVER_POLL_LIMIT + 2);

    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(screen.queryByText(SWITCHING_TEXT)).toBeNull();
    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
    expect(screen.getByText(RESTART_PROMPT)).toBeTruthy();
    // The installation is the new one now; no update is offered any more.
    await waitFor(() => expect(screen.queryByText('Update Now')).toBeNull());
  });

  it('a console that does not report which process it is can never be told from a successor', async () => {
    const script = [confirmed(), confirmed()];
    await confirmUpdate(script.shift() ?? confirmed());
    api.fetchUpdateTransaction.mockImplementation(async () => script.shift() ?? confirmed());

    await passHandoverLooks(HANDOVER_POLL_LIMIT + 2);

    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
  });

  it('an update that ends in any other state is reported as ended, with no handover attempted', async () => {
    await startUpdate(async () => answer('rolled_back', { terminal: true, serverPid: PREDECESSOR }));
    await settle();

    expect(await screen.findByText('Update transaction ended: rolled_back')).toBeTruthy();
    expect(screen.queryByText(SWITCHING_TEXT)).toBeNull();
    await passHandoverLooks(3);
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
  });
});

describe("UpdatePage — who switches the console is the server's word", () => {
  /** Starts an update whose second poll confirms it, with `handover` as given and the predecessor still answering. */
  async function confirmOn(handover: Handover | undefined): Promise<void> {
    const same = confirmed({ serverPid: PREDECESSOR, handover });
    const script = [answer('planned', { serverPid: PREDECESSOR, handover }), same, same];
    await startUpdate(async () => script.shift() ?? same);
    await settle();
    await passPolls();
  }

  it('a console the Companion launched is left to the Companion: the page says so, and gives it its 30-second beat', async () => {
    await confirmOn('companion');
    expect(await screen.findByText(COMPANION_TEXT)).toBeTruthy();
    expect(screen.queryByText(SWITCHING_TEXT)).toBeNull();
    api.fetchUpdateTransaction.mockImplementation(async () => confirmed({ serverPid: PREDECESSOR, handover: 'companion' }));

    // Past everything the console's own handover is given, and nothing has
    // switched — the page keeps waiting: the Companion acts on its own beat.
    await passHandoverLooks(HANDOVER_POLL_LIMIT + 5);
    expect(screen.getByText(COMPANION_TEXT)).toBeTruthy();
    expect(screen.queryByText(RESTART_PROMPT)).toBeNull();

    await passHandoverLooks(50);
    expect(screen.getByText(COMPANION_TEXT)).toBeTruthy();

    api.fetchUpdateTransaction.mockImplementation(async () => confirmed({ serverPid: SUCCESSOR, handover: 'companion' }));
    await passHandoverLooks(1);
    expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1);
  });

  it('…and asks for a restart if even the Companion never brings the new console up', async () => {
    await confirmOn('companion');
    api.fetchUpdateStatus.mockResolvedValue({
      success: true,
      data: { currentVersion: '2.8.11', latestVersion: '2.8.11', hasUpdate: false, state: 'up_to_date' },
    });

    await passHandoverLooks(COMPANION_HANDOVER_POLL_LIMIT + 5);

    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(screen.queryByText(COMPANION_TEXT)).toBeNull();
    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
    expect(screen.getByText(RESTART_PROMPT)).toBeTruthy();
  });

  it('when nobody will switch the console, the running update already says so', async () => {
    await startUpdate(async () => answer('planned', { serverPid: PREDECESSOR, handover: 'manual' }));
    await settle();

    expect(screen.getByText(BACKGROUND_NOTE_RESTART)).toBeTruthy();
    expect(screen.queryByText(BACKGROUND_NOTE)).toBeNull();
  });

  it('…and is not waited for: the restart is asked for at once, and the page is usable again', async () => {
    await confirmOn('manual');
    await settle();

    expect(screen.queryByTestId('update-switching')).toBeNull();
    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
    expect(screen.getByText(RESTART_PROMPT)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Now' })).toHaveProperty('disabled', false));
  });

  it('a server that does not say who switches is not waited for either', async () => {
    await confirmOn(undefined);

    expect(screen.queryByTestId('update-switching')).toBeNull();
    expect(await screen.findByText(FINISHED_TEXT)).toBeTruthy();
  });

  it('after asking for a restart, the page still follows one made by hand', async () => {
    await confirmOn('manual');
    api.fetchUpdateTransaction.mockImplementation(async () => confirmed({ serverPid: SUCCESSOR, handover: 'manual' }));

    // Looked for rarely: a restart by hand is not something that happens within a second.
    await passManualLooks(1);
    expect(api.fetchUpdateTransaction.mock.calls.length).toBeGreaterThan(0);
    await passManualLooks(1);
    expect(vi.mocked(reloadPage)).toHaveBeenCalledTimes(1);
  });

  it('…but not forever', async () => {
    await confirmOn('manual');
    const fetchesBefore = api.fetchUpdateTransaction.mock.calls.length;

    await passManualLooks(MANUAL_HANDOVER_POLL_LIMIT + 2);

    const fetchesAfter = api.fetchUpdateTransaction.mock.calls.length;
    expect(fetchesAfter - fetchesBefore).toBeLessThanOrEqual(MANUAL_HANDOVER_POLL_LIMIT);
    await passManualLooks(3);
    expect(api.fetchUpdateTransaction.mock.calls.length).toBe(fetchesAfter);
    expect(vi.mocked(reloadPage)).not.toHaveBeenCalled();
    expect(screen.getByText(FINISHED_TEXT)).toBeTruthy();
  });
});
