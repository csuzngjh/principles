import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  applyTrajectorySchemaBase,
  buildToolFailureObservation,
  evaluateTriage,
  evaluateTriggerController,
  resolveSourceKind,
  sanitizeToolParams,
  sanitizeValue,
} from '@principles/core/runtime-v2';
import type { GovernanceHostKind } from '@principles/core/runtime-v2';
import type { HostEvent, HostEventEmitter, HostEventResult } from '@principles/core/host';

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'write_file', 'edit_file', 'replace']);
/** Shared with the governance admission path so both gate tool failures identically. */
export const PRODUCTION_WRITE_TOOLS: ReadonlySet<string> = WRITE_TOOLS;
const MAX_PREVIEW = 500;
const PAIN_COOLDOWN_WINDOW_MS = 15 * 60 * 1000;
const cooldowns = new Map<string, number>();

export interface PainEvidenceEntry {
  sourceRef: string;
  note: string;
}

export interface ProductionPainEnrichment {
  eventId?: string;
  painScore?: number;
  isRisky?: boolean;
  consecutiveErrors?: number;
  relativePath?: string;
  agentId?: string;
  errorHash?: string;
  evidence?: readonly PainEvidenceEntry[];
}

export type PainEnrichmentProvider = (event: HostEvent) => unknown | Promise<unknown>;
export type PainDatabaseFactory = (databasePath: string) => Database.Database;

/** SPEC-CODEX-PAIN-CLOSURE-001 CR-01: a tool result is success, failure or unknown. */
export type ToolOutcomeClassification = 'success' | 'failure' | 'unknown';

interface NormalizedOutcome {
  outcome: ToolOutcomeClassification;
  failure: boolean;
  exitCode: number | null;
  /** Bounded structured reason present when the outcome is unknown (rc-9). */
  unknownReason?: string;
  error?: string;
  durationMs?: number;
  params: unknown;
  result: unknown;
}

/** Structural input accepted by the canonical derivations (HostEvent satisfies it without a cast). */
export interface ProductionToolEventFields {
  workspaceDir: string;
  sessionId: string;
  turnId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-01 (PRI-960): classify a tool result as
 * success / failure / unknown from structured facts only — a missing exit
 * code must never become a fabricated 0, and text-only responses must never
 * be guessed into success or failure by keyword scanning.
 *
 * Verified Codex facts (codex-rs core/src/tools/context.rs): PostToolUse
 * `tool_response` for the shell tool is a plain string (the truncated output
 * text); the exit code is only published to the transcript CommandExecution
 * record. Plain-text responses therefore classify as unknown here and are
 * upgraded later by the consent-gated transcript path (recordVerifiedToolOutcomes).
 *
 * Structured read tools (object/array results without an error field) are a
 * legitimate completion of the tool contract and stay success (SPEC §5.1).
 */
function normalizeOutcome(event: Pick<HostEvent, 'context'> | ProductionToolEventFields): NormalizedOutcome {
  const context = 'context' in event ? event.context : event;
  const envelope = context.toolOutput;
  const result = field(envelope, 'result') ?? envelope;
  const errorValue = field(envelope, 'error') ?? field(result, 'error');
  const error = errorValue === undefined || errorValue === null || errorValue === '' ? undefined : String(errorValue);
  // Exit-code candidates: camelCase AND snake_case at the envelope, result,
  // details and metadata levels (Codex transcript facts arrive snake_case).
  const exitCandidates: unknown[] = [
    field(envelope, 'exitCode'), field(envelope, 'exit_code'),
    field(result, 'exitCode'), field(result, 'exit_code'),
    field(field(result, 'details'), 'exitCode'), field(field(result, 'details'), 'exit_code'),
    field(field(result, 'metadata'), 'exitCode'), field(field(result, 'metadata'), 'exit_code'),
  ];
  const exitCandidate = exitCandidates.find((value) => typeof value === 'number' && Number.isInteger(value));
  const exitCode = typeof exitCandidate === 'number' ? exitCandidate : null;
  const durationValue = field(envelope, 'durationMs');

  let outcome: ToolOutcomeClassification;
  let unknownReason: string | undefined;
  if (error !== undefined) {
    outcome = 'failure';
  } else if (exitCode !== null) {
    outcome = exitCode === 0 ? 'success' : 'failure';
  } else if (typeof envelope === 'string' || typeof result === 'string') {
    outcome = 'unknown';
    unknownReason = 'text_only_response';
  } else if (isRecord(envelope) || Array.isArray(envelope)) {
    outcome = 'success';
  } else {
    outcome = 'unknown';
    unknownReason = 'unconfirmed_result_shape';
  }
  return {
    outcome,
    failure: outcome === 'failure',
    exitCode,
    ...(unknownReason !== undefined ? { unknownReason } : {}),
    ...(error ? { error: error.slice(0, MAX_PREVIEW) } : {}),
    ...(typeof durationValue === 'number' && Number.isFinite(durationValue) && durationValue >= 0 ? { durationMs: durationValue } : {}),
    params: context.toolInput ?? {},
    result,
  };
}

function isEvidence(value: unknown): value is readonly PainEvidenceEntry[] {
  return Array.isArray(value) && value.length <= 8 && value.every((entry) =>
    isRecord(entry) && typeof field(entry, 'sourceRef') === 'string' && String(field(entry, 'sourceRef')).trim().length > 0
      && String(field(entry, 'sourceRef')).length <= 300 && typeof field(entry, 'note') === 'string' && String(field(entry, 'note')).length <= 200);
}

function parseEnrichment(value: unknown): ProductionPainEnrichment | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const painScore = field(value, 'painScore');
  const isRisky = field(value, 'isRisky');
  const consecutiveErrors = field(value, 'consecutiveErrors');
  const evidence = field(value, 'evidence');
  const eventId = field(value, 'eventId');
  const relativePath = field(value, 'relativePath');
  const agentId = field(value, 'agentId');
  const errorHash = field(value, 'errorHash');
  if (painScore !== undefined && (typeof painScore !== 'number' || !Number.isFinite(painScore) || painScore < 0 || painScore > 100)) return null;
  if (isRisky !== undefined && typeof isRisky !== 'boolean') return null;
  if (consecutiveErrors !== undefined && (typeof consecutiveErrors !== 'number' || !Number.isInteger(consecutiveErrors) || consecutiveErrors < 0)) return null;
  for (const key of ['eventId', 'relativePath', 'agentId', 'errorHash'] as const) {
    const candidate = field(value, key);
    if (candidate !== undefined && (typeof candidate !== 'string' || candidate.trim().length === 0 || candidate.length > 500)) return null;
  }
  if (evidence !== undefined && !isEvidence(evidence)) return null;
  return {
    ...(typeof eventId === 'string' ? { eventId } : {}),
    ...(typeof painScore === 'number' ? { painScore } : {}),
    ...(typeof isRisky === 'boolean' ? { isRisky } : {}),
    ...(typeof consecutiveErrors === 'number' ? { consecutiveErrors } : {}),
    ...(typeof relativePath === 'string' ? { relativePath } : {}),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    ...(typeof errorHash === 'string' ? { errorHash } : {}),
    ...(isEvidence(evidence) ? { evidence } : {}),
  };
}

function stable(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 2_000));
    if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
    return JSON.stringify(String(value));
  }
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.slice(0, 50).map((item) => stable(item, seen)).join(',')}]`;
  const keys = Object.keys(value).sort().slice(0, 50);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(field(value, key), seen)}`).join(',')}}`;
}

function preview(value: unknown): string | null {
  try {
    const text = stable(value);
    return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 3)}...` : text;
  } catch {
    return '[result_preview_unavailable]';
  }
}

interface IdentityInput {
  workspaceDir: string;
  sessionId: string;
  turnId?: string;
  toolName?: string;
  source: string;
  canonicalEventId?: string;
  outcome: NormalizedOutcome;
  sanitizedParams: Record<string, unknown>;
}

function ids(input: IdentityInput): { eventId: string; painId: string } {
  const { outcome, sanitizedParams, canonicalEventId } = input;
  const canonical = stable({
    workspaceDir: path.resolve(input.workspaceDir),
    sessionId: input.sessionId,
    turnId: input.turnId ?? null,
    toolName: input.toolName,
    source: input.source,
    suppliedEventId: canonicalEventId ?? null,
    params: sanitizedParams,
    result: sanitizeValue(outcome.result, 0, input.workspaceDir),
    error: outcome.error ?? null,
    exitCode: outcome.exitCode,
    failure: outcome.failure,
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { eventId: `host_${digest}`, painId: `pain_host_${digest}` };
}

export interface DerivedToolPainIdentity {
  eventId: string;
  painId: string;
  outcome: NormalizedOutcome;
  sanitizedParams: Record<string, unknown>;
  paramsJson: string;
  resultPreview: string | null;
}

/**
 * The canonical tool-pain identity derivation, exposed for the governance
 * admission path (Codex Governance Closure SPEC §10): the same normalized
 * fields fed to the live production handler derive the same deterministic
 * `pain_host_<sha256>` id, so live and observation-delivered admissions of one
 * tool call converge on one canonical pain.
 */
export function deriveProductionToolPainIdentity(fields: ProductionToolEventFields & { canonicalEventId?: string }): DerivedToolPainIdentity {
  const outcome = normalizeOutcome(fields);
  const sanitizedParams = sanitizeToolParams(outcome.params, fields.workspaceDir);
  const { eventId, painId } = ids({
    workspaceDir: fields.workspaceDir,
    sessionId: fields.sessionId,
    ...(fields.turnId !== undefined ? { turnId: fields.turnId } : {}),
    ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
    source: fields.source,
    ...(fields.canonicalEventId !== undefined ? { canonicalEventId: fields.canonicalEventId } : {}),
    outcome,
    sanitizedParams,
  });
  return {
    eventId,
    painId,
    outcome,
    sanitizedParams,
    paramsJson: stable(sanitizedParams),
    resultPreview: preview({ eventId, result: sanitizeValue(outcome.result, 0, fields.workspaceDir) }),
  };
}

/**
 * The canonical correction-pain identity derivation (SPEC §10/§12): deterministic,
 * content-derived, retry-safe — replacing the legacy random `correction_<traceId>`
 * ids. The identity is scoped by a stable OCCURRENCE identity supplied by the
 * host (Codex hostTurnId / OpenClaw per-session turn index), so:
 *   - a retry / live+transcript replay of the SAME real occurrence → same pain;
 *   - the same correction text in a LATER real turn → a NEW pain occurrence.
 * The raw text participates only in the in-memory hash — it is never persisted
 * (the persistence boundary sanitizes it; see governance-signal-admission).
 */
export function deriveProductionCorrectionPainIdentity(fields: {
  workspaceDir: string;
  sessionId: string;
  /** Stable occurrence identity of the real correction event (host turn id / per-session turn index). */
  occurrenceId: string;
  text: string;
}): { eventId: string; painId: string } {
  const canonical = stable({
    workspaceDir: path.resolve(fields.workspaceDir),
    sessionId: fields.sessionId,
    occurrenceId: fields.occurrenceId,
    source: 'user_correction',
    text: fields.text,
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { eventId: `host_${digest}`, painId: `pain_host_${digest}` };
}


const REQUIRED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  sessions: { session_id: 'TEXT', started_at: 'TEXT', updated_at: 'TEXT' },
  tool_calls: { session_id: 'TEXT', tool_name: 'TEXT', outcome: 'TEXT', duration_ms: 'INTEGER', exit_code: 'INTEGER', error_type: 'TEXT', error_message: 'TEXT', gfi_before: 'REAL', gfi_after: 'REAL', params_json: 'TEXT', result_preview: 'TEXT', created_at: 'TEXT' },
  pain_events: { session_id: 'TEXT', source: 'TEXT', score: 'REAL', reason: 'TEXT', severity: 'TEXT', origin: 'TEXT', confidence: 'REAL', text: 'TEXT', canonical_pain_id: 'TEXT', runtime_task_id: 'TEXT', host_kind: 'TEXT', created_at: 'TEXT' },
};

function pragmaField(row: unknown, key: string): unknown {
  return isRecord(row) && Object.hasOwn(row, key) ? Object.getOwnPropertyDescriptor(row, key)?.value : undefined;
}

function hasCanonicalIndexPredicate(db: Database.Database): boolean {
  const row: unknown = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get('idx_pain_events_canonical_pain_id');
  const sql = pragmaField(row, 'sql');
  if (typeof sql !== 'string' || sql.length === 0 || sql.length > 2_000) return false;
  const normalized = sql
    .replace(/["'`]/g, '')
    .replace(/\[|\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .toUpperCase();
  const whereIndex = normalized.indexOf(' WHERE ');
  return whereIndex >= 0 && normalized.slice(whereIndex + 7) === 'CANONICAL_PAIN_ID IS NOT NULL';
}

function hasCanonicalSchema(db: Database.Database): boolean {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const rows: unknown[] = db.prepare(`PRAGMA table_info(${table})`).all();
    const actual = new Map<string, string>();
    for (const row of rows) {
      const name = pragmaField(row, 'name');
      const type = pragmaField(row, 'type');
      if (typeof name !== 'string' || typeof type !== 'string') return false;
      actual.set(name, type.toUpperCase());
    }
    for (const [name, type] of Object.entries(required)) {
      if (actual.get(name) !== type) return false;
    }
  }
  const indexes: unknown[] = db.prepare('PRAGMA index_list(pain_events)').all();
  const canonical = indexes.find((row) => pragmaField(row, 'name') === 'idx_pain_events_canonical_pain_id');
  if (pragmaField(canonical, 'unique') !== 1 || pragmaField(canonical, 'partial') !== 1) return false;
  if (!hasCanonicalIndexPredicate(db)) return false;
  const indexColumns: unknown[] = db.prepare('PRAGMA index_info(idx_pain_events_canonical_pain_id)').all();
  if (indexColumns.length !== 1 || pragmaField(indexColumns[0], 'name') !== 'canonical_pain_id') return false;
  // Preparing the exact production statements proves syntax/column readiness
  // without executing mutation or invoking host enrichment side effects.
  db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_use_id = ?');
  db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ? AND outcome = ? AND exit_code IS ? AND error_message IS ? AND result_preview IS ?');
  db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?');
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at');
  db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.prepare('INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return true;
}

/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-01: additive migration for the host
 * tool-call id join column. The schema-owning modules (trajectory-schema.ts
 * applyTrajectorySchemaBase) add it for every fresh/managed open; this local
 * ensure covers the raw production-handler open, which historically opens
 * trajectory.db without running the schema apply.
 */
function ensureToolCallsToolUseIdColumn(db: Database.Database): void {
  const columns: unknown[] = db.prepare('PRAGMA table_info(tool_calls)').all();
  if (columns.some((row) => pragmaField(row, 'name') === 'tool_use_id')) return;
  try {
    db.exec('ALTER TABLE tool_calls ADD COLUMN tool_use_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_session_tool_use_id ON tool_calls(session_id, tool_use_id)');
  } catch {
    // A concurrent writer may have added it between the check and the ALTER;
    // the prepared-statement readiness check below fails loud if it is truly absent.
  }
}

/** One host-verified tool outcome (SPEC-CODEX-PAIN-CLOSURE-001 CR-01). */
export interface VerifiedToolOutcomeInput {
  /** Host tool-call id — the join key written by the live PostToolUse path. */
  readonly toolUseId: string;
  readonly toolName: string;
  readonly params?: unknown;
  /** Verified process exit code from the host's authoritative tool-fact record. */
  readonly exitCode: number;
  readonly outputPreview?: string;
}

export type VerifiedToolOutcomeStatus =
  | { status: 'updated'; id: number }
  | { status: 'inserted'; id: number }
  | { status: 'skipped_final'; id: number; reason: 'outcome_already_final' }
  | { status: 'unavailable'; reason: 'trajectory_db_not_found' | 'trajectory_write_failed' | `trajectory_write_failed:${string}` };

/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-01: upgrade the live-hook observation of a
 * tool call with the host-verified final result (exit code) read through the
 * existing authorized transcript-facts path. Only rows still recorded as
 * `unknown` (text-only live response) are upgraded — a structured live fact
 * is never overwritten. Missing live rows are inserted so the verified fact
 * is durable even when the live hook never fired.
 */
export function recordVerifiedToolOutcomes(args: {
  workspaceDir: string;
  sessionId: string;
  outcomes: readonly VerifiedToolOutcomeInput[];
  painDatabaseFactory?: PainDatabaseFactory;
}): VerifiedToolOutcomeStatus[] {
  const results: VerifiedToolOutcomeStatus[] = [];
  if (args.outcomes.length === 0) return results;
  const dbPath = path.join(args.workspaceDir, '.state', 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    return args.outcomes.map(() => ({ status: 'unavailable', reason: 'trajectory_db_not_found' }));
  }
  let db: Database.Database | undefined;
  try {
    db = args.painDatabaseFactory ? args.painDatabaseFactory(dbPath) : new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    // Workspaces whose trajectory.db only ever carried the governance tables
    // (no live PostToolUse writer ran yet) lack tool_calls: apply the one
    // canonical base schema before upgrading (idempotent, DDL authority stays
    // with core's trajectory-schema).
    const hasToolCalls = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'").get() !== undefined);
    if (!hasToolCalls) applyTrajectorySchemaBase(db);
    ensureToolCallsToolUseIdColumn(db);
    const findByToolUseId = db.prepare('SELECT id, outcome FROM tool_calls WHERE session_id = ? AND tool_use_id = ? ORDER BY id LIMIT 1');
    const upgradeUnknown = db.prepare("UPDATE tool_calls SET outcome = ?, exit_code = ?, result_preview = COALESCE(?, result_preview) WHERE id = ? AND outcome = 'unknown'");
    const insertVerified = db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const upsertSession = db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at');
    const createdAt = new Date().toISOString();
    db.transaction(() => {
      for (const input of args.outcomes) {
        if (typeof input.exitCode !== 'number' || !Number.isInteger(input.exitCode)) continue;
        const finalOutcome = input.exitCode === 0 ? 'success' : 'failure';
        const existing = findByToolUseId.get(args.sessionId, input.toolUseId) as { id: number; outcome: string } | undefined;
        const boundedPreview = typeof input.outputPreview === 'string' && input.outputPreview.length > 0
          ? input.outputPreview.slice(0, MAX_PREVIEW)
          : null;
        if (existing !== undefined) {
          if (existing.outcome === 'unknown') {
            upgradeUnknown.run(finalOutcome, input.exitCode, boundedPreview, existing.id);
            results.push({ status: 'updated', id: existing.id });
          } else {
            results.push({ status: 'skipped_final', id: existing.id, reason: 'outcome_already_final' });
          }
          continue;
        }
        upsertSession.run(args.sessionId, createdAt, createdAt);
        const sanitizedParams = sanitizeToolParams(input.params ?? {}, args.workspaceDir);
        const info = insertVerified.run(args.sessionId, input.toolName, finalOutcome, null, input.exitCode, null, null, null, null, stable(sanitizedParams), boundedPreview, createdAt, input.toolUseId);
        results.push({ status: 'inserted', id: Number(info.lastInsertRowid) });
      }
    })();
  } catch (error) {
    const reason: `trajectory_write_failed:${string}` = `trajectory_write_failed:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`;
    const filled = results.length;
    for (let i = filled; i < args.outcomes.length; i += 1) results.push({ status: 'unavailable', reason });
  } finally {
    try { db?.close(); } catch { /* write result already determined; cleanup is best-effort */ }
  }
  return results;
}

/**
 * PRI-640: host attribution is supplied by the host adapter that constructs
 * this shared handler (OpenClaw / Codex adapters) — never guessed inside the
 * writer. Omitted -> NULL (unknown).
 */
export function createProductionPainEvidenceHandler(options: { painEnrichmentProvider?: PainEnrichmentProvider; painDatabaseFactory?: PainDatabaseFactory; hostKind?: GovernanceHostKind; events?: HostEventEmitter } = {}) {
  return async (event: HostEvent): Promise<HostEventResult> => {
    // PRI-750: shared-path tool event with the host's natural turn/tool ids
    // (Codex turn_id → runId, tool_use_id → toolCallId) so receipt events
    // carry a turn-level anchor in the same events_*.jsonl format as the
    // OpenClaw path. Emitted BEFORE the trajectory-db availability gate so
    // the receipt chain stays observable even when the trajectory store is
    // unavailable. Emission failure must not block the tool result — it
    // degrades to an observable warning (rc-9). Optional port: absent means
    // no-op (the OpenClaw plugin path emits its own tool events).
    let emissionWarning: string | undefined;
    try {
      const earlyOutcome = normalizeOutcome(event);
      options.events?.recordToolCall(event.context.sessionId, {
        toolName: event.context.toolName ?? '',
        ...(earlyOutcome.error ? { error: earlyOutcome.error } : {}),
        ...(earlyOutcome.exitCode !== null && earlyOutcome.exitCode !== 0 ? { exitCode: earlyOutcome.exitCode } : {}),
        ...(event.context.turnId !== undefined ? { runId: event.context.turnId } : {}),
        ...(event.context.toolCallId !== undefined ? { toolCallId: event.context.toolCallId } : {}),
      });
    } catch (err) {
      emissionWarning = `receipt_event_write_failed:${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`;
    }

    const dbPath = path.join(event.context.workspaceDir, '.state', 'trajectory.db');
    if (!fs.existsSync(dbPath)) {
      return { decision: 'observe', source: event.source, warnings: [...(emissionWarning ? [emissionWarning] : []), 'trajectory_db_not_found'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'initialize the selected PD workspace before retrying the hook' } };
    }

    let db: Database.Database | undefined;
    try {
      db = options.painDatabaseFactory ? options.painDatabaseFactory(dbPath) : new Database(dbPath);
      db.pragma('busy_timeout = 5000');
      ensureToolCallsToolUseIdColumn(db);
      if (!hasCanonicalSchema(db)) {
        db.close();
        db = undefined;
        return { decision: 'observe', source: event.source, warnings: [...(emissionWarning ? [emissionWarning] : []), 'trajectory_schema_invalid'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'run the supported PD workspace migration' } };
      }
    } catch (error) {
      try { db?.close(); } catch { /* best-effort cleanup of an unusable handle */ }
      return { decision: 'observe', source: event.source, warnings: [...(emissionWarning ? [emissionWarning] : []), `trajectory_database_unavailable:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'inspect or repair the selected PD trajectory database' } };
    }

    const warnings: string[] = [];
    let enrichment: ProductionPainEnrichment | null;
    try {
      enrichment = parseEnrichment(await options.painEnrichmentProvider?.(event));
    } catch (error) {
      warnings.push(`pain_enrichment_failed:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
      enrichment = null;
    }
    if (!enrichment) {
      try { db.close(); } catch { /* no business write occurred */ }
      return { decision: 'observe', source: event.source, warnings: [...(emissionWarning ? [emissionWarning] : []), ...(warnings.length > 0 ? warnings : ['pain_enrichment_invalid'])], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'inspect host pain enrichment input' } };
    }

    const outcome = normalizeOutcome(event);
    const sanitizedParams = sanitizeToolParams(outcome.params, event.context.workspaceDir);
    const toolName = event.context.toolName ?? '';
    const sourceObservation = buildToolFailureObservation({ toolName, error: outcome.error, exitCode: outcome.exitCode ?? undefined });
    const nonZeroExit = outcome.exitCode !== null && outcome.exitCode !== 0;
    const sourceKind = resolveSourceKind({
      observedAt: new Date().toISOString(), workspaceId: event.context.workspaceDir,
      sessionId: event.context.sessionId, toolName, failureSource: sourceObservation.failureSource,
      toolNotFound: sourceObservation.toolNotFound, nonZeroExit,
    });
    const relativePath = enrichment.relativePath ?? String(field(outcome.params, 'file_path') ?? field(outcome.params, 'path') ?? 'unknown').slice(0, 500);
    const isRisky = enrichment.isRisky ?? (path.isAbsolute(relativePath) && !path.resolve(relativePath).startsWith(`${path.resolve(event.context.workspaceDir)}${path.sep}`));
    const painScore = enrichment.painScore ?? Math.min(100, (outcome.failure ? 70 : 0) + (isRisky ? 20 : 0));
    const errorHash = enrichment.errorHash ?? createHash('sha256').update(outcome.error ?? String(outcome.exitCode)).digest('hex');
    const cooldownKey = `${path.resolve(event.context.workspaceDir)}:${event.context.sessionId}:${sourceObservation.failureSource}:${errorHash}`;
    const last = cooldowns.get(cooldownKey);
    const cooldownActive = last !== undefined && Date.now() - last < PAIN_COOLDOWN_WINDOW_MS;
    const triage = evaluateTriage({ sourceKind, score: painScore, consecutiveErrors: enrichment.consecutiveErrors, isRisky });
    const trigger = evaluateTriggerController({ triageResult: triage, isOwnerManual: false, isCooldownActive: cooldownActive, isValid: true, score: painScore, sessionId: event.context.sessionId });
    const admitted = outcome.outcome === 'failure' && WRITE_TOOLS.has(toolName) && trigger.shouldCreateDiagnosticTask;
    const { eventId, painId } = ids({
      workspaceDir: event.context.workspaceDir,
      sessionId: event.context.sessionId,
      ...(event.context.turnId !== undefined ? { turnId: event.context.turnId } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      source: event.source,
      ...(enrichment.eventId ? { canonicalEventId: enrichment.eventId } : {}),
      outcome,
      sanitizedParams,
    });
    const createdAt = new Date().toISOString();
    const paramsJson = stable(sanitizedParams);
    const resultPreview = preview({ eventId, result: sanitizeValue(outcome.result, 0, event.context.workspaceDir) });
    let duplicate = false;
    let duplicateAdmitted = false;

    try {
      db.transaction(() => {
        // CR-01: the host tool-call id is the stable join key for the
        // consent-gated transcript upgrade (recordVerifiedToolOutcomes);
        // content-shape probing stays the fallback for hosts without ids.
        if (event.context.toolCallId !== undefined
          && db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_use_id = ?').get(event.context.sessionId, event.context.toolCallId) !== undefined) {
          duplicate = true;
          duplicateAdmitted = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) !== undefined;
          return;
        }
        if (db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ? AND outcome = ? AND exit_code IS ? AND error_message IS ? AND result_preview IS ?').get(event.context.sessionId, toolName, paramsJson, outcome.outcome, outcome.exitCode, outcome.error ?? null, resultPreview)) {
          duplicate = true;
          duplicateAdmitted = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) !== undefined;
          return;
        }
        db.prepare(`INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`).run(event.context.sessionId, createdAt, createdAt);
        db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at, tool_use_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(event.context.sessionId, toolName, outcome.outcome, outcome.durationMs ?? null, outcome.exitCode, outcome.error ? outcome.error.split(/[\s:]/, 1)[0] : null, outcome.error ?? null, null, null, paramsJson, resultPreview, createdAt, event.context.toolCallId ?? null);
        if (admitted) {
          // Raw observation only (Pain Diagnosis Persistence SPEC §8): the
          // pain row must record WHAT happened, not WHY. Attribution
          // (People/Design/Assumption/Tooling) belongs to the Diagnostician.
          // confidence stays null — no attribution confidence exists at
          // detection time. origin remains 'system_infer' because origin is a
          // declared enum (event-types.ts: who reported the pain), not an
          // attribution claim.
          const reason = `tool=${toolName}; error=${outcome.error ?? `exit=${outcome.exitCode}`}; path=${relativePath}`;
          db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.context.sessionId, sourceObservation.failureSource ?? 'tool_failure', painScore, reason, painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild', 'system_infer', null, enrichment.evidence?.map((entry) => `${entry.sourceRef}: ${entry.note}`).join('\n') ?? null, painId, null, options.hostKind ?? null, createdAt);
        }
      })();
      if (admitted && !duplicate) {
        const admittedAt = Date.now();
        // Bound the module-level cooldown map in long-lived host processes
        // (OpenClaw): keys carry sessionId + errorHash, so unbounded retention
        // grows monotonically. Evict entries outside the cooldown window —
        // they can never be consulted again.
        for (const [staleKey, staleAt] of cooldowns) {
          if (admittedAt - staleAt >= PAIN_COOLDOWN_WINDOW_MS) cooldowns.delete(staleKey);
        }
        cooldowns.set(cooldownKey, admittedAt);
      }
    } catch (error) {
      return { decision: 'observe', source: event.source, warnings: [...(emissionWarning ? [emissionWarning] : []), `trajectory_write_failed:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`], metadata: { outcome: outcome.outcome, admitted: false, duplicate: false, nextAction: 'inspect the workspace trajectory database and retry' } };
    } finally {
      try { db.close(); } catch { /* write result already determined; cleanup is best-effort */ }
    }

    const effectiveAdmitted = admitted || duplicateAdmitted;
    return {
      decision: 'observe',
      source: event.source,
      ...(emissionWarning ? { warnings: [emissionWarning] } : {}),
      metadata: {
        eventId, painId: effectiveAdmitted ? painId : null, outcome: outcome.outcome, ...(outcome.unknownReason !== undefined ? { outcomeReason: outcome.unknownReason } : {}), exitCode: outcome.exitCode, admitted: effectiveAdmitted, duplicate,
        sourceKind, failureSource: sourceObservation.failureSource ?? null, triggerOutcome: trigger.outcome,
        triggerReason: trigger.reason, painScore, isRisky, relativePath, agentId: enrichment.agentId ?? null,
        evidence: enrichment.evidence ?? [],
      } };
  };
}

export function resetProductionPainCooldownForTest(): void {
  cooldowns.clear();
}

export function productionPainCooldownEntryCountForTest(): number {
  return cooldowns.size;
}
export { hasCanonicalSchema as hasProductionPainSchema };
