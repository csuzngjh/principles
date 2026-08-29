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
import Database from 'better-sqlite3';
import { sanitizeString, sanitizeValue } from '@principles/core/runtime-v2';

// ─── Retention policy constants (Owner-approved, SPEC rev 2 §11) ────────────
export const GOVERNANCE_RETENTION_MAX_TURNS = 32;
export const GOVERNANCE_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const GOVERNANCE_PROMOTION_PRECEDING_TURNS = 12;
export const GOVERNANCE_PENDING_TAIL_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const GOVERNANCE_OBSERVATION_SCHEMA_VERSION = 1;
const MAX_TEXT_BOUND = 200; // matches MAX_EVIDENCE_VALUE_CHARS; guards stored identity fields
const MAX_JSON_COLUMN = 8_000;

export type GovernanceObservationKind = 'user_turn' | 'assistant_turn' | 'tool_call';
export type GovernanceObservationSource = 'live_hook' | 'transcript';
export type GovernanceObservationCompleteness = 'complete' | 'partial';
export type GovernanceRetentionClass = 'operational' | 'promoted' | 'expired' | 'rolled_back';

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
  /** Byte offset of the source record start — used to stop checkpoint advance on conflict. */
  readonly recordByteStart?: number;

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
    return text.length > MAX_JSON_COLUMN ? `${text.slice(0, MAX_JSON_COLUMN - 3)}...` : text;
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

function ensureGovernanceObservationSchema(db: Database.Database): void {
  db.transaction(() => {
    for (const statement of CREATE_STATEMENTS) db.exec(statement);
    const row = db.prepare('SELECT version FROM governance_observation_schema_version LIMIT 1').get();
    const current = isRecord(row) ? own(row, 'version') : undefined;
    if (typeof current !== 'number') {
      db.prepare('INSERT INTO governance_observation_schema_version (version) VALUES (?)').run(GOVERNANCE_OBSERVATION_SCHEMA_VERSION);
    } else if (current < GOVERNANCE_OBSERVATION_SCHEMA_VERSION) {
      db.prepare('UPDATE governance_observation_schema_version SET version = ?').run(GOVERNANCE_OBSERVATION_SCHEMA_VERSION);
    }
  })();
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
      (rollout_row_id, host_kind, rollout_identity, root_session_id, host_turn_id, kind, logical_key, transcript_record_key, assistant_item_id, phase, tool_use_id, transcript_tool_call_id, visible_text, sanitized_tool_facts_json, source, completeness, retention_class, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'operational', ?)`)
      .run(rolloutRowId, input.hostKind, input.rolloutIdentity, input.rootSessionId, input.hostTurnId, input.kind, input.logicalObservationKey,
        input.transcriptRecordKey ?? null, boundedString(input.assistantItemId, MAX_TEXT_BOUND), boundedString(input.phase, MAX_TEXT_BOUND) ?? null,
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

function pruneRetention(db: Database.Database, rolloutRowId: number | null, now: Date): void {
  const nowIso = now.toISOString();
  // Age bound: global, bounded single statements over the retention index.
  db.prepare(`UPDATE governance_observations SET visible_text = NULL, sanitized_tool_facts_json = NULL, retention_class = 'expired', expired_at = ?
    WHERE retention_class = 'operational' AND observed_at < ?`)
    .run(nowIso, new Date(now.getTime() - GOVERNANCE_RETENTION_MAX_AGE_MS).toISOString());
  // Turn bound: per ingested rollout, keep the latest N conversational turns.
  if (rolloutRowId === null) return;
  const rows = db.prepare(`SELECT host_turn_id, MIN(id) AS first_id FROM governance_observations
    WHERE rollout_row_id = ? AND retention_class = 'operational'
    GROUP BY host_turn_id ORDER BY first_id DESC`).all(rolloutRowId);
  if (rows.length <= GOVERNANCE_RETENTION_MAX_TURNS) return;
  const expiredIds: number[] = [];
  for (const row of rows.slice(GOVERNANCE_RETENTION_MAX_TURNS)) {
    const turnId = rowField(row, 'host_turn_id');
    if (typeof turnId !== 'string') continue;
    const obsRows = db.prepare('SELECT id FROM governance_observations WHERE rollout_row_id = ? AND host_turn_id = ? AND retention_class = ?')
      .all(rolloutRowId, turnId, 'operational');
    for (const obsRow of obsRows) {
      const id = rowField(obsRow, 'id');
      if (typeof id === 'number') expiredIds.push(id);
    }
  }
  expireRows(db, expiredIds, { now: nowIso, klass: 'expired' });
}

function completePendingTails(db: Database.Database, rolloutRowId: number, now: string): number {
  const pending = db.prepare("SELECT * FROM governance_pending_promotion_tails WHERE rollout_row_id = ? AND state = 'pending'").all(rolloutRowId);
  let completed = 0;
  for (const tail of pending) {
    const triggerKey = rowField(tail, 'trigger_logical_key');
    if (typeof triggerKey !== 'string') continue;
    const triggerRow = db.prepare('SELECT id FROM governance_observations WHERE logical_key = ?').get(triggerKey);
    const triggerId = rowField(triggerRow, 'id');
    if (typeof triggerId !== 'number') continue;
    // The next completed assistant turn: the earliest final-answer assistant
    // observation that physically follows the trigger in this rollout.
    const next = db.prepare(`SELECT id FROM governance_observations
      WHERE rollout_row_id = ? AND kind = 'assistant_turn' AND phase = 'final_answer' AND completeness = 'complete' AND id > ?
      ORDER BY id LIMIT 1`).get(rolloutRowId, triggerId);
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
            lastDegradation?.reason ?? null, lastDegradation?.ordinal, now);
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
          const turns = db.prepare(`SELECT host_turn_id, MIN(id) AS first_id FROM governance_observations
            WHERE rollout_row_id = ? AND retention_class = 'operational' GROUP BY host_turn_id ORDER BY first_id DESC LIMIT ?`)
            .all(rolloutRowId, markerTurns);
          const ids: number[] = [];
          for (const turn of turns) {
            const turnId = rowField(turn, 'host_turn_id');
            if (typeof turnId !== 'string') continue;
            for (const obsRow of db.prepare('SELECT id FROM governance_observations WHERE rollout_row_id = ? AND host_turn_id = ? AND retention_class = ?').all(rolloutRowId, turnId, 'operational')) {
              const id = rowField(obsRow, 'id');
              if (typeof id === 'number') ids.push(id);
            }
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
        ok: false, reason: 'logical_key_content_conflict', nextAction: 'the first committed content was preserved and the observation is marked partial; run the audited quarantine/recovery command once available (Slice D) or re-ingest from a fresh rollout',
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

      const promoteIds = (ids: readonly number[]) => {
        for (const id of ids) {
          db.prepare("UPDATE governance_observations SET retention_class = 'promoted', promoted_at = ?, promotion_ref = COALESCE(promotion_ref, ?) WHERE id = ? AND retention_class != 'promoted'")
            .run(now, input.painRef, id);
          promoted += 1;
        }
      };

      // ≤12 preceding visible turns: turn groups strictly before the trigger's
      // own turn, newest first, operational rows only (expired bodies are gone).
      const turns = db.prepare(`SELECT host_turn_id, MIN(id) AS first_id FROM governance_observations
        WHERE rollout_row_id = ? AND retention_class = 'operational' GROUP BY host_turn_id ORDER BY first_id ASC`).all(rolloutRowId);
      const triggerTurnIndex = turns.findIndex((turn) => {
        const ids = db.prepare('SELECT id FROM governance_observations WHERE rollout_row_id = ? AND host_turn_id = ? AND logical_key = ?')
          .all(rolloutRowId, rowField(turn, 'host_turn_id'), input.triggerLogicalKey);
        return ids.length > 0;
      });
      const preceding = triggerTurnIndex > 0 ? turns.slice(Math.max(0, triggerTurnIndex - GOVERNANCE_PROMOTION_PRECEDING_TURNS), triggerTurnIndex) : [];
      for (const turn of preceding) {
        const turnId = rowField(turn, 'host_turn_id');
        if (typeof turnId !== 'string') continue;
        const rows = db.prepare("SELECT id FROM governance_observations WHERE rollout_row_id = ? AND host_turn_id = ? AND retention_class = 'operational'").all(rolloutRowId, turnId);
        promoteIds(rows.map((row) => Number(rowField(row, 'id'))).filter((id) => Number.isInteger(id)));
      }
      promoteIds([Number(triggerId)]);

      const next = db.prepare(`SELECT id FROM governance_observations
        WHERE rollout_row_id = ? AND kind = 'assistant_turn' AND phase = 'final_answer' AND completeness = 'complete' AND id > ?
        ORDER BY id LIMIT 1`).get(rolloutRowId, triggerId);
      const nextId = rowField(next, 'id');
      if (typeof nextId === 'number') {
        promoteIds([nextId]);
        tailState = 'completed';
      } else {
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

