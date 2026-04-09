/**
 * Migration: Add thinking_model_events and gfi_state tables to trajectory.db
 *
 * These tables were added by separate classes (ControlUiDatabase, HealthQueryService)
 * after the initial trajectory schema. Consolidated here for unified management.
 */

import type { Migration } from '../migration-runner.js';

export const migration: Migration = {
  id: '002',
  name: 'add-thinking-and-gfi',
  db: 'trajectory.db',
  up(db) {
    // Thinking model events (originally from ControlUiDatabase)
    db.exec(`CREATE TABLE IF NOT EXISTS thinking_model_events (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thinking_model_events_model_created ON thinking_model_events(model_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thinking_model_events_session_created ON thinking_model_events(session_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thinking_model_events_assistant_turn ON thinking_model_events(assistant_turn_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thinking_model_events_run_id ON thinking_model_events(run_id)`);

    // GFI state (originally from HealthQueryService)
    db.exec(`CREATE TABLE IF NOT EXISTS gfi_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_gfi REAL NOT NULL DEFAULT 0,
      daily_gfi_peak REAL NOT NULL DEFAULT 0,
      gfi_date TEXT NOT NULL DEFAULT ''
    )`);

    // Views for thinking model analytics
    db.exec(`CREATE VIEW IF NOT EXISTS v_thinking_model_usage AS
      SELECT
        model_id,
        COUNT(*) AS hits,
        COUNT(DISTINCT session_id) AS distinctSessions,
        COUNT(DISTINCT assistant_turn_id) AS distinctTurns,
        CAST(COUNT(DISTINCT session_id) AS REAL) /
          NULLIF((SELECT COUNT(DISTINCT session_id) FROM thinking_model_events), 0) AS coverageRate
      FROM thinking_model_events GROUP BY model_id`);

    db.exec(`CREATE VIEW IF NOT EXISTS v_thinking_model_effectiveness AS
      SELECT tme.model_id, tme.id AS event_id,
        COUNT(DISTINCT tc.id) AS toolCallsAfter,
        SUM(CASE WHEN tc.outcome = 'success' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN tc.outcome = 'failure' THEN 1 ELSE 0 END) AS failures,
        COUNT(DISTINCT pe.id) AS painEventsAfter
      FROM thinking_model_events tme
      LEFT JOIN tool_calls tc ON tc.session_id = tme.session_id AND tc.created_at > tme.created_at
      LEFT JOIN pain_events pe ON pe.session_id = tme.session_id AND pe.created_at > tme.created_at
      GROUP BY tme.model_id, tme.id`);

    db.exec(`CREATE VIEW IF NOT EXISTS v_thinking_model_scenarios AS
      SELECT tme.model_id, json_each.value AS scenario, COUNT(*) AS hits
      FROM thinking_model_events tme, json_each(tme.scenario_json)
      GROUP BY tme.model_id, json_each.value`);

    db.exec(`CREATE VIEW IF NOT EXISTS v_thinking_model_daily_trend AS
      SELECT date(created_at) AS day, model_id, COUNT(*) AS hits
      FROM thinking_model_events GROUP BY date(created_at), model_id ORDER BY day ASC`);
  },
};
