/**
 * IngestionHealthModel — Console adapter for the unified three-host
 * conversation-ingestion health section (PRI-1171 ticket ⑦; SPEC v0.2 §6,
 * tech design §9).
 *
 * The readiness/state computation has ONE authority: the production CLI
 * `pd health --json` (packages/pd-cli/src/commands/health-ingestion.ts).
 * This model executes that command in a fresh subprocess against the
 * workspace and returns its `.ingestion` section VERBATIM — the Console
 * MUST NOT copy the per-host judgment, or CLI and Console could disagree
 * about the same facts (P4: one source of truth). Same discipline as the
 * CodexGovernanceHealthModel (PRI-625 Slice D / PRI-1013).
 *
 * Failure is explicit (rc-9): when the CLI cannot run or its output is not a
 * report, the model returns `status: 'unknown'` with a structured reason and
 * the manual-run nextAction — "unable to determine" is never rendered as
 * healthy. A non-zero exit is NOT by itself a collection failure: the main
 * `pd health` report can exit 1 for OTHER degraded sections (ledger
 * consistency, MCP) while still printing the full JSON report first, so a
 * parseable report on any non-killed exit is accepted (killed/signal/spawn
 * errors are failures — their stdout is partial or stale, never a report).
 *
 * Read-only status, NOT trajectory browsing (SPEC G6 red line): this surface
 * carries flags/consent metadata/water marks/lag counters and bounded
 * session identities — never observation bodies or transcript content.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePdCliEntry } from './CodexGovernanceHealthModel.js';
import { errorMessage } from '../utils/response.js';

const execFileAsync = promisify(execFile);

/** The per-host row shape mirrors health-ingestion.ts structurally (review surface, not a projection). */
export interface IngestionHostRow {
  status: 'monitored' | 'not_wired';
  [field: string]: unknown;
}

export interface IngestionHealthSnapshot {
  /** 'ok' = the CLI authority produced a real report (verbatim section passthrough). */
  status: 'ok';
  generatedAt: string;
  workspace: string;
  ingestion: {
    codex: IngestionHostRow;
    workbuddy: IngestionHostRow;
    openclaw: IngestionHostRow;
  };
}

export type IngestionHealthResult =
  | { status: 'ok'; snapshot: IngestionHealthSnapshot }
  | {
    status: 'unknown';
    reason: string;
    nextAction: string;
    productClaim: 'degraded';
  };

const MANUAL_RUN_ACTION = 'Run `pd health --workspace <dir> --json` manually to see the structured ingestion section.';

function degradedCollection(reason: string, detail: string): IngestionHealthResult {
  return {
    status: 'unknown',
    reason,
    nextAction: detail.length > 0 ? `${MANUAL_RUN_ACTION} (${detail})` : MANUAL_RUN_ACTION,
    productClaim: 'degraded',
  };
}

function isDegradedBlock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return typeof Reflect.get(value, 'reason') === 'string'
    && typeof Reflect.get(value, 'nextAction') === 'string';
}

/** Minimal shapes the CLIENT validator requires — reject here so a malformed
 * row degrades to the explicit unknown block, not a client-side "unable to
 * connect" (the client validator rejects the whole response on one bad row).
 * This is a guard, NOT a second copy of the full client validation. */
function isCheckpointSessionPart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, 'lagBytes') || !Object.hasOwn(value, 'lastDegradationReason')) return false;
  const lag = Reflect.get(value, 'lagBytes');
  const degradation = Reflect.get(value, 'lastDegradationReason');
  return typeof Reflect.get(value, 'rolloutIdentity') === 'string'
    && typeof Reflect.get(value, 'byteOffset') === 'number'
    && typeof Reflect.get(value, 'incompleteTail') === 'boolean'
    && typeof Reflect.get(value, 'updatedAt') === 'string'
    && (lag === null || typeof lag === 'number')
    && (degradation === null || typeof degradation === 'string');
}

function isCheckpointsPart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, 'total')) return isDegradedBlock(value);
  // The client validator requires these fields and rejects the WHOLE response
  // when one is missing. Guard them here too: a `checkpoints` block lacking
  // lastSuccessAt (or with a malformed session element) must degrade to the
  // structured unknown block, not reach the page as "unable to connect"
  // (PR #2563 re-review 4546270187).
  for (const key of ['lastSuccessAt', 'checkpointOffset', 'lagBytes', 'lastDegradation', 'sessions'] as const) {
    if (!Object.hasOwn(value, key)) return false;
  }
  const nullableString = (v: unknown): boolean => v === null || typeof v === 'string';
  const nullableNumber = (v: unknown): boolean => v === null || typeof v === 'number';
  if (!nullableString(Reflect.get(value, 'lastSuccessAt'))
    || !nullableNumber(Reflect.get(value, 'checkpointOffset'))
    || !nullableNumber(Reflect.get(value, 'lagBytes'))) return false;
  const lastDegradation = Reflect.get(value, 'lastDegradation');
  if (lastDegradation !== null) {
    if (typeof lastDegradation !== 'object' || Array.isArray(lastDegradation)) return false;
    if (typeof Reflect.get(lastDegradation, 'reason') !== 'string'
      || typeof Reflect.get(lastDegradation, 'updatedAt') !== 'string'
      || !Object.hasOwn(lastDegradation, 'ordinal')) return false;
  }
  const sessions = Reflect.get(value, 'sessions');
  if (!Array.isArray(sessions)) return false;
  return typeof Reflect.get(value, 'total') === 'number'
    && typeof Reflect.get(value, 'incompleteTailCount') === 'number'
    && typeof Reflect.get(value, 'lagUndetectable') === 'boolean'
    && typeof Reflect.get(value, 'truncated') === 'boolean'
    && sessions.every(isCheckpointSessionPart);
}

function isLiveOnlyPart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!Object.hasOwn(value, 'sessions')) return isDegradedBlock(value);
  const sessions = Reflect.get(value, 'sessions');
  if (!Array.isArray(sessions)) return false;
  if (typeof Reflect.get(value, 'truncated') !== 'boolean') return false;
  return sessions.every((session: unknown) => {
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return false;
    return typeof Reflect.get(session, 'rolloutIdentity') === 'string'
      && typeof Reflect.get(session, 'lastObservedAt') === 'string'
      && typeof Reflect.get(session, 'observationCount') === 'number';
  });
}

function isHostRow(value: unknown): value is IngestionHostRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const status = Reflect.get(value, 'status');
  if (status === 'not_wired') return isDegradedBlock(value);
  if (status !== 'monitored') return false;
  // Field presence alone is not enough: `{ status:'monitored', hostFlag:{} }`
  // used to pass here and then fail the client validator, rendering the page
  // as "unreachable" instead of a structured collection failure (PR #2563
  // review, CodeRabbit finding 4545201393).
  for (const field of ['hostFlag', 'ingestionFlag'] as const) {
    const flag = Reflect.get(value, field);
    if (typeof flag !== 'object' || flag === null || Array.isArray(flag)) return false;
    const state = Reflect.get(flag, 'state');
    if (state !== 'ENABLED' && state !== 'DISABLED' && state !== 'UNKNOWN') return false;
    if (typeof Reflect.get(flag, 'source') !== 'string') return false;
  }
  const consent = Reflect.get(value, 'consent');
  if (typeof consent !== 'object' || consent === null || Array.isArray(consent)
    || typeof Reflect.get(consent, 'state') !== 'string') return false;
  return isCheckpointsPart(Reflect.get(value, 'checkpoints'))
    && isLiveOnlyPart(Reflect.get(value, 'liveOnly'));
}

/**
 * rc-1..rc-4: stdout from a subprocess is untrusted runtime data even when
 * the subprocess is our own CLI, so the section-bearing fields are checked
 * before the passthrough cast. This distinguishes a real report from a
 * usage/rejection JSON or truncated output; the cast stays a verbatim
 * passthrough of the CLI's documented contract (runtime-contract-exempt per
 * the CodexGovernanceHealthModel precedent) because it sits behind the guards.
 */
function parseIngestionReport(text: string): IngestionHealthSnapshot | undefined {
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const generatedAt = Reflect.get(parsed, 'generatedAt');
  const workspace = Reflect.get(parsed, 'workspace');
  if (typeof generatedAt !== 'string' || typeof workspace !== 'string') return undefined;
  const ingestion = Reflect.get(parsed, 'ingestion');
  if (typeof ingestion !== 'object' || ingestion === null || Array.isArray(ingestion)) return undefined;
  const section: Record<string, unknown> = ingestion;
  const codex = Reflect.get(section, 'codex');
  const workbuddy = Reflect.get(section, 'workbuddy');
  const openclaw = Reflect.get(section, 'openclaw');
  // isHostRow is a type predicate — the validated values flow through with no cast.
  if (!isHostRow(codex) || !isHostRow(workbuddy) || !isHostRow(openclaw)) return undefined;
  return {
    status: 'ok',
    generatedAt,
    workspace,
    ingestion: { codex, workbuddy, openclaw },
  };
}

/** rc-1/rc-2: the failure shape from fs/exec is unknown — read fields only if present. */
function stdoutFromExecError(error: unknown): string {
  if (typeof error !== 'object' || error === null || !Object.hasOwn(error, 'stdout')) return '';
  const { stdout } = error as { stdout?: unknown };
  return typeof stdout === 'string' ? stdout : '';
}

function execFailureKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const rec = error as Record<string, unknown>;
  if (rec.killed === true) return 'killed';
  if (typeof rec.signal === 'string' && rec.signal.length > 0) return `signal ${rec.signal}`;
  if (typeof rec.code === 'string') return rec.code;
  return undefined;
}

export class IngestionHealthModel {
  private readonly workspaceDir: string;
  private readonly cliEntryOverride: string | null;
  private readonly execTimeoutMs: number;

  constructor(workspaceDir: string, cliEntryOverride?: string, options?: { execTimeoutMs?: number }) {
    this.workspaceDir = workspaceDir;
    this.cliEntryOverride = cliEntryOverride ?? null;
    // Production default; the option exists only so a regression test can
    // trigger a REAL timeout kill without waiting 30s (PRI-1013 discipline).
    this.execTimeoutMs = options?.execTimeoutMs ?? 30_000;
  }

  async collect(): Promise<IngestionHealthResult> {
    const resolution = this.cliEntryOverride !== null
      ? { ok: true as const, entry: this.cliEntryOverride }
      : resolvePdCliEntry();
    if (!resolution.ok) {
      return degradedCollection(resolution.reason, resolution.nextAction);
    }
    let stdout: string;
    try {
      const result = await execFileAsync(
        process.execPath,
        [resolution.entry, 'health', '--workspace', this.workspaceDir, '--json'],
        { encoding: 'utf8', timeout: this.execTimeoutMs, windowsHide: true },
      );
      ({ stdout } = result);
    } catch (error) {
      // A parseable report on ANY non-killed exit is accepted: the main health
      // report may exit 1 for OTHER degraded sections (ledger/MCP) after
      // printing the full JSON. killed/signal/spawn failures never render.
      const failureKind = execFailureKind(error);
      if (failureKind !== undefined) {
        return degradedCollection('health_collection_failed', `${errorMessage(error).slice(0, 160)} [${failureKind}]`);
      }
      const report = parseIngestionReport(stdoutFromExecError(error));
      if (report !== undefined) return { status: 'ok', snapshot: report };
      return degradedCollection('health_collection_failed', errorMessage(error).slice(0, 160));
    }
    const snapshot = parseIngestionReport(stdout);
    if (snapshot === undefined) {
      // degradedCollection already prefixes MANUAL_RUN_ACTION — pass an empty
      // detail, otherwise the same sentence is emitted twice (PR #2563 review).
      return degradedCollection('health_report_unparseable', '');
    }
    return { status: 'ok', snapshot };
  }
}
