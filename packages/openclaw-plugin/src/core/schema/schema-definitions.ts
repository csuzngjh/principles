/**
 * Schema Registry — Central source of truth for all database schemas.
 *
 * All table, view, and index definitions live here. No more scattered
 * CREATE TABLE statements across multiple database classes.
 *
 * Each definition is keyed by `${dbName}.${name}` for uniqueness.
 */

import type { Db } from './db-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DbType = 'trajectory.db' | 'central.db' | 'workflow.db';

export interface TableDefinition {
  ddl: string;
  indexes?: string[];
}

export interface ViewDefinition {
  ddl: string;
}

export interface FtsDefinition {
  ddl: string;
}

export interface Migration {
  /** Unique ID, e.g. '001' */
  id: string;
  /** Human-readable name, e.g. 'init-trajectory' */
  name: string;
  /** Which database file this migration applies to */
  db: DbType;
  /** Apply this migration */
  up: (db: Db) => void;
  /** Revert this migration */
  down?: (db: Db) => void;
}

export interface SchemaCatalog {
  tables: Record<string, TableDefinition>;
  views: Record<string, ViewDefinition>;
  fts: Record<string, FtsDefinition>;
}

// ---------------------------------------------------------------------------
// Schema Definitions — ALL tables across ALL databases
// ---------------------------------------------------------------------------

/**
 * All schema definitions organized by database file.
 * Key format: `${dbName}.${tableName}`
 */
export const SCHEMAS: Record<DbType, SchemaCatalog> = {

  // ========================================================================
  // trajectory.db — Main event store
  // ========================================================================
  'trajectory.db': {
    tables: {
      'trajectory.schema_version': {
        ddl: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
      },
      'trajectory.ingest_checkpoint': {
        ddl: `CREATE TABLE IF NOT EXISTS ingest_checkpoint (
          source_key TEXT PRIMARY KEY,
          imported_at TEXT NOT NULL
        )`,
      },
      'trajectory.sessions': {
        ddl: `CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'trajectory.assistant_turns': {
        ddl: `CREATE TABLE IF NOT EXISTS assistant_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          raw_text TEXT,
          sanitized_text TEXT NOT NULL,
          usage_json TEXT NOT NULL,
          empathy_signal_json TEXT NOT NULL,
          blob_ref TEXT,
          raw_excerpt TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_assistant_turns_session_id ON assistant_turns(session_id)`,
          `CREATE INDEX IF NOT EXISTS idx_assistant_turns_created_at ON assistant_turns(created_at)`,
          `CREATE INDEX IF NOT EXISTS idx_assistant_turns_provider_model ON assistant_turns(provider, model)`,
        ],
      },
      'trajectory.user_turns': {
        ddl: `CREATE TABLE IF NOT EXISTS user_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          raw_text TEXT,
          blob_ref TEXT,
          raw_excerpt TEXT,
          correction_detected INTEGER NOT NULL DEFAULT 0,
          correction_cue TEXT,
          references_assistant_turn_id INTEGER,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_user_turns_session_id ON user_turns(session_id)`,
        ],
      },
      'trajectory.tool_calls': {
        ddl: `CREATE TABLE IF NOT EXISTS tool_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          outcome TEXT NOT NULL,
          duration_ms INTEGER,
          exit_code INTEGER,
          error_type TEXT,
          error_message TEXT,
          gfi_before REAL,
          gfi_after REAL,
          params_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)`,
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at)`,
        ],
      },
      'trajectory.pain_events': {
        ddl: `CREATE TABLE IF NOT EXISTS pain_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          source TEXT NOT NULL,
          score REAL NOT NULL,
          reason TEXT,
          severity TEXT,
          origin TEXT,
          confidence REAL,
          text TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_pain_events_session_id ON pain_events(session_id)`,
          `CREATE INDEX IF NOT EXISTS idx_pain_events_created_at ON pain_events(created_at)`,
        ],
      },
      'trajectory.gate_blocks': {
        ddl: `CREATE TABLE IF NOT EXISTS gate_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          tool_name TEXT NOT NULL,
          file_path TEXT,
          reason TEXT NOT NULL,
          plan_status TEXT,
          gfi REAL,
          gfi_after REAL,
          trust_stage INTEGER,
          gate_type TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_gate_blocks_created_at ON gate_blocks(created_at)`,
        ],
      },
      'trajectory.trust_changes': {
        ddl: `CREATE TABLE IF NOT EXISTS trust_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          previous_score REAL NOT NULL,
          new_score REAL NOT NULL,
          delta REAL NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'trajectory.principle_events': {
        ddl: `CREATE TABLE IF NOT EXISTS principle_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          principle_id TEXT,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'trajectory.task_outcomes': {
        ddl: `CREATE TABLE IF NOT EXISTS task_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          task_id TEXT,
          outcome TEXT NOT NULL,
          summary TEXT,
          principle_ids_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'trajectory.correction_samples': {
        ddl: `CREATE TABLE IF NOT EXISTS correction_samples (
          sample_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          bad_assistant_turn_id INTEGER NOT NULL,
          user_correction_turn_id INTEGER NOT NULL,
          recovery_tool_span_json TEXT NOT NULL,
          diff_excerpt TEXT NOT NULL,
          principle_ids_json TEXT NOT NULL,
          quality_score REAL NOT NULL,
          review_status TEXT NOT NULL,
          export_mode TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_correction_samples_review_status ON correction_samples(review_status)`,
        ],
      },
      'trajectory.sample_reviews': {
        ddl: `CREATE TABLE IF NOT EXISTS sample_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sample_id TEXT NOT NULL,
          review_status TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'trajectory.exports_audit': {
        ddl: `CREATE TABLE IF NOT EXISTS exports_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          export_kind TEXT NOT NULL,
          mode TEXT NOT NULL,
          approved_only INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'trajectory.evolution_tasks': {
        ddl: `CREATE TABLE IF NOT EXISTS evolution_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT UNIQUE NOT NULL,
          trace_id TEXT NOT NULL,
          source TEXT NOT NULL,
          reason TEXT,
          score INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          enqueued_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          resolution TEXT,
          task_kind TEXT,
          priority TEXT,
          retry_count INTEGER,
          max_retries INTEGER,
          last_error TEXT,
          result_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_evolution_tasks_trace_id ON evolution_tasks(trace_id)`,
          `CREATE INDEX IF NOT EXISTS idx_evolution_tasks_status ON evolution_tasks(status)`,
          `CREATE INDEX IF NOT EXISTS idx_evolution_tasks_created_at ON evolution_tasks(created_at)`,
        ],
      },
      'trajectory.evolution_events': {
        ddl: `CREATE TABLE IF NOT EXISTS evolution_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trace_id TEXT NOT NULL,
          task_id TEXT,
          stage TEXT NOT NULL,
          level TEXT DEFAULT 'info',
          message TEXT NOT NULL,
          summary TEXT,
          metadata_json TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_evolution_events_trace_id ON evolution_events(trace_id)`,
          `CREATE INDEX IF NOT EXISTS idx_evolution_events_created_at ON evolution_events(created_at)`,
        ],
      },
      'trajectory.thinking_model_events': {
        ddl: `CREATE TABLE IF NOT EXISTS thinking_model_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          assistant_turn_id INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          matched_pattern TEXT NOT NULL,
          scenario_json TEXT NOT NULL,
          tool_context_json TEXT NOT NULL,
          pain_context_json TEXT NOT NULL,
          principle_context_json TEXT NOT NULL,
          trigger_excerpt TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_thinking_model_events_model_created ON thinking_model_events(model_id, created_at)`,
          `CREATE INDEX IF NOT EXISTS idx_thinking_model_events_session_created ON thinking_model_events(session_id, created_at)`,
          `CREATE INDEX IF NOT EXISTS idx_thinking_model_events_assistant_turn ON thinking_model_events(assistant_turn_id)`,
          `CREATE INDEX IF NOT EXISTS idx_thinking_model_events_run_id ON thinking_model_events(run_id)`,
        ],
      },
      'trajectory.gfi_state': {
        ddl: `CREATE TABLE IF NOT EXISTS gfi_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          current_gfi REAL NOT NULL DEFAULT 0,
          daily_gfi_peak REAL NOT NULL DEFAULT 0,
          gfi_date TEXT NOT NULL DEFAULT ''
        )`,
        indexes: [],
      },
    },
    views: {
      'trajectory.v_error_clusters': {
        ddl: `CREATE VIEW IF NOT EXISTS v_error_clusters AS
          SELECT tool_name, COALESCE(error_type, 'unknown') AS error_type, COUNT(*) AS occurrences
          FROM tool_calls WHERE outcome = 'failure'
          GROUP BY tool_name, COALESCE(error_type, 'unknown')
          ORDER BY occurrences DESC`,
      },
      'trajectory.v_principle_effectiveness': {
        ddl: `CREATE VIEW IF NOT EXISTS v_principle_effectiveness AS
          SELECT event_type, COUNT(*) AS total FROM principle_events
          GROUP BY event_type ORDER BY total DESC`,
      },
      'trajectory.v_sample_queue': {
        ddl: `CREATE VIEW IF NOT EXISTS v_sample_queue AS
          SELECT review_status, COUNT(*) AS total FROM correction_samples
          GROUP BY review_status`,
      },
      'trajectory.v_daily_metrics': {
        ddl: `CREATE VIEW IF NOT EXISTS v_daily_metrics AS
          WITH tool_daily AS (
            SELECT date(created_at) AS day, COUNT(*) AS toolCalls,
                   SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
            FROM tool_calls GROUP BY date(created_at)
          ),
          pain_daily AS (
            SELECT date(created_at) AS day, COUNT(*) AS painEvents
            FROM pain_events GROUP BY date(created_at)
          ),
          corrections_daily AS (
            SELECT date(created_at) AS day, COUNT(*) AS userCorrections
            FROM correction_samples GROUP BY date(created_at)
          ),
          thinking_daily AS (
            SELECT date(created_at) AS day, COUNT(*) AS thinkingTurns
            FROM thinking_model_events GROUP BY date(created_at)
          )
          SELECT
            COALESCE(t.day, p.day, c.day, th.day) AS day,
            COALESCE(t.toolCalls, 0) AS toolCalls,
            COALESCE(t.failures, 0) AS failures,
            COALESCE(p.painEvents, 0) AS painEvents,
            COALESCE(c.userCorrections, 0) AS userCorrections,
            COALESCE(th.thinkingTurns, 0) AS thinkingTurns
          FROM tool_daily t
          FULL OUTER JOIN pain_daily p ON t.day = p.day
          FULL OUTER JOIN corrections_daily c ON COALESCE(t.day, p.day) = c.day
          FULL OUTER JOIN thinking_daily th ON COALESCE(COALESCE(t.day, p.day), c.day) = th.day
          ORDER BY day ASC`,
      },
      'trajectory.v_thinking_model_usage': {
        ddl: `CREATE VIEW IF NOT EXISTS v_thinking_model_usage AS
          SELECT
            model_id,
            COUNT(*) AS hits,
            COUNT(DISTINCT session_id) AS distinctSessions,
            COUNT(DISTINCT assistant_turn_id) AS distinctTurns,
            CAST(COUNT(DISTINCT session_id) AS REAL) /
              NULLIF((SELECT COUNT(DISTINCT session_id) FROM thinking_model_events), 0) AS coverageRate
          FROM thinking_model_events GROUP BY model_id`,
      },
      'trajectory.v_thinking_model_effectiveness': {
        ddl: `CREATE VIEW IF NOT EXISTS v_thinking_model_effectiveness AS
          SELECT tme.model_id, tme.id AS event_id,
            COUNT(DISTINCT tc.id) AS toolCallsAfter,
            SUM(CASE WHEN tc.outcome = 'success' THEN 1 ELSE 0 END) AS successes,
            SUM(CASE WHEN tc.outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
            COUNT(DISTINCT pe.id) AS painEventsAfter
          FROM thinking_model_events tme
          LEFT JOIN tool_calls tc ON tc.session_id = tme.session_id AND tc.created_at > tme.created_at
          LEFT JOIN pain_events pe ON pe.session_id = tme.session_id AND pe.created_at > tme.created_at
          GROUP BY tme.model_id, tme.id`,
      },
      'trajectory.v_thinking_model_scenarios': {
        ddl: `CREATE VIEW IF NOT EXISTS v_thinking_model_scenarios AS
          SELECT tme.model_id, json_each.value AS scenario, COUNT(*) AS hits
          FROM thinking_model_events tme, json_each(tme.scenario_json)
          GROUP BY tme.model_id, json_each.value`,
      },
      'trajectory.v_thinking_model_daily_trend': {
        ddl: `CREATE VIEW IF NOT EXISTS v_thinking_model_daily_trend AS
          SELECT date(created_at) AS day, model_id, COUNT(*) AS hits
          FROM thinking_model_events GROUP BY date(created_at), model_id ORDER BY day ASC`,
      },
    },
    fts: {
      'trajectory.pain_events_fts': {
        ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS pain_events_fts USING fts5(
          text,
          pain_event_id UNINDEXED,
          tokenize='porter unicode61'
        )`,
      },
    },
  },

  // ========================================================================
  // central.db — Aggregated multi-workspace data
  // ========================================================================
  'central.db': {
    tables: {
      'central.schema_version': {
        ddl: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
      },
      'central.workspaces': {
        ddl: `CREATE TABLE IF NOT EXISTS workspaces (
          name TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          last_sync TEXT
        )`,
      },
      'central.workspace_config': {
        ddl: `CREATE TABLE IF NOT EXISTS workspace_config (
          workspace_name TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 1,
          display_name TEXT,
          sync_enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      },
      'central.global_config': {
        ddl: `CREATE TABLE IF NOT EXISTS global_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      },
      'central.aggregated_sessions': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_sessions (
          session_id TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON aggregated_sessions(workspace)`,
        ],
      },
      'central.aggregated_tool_calls': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_tool_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          outcome TEXT NOT NULL,
          duration_ms INTEGER,
          error_type TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON aggregated_tool_calls(workspace)`,
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON aggregated_tool_calls(outcome)`,
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON aggregated_tool_calls(created_at)`,
        ],
      },
      'central.aggregated_pain_events': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_pain_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          source TEXT NOT NULL,
          score REAL NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_pain_workspace ON aggregated_pain_events(workspace)`,
          `CREATE INDEX IF NOT EXISTS idx_pain_created ON aggregated_pain_events(created_at)`,
        ],
      },
      'central.aggregated_user_corrections': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_user_corrections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          correction_cue TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'central.aggregated_principle_events': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_principle_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          principle_id TEXT,
          event_type TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'central.aggregated_thinking_events': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_thinking_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          matched_pattern TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_thinking_workspace ON aggregated_thinking_events(workspace)`,
          `CREATE INDEX IF NOT EXISTS idx_thinking_model ON aggregated_thinking_events(model_id)`,
        ],
      },
      'central.aggregated_correction_samples': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_correction_samples (
          sample_id TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          bad_assistant_turn_id INTEGER NOT NULL,
          quality_score REAL,
          review_status TEXT,
          created_at TEXT NOT NULL
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_corrections_workspace ON aggregated_correction_samples(workspace)`,
        ],
      },
      'central.aggregated_task_outcomes': {
        ddl: `CREATE TABLE IF NOT EXISTS aggregated_task_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          task_id TEXT,
          outcome TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`,
        indexes: [],
      },
      'central.sync_log': {
        ddl: `CREATE TABLE IF NOT EXISTS sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace TEXT NOT NULL,
          synced_at TEXT NOT NULL,
          records_synced INTEGER NOT NULL
        )`,
        indexes: [],
      },
    },
    views: {},
    fts: {},
  },

  // ========================================================================
  // workflow.db — Subagent workflow tracking
  // ========================================================================
  'workflow.db': {
    tables: {
      'workflow.schema_version': {
        ddl: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`,
      },
      'workflow.subagent_workflows': {
        ddl: `CREATE TABLE IF NOT EXISTS subagent_workflows (
          workflow_id TEXT PRIMARY KEY,
          workflow_type TEXT NOT NULL,
          transport TEXT NOT NULL,
          parent_session_id TEXT NOT NULL,
          child_session_key TEXT NOT NULL,
          run_id TEXT,
          state TEXT NOT NULL DEFAULT 'pending',
          cleanup_state TEXT NOT NULL DEFAULT 'none',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_observed_at INTEGER,
          duration_ms INTEGER,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_workflows_parent_session ON subagent_workflows(parent_session_id)`,
          `CREATE INDEX IF NOT EXISTS idx_workflows_child_session ON subagent_workflows(child_session_key)`,
          `CREATE INDEX IF NOT EXISTS idx_workflows_state ON subagent_workflows(state)`,
          `CREATE INDEX IF NOT EXISTS idx_workflows_type ON subagent_workflows(workflow_type)`,
        ],
      },
      'workflow.subagent_workflow_events': {
        ddl: `CREATE TABLE IF NOT EXISTS subagent_workflow_events (
          workflow_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          reason TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_events_workflow ON subagent_workflow_events(workflow_id)`,
        ],
      },
      'workflow.subagent_workflow_stage_outputs': {
        ddl: `CREATE TABLE IF NOT EXISTS subagent_workflow_stage_outputs (
          workflow_id TEXT NOT NULL,
          stage TEXT NOT NULL CHECK (stage IN ('dreamer', 'philosopher')),
          output_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
        )`,
        indexes: [
          `CREATE INDEX IF NOT EXISTS idx_stage_outputs_workflow ON subagent_workflow_stage_outputs(workflow_id)`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_outputs_idempotency ON subagent_workflow_stage_outputs(idempotency_key)`,
        ],
      },
    },
    views: {},
    fts: {},
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all schema definitions for a specific database */
export function getCatalog(db: DbType): SchemaCatalog {
  return SCHEMAS[db];
}

/** Get all database types */
export const DB_TYPES: DbType[] = ['trajectory.db', 'central.db', 'workflow.db'];
