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

function isHostRow(value: unknown): value is IngestionHostRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const status = Reflect.get(value, 'status');
  return status === 'monitored' || status === 'not_wired';
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
      return degradedCollection('health_report_unparseable', MANUAL_RUN_ACTION);
    }
    return { status: 'ok', snapshot };
  }
}
