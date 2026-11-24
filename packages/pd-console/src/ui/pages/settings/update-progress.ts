/**
 * Update progress view model — what the page says about an update in flight.
 *
 * Pure on purpose: no React and no clock of its own (`nowMs` is a parameter),
 * so every rule here is unit-tested in node and the page only renders the
 * result.
 *
 * The transaction journal announces the installer's stages in the installer's
 * vocabulary — planned, downloaded, verified, staged, activated, confirmed —
 * and says nothing about how far along the current one is. A three-minute
 * download spent entirely in `planned` reads as "hung" unless the page says
 * more. This module turns (journal state, the installer's progress
 * observation, the time) into the four stages an Owner recognises, plus the
 * one number that says the stage is moving.
 */

import type { UpdateTransactionProgress } from '../../utils/validators.js';

/** The stages an update goes through, in order. "Done" is not a stage: it ends the panel. */
export const UPDATE_STAGES = ['download', 'verify', 'deploy', 'finalize'] as const;
export type UpdateStage = (typeof UPDATE_STAGES)[number];

/**
 * Which stage a journal state belongs to. A state is announced when the
 * stage BEFORE it has finished, so a state names the stage now running:
 * `planned` is written right before the download starts, `downloaded` right
 * before verification, and so on. Terminal states and anything unknown map to
 * null — the page handles an ended or unreadable transaction separately.
 */
const STATE_STAGE: Readonly<Record<string, UpdateStage>> = {
  planned: 'download',
  downloaded: 'verify',
  verified: 'deploy',
  staged: 'finalize',
  probed: 'finalize',
  activated: 'finalize',
  host_verified: 'finalize',
};

export function stageOfState(lastState: string | null): UpdateStage | null {
  if (lastState === null || !Object.hasOwn(STATE_STAGE, lastState)) return null;
  const stage: UpdateStage | undefined = STATE_STAGE[lastState];
  return stage ?? null;
}

export interface TransferSample {
  readonly atMs: number;
  readonly bytes: number;
}

export interface TransferRate {
  readonly bytesPerSecond: number;
  /** Null while the rate is not measurable (no movement yet, or no total known). */
  readonly remainingMs: number | null;
}

/**
 * Transfer rate between two byte samples. A rate measured over a fraction of
 * a second jumps with every network hiccup; the caller picks the earlier
 * sample far enough back for the number to be steady.
 */
export function measureTransfer(previous: TransferSample, current: TransferSample, bytesTotal?: number): TransferRate {
  const seconds = (current.atMs - previous.atMs) / 1000;
  if (!(seconds > 0)) return { bytesPerSecond: 0, remainingMs: null };
  const bytesPerSecond = Math.max(0, (current.bytes - previous.bytes) / seconds);
  const remainingMs = bytesPerSecond > 0 && bytesTotal !== undefined && bytesTotal >= current.bytes
    ? Math.round(((bytesTotal - current.bytes) / bytesPerSecond) * 1000)
    : null;
  return { bytesPerSecond, remainingMs };
}

export interface UpdateProgressView {
  readonly stage: UpdateStage | null;
  /** Position in UPDATE_STAGES; -1 while the stage is unknown. */
  readonly stageIndex: number;
  /** What the bar shows for the current stage, 0–100; null when it cannot be measured. */
  readonly percent: number | null;
  readonly elapsedMs: number;
  /** Time spent in the current stage — the number that proves a quiet stage is alive. */
  readonly stageElapsedMs: number;
  /** Download figures, only while they are known. */
  readonly bytes: {
    readonly received: number;
    readonly total: number;
    readonly perSecond: number | null;
    readonly remainingMs: number | null;
  } | null;
  /** The installer's own words for what it is doing (technical detail). */
  readonly step: string | null;
}

export interface UpdateProgressInput {
  readonly lastState: string | null;
  readonly startedAt: string | null;
  readonly lastAt: string | null;
  readonly progress: UpdateTransactionProgress | null;
  readonly nowMs: number;
  /** An earlier download sample to measure the rate from; omit for no rate. */
  readonly transferFrom?: TransferSample | null;
}

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function describeUpdateProgress(input: UpdateProgressInput): UpdateProgressView {
  const { progress, nowMs } = input;
  const stage = stageOfState(input.lastState);
  const startedMs = timestampMs(input.startedAt);
  const elapsedMs = startedMs === null ? 0 : Math.max(0, nowMs - startedMs);
  // The download stage begins with the transaction; every later stage begins
  // when the journal announces it.
  const stageStartedMs = stage === 'download' ? startedMs : timestampMs(input.lastAt) ?? startedMs;
  const stageElapsedMs = stageStartedMs === null ? 0 : Math.max(0, nowMs - stageStartedMs);

  let percent: number | null = null;
  let bytes: UpdateProgressView['bytes'] = null;
  if (stage === 'download' && progress?.bytesReceived !== undefined && progress.bytesTotal !== undefined) {
    const { bytesReceived, bytesTotal } = progress;
    percent = Math.floor((bytesReceived / bytesTotal) * 100);
    const rate = input.transferFrom === undefined || input.transferFrom === null
      ? { bytesPerSecond: 0, remainingMs: null }
      : measureTransfer(input.transferFrom, { atMs: nowMs, bytes: bytesReceived }, bytesTotal);
    bytes = {
      received: bytesReceived,
      total: bytesTotal,
      // A rate of zero means "not measurable", not "stalled": one sample is no sample.
      perSecond: rate.bytesPerSecond > 0 ? rate.bytesPerSecond : null,
      remainingMs: rate.remainingMs,
    };
  } else if ((stage === 'deploy' || stage === 'finalize') && progress?.percent !== undefined) {
    percent = Math.floor(progress.percent);
  }

  return {
    stage,
    stageIndex: stage === null ? -1 : UPDATE_STAGES.indexOf(stage),
    percent,
    elapsedMs,
    stageElapsedMs,
    bytes,
    step: progress?.step ?? null,
  };
}

const BINARY_UNIT = 1024;

/** `512 B`, `96.3 MB`, `1.50 GB` — binary units; one decimal from MB up, none below. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < BINARY_UNIT) return `${Math.round(bytes)} B`;
  const kilobytes = bytes / BINARY_UNIT;
  if (kilobytes < BINARY_UNIT) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / BINARY_UNIT;
  if (megabytes < BINARY_UNIT) return `${megabytes.toFixed(1)} MB`;
  return `${(megabytes / BINARY_UNIT).toFixed(2)} GB`;
}

/** `03:27`, `1:02:03`. Minutes are padded so the digits do not dance. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
