/**
 * Migration: Initialize workflow.db (subagent workflow tracking) tables
 */

import type { Migration } from '../migration-runner.js';

export const migration: Migration = {
  id: '001',
  name: 'init-workflow',
  db: 'workflow.db',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS subagent_workflows (
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
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_parent_session ON subagent_workflows(parent_session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_child_session ON subagent_workflows(child_session_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_state ON subagent_workflows(state)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_workflows_type ON subagent_workflows(workflow_type)`);

    db.exec(`CREATE TABLE IF NOT EXISTS subagent_workflow_events (
      workflow_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_workflow ON subagent_workflow_events(workflow_id)`);

    db.exec(`CREATE TABLE IF NOT EXISTS subagent_workflow_stage_outputs (
      workflow_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('dreamer', 'philosopher')),
      output_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stage_outputs_workflow ON subagent_workflow_stage_outputs(workflow_id)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_outputs_idempotency ON subagent_workflow_stage_outputs(idempotency_key)`);
  },
};
