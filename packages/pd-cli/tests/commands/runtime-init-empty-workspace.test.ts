/**
 * runtime-init empty-workspace integration tests — verifies real DB initialization.
 *
 * Does NOT mock the DB layer. Uses real better-sqlite3 to create actual database
 * files in a temp workspace, then verifies all expected tables exist.
 *
 * Covers:
 *   - EMPTY-01: initialize empty workspace → all 3 DBs have full schema
 *   - EMPTY-02: idempotency — running twice does not error or lose data
 *
 * Prerequisites: @principles/core and principles-disciple must be built.
 *
 * ERR refs:
 * - rc-7-loop-state-freshness: idempotency test uses fresh workspace each run
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { buildRuntimeInitOutput } from '../../src/commands/runtime-init.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-init-empty-'));
}

function rmTmpDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function getTableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];
    return rows.map(r => r.name);
  } finally {
    db.close();
  }
}

function getIndexNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];
    return rows.map(r => r.name);
  } finally {
    db.close();
  }
}

// ── Expected schema ─────────────────────────────────────────────────────────

const EXPECTED_STATE_TABLES = [
  'tasks', 'runs', 'artifacts', 'commits',
  'principle_candidates', 'pi_artifacts',
  'approvals', 'activations', 'intent_decisions',
  'schema_version',
];

const EXPECTED_TRAJECTORY_TABLES = [
  'schema_version', 'ingest_checkpoint', 'sessions', 'assistant_turns',
  'user_turns', 'tool_calls', 'pain_events', 'gate_blocks', 'trust_changes',
  'principle_events', 'task_outcomes', 'correction_samples', 'sample_reviews',
  'exports_audit', 'evolution_tasks', 'evolution_events',
];

const EXPECTED_WORKFLOW_TABLES = [
  'schema_version', 'subagent_workflows', 'subagent_workflow_events',
];

const EXPECTED_TRAJECTORY_INDEXES = [
  'idx_assistant_turns_session_id',
  'idx_assistant_turns_created_at',
  'idx_assistant_turns_provider_model',
  'idx_user_turns_session_id',
  'idx_tool_calls_session_id',
  'idx_tool_calls_created_at',
  'idx_pain_events_session_id',
  'idx_pain_events_canonical_pain_id',
  'idx_correction_samples_review_status',
  'idx_evolution_tasks_trace_id',
  'idx_evolution_tasks_status',
  'idx_evolution_tasks_created_at',
  'idx_evolution_events_trace_id',
  'idx_evolution_events_created_at',
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('pd runtime init — empty workspace integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  // ── EMPTY-01: initialize empty workspace ───────────────────────────────────

  describe('EMPTY-01: initialize empty workspace', () => {
    it('returns ok=true with 3 initialized databases', () => {
      const output = buildRuntimeInitOutput(tmpDir, true);
      expect(output.ok).toBe(true);
      expect(output.mode).toBe('confirm');
      expect(output.databases).toHaveLength(3);
      for (const db of output.databases) {
        expect(db.status).toBe('initialized');
      }
    });

    it('creates state.db with all expected tables', () => {
      buildRuntimeInitOutput(tmpDir, true);
      const stateDbPath = path.join(tmpDir, '.pd', 'state.db');
      expect(fs.existsSync(stateDbPath)).toBe(true);
      const tables = getTableNames(stateDbPath);
      for (const expected of EXPECTED_STATE_TABLES) {
        expect(tables).toContain(expected);
      }
    });

    it('creates trajectory.db with all 16 expected tables', () => {
      buildRuntimeInitOutput(tmpDir, true);
      const trajDbPath = path.join(tmpDir, '.state', 'trajectory.db');
      expect(fs.existsSync(trajDbPath)).toBe(true);
      const tables = getTableNames(trajDbPath);
      expect(tables).toHaveLength(EXPECTED_TRAJECTORY_TABLES.length);
      for (const expected of EXPECTED_TRAJECTORY_TABLES) {
        expect(tables).toContain(expected);
      }
    });

    it('creates trajectory.db with all expected indexes', () => {
      buildRuntimeInitOutput(tmpDir, true);
      const trajDbPath = path.join(tmpDir, '.state', 'trajectory.db');
      const indexes = getIndexNames(trajDbPath);
      for (const expected of EXPECTED_TRAJECTORY_INDEXES) {
        expect(indexes).toContain(expected);
      }
    });

    it('creates subagent_workflows.db with all expected tables', () => {
      buildRuntimeInitOutput(tmpDir, true);
      const wfDbPath = path.join(tmpDir, '.state', 'subagent_workflows.db');
      expect(fs.existsSync(wfDbPath)).toBe(true);
      const tables = getTableNames(wfDbPath);
      for (const expected of EXPECTED_WORKFLOW_TABLES) {
        expect(tables).toContain(expected);
      }
    });

    it('pain_events table has canonical_pain_id and runtime_task_id columns', () => {
      buildRuntimeInitOutput(tmpDir, true);
      const trajDbPath = path.join(tmpDir, '.state', 'trajectory.db');
      const db = new Database(trajDbPath, { readonly: true });
      try {
        const cols = db.prepare('PRAGMA table_info(pain_events)').all() as { name: string }[];
        const colNames = cols.map(c => c.name);
        expect(colNames).toContain('canonical_pain_id');
        expect(colNames).toContain('runtime_task_id');
        expect(colNames).toContain('text');
      } finally {
        db.close();
      }
    });

    it('evolution_tasks table has V2 migration columns', () => {
      buildRuntimeInitOutput(tmpDir, true);
      const trajDbPath = path.join(tmpDir, '.state', 'trajectory.db');
      const db = new Database(trajDbPath, { readonly: true });
      try {
        const cols = db.prepare('PRAGMA table_info(evolution_tasks)').all() as { name: string }[];
        const colNames = cols.map(c => c.name);
        expect(colNames).toContain('task_kind');
        expect(colNames).toContain('priority');
        expect(colNames).toContain('retry_count');
        expect(colNames).toContain('max_retries');
        expect(colNames).toContain('last_error');
        expect(colNames).toContain('result_ref');
      } finally {
        db.close();
      }
    });
  });

  // ── EMPTY-02: idempotency ──────────────────────────────────────────────────

  describe('EMPTY-02: idempotency', () => {
    it('running twice does not error and tables remain intact', () => {
      // First initialization
      const output1 = buildRuntimeInitOutput(tmpDir, true);
      expect(output1.ok).toBe(true);

      // Capture table counts after first init
      const trajDbPath = path.join(tmpDir, '.state', 'trajectory.db');
      const tables1 = getTableNames(trajDbPath);

      // Second initialization (should be idempotent)
      const output2 = buildRuntimeInitOutput(tmpDir, true);
      expect(output2.ok).toBe(true);
      expect(output2.databases).toHaveLength(3);
      for (const db of output2.databases) {
        expect(db.status).toBe('initialized');
      }

      // Table set should be unchanged
      const tables2 = getTableNames(trajDbPath);
      expect(tables2).toEqual(tables1);
    });

    it('dry-run after confirm does not modify existing DBs', () => {
      // First: confirm mode (real init)
      buildRuntimeInitOutput(tmpDir, true);
      const trajDbPath = path.join(tmpDir, '.state', 'trajectory.db');
      const tablesBefore = getTableNames(trajDbPath);

      // Second: dry-run mode (should not modify)
      const output = buildRuntimeInitOutput(tmpDir, false);
      expect(output.mode).toBe('dry-run');

      const tablesAfter = getTableNames(trajDbPath);
      expect(tablesAfter).toEqual(tablesBefore);
    });
  });
});
