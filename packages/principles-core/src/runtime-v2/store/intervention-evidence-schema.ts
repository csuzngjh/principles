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
 *   - Records are append-only. A narrowly guarded UPDATE can only remove
 *     bounded sensitive payload text at expiry; DELETE and every identity,
 *     lineage, digest and provenance rewrite remain blocked.
 *   - Idempotency anchor: UNIQUE(source_kind, source_locator, observation_key)
 *     plus record_digest — replaying the same source is a no-op; a different
 *     payload under the same key is a reported source conflict, never an
 *     overwrite.
 *   - The capability matrix is declarative adapter state (latest declaration
 *     wins per host × capability), not observed fact history.
 */
import { RECEIPT_RETENTION_POLICY_DAYS } from '../receipt-coverage.js';

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
    content_redacted_at TEXT,
    UNIQUE (source_kind, source_locator, observation_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_ier_principle_time ON intervention_evidence_records(principle_id, recorded_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_ier_activation ON intervention_evidence_records(activation_id)',
  'CREATE INDEX IF NOT EXISTS idx_ier_episode ON intervention_evidence_records(episode_key)',
  'CREATE INDEX IF NOT EXISTS idx_ier_effect ON intervention_evidence_records(effect_key)',
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

/** Reinstalled after the additive column migration on every writable open. */
export const INTERVENTION_EVIDENCE_IMMUTABILITY_STATEMENTS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS intervention_evidence_records_no_update
    BEFORE UPDATE ON intervention_evidence_records
    WHEN NOT (
      ((OLD.content_redacted_at IS NULL AND NEW.content_redacted_at IS NOT NULL) OR
       (OLD.content_redacted_at IS NOT NULL AND NEW.content_redacted_at IS OLD.content_redacted_at
        AND OLD.correction_reason IS NOT NULL AND OLD.correction_reason <> '[expired]' AND NEW.correction_reason = '[expired]'))
      AND julianday(CASE WHEN OLD.occurred_at IS NOT NULL AND OLD.occurred_at < OLD.recorded_at THEN OLD.occurred_at ELSE OLD.recorded_at END) <= julianday('now', CASE WHEN OLD.source_kind IN ('codex_pd_hook_event_log', 'codex_governance_observation') THEN '-7 days' ELSE '-${RECEIPT_RETENTION_POLICY_DAYS} days' END)
      AND NEW.evidence_id IS OLD.evidence_id
      AND NEW.scope_id IS OLD.scope_id
      AND NEW.source_kind IS OLD.source_kind
      AND NEW.observation_key IS OLD.observation_key
      AND NEW.source_locator IS OLD.source_locator
      AND NEW.record_kind IS OLD.record_kind
      AND NEW.principle_id IS OLD.principle_id
      AND NEW.activation_id IS OLD.activation_id
      AND NEW.delivery_key IS OLD.delivery_key
      AND NEW.episode_key IS OLD.episode_key
      AND NEW.effect_key IS OLD.effect_key
      AND NEW.correction_of IS OLD.correction_of
      AND (NEW.correction_reason IS OLD.correction_reason OR
           (OLD.correction_reason IS NOT NULL AND NEW.correction_reason = '[expired]'))
      AND NEW.occurred_at IS OLD.occurred_at
      AND NEW.recorded_at IS OLD.recorded_at
      AND NEW.native_refs_json IS OLD.native_refs_json
      AND NEW.content_ref_json IS OLD.content_ref_json
      AND NEW.activation_ref_json IS OLD.activation_ref_json
      AND NEW.record_digest IS OLD.record_digest
      AND json(NEW.payload_json) = CASE OLD.record_kind
        WHEN 'delivery' THEN json_remove(OLD.payload_json, '$.failureReason', '$.nonAttemptReason', '$.unsupportedNote')
        WHEN 'application' THEN json_remove(OLD.payload_json, '$.claimText')
        WHEN 'behavior_episode' THEN json_set(json_remove(OLD.payload_json, '$.inputPreview', '$.resultSummary'), '$.actionSummary', '[expired]')
        WHEN 'effect' THEN json_set(json_remove(OLD.payload_json, '$.disputeReason'), '$.observationSummary', '[expired]')
        WHEN 'outcome' THEN json_remove(json_set(OLD.payload_json, '$.observationSummary', '[expired]'), '$.feedbackText', '$.actorId')
        ELSE NULL
      END
      AND (json(NEW.payload_json) <> json(OLD.payload_json) OR NEW.correction_reason IS NOT OLD.correction_reason)
    )
    BEGIN
      SELECT RAISE(ABORT, 'intervention evidence records are immutable except authorized evidence text redaction');
    END`,
  `CREATE TRIGGER IF NOT EXISTS intervention_evidence_records_no_delete
    BEFORE DELETE ON intervention_evidence_records
    BEGIN
      SELECT RAISE(ABORT, 'intervention evidence records are immutable');
    END`,
];

/** Tables this feature owns inside state.db (existence precheck for reads). */
export const INTERVENTION_EVIDENCE_TABLES: readonly string[] = [
  'intervention_evidence_scope',
  'intervention_evidence_records',
  'intervention_capability_declarations',
];
