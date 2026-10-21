import fs from 'node:fs';
import path from 'node:path';
import {
  PROMPT_BUDGET_POLICY_VERSION,
  RUNTIME_V2_PRINCIPLE_BUDGET,
  isValidContextWindowTokens,
  promptBudgetCharsForContextWindow,
  type PromptBudgetCapacitySource,
  type PromptBudgetCapacityStatus,
  type PromptBudgetFallbackReason,
  type PromptBudgetResolution,
} from '@principles/core/runtime-v2';
import {
  isPromptInjectionTargetHost,
  type PromptInjectionTargetHost,
} from './prompt-injection-projection.js';

/**
 * PRI-1017: runtime budget OBSERVATION read model over the EXISTING
 * injection-event JSONL (`<workspaceDir>/{.pd,.state}/logs/events_<date>.jsonl`,
 * written by the OpenClaw EventLog and the Codex/WorkBuddy shared path via
 * appendEventLogLine).
 *
 * Why this exists: SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1 forbids the
 * actual injection from running a dynamic budget while the Console forecasts
 * under a different fixed 2000-char budget. The console holds no live host
 * facts, but the RUNTIME persists the resolution it actually used —
 * `runtime_v2_prompt_activations_injected` carries budgetChars, capacity
 * provenance and hostKind. This module reads those facts back so console
 * surfaces forecast under the same budget the last real injection used.
 *
 * Honesty rules this model enforces (SPEC §6.1/§7):
 * - An observation is a FACT ABOUT THE PAST, never a live claim: callers must
 *   surface `observedAt`; the console labels it "most recent runtime
 *   observation", not a current confirmation.
 * - No logs / no budget facts ⇒ absent, never a fabricated window; the caller
 *   keeps the honest fixed-fallback policy.
 * - A latest observation older than RUNTIME_BUDGET_OBSERVATION_MAX_AGE_MS is
 *   `stale` — the caller must NOT present it as the current budget.
 * - Observations bind to ONE host: OpenClaw's window is never used for a
 *   Codex or WorkBuddy forecast.
 * - Untrusted input discipline: every line is parsed as `unknown` and
 *   narrowed with typeof guards + closed-set checks; structurally invalid
 *   lines are counted in `parseFailures` and skipped loudly, never guessed.
 * - Events predating the model-aware policy carry no provenance fields; they
 *   are counted as `legacyEventsSkipped` and produce NO observation — a
 *   missing provenance field is "policy unknown", never a capacity claim.
 * - Bounded I/O: only the newest bytes of the most recent daily files are read
 *   (tail window), the file cap applying PER candidate log directory, so a
 *   runaway or crafted log cannot make a Console request read an unbounded
 *   amount of data. Only bounded budget metadata is retained and returned;
 *   other event payloads are not cached.
 */

/**
 * Candidate directories for the runtime-v2 event log, in priority order.
 * Shared with the RuleCode telemetry collector (ERR-031: both readers derive
 * from one list — the v1 EventLog writer emits `.state/logs`, no production
 * code ever created `.pd/logs`).
 */
export const RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS: readonly string[] = ['.pd/logs', '.state/logs'];

/**
 * Bounded I/O: only the most recent daily files are scanned — PER candidate
 * log directory (`RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS`), not globally. The
 * cap is deliberately per directory: both directories describe the same
 * workspace's log convention and either can hold the newest event for a given
 * host (the reader takes latest-wins ACROSS them), so a global cap would let
 * one directory's files starve the other and drop a live host observation.
 * Worst case per read is therefore `RUNTIME_BUDGET_OBSERVATION_MAX_FILES ×
 * RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS.length` files (14 today) and the same
 * count × `RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES` bytes (56 MiB today).
 */
export const RUNTIME_BUDGET_OBSERVATION_MAX_FILES = 7;

/**
 * Bounded I/O: per file, only the newest bytes are read. The writer appends,
 * so the latest observation per host lives at the TAIL; a file larger than
 * this window is tail-read and its older prefix skipped (counted in
 * `truncatedFiles`) instead of materialising an unbounded log in the console
 * process. 4 MiB is ~3.4x the largest real day observed on 2026-10-21
 * (WorkBuddy 1.17 MiB, Codex 0.87 MiB, OpenClaw 0.98 MiB across 7 files).
 */
export const RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Maximum age of an observation that may be presented as a CURRENT runtime
 * fact. The runtime refreshes the observation on every prompt build, so an
 * active workspace holds minute-old facts; beyond a day the model may have
 * been switched and the window is no longer evidence about the present.
 */
export const RUNTIME_BUDGET_OBSERVATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Clock-skew allowance for event timestamps. A writer clock ahead of ours is
 * normal; an observation further in the future is not a fact about the
 * present and must never be selected as the current budget.
 */
export const RUNTIME_BUDGET_OBSERVATION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Upper bound on the envelope `ts` string; anything longer is not a timestamp. */
const OBSERVED_AT_MAX_LENGTH = 64;

/** Console-side bounded reason: a runtime observation exists but is too old. */
export const RUNTIME_BUDGET_OBSERVATION_STALE_REASON = 'runtime_budget_observation_stale' as const;

export interface RuntimePromptBudgetObservation {
  /** The workspace the observed event was bound to (event `data.workspaceDir`). */
  workspaceDir: string;
  /** Host that produced the observation; observations never cross hosts. */
  hostKind: PromptInjectionTargetHost;
  /** Budget the real injection ran under (UTF-16 code units). */
  budgetChars: number;
  capacitySource: PromptBudgetCapacitySource;
  capacityStatus: PromptBudgetCapacityStatus;
  /** The context window the budget derived from; null when unknown. */
  contextWindowTokens: number | null;
  /** Bounded fallback reason carried by the event; null when confirmed. */
  fallbackReason: PromptBudgetFallbackReason | null;
  /** Policy version the observed budget was computed under (closed literal). */
  policyVersion: typeof PROMPT_BUDGET_POLICY_VERSION | null;
  /** ISO timestamp of the observed event (`ts` envelope field). */
  observedAt: string;
}

export interface RuntimeBudgetObservationReport {
  /** Latest observation per host (most recent by event `ts`). */
  observations: RuntimePromptBudgetObservation[];
  filesRead: string[];
  lines: number;
  parseFailures: number;
  /** Injection events without model-aware budget provenance (pre-policy events). */
  legacyEventsSkipped: number;
  /** Injection events whose budget policy version differs from the current one. */
  foreignPolicyEventsSkipped: number;
  /**
   * Files larger than the bounded read window whose older prefix was skipped.
   * Non-zero means `lines`/skip counters describe the read window only.
   */
  truncatedFiles: number;
  note: string;
}

export type RuntimeBudgetObservationSelection =
  | { kind: 'usable'; observation: RuntimePromptBudgetObservation }
  | { kind: 'stale'; observation: RuntimePromptBudgetObservation }
  | { kind: 'absent' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Windows paths are case-insensitive; compare them the way the OS does. */
function sameWorkspacePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function parseObservedAt(value: string): number | null {
  if (value.length > OBSERVED_AT_MAX_LENGTH) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const BUDGET_CAPACITY_SOURCES: ReadonlySet<string> = new Set([
  'host_effective_window',
  'pi_catalog_exact',
  'legacy_fallback',
]);

const BUDGET_CAPACITY_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'unknown']);

const BUDGET_FALLBACK_REASONS: ReadonlySet<string> = new Set([
  'host_capacity_absent',
  'host_capacity_source_untrusted',
  'host_capacity_invalid_value',
  'catalog_unavailable',
  'model_identity_absent',
  'catalog_no_exact_match',
  'catalog_no_match_for_model_id',
  'catalog_ambiguous_model_id',
  'catalog_provider_absent',
  'catalog_metadata_invalid',
]);

function isBudgetFallbackReason(value: unknown): value is PromptBudgetFallbackReason {
  return typeof value === 'string' && BUDGET_FALLBACK_REASONS.has(value);
}

/**
 * Narrow one untrusted event line into an observation, or null when it does
 * not carry a trustworthy model-aware budget fact. rc-1/rc-2: every field is
 * guarded; a structurally valid event missing provenance is NOT an
 * observation (see `legacyEventsSkipped` at the report level).
 */
function narrowObservation(parsed: unknown, workspaceDir: string, nowMs: number): RuntimePromptBudgetObservation | null {
  if (!isRecord(parsed)) return null;
  if (nonEmptyString(parsed.type) !== 'runtime_v2_prompt_activations_injected') return null;
  const observedAt = nonEmptyString(parsed.ts);
  const { data } = parsed;
  if (observedAt === undefined || !isRecord(data)) return null;
  const observedAtMs = parseObservedAt(observedAt);
  if (observedAtMs === null) return null;
  // A timestamp beyond minor clock skew is not a fact about the present; it
  // must not win the "latest observation" race or back a current forecast.
  if (observedAtMs - nowMs > RUNTIME_BUDGET_OBSERVATION_MAX_FUTURE_SKEW_MS) return null;
  // Workspace binding: the console model is workspace-scoped, so an event
  // recorded under a different workspaceDir is not this workspace's fact.
  const eventWorkspaceDir = nonEmptyString(data.workspaceDir);
  if (eventWorkspaceDir === undefined || !sameWorkspacePath(eventWorkspaceDir, workspaceDir)) return null;
  const rawHostKind = data.hostKind;
  if (!isPromptInjectionTargetHost(rawHostKind)) return null;
  const { budget } = data;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0) return null;
  // A budget computed under another policy version is not evidence about the
  // CURRENT formula. Absent provenance is pre-policy, not "current by
  // default": both are skipped, never reinterpreted.
  if (data.budgetPolicyVersion !== PROMPT_BUDGET_POLICY_VERSION) return null;
  const rawSource = data.budgetCapacitySource;
  const rawStatus = data.budgetCapacityStatus;
  if (typeof rawSource !== 'string' || !BUDGET_CAPACITY_SOURCES.has(rawSource)) return null;
  if (typeof rawStatus !== 'string' || !BUDGET_CAPACITY_STATUSES.has(rawStatus)) return null;
  const rawWindow = data.budgetContextWindowTokens;
  const rawReason = data.budgetFallbackReason;
  if (rawReason !== undefined && !isBudgetFallbackReason(rawReason)) return null;
  // Source/status/window/budget must describe ONE coherent resolution: a
  // confirmed source needs a real window and exactly the budget the shared
  // formula derives from it; the legacy fallback needs the legacy budget, no
  // window, and a bounded reason. Anything else is not a trustworthy fact.
  if (rawStatus === 'confirmed') {
    if (rawSource !== 'host_effective_window' && rawSource !== 'pi_catalog_exact') return null;
    if (!isValidContextWindowTokens(rawWindow)) return null;
    if (budget !== promptBudgetCharsForContextWindow(rawWindow)) return null;
    if (rawReason !== undefined) return null;
  } else {
    if (rawSource !== 'legacy_fallback') return null;
    if (rawWindow !== undefined) return null;
    if (!isBudgetFallbackReason(rawReason)) return null;
    if (budget !== RUNTIME_V2_PRINCIPLE_BUDGET) return null;
  }
  return {
    workspaceDir,
    hostKind: rawHostKind,
    budgetChars: budget,
    capacitySource: rawSource,
    capacityStatus: rawStatus as PromptBudgetCapacityStatus,
    contextWindowTokens: rawWindow ?? null,
    fallbackReason: rawReason ?? null,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    observedAt,
  };
}

/**
 * Read at most the newest `RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES` of a
 * log file. When the prefix is skipped, the partial first line after the cut
 * is dropped so a half-written JSON line can never be parsed. Returns null
 * when the file cannot be opened/read (the caller skips it loudly elsewhere).
 */
function readBoundedLogText(filePath: string): { text: string; truncated: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES);
    const length = size - start;
    if (length <= 0) return { text: '', truncated: false };
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    return { text, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* fd already closed */ }
  }
}

/**
 * Read the most recent budget observation per host from the workspace's
 * runtime-v2 event logs. Never throws: an unreadable log directory degrades
 * to an empty report with an explicit note (absence is UNKNOWN, not zero).
 */
export function readRuntimePromptBudgetObservations(input: {
  workspaceDir: string;
  /** Reference clock for the future-timestamp guard (tests pass a fixed one). */
  now?: Date;
}): RuntimeBudgetObservationReport {
  const { workspaceDir } = input;
  const nowMs = (input.now ?? new Date()).getTime();
  const filesRead: string[] = [];
  const lines = { count: 0 };
  const parseFailures = { count: 0 };
  const legacyEventsSkipped = { count: 0 };
  const foreignPolicyEventsSkipped = { count: 0 };
  const truncatedFiles = { count: 0 };
  const latest = new Map<PromptInjectionTargetHost, RuntimePromptBudgetObservation>();
  for (const candidate of RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS) {
    const logsRoot = path.resolve(workspaceDir, ...candidate.split('/'));
    if (!fs.existsSync(logsRoot)) continue;
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync(logsRoot);
    } catch {
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(logsRoot)
        .filter((name) => name.startsWith('events_') && name.endsWith('.jsonl'))
        .sort()
        .slice(-RUNTIME_BUDGET_OBSERVATION_MAX_FILES);
    } catch {
      // Unreadable directory contributes nothing; the note stays explicit.
      continue;
    }
    for (const name of names) {
      // Containment guard: only bare event filenames inside the resolved
      // logs root are ever read — a crafted name cannot escape the directory.
      // Canonicalize BOTH sides so an in-logs symlink cannot redirect the
      // read outside the workspace log directory (EP-08).
      const filePath = path.resolve(logsRoot, name);
      if (!filePath.startsWith(logsRoot + path.sep) || path.basename(name) !== name) continue;
      let canonicalFile: string;
      try {
        canonicalFile = fs.realpathSync(filePath);
      } catch {
        continue;
      }
      if (!canonicalFile.startsWith(canonicalRoot + path.sep)) continue;
      filesRead.push(canonicalFile);
      const bounded = readBoundedLogText(canonicalFile);
      if (bounded === null) continue;
      if (bounded.truncated) truncatedFiles.count += 1;
      for (const line of bounded.text.split('\n')) {
        if (line.trim().length === 0) continue;
        lines.count += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parseFailures.count += 1;
          continue;
        }
        if (isRecord(parsed) && parsed.type === 'runtime_v2_prompt_activations_injected' && isRecord(parsed.data)) {
          const { data } = parsed;
          const rawPolicyVersion = data.budgetPolicyVersion;
          if (rawPolicyVersion !== undefined && rawPolicyVersion !== PROMPT_BUDGET_POLICY_VERSION) {
            // A budget computed under a DIFFERENT policy version is not
            // evidence about the current formula — counted, not reinterpreted.
            foreignPolicyEventsSkipped.count += 1;
            continue;
          }
          const observation = narrowObservation(parsed, workspaceDir, nowMs);
          if (observation === null) {
            // A pre-policy event, a future/invalid timestamp, incoherent
            // provenance or an unusable binding — counted, never guessed.
            legacyEventsSkipped.count += 1;
            continue;
          }
          const previous = latest.get(observation.hostKind);
          // Compare PARSED instants, not strings: a longer/invalid timestamp
          // must not shadow a real observation lexicographically.
          if (previous === undefined || Date.parse(observation.observedAt) > Date.parse(previous.observedAt)) {
            latest.set(observation.hostKind, observation);
          }
          continue;
        }
        if (isRecord(parsed) && parsed.type === 'runtime_v2_prompt_activations_injected' && !isRecord(parsed.data)) {
          parseFailures.count += 1;
        }
      }
    }
  }
  return {
    observations: [...latest.values()],
    filesRead,
    lines: lines.count,
    parseFailures: parseFailures.count,
    legacyEventsSkipped: legacyEventsSkipped.count,
    foreignPolicyEventsSkipped: foreignPolicyEventsSkipped.count,
    truncatedFiles: truncatedFiles.count,
    note: 'observations are PAST runtime facts bound to one host; absence means UNKNOWN (never a fabricated window); events without model-aware budget provenance, or computed under a different policy version, are skipped, not reinterpreted; the bounded read takes the newest daily files per candidate log directory and files larger than the tail window are counted in truncatedFiles (older prefix skipped, newest event per host still inside the window)',
  };
}

/** Latest-wins ordering that treats unparseable timestamps as older, not newer. */
function compareObservedAt(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return Number.isFinite(rightMs) ? -1 : 0;
  if (!Number.isFinite(rightMs)) return 1;
  return leftMs - rightMs;
}

/**
 * Select the observation that may back a console forecast for `targetHost`.
 * `absent` when the host has no observation at all; `stale` when the latest
 * one is older than the freshness bound (the caller must fall back honestly).
 */
export function selectRuntimeBudgetObservation(input: {
  observations: readonly RuntimePromptBudgetObservation[];
  targetHost?: PromptInjectionTargetHost;
  now?: Date;
}): RuntimeBudgetObservationSelection {
  const now = input.now ?? new Date();
  const candidates = input.targetHost === undefined
    ? [...input.observations]
    : input.observations.filter((observation) => observation.hostKind === input.targetHost);
  let latest: RuntimePromptBudgetObservation | undefined;
  for (const candidate of candidates) {
    if (latest === undefined || compareObservedAt(candidate.observedAt, latest.observedAt) > 0) latest = candidate;
  }
  if (latest === undefined) return { kind: 'absent' };
  const observedAt = Date.parse(latest.observedAt);
  if (
    !Number.isFinite(observedAt)
    || observedAt - now.getTime() > RUNTIME_BUDGET_OBSERVATION_MAX_FUTURE_SKEW_MS
    || now.getTime() - observedAt > RUNTIME_BUDGET_OBSERVATION_MAX_AGE_MS
  ) {
    return { kind: 'stale', observation: latest };
  }
  return { kind: 'usable', observation: latest };
}

/**
 * Console-facing selection: one call gives the confirmed-host budget basis,
 * the honest stale marker, and the per-host bases for unconfirmed routes.
 * Reads the workspace's event logs; never throws.
 */
export interface ConsoleRuntimeBudgetFacts {
  /** Usable observation for the requested host (only when targetHost is given). */
  selected?: RuntimePromptBudgetObservation;
  /** Latest observation for the requested host that is too old to be current. */
  stale?: RuntimePromptBudgetObservation;
  /**
   * Usable observations per host — used for unconfirmed per-host forecasts
   * AND for a confirmed route whose host was resolved from workspace facts
   * (no request-level targetHost). Each host only ever gets its own fact.
   */
  perHost: Map<PromptInjectionTargetHost, RuntimePromptBudgetObservation>;
  /** Latest per-host observation that is too old to be presented as current. */
  stalePerHost: Map<PromptInjectionTargetHost, RuntimePromptBudgetObservation>;
}

export function selectConsoleRuntimeBudgetFacts(input: {
  workspaceDir: string;
  targetHost?: PromptInjectionTargetHost;
  now?: Date;
}): ConsoleRuntimeBudgetFacts {
  const report = readRuntimePromptBudgetObservations({ workspaceDir: input.workspaceDir, now: input.now });
  const perHost = new Map<PromptInjectionTargetHost, RuntimePromptBudgetObservation>();
  const stalePerHost = new Map<PromptInjectionTargetHost, RuntimePromptBudgetObservation>();
  for (const observation of report.observations) {
    const selection = selectRuntimeBudgetObservation({
      observations: report.observations,
      targetHost: observation.hostKind,
      now: input.now,
    });
    if (selection.kind === 'usable') perHost.set(observation.hostKind, selection.observation);
    else if (selection.kind === 'stale') stalePerHost.set(observation.hostKind, selection.observation);
  }
  if (input.targetHost === undefined) {
    return { perHost, stalePerHost };
  }
  const selection = selectRuntimeBudgetObservation({
    observations: report.observations,
    targetHost: input.targetHost,
    now: input.now,
  });
  return {
    ...(selection.kind === 'usable' ? { selected: selection.observation } : {}),
    ...(selection.kind === 'stale' ? { stale: selection.observation } : {}),
    perHost,
    stalePerHost,
  };
}

/**
 * Rebuild the budget resolution an observation stands for, so console
 * projections run under the SAME resolution shape the real injection used.
 * `fallbackDetail` is deliberately dropped: it is log-only context and never
 * rides events or console payloads.
 */
export function runtimeBudgetObservationToResolution(
  observation: RuntimePromptBudgetObservation,
): PromptBudgetResolution {
  return {
    budgetChars: observation.budgetChars,
    capacitySource: observation.capacitySource,
    capacityStatus: observation.capacityStatus,
    contextWindowTokens: observation.contextWindowTokens,
    policyVersion: observation.policyVersion ?? PROMPT_BUDGET_POLICY_VERSION,
    ...(observation.fallbackReason !== null ? { fallbackReason: observation.fallbackReason } : {}),
  };
}
