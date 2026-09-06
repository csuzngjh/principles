/**
 * Governance Observation Store — Codex Governance Closure Slice A (PRI-622).
 *
 * Host-neutral storage seam for bounded Governance Observations, per Codex
 * Governance Closure SPEC rev 2 §6/§7/§10/§11 and the Slice A Implementation
 * SPEC (2026-08-29). The Codex adapter decodes host transcripts and calls
 * {@link ingestGovernanceObservations}; this module owns everything below the
 * seam: sanitization at the persistence boundary, logical/physical identity
 * upsert and convergence, the transcript checkpoint, bounded retention
 * (latest ≤32 visible turns per rollout AND ≤7 days, whichever expires
 * sooner), compaction/rollback tombstones, and the promotion substrate
 * (≤12 preceding turns + trigger + next completed assistant turn with a
 * durable pending tail) that Slice B will drive after pain admission.
 *
 * Slice A creates NO pain identity: promotion accepts a caller-provided
 * pain reference only (SPEC §18).
 *
 * Storage authority: the existing Workspace trajectory store
 * `{workspace}/.state/trajectory.db`. The baseline schema is owned by
 * openclaw-plugin's `applyTrajectorySchema` (mirrored in core's
 * `ensureTrajectorySchema` for the pain tables). The `governance_*` tables
 * below are written and read ONLY by this module, so their DDL lives here —
 * idempotent, versioned by `governance_observation_schema_version`, and
 * additive to any existing trajectory.db (unknown tables are untouched by
 * the other owners). No raw transcript bytes, no second pain authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { sanitizeString, sanitizeValue } from '@principles/core/runtime-v2';

// ─── Retention policy constants (Owner-approved, SPEC rev 2 §11) ────────────
export const GOVERNANCE_RETENTION_MAX_TURNS = 32;
export const GOVERNANCE_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const GOVERNANCE_PROMOTION_PRECEDING_TURNS = 12;
export const GOVERNANCE_PENDING_TAIL_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const GOVERNANCE_OBSERVATION_SCHEMA_VERSION = 3;
const MAX_TEXT_BOUND = 200; // matches MAX_EVIDENCE_VALUE_CHARS; guards stored identity fields
const MAX_JSON_COLUMN = 8_000;

export type GovernanceObservationKind = 'user_turn' | 'assistant_turn' | 'tool_call';
export type GovernanceObservationSource = 'live_hook' | 'transcript';
export type GovernanceObservationCompleteness = 'complete' | 'partial';
/** `quarantined` (Slice D §15): audited, permanently-invalid row; bodies dropped, metadata kept. */
export type GovernanceRetentionClass = 'operational' | 'promoted' | 'expired' | 'rolled_back' | 'quarantined';

export interface GovernanceObservationInput {
  readonly hostKind: 'codex';
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly parentRolloutIdentity?: string;
  readonly agentIdentity?: string;
  readonly agentDepth?: number;

  readonly hostTurnId: string;
  readonly kind: GovernanceObservationKind;

  /** Semantic convergence identity (SPEC §6). Built by the host adapter. */
  readonly logicalObservationKey: string;
  /** Physical replay identity: `host|rollout|ordinal` (SPEC §6). */
  readonly transcriptRecordKey?: string;
  /**
   * Byte offset of the source record start — the durable transcript SOURCE
   * ORDER (records are append-only, so byte position is strictly increasing
   * within one rollout). All before/after/last-N/next-assistant logic orders
   * by this value, never by the SQLite insertion id: a live hook row is
   * inserted BEFORE the older history that a later catch-up ingests, so
   * insertion order is not transcript order (PR #1455 review P1).
   */
  readonly recordByteStart?: number;
  /** Per-rollout physical record ordinal (G1 §4) — tiebreaker/telemetry alongside the byte order. */
  readonly recordOrdinal?: number;

  readonly assistantItemId?: string;
  /** assistant phase: 'commentary' | 'final_answer' (assistant_turn only). */
  readonly phase?: string;
  readonly toolUseId?: string;
  /** Transcript model-level call id (call_*) — different id space than toolUseId. */
  readonly transcriptToolCallId?: string;

  readonly visibleText?: string;
  readonly toolFacts?: unknown;

  readonly source: GovernanceObservationSource;
  readonly completeness: GovernanceObservationCompleteness;
  readonly observedAt: string;
}

export interface GovernanceCheckpointInput {
  readonly hostKind: 'codex';
  readonly rolloutIdentity: string;
  readonly byteOffset: number;
  readonly lastOrdinal: number;
  readonly cliVersion?: string;
  readonly rootSessionId: string;
  readonly incompleteTail: boolean;
}

export interface GovernanceIngestDegradation {
  readonly reason: string;
  readonly ordinal?: number;
  readonly nextAction?: string;
}

export interface IngestGovernanceObservationsResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly inserted: number;
  readonly enriched: number;
  readonly duplicates: number;
  readonly checkpointCommitted: boolean;
  readonly warnings: readonly string[];
}

export interface GovernanceCheckpointRecord {
  readonly hostKind: string;
  readonly rolloutIdentity: string;
  readonly byteOffset: number;
  readonly lastOrdinal: number;
  readonly cliVersion: string | null;
  readonly rootSessionId: string;
  readonly incompleteTail: boolean;
  readonly lastDegradationReason: string | null;
  readonly lastDegradationOrdinal: number | null;
  readonly updatedAt: string;
}

export interface GovernanceObservationRecord {
  readonly id: number;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly kind: GovernanceObservationKind;
  readonly logicalKey: string;
  readonly transcriptRecordKey: string | null;
  readonly sourceOrder: number | null;
  readonly sourceOrdinal: number | null;
  readonly assistantItemId: string | null;
  readonly phase: string | null;
  readonly toolUseId: string | null;
  readonly transcriptToolCallId: string | null;
  readonly visibleText: string | null;
  readonly sanitizedToolFactsJson: string | null;
  readonly source: GovernanceObservationSource;
  readonly completeness: GovernanceObservationCompleteness;
  readonly retentionClass: GovernanceRetentionClass;
  readonly observedAt: string;
  readonly promotionRef: string | null;
}

export interface PromoteGovernanceEvidenceInput {
  readonly workspaceDir: string;
  readonly hostKind: 'codex';
  readonly rolloutIdentity: string;
  readonly triggerLogicalKey: string;
  /** Caller-provided pain reference. Slice A never mints a pain identity (SPEC §18). */
  readonly painRef: string;
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type PromoteGovernanceEvidenceResult =
  | { ok: true; promoted: number; tailState: 'completed' | 'pending'; warnings: readonly string[] }
  | { ok: false; reason: string; nextAction: string };

export type ObservationDatabaseFactory = (databasePath: string) => Database.Database;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function boundedString(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null;
    if (text.length <= MAX_JSON_COLUMN) return text;
    // Truncating a serialized JSON document mid-value yields INVALID JSON.
    // Keep the column bound while staying parseable: store an ESCAPED
    // fragment inside a small wrapper object, shrinking until the wrapper
    // itself fits (escaping can expand the fragment, so verify each round).
    let keep = text.length;
    while (keep > 0) {
      keep = Math.max(0, keep - Math.max(200, Math.floor(keep / 4)));
      const wrapped = JSON.stringify({ truncated: true, preview: text.slice(0, keep) });
      if (wrapped.length <= MAX_JSON_COLUMN) return wrapped;
    }
    return '{"truncated":true,"preview":""}';
  } catch {
    return null;
  }
}

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS governance_observation_schema_version (version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS governance_rollouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_kind TEXT NOT NULL,
    rollout_identity TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    parent_rollout_id TEXT,
    agent_identity TEXT,
    agent_depth INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(host_kind, rollout_identity)
  )`,
  `CREATE TABLE IF NOT EXISTS governance_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollout_row_id INTEGER NOT NULL,
    host_kind TEXT NOT NULL,
    rollout_identity TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    host_turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    logical_key TEXT NOT NULL,
    transcript_record_key TEXT,
    source_order INTEGER,
    source_ordinal INTEGER,
    assistant_item_id TEXT,
    phase TEXT,
    tool_use_id TEXT,
    transcript_tool_call_id TEXT,
    visible_text TEXT,
    sanitized_tool_facts_json TEXT,
    source TEXT NOT NULL,
    completeness TEXT NOT NULL,
    retention_class TEXT NOT NULL DEFAULT 'operational',
    observed_at TEXT NOT NULL,
    promoted_at TEXT,
    promotion_ref TEXT,
    expired_at TEXT,
    UNIQUE(logical_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_governance_observations_source_order
     ON governance_observations(rollout_row_id, source_order)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_observations_physical
     ON governance_observations(transcript_record_key) WHERE transcript_record_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_governance_observations_rollout_turn
     ON governance_observations(rollout_row_id, host_turn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_governance_observations_retention
     ON governance_observations(retention_class, observed_at)`,
  `CREATE TABLE IF NOT EXISTS governance_transcript_checkpoints (
    host_kind TEXT NOT NULL,
    rollout_identity TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    last_ordinal INTEGER NOT NULL,
    cli_version TEXT,
    root_session_id TEXT NOT NULL,
    incomplete_tail INTEGER NOT NULL DEFAULT 0,
    last_degradation_reason TEXT,
    last_degradation_ordinal INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (host_kind, rollout_identity)
  )`,
  `CREATE TABLE IF NOT EXISTS governance_pending_promotion_tails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollout_row_id INTEGER NOT NULL,
    host_kind TEXT NOT NULL,
    rollout_identity TEXT NOT NULL,
    trigger_logical_key TEXT NOT NULL,
    pain_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    stale_at TEXT,
    UNIQUE(rollout_row_id, trigger_logical_key, pain_ref)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_governance_pending_tails_state
     ON governance_pending_promotion_tails(state, created_at)`,
];

/** Column additions after v1 (dev databases created before the source-order fix). */
const V2_ADDED_COLUMNS = [
  { table: 'governance_observations', name: 'source_order', type: 'INTEGER' },
  { table: 'governance_observations', name: 'source_ordinal', type: 'INTEGER' },
];

/** Column additions in v3 (Slice D §15 quarantine: audited recovery metadata). */
const V3_ADDED_COLUMNS = [
  { table: 'governance_observations', name: 'quarantined_at', type: 'TEXT' },
  { table: 'governance_observations', name: 'quarantine_reason', type: 'TEXT' },
  { table: 'governance_observations', name: 'quarantine_digest', type: 'TEXT' },
  { table: 'governance_observations', name: 'quarantine_operator', type: 'TEXT' },
  { table: 'governance_observations', name: 'quarantine_gap', type: 'TEXT' },
];

function ensureGovernanceObservationSchema(db: Database.Database): void {
  db.transaction(() => {
    for (const statement of CREATE_STATEMENTS) db.exec(statement);
    for (const column of [...V2_ADDED_COLUMNS, ...V3_ADDED_COLUMNS]) {
      try {
        db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.type}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('duplicate column name')) throw error;
      }
    }
    const row = db.prepare('SELECT version FROM governance_observation_schema_version LIMIT 1').get();
    const current = isRecord(row) ? own(row, 'version') : undefined;
    if (typeof current !== 'number') {
      db.prepare('INSERT INTO governance_observation_schema_version (version) VALUES (?)').run(GOVERNANCE_OBSERVATION_SCHEMA_VERSION);
    } else if (current < GOVERNANCE_OBSERVATION_SCHEMA_VERSION) {
      db.prepare('UPDATE governance_observation_schema_version SET version = ?').run(GOVERNANCE_OBSERVATION_SCHEMA_VERSION);
    }
  })();
}

/**
 * Shared with the sibling governance-signal-admission module (Slice B): both
 * modules own separate governance_* tables in the same trajectory.db, and the
 * admission/reconciliation paths read observation-owned tables (promotion
 * tails). One open must make the whole governance schema ready.
 */
export function ensureGovernanceSchema(db: Database.Database): void {
  ensureGovernanceObservationSchema(db);
}

interface OpenStoreResult {
  db: Database.Database;
  close(): void;
}

type Degradation = { ok: false; reason: string; nextAction: string };

function openStore(workspaceDir: string, factory?: ObservationDatabaseFactory): OpenStoreResult | Degradation {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: 'trajectory_db_not_found', nextAction: 'initialize the selected PD workspace (pd runtime init) before enabling conversation ingestion' };
  }
  try {
    const db = factory ? factory(dbPath) : new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    ensureGovernanceObservationSchema(db);
    return { db, close: () => { try { db.close(); } catch { /* write result already determined */ } } };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `trajectory_database_unavailable:${detail}`, nextAction: 'inspect or repair the selected PD trajectory database' };
  }
}

function rowField(row: unknown, key: string): unknown {
  return isRecord(row) ? own(row, key) : undefined;
}

function upsertRollout(db: Database.Database, input: GovernanceRolloutDescriptor, now: string): number {
  const existing = db.prepare('SELECT id FROM governance_rollouts WHERE host_kind = ? AND rollout_identity = ?').get(input.hostKind, input.rolloutIdentity);
  const existingId = rowField(existing, 'id');
  if (typeof existingId === 'number') {
    db.prepare('UPDATE governance_rollouts SET root_session_id = ?, parent_rollout_id = COALESCE(?, parent_rollout_id), agent_identity = COALESCE(?, agent_identity), agent_depth = COALESCE(?, agent_depth), updated_at = ? WHERE id = ?')
      .run(input.rootSessionId, input.parentRolloutIdentity ?? null, input.agentIdentity ?? null, input.agentDepth ?? null, now, existingId);
    return existingId;
  }
  const result = db.prepare('INSERT INTO governance_rollouts (host_kind, rollout_identity, root_session_id, parent_rollout_id, agent_identity, agent_depth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(input.hostKind, input.rolloutIdentity, input.rootSessionId, input.parentRolloutIdentity ?? null, boundedString(input.agentIdentity, MAX_TEXT_BOUND), input.agentDepth ?? null, now, now);
  return Number(result.lastInsertRowid);
}

interface ObservationOutcome { disposition: 'inserted' | 'enriched' | 'duplicate' | 'conflict'; stopByteStart?: number }

interface ApplyObservationArgs {
  db: Database.Database;
  rolloutRowId: number;
  input: GovernanceObservationInput;
  workspaceDir: string;
}

function applyObservation({ db, rolloutRowId, input, workspaceDir }: ApplyObservationArgs): ObservationOutcome {
  const existing = db.prepare('SELECT * FROM governance_observations WHERE logical_key = ?').get(input.logicalObservationKey);
  if (!isRecord(existing)) {
    // Physical replay guard: the same transcript record decoded twice (crash
    // before checkpoint, or a re-invoked hook) must not contribute twice.
    if (input.transcriptRecordKey !== undefined) {
      const physical = db.prepare('SELECT id FROM governance_observations WHERE transcript_record_key = ?').get(input.transcriptRecordKey);
      if (isRecord(physical)) return { disposition: 'duplicate' };
    }
    const sanitizedText = input.visibleText !== undefined ? sanitizeString(input.visibleText, workspaceDir) : null;
    const facts = input.toolFacts !== undefined ? safeJson({ facts: sanitizeValue(input.toolFacts, 0, workspaceDir) }) : null;
    db.prepare(`INSERT INTO governance_observations
      (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, transcript_record_key, source_order, source_ordinal, assistant_item_id, phase, tool_use_id, transcript_tool_call_id, visible_text, sanitized_tool_facts_json, source, completeness, retention_class, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'operational', ?)`)
      .run(rolloutRowId, input.hostKind, input.rolloutIdentity, input.rootSessionId, input.hostTurnId, input.kind, input.logicalObservationKey,
        input.transcriptRecordKey ?? null, input.recordByteStart ?? null, input.recordOrdinal ?? null,
        boundedString(input.assistantItemId, MAX_TEXT_BOUND), boundedString(input.phase, MAX_TEXT_BOUND) ?? null,
        boundedString(input.toolUseId, MAX_TEXT_BOUND), boundedString(input.transcriptToolCallId, MAX_TEXT_BOUND),
        sanitizedText, facts, input.source, input.completeness, input.observedAt);
    return { disposition: 'inserted' };
  }

  const existingId = rowField(existing, 'id');
  const existingText = rowField(existing, 'visible_text');
  // Source precedence (SPEC §10): user rows created live are enriched by the
  // transcript with identity/ordering; tool rows created live are enriched or
  // no-op'd by tool_use_id; assistant content comes only from the transcript.
  // A user content mismatch for one logical key is a lineage conflict: keep
  // the first committed content, mark partial, and stop checkpoint advance at
  // the conflicting record — never overwrite silently.
  if (input.kind === 'user_turn'
    && input.source === 'transcript'
    && input.visibleText !== undefined
    && typeof existingText === 'string'
    && sanitizeString(input.visibleText, workspaceDir) !== existingText) {
    db.prepare("UPDATE governance_observations SET completeness = 'partial' WHERE id = ?").run(existingId);
    return { disposition: 'conflict', stopByteStart: input.recordByteStart };
  }

  const updates: string[] = [];
  const values: unknown[] = [];
  const fill = (column: string, value: unknown) => {
    const current = rowField(existing, column);
    if ((current === null || current === undefined) && value !== null && value !== undefined) {
      updates.push(`${column} = ?`);
      values.push(value);
    }
  };
  fill('transcript_record_key', input.transcriptRecordKey ?? null);
  // Transcript replay enriches the live row with its real transcript position
  // (PR #1455 review P1): all ordering logic reads source_order, so a live row
  // must gain it the moment the transcript catch-up converges the same event.
  fill('source_order', input.recordByteStart);
  fill('source_ordinal', input.recordOrdinal);
  fill('assistant_item_id', boundedString(input.assistantItemId, MAX_TEXT_BOUND));
  fill('phase', boundedString(input.phase, MAX_TEXT_BOUND));
  fill('tool_use_id', boundedString(input.toolUseId, MAX_TEXT_BOUND));
  fill('transcript_tool_call_id', boundedString(input.transcriptToolCallId, MAX_TEXT_BOUND));
  fill('visible_text', input.visibleText !== undefined ? sanitizeString(input.visibleText, workspaceDir) : null);
  fill('sanitized_tool_facts_json', input.toolFacts !== undefined ? safeJson({ facts: sanitizeValue(input.toolFacts, 0, workspaceDir) }) : null);
  const existingCompleteness = rowField(existing, 'completeness');
  if (existingCompleteness === 'partial' && input.completeness === 'complete') {
    updates.push('completeness = ?');
    values.push('complete');
  }
  if (updates.length === 0) return { disposition: 'duplicate' };
  updates.push('source = ?');
  values.push(input.source);
  values.push(existingId);
  db.prepare(`UPDATE governance_observations SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return { disposition: 'enriched' };
}

function expireRows(db: Database.Database, ids: readonly number[], expiry: { now: string; klass: 'expired' | 'rolled_back' }): void {
  const { now, klass } = expiry;
  if (ids.length === 0) return;
  const chunks: number[][] = [];
  for (let index = 0; index < ids.length; index += 200) chunks.push(ids.slice(index, index + 200));
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    db.prepare(`UPDATE governance_observations SET visible_text = NULL, sanitized_tool_facts_json = NULL, retention_class = ?, expired_at = ? WHERE id IN (${placeholders}) AND retention_class = 'operational'`)
      .run(klass, now, ...chunk);
  }
}

/**
 * Canonical turn order for one rollout, oldest → newest:
 *   1. turns with transcript source order, ascending by MIN(source_order)
 *      (byte offsets are append-only within a rollout — G1 §4/§6);
 *   2. then live-only turns (no transcript evidence yet — the hook observed
 *      them but the Stop replay has not converged them), in observation
 *      arrival order. Insertion id is used ONLY as the tiebreak among rows
 *      that have no transcript order; it is never a transcript order.
 *
 * Every before/after/last-N/next-assistant decision MUST go through this
 * ordering: a live hook row is INSERTED before the older history a later
 * catch-up ingests, so insertion id alone misorders the rollout.
 */
interface TurnOrderRow { hostTurnId: string; turnOrder: number | null }

function listTurnsInSourceOrder(db: Database.Database, rolloutRowId: number): TurnOrderRow[] {
  const rows = db.prepare(`SELECT host_turn_id, MIN(source_order) AS turn_order, MIN(id) AS arrival
    FROM governance_observations
    WHERE rollout_row_id = ? AND retention_class = 'operational'
    GROUP BY host_turn_id
    ORDER BY (MIN(source_order) IS NULL) ASC, MIN(source_order) ASC, MIN(id) ASC`).all(rolloutRowId);
  return rows.map((row) => ({
    hostTurnId: String(rowField(row, 'host_turn_id')),
    turnOrder: typeof rowField(row, 'turn_order') === 'number' ? (rowField(row, 'turn_order') as number) : null,
  }));
}

function turnObservationIds(db: Database.Database, rolloutRowId: number, hostTurnId: string): number[] {
  const rows = db.prepare("SELECT id FROM governance_observations WHERE rollout_row_id = ? AND host_turn_id = ? AND retention_class = 'operational'")
    .all(rolloutRowId, hostTurnId);
  return rows.map((row) => Number(rowField(row, 'id'))).filter((id) => Number.isInteger(id));
}

function pruneRetention(db: Database.Database, rolloutRowId: number | null, now: Date): void {
  const nowIso = now.toISOString();
  // Age bound: global, bounded single statements over the retention index.
  db.prepare(`UPDATE governance_observations SET visible_text = NULL, sanitized_tool_facts_json = NULL, retention_class = 'expired', expired_at = ?
    WHERE retention_class = 'operational' AND observed_at < ?`)
    .run(nowIso, new Date(now.getTime() - GOVERNANCE_RETENTION_MAX_AGE_MS).toISOString());
  // Turn bound: per ingested rollout, keep the latest N conversational turns
  // in canonical source order (live-only turns count as newest).
  if (rolloutRowId === null) return;
  const turns = listTurnsInSourceOrder(db, rolloutRowId);
  if (turns.length <= GOVERNANCE_RETENTION_MAX_TURNS) return;
  const expiredIds: number[] = [];
  for (const turn of turns.slice(0, turns.length - GOVERNANCE_RETENTION_MAX_TURNS)) {
    expiredIds.push(...turnObservationIds(db, rolloutRowId, turn.hostTurnId));
  }
  expireRows(db, expiredIds, { now: nowIso, klass: 'expired' });
}

function completePendingTails(db: Database.Database, rolloutRowId: number, now: string): number {
  const pending = db.prepare("SELECT * FROM governance_pending_promotion_tails WHERE rollout_row_id = ? AND state = 'pending'").all(rolloutRowId);
  let completed = 0;
  for (const tail of pending) {
    const triggerKey = rowField(tail, 'trigger_logical_key');
    if (typeof triggerKey !== 'string') continue;
    const triggerRow = db.prepare('SELECT * FROM governance_observations WHERE logical_key = ?').get(triggerKey);
    if (!isRecord(triggerRow)) continue;
    const triggerOrder = rowField(triggerRow, 'source_order');
    if (typeof triggerOrder !== 'number') continue; // not yet positioned by the transcript replay
    // The next completed assistant turn: the earliest final-answer assistant
    // observation AFTER the trigger in transcript source order.
    const next = db.prepare(`SELECT id FROM governance_observations
      WHERE rollout_row_id = ? AND kind = 'assistant_turn' AND phase = 'final_answer' AND completeness = 'complete' AND source_order > ?
      ORDER BY source_order LIMIT 1`).get(rolloutRowId, triggerOrder);
    const nextId = rowField(next, 'id');
    if (typeof nextId !== 'number') continue;
    db.prepare("UPDATE governance_observations SET retention_class = 'promoted', promoted_at = ?, promotion_ref = COALESCE(promotion_ref, ?) WHERE id = ? AND retention_class != 'promoted'")
      .run(now, rowField(tail, 'pain_ref'), nextId);
    db.prepare("UPDATE governance_pending_promotion_tails SET state = 'completed', completed_at = ? WHERE id = ?").run(now, rowField(tail, 'id'));
    completed += 1;
  }
  return completed;
}

function expireStalePendingTails(db: Database.Database, now: Date): void {
  db.prepare("UPDATE governance_pending_promotion_tails SET state = 'stale', stale_at = ? WHERE state = 'pending' AND created_at < ?")
    .run(now.toISOString(), new Date(now.getTime() - GOVERNANCE_PENDING_TAIL_STALE_MS).toISOString());
}

export interface GovernanceRolloutDescriptor {
  readonly hostKind: 'codex';
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly parentRolloutIdentity?: string;
  readonly agentIdentity?: string;
  readonly agentDepth?: number;
}

export interface IngestGovernanceObservationsInput {
  readonly workspaceDir: string;
  /** Rollout lineage, established even when a delta contains no projected observations (markers/skips only). */
  readonly rollout?: GovernanceRolloutDescriptor;
  readonly observations: readonly GovernanceObservationInput[];
  readonly checkpoint?: GovernanceCheckpointInput;
  readonly degradations?: readonly GovernanceIngestDegradation[];
  readonly compactionTimestamp?: string;
  /** Sequential rollback markers (num_turns each) decoded from the transcript delta. */
  readonly rollbackTurns?: readonly number[];
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export function ingestGovernanceObservations(input: IngestGovernanceObservationsInput): IngestGovernanceObservationsResult {
  const opened = openStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return { ok: false, reason: opened.reason, nextAction: opened.nextAction, inserted: 0, enriched: 0, duplicates: 0, checkpointCommitted: false, warnings: [] };
  const { db, close } = opened;
  const now = (input.now ?? new Date()).toISOString();
  const warnings: string[] = [];

  try {
    let inserted = 0;
    let enriched = 0;
    let duplicates = 0;
    let conflictStop: number | undefined;
    let conflictKey = '';

    const result = db.transaction(() => {
      let rolloutRowId: number | null = null;
      if (input.rollout !== undefined) {
        rolloutRowId = upsertRollout(db, input.rollout, now);
      }
      for (const observation of input.observations) {
        rolloutRowId = upsertRollout(db, observation, now);
        const outcome = applyObservation({ db, rolloutRowId, input: observation, workspaceDir: input.workspaceDir });
        if (outcome.disposition === 'inserted') inserted += 1;
        else if (outcome.disposition === 'enriched') enriched += 1;
        else if (outcome.disposition === 'duplicate') duplicates += 1;
        else if (outcome.disposition === 'conflict') {
          conflictStop = outcome.stopByteStart;
          conflictKey = observation.logicalObservationKey;
          return 'conflict';
        }
      }

      // Durable checkpoint: advances only in the transaction that commits its
      // decoded observations (SPEC §8) — including deltas that contained only
      // skipped or unknown records. A conflict or malformed record stops the
      // advance at the offending record so it is re-examined, never skipped.
      if (input.checkpoint !== undefined) {
        const degradations = input.degradations ?? [];
        const [firstDegradation] = degradations;
        const stopOffset = conflictStop;
        const byteOffset = stopOffset !== undefined && stopOffset < input.checkpoint.byteOffset ? stopOffset : input.checkpoint.byteOffset;
        const lastDegradation = conflictKey
          ? { reason: 'logical_key_content_conflict', ordinal: null as number | null }
          : firstDegradation
            ? { reason: firstDegradation.reason, ordinal: firstDegradation.ordinal ?? null }
            : null;
        db.prepare(`INSERT INTO governance_transcript_checkpoints
            (host_kind, rollout_identity, byte_offset, last_ordinal, cli_version, root_session_id, incomplete_tail, last_degradation_reason, last_degradation_ordinal, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(host_kind, rollout_identity) DO UPDATE SET
              byte_offset = excluded.byte_offset, last_ordinal = excluded.last_ordinal, cli_version = COALESCE(excluded.cli_version, cli_version),
              root_session_id = excluded.root_session_id, incomplete_tail = excluded.incomplete_tail,
              last_degradation_reason = excluded.last_degradation_reason, last_degradation_ordinal = excluded.last_degradation_ordinal, updated_at = excluded.updated_at`)
          .run(input.checkpoint.hostKind, input.checkpoint.rolloutIdentity, byteOffset, input.checkpoint.lastOrdinal,
            input.checkpoint.cliVersion ?? null, input.checkpoint.rootSessionId, input.checkpoint.incompleteTail ? 1 : 0,
            lastDegradation?.reason ?? null, lastDegradation?.ordinal ?? null, now);
      }

      // Marker semantics: compaction replaces logical history (tombstone every
      // unpromoted observation recorded before the marker); rollback truncates
      // the last N logical turns. Physical records remain; bodies must not.
      if (input.compactionTimestamp && rolloutRowId !== null) {
        const stale = db.prepare(`SELECT id FROM governance_observations WHERE rollout_row_id = ? AND retention_class = 'operational' AND observed_at <= ?`)
          .all(rolloutRowId, input.compactionTimestamp);
        expireRows(db, stale.map((row) => Number(rowField(row, 'id'))).filter((id) => Number.isInteger(id)), { now, klass: 'rolled_back' });
        warnings.push('compaction_marker_applied');
      }
      if (Array.isArray(input.rollbackTurns) && input.rollbackTurns.length > 0 && rolloutRowId !== null) {
        let rolledBackTurns = 0;
        for (const markerTurns of input.rollbackTurns) {
          if (typeof markerTurns !== 'number' || markerTurns <= 0) continue;
          // The LAST N logical turns in canonical source order (live-only
          // turns are the newest; replayed turns order by transcript bytes).
          const turns = listTurnsInSourceOrder(db, rolloutRowId).slice(-markerTurns);
          const ids: number[] = [];
          for (const turn of turns) {
            ids.push(...turnObservationIds(db, rolloutRowId, turn.hostTurnId));
          }
          expireRows(db, ids, { now, klass: 'rolled_back' });
          rolledBackTurns += markerTurns;
        }
        warnings.push(`rollback_marker_applied:${rolledBackTurns}`);
      }

      if (rolloutRowId !== null) completePendingTails(db, rolloutRowId, now);
      expireStalePendingTails(db, new Date(now));
      pruneRetention(db, rolloutRowId, new Date(now));
      return 'committed';
    })();

    if (result === 'conflict') {
      return {
        ok: false, reason: 'logical_key_content_conflict', nextAction: 'the first committed content was preserved and the observation is marked partial; run `pd codex ingest quarantine --workspace <path> --rollout <id> --record <id>` (audited, dry-run default) or re-ingest from a fresh rollout',
        inserted, enriched, duplicates, checkpointCommitted: false, warnings: [`conflict:${conflictKey}`],
      };
    }
    return { ok: true, inserted, enriched, duplicates, checkpointCommitted: input.checkpoint !== undefined, warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `governance_write_failed:${detail}`, nextAction: 'inspect the workspace trajectory database and retry; nothing was partially committed', inserted: 0, enriched: 0, duplicates: 0, checkpointCommitted: false, warnings: [] };
  } finally {
    close();
  }
}

export interface ReadGovernanceCheckpointArgs {
  readonly workspaceDir: string;
  readonly hostKind: 'codex';
  readonly rolloutIdentity: string;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export function readGovernanceCheckpoint(args: ReadGovernanceCheckpointArgs): GovernanceCheckpointRecord | null | Degradation {
  const { workspaceDir, hostKind, rolloutIdentity, databaseFactory } = args;
  const opened = openStore(workspaceDir, databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const row = db.prepare('SELECT * FROM governance_transcript_checkpoints WHERE host_kind = ? AND rollout_identity = ?').get(hostKind, rolloutIdentity);
    if (!isRecord(row)) return null;
    return {
      hostKind: String(rowField(row, 'host_kind')),
      rolloutIdentity: String(rowField(row, 'rollout_identity')),
      byteOffset: Number(rowField(row, 'byte_offset')),
      lastOrdinal: Number(rowField(row, 'last_ordinal')),
      cliVersion: typeof rowField(row, 'cli_version') === 'string' ? (rowField(row, 'cli_version') as string) : null,
      rootSessionId: String(rowField(row, 'root_session_id')),
      incompleteTail: rowField(row, 'incomplete_tail') === 1,
      lastDegradationReason: typeof rowField(row, 'last_degradation_reason') === 'string' ? (rowField(row, 'last_degradation_reason') as string) : null,
      lastDegradationOrdinal: typeof rowField(row, 'last_degradation_ordinal') === 'number' ? (rowField(row, 'last_degradation_ordinal') as number) : null,
      updatedAt: String(rowField(row, 'updated_at')),
    };
  } finally {
    close();
  }
}

export interface ListGovernanceCheckpointsArgs {
  readonly workspaceDir: string;
  readonly hostKind: 'codex';
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type ListGovernanceCheckpointsResult =
  | { ok: true; checkpoints: readonly GovernanceCheckpointRecord[] }
  | Degradation;

/**
 * List every checkpoint for a host kind, oldest-updated first (PRI-624).
 * The Slice C worker/CLI catch-up uses this to find rollouts with pending
 * transcript lag — the checkpoint set is exactly the set of rollouts the
 * authenticated hook previously delivered, so this is never session
 * discovery (SPEC §13 / ADR-0020 §11.2).
 */
export function listGovernanceCheckpoints(args: ListGovernanceCheckpointsArgs): ListGovernanceCheckpointsResult {
  const { workspaceDir, hostKind, databaseFactory } = args;
  const opened = openStore(workspaceDir, databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const rows = db.prepare('SELECT * FROM governance_transcript_checkpoints WHERE host_kind = ? ORDER BY updated_at ASC').all(hostKind);
    const checkpoints: GovernanceCheckpointRecord[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      checkpoints.push({
        hostKind: String(rowField(raw, 'host_kind')),
        rolloutIdentity: String(rowField(raw, 'rollout_identity')),
        byteOffset: Number(rowField(raw, 'byte_offset')),
        lastOrdinal: Number(rowField(raw, 'last_ordinal')),
        cliVersion: typeof rowField(raw, 'cli_version') === 'string' ? (rowField(raw, 'cli_version') as string) : null,
        rootSessionId: String(rowField(raw, 'root_session_id')),
        incompleteTail: rowField(raw, 'incomplete_tail') === 1,
        lastDegradationReason: typeof rowField(raw, 'last_degradation_reason') === 'string' ? (rowField(raw, 'last_degradation_reason') as string) : null,
        lastDegradationOrdinal: typeof rowField(raw, 'last_degradation_ordinal') === 'number' ? (rowField(raw, 'last_degradation_ordinal') as number) : null,
        updatedAt: String(rowField(raw, 'updated_at')),
      });
    }
    return { ok: true, checkpoints };
  } finally {
    close();
  }
}

export interface ListGovernanceObservationsInput {
  readonly workspaceDir: string;
  readonly rolloutIdentity?: string;
  readonly retentionClass?: GovernanceRetentionClass;
  readonly limit?: number;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type ListGovernanceObservationsResult =
  | { ok: true; observations: readonly GovernanceObservationRecord[] }
  | Degradation;

export function listGovernanceObservations(input: ListGovernanceObservationsInput): ListGovernanceObservationsResult {
  const opened = openStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.rolloutIdentity !== undefined) { conditions.push('rollout_identity = ?'); values.push(input.rolloutIdentity); }
    if (input.retentionClass !== undefined) { conditions.push('retention_class = ?'); values.push(input.retentionClass); }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
    const rows = db.prepare(`SELECT * FROM governance_observations${where} ORDER BY id LIMIT ?`).all(...values, limit);
    const observations = rows.map((row) => ({
      id: Number(rowField(row, 'id')),
      rolloutIdentity: String(rowField(row, 'rollout_identity')),
      rootSessionId: String(rowField(row, 'root_session_id')),
      hostTurnId: String(rowField(row, 'host_turn_id')),
      kind: rowField(row, 'kind') as GovernanceObservationKind,
      logicalKey: String(rowField(row, 'logical_key')),
      transcriptRecordKey: typeof rowField(row, 'transcript_record_key') === 'string' ? (rowField(row, 'transcript_record_key') as string) : null,
      sourceOrder: typeof rowField(row, 'source_order') === 'number' ? (rowField(row, 'source_order') as number) : null,
      sourceOrdinal: typeof rowField(row, 'source_ordinal') === 'number' ? (rowField(row, 'source_ordinal') as number) : null,
      assistantItemId: typeof rowField(row, 'assistant_item_id') === 'string' ? (rowField(row, 'assistant_item_id') as string) : null,
      phase: typeof rowField(row, 'phase') === 'string' ? (rowField(row, 'phase') as string) : null,
      toolUseId: typeof rowField(row, 'tool_use_id') === 'string' ? (rowField(row, 'tool_use_id') as string) : null,
      transcriptToolCallId: typeof rowField(row, 'transcript_tool_call_id') === 'string' ? (rowField(row, 'transcript_tool_call_id') as string) : null,
      visibleText: typeof rowField(row, 'visible_text') === 'string' ? (rowField(row, 'visible_text') as string) : null,
      sanitizedToolFactsJson: typeof rowField(row, 'sanitized_tool_facts_json') === 'string' ? (rowField(row, 'sanitized_tool_facts_json') as string) : null,
      source: rowField(row, 'source') as GovernanceObservationSource,
      completeness: rowField(row, 'completeness') as GovernanceObservationCompleteness,
      retentionClass: rowField(row, 'retention_class') as GovernanceRetentionClass,
      observedAt: String(rowField(row, 'observed_at')),
      promotionRef: typeof rowField(row, 'promotion_ref') === 'string' ? (rowField(row, 'promotion_ref') as string) : null,
    }));
    return { ok: true, observations };
  } finally {
    close();
  }
}

class PromotionMissingError extends Error {
  constructor(readonly reason: string, readonly nextAction: string) {
    super(reason);
    this.name = 'PromotionMissingError';
  }
}

export function promoteGovernanceEvidence(input: PromoteGovernanceEvidenceInput): PromoteGovernanceEvidenceResult {
  const opened = openStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return { ok: false, reason: opened.reason, nextAction: opened.nextAction };
  const { db, close } = opened;
  const now = (input.now ?? new Date()).toISOString();
  const warnings: string[] = [];

  try {
    let promoted = 0;
    let tailState: 'completed' | 'pending' = 'pending';

    db.transaction(() => {
      const rollout = db.prepare('SELECT id FROM governance_rollouts WHERE host_kind = ? AND rollout_identity = ?').get(input.hostKind, input.rolloutIdentity);
      const rolloutRowId = rowField(rollout, 'id');
      if (typeof rolloutRowId !== 'number') throw new PromotionMissingError('rollout_not_found', 'ingest the rollout before promoting evidence around it');

      // Idempotency: a completed or still-pending tail for the same trigger +
      // pain reference is a no-op replay (crash, restart, duplicate delivery).
      const existingTail = db.prepare('SELECT * FROM governance_pending_promotion_tails WHERE rollout_row_id = ? AND trigger_logical_key = ? AND pain_ref = ?')
        .get(rolloutRowId, input.triggerLogicalKey, input.painRef);
      if (isRecord(existingTail)) {
        const state = rowField(existingTail, 'state');
        if (state === 'completed') { tailState = 'completed'; return; }
        if (state === 'pending') {
          // Recovery invariant: the tail may already be satisfiable now.
          const completedNow = completePendingTails(db, rolloutRowId, now);
          if (completedNow > 0) tailState = 'completed';
          return;
        }
        // state === 'stale': a diagnosable terminal state — do not silently
        // re-arm; the caller must start a new promotion with a new reference.
        throw new PromotionMissingError('promotion_tail_stale', 'the pending promotion tail expired; create a new promotion with a new pain reference');
      }

      const triggerRow = db.prepare('SELECT * FROM governance_observations WHERE logical_key = ? AND rollout_row_id = ?').get(input.triggerLogicalKey, rolloutRowId);
      if (!isRecord(triggerRow)) throw new PromotionMissingError('trigger_not_found', 'the triggering observation must be ingested before promotion');
      const triggerId = rowField(triggerRow, 'id');
      const triggerOrder = typeof rowField(triggerRow, 'source_order') === 'number' ? (rowField(triggerRow, 'source_order') as number) : null;

      const promoteIds = (ids: readonly number[]) => {
        for (const id of ids) {
          db.prepare("UPDATE governance_observations SET retention_class = 'promoted', promoted_at = ?, promotion_ref = COALESCE(promotion_ref, ?) WHERE id = ? AND retention_class != 'promoted'")
            .run(now, input.painRef, id);
          promoted += 1;
        }
      };

      // ≤12 preceding visible turns: the turns immediately BEFORE the
      // trigger's own turn in canonical source order (transcript byte order;
      // a live trigger not yet replayed positions after everything observed
      // so far, which is exactly its real position — nothing newer exists).
      const turns = listTurnsInSourceOrder(db, rolloutRowId);
      const triggerTurnIndex = turns.findIndex((turn) => {
        const ids = db.prepare('SELECT id FROM governance_observations WHERE rollout_row_id = ? AND host_turn_id = ? AND logical_key = ?')
          .all(rolloutRowId, turn.hostTurnId, input.triggerLogicalKey);
        return ids.length > 0;
      });
      const precedingStart = triggerTurnIndex > 0 ? Math.max(0, triggerTurnIndex - GOVERNANCE_PROMOTION_PRECEDING_TURNS) : -1;
      const preceding = triggerTurnIndex > 0 ? turns.slice(precedingStart, triggerTurnIndex) : [];
      for (const turn of preceding) {
        promoteIds(turnObservationIds(db, rolloutRowId, turn.hostTurnId));
      }
      promoteIds([Number(triggerId)]);

      if (triggerOrder !== null) {
        // Next completed assistant turn: the earliest final-answer assistant
        // AFTER the trigger in transcript source order. When the trigger has
        // no transcript position yet, the durable pending tail below resolves
        // once the replay enriches it (completePendingTails re-checks).
        const next = db.prepare(`SELECT id FROM governance_observations
          WHERE rollout_row_id = ? AND kind = 'assistant_turn' AND phase = 'final_answer' AND completeness = 'complete' AND source_order > ?
          ORDER BY source_order LIMIT 1`).get(rolloutRowId, triggerOrder);
        const nextId = rowField(next, 'id');
        if (typeof nextId === 'number') {
          promoteIds([nextId]);
          tailState = 'completed';
        }
      }
      if (tailState !== 'completed') {
        db.prepare(`INSERT INTO governance_pending_promotion_tails (rollout_row_id, host_kind, rollout_identity, trigger_logical_key, pain_ref, state, created_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
          .run(rolloutRowId, input.hostKind, input.rolloutIdentity, input.triggerLogicalKey, input.painRef, now);
        tailState = 'pending';
        warnings.push('pending_next_assistant_tail');
      }
    })();

    return { ok: true, promoted, tailState, warnings };
  } catch (error) {
    if (error instanceof PromotionMissingError) return { ok: false, reason: error.reason, nextAction: error.nextAction };
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `governance_write_failed:${detail}`, nextAction: 'inspect the workspace trajectory database and retry; nothing was partially committed' };
  } finally {
    close();
  }
}

// ─── Quarantine (Slice D, SPEC rev 2 §15) ────────────────────────────────────

export interface QuarantineGovernanceObservationArgs {
  readonly workspaceDir: string;
  readonly hostKind: 'codex';
  readonly rolloutIdentity: string;
  /** governance_observations.id — `pd codex ingest quarantine --record <id>`. */
  readonly recordId: number;
  /** Why this record is permanently invalid (bounded, stored verbatim). */
  readonly reason: string;
  /** Who ran the quarantine (operator identity string, bounded). */
  readonly operator: string;
  /** false = dry run (default contract): report, never mutate. */
  readonly confirm?: boolean;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export interface QuarantinedRecordSummary {
  readonly id: number;
  readonly kind: string;
  readonly logicalKey: string;
  readonly observedAt: string;
  readonly retentionClass: GovernanceRetentionClass;
  /** SHA-256 over the row's stored content (hex) — computed the same way for dry runs. */
  readonly digest: string;
  /** Bounded neighbor description: `prev=<order|none>;next=<order|none>;record=<order|null>`. */
  readonly gap: string;
}

export type QuarantineGovernanceObservationResult =
  | {
    ok: true;
    dryRun: boolean;
    alreadyQuarantined: boolean;
    record: QuarantinedRecordSummary;
  }
  | { ok: false; reason: string; nextAction: string };

const QUARANTINE_REASON_MAX = 200;
const QUARANTINE_OPERATOR_MAX = 80;

function observationDigest(row: Record<string, unknown>): string {
  // Digest the row's stored content exactly as persisted (rc-8: hashing
  // string columns only — never JSON.stringify of untrusted unknowns). The
  // digest lets a future audit recognize the same record if it reappears.
  const hash = createHash('sha256');
  for (const column of ['rollout_identity', 'logical_key', 'transcript_record_key', 'kind', 'source', 'completeness', 'visible_text', 'sanitized_tool_facts_json', 'observed_at']) {
    const value = row[column];
    hash.update(`${column}=`);
    hash.update(value === null || value === undefined ? '<null>' : String(value));
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Audited quarantine for a permanently invalid governance observation
 * (SPEC §15). Dry run is the contract default: without `confirm` the store
 * reports what WOULD happen and mutates nothing. With `confirm`:
 *  - bodies (visible_text / sanitized_tool_facts_json) are dropped;
 *  - retention_class becomes `quarantined` (terminal class — never pruned,
 *    never promoted);
 *  - digest, reason, operator, timestamp, and the neighbor gap are recorded;
 *  - the Codex transcript is never read or touched (this function opens only
 *    the workspace trajectory.db).
 * Promoted evidence is refused: Owner-decided evidence leaves only through
 * the Owner governance cleanup commands.
 */
export function quarantineGovernanceObservation(args: QuarantineGovernanceObservationArgs): QuarantineGovernanceObservationResult {
  const { workspaceDir, hostKind, rolloutIdentity, recordId, reason, operator, confirm = false } = args;
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return { ok: false, reason: 'record_id_invalid', nextAction: 'Pass the numeric governance_observations.id (--record <id>); run `pd codex ingest catch-up --json` output or inspect trajectory.db to find it.' };
  }
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > QUARANTINE_REASON_MAX) {
    return { ok: false, reason: 'reason_required', nextAction: `Provide a non-empty reason (≤ ${QUARANTINE_REASON_MAX} chars) describing why the record is permanently invalid.` };
  }
  if (typeof operator !== 'string' || operator.trim().length === 0 || operator.length > QUARANTINE_OPERATOR_MAX) {
    return { ok: false, reason: 'operator_required', nextAction: `Provide the operator identity (≤ ${QUARANTINE_OPERATOR_MAX} chars).` };
  }
  const opened = openStore(workspaceDir, args.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const outcome = db.transaction(() => {
      const rolloutRow = db.prepare('SELECT id FROM governance_rollouts WHERE host_kind = ? AND rollout_identity = ?').get(hostKind, rolloutIdentity);
      if (!isRecord(rolloutRow)) {
        return { ok: false, reason: 'rollout_not_found', nextAction: `No governed rollout '${rolloutIdentity}' for host '${hostKind}' in this workspace; check the identity (see \`pd codex ingest catch-up\` output).` };
      }
      const rolloutRowId = rowField(rolloutRow, 'id');
      const row = db.prepare('SELECT * FROM governance_observations WHERE id = ? AND rollout_row_id = ?').get(recordId, rolloutRowId);
      if (!isRecord(row)) {
        return { ok: false, reason: 'record_not_found', nextAction: `Record ${recordId} does not exist in rollout '${rolloutIdentity}' of this workspace; verify the id.` };
      }
      const retentionClassRaw = String(rowField(row, 'retention_class'));
      // rc-2: the DB column is untrusted — only known classes enter the typed
      // summary; anything else reads as 'expired' semantics for reporting but
      // still fails the quarantinable check below.
      const retentionClass: GovernanceRetentionClass = retentionClassRaw === 'operational' || retentionClassRaw === 'promoted'
        || retentionClassRaw === 'quarantined' || retentionClassRaw === 'rolled_back'
        ? retentionClassRaw
        : 'expired';
      const quarantinedAt = rowField(row, 'quarantined_at');
      const sourceOrder = typeof rowField(row, 'source_order') === 'number' ? (rowField(row, 'source_order') as number) : null;

      const neighborQuery = (direction: 'prev' | 'next'): number | 'none' => {
        if (sourceOrder === null) return 'none';
        const comparison = direction === 'prev' ? '<' : '>';
        const ordering = direction === 'prev' ? 'DESC' : 'ASC';
        const neighbor = db.prepare(`SELECT source_order FROM governance_observations
          WHERE rollout_row_id = ? AND source_order IS NOT NULL AND source_order ${comparison} ?
          ORDER BY source_order ${ordering} LIMIT 1`).get(rolloutRowId, sourceOrder);
        const value = isRecord(neighbor) ? rowField(neighbor, 'source_order') : undefined;
        return typeof value === 'number' ? value : 'none';
      };

      const summary: QuarantinedRecordSummary = {
        id: recordId,
        kind: String(rowField(row, 'kind')),
        logicalKey: String(rowField(row, 'logical_key')),
        observedAt: String(rowField(row, 'observed_at')),
        retentionClass,
        digest: observationDigest(row),
        gap: `prev=${neighborQuery('prev')};next=${neighborQuery('next')};record=${sourceOrder === null ? 'null' : sourceOrder}`,
      };

      if (typeof quarantinedAt === 'string' && quarantinedAt.length > 0) {
        // Already terminal: report the RECORDED audit digest/gap, not a
        // re-hash of the row (bodies were dropped at quarantine time, so a
        // fresh hash would silently differ from the audited one).
        const recordedDigest = rowField(row, 'quarantine_digest');
        const recordedGap = rowField(row, 'quarantine_gap');
        return {
          ok: true, dryRun: false, alreadyQuarantined: true,
          record: {
            ...summary,
            digest: typeof recordedDigest === 'string' && recordedDigest.length > 0 ? recordedDigest : summary.digest,
            gap: typeof recordedGap === 'string' && recordedGap.length > 0 ? recordedGap : summary.gap,
          },
        };
      }
      if (retentionClass === 'promoted') {
        return { ok: false, reason: 'record_is_promoted_evidence', nextAction: 'Promoted evidence is Owner-decided governance evidence; quarantine never touches it. Use the existing Owner governance cleanup commands if the evidence must be removed.' };
      }
      if (retentionClass !== 'operational') {
        return { ok: false, reason: `record_not_quarantinable:${retentionClass}`, nextAction: 'Only operational records can be quarantined; expired and rolled-back rows are already terminal.' };
      }
      if (!confirm) {
        return { ok: true, dryRun: true, alreadyQuarantined: false, record: summary };
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE governance_observations
        SET visible_text = NULL, sanitized_tool_facts_json = NULL, retention_class = 'quarantined',
            quarantined_at = ?, quarantine_reason = ?, quarantine_digest = ?, quarantine_operator = ?, quarantine_gap = ?
        WHERE id = ? AND retention_class = 'operational'`)
        .run(now, reason, summary.digest, operator, summary.gap, recordId);
      return { ok: true, dryRun: false, alreadyQuarantined: false, record: summary };
    })();
    return outcome as QuarantineGovernanceObservationResult;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `governance_quarantine_failed:${detail}`, nextAction: 'inspect the workspace trajectory database and retry; the transaction rolled back, nothing was partially mutated' };
  } finally {
    close();
  }
}

// ─── Read-only surface stats (Slice D, SPEC rev 2 §15 health) ───────────────

export interface GovernanceObservationStats {
  readonly operational: number;
  readonly promoted: number;
  readonly quarantined: number;
  readonly terminalOther: number;
  /** Oldest operational observed_at + retention window — when the next row ages out. */
  readonly nextExpiryAt: string | null;
  readonly lastObservationAt: string | null;
}

export type ReadGovernanceObservationStatsResult =
  | { ok: true; stats: GovernanceObservationStats }
  | { ok: false; reason: string; nextAction: string };

/**
 * Bounded read-only counts for the §15 health surface. Unknown is reported
 * as a structured degradation — never silently as zero (§15: unknown is not
 * reported as healthy).
 */
export function readGovernanceObservationStats(args: { workspaceDir: string; databaseFactory?: ObservationDatabaseFactory }): ReadGovernanceObservationStatsResult {
  const opened = openStore(args.workspaceDir, args.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const counts = db.prepare(`SELECT
        SUM(CASE WHEN retention_class = 'operational' THEN 1 ELSE 0 END) AS operational,
        SUM(CASE WHEN retention_class = 'promoted' THEN 1 ELSE 0 END) AS promoted,
        SUM(CASE WHEN retention_class = 'quarantined' THEN 1 ELSE 0 END) AS quarantined,
        SUM(CASE WHEN retention_class IN ('expired', 'rolled_back') THEN 1 ELSE 0 END) AS terminal_other,
        MIN(CASE WHEN retention_class = 'operational' THEN observed_at END) AS oldest_operational,
        MAX(observed_at) AS last_observation
      FROM governance_observations`).get();
    if (!isRecord(counts)) {
      return { ok: false, reason: 'governance_stats_unavailable', nextAction: 'Inspect the workspace trajectory.db governance_observations table.' };
    }
    const numberOr = (value: unknown): number => (typeof value === 'number' ? value : 0);
    const stringOr = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
    const oldest = stringOr(own(counts, 'oldest_operational'));
    const nextExpiry = oldest !== null && !Number.isNaN(Date.parse(oldest))
      ? new Date(Date.parse(oldest) + GOVERNANCE_RETENTION_MAX_AGE_MS).toISOString()
      : null;
    return {
      ok: true,
      stats: {
        operational: numberOr(own(counts, 'operational')),
        promoted: numberOr(own(counts, 'promoted')),
        quarantined: numberOr(own(counts, 'quarantined')),
        terminalOther: numberOr(own(counts, 'terminal_other')),
        nextExpiryAt: nextExpiry,
        lastObservationAt: stringOr(own(counts, 'last_observation')),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 160) : String(error);
    return { ok: false, reason: `governance_stats_failed:${detail}`, nextAction: 'Inspect the workspace trajectory.db; the health surface degraded without mutating anything.' };
  } finally {
    close();
  }
}

