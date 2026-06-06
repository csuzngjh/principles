/**
 * ActivationsConsoleModel Tests — PRI-CR6
 *
 * Tests for the activations data model:
 * - Returns graceful degraded response when state.db missing
 * - Returns graceful degraded response when activation table missing
 * - Maps activation records to principleId via artifact lookup
 * - Handles deactivateActivation operation
 * - Returns proper error for already inactive activation
 *
 * ERR entries:
 * - ERR-002: Graceful degradation includes reason (note field)
 * - ERR-001/005: No `as` bypasses on untrusted data
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ActivationsConsoleModel } from '../../src/server/models/ActivationsConsoleModel.js';
import { SqliteConnection } from '@principles/core/runtime-v2';

// ── Test Setup ───────────────────────────────────────────────────────────────

let tempDir: string;
let workspaceDir: string;
let model: ActivationsConsoleModel;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-activations-model-test-'));
  workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  model = new ActivationsConsoleModel(workspaceDir);
});

afterEach(() => {
  model.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Missing Database Handling ────────────────────────────────────────────────

describe('ActivationsConsoleModel — missing database handling', () => {
  it('returns degraded response with note when state.db does not exist', async () => {
    const result = await model.getActivations();

    expect(result.activations).toEqual([]);
    expect(result.generatedAt).toBeDefined();
    expect(result.note).toBeDefined();
    expect(result.note).toContain('state.db not found');
  });

  it('returns degraded response with note when activation table missing', async () => {
    // Create .pd/state.db but without activation table
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    // Drop the activations table to simulate missing table scenario
    db.exec('DROP TABLE IF EXISTS activations');
    conn.close();

    const result = await model.getActivations();

    expect(result.activations).toEqual([]);
    expect(result.note).toBeDefined();
    expect(result.note).toContain('activation table not found');
  });
});

// ── Data Computation ─────────────────────────────────────────────────────────

describe('ActivationsConsoleModel — data computation', () => {
  it('returns empty activations when tables exist but no records', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    conn.getDb();
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toEqual([]);
    expect(result.note).toBeUndefined();
  });

  it('maps activation records to principleId via artifact lookup', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    const now = new Date().toISOString();
    
    // Insert activations
    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES 
        ('act-001', 'idem-001', 'artifact-001', 'prompt', 'inject', 'THINKING_OS.md', '${now}', NULL),
        ('act-002', 'idem-002', 'artifact-002', 'code_tool_hook', 'inject', 'rule-host.ts', '${now}', '${now}')
    `);
    
    // Insert pi_artifacts for principleId mapping
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES 
        ('artifact-001', 'test', 'task-001', 'principle-001', '{}', '${now}', '${now}'),
        ('artifact-002', 'test', 'task-002', 'principle-002', '{}', '${now}', '${now}')
    `);
    
    conn.close();

    const result = await model.getActivations();
    
    expect(result.activations).toHaveLength(2);
    
    // Active activation
    const active = result.activations.find(a => a.id === 'act-001');
    expect(active).toBeDefined();
    expect(active?.status).toBe('active');
    expect(active?.principleId).toBe('principle-001');
    expect(active?.channel).toBe('prompt');
    expect(active?.action).toBe('inject');
    
    // Inactive activation
    const inactive = result.activations.find(a => a.id === 'act-002');
    expect(inactive).toBeDefined();
    expect(inactive?.status).toBe('inactive');
    expect(inactive?.principleId).toBe('principle-002');
  });

  it('handles unlinked artifacts (missing principleId)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    const now = new Date().toISOString();
    
    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('act-unlinked', 'idem-unlinked', 'artifact-unlinked', 'prompt', 'inject', 'test.md', '${now}', NULL)
    `);
    
    // No artifact record
    conn.close();

    const result = await model.getActivations();
    
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0].principleId).toBe('unlinked');
  });

  it('handles null activatedAt correctly', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    // Note: activated_at is NOT NULL in the schema, so this test verifies
    // that the model handles the case where activatedAt is properly set
    const now = new Date().toISOString();
    
    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('act-with-date', 'idem-with-date', 'artifact-001', 'prompt', 'inject', 'test.md', '${now}', NULL)
    `);
    
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES ('artifact-001', 'test', 'task-001', 'principle-001', '{}', '${now}', '${now}')
    `);
    
    conn.close();

    const result = await model.getActivations();
    
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0].activatedAt).toBe(now);
  });
});

// ── Deactivate Operation ─────────────────────────────────────────────────────

describe('ActivationsConsoleModel — deactivateActivation', () => {
  it('returns error when state.db does not exist', async () => {
    const result = await model.deactivateActivation('act-001');
    
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('state.db not found');
    expect(result.nextAction).toBeDefined();
  });

  it('returns error when activation not found or already inactive', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    const now = new Date().toISOString();
    
    // Insert an already inactive activation
    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('act-inactive', 'idem-inactive', 'artifact-001', 'prompt', 'inject', 'test.md', '${now}', '${now}')
    `);
    
    conn.close();

    // Try to deactivate already inactive
    const result = await model.deactivateActivation('act-inactive');
    
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found or already inactive');
    expect(result.nextAction).toContain('Refresh');
  });

  it('successfully deactivates an active activation', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    
    const now = new Date().toISOString();
    
    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('act-active', 'idem-active', 'artifact-001', 'prompt', 'inject', 'test.md', '${now}', NULL)
    `);
    
    conn.close();

    const result = await model.deactivateActivation('act-active');
    
    expect(result.ok).toBe(true);
    
    // Verify the activation is now inactive
    const verifyResult = await model.getActivations();
    const deactivated = verifyResult.activations.find(a => a.id === 'act-active');
    expect(deactivated?.status).toBe('inactive');
    expect(deactivated?.activatedAt).not.toBeNull();
  });

  it('returns error for non-existent activation ID', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    conn.getDb();
    conn.close();

    const result = await model.deactivateActivation('nonexistent-activation');
    
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found or already inactive');
  });
});

// ── Disposal ─────────────────────────────────────────────────────────────────

describe('ActivationsConsoleModel — disposal', () => {
  it('dispose() closes connections without error', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    conn.getDb();
    conn.close();

    await model.getActivations();
    model.dispose();
    
    // Second dispose should not throw
    model.dispose();
  });
});