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
import { canonicalPathSync, isJsonObject, preflightCheck, type LabModules, type StudyRoots } from './examiner-executor.js';

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
}

/**
 * Resolve `<studyDir>/events.jsonl` and prove the resolved target stays inside
 * `root` (fail-closed null). Every ledger read/append in this module goes
 * through this boundary check — a directory swapped for a link after access
 * resolution can never redirect the append outside the writable root.
 */
function ledgerFileInside(root: string, studyDir: string): string | null {
  const target = path.resolve(studyDir, 'events.jsonl');
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target.startsWith(rootPrefix)) return target;
  return null;
}

/** Append one console-run lifecycle event to the study's events ledger. */
export function appendConsoleRunEvent(roots: StudyRoots, studyDir: string, event: ConsoleRunEvent): void {
  const writableReal = canonicalPathSync(roots.writable);
  if (!writableReal) throw new Error('console run ledger: the writable study root cannot be resolved (fail-closed)');
  const file = ledgerFileInside(writableReal, studyDir);
  if (!file) throw new Error('console run ledger: the events file resolves outside the writable study root (fail-closed)');
  // P1-6: the ledger itself must be a regular file inside the boundary — a
  // symlink planted at events.jsonl (or its replacement mid-flight) must not
  // redirect the append. First append on a fresh study creates it exclusively.
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('console run ledger: the events file is not a regular file (symlink or special file refused)');
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
  } else {
    // 'wx' exclusive create: a pre-planted symlink at this exact path fails
    // the create instead of being followed.
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** True when the ledger has RUN_STARTED without a following RUN_FINISHED. */
function offlineExecutionInFlight(studyDir: string): boolean {
  const file = path.join(studyDir, 'events.jsonl');
  if (!fs.existsSync(file)) return false;
  let started = false;
  let finished = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const row: unknown = JSON.parse(line);
      if (!isJsonObject(row) || typeof row.type !== 'string') continue;
      if (row.type === 'RUN_STARTED') started = true;
      if (row.type === 'RUN_FINISHED') finished = true;
    } catch {
      // Corrupt lines are refused by readConsoleRuns on the acceptance path;
      // this scan only refines the in-flight check.
    }
  }
  return started && !finished;
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

/** Derive the console-run states from the study ledger (never stored separately). */
export function readConsoleRuns(studyDir: string): ConsoleRunState[] {
  const file = path.join(studyDir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new ConsoleLedgerUnreadableError('ledger_unreadable', `the study event ledger could not be stat-ed: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ConsoleLedgerUnreadableError('ledger_unreadable', 'the study event ledger is not a regular file (symlink or special file refused)');
  }
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    throw new ConsoleLedgerUnreadableError('ledger_unreadable', `the study event ledger could not be read: ${(error as Error).message}`);
  }
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
    const existing = runs.get(parsed.runId) ?? { runId: parsed.runId, mode, status: 'RUNNING', acceptedAt, finishedAt: null, outcome: null, reason: null };
    if (parsed.type === 'CONSOLE_RUN_ACCEPTED') {
      runs.set(parsed.runId, { ...existing, status: 'RUNNING', acceptedAt, finishedAt: null, outcome: null, reason: null });
    } else if (parsed.type === 'CONSOLE_RUN_FINISHED') {
      runs.set(parsed.runId, { ...existing, status: 'FINISHED', finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : null, outcome: typeof parsed.outcome === 'string' ? parsed.outcome : null, reason: typeof parsed.reason === 'string' ? parsed.reason : null });
    } else if (parsed.type === 'CONSOLE_RUN_FAILED') {
      runs.set(parsed.runId, { ...existing, status: 'FAILED', finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : null, outcome: typeof parsed.outcome === 'string' ? parsed.outcome : null, reason: typeof parsed.reason === 'string' ? parsed.reason : null });
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

export async function acceptConsoleRun(
  roots: StudyRoots,
  studyDir: string,
  inputs: { studyId: string; mode: ConsoleRunMode; labRoot: string },
): Promise<ConsoleRunAcceptance> {
  const ledgerUrl = pathToFileURL(path.join(inputs.labRoot, 'lib', 'challenge-ledger.mjs')).href;
  const ledgerMod = (await import(ledgerUrl)) as {
    acquireStudyWriteLock: (dir: string, options: { owner: string }) => unknown;
    releaseStudyWriteLock: (dir: string, options: { owner: string }) => unknown;
    StudyLockError?: new (...args: unknown[]) => Error;
  };
  if (typeof ledgerMod.acquireStudyWriteLock !== 'function' || typeof ledgerMod.releaseStudyWriteLock !== 'function') {
    throw new Error('the lab payload does not export the study write lock — cannot accept console runs safely');
  }
  const owner = `pd-console-accept-${process.pid}`;
  ledgerMod.acquireStudyWriteLock(studyDir, { owner });
  try {
    // Everything below is INSIDE the lock. A ledger that cannot be honestly
    // read refuses the acceptance (P1-4B) — never an empty-arrays guess.
    const runs = readConsoleRuns(studyDir);
    const running = currentConsoleRun(runs);
    if (running) throw new ConsoleRunInProgressError(running);
    // A synchronous offline run in flight (RUN_STARTED without RUN_FINISHED)
    // also refuses: one execution at a time per study.
    if (offlineExecutionInFlight(studyDir)) throw new OfflineRunInFlightError();
    const runId = mintRunId();
    const acceptedAt = new Date().toISOString();
    appendConsoleRunEvent(roots, studyDir, {
      type: 'CONSOLE_RUN_ACCEPTED', schema: CONSOLE_RUN_SCHEMA, runId, studyId: inputs.studyId,
      mode: inputs.mode, acceptedAt, pid: process.pid, owner: 'pd-console',
    });
    return { runId, acceptedAt };
  } finally {
    try {
      ledgerMod.releaseStudyWriteLock(studyDir, { owner });
    } catch {
      // An unreleaseable lock stays on disk (crash-holder semantics); the
      // lab's lock TTL discipline governs recovery.
    }
  }
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
export async function recoverUnfinishedConsoleRuns(roots: StudyRoots): Promise<{ studyId: string; runId: string }[]> {
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
      runs = readConsoleRuns(dirReal);
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
    const file = path.resolve(dirReal, 'events.jsonl');
    if (!file.startsWith(rootPrefix)) continue;
    try {
      const accepted = fs.readFileSync(file, 'utf8').split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
        .filter((row): row is Record<string, unknown> => isJsonObject(row) && row.type === 'CONSOLE_RUN_ACCEPTED' && row.runId === running.runId)
        .pop();
      const pid = typeof accepted?.pid === 'number' ? accepted.pid : 0;
      if (processAlive(pid)) continue;
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
    } catch {
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

  // 2. Stage R authorization: what the Owner has (or has not) issued.
  const stageR = await readStageR(labRoot, studyDir);
  const facts = stageRFacts(stageR.record);
  const authOk = stageR.present && facts.status === 'APPROVED' && facts.executionMode === 'F2-real-host' && !facts.revoked && !facts.halted;
  check({ id: 'stage_r_authorization', ok: authOk, detail: authOk
    ? `APPROVED F2-real-host authorization present (model ${facts.model ?? 'unspecified'}, validUntil ${facts.validUntil ?? 'unbounded'})`
    : stageR.present
      ? `a run-authorization.json exists but is not an approvable F2 record (status=${facts.status ?? 'unknown'}, mode=${facts.executionMode ?? 'unknown'}${facts.revoked ? ', REVOKED' : ''}${facts.halted ? ', HALTED' : ''})`
      : 'no run-authorization.json in the study — the Owner must issue an APPROVED F2-real-host record before real execution' });

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
  //    the writable study root. P1-6: an EXCLUSIVE mkdtemp probe (random
  //    suffix, never following a pre-planted name) inside the study dir, and
  //    the removal re-verifies the target is still the directory we created.
  let isolationOk = false;
  let isolationNote: string;
  try {
    const probeDir = fs.mkdtempSync(path.join(studyDir, '.console-host-dry-run-probe-'));
    let removed = false;
    try {
      const probeReal = canonicalPathSync(probeDir);
      const studyReal = canonicalPathSync(studyDir);
      if (!probeReal || !studyReal || !probeReal.startsWith(studyReal + path.sep)) {
        throw new Error('the probe directory resolved outside the study — refusal, never cleanup of an unknown path');
      }
      const marker = path.join(probeDir, 'round-write.txt');
      const markerFd = fs.openSync(marker, 'wx');
      try {
        fs.writeSync(markerFd, 'probe');
      } finally {
        fs.closeSync(markerFd);
      }
      removed = true;
    } finally {
      if (removed) {
        fs.rmSync(probeDir, { recursive: true, force: true });
      }
    }
    isolationOk = !fs.existsSync(probeDir);
    isolationNote = isolationOk ? 'round-directory creation verified inside the writable study root (exclusive temp dir created + removed, no residue)' : 'the probe directory could not be removed — residue left behind';
  } catch (error) {
    isolationNote = `round-directory creation failed: ${(error as Error).message}`;
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
      present: stageR.present,
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

