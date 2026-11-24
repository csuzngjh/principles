/**
 * The update progress view model — the rules behind what the Update page says
 * while an update runs. Pure functions, so every branch is pinned directly.
 *
 * 1. The journal's state names map to the four stages an Owner recognises —
 *    and nothing else maps: a terminal or unknown state is "no stage", never a
 *    guess. (A state name like `toString` is not a stage either.)
 * 2. Each stage shows the one number that proves it is moving: bytes for the
 *    download, the installer's completion for deploy/finalize, nothing made up
 *    for verify.
 * 3. Elapsed time is measured from the journal's own timestamps, and the
 *    download stage starts with the transaction (the journal never announces it).
 * 4. A transfer rate needs two samples in time and a known total; without
 *    them it is "unknown", never zero or infinite.
 */
import { describe, expect, it } from 'vitest';
import {
  UPDATE_STAGES,
  describeUpdateProgress,
  formatBytes,
  formatElapsed,
  measureTransfer,
  stageOfState,
} from '../../src/ui/pages/settings/update-progress.js';
import type { UpdateTransactionProgress } from '../../src/ui/utils/validators.js';

const START = Date.parse('2026-11-23T07:57:34.427Z');

describe('which stage a journal state belongs to', () => {
  it('a state names the stage now running — it is announced right after the previous one finished', () => {
    expect(stageOfState('planned')).toBe('download');
    expect(stageOfState('downloaded')).toBe('verify');
    expect(stageOfState('verified')).toBe('deploy');
    for (const state of ['staged', 'probed', 'activated', 'host_verified']) {
      expect(stageOfState(state), state).toBe('finalize');
    }
  });

  it('an ended, missing or unknown state is no stage at all', () => {
    for (const state of ['confirmed', 'rolled_back', 'refused', 'failed', 'some_future_state', 'toString', 'constructor', '__proto__']) {
      expect(stageOfState(state), state).toBeNull();
    }
    expect(stageOfState(null)).toBeNull();
  });

  it('the stages run in the order an update goes through them', () => {
    expect(UPDATE_STAGES).toEqual(['download', 'verify', 'deploy', 'finalize']);
  });
});

describe('what the panel shows for the running stage', () => {
  const base = { startedAt: new Date(START).toISOString(), lastAt: new Date(START).toISOString(), nowMs: START + 207_000 };

  it('a download with byte counts shows how far along it is', () => {
    const progress: UpdateTransactionProgress = {
      at: new Date(START + 200_000).toISOString(),
      step: 'Downloading the release asset…',
      bytesReceived: 12 * 1024 * 1024,
      bytesTotal: 96 * 1024 * 1024,
    };

    const view = describeUpdateProgress({ ...base, lastState: 'planned', progress });

    expect(view).toMatchObject({ stage: 'download', stageIndex: 0, percent: 12, elapsedMs: 207_000, stageElapsedMs: 207_000, step: 'Downloading the release asset…' });
    expect(view.bytes).toMatchObject({ received: 12 * 1024 * 1024, total: 96 * 1024 * 1024, perSecond: null, remainingMs: null });
  });

  it('a download by an older executor (no byte counts) is not given a number it does not have', () => {
    const view = describeUpdateProgress({ ...base, lastState: 'planned', progress: null });

    expect(view.stage).toBe('download');
    expect(view.percent).toBeNull();
    expect(view.bytes).toBeNull();
    expect(view.elapsedMs).toBe(207_000);
  });

  it('verification is not measurable, and does not pretend to be', () => {
    const progress: UpdateTransactionProgress = { at: new Date(START + 210_000).toISOString(), step: 'Verifying the release asset…' };

    const view = describeUpdateProgress({
      startedAt: new Date(START).toISOString(),
      lastAt: new Date(START + 200_000).toISOString(),
      nowMs: START + 207_000,
      lastState: 'downloaded',
      progress,
    });

    expect(view).toMatchObject({ stage: 'verify', stageIndex: 1, percent: null, bytes: null, step: 'Verifying the release asset…', elapsedMs: 207_000 });
    // The stage began when the journal announced it, not when the transaction did.
    expect(view.stageElapsedMs).toBe(7_000);
  });

  it('deploying and finishing show the installer own completion', () => {
    const progress: UpdateTransactionProgress = { at: new Date(START).toISOString(), step: 'Installing pd-console...', percent: 61.6 };

    expect(describeUpdateProgress({ ...base, lastState: 'verified', progress })).toMatchObject({ stage: 'deploy', stageIndex: 2, percent: 61, bytes: null });
    expect(describeUpdateProgress({ ...base, lastState: 'activated', progress })).toMatchObject({ stage: 'finalize', stageIndex: 3, percent: 61, bytes: null });
  });

  it('a transaction whose start time is unknown reads as "just started", not as a NaN or a negative', () => {
    const view = describeUpdateProgress({ startedAt: null, lastAt: null, nowMs: START, lastState: 'planned', progress: null });

    expect(view).toMatchObject({ stage: 'download', elapsedMs: 0, stageElapsedMs: 0 });
  });

  it('a clock that runs backwards never shows a negative duration', () => {
    const view = describeUpdateProgress({ ...base, nowMs: START - 5000, lastState: 'planned', progress: null });

    expect(view.elapsedMs).toBe(0);
    expect(view.stageElapsedMs).toBe(0);
  });

  it('an unreadable transaction has no stage, and still shows nothing made up', () => {
    const view = describeUpdateProgress({ ...base, lastState: 'failed_somewhere_new', progress: { at: new Date(START).toISOString(), percent: 10 } });

    expect(view.stage).toBeNull();
    expect(view.stageIndex).toBe(-1);
    expect(view.percent).toBeNull();
  });
});

describe('the transfer rate', () => {
  it('is the bytes that arrived divided by the time they took', () => {
    const rate = measureTransfer({ atMs: 0, bytes: 1_000_000 }, { atMs: 4000, bytes: 5_000_000 }, 9_000_000);

    expect(rate).toEqual({ bytesPerSecond: 1_000_000, remainingMs: 4000 });
  });

  it('is unknown without a known total, without movement, or without time between the samples', () => {
    expect(measureTransfer({ atMs: 0, bytes: 10 }, { atMs: 4000, bytes: 20 })).toEqual({ bytesPerSecond: 2.5, remainingMs: null });
    expect(measureTransfer({ atMs: 0, bytes: 20 }, { atMs: 4000, bytes: 20 }, 100)).toEqual({ bytesPerSecond: 0, remainingMs: null });
    expect(measureTransfer({ atMs: 4000, bytes: 20 }, { atMs: 4000, bytes: 30 }, 100)).toEqual({ bytesPerSecond: 0, remainingMs: null });
  });

  it('never goes negative when a retry makes the count drop', () => {
    expect(measureTransfer({ atMs: 0, bytes: 500 }, { atMs: 1000, bytes: 100 }).bytesPerSecond).toBe(0);
  });

  it('a completed download has nothing left to wait for', () => {
    expect(measureTransfer({ atMs: 0, bytes: 500 }, { atMs: 1000, bytes: 1000 }, 1000).remainingMs).toBe(0);
  });

  it('reaches the view only through the earlier sample the page hands in', () => {
    const progress: UpdateTransactionProgress = { at: new Date(START).toISOString(), bytesReceived: 5_000_000, bytesTotal: 9_000_000 };

    const view = describeUpdateProgress({
      startedAt: new Date(START - 4000).toISOString(), lastAt: null, nowMs: START, lastState: 'planned', progress,
      transferFrom: { atMs: START - 4000, bytes: 1_000_000 },
    });

    expect(view.bytes).toMatchObject({ perSecond: 1_000_000, remainingMs: 4000 });
  });
});

describe('formatting for the reading path', () => {
  it('byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12.0 MB');
    expect(formatBytes(96.3 * 1024 * 1024)).toBe('96.3 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('durations, padded so the digits do not dance', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(327_000)).toBe('05:27');
    expect(formatElapsed(3723_000)).toBe('1:02:03');
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});
