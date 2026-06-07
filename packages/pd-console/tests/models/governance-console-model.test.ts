/**
 * GovernanceConsoleModel Tests — PRI-329
 *
 * Extended governance state tests:
 * - `none`: state.db not found or empty workspace
 * - `in_progress`: pipeline activity but no owner-ready items
 * - `owner_review_ready`: pending approval or validated artifact
 * - `degraded`: retry_wait / failed task or broken chain
 *
 * ERR entries:
 * - ERR-001/005: No `as` bypasses on untrusted data
 * - ERR-002: Degradation includes reason + nextAction
 * - ERR-009: Required array elements fail loud
 * - ERR-025: Tests cover real production path (getGovernanceQueue)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GovernanceConsoleModel } from '../../src/server/models/GovernanceConsoleModel.js';
import { SqliteConnection } from '@principles/core/runtime-v2';

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let workspaceDir: string;
let model: GovernanceConsoleModel;

/** Real schemas extracted from production state.db */
function createTestDb(): SqliteConnection {
  const conn = new SqliteConnection({ workspaceDir, readonly: false });
  const db = conn.getDb();

  // Disable FK enforcement for test isolation — we only test the read model
  db.pragma('foreign_keys = OFF');

  // tasks table — matches production schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      input_ref TEXT,
      result_ref TEXT,
      diagnostic_json TEXT
    )
  `);

  // pi_artifacts table — matches production schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS pi_artifacts (
      artifact_id TEXT PRIMARY KEY,
      artifact_kind TEXT NOT NULL,
      source_task_id TEXT NOT NULL,
      source_principle_id TEXT,
      source_rule_id TEXT,
      lineage_artifact_ids TEXT NOT NULL DEFAULT '[]',
      validation_status TEXT NOT NULL DEFAULT 'pending',
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // principle_candidates table — matches production schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS principle_candidates (
      candidate_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      confidence REAL,
      source_recommendation_json TEXT,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      recommendation_kind TEXT NOT NULL DEFAULT 'principle',
      trigger_pattern TEXT,
      action TEXT,
      abstracted_principle TEXT
    )
  `);

  // approvals table — matches production schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      confidence REAL,
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      decision_note TEXT,
      rejection_reason TEXT,
      summary TEXT,
      trigger_reason TEXT,
      confidence_explanation TEXT,
      effect_description TEXT,
      rejection_effect TEXT
    )
  `);

  return conn;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  model = new GovernanceConsoleModel(workspaceDir);
});

afterEach(() => {
  model.dispose();
  // Small delay to release file handles on Windows
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore EPERM on Windows — cleanup is best-effort in tests
  }
});

// ── State: none ──────────────────────────────────────────────────────────────

describe('GovernanceConsoleModel — state: none', () => {
  it('returns governanceState=none when state.db does not exist', async () => {
    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(0);
    expect(result.governanceState).toBe('none');
    expect(result.stateReason).toBeDefined();
    expect(result.stateReason.length).toBeGreaterThan(0);
    expect(result.nextAction).toBeDefined();
    expect(result.nextAction.length).toBeGreaterThan(0);
    expect(result.note).toBeDefined();
    expect(result.note).toContain('state.db not found');
  });

  it('returns governanceState=none when state.db has no pipeline activity', async () => {
    const conn = createTestDb();
    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('none');
    expect(result.pendingReviewCount).toBe(0);
    expect(result.behaviorDeviationCount).toBe(0);
  });
});

// ── State: in_progress ───────────────────────────────────────────────────────

describe('GovernanceConsoleModel — state: in_progress', () => {
  it('returns governanceState=in_progress when consumed candidates exist', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, status, created_at, consumed_at, recommendation_kind)
      VALUES ('candidate-1', 'artifact-1', 'task-1', 'run-1', 'Test candidate', 'Test description', 'idem-1', 'consumed', '${now}', '${now}', 'principle')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(0);
    expect(result.governanceState).toBe('in_progress');
    expect(result.stateReason).toBeDefined();
    expect(result.nextAction).toBeDefined();
    expect(result.inProgressSummary).toBeDefined();
  });

  it('returns governanceState=in_progress when internalization tasks exist', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count)
      VALUES ('task-dreamer-1', 'dreamer', 'succeeded', '${now}', '${now}', 1)
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(0);
    expect(result.governanceState).toBe('in_progress');
    expect(result.stateReason).toBeDefined();
    expect(result.inProgressSummary).toBeDefined();
  });
});

// ── State: owner_review_ready ────────────────────────────────────────────────

describe('GovernanceConsoleModel — state: owner_review_ready', () => {
  it('returns governanceState=owner_review_ready when pending approvals exist', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr-test-1', 'artifact-1', 'prompt', 'low', 'pending', '${now}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(1);
    expect(result.governanceState).toBe('owner_review_ready');
    expect(result.stateReason).toBeDefined();
    expect(result.stateReason).toContain('1');
    expect(result.nextAction).toBeDefined();
  });

  it('returns governanceState=owner_review_ready when validated artifacts exist', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    // No pending approval — all approved
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr-approved-1', 'artifact-approved', 'prompt', 'low', 'approved', '${now}')
    `);

    // But validated artifact exists
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, content_json, validation_status, created_at, updated_at)
      VALUES ('artifact-validated', 'candidate', 'task-1', '{}', 'validated', '${now}', '${now}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('owner_review_ready');
    expect(result.stateReason).toBeDefined();
    expect(result.nextAction).toBeDefined();
  });
});

// ── State: degraded ──────────────────────────────────────────────────────────

describe('GovernanceConsoleModel — state: degraded', () => {
  it('returns governanceState=degraded when retry_wait tasks exist', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('task-1', 'dreamer', 'retry_wait', '${now}', '${now}', 2, 'LLM output invalid')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    expect(result.degradedSignals).toBeDefined();
    expect(result.degradedSignals!.length).toBeGreaterThan(0);
    expect(result.degradedSignals![0].reason).toBeDefined();
    expect(result.degradedSignals![0].nextAction).toBeDefined();
    expect(result.degradedSignals![0].source).toBeDefined();
    expect(result.stateReason).toBeDefined();
    expect(result.nextAction).toBeDefined();
  });

  it('returns governanceState=degraded when failed tasks exist', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('task-failed-1', 'philosopher', 'failed', '${now}', '${now}', 3, 'Max retries exceeded')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    expect(result.degradedSignals).toBeDefined();
    expect(result.degradedSignals!.length).toBe(1);
    expect(result.degradedSignals![0].source).toBe('internalization_task');
  });
});

// ── Priority: owner_review_ready takes priority over degraded ────────────────

describe('GovernanceConsoleModel — state priority', () => {
  it('priority order: owner_review_ready > degraded > in_progress > none', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    // Both pending approval and retry_wait exist
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr-test-1', 'artifact-1', 'prompt', 'low', 'pending', '${now}')
    `);
    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('task-retry-1', 'dreamer', 'retry_wait', '${now}', '${now}', 2, 'Timeout')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    // owner_review_ready takes priority over degraded
    expect(result.governanceState).toBe('owner_review_ready');
    expect(result.pendingReviewCount).toBe(1);
    // degraded signals still reported alongside owner_review_ready
    expect(result.degradedSignals).toBeDefined();
    expect(result.degradedSignals!.length).toBeGreaterThan(0);
  });
});

// ── Data Computation ─────────────────────────────────────────────────────────

describe('GovernanceConsoleModel — data computation', () => {
  it('computes pendingReviewCount from pending approvals', async () => {
    const conn = createTestDb();
    const db = conn.getDb();

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr_test_artifact-001', 'artifact-001', 'prompt', 'low', 'pending', '${now}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();
    expect(result.pendingReviewCount).toBe(1);
    expect(result.behaviorDeviationCount).toBe(0);
    expect(result.stagnationSignals).toEqual([]);
  });

  it('computes behaviorDeviationCount for high/critical risk approvals', async () => {
    const conn = createTestDb();
    const db = conn.getDb();

    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES
        ('apr_prompt_artifact-1', 'artifact-1', 'prompt', 'low', 'pending', '${now}'),
        ('apr_prompt_artifact-2', 'artifact-2', 'prompt', 'high', 'pending', '${now}'),
        ('apr_prompt_artifact-3', 'artifact-3', 'prompt', 'critical', 'pending', '${now}'),
        ('apr_prompt_artifact-4', 'artifact-4', 'prompt', 'medium', 'pending', '${now}')
    `);

    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES
        ('artifact-1', 'test', 'task-1', 'principle-1', '{}', '${now}', '${now}'),
        ('artifact-2', 'test', 'task-2', 'principle-2', '{}', '${now}', '${now}'),
        ('artifact-3', 'test', 'task-3', 'principle-3', '{}', '${now}', '${now}'),
        ('artifact-4', 'test', 'task-4', 'principle-4', '{}', '${now}', '${now}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(4);
    expect(result.behaviorDeviationCount).toBe(2);
    expect(result.stagnationSignals).toHaveLength(0);
  });

  it('computes stagnationSignals for approvals older than 7 days', async () => {
    const conn = createTestDb();
    const db = conn.getDb();

    const recentDate = new Date().toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES
        ('apr_prompt_artifact-recent', 'artifact-recent', 'prompt', 'low', 'pending', '${recentDate}'),
        ('apr_prompt_artifact-10d', 'artifact-10d', 'prompt', 'low', 'pending', '${tenDaysAgo}'),
        ('apr_prompt_artifact-30d', 'artifact-30d', 'prompt', 'low', 'pending', '${thirtyDaysAgo}')
    `);

    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES
        ('artifact-recent', 'test', 'task-recent', 'principle-recent', '{}', '${recentDate}', '${recentDate}'),
        ('artifact-10d', 'test', 'task-10d', 'principle-10d', '{}', '${tenDaysAgo}', '${tenDaysAgo}'),
        ('artifact-30d', 'test', 'task-30d', 'principle-30d', '{}', '${thirtyDaysAgo}', '${thirtyDaysAgo}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(3);
    expect(result.stagnationSignals).toHaveLength(2);

    const tenDaySignal = result.stagnationSignals.find(s => s.principleId === 'principle-10d');
    expect(tenDaySignal).toBeDefined();
    expect(tenDaySignal?.type).toBe('never_activated');
    expect(tenDaySignal?.daysSince).toBeGreaterThanOrEqual(10);
  });
});

// ── Disposal ─────────────────────────────────────────────────────────────────

describe('GovernanceConsoleModel — disposal', () => {
  it('dispose() closes connection without error', async () => {
    const conn = createTestDb();
    conn.close();

    await model.getGovernanceQueue();
    model.dispose();

    // Second dispose should not throw
    model.dispose();
  });
});
