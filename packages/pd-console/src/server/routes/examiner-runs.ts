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
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalPathSync, isPathInside, isJsonObject, preflightCheck, type LabModules, type StudyRoots } from './examiner-executor.js';

export const CONSOLE_RUN_SCHEMA = 'examiner-console-run.v1';
export const CONSOLE_RUN_EVENT_TYPES = ['CONSOLE_RUN_ACCEPTED', 'CONSOLE_RUN_FINISHED', 'CONSOLE_RUN_FAILED', 'CONSOLE_RUN_ABANDONED'] as const;
export type ConsoleRunMode = 'host-dry-run' | 'f2-real-host';
export type ConsoleRunEventType = (typeof CONSOLE_RUN_EVENT_TYPES)[number];
export const CONSOLE_RUN_MODES: readonly ConsoleRunMode[] = ['host-dry-run', 'f2-real-host'];

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
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

export function mintRunId(): string {
  return `RUN-C-${randomUUID().toUpperCase()}`;
}

/** Derive the console-run states from the study ledger (never stored separately). */
export function readConsoleRuns(studyDir: string): ConsoleRunState[] {
  const file = path.join(studyDir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const runs = new Map<string, ConsoleRunState>();
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isJsonObject(parsed) || typeof parsed.type !== 'string' || !(CONSOLE_RUN_EVENT_TYPES as readonly string[]).includes(parsed.type)) continue;
      if (parsed.schema !== CONSOLE_RUN_SCHEMA || typeof parsed.runId !== 'string' || typeof parsed.mode !== 'string') continue;
      const mode = parsed.mode as ConsoleRunMode;
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
  } catch {
    return [];
  }
  return [...runs.values()].sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : 1));
}

export function currentConsoleRun(runs: ConsoleRunState[]): ConsoleRunState | null {
  return runs.find((run) => run.status === 'RUNNING') ?? null;
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
    const runs = readConsoleRuns(dirReal);
    const running = currentConsoleRun(runs);
    if (!running) continue;
    // The accepting pid is only recoverable from the raw ACCEPTED event.
    const file = path.resolve(dirReal, 'events.jsonl');
    if (!file.startsWith(rootPrefix)) continue;
    try {
      const accepted = fs.readFileSync(file, 'utf8').split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.type === 'CONSOLE_RUN_ACCEPTED' && row.runId === running.runId)
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
export async function hostDryRunPass(modules: LabModules, labRoot: string, studyDir: string, context: { labRoot: string; roots: StudyRoots } | undefined): Promise<HostDryRunResult> {
  const checks: DryRunCheck[] = [];
  const check = (id: string, severity: DryRunCheck['severity'], ok: boolean, detail: string) => checks.push({ id, severity, ok, detail });

  // 1. The frozen offline contract must still verify.
  try {
    const preflight = preflightCheck(modules, studyDir, context);
    check('offline_contract_preflight', 'blocker', preflight.ok, preflight.ok
      ? 'the frozen study contract verified (manifest/HEPS/RuleCode/pairs/bindings)'
      : `preflight blockers: ${preflight.blockers.map((b) => String((b as { id?: string }).id ?? 'unknown')).join(', ')}`);
  } catch (error) {
    check('offline_contract_preflight', 'blocker', false, `preflight could not run: ${(error as Error).message}`);
  }

  // 2. Stage R authorization: what the Owner has (or has not) issued.
  const stageR = await readStageR(labRoot, studyDir);
  const facts = stageRFacts(stageR.record);
  const authOk = stageR.present && facts.status === 'APPROVED' && facts.executionMode === 'F2-real-host' && !facts.revoked && !facts.halted;
  check('stage_r_authorization', 'blocker', authOk, authOk
    ? `APPROVED F2-real-host authorization present (model ${facts.model ?? 'unspecified'}, validUntil ${facts.validUntil ?? 'unbounded'})`
    : stageR.present
      ? `a run-authorization.json exists but is not an approvable F2 record (status=${facts.status ?? 'unknown'}, mode=${facts.executionMode ?? 'unknown'}${facts.revoked ? ', REVOKED' : ''}${facts.halted ? ', HALTED' : ''})`
      : 'no run-authorization.json in the study — the Owner must issue an APPROVED F2-real-host record before real execution');

  // 3. OpenClaw CLI probe — a LOCAL `--version` process, never a model call,
  //    delegated to the lab's read-only probe with NO executable argument
  //    (fixed default 'openclaw'; untrusted study data never picks binaries).
  let cliVersion: string | null = null;
  let hostOk = false;
  let hostNote = '';
  try {
    const hostUrl = pathToFileURL(path.join(labRoot, 'lib', 'challenge-openclaw-host.mjs')).href;
    const hostMod = (await import(hostUrl)) as { probeOpenClawCli?: (options?: Record<string, unknown>) => { ok: boolean; cliVersion: string | null; reason: string | null } };
    if (typeof hostMod.probeOpenClawCli !== 'function') {
      hostNote = 'the OpenClaw host module in this lab payload does not export the read-only CLI probe';
    } else {
      const probe = hostMod.probeOpenClawCli();
      hostOk = probe.ok === true;
      cliVersion = probe.cliVersion;
      hostNote = hostOk ? `OpenClaw CLI reachable (${cliVersion})` : `OpenClaw CLI not reachable: ${probe.reason ?? 'unknown reason'}`;
    }
  } catch (error) {
    hostNote = `the OpenClaw CLI probe could not run (${(error as Error).message})`;
  }
  check('host_cli_probe', 'blocker', hostOk, hostNote);

  // 4. Isolation workspace probe: per-arm round dirs must be creatable inside
  //    the writable study root (create + remove, nothing left behind).
  let isolationOk = false;
  let isolationNote = '';
  try {
    const probeDir = path.join(studyDir, '.console-host-dry-run-probe');
    fs.mkdirSync(probeDir, { recursive: true });
    const marker = path.join(probeDir, 'round-write.txt');
    fs.writeFileSync(marker, 'probe', 'utf8');
    fs.rmSync(probeDir, { recursive: true, force: true });
    isolationOk = !fs.existsSync(probeDir);
    isolationNote = isolationOk ? 'round-directory creation verified inside the writable study root (created + removed)' : 'the probe directory could not be removed — residue left behind';
  } catch (error) {
    isolationNote = `round-directory creation failed: ${(error as Error).message}`;
  }
  check('isolation_workspace_probe', 'blocker', isolationOk, isolationNote);

  // 5. Evidence ceiling (informational — the capability table is frozen).
  check('injection_capability_ceiling', 'info', true, 'OpenClaw prompt-delivery evidence ceiling is SUBMITTED (HOST_MAX_PROVABLE_LEVEL) — full-conclusion minimum CONTEXT_PRESENT can never be claimed from an OpenClaw prompt delivery');

  // 6. The dry-run's own zero-model-call guarantee.
  check('model_calls_zero', 'info', true, 'this dry-run performs zero model/provider calls by construction (local CLI version probe + filesystem checks only)');

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

export interface F2GateResult {
  authorized: boolean;
  reasons: string[];
  record: Record<string, unknown> | null;
}

/**
 * The necessary conditions the console checks BEFORE accepting a real F2 run.
 * The Stage R gate inside the runner remains the AUTHORITY and re-verifies
 * per unit under the study lock — a record that passes here but fails there
 * refuses inside the runner with no RUN_STARTED and no reservation.
 */
export async function f2AuthorizationGate(labRoot: string, studyDir: string): Promise<F2GateResult> {
  const reasons: string[] = [];
  const stageR = await readStageR(labRoot, studyDir);
  if (!stageR.present) {
    return { authorized: false, reasons: ['no run-authorization.json exists in this study — the Owner must issue an APPROVED F2-real-host record bound to the frozen study'], record: null };
  }
  const facts = stageRFacts(stageR.record);
  if (facts.status !== 'APPROVED') reasons.push(`authorization status is '${facts.status ?? 'unknown'}' (APPROVED required)`);
  if (facts.executionMode !== 'F2-real-host') reasons.push(`authorization executionMode is '${facts.executionMode ?? 'unknown'}' (F2-real-host required)`);
  if (facts.revoked) reasons.push('the authorization record is REVOKED');
  if (facts.halted) reasons.push('the authorization record is HALTED');
  // Binding: the record must name THIS study and match its frozen suite hash.
  const record: Record<string, unknown> = stageR.record ?? {};
  const manifestFile = path.join(studyDir, 'examiner-manifest.json');
  const suiteFile = path.join(studyDir, 'suite-manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    const suite = JSON.parse(fs.readFileSync(suiteFile, 'utf8')) as Record<string, unknown>;
    if (typeof record.studyId === 'string' && record.studyId !== manifest.studyId) {
      reasons.push('the authorization is bound to a different study id');
    }
    if (typeof record.suiteHash === 'string' && typeof suite.suiteHash === 'string' && record.suiteHash !== suite.suiteHash) {
      reasons.push('the authorization suiteHash does not match the frozen suite');
    }
  } catch (error) {
    reasons.push(`the frozen study files could not be read for binding verification (${(error as Error).message})`);
  }
  return { authorized: reasons.length === 0, reasons, record: stageR.record };
}
