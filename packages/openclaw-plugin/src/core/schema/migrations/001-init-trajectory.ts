/**
 * Migration: Initialize trajectory.db tables
 * This creates all core event store tables.
 */

import type { Migration } from '../migration-runner.js';

export const migration: Migration = {
  id: '001',
  name: 'init-trajectory',
  db: 'trajectory.db',
  up(db) {
    // Core tables
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS assistant_turns (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_assistant_turns_session_id ON assistant_turns(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_assistant_turns_created_at ON assistant_turns(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS user_turns (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_user_turns_session_id ON user_turns(session_id)`);

    db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS pain_events (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pain_events_session_id ON pain_events(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pain_events_created_at ON pain_events(created_at)`);

    // FTS5
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS pain_events_fts USING fts5(
      text,
      pain_event_id UNINDEXED,
      tokenize='porter unicode61'
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS gate_blocks (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_blocks_created_at ON gate_blocks(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS trust_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      previous_score REAL NOT NULL,
      new_score REAL NOT NULL,
      delta REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS principle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      principle_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS task_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      task_id TEXT,
      outcome TEXT NOT NULL,
      summary TEXT,
      principle_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS correction_samples (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_correction_samples_review_status ON correction_samples(review_status)`);

    db.exec(`CREATE TABLE IF NOT EXISTS sample_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id TEXT NOT NULL,
      review_status TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS exports_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      export_kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      approved_only INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS evolution_tasks (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_tasks_trace_id ON evolution_tasks(trace_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_tasks_status ON evolution_tasks(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_tasks_created_at ON evolution_tasks(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS evolution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      task_id TEXT,
      stage TEXT NOT NULL,
      level TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      summary TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_events_trace_id ON evolution_events(trace_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evolution_events_created_at ON evolution_events(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS ingest_checkpoint (
      source_key TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    )`);
  },
};
