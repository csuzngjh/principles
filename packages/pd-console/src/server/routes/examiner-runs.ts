/**
 * SPEC-PD-EXAMINER-001 v0.10.1 §12.3 — the minimal ASYNC execution contract
 * for console-originated runs, plus the F2 readiness surface.
 *
 * Contract (all state derives from the study's EXISTING append-only ledger —
 * `events.jsonl` — never a second execution ledger):
 *
 *   POST /studies/:id/run {mode:'host-dry-run'|'f2-real-host'}
 *     → gate → append CONSOLE_RUN_ACCEPTED {runId, mode, pid}
 *     → 202 Accepted {runId, studyId, status:'ACCEPTED'}
 *     → detached work appends CONSOLE_RUN_FINISHED | CONSOLE_RUN_FAILED
 *
 *   - one unfinished console run per study: a second POST answers 409
 *     run_in_progress (no new event, no work);
 *   - duplicate/repeat requests are therefore explicitly refused, never
 *     silently duplicated (idempotency by refusal);
 *   - a server restart leaves an ACCEPTED without a terminal event; startup
 *     recovery appends CONSOLE_RUN_ABANDONED {reason:'server_restart'} for
 *     runs whose accepting process is gone — an abandoned attempt is
 *     RESULT_UNKNOWN and is NEVER auto-retried;
 *   - f2-real-host additionally requires an APPROVED Stage R authorization
 *     bound to the frozen study BEFORE acceptance (403 otherwise) — and the
 *   runner re-verifies the same authority under the study lock per unit
 *     (this gate is a necessary condition, the runner is the authority).
 *
 * Zero-model-call guarantee: host dry-run only probes the local OpenClaw CLI
 * (`--version`), reads the frozen study and the authorization record, and
 * creates+removes a probe directory. No provider is contacted. The CLI probe
 * delegates to the lab's read-only `probeOpenClawCli()` (the same local
 * `--version` process transport creation uses) — this console module itself
 * never spawns a process and never passes an executable path derived from
 * study data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  canonicalPathSync, isJsonObject, isPathInside, isSamePath, preflightCheck, readStudyJson,
  type LabModules, type StudyRoots,
} from './examiner-executor.js';

export const CONSOLE_RUN_SCHEMA = 'examiner-console-run.v1';
export const CONSOLE_RUN_EVENT_TYPES = ['CONSOLE_RUN_ACCEPTED', 'CONSOLE_RUN_FINISHED', 'CONSOLE_RUN_FAILED', 'CONSOLE_RUN_ABANDONED'] as const;
export type ConsoleRunMode = 'host-dry-run' | 'f2-real-host';
export type ConsoleRunEventType = (typeof CONSOLE_RUN_EVENT_TYPES)[number];
export const CONSOLE_RUN_MODES: readonly ConsoleRunMode[] = ['host-dry-run', 'f2-real-host'];

/** rc-2: real runtime guard for an untrusted mode value (no `as` narrowing). */
function isConsoleRunMode(value: string): value is ConsoleRunMode {
  return CONSOLE_RUN_MODES.some((mode) => mode === value);
}

/** Directory-name allowlist for the recovery scan (same charset as study handles). */
const STUDY_DIR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ConsoleRunEvent {
  type: ConsoleRunEventType;
  schema: typeof CONSOLE_RUN_SCHEMA;
  runId: string;
  studyId: string;
  mode: ConsoleRunMode;
  acceptedAt: string;
  pid: number;
  owner: 'pd-console';
  finishedAt?: string;
  outcome?: string;
  reason?: string;
  checks?: unknown[];
}

export interface ConsoleRunState {
  runId: string;
  mode: ConsoleRunMode;
  status: 'RUNNING' | 'FINISHED' | 'FAILED' | 'ABANDONED';
  acceptedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  reason: string | null;
  /** The dry-run checklist carried by the terminal event (never re-invented). */
  checks?: unknown[];
}

// ── Secure events.jsonl access (single-fd, identity-pinned) ─────────────────

/**
 * P1-4: the study's event ledger is UNREADABLE for a reason the Owner must
 * see — a corrupt or permission-blocked ledger is never silently treated as
 * "no runs". Only a genuinely absent file (first-run condition) yields [].
 */
export class ConsoleLedgerUnreadableError extends Error {
  readonly code: 'ledger_unreadable' | 'ledger_corrupt';
  constructor(code: 'ledger_unreadable' | 'ledger_corrupt', message: string) {
    super(message);
    this.name = 'ConsoleLedgerUnreadableError';
    this.code = code;
  }
}

/**
 * SECURITY CONTRACT (P1 TOCTOU):
 *
 * `events.jsonl` is the single source of truth for console runs. Every
 * read/write goes through one file-descriptor session:
 *
 *   1. the study directory is resolved canonically and proven to live inside
 *      the WRITABLE root and outside the HISTORICAL root;
 *   2. its directory identity (dev+ino) is captured BEFORE the open;
 *   3. on Linux the directory itself is opened (O_DIRECTORY|O_NOFOLLOW) and the
 *      ledger is opened RELATIVE to that held fd via `/proc/self/fd/<n>`, so the
 *      kernel resolves the parent atomically — a path swap cannot redirect it;
 *   4. the ledger is opened with O_NOFOLLOW (no final-component link) and
 *      created exclusively (O_CREAT|O_EXCL) when absent;
 *   5. the FILE is fstat-ed and must be a regular file, and the DIRECTORY
 *      identity is re-verified through the held fd;
 *   6. the same fd performs the read/write (no path re-open), and writes loop
 *      until the whole payload is stored;
 *   7. on platforms without `/proc/self/fd` (Windows/macOS) the directory
 *      identity is re-stat-ed after the open and the file's canonical path must
 *      still be exactly `<studyReal>/events.jsonl` BEFORE any read/write —
 *      a swap is refused, never followed. This is the documented weaker
 *      mechanism; see the class comment on residual windows.
 *
 * Failure classes stay distinct and fail-closed: absent (only legitimate
 * first-run), corrupt, permission denied, symlink/junction, identity change.
 */
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
const O_DIRECTORY = typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0;
const LEDGER_READ_CHUNK = 64 * 1024;

interface DirIdentity { dev: bigint; ino: bigint; }
interface OpenedLedger { fd: number; dirFd: number | null; created: boolean; }

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? 'unknown';
}

function identityOf(target: string): DirIdentity | null {
  try {
    const stat = fs.statSync(target, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameIdentity(a: DirIdentity | null, b: DirIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

function ledgerUnreadable(message: string): Error {
  return new ConsoleLedgerUnreadableError('ledger_unreadable', message);
}

/** Resolve + prove the study directory boundary (fail-closed, never string-only). */
function resolveLedgerStudyDir(roots: StudyRoots, studyDir: string, mode: 'read' | 'append'): string {
  const studyReal = canonicalPathSync(studyDir);
  if (!studyReal) throw ledgerUnreadable('the study directory cannot be resolved to a canonical location (fail-closed)');
  // Identity, not just prefix: a directory swapped for a SIBLING inside the
  // writable root still resolves to a different basename. The console only
  // ever addresses `<root>/<studyId>`, so any mismatch is a swap, not a study.
  if (path.basename(studyReal) !== path.basename(path.resolve(studyDir))) {
    throw ledgerUnreadable('the study directory resolved to a different entry name — path swap refused (fail-closed)');
  }
  const historicalReal = canonicalPathSync(roots.historical) ?? roots.historical;
  // Historical research assets are READ-ONLY, never unwritable-unknown: the
  // status projection must still show their recorded run history. Reads are
  // allowed under the same identity/fstat contract; every append is refused.
  if (isSamePath(historicalReal, studyReal) || isPathInside(historicalReal, studyReal)) {
    if (mode === 'append') throw ledgerUnreadable('the study directory resolves inside the historical research area — writes are refused (fail-closed)');
    return studyReal;
  }
  const writableReal = canonicalPathSync(roots.writable) ?? roots.writable;
  if (!isPathInside(writableReal, studyReal)) {
    throw ledgerUnreadable('the study directory resolves outside the writable console root (fail-closed)');
  }
  return studyReal;
}

/** Linux-only atomic parent binding; null means "use the documented fallback". */
function openPinnedStudyDir(studyReal: string): number | null {
  if (process.platform !== 'linux') return null;
  try {
    return fs.openSync(studyReal, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    throw ledgerUnreadable(`the study directory cannot be opened safely (${errorCode(error)})`);
  }
}

function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch { /* already closed */ }
}

/** Remove ONLY a ledger this call created, and only through a verified parent. */
function discardCreatedLedger(dirFd: number | null, studyReal: string): void {
  try {
    const expected = path.join(studyReal, 'events.jsonl');
    if (dirFd !== null) {
      fs.unlinkSync(`/proc/self/fd/${dirFd}/events.jsonl`);
      return;
    }
    const real = canonicalPathSync(expected);
    if (real && isSamePath(real, expected)) fs.unlinkSync(real);
  } catch {
    // Leftover empty file is reported by the caller's fail-closed error.
  }
}

/**
 * Open the ledger for `read` or `append` under the identity contract above.
 * Returns null ONLY when the ledger is absent in read mode (first-run case).
 */
function openLedger(roots: StudyRoots, studyDir: string, mode: 'read' | 'append'): OpenedLedger | null {
  const studyReal = resolveLedgerStudyDir(roots, studyDir, mode);
  const dirBefore = identityOf(studyReal);
  if (!dirBefore) throw ledgerUnreadable('the study directory identity cannot be established (fail-closed)');
  const dirFd = openPinnedStudyDir(studyReal);
  const target = dirFd !== null ? `/proc/self/fd/${dirFd}/events.jsonl` : path.join(studyReal, 'events.jsonl');
  let fd: number | null = null;
  let created = false;
  try {
    if (mode === 'read') {
      try {
        fd = fs.openSync(target, fs.constants.O_RDONLY | O_NOFOLLOW);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          closeQuietly(dirFd);
          return null; // genuinely absent ledger — the only empty case
        }
        throw ledgerUnreadable(`the study event ledger cannot be opened (${errorCode(error)})`);
      }
    } else {
      try {
        fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND | O_NOFOLLOW);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          throw ledgerUnreadable(`the study event ledger cannot be opened for append (${errorCode(error)})`);
        }
        try {
          fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | O_NOFOLLOW);
          created = true;
        } catch (createError) {
          throw ledgerUnreadable(`the study event ledger cannot be created exclusively (${errorCode(createError)})`);
        }
      }
    }
    const fileStat = fs.fstatSync(fd, { bigint: true });
    if (!fileStat.isFile()) {
      throw ledgerUnreadable('the study event ledger is not a regular file (symlink or special file refused)');
    }
    if (dirFd !== null) {
      const dirStat = fs.fstatSync(dirFd, { bigint: true });
      if (!dirStat.isDirectory() || !sameIdentity({ dev: dirStat.dev, ino: dirStat.ino }, dirBefore)) {
        throw ledgerUnreadable('the study directory identity changed while the ledger was opened (fail-closed)');
      }
    } else {
      // Documented fallback (Windows/macOS): identity re-check + exact canonical
      // path of the ledger, evaluated AFTER the open and BEFORE any read/write.
      if (!sameIdentity(identityOf(studyReal), dirBefore)) {
        throw ledgerUnreadable('the study directory identity changed while the ledger was opened (fail-closed)');
      }
      const fileReal = canonicalPathSync(path.join(studyReal, 'events.jsonl'));
      if (!fileReal || !isSamePath(fileReal, path.join(studyReal, 'events.jsonl'))) {
        throw ledgerUnreadable('the study event ledger path resolves elsewhere (symlink or junction refused)');
      }
    }
    return { fd, dirFd, created };
  } catch (error) {
    if (created) discardCreatedLedger(dirFd, studyReal);
    closeQuietly(fd);
    closeQuietly(dirFd);
    throw error;
  }
}

/** Read the WHOLE ledger through the verified fd (no path re-open). */
function readAllFromFd(fd: number): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(LEDGER_READ_CHUNK);
  let position = 0;
  for (;;) {
    const readBytes = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (readBytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, readBytes)));
    position += readBytes;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Write the WHOLE payload; a short write is retried, zero progress fails closed. */
function writeAllToFd(fd: number, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < payload.length) {
    const chunk = fs.writeSync(fd, payload, written, payload.length - written);
    if (chunk <= 0) throw new Error('the study event ledger write made no progress (fail-closed)');
    written += chunk;
  }
}

export interface OwnedProbeDir { path: string; dev: bigint; ino: bigint; }
export interface StudyDirPin { real: string; dev: bigint; ino: bigint; }

/**
 * Remove the dry-run probe directory ONLY when it is still the exact plain
 * directory this run created (identity dev+ino), still resolves inside the
 * same study directory, and the study directory itself has not been swapped.
 * Any unprovable case keeps the residue and reports why — an unknown path is
 * never deleted.
 */
export function removeProbeDirIfStillOwned(probe: OwnedProbeDir, study: StudyDirPin): { removed: boolean; reason?: string } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(probe.path);
  } catch (error) {
    return { removed: false, reason: `the probe path cannot be stat-ed (${errorCode(error)})` };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { removed: false, reason: 'the probe path is no longer a plain directory' };
  }
  if (!sameIdentity(identityOf(probe.path), { dev: probe.dev, ino: probe.ino })) {
    return { removed: false, reason: 'the probe directory identity changed' };
  }
  if (!sameIdentity(identityOf(study.real), { dev: study.dev, ino: study.ino })) {
    return { removed: false, reason: 'the study directory identity changed' };
  }
  const probeReal = canonicalPathSync(probe.path);
  if (!probeReal || !isPathInside(study.real, probeReal)) {
    return { removed: false, reason: 'the probe directory no longer resolves inside the study' };
  }
  try {
    fs.rmSync(probe.path, { recursive: true, force: true });
  } catch (error) {
    return { removed: false, reason: `removal failed (${errorCode(error)})` };
  }
  try {
    fs.lstatSync(probe.path);
    return { removed: false, reason: 'the probe path still exists after removal' };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { removed: true };
    return { removed: false, reason: `post-removal verification failed (${errorCode(error)})` };
  }
}

/** Safe ledger text reader: null ONLY when the ledger is legitimately absent. */
function readLedgerText(roots: StudyRoots, studyDir: string): string | null {
  const opened = openLedger(roots, studyDir, 'read');
  if (!opened) return null;
  try {
    return readAllFromFd(opened.fd);
  } catch (error) {
    throw new ConsoleLedgerUnreadableError('ledger_unreadable', `the study event ledger could not be read (${(error as Error).message})`);
  } finally {
    closeQuietly(opened.fd);
    closeQuietly(opened.dirFd);
  }
}

/** Append one console-run lifecycle event to the study's events ledger. */
export function appendConsoleRunEvent(roots: StudyRoots, studyDir: string, event: ConsoleRunEvent): void {
  const opened = openLedger(roots, studyDir, 'append');
  if (!opened) throw ledgerUnreadable('the study event ledger could not be opened for append (fail-closed)');
  try {
    writeAllToFd(opened.fd, `${JSON.stringify(event)}\n`);
  } finally {
    closeQuietly(opened.fd);
    closeQuietly(opened.dirFd);
  }
}

/** True when the LATEST RUN_STARTED has no following RUN_FINISHED. */
function offlineExecutionInFlight(roots: StudyRoots, studyDir: string): boolean {
  const text = readLedgerText(roots, studyDir);
  if (text === null) return false;
  let started = false;
  let finishedAfterStart = false;
  const lines = text.split('\n').filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      // A corrupt ledger is NEVER "no offline execution": refuse it here too.
      throw new ConsoleLedgerUnreadableError('ledger_corrupt', `the study event ledger is corrupt at line ${index + 1} (JSON parse failed: ${(error as Error).message}) — refuse rather than treat as idle`);
    }
    if (!isJsonObject(row) || typeof row.type !== 'string') continue;
    // A finish from an EARLIER run must not mask a later in-flight run: only
    // a RUN_FINISHED AFTER the latest RUN_STARTED settles the current one.
    if (row.type === 'RUN_STARTED') {
      started = true;
      finishedAfterStart = false;
    } else if (row.type === 'RUN_FINISHED' && started) {
      finishedAfterStart = true;
    }
  }
  return started && !finishedAfterStart;
}

export class OfflineRunInFlightError extends Error {
  constructor() {
    super('an offline execution is currently in progress for this study (RUN_STARTED without RUN_FINISHED)');
    this.name = 'OfflineRunInFlightError';
  }
}

export function mintRunId(): string {
  return `RUN-C-${randomUUID().toUpperCase()}`;
}

/** Derive the console-run states from the study ledger (never stored separately). */
export function readConsoleRuns(roots: StudyRoots, studyDir: string): ConsoleRunState[] {
  const text = readLedgerText(roots, studyDir);
  if (text === null) return [];
  const lines: string[] = text.split('\n').filter(Boolean);
  const runs = new Map<string, ConsoleRunState>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ConsoleLedgerUnreadableError('ledger_corrupt', `the study event ledger is corrupt at line ${index + 1} (JSON parse failed: ${(error as Error).message}) — refuse rather than pretend it is empty`);
    }
    if (!isJsonObject(parsed) || typeof parsed.type !== 'string' || !(CONSOLE_RUN_EVENT_TYPES as readonly string[]).includes(parsed.type)) continue;
    if (parsed.schema !== CONSOLE_RUN_SCHEMA || typeof parsed.runId !== 'string' || typeof parsed.mode !== 'string') continue;
    // rc-2: an untrusted mode string is narrowed by a real guard, never `as`.
    // A value outside the two supported modes is not a console-run event.
    const mode = isConsoleRunMode(parsed.mode) ? parsed.mode : null;
    if (mode === null) continue;
    const acceptedAt = typeof parsed.acceptedAt === 'string' ? parsed.acceptedAt : '';
    const checks = Array.isArray(parsed.checks) ? parsed.checks : undefined;
    const existing = runs.get(parsed.runId) ?? { runId: parsed.runId, mode, status: 'RUNNING', acceptedAt, finishedAt: null, outcome: null, reason: null };
    if (parsed.type === 'CONSOLE_RUN_ACCEPTED') {
      runs.set(parsed.runId, { ...existing, status: 'RUNNING', acceptedAt, finishedAt: null, outcome: null, reason: null });
    } else if (parsed.type === 'CONSOLE_RUN_FINISHED') {
      runs.set(parsed.runId, { ...existing, status: 'FINISHED', finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : null, outcome: typeof parsed.outcome === 'string' ? parsed.outcome : null, reason: typeof parsed.reason === 'string' ? parsed.reason : null, ...(checks !== undefined ? { checks } : {}) });
    } else if (parsed.type === 'CONSOLE_RUN_FAILED') {
      runs.set(parsed.runId, { ...existing, status: 'FAILED', finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : null, outcome: typeof parsed.outcome === 'string' ? parsed.outcome : null, reason: typeof parsed.reason === 'string' ? parsed.reason : null, ...(checks !== undefined ? { checks } : {}) });
    } else if (parsed.type === 'CONSOLE_RUN_ABANDONED') {
      runs.set(parsed.runId, { ...existing, status: 'ABANDONED', finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : null, outcome: 'RESULT_UNKNOWN', reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown' });
    }
  }
  return [...runs.values()].sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : 1));
}

export function currentConsoleRun(runs: ConsoleRunState[]): ConsoleRunState | null {
  return runs.find((run) => run.status === 'RUNNING') ?? null;
}

/**
 * Study status projection (manifest + ledger settlement counts + report status).
 * The DISPLAY projection tolerates single corrupt lines — the authoritative
 * console-run reader refuses them and the route reports `ledgerProblem` — but
 * it reads the ledger through the SAME secure fd boundary (never by path).
 */
export function studyStatusPayload(roots: StudyRoots, studyDir: string): Record<string, unknown> {
  const manifest = readStudyJson(studyDir, 'examiner-manifest.json');
  let events: Record<string, unknown>[] = [];
  try {
    const text = readLedgerText(roots, studyDir);
    if (text !== null) {
      events = text.trim().split('\n').filter(Boolean)
        .map((line): Record<string, unknown> | null => {
          try {
            const parsed: unknown = JSON.parse(line);
            return isJsonObject(parsed) ? parsed : null;
          } catch {
            return null;
          }
        })
        .filter((row): row is Record<string, unknown> => row !== null);
    }
  } catch (error) {
    if (!(error instanceof ConsoleLedgerUnreadableError)) throw error;
    // The status route surfaces the structured ledgerProblem; this projection
    // must not turn "unreadable" into fabricated clean zeroes.
    events = [];
  }
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (typeof event.type !== 'string' || !event.type.startsWith('UNIT_FINISHED')) continue;
    const result = String(event.result ?? 'UNKNOWN');
    counts[result] = (counts[result] ?? 0) + 1;
  }
  const target = isJsonObject(manifest.targetPrinciple) && typeof manifest.targetPrinciple.id === 'string'
    ? manifest.targetPrinciple.id
    : null;
  // A run is "finished" only when the LATEST RUN_STARTED has a following
  // RUN_FINISHED. A finish from an earlier run must never make a later
  // in-flight run look complete (the Owner would see "finished" and the page
  // would stop polling while the run is still executing).
  let runStarted = false;
  let runFinished = false;
  for (const event of events) {
    if (event.type === 'RUN_STARTED') {
      runStarted = true;
      runFinished = false;
    } else if (event.type === 'RUN_FINISHED' && runStarted) {
      runFinished = true;
    }
  }
  const reportExists = fs.existsSync(path.join(studyDir, 'behavior-report-v2.json'));
  const report = reportExists ? readStudyJson(studyDir, 'behavior-report-v2.json') : null;
  return {
    studyId: path.basename(studyDir),
    experimentMode: manifest.experimentMode,
    interventionType: manifest.interventionType,
    targetPrincipleId: target,
    plannedPairs: manifest.plannedPairs,
    runStarted,
    runFinished,
    unitStates: counts,
    reportStatus: report ? report.status : null,
  };
}

/**
 * P1-4: the whole acceptance transaction — read current runs, check the
 * single-live constraint (async AND offline in-flight), verify the study is
 * still writable, append CONSOLE_RUN_ACCEPTED — happens under the EXISTING
 * lab study write lock, so two concurrent requests can never both pass the
 * check. The lock guards ONLY the acceptance; the async execution itself
 * runs unlocked (settlement appends race-free through the same lock the
 * runner already takes for real executions).
 */
export class ConsoleRunInProgressError extends Error {
  readonly runId: string;
  readonly mode: string;
  readonly acceptedAt: string;
  constructor(running: ConsoleRunState) {
    super(`console run ${running.runId} (${running.mode}) is still in progress`);
    this.name = 'ConsoleRunInProgressError';
    this.runId = running.runId;
    this.mode = running.mode;
    this.acceptedAt = running.acceptedAt;
  }
}

export interface ConsoleRunAcceptance {
  runId: string;
  acceptedAt: string;
}

interface StudyLockModule {
  acquireStudyWriteLock: (dir: string, options: { owner: string }) => unknown;
  releaseStudyWriteLock: (dir: string, options: { owner: string }) => unknown;
}

/** Load the lab's authoritative single-writer lock (dynamic — no package edge). */
async function loadStudyLock(labRoot: string): Promise<StudyLockModule> {
  const ledgerUrl = pathToFileURL(path.join(labRoot, 'lib', 'challenge-ledger.mjs')).href;
  const mod = (await import(ledgerUrl)) as Partial<StudyLockModule>;
  if (typeof mod.acquireStudyWriteLock !== 'function' || typeof mod.releaseStudyWriteLock !== 'function') {
    throw new Error('the lab payload does not export the study write lock — refusing an unguarded ledger settlement');
  }
  return { acquireStudyWriteLock: mod.acquireStudyWriteLock, releaseStudyWriteLock: mod.releaseStudyWriteLock };
}

/**
 * Run `operation` under the SAME study write lock the offline runner holds.
 * Acceptance, recovery and async settlement all use this one lock, so a
 * terminal event can never land between another writer's check and append.
 */
async function withStudyWriteLock<T>(
  input: { labRoot: string; studyDir: string; owner: string },
  operation: () => T | Promise<T>,
): Promise<T> {
  const lock = await loadStudyLock(input.labRoot);
  lock.acquireStudyWriteLock(input.studyDir, { owner: input.owner });
  try {
    return await operation();
  } finally {
    try {
      lock.releaseStudyWriteLock(input.studyDir, { owner: input.owner });
    } catch {
      // An unreleaseable lock stays on disk (crash-holder semantics); the
      // lab's lock discipline governs recovery.
    }
  }
}

export async function acceptConsoleRun(
  roots: StudyRoots,
  studyDir: string,
  inputs: { studyId: string; mode: ConsoleRunMode; labRoot: string },
): Promise<ConsoleRunAcceptance> {
  const owner = `pd-console-accept-${process.pid}`;
  return withStudyWriteLock({ labRoot: inputs.labRoot, studyDir, owner }, () => {
    // Everything below is INSIDE the lock. A ledger that cannot be honestly
    // read refuses the acceptance (P1-4B) — never an empty-arrays guess.
    const runs = readConsoleRuns(roots, studyDir);
    const running = currentConsoleRun(runs);
    if (running) throw new ConsoleRunInProgressError(running);
    // A synchronous offline run in flight (RUN_STARTED without RUN_FINISHED)
    // also refuses: one execution at a time per study.
    if (offlineExecutionInFlight(roots, studyDir)) throw new OfflineRunInFlightError();
    const runId = mintRunId();
    const acceptedAt = new Date().toISOString();
    appendConsoleRunEvent(roots, studyDir, {
      type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId, studyId: inputs.studyId,
      mode: inputs.mode, acceptedAt, pid: process.pid, owner: 'pd-console',
    });
    return { runId, acceptedAt };
  });
}

/**
 * Append an async run's TERMINAL event under the study write lock. Recovery
 * (which also holds the lock) therefore either sees the terminal event and
 * skips, or appends ABANDONED first and the later terminal event wins — an
 * already-settled run can never be reported as ABANDONED.
 */
export async function appendConsoleRunEventLocked(
  input: { labRoot: string; roots: StudyRoots; studyDir: string },
  event: ConsoleRunEvent,
): Promise<void> {
  await withStudyWriteLock(
    { labRoot: input.labRoot, studyDir: input.studyDir, owner: `pd-console-settle-${process.pid}` },
    () => appendConsoleRunEvent(input.roots, input.studyDir, event),
  );
}

/**
 * Offline→async half of the single-active contract (P1-3).
 *
 * The lab runner calls this UNDER the study write lock, BEFORE RUN_STARTED,
 * attempt reservation or actor creation. The caller (route layer) supplies it
 * so `examiner-runs` and `examiner-executor` never import each other.
 */
export function assertOfflineAdmissionAllowed(roots: StudyRoots, studyDir: string): void {
  const running = currentConsoleRun(readConsoleRuns(roots, studyDir));
  if (running) throw new ConsoleRunInProgressError(running);
}

/** Best-effort liveness probe for the process that accepted a run. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const { code } = error as { code?: string };
    return code === 'EPERM';
  }
}

/**
 * Startup recovery: walk the WRITABLE root only (historical assets are never
 * console-run targets) and abandon every unfinished console run whose
 * accepting process is gone. An accepting process that is still alive keeps
 * its run (another console server may legitimately be serving the workspace).
 *
 * Path safety: only names the server itself enumerated that pass the
 * study-handle charset allowlist, each directory must resolve canonically
 * INSIDE the writable root, and every ledger access re-proves containment at
 * the point of use — a symlinked/junctioned entry is skipped, never followed.
 */
export async function recoverUnfinishedConsoleRuns(roots: StudyRoots, labRoot: string): Promise<{ studyId: string; runId: string }[]> {
  const recovered: { studyId: string; runId: string }[] = [];
  const writableReal = canonicalPathSync(roots.writable);
  if (!writableReal || !fs.existsSync(roots.writable)) return recovered;
  const rootPrefix = writableReal.endsWith(path.sep) ? writableReal : `${writableReal}${path.sep}`;
  const entries = fs.readdirSync(roots.writable, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && STUDY_DIR_NAME_PATTERN.test(entry.name));
  for (const entry of entries) {
    const dirReal = canonicalPathSync(path.join(roots.writable, entry.name));
    if (!dirReal || !dirReal.startsWith(rootPrefix)) continue;
    // P1-4B: an unreadable ledger in ONE study must not hide (or be mistaken
    // for "no runs" in) the others — skip it loudly and keep scanning.
    let runs: ConsoleRunState[];
    try {
      runs = readConsoleRuns(roots, dirReal);
    } catch (error) {
      if (error instanceof ConsoleLedgerUnreadableError) {
        console.error(`[pd-console] examiner run recovery: study ${entry.name} ledger ${error.code} — skipped (not treated as no-runs): ${error.message}`);
        continue;
      }
      throw error;
    }
    const running = currentConsoleRun(runs);
    if (!running) continue;
    // The accepting pid is only recoverable from the raw ACCEPTED event.
    try {
      const text = readLedgerText(roots, dirReal);
      if (text === null) continue;
      const accepted = text.split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
        .filter((row): row is Record<string, unknown> => isJsonObject(row) && row.type === 'CONSOLE_RUN_ACCEPTED' && row.runId === running.runId)
        .pop();
      const pid = typeof accepted?.pid === 'number' ? accepted.pid : 0;
      if (processAlive(pid)) continue;
      // The check-and-append below runs under the SAME lock the async
      // settlement takes. Re-reading inside the lock proves the run is still
      // unfinished: a terminal event that landed in between wins, and two
      // concurrent recoveries cannot both append ABANDONED.
      await withStudyWriteLock({ labRoot, studyDir: dirReal, owner: `pd-console-recover-${process.pid}` }, () => {
        const fresh = currentConsoleRun(readConsoleRuns(roots, dirReal));
        if (!fresh || fresh.runId !== running.runId) return;
        appendConsoleRunEvent(roots, dirReal, {
          type: 'CONSOLE_RUN_ABANDONED',
          schema: CONSOLE_RUN_SCHEMA,
          runId: running.runId,
          studyId: entry.name,
          mode: running.mode,
          acceptedAt: running.acceptedAt,
          pid,
          owner: 'pd-console',
          finishedAt: new Date().toISOString(),
          outcome: 'RESULT_UNKNOWN',
          reason: 'server_restart — the accepting process is gone; the attempt stays RESULT_UNKNOWN and is never auto-retried',
        });
        recovered.push({ studyId: entry.name, runId: running.runId });
      });
    } catch (error) {
      if ((error as Error).name === 'StudyLockError') {
        console.error(`[pd-console] examiner run recovery: study ${entry.name} is locked by another writer — skipped (that writer settles it)`);
        continue;
      }
      // An unreadable ledger is reported by the status route; recovery skips it.
    }
  }
  return recovered;
}

// ── Stage R authorization (read via the lab's own gate module) ──────────────

export interface StageRRead {
  present: boolean;
  record: Record<string, unknown> | null;
  problem: string | null;
}

async function readStageR(labRoot: string, studyDir: string): Promise<StageRRead> {
  try {
    const url = pathToFileURL(path.join(labRoot, 'lib', 'challenge-stage-r-gate.mjs')).href;
    const mod = (await import(url)) as { readStageRAuthorization: (dir: string) => Record<string, unknown> | null };
    const record = mod.readStageRAuthorization(studyDir);
    return record ? { present: true, record, problem: null } : { present: false, record: null, problem: 'run-authorization.json missing or unreadable' };
  } catch (error) {
    return { present: false, record: null, problem: `the Stage R gate module could not be loaded (${(error as Error).message})` };
  }
}

/** Closed extraction of the fields the dry-run/gate surface needs (rc-2). */
function stageRFacts(record: Record<string, unknown> | null): {
  status: string | null;
  executionMode: string | null;
  revoked: boolean;
  halted: boolean;
  model: string | null;
  validUntil: string | null;
} {
  if (!record) return { status: null, executionMode: null, revoked: false, halted: false, model: null, validUntil: null };
  const identity = isJsonObject(record.requestedActorIdentity) ? record.requestedActorIdentity : {};
  return {
    status: typeof record.status === 'string' ? record.status : null,
    executionMode: typeof record.executionMode === 'string' ? record.executionMode : null,
    revoked: record.revoked === true,
    halted: record.halted === true,
    model: typeof identity.model === 'string' ? identity.model : null,
    validUntil: typeof record.validUntil === 'string' ? record.validUntil : null,
  };
}

// ── Host dry-run (zero model calls) ─────────────────────────────────────────

export interface DryRunCheck {
  id: string;
  severity: 'blocker' | 'warning' | 'info';
  ok: boolean;
  detail: string;
}

export interface HostDryRunResult {
  ok: boolean;
  checks: DryRunCheck[];
  authorization: { present: boolean; status: string | null; executionMode: string | null; model: string | null; note: string };
  hostProbe: { cliVersion: string | null; note: string };
  modelCalls: 0;
}

/**
 * The host dry-run: everything Gate 2 can check WITHOUT a model call. It is
 * deliberately a checklist, not a pass/fail black box — the Owner sees exactly
 * which prerequisite is missing before real execution can be requested.
 */
export async function hostDryRunPass(input: { modules: LabModules; labRoot: string; studyDir: string; context: { labRoot: string; roots: StudyRoots } | undefined }): Promise<HostDryRunResult> {
  const { modules, labRoot, studyDir, context } = input;
  const checks: DryRunCheck[] = [];
  const check = (entry: { id: string; ok: boolean; detail: string; severity?: DryRunCheck['severity'] }): void => {
    checks.push({ id: entry.id, severity: entry.severity ?? 'blocker', ok: entry.ok, detail: entry.detail });
  };

  // 1. The frozen offline contract must still verify.
  try {
    const preflight = preflightCheck(modules, studyDir, context);
    check({ id: 'offline_contract_preflight', ok: preflight.ok, detail: preflight.ok
      ? 'the frozen study contract verified (manifest/HEPS/RuleCode/pairs/bindings)'
      : `preflight blockers: ${preflight.blockers.map((b) => String((b as { id?: string }).id ?? 'unknown')).join(', ')}` });
  } catch (error) {
    check({ id: 'offline_contract_preflight', ok: false, detail: `preflight could not run: ${(error as Error).message}` });
  }

  // 2. Stage R authorization — the SAME authoritative verifier the F2 request
  //    uses (schema, stage/status, the full study binding, the validity
  //    window, the retirement registry, revocation/halted and probe evidence).
  //    A dry-run must never report readiness on a weaker subset than the gate.
  let gate: F2GateResult;
  try {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- hoisted declaration (the gate section follows the dry-run section)
    gate = await f2AuthorizationGate(labRoot, studyDir);
  } catch (error) {
    gate = { authorized: false, reasons: [`the Stage R gate could not run (${(error as Error).message})`], record: null };
  }
  const facts = stageRFacts(gate.record);
  const authOk = gate.authorized;
  check({ id: 'stage_r_authorization', ok: authOk, detail: authOk
    ? `APPROVED F2-real-host authorization verified by the lab Stage R gate (model ${facts.model ?? 'unspecified'}, validUntil ${facts.validUntil ?? 'unbounded'})`
    : gate.reasons.length > 0
      ? `Stage R gate refused: ${gate.reasons.join('; ')}`
      : 'Stage R gate refused the authorization record' });

  // 3. OpenClaw CLI probe — a LOCAL `--version` process, never a model call,
  //    delegated to the lab's read-only probe with NO executable argument
  //    (fixed default 'openclaw'; untrusted study data never picks binaries).
  let cliVersion: string | null = null;
  let hostOk = false;
  let hostNote: string;
  try {
    const hostUrl = pathToFileURL(path.join(labRoot, 'lib', 'challenge-openclaw-host.mjs')).href;
    const hostMod = (await import(hostUrl)) as { probeOpenClawCli?: (options?: Record<string, unknown>) => { ok: boolean; cliVersion: string | null; reason: string | null } };
    if (typeof hostMod.probeOpenClawCli !== 'function') {
      hostNote = 'the OpenClaw host module in this lab payload does not export the read-only CLI probe';
    } else {
      const { ok, cliVersion: probedVersion, reason } = hostMod.probeOpenClawCli();
      hostOk = ok === true;
      cliVersion = probedVersion;
      hostNote = hostOk ? `OpenClaw CLI reachable (${cliVersion})` : `OpenClaw CLI not reachable: ${reason ?? 'unknown reason'}`;
    }
  } catch (error) {
    hostNote = `the OpenClaw CLI probe could not run (${(error as Error).message})`;
  }
  check({ id: 'host_cli_probe', ok: hostOk, detail: hostNote });

  // 4. Isolation workspace probe: per-arm round dirs must be creatable inside
  //    the writable study root. P1-2: EXCLUSIVE mkdtemp (random suffix, never a
  //    fixed name), the study directory is re-verified through the ledger
  //    boundary first, the created directory's identity is captured, the marker
  //    is created exclusively with O_NOFOLLOW, and cleanup removes ONLY the
  //    directory this run created while its identity and containment still
  //    verify. If identity cannot be proven the residue is KEPT and reported.
  let isolationOk = false;
  let isolationNote: string;
  let probeDir: string | null = null;
  try {
    const studyReal = context ? resolveLedgerStudyDir(context.roots, studyDir, 'append') : canonicalPathSync(studyDir);
    const studyIdentity = studyReal ? identityOf(studyReal) : null;
    if (!studyReal || !studyIdentity) throw new Error('the study directory identity cannot be established (fail-closed)');
    probeDir = fs.mkdtempSync(path.join(studyReal, '.console-host-dry-run-probe-'));
    const probeStat = fs.lstatSync(probeDir);
    if (probeStat.isSymbolicLink() || !probeStat.isDirectory()) throw new Error('the probe path is not a plain directory (fail-closed)');
    const probeIdentity = identityOf(probeDir);
    if (!probeIdentity) throw new Error('the probe directory identity cannot be established (fail-closed)');
    const probeReal = canonicalPathSync(probeDir);
    if (!probeReal || !isPathInside(studyReal, probeReal)) {
      throw new Error('the probe directory resolved outside the study — refusal, never cleanup of an unknown path');
    }
    const marker = path.join(probeDir, 'round-write.txt');
    const markerFd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW);
    try {
      const markerStat = fs.fstatSync(markerFd, { bigint: true });
      if (!markerStat.isFile()) throw new Error('the probe marker is not a regular file (fail-closed)');
      writeAllToFd(markerFd, 'probe');
    } finally {
      closeQuietly(markerFd);
    }
    const removal = removeProbeDirIfStillOwned(
      { path: probeDir, dev: probeIdentity.dev, ino: probeIdentity.ino },
      { real: studyReal, dev: studyIdentity.dev, ino: studyIdentity.ino },
    );
    if (!removal.removed) throw new Error(`the probe directory was NOT removed (${removal.reason ?? 'unknown reason'}) — residue kept, never an unknown-path delete`);
    isolationOk = !fs.existsSync(probeDir);
    isolationNote = isolationOk ? 'round-directory creation verified inside the writable study root (exclusive temp dir created + removed, no residue)' : 'the probe directory could not be removed — residue left behind';
  } catch (error) {
    const residue = probeDir !== null && fs.existsSync(probeDir) ? ` (residue kept: ${probeDir})` : '';
    isolationNote = `round-directory creation failed: ${(error as Error).message}${residue}`;
  }
  check({ id: 'isolation_workspace_probe', ok: isolationOk, detail: isolationNote });

  // 5. Evidence ceiling (informational — the capability table is frozen).
  check({ id: 'injection_capability_ceiling', ok: true, severity: 'info', detail: 'OpenClaw prompt-delivery evidence ceiling is SUBMITTED (HOST_MAX_PROVABLE_LEVEL) — full-conclusion minimum CONTEXT_PRESENT can never be claimed from an OpenClaw prompt delivery' });

  // 6. The dry-run's own zero-model-call guarantee.
  check({ id: 'model_calls_zero', ok: true, severity: 'info', detail: 'this dry-run performs zero model/provider calls by construction (local CLI version probe + filesystem checks only)' });

  return {
    ok: checks.every((entry) => entry.severity === 'info' || entry.ok),
    checks,
    authorization: {
      present: gate.record !== null,
      status: facts.status,
      executionMode: facts.executionMode,
      model: facts.model,
      note: authOk ? 'authorized for F2 real-host execution' : 'NOT authorized — see the stage_r_authorization check',
    },
    hostProbe: { cliVersion, note: hostNote },
    modelCalls: 0,
  };
}

// ── F2 real-host authorization gate ─────────────────────────────────────────

/** Read a JSON-object file or throw a clean refusal (rc-1/rc-3). */
function readJsonObjectFileStrict(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isJsonObject(parsed)) throw new Error(`${path.basename(file)} is not a JSON object`);
  return parsed;
}

function hashOfCanonicalJson(value: unknown): string {
  // Canonical JSON hashing identical to the lab's hashOfCanonical (sorted
  // keys, no whitespace). Kept local so the gate does not import freeze
  // machinery beyond the gate module itself.
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (isJsonObject(input)) {
      const entries = Object.entries(input).filter(([, v]) => v !== undefined);
      return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]));
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export interface F2GateResult {
  authorized: boolean;
  reasons: string[];
  record: Record<string, unknown> | null;
}

/**
 * P1-5: the console gate REUSES the lab's authoritative Stage R verifier
 * (verifyStageRAuthorization) instead of a hand-rolled subset — schema,
 * stage/status, the full study binding (studyId/suiteHash/mappingHash/
 * graderHash/studyPlanHash), arms/cases/repetitions coverage, attemptCap,
 * requestCap, the validity window, the retirement registry, revocation/
 * halted, requestedActorIdentity and the F2 real-host probe evidence are ALL
 * enforced. A record that is merely status=APPROVED fails every missing
 * binding it does not carry. The runner re-verifies the same authority per
 * unit under the study lock — this gate is a necessary condition, the runner
 * is the authority.
 */
export async function f2AuthorizationGate(labRoot: string, studyDir: string): Promise<F2GateResult> {
  const stageR = await readStageR(labRoot, studyDir);
  if (!stageR.present) {
    return { authorized: false, reasons: ['no run-authorization.json exists in this study — the Owner must issue an APPROVED F2-real-host record bound to the frozen study'], record: null };
  }
  // The frozen facts the bindings are derived from (read fail-closed — a
  // study whose frozen files are unreadable cannot be authorized).
  const frozen = (() => {
    try {
      const manifest = readJsonObjectFileStrict(path.join(studyDir, 'examiner-manifest.json'));
      const suite = readJsonObjectFileStrict(path.join(studyDir, 'suite-manifest.json'));
      const mapping = readJsonObjectFileStrict(path.join(studyDir, 'pain-mechanism-mapping.json'));
      const scoring = readJsonObjectFileStrict(path.join(studyDir, 'scoring-contract.json'));
      return { ok: true as const, manifest, suite, mapping, scoring };
    } catch (error) {
      return { ok: false as const, reason: (error as Error).message };
    }
  })();
  if (!frozen.ok) {
    return { authorized: false, reasons: [`the frozen study files could not be read for binding verification: ${frozen.reason}`], record: stageR.record };
  }
  const gateUrl = pathToFileURL(path.join(labRoot, 'lib', 'challenge-stage-r-gate.mjs')).href;
  const gateMod = (await import(gateUrl)) as {
    verifyStageRAuthorization?: (input: Record<string, unknown>) => { ok: boolean; reasons: string[] };
    readStudyPlanHash?: (dir: string) => string;
    readAuthorizationRevocations?: () => unknown;
  };
  if (typeof gateMod.verifyStageRAuthorization !== 'function' || typeof gateMod.readStudyPlanHash !== 'function') {
    return { authorized: false, reasons: ['the lab payload does not export the authoritative Stage R verifier — fail-closed'], record: stageR.record };
  }
  const suiteCases = Array.isArray(frozen.suite.cases) ? frozen.suite.cases : [];
  const caseIds = suiteCases.map((entry) => (isJsonObject(entry) && typeof entry.caseId === 'string' ? entry.caseId : ''));
  const repetitionsPerCase = Number.isInteger(frozen.manifest.repetitionsPerCase) ? Number(frozen.manifest.repetitionsPerCase) : 0;
  const repetitionIds = Array.from({ length: repetitionsPerCase }, (_, index) => String(index + 1));
  const record: Record<string, unknown> = stageR.record ?? {};
  const attemptCap = Number.isSafeInteger(record.attemptCap) ? record.attemptCap : null;
  const verdict = gateMod.verifyStageRAuthorization({
    authorizationRecord: record,
    bindings: {
      studyId: frozen.manifest.studyId ?? null,
      suiteHash: frozen.suite.suiteHash ?? null,
      mappingHash: frozen.mapping.mappingHash ?? null,
      graderHash: hashOfCanonicalJson(frozen.scoring),
      studyPlanHash: gateMod.readStudyPlanHash(studyDir),
    },
    plan: { arms: ['A', 'B'], cases: caseIds, repetitions: repetitionIds },
    maxAttemptsTotal: attemptCap,
    now: Date.now(),
    declaredExecutionMode: 'F2-real-host',
    // The console declares NOTHING of its own: a bound timeout/cap is echoed
    // back verbatim (the real runner must declare the same values), and an
    // unbound one is left undeclared — so this gate can never widen the
    // Owner-approved budget; it can only fail the record's own integrity.
    ...(Number.isSafeInteger(record.requestTimeoutMs) ? { declaredRequestTimeoutMs: record.requestTimeoutMs } : {}),
    ...(Number.isSafeInteger(record.maxRequestsPerAttempt) ? { declaredMaxRequestsPerAttempt: record.maxRequestsPerAttempt } : {}),
    retiredAuthorizations: typeof gateMod.readAuthorizationRevocations === 'function' ? gateMod.readAuthorizationRevocations() : null,
  });
  return { authorized: verdict.ok, reasons: verdict.reasons, record };
}

