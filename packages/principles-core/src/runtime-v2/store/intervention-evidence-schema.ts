/**
 * Intervention Evidence schema statements — PD v2 Phase 1 (ADR-0027).
 *
 * Applied statement-by-statement by SqliteConnection.initSchema() (bulk
 * exec() in new code is flagged by the security write gate). Every statement
 * is idempotent (CREATE ... IF NOT EXISTS), so existing state.db workspaces
 * upgrade on the next write-connection open without a version bump — same
 * precedent as pain_diagnoses / pending_agent_drafts.
 *
 * Design notes:
 *   - Records are append-only and immutable; corrections append a new row
 *     referencing the original via correction_of. UPDATE/DELETE triggers
 *     enforce immutability at the DB level (activation_decisions precedent).
 *   - Idempotency anchor: UNIQUE(source_kind, source_locator, observation_key)
 *     plus record_digest — replaying the same source is a no-op; a different
 *     payload under the same key is a reported source conflict, never an
 *     overwrite.
 *   - The capability matrix is declarative adapter state (latest declaration
 *     wins per host × capability), not observed fact history.
 */
export const INTERVENTION_EVIDENCE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS intervention_evidence_scope (
    scope_id TEXT PRIMARY KEY,
    established_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS intervention_evidence_records (
    evidence_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    source_locator TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK (record_kind IN ('delivery','application','behavior_episode','effect','outcome')),
    principle_id TEXT,
    activation_id TEXT,
    delivery_key TEXT,
    episode_key TEXT,
    effect_key TEXT,
    correction_of TEXT,
    correction_reason TEXT,
    occurred_at TEXT,
    recorded_at TEXT NOT NULL,
    native_refs_json TEXT NOT NULL,
    content_ref_json TEXT,
    activation_ref_json TEXT,
    payload_json TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    UNIQUE (source_kind, source_locator, observation_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_ier_principle_time ON intervention_evidence_records(principle_id, recorded_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_ier_activation ON intervention_evidence_records(activation_id)',
  'CREATE INDEX IF NOT EXISTS idx_ier_episode ON intervention_evidence_records(episode_key)',
  'CREATE INDEX IF NOT EXISTS idx_ier_effect ON intervention_evidence_records(effect_key)',
  `CREATE TRIGGER IF NOT EXISTS intervention_evidence_records_no_update
    BEFORE UPDATE ON intervention_evidence_records
    BEGIN
      SELECT RAISE(ABORT, 'intervention evidence records are immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS intervention_evidence_records_no_delete
    BEFORE DELETE ON intervention_evidence_records
    BEGIN
      SELECT RAISE(ABORT, 'intervention evidence records are immutable');
    END`,
  `CREATE TABLE IF NOT EXISTS intervention_capability_declarations (
    host_kind TEXT NOT NULL CHECK (host_kind IN ('openclaw','codex')),
    capability TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('supported','unsupported','unknown')),
    adapter_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    max_confirmation TEXT,
    note TEXT,
    declared_at TEXT NOT NULL,
    PRIMARY KEY (host_kind, capability)
  )`,
];

/** Tables this feature owns inside state.db (existence precheck for reads). */
export const INTERVENTION_EVIDENCE_TABLES: readonly string[] = [
  'intervention_evidence_scope',
  'intervention_evidence_records',
  'intervention_capability_declarations',
];
