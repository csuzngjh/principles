/**
 * GovernanceConsoleModel Tests — PRI-CR3
 *
 * Tests for the governance queue data model:
 * - Returns graceful degraded response when state.db missing
 * - Returns graceful degraded response when approval table missing
 * - Computes pendingReviewCount correctly
 * - Computes behaviorDeviationCount (high/critical risk)
 * - Computes stagnationSignals for approvals older than 7 days
 * - Handles artifact → principleId mapping
 *
 * ERR entries:
 * - ERR-002: Graceful degradation includes reason (note field)
 * - ERR-001/005: No `as` bypasses on untrusted data
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GovernanceConsoleModel } from '../../src/server/models/GovernanceConsoleModel.js';
import { SqliteConnection } from '@principles/core/runtime-v2';

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let workspaceDir: string;
let model: GovernanceConsoleModel;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-governance-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  model = new GovernanceConsoleModel(workspaceDir);
});

afterEach(() => {
  model.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Missing Database Handling ────────────────────────────────────────────────

describe('GovernanceConsoleModel — missing database handling', () => {
  it('returns degraded response with note when state.db does not exist', async () => {
    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(0);
    expect(result.behaviorDeviationCount).toBe(0);
    expect(result.stagnationSignals).toEqual([]);
    expect(result.note).toBeDefined();
    expect(result.note).toContain('state.db not found');
    expect(result.generatedAt).toBeDefined();
  });

  it('returns degraded response with note when approval table missing', async () => {
    // Create .pd/state.db but without approval table
    const pdDir = path.join(workspaceDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    const stateDbPath = path.join(pdDir, 'state.db');
    
    // Use SqliteConnection to create a properly initialized database
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    // Drop the approvals table to simulate missing table scenario
    db.exec('DROP TABLE IF EXISTS approvals');
    conn.close();

    const result = await model.getGovernanceQueue();

    expect(result.pendingReviewCount).toBe(0);
    expect(result.behaviorDeviationCount).toBe(0);
    expect(result.stagnationSignals).toEqual([]);
    expect(result.note).toBeDefined();
    expect(result.note).toContain('approval queue table not found');
  });
});

// ── Data Computation ─────────────────────────────────────────────────────────

describe('GovernanceConsoleModel — data computation', () => {
  it('computes pendingReviewCount from pending approvals', async () => {
    // Use SqliteConnection to create a properly initialized database
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    // Insert pending approvals
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES 
        ('apr_test_artifact-001', 'artifact-001', 'prompt', 'low', 'pending', '${now}')
    `);
    
    conn.close();

    const result = await model.getGovernanceQueue();
    expect(result.pendingReviewCount).toBe(1);
    expect(result.behaviorDeviationCount).toBe(0);
    expect(result.stagnationSignals).toEqual([]);
    // No note when tables exist with data
    expect(result.note).toBeUndefined();
  });

  it('computes behaviorDeviationCount for high/critical risk approvals', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    // Insert pending approvals with different risk levels
    const now = new Date().toISOString();
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES 
        ('apr_prompt_artifact-1', 'artifact-1', 'prompt', 'low', 'pending', '${now}'),
        ('apr_prompt_artifact-2', 'artifact-2', 'prompt', 'high', 'pending', '${now}'),
        ('apr_prompt_artifact-3', 'artifact-3', 'prompt', 'critical', 'pending', '${now}'),
        ('apr_prompt_artifact-4', 'artifact-4', 'prompt', 'medium', 'pending', '${now}')
    `);
    
    // Insert pi_artifacts for principleId mapping
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
    
    // 4 pending approvals total
    expect(result.pendingReviewCount).toBe(4);
    // 2 high/critical risk (artifact-2 and artifact-3)
    expect(result.behaviorDeviationCount).toBe(2);
    // No stagnation (all recent)
    expect(result.stagnationSignals).toHaveLength(0);
  });

  it('computes stagnationSignals for approvals older than 7 days', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    // Create dates: one recent, one 10 days ago, one 30 days ago
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
    
    // 3 pending approvals total
    expect(result.pendingReviewCount).toBe(3);
    // 2 stagnation signals (10 days and 30 days ago)
    expect(result.stagnationSignals).toHaveLength(2);
    
    // Check stagnation signal structure
    const tenDaySignal = result.stagnationSignals.find(s => s.principleId === 'principle-10d');
    expect(tenDaySignal).toBeDefined();
    expect(tenDaySignal?.type).toBe('never_activated');
    expect(tenDaySignal?.daysSince).toBeGreaterThanOrEqual(10);
    
    const thirtyDaySignal = result.stagnationSignals.find(s => s.principleId === 'principle-30d');
    expect(thirtyDaySignal).toBeDefined();
    expect(thirtyDaySignal?.daysSince).toBeGreaterThanOrEqual(30);
  });

  it('handles unlinked artifacts (missing principleId)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    
    db.exec(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, requested_at)
      VALUES ('apr_prompt_artifact-unlinked', 'artifact-unlinked', 'prompt', 'low', 'pending', '${tenDaysAgo}')
    `);
    
    // No pi_artifacts record for this approval
    conn.close();

    const result = await model.getGovernanceQueue();
    
    expect(result.stagnationSignals).toHaveLength(1);
    expect(result.stagnationSignals[0].principleId).toBe('unlinked');
  });
});

// ── Disposal ─────────────────────────────────────────────────────────────────

describe('GovernanceConsoleModel — disposal', () => {
  it('dispose() closes connection without error', async () => {
    // Create database to force connection
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    conn.getDb();
    conn.close();

    await model.getGovernanceQueue();
    model.dispose();
    
    // Second dispose should not throw
    model.dispose();
  });
});