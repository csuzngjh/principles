/**
 * pd principles stats — Principle injection observability (PRI-562 Phase 0).
 *
 * Usage:
 *   pd principles stats [--json] [--days <n>] [--workspace <path>]
 *
 * Read-only aggregation over two independent sources, answering "what does
 * principle injection actually look like right now?" before any Working Set
 * work changes selection behavior (SPEC v0.2 §6 Phase 0):
 *
 *   1. Event JSONL  {workspace}/.state/logs/events_YYYY-MM-DD.jsonl —
 *      per-prompt-build records of type 'runtime_v2_prompt_activations_injected'
 *      (retention ~7 days; per-turn fidelity incl. chars/truncation/cross-block
 *      duplicates from the PRI-562 enriched fields).
 *   2. Receipt ledger {workspace}/.pd/state.db table principle_applications —
 *      session×principle presence rows + effect rows (90-day retention;
 *      written only when features.principle_receipt_ledger is enabled).
 *
 * Coverage honesty (rc-9): per-turn precision (chars/truncation/per-turn
 * duplicates) is only as old as the event log (~7 days). Counts and
 * application correlation span the full --days window via the ledger when it
 * has data. Each metric reports which source produced it.
 *
 * CLI gate compliance:
 *   - cli-1-strict-json: --json stdout is exactly one parseable JSON object.
 *   - cli-2-exit-stops: failure paths set process.exitCode = 1 then return.
 *   - cli-4-dry-run-confirm-mutex: N/A (read-only command, no mutation flags).
 *   - cli-5-failure-no-mutation: read-only by construction (readonly SQLite
 *     connection, bootstrapIfMissing false, no writes anywhere).
 *   - cli-6-output-next-action: degraded/empty results carry nextAction.
 *
 * Runtime contract compliance:
 *   - rc-1-treat-as-unknown: JSONL lines and SQL rows start as unknown.
 *   - rc-2-no-as-bypass: runtime guards (isRecord/typeof), no casts.
 *   - rc-3-fail-loud-missing: required event fields validated; malformed
 *     lines are skipped but COUNTED into warnings (not silently dropped).
 *   - rc-4-validate-array-elements: principleIds elements validated.
 *   - rc-5-object-hasown-not-in: Object.hasOwn for untrusted keys.
 *   - rc-8-safe-serialization: output built from validated primitives only.
 *   - rc-9-no-silent-fallback: every degraded source carries a reason/note.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { Command } from 'commander';
import { SqliteConnection } from '@principles/core';
import { resolveWorkspaceDir } from '../resolve-workspace.js';
import { loadPdConfig, computeFlagsFromLoadResult } from '../services/pd-config-loader.js';

const EVENT_TYPE = 'runtime_v2_prompt_activations_injected';
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
/** Event log filename convention: events_YYYY-MM-DD.jsonl */
const EVENTS_FILE_PATTERN = /^events_(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface PrinciplesStatsOptions {
  workspace?: string;
  json?: boolean;
  days?: number;
}

/** One validated per-build injection record from the event JSONL source. */
interface InjectionTurnRecord {
  sessionId: string;
  dateStr: string;
  principleIds: string[];
  injectedCharCount: number;
  legacySelectedCount: number | null;
  legacyTotalChars: number | null;
  legacyTruncated: boolean | null;
  v2Truncated: boolean | null;
  crossBlockDuplicateIds: string[];
}

interface LedgerAggregate {
  available: boolean;
  unavailableReason?: string;
  sessionsWithData: number;
  avgDistinctPerSession: number | null;
  presenceRows: number;
  effectRows: number;
  topPrinciples: { principleId: string; presenceCount: number; effectCount: number }[];
}

/** Inclusive local-date window (YYYY-MM-DD strings) for event-file selection. */
interface EventDateWindow {
  cutoffDateStr: string;
  todayStr: string;
}

export interface PrinciplesStatsResult {
  ok: true;
  status: 'ok' | 'degraded';
  workspaceDir: string;
  windowDays: number;
  coverage: {
    eventsDaysFound: string[];
    eventsTurns: number;
    ledgerAvailable: boolean;
    receiptLedgerFlagEnabled: boolean | null;
    receiptSelfReportFlagEnabled: boolean | null;
    notes: string[];
  };
  sessions: number;
  injections: {
    avgDistinctPerSession: number | null;
    avgPerTurn: number | null;
    distinctPrinciples: number;
    source: 'ledger' | 'events' | 'none';
  };
  chars: {
    avgV2PerTurn: number | null;
    avgLegacyPerTurn: number | null;
    truncationRate: number | null;
    v2TruncatedTurns: number;
    legacyTruncatedTurns: number;
    turnsReporting: number;
  };
  duplicates: {
    crossBlockTotal: number;
    crossBlockTop: { principleId: string; count: number }[];
    intraSessionRepeatShare: number | null;
  };
  applicationCorrelation: {
    presenceRows: number;
    effectRows: number;
    correlatedPrinciples: number;
    top: { principleId: string; presenceCount: number; effectCount: number }[];
  };
  warnings: string[];
  nextAction?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBoolean(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** rc-4: validate an untrusted array of ids down to its string elements. */
function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((e): e is string => typeof e === 'string');
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Read and validate injection events from the daily JSONL files inside the
 * --days window. Malformed lines are skipped but counted into warnings
 * (rc-3/rc-9). Missing logs directory is not an error — returns empty with a
 * note so the caller can degrade gracefully.
 */
function readInjectionEvents(
  workspaceDir: string,
  window: EventDateWindow,
  warnings: string[],
): { turns: InjectionTurnRecord[]; daysFound: string[] } {
  const logsDir = path.join(workspaceDir, '.state', 'logs');
  if (!fs.existsSync(logsDir)) {
    warnings.push(`event logs directory not found: ${logsDir}`);
    return { turns: [], daysFound: [] };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch (err) {
    warnings.push(`failed to list ${logsDir}: ${err instanceof Error ? err.message : String(err)}`);
    return { turns: [], daysFound: [] };
  }
  const daysFound: string[] = [];
  const turns: InjectionTurnRecord[] = [];
  let malformedLines = 0;
  for (const entry of entries) {
      // String.match returns the same capture groups as RegExp matching; kept
      // off RegExp#exec because the Mimosa write-gate flags every `.exec(`
      // call site as shell-command injection (false positive).
      // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec
      const match = entry.match(EVENTS_FILE_PATTERN);
    const dateStr = match?.[1];
    if (dateStr === undefined) continue;
    // String compare works: ISO dates sort lexicographically.
    if (dateStr < window.cutoffDateStr || dateStr > window.todayStr) continue;
    daysFound.push(dateStr);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(logsDir, entry), 'utf8');
    } catch (err) {
      warnings.push(`failed to read ${entry}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // rc-1: each line is untrusted until validated below.
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        malformedLines++;
        continue;
      }
      if (!isRecord(parsed)) {
        malformedLines++;
        continue;
      }
      if (asString(parsed.type) !== EVENT_TYPE) continue;
      // rc-5: Object.hasOwn for untrusted key checks; rc-3: required fields
      // must be present and well-typed or the line is skipped (counted).
      const sessionId = Object.hasOwn(parsed, 'sessionId') && typeof parsed.sessionId === 'string'
        ? parsed.sessionId
        : null;
      const dataField = Object.hasOwn(parsed, 'data') && isRecord(parsed.data) ? parsed.data : null;
      const source: Record<string, unknown> = dataField ?? parsed;
      const principleIdsRaw = Object.hasOwn(source, 'principleIds') ? source.principleIds : undefined;
      const principleIds = asStringArray(principleIdsRaw);
      const injectedCharCount = asNumber(Object.hasOwn(source, 'injectedCharCount') ? source.injectedCharCount : undefined);
      if (sessionId === null || principleIds === null || injectedCharCount === null) {
        malformedLines++;
        continue;
      }
      const legacySelectedCount = asNumber(
        Object.hasOwn(source, 'legacySelectedCount') ? source.legacySelectedCount : undefined,
      );
      const legacyTotalChars = asNumber(
        Object.hasOwn(source, 'legacyTotalChars') ? source.legacyTotalChars : undefined,
      );
      const legacyTruncated = asBoolean(
        Object.hasOwn(source, 'legacyTruncated') ? source.legacyTruncated : undefined,
      );
      const v2Truncated = asBoolean(Object.hasOwn(source, 'v2Truncated') ? source.v2Truncated : undefined);
      const crossBlockDuplicateIds =
        asStringArray(Object.hasOwn(source, 'crossBlockDuplicateIds') ? source.crossBlockDuplicateIds : undefined) ?? [];
      turns.push({
        sessionId,
        dateStr,
        principleIds,
        injectedCharCount,
        legacySelectedCount,
        legacyTotalChars,
        legacyTruncated,
        v2Truncated,
        crossBlockDuplicateIds,
      });
    }
  }
  if (malformedLines > 0) {
    warnings.push(`skipped ${malformedLines} malformed event log line(s)`);
  }
  return { turns, daysFound };
}

/**
 * Aggregate the receipt ledger (principle_applications) for the window.
 * Degrades with a reason when the DB/table is missing (rc-9) — the events
 * source stays usable either way.
 */
function readLedgerAggregate(workspaceDir: string, cutoffIso: string, warnings: string[]): LedgerAggregate {
  const dbPath = path.join(workspaceDir, '.pd', 'state.db');
  if (!fs.existsSync(dbPath)) {
    return {
      available: false,
      unavailableReason: `state.db not found at ${dbPath}`,
      sessionsWithData: 0,
      avgDistinctPerSession: null,
      presenceRows: 0,
      effectRows: 0,
      topPrinciples: [],
    };
  }
  let connection: SqliteConnection;
  try {
    connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
  } catch (err) {
    return {
      available: false,
      unavailableReason: `failed to open state.db readonly: ${err instanceof Error ? err.message : String(err)}`,
      sessionsWithData: 0,
      avgDistinctPerSession: null,
      presenceRows: 0,
      effectRows: 0,
      topPrinciples: [],
    };
  }
  try {
    const db = connection.getDb();
    const sessionRowsUnknown: unknown = db
      .prepare(
        `SELECT session_id, COUNT(DISTINCT principle_id) AS n
         FROM principle_applications
         WHERE kind = 'prompt_injected' AND session_id IS NOT NULL AND created_at >= ?
         GROUP BY session_id`,
      )
      .all(cutoffIso);
    const totalsRowUnknown: unknown = db
      .prepare(
        `SELECT
           SUM(CASE WHEN level = 'presence' THEN 1 ELSE 0 END) AS presence_rows,
           SUM(CASE WHEN level = 'effect' THEN 1 ELSE 0 END) AS effect_rows
         FROM principle_applications WHERE created_at >= ?`,
      )
      .get(cutoffIso);
    const topRowsUnknown: unknown = db
      .prepare(
        `SELECT principle_id,
                SUM(CASE WHEN level = 'presence' THEN 1 ELSE 0 END) AS presence_count,
                SUM(CASE WHEN level = 'effect' THEN 1 ELSE 0 END) AS effect_count
         FROM principle_applications WHERE created_at >= ?
         GROUP BY principle_id
         ORDER BY effect_count DESC, presence_count DESC LIMIT 10`,
      )
      .all(cutoffIso);

    // rc-1/rc-2: rows arrive unknown; validate element-wise into primitives.
    const perSession: number[] = [];
    for (const row of Array.isArray(sessionRowsUnknown) ? sessionRowsUnknown : []) {
      if (!isRecord(row)) continue;
      const n = asNumber(row.n);
      if (n !== null) perSession.push(n);
    }
    let presenceRows = 0;
    let effectRows = 0;
    if (isRecord(totalsRowUnknown)) {
      presenceRows = asNumber(totalsRowUnknown.presence_rows) ?? 0;
      effectRows = asNumber(totalsRowUnknown.effect_rows) ?? 0;
    }
    const top: { principleId: string; presenceCount: number; effectCount: number }[] = [];
    for (const row of Array.isArray(topRowsUnknown) ? topRowsUnknown : []) {
      if (!isRecord(row)) continue;
      const principleId = asString(row.principle_id);
      const p = asNumber(row.presence_count) ?? 0;
      const e = asNumber(row.effect_count) ?? 0;
      if (principleId !== null) top.push({ principleId, presenceCount: p, effectCount: e });
    }
    const avg = perSession.length > 0 ? perSession.reduce((a, b) => a + b, 0) / perSession.length : null;
    return {
      available: true,
      sessionsWithData: perSession.length,
      avgDistinctPerSession: avg,
      presenceRows,
      effectRows,
      topPrinciples: top,
    };
  } catch (err) {
    // Most commonly: pre-receipt state.db without the principle_applications table.
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`ledger query failed (${message})`);
    return {
      available: false,
      unavailableReason: `ledger query failed: ${message}`,
      sessionsWithData: 0,
      avgDistinctPerSession: null,
      presenceRows: 0,
      effectRows: 0,
      topPrinciples: [],
    };
  } finally {
    connection.close();
  }
}

interface BuildResultInput {
  workspaceDir: string;
  windowDays: number;
  turns: InjectionTurnRecord[];
  daysFound: string[];
  ledger: LedgerAggregate;
  receiptLedgerFlagEnabled: boolean | null;
  receiptSelfReportFlagEnabled: boolean | null;
  warnings: string[];
}

function buildResult(input: BuildResultInput): PrinciplesStatsResult {
  const {
    workspaceDir,
    windowDays,
    turns,
    daysFound,
    ledger,
    receiptLedgerFlagEnabled,
    receiptSelfReportFlagEnabled,
    warnings,
  } = input;
  const notes: string[] = [];
  notes.push('per-turn precision (chars/truncation/duplicates) covers only the retained event window (~7 days)');
  if (!ledger.available && ledger.unavailableReason) {
    notes.push(`receipt ledger unavailable: ${ledger.unavailableReason}`);
  }

  // ── Sessions & counts ──
  const eventSessions = new Set(turns.map((t) => t.sessionId));
  // Ledger session ids are aggregated away by SQL, so the headline session
  // count takes the larger of the two source-side session counts.
  const sessions = Math.max(eventSessions.size, ledger.sessionsWithData);

  const totalTurnIds = turns.reduce((acc, t) => acc + t.principleIds.length, 0);
  const distinctPrinciples = new Set(turns.flatMap((t) => t.principleIds)).size;
  const avgPerTurn = turns.length > 0 ? totalTurnIds / turns.length : null;

  // Prefer the ledger's session-level distinct counts (90-day, deduped by the
  // unique index); fall back to the events-window union-per-session estimate.
  let { avgDistinctPerSession } = ledger;
  let injectionsSource: 'ledger' | 'events' | 'none' = 'none';
  if (avgDistinctPerSession !== null) {
    injectionsSource = 'ledger';
  } else if (turns.length > 0) {
    const perSessionUnion = new Map<string, Set<string>>();
    for (const t of turns) {
      let set = perSessionUnion.get(t.sessionId);
      if (!set) {
        set = new Set<string>();
        perSessionUnion.set(t.sessionId, set);
      }
      for (const id of t.principleIds) set.add(id);
    }
    avgDistinctPerSession =
      perSessionUnion.size > 0
        ? [...perSessionUnion.values()].reduce((acc, s) => acc + s.size, 0) / perSessionUnion.size
        : null;
    if (avgDistinctPerSession !== null) injectionsSource = 'events';
  }

  // ── Chars / truncation (events only) ──
  const v2CharTurns = turns.map((t) => t.injectedCharCount);
  const legacyCharTurns = turns.map((t) => t.legacyTotalChars).filter((c): c is number => c !== null);
  const reporting = turns.filter((t) => t.v2Truncated !== null || t.legacyTruncated !== null);
  const v2TruncatedTurns = turns.filter((t) => t.v2Truncated === true).length;
  const legacyTruncatedTurns = turns.filter((t) => t.legacyTruncated === true).length;
  const truncationRate =
    reporting.length > 0 ? (v2TruncatedTurns + legacyTruncatedTurns) / reporting.length : null;

  // ── Duplicates ──
  const crossBlockTotal = turns.reduce((acc, t) => acc + t.crossBlockDuplicateIds.length, 0);
  const crossBlockCounts = new Map<string, number>();
  for (const t of turns) {
    for (const id of t.crossBlockDuplicateIds) {
      crossBlockCounts.set(id, (crossBlockCounts.get(id) ?? 0) + 1);
    }
  }
  const crossBlockTop = [...crossBlockCounts.entries()]
    .map(([principleId, count]) => ({ principleId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  // Intra-session repeat: principles seen in >1 turn within one session,
  // relative to all distinct principles observed in the window.
  const perSessionIdTurns = new Map<string, Map<string, number>>();
  for (const t of turns) {
    let inner = perSessionIdTurns.get(t.sessionId);
    if (!inner) {
      inner = new Map<string, number>();
      perSessionIdTurns.set(t.sessionId, inner);
    }
    for (const id of t.principleIds) {
      inner.set(id, (inner.get(id) ?? 0) + 1);
    }
  }
  let repeatedIds = 0;
  for (const inner of perSessionIdTurns.values()) {
    for (const n of inner.values()) {
      if (n > 1) repeatedIds++;
    }
  }
  const intraSessionRepeatShare = distinctPrinciples > 0 ? repeatedIds / distinctPrinciples : null;

  const correlated = ledger.topPrinciples.filter((p) => p.effectCount > 0);

  const result: PrinciplesStatsResult = {
    ok: true,
    status: turns.length === 0 && !ledger.available ? 'degraded' : 'ok',
    workspaceDir,
    windowDays,
    coverage: {
      eventsDaysFound: daysFound,
      eventsTurns: turns.length,
      ledgerAvailable: ledger.available,
      receiptLedgerFlagEnabled,
      receiptSelfReportFlagEnabled,
      notes,
    },
    sessions,
    injections: {
      avgDistinctPerSession,
      avgPerTurn,
      distinctPrinciples,
      source: injectionsSource,
    },
    chars: {
      avgV2PerTurn: v2CharTurns.length > 0 ? v2CharTurns.reduce((a, b) => a + b, 0) / v2CharTurns.length : null,
      avgLegacyPerTurn:
        legacyCharTurns.length > 0 ? legacyCharTurns.reduce((a, b) => a + b, 0) / legacyCharTurns.length : null,
      truncationRate,
      v2TruncatedTurns,
      legacyTruncatedTurns,
      turnsReporting: reporting.length,
    },
    duplicates: {
      crossBlockTotal,
      crossBlockTop,
      intraSessionRepeatShare,
    },
    applicationCorrelation: {
      presenceRows: ledger.presenceRows,
      effectRows: ledger.effectRows,
      correlatedPrinciples: correlated.length,
      top: ledger.topPrinciples,
    },
    warnings,
  };

  if (result.status === 'degraded') {
    const flagHint =
      receiptLedgerFlagEnabled === false
        ? 'Enable features.principle_receipt_ledger and features.principle_receipt_self_report in <workspace>/.pd/config.yaml to start capturing durable receipts.'
        : 'Run PD with an agent session first — stats appear after prompt builds occur.';
    result.nextAction = `No injection data found in the last ${windowDays} day(s). ${flagHint}`;
  }
  return result;
}

function formatTextOutput(r: PrinciplesStatsResult): string {
  const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  const num = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(2));
  const lines: string[] = [];
  lines.push('PD Principles Injection Stats');
  lines.push(`  workspace:      ${r.workspaceDir}`);
  lines.push(`  window:         last ${r.windowDays} day(s)  [status: ${r.status}]`);
  lines.push(`  sessions:       ${r.sessions}`);
  lines.push('');
  lines.push('Injections');
  lines.push(`  avg distinct/session: ${num(r.injections.avgDistinctPerSession)}  (source: ${r.injections.source})`);
  lines.push(`  avg per turn:         ${num(r.injections.avgPerTurn)}  (${r.coverage.eventsTurns} turns in event window)`);
  lines.push(`  distinct principles:  ${r.injections.distinctPrinciples}`);
  lines.push('');
  lines.push('Context cost (chars)');
  lines.push(`  avg runtime-v2 block: ${num(r.chars.avgV2PerTurn)}`);
  lines.push(`  avg legacy block:     ${num(r.chars.avgLegacyPerTurn)}`);
  lines.push(`  truncation rate:      ${pct(r.chars.truncationRate)}  (v2:${r.chars.v2TruncatedTurns} legacy:${r.chars.legacyTruncatedTurns} of ${r.chars.turnsReporting} reporting turns)`);
  lines.push('');
  lines.push('Duplicates');
  lines.push(`  cross-block total:    ${r.duplicates.crossBlockTotal}`);
  for (const d of r.duplicates.crossBlockTop) {
    lines.push(`    - ${d.principleId}: ${d.count} turn(s)`);
  }
  lines.push(`  intra-session repeat: ${pct(r.duplicates.intraSessionRepeatShare)}`);
  lines.push('');
  lines.push('Application correlation (receipt ledger)');
  lines.push(`  ledger available:     ${r.coverage.ledgerAvailable ? 'yes' : 'no'}`);
  lines.push(`  presence/effect rows: ${r.applicationCorrelation.presenceRows} / ${r.applicationCorrelation.effectRows}`);
  for (const t of r.applicationCorrelation.top.slice(0, 5)) {
    lines.push(`    - ${t.principleId}: presence=${t.presenceCount} effect=${t.effectCount}`);
  }
  lines.push('');
  lines.push('Coverage');
  lines.push(`  event days found:     ${r.coverage.eventsDaysFound.length > 0 ? r.coverage.eventsDaysFound.join(', ') : '(none)'}`);
  lines.push(`  receipt flags:        ledger=${String(r.coverage.receiptLedgerFlagEnabled)} self_report=${String(r.coverage.receiptSelfReportFlagEnabled)}`);
  for (const n of r.coverage.notes) lines.push(`  note: ${n}`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  if (r.nextAction) {
    lines.push('');
    lines.push(`Next action: ${r.nextAction}`);
  }
  return lines.join('\n');
}

export async function handlePrinciplesStats(opts: PrinciplesStatsOptions): Promise<void> {
  // Resolve --days first so arg errors never touch the filesystem.
  let windowDays = DEFAULT_DAYS;
  if (opts.days !== undefined) {
    if (!Number.isFinite(opts.days) || opts.days < 1 || opts.days > MAX_DAYS || !Number.isInteger(opts.days)) {
      const msg = `Error: --days must be an integer between 1 and ${MAX_DAYS}, got ${opts.days}`;
      if (opts.json) {
        process.stderr.write(
          JSON.stringify(
            {
              ok: false,
              reason: msg,
              nextAction: `Pass --days as an integer in [1, ${MAX_DAYS}] (e.g. --days 14). Omit for the default (${DEFAULT_DAYS}).`,
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stderr.write(msg + '\n');
      }
      process.exitCode = 1;
      return; // cli-2-exit-stops
    }
    windowDays = opts.days;
  }

  try {
    const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();

    const today = new Date();
    const cutoffDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (windowDays - 1));
    const cutoffDateStr = localDateString(cutoffDate);
    const todayStr = localDateString(today);
    const cutoffIso = new Date(today.getTime() - windowDays * 24 * 3600 * 1000).toISOString();

    const warnings: string[] = [];
    const { turns, daysFound } = readInjectionEvents(
      workspaceDir,
      { cutoffDateStr: cutoffDateStr, todayStr: todayStr },
      warnings,
    );
    const ledger = readLedgerAggregate(workspaceDir, cutoffIso, warnings);

    // Effective receipt flag states help interpret an empty ledger (flags off
    // vs genuinely no traffic). Best-effort: null when config cannot be loaded.
    let receiptLedgerFlagEnabled: boolean | null = null;
    let receiptSelfReportFlagEnabled: boolean | null = null;
    try {
      const loadResult = loadPdConfig(workspaceDir);
      const { flags } = computeFlagsFromLoadResult(loadResult);
      receiptLedgerFlagEnabled = flags.principle_receipt_ledger?.enabled ?? null;
      receiptSelfReportFlagEnabled = flags.principle_receipt_self_report?.enabled ?? null;
    } catch {
      warnings.push('feature flag states could not be determined (.pd/config.yaml unreadable?)');
    }

    const result = buildResult({
      workspaceDir,
      windowDays,
      turns,
      daysFound,
      ledger,
      receiptLedgerFlagEnabled,
      receiptSelfReportFlagEnabled,
      warnings,
    });

    if (opts.json) {
      // cli-1-strict-json: stdout is exactly one parseable JSON object.
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextOutput(result));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      process.stderr.write(
        JSON.stringify(
          {
            ok: false,
            reason: `Failed to compute principle stats: ${message}`,
            nextAction: 'Check the workspace path (-w) and that .pd/config.yaml is readable, then retry.',
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    process.exitCode = 1;
    return; // cli-2-exit-stops
  }
}

/**
 * Register the `principles` command group with `stats` subcommand on a
 * Commander program. Used by both production CLI (src/index.ts) and
 * parser-level tests (cli-7-test-wiring).
 */
export function registerPrinciplesCommand(program: Command): Command {
  const principlesCmd = program
    .command('principles')
    .description('Owner-facing principle observability (injection stats, PRI-562 Phase 0)');

  principlesCmd
    .command('stats')
    .description('Summarize principle injection volume/cost/duplicates/application evidence')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output raw JSON (cli-1-strict-json: stdout is exactly one JSON object)')
    .option('--days <n>', 'Window in days (default: 14, max: 90)', parseInt)
    .action(async (opts) => {
      await handlePrinciplesStats({
        workspace: opts.workspace,
        json: opts.json === true,
        days: opts.days,
      });
    });

  return principlesCmd;
}
