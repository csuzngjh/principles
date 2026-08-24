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
    expect(result.stateReasonCode).toBe('state_db_missing');
    expect(result.nextActionCode).toBe('run_config_doctor');
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
    expect(result.stateReasonCode).toBe('no_pipeline_activity');
    expect(result.nextActionCode).toBe('wait_for_pipeline');
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
    expect(result.stateReasonCode).toBe('consumed_candidates');
    expect(result.nextActionCode).toBe('wait_for_pipeline');
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
    expect(result.stateReasonCode).toBe('pipeline_active');
    expect(result.nextActionCode).toBe('check_pipeline_status');
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
    expect(result.stateReasonCode).toBe('pending_approvals');
    expect(result.nextActionCode).toBe('review_approvals');
    expect(result.stateReason).toContain('1');
    expect(result.nextAction).toBeDefined();
  });

  it('validated artifacts alone do NOT trigger owner_review_ready (P1-2)', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    // No pending approval — all approved
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr-approved-1', 'artifact-approved', 'prompt', 'low', 'approved', '${now}')
    `);

    // Validated artifact exists — but this should NOT trigger owner_review_ready
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, content_json, validation_status, created_at, updated_at)
      VALUES ('artifact-validated', 'candidate', 'task-1', '{}', 'validated', '${now}', '${now}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    // P1-2: validatedArtifactCount is too broad; only pendingReviewCount > 0
    // determines owner_review_ready. The owner-actionable queue read model
    // (PRI-330) will refine this.
    expect(result.governanceState).not.toBe('owner_review_ready');
    expect(result.pendingReviewCount).toBe(0);
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
    expect(result.stateReasonCode).toBe('degraded_state');
    expect(result.nextActionCode).toBe('check_degraded_signals');
    expect(result.degradedSignals).toBeDefined();
    expect(result.degradedSignals!.length).toBeGreaterThan(0);
    expect(result.degradedSignals![0].reasonCode).toBe('task_retry_wait');
    expect(result.degradedSignals![0].nextActionCode).toBe('check_task_status');
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
    expect(result.degradedSignals![0].reasonCode).toBe('task_failed');
    expect(result.degradedSignals![0].nextActionCode).toBe('fix_and_retry');
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

// ── PRI-556: degraded time window + bounded summary ──────────────────────────

describe('GovernanceConsoleModel — PRI-556 degraded time window', () => {
  it('8-day-old failed/retry_wait tasks do NOT trigger degraded (historical pollution fix)', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES
        ('task-old-failed', 'artificer', 'failed', '${eightDaysAgo}', '${eightDaysAgo}', 3, 'output_invalid'),
        ('task-old-retry', 'dreamer', 'retry_wait', '${eightDaysAgo}', '${eightDaysAgo}', 1, 'timeout')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    // Historical rows still count as pipeline activity, but not as degradation.
    expect(result.governanceState).toBe('in_progress');
    expect(result.degradedSignals).toBeUndefined();
  });

  it('a 2-day-old failed task still triggers degraded', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('task-fresh-failed', 'artificer', 'failed', '${twoDaysAgo}', '${twoDaysAgo}', 3, 'input_invalid')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    expect(result.degradedSignals).toBeDefined();
    expect(result.degradedSignals!.length).toBe(1);
    expect(result.degradedSignals![0].reasonCode).toBe('task_failed');
    expect(result.degradedSignals![0].reason).toContain('1 internalization failures require attention');
    expect(result.degradedSignals![0].failureSummary?.count).toBe(1);
    expect(result.degradedSignals![0].failureSummary?.details.length).toBe(1);
  });

  it('pending approvals take priority over a recent failure (owner_review_ready first)', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr-pri-556', 'artifact-pri-556', 'prompt', 'low', 'pending', '${now}')
    `);
    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('task-fresh-failed-2', 'artificer', 'failed', '${twoDaysAgo}', '${twoDaysAgo}', 3, 'input_invalid')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('owner_review_ready');
    expect(result.pendingReviewCount).toBe(1);
    // degraded signal still reported alongside the owner-ready state
    expect(result.degradedSignals).toBeDefined();
    expect(result.degradedSignals!.some((s) => s.reasonCode === 'task_failed')).toBe(true);
  });

  it('many recent failures produce a bounded structured summary, not an overlong string', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const values: string[] = [];
    for (let i = 0; i < 20; i++) {
      values.push(`('task-many-${i}', 'artificer', 'failed', '${twoDaysAgo}', '${twoDaysAgo}', 3, 'input_invalid')`);
    }
    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ${values.join(', ')}
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    const failedSignal = result.degradedSignals!.find((s) => s.reasonCode === 'task_failed');
    expect(failedSignal).toBeDefined();
    // Bounded summary: count + at most 5 details + overflow marker — never the
    // unbounded "kind: error; kind: error; …" concatenation of all 20 rows.
    expect(failedSignal!.reason.length).toBeLessThan(1000);
    expect(failedSignal!.reason).toContain('20 internalization failures require attention');
    expect(failedSignal!.reason).toContain('+15 more');
    expect(failedSignal!.failureSummary?.count).toBe(20);
    expect(failedSignal!.failureSummary?.details.length).toBe(5);
    expect(failedSignal!.failureSummary?.details[0].kind).toBe('artificer');
    expect(failedSignal!.failureSummary?.details[0].taskId.length).toBeLessThanOrEqual(12);
    expect(failedSignal!.failureSummary?.details[0].reason).toBe('input_invalid');
  });

  it('window applies to retry_wait as well: old failed + fresh retry_wait yields only the retry signal', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES
        ('task-old-failed-2', 'artificer', 'failed', '${eightDaysAgo}', '${eightDaysAgo}', 3, 'output_invalid'),
        ('task-fresh-retry', 'dreamer', 'retry_wait', '${twoDaysAgo}', '${twoDaysAgo}', 1, 'timeout')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    expect(result.degradedSignals!.length).toBe(1);
    expect(result.degradedSignals![0].reasonCode).toBe('task_retry_wait');
    expect(result.degradedSignals![0].failureSummary?.count).toBe(1);
  });

  it('short ids stay distinguishable when tasks share the same channel suffix (UUID head preferred over tail slice)', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // Three distinct tasks whose ids differ ONLY in the UUID token and share
    // the identical repeated channel suffix — a tail slice would give all
    // three the same short code ("mpt-prompt"), defeating attribution.
    const uuids = [
      'aaaaaaaa-1111-2222-3333-444444444444',
      'bbbbbbbb-1111-2222-3333-444444444444',
      'cccccccc-1111-2222-3333-444444444444',
    ];
    const values = uuids.map(
      (uuid) => `('artificer-scribe-philosopher-dreamer-${uuid}-prompt-prompt-prompt', 'artificer', 'failed', '${twoDaysAgo}', '${twoDaysAgo}', 3, 'input_invalid')`,
    );
    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ${values.join(', ')}
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    const failedSignal = result.degradedSignals!.find((s) => s.reasonCode === 'task_failed');
    expect(failedSignal).toBeDefined();
    const shortIds = failedSignal!.failureSummary!.details.map((d) => d.taskId);
    // ERR-088: assert exact values AND set distinctness — a length-only
    // assertion passes for any truncation scheme, including the broken one.
    expect(shortIds).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    expect(new Set(shortIds).size).toBe(shortIds.length);
  });

  it('task ids without a UUID token fall back to the tail slice without throwing', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('rulehost-manual_1781970379703_kklqs19g-artificer-r1-mqmj8yaa', 'evaluator', 'failed', '${twoDaysAgo}', '${twoDaysAgo}', 3, 'input_invalid')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    const failedSignal = result.degradedSignals!.find((s) => s.reasonCode === 'task_failed');
    expect(failedSignal).toBeDefined();
    const detail = failedSignal!.failureSummary!.details[0];
    // No canonical UUID token in this id shape → tail-slice fallback (last 12 chars).
    expect(detail.taskId).toBe('-r1-mqmj8yaa');
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

// ── Governance Recovery Actions v1 Phase 0: needs_human_review signal fix ─────

describe('GovernanceConsoleModel — needs_human_review owner-attention signal (recovery v1)', () => {
  it('rollout_reviewer needs_human_review task enters the queue (AC-6)', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count)
      VALUES ('task-rollout-1', 'rollout_reviewer', 'needs_human_review', '${now}', '${now}', 2)
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    // Previously: no stage's needs_human_review task reached this queue, and
    // rollout_reviewer was missing from the kind list entirely (both fixed).
    expect(result.pendingHumanReviewCount).toBe(1);
    expect(result.pendingReviewCount).toBe(0);
    expect(result.governanceState).toBe('owner_review_ready');
    expect(result.stateReasonCode).toBe('tasks_need_human_review');
    expect(result.nextActionCode).toBe('review_failed_tasks');
    expect(result.stateReason).toContain('1');
  });

  it('counts needs_human_review across all peer-runner kinds without a time window', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count)
      VALUES
        ('task-eval-1', 'evaluator', 'needs_human_review', '${now}', '${now}', 1),
        ('task-dreamer-1', 'dreamer', 'needs_human_review', '${thirtyDaysAgo}', '${thirtyDaysAgo}', 1),
        ('task-rollout-1', 'rollout_reviewer', 'needs_human_review', '${thirtyDaysAgo}', '${thirtyDaysAgo}', 2)
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    // Owner-attention items persist until the owner acts — no PRI-556 window
    expect(result.pendingHumanReviewCount).toBe(3);
    expect(result.governanceState).toBe('owner_review_ready');
    expect(result.stateReasonCode).toBe('tasks_need_human_review');
  });

  it('pending approvals still take priority over needs_human_review tasks', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count)
      VALUES ('task-rollout-1', 'rollout_reviewer', 'needs_human_review', '${now}', '${now}', 2)
    `);
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr-1', 'artifact-1', 'prompt', 'low', 'pending', '${now}')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(1);
    expect(result.pendingHumanReviewCount).toBe(1);
    expect(result.stateReasonCode).toBe('pending_approvals');
    expect(result.governanceState).toBe('owner_review_ready');
  });

  it('rollout_reviewer failed task now produces a degraded signal (kind list fix)', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, last_error)
      VALUES ('task-rollout-2', 'rollout_reviewer', 'failed', '${now}', '${now}', 1, 'rollout_dispatch_refused')
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.governanceState).toBe('degraded');
    expect(result.degradedSignals).toBeDefined();
    const signal = result.degradedSignals?.find(s => s.reasonCode === 'task_failed');
    expect(signal).toBeDefined();
    expect(signal?.failureSummary?.details[0]?.kind).toBe('rollout_reviewer');
  });

  it('non-peer-runner kinds (e.g. diagnostician) do not enter the needs_human_review count', async () => {
    const conn = createTestDb();
    const db = conn.getDb();
    const now = new Date().toISOString();

    db.exec(`
      INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count)
      VALUES ('task-diag-1', 'diagnostician', 'needs_human_review', '${now}', '${now}', 1)
    `);

    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingHumanReviewCount).toBeUndefined();
    // diagnostician is not a peer-runner kind: it neither enters the
    // human-review count nor counts as internalization pipeline activity
    // (pre-existing semantics of the kind-scoped activity query)
    expect(result.governanceState).toBe('none');
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
