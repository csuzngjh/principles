/**
 * Canonical trajectory.db schema definition (PRI-774; SPEC:
 * docs/specs/trajectory-data-plane-single-truth.md).
 *
 * Single source of truth for the schema applied by BOTH build paths:
 * - openclaw-plugin applyTrajectorySchema() → Profile B/C (views: true)
 * - principles-core ensureTrajectorySchema() → Profile A (views: false,
 *   pain-record path)
 *
 * Ownership:
 * - owns: CREATE TABLE/INDEX/VIEW statements, column-migration blocks, the
 *   evolution_tasks column backfill, TRAJECTORY_SCHEMA_VERSION and
 *   TRAJECTORY_TABLES declarations.
 * - does NOT own: path resolution, directory creation, connection lifecycle,
 *   WAL/pragmas, schema_version ROW writes (TrajectoryDatabase.initSchema and
 *   initTrajectorySchema keep that), v_daily_metrics (plugin migrateSchema),
 *   governance_* tables (host-runtime stores).
 *
 * Zero pathways are abolished: both paths keep their exact pre-PRI-774
 * behavior; only the definition-text copies converge (SPEC v3, Owner-approved).
 */
import type { Database } from 'better-sqlite3';

export interface TrajectorySchemaApplyOptions {
  /**
   * Profile B (runtime-init): also create the three analytics views.
   * Default false (Profile A, core pain-record path — views are
   * plugin-read conveniences).
   */
  views?: boolean;
}

export interface TrajectorySchemaApplyResult {
  tables: string[];
  warnings: string[];
}

/** trajectory.db schema version. Row writes stay with the two existing owner entry points. */
export const TRAJECTORY_SCHEMA_VERSION = 1;

/** Fresh-schema table list, in creation order (single derived source). */
export const TRAJECTORY_TABLES = [
  'schema_version',
  'ingest_checkpoint',
  'sessions',
  'assistant_turns',
  'user_turns',
  'tool_calls',
  'pain_events',
  'gate_blocks',
  'trust_changes',
  'principle_events',
  'task_outcomes',
  'correction_samples',
  'sample_reviews',
  'signal_confirmations',
  'exports_audit',
] as const;

/**
 * SQLite's only signal for "column already exists" is the error message text
 * (there is no IF NOT EXISTS for ADD COLUMN); unexpected errors must rethrow.
 */
function isDuplicateColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('duplicate column name') || message.includes('no column named')
  );
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

export function applyTrajectorySchemaBase(
  db: Database,
  opts: { views?: boolean } = {},
): { tables: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const tables = [...TRAJECTORY_TABLES];

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS ingest_checkpoint (source_key TEXT PRIMARY KEY, imported_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS assistant_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, raw_text TEXT, sanitized_text TEXT NOT NULL, usage_json TEXT NOT NULL, empathy_signal_json TEXT NOT NULL, blob_ref TEXT, raw_excerpt TEXT, stop_reason TEXT, thinking_blocks_count INTEGER, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS user_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL, raw_text TEXT, blob_ref TEXT, raw_excerpt TEXT, correction_detected INTEGER NOT NULL DEFAULT 0, correction_cue TEXT, references_assistant_turn_id INTEGER, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS gate_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, tool_name TEXT NOT NULL, file_path TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS trust_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, previous_score REAL NOT NULL, new_score REAL NOT NULL, delta REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS principle_events (id INTEGER PRIMARY KEY AUTOINCREMENT, principle_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS task_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT, outcome TEXT NOT NULL, summary TEXT, principle_ids_json TEXT NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS correction_samples (sample_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, bad_assistant_turn_id INTEGER NOT NULL, user_correction_turn_id INTEGER NOT NULL, recovery_tool_span_json TEXT NOT NULL, diff_excerpt TEXT NOT NULL, principle_ids_json TEXT NOT NULL, quality_score REAL NOT NULL, review_status TEXT NOT NULL, export_mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sample_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id TEXT NOT NULL, review_status TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS signal_confirmations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_turn_rowid INTEGER NOT NULL UNIQUE, occurrence_id TEXT NOT NULL, excerpt TEXT NOT NULL, terms_json TEXT NOT NULL, suggested_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'pending\' CHECK (status IN (\'pending\',\'confirmed\',\'rejected\',\'abandoned\')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS exports_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, export_kind TEXT NOT NULL, mode TEXT NOT NULL, approved_only INTEGER NOT NULL, file_path TEXT NOT NULL, row_count INTEGER NOT NULL, created_at TEXT NOT NULL)');

  // Migration: Add text column to pain_events if it doesn't exist (MEM-01).
  try {
    db.exec('ALTER TABLE pain_events ADD COLUMN text TEXT');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }

  // PRI-406: canonical_pain_id + runtime_task_id columns.
  try {
    db.exec('ALTER TABLE pain_events ADD COLUMN canonical_pain_id TEXT');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }
  try {
    db.exec('ALTER TABLE pain_events ADD COLUMN runtime_task_id TEXT');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }

  // PRI-640: host attribution — observability metadata only, orthogonal to
  // `origin` (evidence semantics) and excluded from canonical pain identity.
  try {
    db.exec('ALTER TABLE pain_events ADD COLUMN host_kind TEXT');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }

  // Trajectory enhancement: stop_reason / thinking_blocks_count / result_preview.
  try {
    db.exec('ALTER TABLE assistant_turns ADD COLUMN stop_reason TEXT');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }
  try {
    db.exec('ALTER TABLE assistant_turns ADD COLUMN thinking_blocks_count INTEGER');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }
  try {
    db.exec('ALTER TABLE tool_calls ADD COLUMN result_preview TEXT');
  } catch (err: unknown) {
    if (!isDuplicateColumnError(err)) throw err;
  }

  // PRI-406: Partial unique index on canonical_pain_id (non-null only) for dedup.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');

  // PRI-770/773: evolution_tasks historical column backfill — only when the
  // legacy table exists (old workspaces); fresh workspaces never create it.
  if (tableExists(db, 'evolution_tasks')) {
    try {
      db.exec('ALTER TABLE evolution_tasks ADD COLUMN task_kind TEXT');
    } catch (err: unknown) {
      if (!isDuplicateColumnError(err)) throw err;
    }
    try {
      db.exec('ALTER TABLE evolution_tasks ADD COLUMN priority TEXT');
    } catch (err: unknown) {
      if (!isDuplicateColumnError(err)) throw err;
    }
    try {
      db.exec('ALTER TABLE evolution_tasks ADD COLUMN retry_count INTEGER');
    } catch (err: unknown) {
      if (!isDuplicateColumnError(err)) throw err;
    }
    try {
      db.exec('ALTER TABLE evolution_tasks ADD COLUMN max_retries INTEGER');
    } catch (err: unknown) {
      if (!isDuplicateColumnError(err)) throw err;
    }
    try {
      db.exec('ALTER TABLE evolution_tasks ADD COLUMN last_error TEXT');
    } catch (err: unknown) {
      if (!isDuplicateColumnError(err)) throw err;
    }
    try {
      db.exec('ALTER TABLE evolution_tasks ADD COLUMN result_ref TEXT');
    } catch (err: unknown) {
      if (!isDuplicateColumnError(err)) throw err;
    }
  }

  // Secondary indexes (creation order preserved from the pre-convergence copy).
  db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_turns_session_id ON assistant_turns(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_turns_created_at ON assistant_turns(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_turns_provider_model ON assistant_turns(provider, model)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_turns_session_id ON user_turns(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pain_events_session_id ON pain_events(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_correction_samples_review_status ON correction_samples(review_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_signal_confirmations_status ON signal_confirmations(status, attempts)');

  // Profile B views (runtime-init only; intentional asymmetry vs Profile A).
  if (opts.views === true) {
    db.exec("CREATE VIEW IF NOT EXISTS v_error_clusters AS SELECT tool_name, COALESCE(error_type, 'unknown') AS error_type, COUNT(*) AS occurrences FROM tool_calls WHERE outcome = 'failure' GROUP BY tool_name, COALESCE(error_type, 'unknown') ORDER BY occurrences DESC");
    db.exec('CREATE VIEW IF NOT EXISTS v_principle_effectiveness AS SELECT event_type, COUNT(*) AS total FROM principle_events GROUP BY event_type ORDER BY total DESC');
    db.exec('CREATE VIEW IF NOT EXISTS v_sample_queue AS SELECT review_status, COUNT(*) AS total FROM correction_samples GROUP BY review_status');
  }

  return { tables, warnings };
}
