/**
 * Migration: Initialize central.db (aggregated multi-workspace) tables
 */

import type { Migration } from '../migration-runner.js';

export const migration: Migration = {
  id: '001',
  name: 'init-central',
  db: 'central.db',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      last_sync TEXT
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS workspace_config (
      workspace_name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS global_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_sessions (
      session_id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON aggregated_sessions(workspace)`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER,
      error_type TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON aggregated_tool_calls(workspace)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON aggregated_tool_calls(outcome)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON aggregated_tool_calls(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_pain_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      score REAL NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pain_workspace ON aggregated_pain_events(workspace)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pain_created ON aggregated_pain_events(created_at)`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_user_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      correction_cue TEXT,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_principle_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      principle_id TEXT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_thinking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      matched_pattern TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thinking_workspace ON aggregated_thinking_events(workspace)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_thinking_model ON aggregated_thinking_events(model_id)`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_correction_samples (
      sample_id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      bad_assistant_turn_id INTEGER NOT NULL,
      quality_score REAL,
      review_status TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_corrections_workspace ON aggregated_correction_samples(workspace)`);

    db.exec(`CREATE TABLE IF NOT EXISTS aggregated_task_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      records_synced INTEGER NOT NULL
    )`);
  },
};
