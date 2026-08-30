import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildToolFailureObservation,
  evaluateTriage,
  evaluateTriggerController,
  resolveSourceKind,
  sanitizeToolParams,
  sanitizeValue,
} from '@principles/core/runtime-v2';
import type { HostEvent, HostEventResult } from '@principles/core/host';

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

interface NormalizedOutcome {
  failure: boolean;
  exitCode: number;
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

function normalizeOutcome(event: Pick<HostEvent, 'context'> | ProductionToolEventFields): NormalizedOutcome {
  const context = 'context' in event ? event.context : event;
  const envelope = context.toolOutput;
  const result = field(envelope, 'result') ?? envelope;
  const errorValue = field(envelope, 'error');
  const resultExit = field(result, 'exitCode');
  const detailsExit = field(field(result, 'details'), 'exitCode');
  const exitCode = typeof resultExit === 'number' ? resultExit : typeof detailsExit === 'number' ? detailsExit : 0;
  const error = errorValue === undefined || errorValue === null || errorValue === '' ? undefined : String(errorValue);
  const durationValue = field(envelope, 'durationMs');
  return {
    failure: error !== undefined || exitCode !== 0,
    exitCode,
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
 * ids. Turn-scoped where the host supplies a stable turn id, so one real Owner
 * correction delivered live and via transcript resolves to one canonical pain.
 */
export function deriveProductionCorrectionPainIdentity(fields: {
  workspaceDir: string;
  sessionId: string;
  turnId?: string;
  text: string;
}): { eventId: string; painId: string } {
  const canonical = stable({
    workspaceDir: path.resolve(fields.workspaceDir),
    sessionId: fields.sessionId,
    turnId: fields.turnId ?? null,
    source: 'user_correction',
    text: fields.text,
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { eventId: `host_${digest}`, painId: `pain_host_${digest}` };
}


const REQUIRED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  sessions: { session_id: 'TEXT', started_at: 'TEXT', updated_at: 'TEXT' },
  tool_calls: { session_id: 'TEXT', tool_name: 'TEXT', outcome: 'TEXT', duration_ms: 'INTEGER', exit_code: 'INTEGER', error_type: 'TEXT', error_message: 'TEXT', gfi_before: 'REAL', gfi_after: 'REAL', params_json: 'TEXT', result_preview: 'TEXT', created_at: 'TEXT' },
  pain_events: { session_id: 'TEXT', source: 'TEXT', score: 'REAL', reason: 'TEXT', severity: 'TEXT', origin: 'TEXT', confidence: 'REAL', text: 'TEXT', canonical_pain_id: 'TEXT', runtime_task_id: 'TEXT', created_at: 'TEXT' },
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
  db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ? AND outcome = ? AND exit_code IS ? AND error_message IS ? AND result_preview IS ?');
  db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?');
  db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at');
  db.prepare('INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.prepare('INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  return true;
}

export function createProductionPainEvidenceHandler(options: { painEnrichmentProvider?: PainEnrichmentProvider; painDatabaseFactory?: PainDatabaseFactory } = {}) {
  return async (event: HostEvent): Promise<HostEventResult> => {
    const dbPath = path.join(event.context.workspaceDir, '.state', 'trajectory.db');
    if (!fs.existsSync(dbPath)) {
      return { decision: 'observe', source: event.source, warnings: ['trajectory_db_not_found'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'initialize the selected PD workspace before retrying the hook' } };
    }

    let db: Database.Database | undefined;
    try {
      db = options.painDatabaseFactory ? options.painDatabaseFactory(dbPath) : new Database(dbPath);
      db.pragma('busy_timeout = 5000');
      if (!hasCanonicalSchema(db)) {
        db.close();
        db = undefined;
        return { decision: 'observe', source: event.source, warnings: ['trajectory_schema_invalid'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'run the supported PD workspace migration' } };
      }
    } catch (error) {
      try { db?.close(); } catch { /* best-effort cleanup of an unusable handle */ }
      return { decision: 'observe', source: event.source, warnings: [`trajectory_database_unavailable:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'inspect or repair the selected PD trajectory database' } };
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
      return { decision: 'observe', source: event.source, warnings: warnings.length > 0 ? warnings : ['pain_enrichment_invalid'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'inspect host pain enrichment input' } };
    }

    const outcome = normalizeOutcome(event);
    const sanitizedParams = sanitizeToolParams(outcome.params, event.context.workspaceDir);
    const toolName = event.context.toolName ?? '';
    const sourceObservation = buildToolFailureObservation({ toolName, error: outcome.error, exitCode: outcome.exitCode });
    const sourceKind = resolveSourceKind({
      observedAt: new Date().toISOString(), workspaceId: event.context.workspaceDir,
      sessionId: event.context.sessionId, toolName, failureSource: sourceObservation.failureSource,
      toolNotFound: sourceObservation.toolNotFound, nonZeroExit: outcome.exitCode !== 0,
    });
    const relativePath = enrichment.relativePath ?? String(field(outcome.params, 'file_path') ?? field(outcome.params, 'path') ?? 'unknown').slice(0, 500);
    const isRisky = enrichment.isRisky ?? (path.isAbsolute(relativePath) && !path.resolve(relativePath).startsWith(`${path.resolve(event.context.workspaceDir)}${path.sep}`));
    const painScore = enrichment.painScore ?? Math.min(100, (outcome.exitCode !== 0 ? 70 : 0) + (isRisky ? 20 : 0));
    const errorHash = enrichment.errorHash ?? createHash('sha256').update(outcome.error ?? String(outcome.exitCode)).digest('hex');
    const cooldownKey = `${path.resolve(event.context.workspaceDir)}:${event.context.sessionId}:${sourceObservation.failureSource}:${errorHash}`;
    const last = cooldowns.get(cooldownKey);
    const cooldownActive = last !== undefined && Date.now() - last < PAIN_COOLDOWN_WINDOW_MS;
    const triage = evaluateTriage({ sourceKind, score: painScore, consecutiveErrors: enrichment.consecutiveErrors, isRisky });
    const trigger = evaluateTriggerController({ triageResult: triage, isOwnerManual: false, isCooldownActive: cooldownActive, isValid: true, score: painScore, sessionId: event.context.sessionId });
    const admitted = outcome.failure && WRITE_TOOLS.has(toolName) && trigger.shouldCreateDiagnosticTask;
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
        if (db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ? AND outcome = ? AND exit_code IS ? AND error_message IS ? AND result_preview IS ?').get(event.context.sessionId, toolName, paramsJson, outcome.failure ? 'failure' : 'success', outcome.exitCode, outcome.error ?? null, resultPreview)) {
          duplicate = true;
          duplicateAdmitted = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) !== undefined;
          return;
        }
        db.prepare(`INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`).run(event.context.sessionId, createdAt, createdAt);
        db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(event.context.sessionId, toolName, outcome.failure ? 'failure' : 'success', outcome.durationMs ?? null, outcome.exitCode, outcome.error ? outcome.error.split(/[\s:]/, 1)[0] : null, outcome.error ?? null, null, null, paramsJson, resultPreview, createdAt);
        if (admitted) {
          // Raw observation only (Pain Diagnosis Persistence SPEC §8): the
          // pain row must record WHAT happened, not WHY. Attribution
          // (People/Design/Assumption/Tooling) belongs to the Diagnostician.
          // confidence stays null — no attribution confidence exists at
          // detection time. origin remains 'system_infer' because origin is a
          // declared enum (event-types.ts: who reported the pain), not an
          // attribution claim.
          const reason = `tool=${toolName}; error=${outcome.error ?? `exit=${outcome.exitCode}`}; path=${relativePath}`;
          db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.context.sessionId, sourceObservation.failureSource ?? 'tool_failure', painScore, reason, painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild', 'system_infer', null, enrichment.evidence?.map((entry) => `${entry.sourceRef}: ${entry.note}`).join('\n') ?? null, painId, null, createdAt);
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
      return { decision: 'observe', source: event.source, warnings: [`trajectory_write_failed:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`], metadata: { outcome: outcome.failure ? 'failure' : 'success', admitted: false, duplicate: false, nextAction: 'inspect the workspace trajectory database and retry' } };
    } finally {
      try { db.close(); } catch { /* write result already determined; cleanup is best-effort */ }
    }

    const effectiveAdmitted = admitted || duplicateAdmitted;
    return { decision: 'observe', source: event.source, metadata: {
      eventId, painId: effectiveAdmitted ? painId : null, outcome: outcome.failure ? 'failure' : 'success', admitted: effectiveAdmitted, duplicate,
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
