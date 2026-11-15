/**
 * PRI-1196 — short-lived state for the background Adaptive append.
 *
 * One turn's state lives under `<workspace>/.state`:
 *   started_<session>_<turn>.json  this turn is tracked (tool observations)
 *   job_<session>_<turn>.json      what the background process must decide
 *   result_<session>_<turn>.json   the ONE ready decision (ids only, no text)
 *   tools_<session>_<turn>.jsonl   pre/post tool observations of this turn
 *   reported_<session>_<turn>.json one-shot marker for a terminal fact
 *   ended_<session>_<turn>.json    Stop marker a late selector must observe
 *
 * The `started` marker is what keeps the ordering gate alive for the whole
 * turn: the selector withdraws the job as soon as it starts, and the result
 * does not exist until scoring ends, so "job or result exists" would leave the
 * entire scoring window unobserved (P1-1). Stop removes the turn state.
 * SessionStart cannot address one turn (its payload has no `turn_id`), so it
 * only sweeps residue above the age bound.
 *
 * Nothing here is durable governance truth: the files are bound to one
 * host-supplied `session_id` + `turn_id` and expire after a 20 s window.
 * Delivery is claimed with `renameSync`, so a replayed or concurrent
 * PostToolUse can emit at most one append.
 */
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendEventLogLine } from '@principles/core/runtime';

export const ADAPTIVE_APPEND_SCHEMA_VERSION = 1;
/** Whole-turn window for a background decision to still be usable. */
export const ADAPTIVE_APPEND_TTL_MS = 20_000;
/** Residue bound for files an abnormal exit left behind. */
export const ADAPTIVE_APPEND_MAX_AGE_MS = 10 * 60_000;
/** Bounded tool-observation tail read per PostToolUse. */
export const ADAPTIVE_APPEND_MAX_OBSERVATIONS = 64;

const PREFIX = 'pd_adaptive_append_';

function stateDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.state');
}

function keyOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function suffix(sessionId: string, turnId: string): string {
  return `${keyOf(sessionId)}_${keyOf(turnId)}`;
}

function jobPathFor(workspaceDir: string, sessionId: string, turnId: string): string {
  return path.join(stateDir(workspaceDir), `${PREFIX}job_${suffix(sessionId, turnId)}.json`);
}

function resultPathFor(workspaceDir: string, sessionId: string, turnId: string): string {
  return path.join(stateDir(workspaceDir), `${PREFIX}result_${suffix(sessionId, turnId)}.json`);
}

function toolsPathFor(workspaceDir: string, sessionId: string, turnId: string): string {
  return path.join(stateDir(workspaceDir), `${PREFIX}tools_${suffix(sessionId, turnId)}.jsonl`);
}

function reportedPathFor(workspaceDir: string, sessionId: string, turnId: string): string {
  return path.join(stateDir(workspaceDir), `${PREFIX}reported_${suffix(sessionId, turnId)}.json`);
}

function startedPathFor(workspaceDir: string, sessionId: string, turnId: string): string {
  return path.join(stateDir(workspaceDir), `${PREFIX}started_${suffix(sessionId, turnId)}.json`);
}

function endedPathFor(workspaceDir: string, sessionId: string, turnId: string): string {
  return path.join(stateDir(workspaceDir), `${PREFIX}ended_${suffix(sessionId, turnId)}.json`);
}

/**
 * Turn-scoped "track this turn" marker. Written once at UserPromptSubmit,
 * before the selector can withdraw the job, so the ordering gate keeps
 * observing Pre/PostToolUse for the whole scoring window.
 *
 * The return value is also the "at most one scoring request per turn" gate:
 * `exists` means a replayed prompt for the same turn must not spawn again.
 */
export function markAdaptiveTurnStarted(input: {workspaceDir: string; sessionId: string; turnId: string}): 'created' | 'exists' | 'failed' {
  try {
    fs.mkdirSync(stateDir(input.workspaceDir), {recursive: true});
    fs.writeFileSync(startedPathFor(input.workspaceDir, input.sessionId, input.turnId), JSON.stringify({at: Date.now()}), {flag: 'wx'});
    return 'created';
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'EEXIST') return 'exists';
    return 'failed';
  }
}

/** True while this turn may still record observations or has a decision artifact. */
export function hasAdaptiveAppendTurn(input: {workspaceDir: string; sessionId: string; turnId: string}): boolean {
  try {
    return fs.existsSync(startedPathFor(input.workspaceDir, input.sessionId, input.turnId))
      || fs.existsSync(jobPathFor(input.workspaceDir, input.sessionId, input.turnId))
      || fs.existsSync(resultPathFor(input.workspaceDir, input.sessionId, input.turnId));
  } catch {
    return false;
  }
}

/**
 * Mark the turn as finished before the cleanup. A background selector that
 * finishes after Stop checks this marker and discards its decision, so a
 * late result can never surface as this turn's outcome.
 */
export function markAdaptiveTurnEnded(input: {workspaceDir: string; sessionId: string; turnId: string}): void {
  try {
    fs.mkdirSync(stateDir(input.workspaceDir), {recursive: true});
    fs.writeFileSync(endedPathFor(input.workspaceDir, input.sessionId, input.turnId), JSON.stringify({at: Date.now()}), {flag: 'wx'});
  } catch {
    // Already marked (or unwritable): the conservative branch is unchanged.
  }
}

export function adaptiveTurnEnded(input: {workspaceDir: string; sessionId: string; turnId: string}): boolean {
  try {
    return fs.existsSync(endedPathFor(input.workspaceDir, input.sessionId, input.turnId));
  } catch {
    return false;
  }
}

export interface AdaptiveAppendHookIdentity {
  readonly entryPath: string;
  readonly mtimeMs: number;
}

/** The installed hook entry of the process that wrote the job. */
export function currentHookIdentity(): AdaptiveAppendHookIdentity | null {
  const [, entryPath] = process.argv;
  if (typeof entryPath !== 'string' || entryPath.length === 0) return null;
  try {
    return {entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs};
  } catch {
    return null;
  }
}

export interface AdaptiveAppendJob {
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workspaceDir: string;
  readonly promptContent: string;
  readonly nativeActivationIds: string[];
  readonly nativeChars: number;
  readonly budgetChars: number;
  readonly hookIdentity: AdaptiveAppendHookIdentity | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** rc-1/rc-3: strict job validation; an invalid job is unusable, never guessed. */
export function parseAdaptiveAppendJob(value: unknown): AdaptiveAppendJob | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== ADAPTIVE_APPEND_SCHEMA_VERSION) return null;
  if (!isFiniteNonNegative(value.createdAt)) return null;
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null;
  if (typeof value.turnId !== 'string' || value.turnId.length === 0) return null;
  if (typeof value.workspaceDir !== 'string' || value.workspaceDir.length === 0) return null;
  if (typeof value.promptContent !== 'string') return null;
  if (!Array.isArray(value.nativeActivationIds) || !value.nativeActivationIds.every((id) => typeof id === 'string')) return null;
  if (!isFiniteNonNegative(value.nativeChars) || !isFiniteNonNegative(value.budgetChars)) return null;
  let hookIdentity: AdaptiveAppendHookIdentity | null = null;
  if (value.hookIdentity !== null && value.hookIdentity !== undefined) {
    if (!isRecord(value.hookIdentity)
      || typeof value.hookIdentity.entryPath !== 'string'
      || typeof value.hookIdentity.mtimeMs !== 'number') return null;
    hookIdentity = {entryPath: value.hookIdentity.entryPath, mtimeMs: value.hookIdentity.mtimeMs};
  }
  return {
    schemaVersion: ADAPTIVE_APPEND_SCHEMA_VERSION,
    createdAt: value.createdAt,
    sessionId: value.sessionId,
    turnId: value.turnId,
    workspaceDir: value.workspaceDir,
    promptContent: value.promptContent,
    nativeActivationIds: [...value.nativeActivationIds],
    nativeChars: value.nativeChars,
    budgetChars: value.budgetChars,
    hookIdentity,
  };
}

export interface AdaptiveAppendTargetRef {
  readonly principleId: string;
  readonly activationId: string;
  readonly artifactId: string;
}

export interface AdaptiveAppendResult {
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly target: AdaptiveAppendTargetRef;
  readonly directiveChars: number;
  readonly nativeActivationIds: string[];
  readonly nativeChars: number;
  readonly budgetChars: number;
  readonly hookIdentity: AdaptiveAppendHookIdentity | null;
}

export function parseAdaptiveAppendResult(value: unknown): AdaptiveAppendResult | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== ADAPTIVE_APPEND_SCHEMA_VERSION) return null;
  if (!isFiniteNonNegative(value.createdAt) || !isFiniteNonNegative(value.startedAt)) return null;
  if (typeof value.sessionId !== 'string' || typeof value.turnId !== 'string') return null;
  if (!isRecord(value.target)) return null;
  const {target} = value;
  if (typeof target.principleId !== 'string' || typeof target.activationId !== 'string' || typeof target.artifactId !== 'string') return null;
  if (!isFiniteNonNegative(value.directiveChars) || !isFiniteNonNegative(value.budgetChars) || !isFiniteNonNegative(value.nativeChars)) return null;
  if (!Array.isArray(value.nativeActivationIds) || !value.nativeActivationIds.every((id) => typeof id === 'string')) return null;
  let hookIdentity: AdaptiveAppendHookIdentity | null = null;
  if (value.hookIdentity !== null && value.hookIdentity !== undefined) {
    if (!isRecord(value.hookIdentity)
      || typeof value.hookIdentity.entryPath !== 'string'
      || typeof value.hookIdentity.mtimeMs !== 'number') return null;
    hookIdentity = {entryPath: value.hookIdentity.entryPath, mtimeMs: value.hookIdentity.mtimeMs};
  }
  return {
    schemaVersion: ADAPTIVE_APPEND_SCHEMA_VERSION,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    sessionId: value.sessionId,
    turnId: value.turnId,
    target: {principleId: target.principleId, activationId: target.activationId, artifactId: target.artifactId},
    directiveChars: value.directiveChars,
    nativeActivationIds: [...value.nativeActivationIds],
    nativeChars: value.nativeChars,
    budgetChars: value.budgetChars,
    hookIdentity,
  };
}

function writeAtomic(target: string, body: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(body), mode === undefined ? undefined : {mode});
  fs.renameSync(temp, target);
}

function unlinkQuietly(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // ENOENT and an in-use file both mean "nothing to release".
  }
}

export type AdaptiveAppendJobWrite =
  | {readonly ok: true; readonly jobPath: string}
  | {readonly ok: false; readonly reason: 'already_started' | 'job_write_failed'};

/**
 * Parent side: create the job ONCE per turn, then hand it to a DETACHED
 * process. `wx` is the gate behind "at most one scoring request per turn": a
 * retried/replayed UserPromptSubmit for the same turn cannot replace the job
 * and spawn a second selector. The job carries the Owner prompt for the
 * decision request only, so the file is owner-only (0600) and is withdrawn by
 * the selector as soon as it reads it; a write that never reaches the selector
 * is removed here or aged out by the residue sweep.
 */
export function writeAdaptiveAppendJob(job: AdaptiveAppendJob): AdaptiveAppendJobWrite {
  const jobPath = jobPathFor(job.workspaceDir, job.sessionId, job.turnId);
  try {
    fs.mkdirSync(path.dirname(jobPath), {recursive: true});
    fs.writeFileSync(jobPath, JSON.stringify(job), {flag: 'wx', mode: 0o600});
    return {ok: true, jobPath};
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'EEXIST') {
      return {ok: false, reason: 'already_started'};
    }
    return {ok: false, reason: 'job_write_failed'};
  }
}

/** A job that could not be handed off must not leave the prompt on disk. */
export function discardAdaptiveAppendJob(jobPath: string): void {
  unlinkQuietly(jobPath);
}

export type AdaptiveAppendSpawnResult = {ok: true; pid: number | undefined} | {ok: false; reason: string};

/**
 * Spawn the background selector. `stdio: 'ignore'` is mandatory: a detached
 * child that inherited the hook's stdout pipe would keep that pipe open and
 * hold the host's first request until the decision finished.
 */
export function spawnAdaptiveBackgroundSelection(jobPath: string): AdaptiveAppendSpawnResult {
  try {
    const entry = fileURLToPath(new URL('../background-selection.js', import.meta.url));
    const child = spawn(process.execPath, [entry, jobPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    // Async spawn failures arrive as an 'error' event, not a throw. Without a
    // listener that event is an uncaught exception in the hook process, which
    // would break the fail-open contract; the failure is already represented by
    // the job file the residue sweep will remove.
    child.on('error', () => undefined);
    child.unref();
    if (child.pid === undefined) return {ok: false, reason: 'spawn_no_pid'};
    return {ok: true, pid: child.pid};
  } catch (error) {
    return {ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'spawn_failed'};
  }
}

/** Child side: read and immediately withdraw the job (the prompt is not kept). */
export function takeAdaptiveAppendJob(jobPath: string): AdaptiveAppendJob | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jobPath, 'utf8');
  } catch {
    return null;
  }
  try {
    fs.unlinkSync(jobPath);
  } catch {
    // The job is single-use; a leftover file is aged out by the residue sweep.
  }
  try {
    return parseAdaptiveAppendJob(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist the ONE ready decision for this turn. */
export function writeAdaptiveAppendResultFor(
  workspaceDir: string,
  result: AdaptiveAppendResult,
): void {
  writeAtomic(resultPathFor(workspaceDir, result.sessionId, result.turnId), result, 0o600);
}

/** Withdraw a result whose turn ended while it was being written. */
export function discardAdaptiveAppendResult(workspaceDir: string, sessionId: string, turnId: string): void {
  unlinkQuietly(resultPathFor(workspaceDir, sessionId, turnId));
}

export type AdaptiveAppendReady = {
  readonly status: 'ready';
  readonly result: AdaptiveAppendResult;
  readonly claimPath: string;
} | {
  readonly status: 'absent' | 'invalid' | 'expired';
  readonly reason?: string;
};

/**
 * Atomically claim the ready result. `renameSync` is the mutex: exactly one
 * concurrent consumer can move the file, so a replayed callback emits nothing.
 */
export function claimAdaptiveAppendResult(input: {
  workspaceDir: string;
  sessionId: string;
  turnId: string;
  now: number;
}): AdaptiveAppendReady {
  const resultPath = resultPathFor(input.workspaceDir, input.sessionId, input.turnId);
  const claimPath = `${resultPath}.claimed_${process.pid}_${randomUUID()}`;
  try {
    fs.renameSync(resultPath, claimPath);
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') {
      return {status: 'absent'};
    }
    return {status: 'invalid', reason: 'claim_failed'};
  }
  let parsed: AdaptiveAppendResult | null;
  try {
    parsed = parseAdaptiveAppendResult(JSON.parse(fs.readFileSync(claimPath, 'utf8')));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    unlinkQuietly(claimPath);
    return {status: 'invalid', reason: 'result_unreadable'};
  }
  if (parsed.sessionId !== input.sessionId || parsed.turnId !== input.turnId) {
    unlinkQuietly(claimPath);
    return {status: 'invalid', reason: 'identity_mismatch'};
  }
  if (!Number.isFinite(parsed.startedAt) || input.now - parsed.startedAt > ADAPTIVE_APPEND_TTL_MS) {
    unlinkQuietly(claimPath);
    return {status: 'expired', reason: 'ttl_expired'};
  }
  return {status: 'ready', result: parsed, claimPath};
}

export function releaseAdaptiveAppendClaim(claimPath: string): void {
  unlinkQuietly(claimPath);
}

export type ToolObservationPhase = 'pre' | 'post';

export interface ToolObservation {
  readonly phase: ToolObservationPhase;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly canonicalKind: string;
  /** Only meaningful for execute kinds: classifyBashRisk(...) === 'safe'. */
  readonly readOnly: boolean;
  readonly at: number;
}

export function appendToolObservation(input: {
  workspaceDir: string;
  sessionId: string;
  turnId: string;
  observation: ToolObservation;
}): void {
  const target = toolsPathFor(input.workspaceDir, input.sessionId, input.turnId);
  try {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.appendFileSync(target, `${JSON.stringify(input.observation)}\n`);
  } catch {
    // Observation loss downgrades to the conservative branch: no proof of
    // ordering means no append. Never fail the tool call.
  }
}

export function readToolObservations(input: {
  workspaceDir: string;
  sessionId: string;
  turnId: string;
}): ToolObservation[] {
  let raw: string;
  try {
    raw = fs.readFileSync(toolsPathFor(input.workspaceDir, input.sessionId, input.turnId), 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0).slice(-ADAPTIVE_APPEND_MAX_OBSERVATIONS);
  const observations: ToolObservation[] = [];
  for (const line of lines) {
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) continue;
      if (value.phase !== 'pre' && value.phase !== 'post') continue;
      if (typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string') continue;
      if (typeof value.canonicalKind !== 'string' || typeof value.readOnly !== 'boolean' || typeof value.at !== 'number') continue;
      observations.push({
        phase: value.phase,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        canonicalKind: value.canonicalKind,
        readOnly: value.readOnly,
        at: value.at,
      });
    } catch {
      continue;
    }
  }
  return observations;
}

export type AppendOrdering =
  | {readonly ok: true}
  | {readonly ok: false; readonly reason: string};

/**
 * The ordering gate:
 *   - the CURRENT call must have been observed at both boundaries — a lone
 *     post proves nothing about what happened before it;
 *   - a `write` call anywhere in this turn ends the opportunity;
 *   - an execute call that is not classified `safe`, or an unresolved kind,
 *     is "semantics unknown" and ends it too;
 *   - another call opened and not yet closed means the completion order of a
 *     parallel batch cannot be proven; a replayed post is a duplicate callback.
 */
export function evaluateAppendOrdering(
  observations: readonly ToolObservation[],
  currentToolCallId: string,
): AppendOrdering {
  if (observations.length === 0) return {ok: false, reason: 'ordering_unprovable'};
  const opened = new Set(observations.filter((entry) => entry.phase === 'pre').map((entry) => entry.toolCallId));
  const closed = new Set(observations.filter((entry) => entry.phase === 'post').map((entry) => entry.toolCallId));
  let sawCurrentPost = false;
  for (const entry of observations) {
    if (entry.toolCallId === currentToolCallId && entry.phase === 'post') {
      if (sawCurrentPost) return {ok: false, reason: 'duplicate_callback'};
      sawCurrentPost = true;
      continue;
    }
    if (entry.canonicalKind === 'write') return {ok: false, reason: 'mutating_tool_observed'};
    if (entry.canonicalKind === 'other') return {ok: false, reason: 'unknown_tool_observed'};
    if (entry.canonicalKind === 'execute' && entry.readOnly !== true) {
      return {ok: false, reason: 'unknown_tool_observed'};
    }
  }
  if (!sawCurrentPost || !opened.has(currentToolCallId) || !closed.has(currentToolCallId)) {
    return {ok: false, reason: 'ordering_unprovable'};
  }
  for (const entry of observations) {
    if (entry.phase !== 'pre') continue;
    if (entry.toolCallId === currentToolCallId) continue;
    if (!closed.has(entry.toolCallId)) return {ok: false, reason: 'parallel_order_unprovable'};
  }
  return {ok: true};
}

/** Delete every short-lived file of one turn (Stop / terminal drop). */
export function clearAdaptiveAppendTurn(input: {workspaceDir: string; sessionId: string; turnId: string}): void {
  const dir = stateDir(input.workspaceDir);
  const keys = suffix(input.sessionId, input.turnId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PREFIX) || !name.includes(keys)) continue;
    // The ended marker outlives the turn's state: a late selector reads it.
    if (name.startsWith(`${PREFIX}ended_`)) continue;
    unlinkQuietly(path.join(dir, name));
  }
}

/** Opportunistic residue sweep; bounded and age-based, never touches fresh state. */
export function clearStaleAdaptiveAppendState(workspaceDir: string, now: number): void {
  const dir = stateDir(workspaceDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).slice(0, 200);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue;
    const target = path.join(dir, name);
    try {
      if (now - fs.statSync(target).mtimeMs > ADAPTIVE_APPEND_MAX_AGE_MS) unlinkQuietly(target);
    } catch {
      continue;
    }
  }
}

/**
 * One-shot marker for a terminal fact of this turn. Returns true only to the
 * caller that created it, so concurrent hooks emit the fact once.
 */
export function claimAdaptiveReportMarker(input: {
  workspaceDir: string;
  sessionId: string;
  turnId: string;
  reason: string;
}): boolean {
  const target = reportedPathFor(input.workspaceDir, input.sessionId, input.turnId);
  try {
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, JSON.stringify({reason: input.reason, at: Date.now()}), {flag: 'wx'});
    return true;
  } catch {
    return false;
  }
}

export interface AdaptiveAppendFactInput {
  readonly stateDir: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly workspaceDir: string;
  /** `<status>:<reason>` — the UI classifies on this prefix. */
  readonly resultCode: string;
  readonly scored: boolean;
  readonly appended?: AdaptiveAppendTargetRef;
  readonly budget: number;
  readonly injectedCharCount: number;
}

/**
 * The console reads `runtime_v2_prompt_activations_injected` with an
 * `adaptive` fact. "Background selected" is emitted with empty arrays (no
 * injection claim); "appended" carries exactly the one principle that was
 * added to the later request.
 */
export function appendAdaptiveAppendFact(input: AdaptiveAppendFactInput): void {
  const {appended} = input;
  const data = {
    eventId: randomUUID(),
    sessionId: input.sessionId,
    runId: input.turnId,
    workspaceDir: input.workspaceDir,
    principleIds: appended ? [appended.principleId] : [],
    activationIds: appended ? [appended.activationId] : [],
    artifactIds: appended ? [appended.artifactId] : [],
    injectedCount: appended ? 1 : 0,
    skippedWarnings: [],
    injectedCharCount: input.injectedCharCount,
    budget: input.budget,
    hostKind: 'codex' as const,
    adaptive: {
      resultCode: input.resultCode.slice(0, 240),
      scored: input.scored,
      ...(appended ? {appendedActivationId: appended.activationId} : {}),
    },
  };
  appendEventLogLine(input.stateDir, {
    ts: new Date().toISOString(),
    type: 'runtime_v2_prompt_activations_injected',
    category: 'injected',
    sessionId: input.sessionId,
    data,
  });
}
