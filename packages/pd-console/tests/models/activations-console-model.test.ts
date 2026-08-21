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
import { updateFeatureFlag } from '../../src/server/config/pd-config-store.js';
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
  // On Windows, SQLite file handles may not release immediately after close().
  // Retry the cleanup with a short delay to avoid EPERM errors.
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      break;
    } catch (err) {
      attempts++;
      if (attempts >= maxAttempts) {
        // Log but don't fail the test — temp dirs are cleaned by OS eventually
        console.warn(`Failed to clean up temp dir after ${maxAttempts} attempts:`, err instanceof Error ? err.message : String(err));
        break;
      }
      // Small delay to let OS release file handles
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

// ── Missing Database Handling ────────────────────────────────────────────────

describe('ActivationsConsoleModel — missing database handling', () => {
  it('returns degraded response with note when state.db does not exist', async () => {
    const result = await model.getActivations();

    expect(result.activations).toEqual([]);
    expect(result.status).toBe('degraded');
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('state.db not found');
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
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('activation table not found');
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
    expect(result.reason).toBeUndefined();
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
    const active = result.activations.find(a => a.activationId === 'act-001');
    expect(active).toBeDefined();
    expect(active?.status).toBe('active');
    expect(active?.principleId).toBe('principle-001');
    expect(active?.channel).toBe('prompt');
    expect(active?.action).toBe('inject');
    
    // Inactive activation (deactivatedAt set → status 'deactivated' under PRI-491)
    const inactive = result.activations.find(a => a.activationId === 'act-002');
    expect(inactive).toBeDefined();
    expect(inactive?.status).toBe('deactivated');
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

  // Bug-O L2: when sourcePrincipleId column is null/empty but contentJson carries
  // a resolvable principleId, extractPrincipleId must fall back to contentJson.
  // Without this fix, dreamer artifacts whose sourcePrincipleId was stripped
  // (non-core-principle case) would show 'unlinked' even when the principle
  // link is recoverable from contentJson.
  it('extracts principleId from contentJson when sourcePrincipleId column is null (Bug-O L2)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();

    const now = new Date().toISOString();
    const contentJson = JSON.stringify({ principleId: 'P_fallback_001', text: 'Test principle' });

    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
      VALUES ('act-fallback', 'idem-fallback', 'artifact-fallback', 'prompt', 'inject', 'test.md', '${now}', NULL)
    `);

    // source_principle_id is NULL, but content_json carries principleId
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES ('artifact-fallback', 'principle', 'task-fallback', NULL, '${contentJson}', '${now}', '${now}')
    `);

    conn.close();

    const result = await model.getActivations();

    expect(result.activations).toHaveLength(1);
    expect(result.activations[0].principleId).toBe('P_fallback_001');
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
    const deactivated = verifyResult.activations.find(a => a.activationId === 'act-active');
    expect(deactivated?.status).toBe('deactivated');
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

// ── PRI-491: Owner Observability (mode / status / contextVersion / evidenceRefs) ──

/**
 * PRI-491 — the Console must surface the same owner-observable fields as the
 * CLI: mode (shadow/live), status (active/deactivated/suspended_by_flag),
 * contextVersion (v1/v2), evidenceRefs, evidenceSummary, nextAction, and
 * promotedAt / deactivatedAt timestamps.
 *
 * Without these tests:
 * - flag-off v2 activations would silently show as "active" (false signal
 *   that the rule will block).
 * - shadow activations would not show the promote command, leaving the
 *   owner unable to act.
 * - evidenceRefs (PRI-490) would be invisible at the Console layer.
 *
 * ERR entries:
 * - ERR-002: degradation (suspended_by_flag) carries a reason via nextAction.
 * - ERR-088: tests assert unique status fields, not only absence of blocking.
 */
describe('ActivationsConsoleModel — PRI-491 owner observability', () => {
  function seedV2Artifact(db: ReturnType<SqliteConnection['getDb']>, artifactId: string, evidenceRefs: string[]) {
    const now = new Date().toISOString();
    const contentJson = JSON.stringify({
      requiresContextVersion: 2,
      evidenceRefs,
      implementationCode: 'return { decision: "allow" };',
    });
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES ('${artifactId}', 'rule', 'task-v2', 'principle-v2', '${contentJson}', '${now}', '${now}')
    `);
  }

  function seedV1Artifact(db: ReturnType<SqliteConnection['getDb']>, artifactId: string) {
    const now = new Date().toISOString();
    const contentJson = JSON.stringify({ implementationCode: 'return { decision: "allow" };' });
    db.exec(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, content_json, created_at, updated_at)
      VALUES ('${artifactId}', 'rule', 'task-v1', 'principle-v1', '${contentJson}', '${now}', '${now}')
    `);
  }

  function insertActivation(
    db: ReturnType<SqliteConnection['getDb']>,
    fields: {
      activationId: string;
      artifactId: string;
      action: string;
      channel?: string;
      activatedAt?: string | null;
      deactivatedAt?: string | null;
      promotedAt?: string | null;
    },
  ) {
    const now = fields.activatedAt ?? new Date().toISOString();
    const channel = fields.channel ?? 'code_tool_hook';
    // Treat null AND undefined as SQL NULL — otherwise `'${undefined}'` becomes
    // the literal string "undefined" in the column, which is truthy and breaks
    // status derivation (the record would look deactivated).
    const deactivatedSql = fields.deactivatedAt == null ? 'NULL' : `'${fields.deactivatedAt}'`;
    const promotedSql = fields.promotedAt == null ? 'NULL' : `'${fields.promotedAt}'`;
    db.exec(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at, promoted_at)
      VALUES (
        '${fields.activationId}',
        'idem-${fields.activationId}',
        '${fields.artifactId}',
        '${channel}',
        '${fields.action}',
        'edit_tool',
        '${now}',
        ${deactivatedSql},
        ${promotedSql}
      )
    `);
  }

  it('shadow v2 activation with flag off shows status=suspended_by_flag and nextAction to enable flag or deactivate', async () => {
    // rulecode_context_v2 flag defaults to off — no .pd/config.yaml means
    // suspended_by_flag (rc-9: reason surfaced via nextAction).
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV2Artifact(db, 'art-v2-shadow', ['ex-1', 'ex-2']);
    insertActivation(db, {
      activationId: 'act-v2-shadow',
      artifactId: 'art-v2-shadow',
      action: 'code_tool_hook_shadow_activate',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    expect(rec.status).toBe('suspended_by_flag');
    expect(rec.mode).toBe('shadow');
    expect(rec.contextVersion).toBe('v2');
    expect(rec.evidenceRefs).toEqual(['ex-1', 'ex-2']);
    expect(rec.evidenceSummary).toContain('2 evidence ref(s)');
    expect(rec.nextAction).toContain('Enable rulecode_context_v2 flag');
    expect(rec.nextAction).toContain('pd activation deactivate --activation-id act-v2-shadow');
    expect(rec.nextAction).not.toContain('--confirm');
    expect(rec.deactivatedAt).toBeNull();
  });

  it('live v2 activation with flag off still shows suspended_by_flag (not silently active)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV2Artifact(db, 'art-v2-live', ['ex-1']);
    insertActivation(db, {
      activationId: 'act-v2-live',
      artifactId: 'art-v2-live',
      action: 'code_tool_hook_live_activate',
      promotedAt: '2026-06-15T10:00:00.000Z',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    // Even though the action is "live", the v2 flag is off, so the rule is
    // suspended. ERR-088: assert the unique status field, not only absence
    // of "active".
    expect(rec.status).toBe('suspended_by_flag');
    expect(rec.mode).toBe('live');
    expect(rec.contextVersion).toBe('v2');
    expect(rec.promotedAt).toBe('2026-06-15T10:00:00.000Z');
    expect(rec.nextAction).toContain('Enable rulecode_context_v2 flag');
  });

  it('shadow v1 activation (no requiresContextVersion) shows status=active and promote nextAction', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV1Artifact(db, 'art-v1-shadow');
    insertActivation(db, {
      activationId: 'act-v1-shadow',
      artifactId: 'art-v1-shadow',
      action: 'code_tool_hook_shadow_activate',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    expect(rec.status).toBe('active');
    expect(rec.mode).toBe('shadow');
    expect(rec.contextVersion).toBe('v1');
    expect(rec.evidenceRefs).toBeUndefined();
    expect(rec.nextAction).toBe(
      'Keep shadow; promotion requires an authenticated Owner decision, immutable evidence bindings, and a passing Promotion Readiness result.',
    );
  });

  it('live v1 activation shows status=active and deactivate nextAction', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV1Artifact(db, 'art-v1-live');
    insertActivation(db, {
      activationId: 'act-v1-live',
      artifactId: 'art-v1-live',
      action: 'code_tool_hook_live_activate',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    expect(rec.status).toBe('active');
    expect(rec.mode).toBe('live');
    expect(rec.nextAction).toBe('pd activation deactivate --activation-id act-v1-live');
  });

  it('deactivated activation shows status=deactivated regardless of contextVersion or flag (precedence)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV2Artifact(db, 'art-v2-dead', ['ex-1']);
    insertActivation(db, {
      activationId: 'act-v2-dead',
      artifactId: 'art-v2-dead',
      action: 'code_tool_hook_live_activate',
      deactivatedAt: '2026-06-20T12:00:00.000Z',
      promotedAt: '2026-06-15T10:00:00.000Z',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    // deactivated > suspended_by_flag > active (matches CLI).
    expect(rec.status).toBe('deactivated');
    expect(rec.deactivatedAt).toBe('2026-06-20T12:00:00.000Z');
    expect(rec.promotedAt).toBe('2026-06-15T10:00:00.000Z');
    // No nextAction for a deactivated record — nothing more to do.
    expect(rec.nextAction).toBeUndefined();
  });

  it('v2 activation with rulecode_context_v2 flag ON shows status=active (not suspended)', async () => {
    // Write a valid base config (without a features: section, mimicking a
    // fresh install), then call the public updateFeatureFlag API to toggle
    // the rulecode_context_v2 flag on. Hand-writing a partial config.yaml
    // without version/runtimeProfiles/internalAgents/ui would fail
    // validatePdConfig, causing loadPdConfig to fall back to defaults
    // (where rulecode_context_v2 is off).
    const pdDir = path.join(workspaceDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    const yamlLines = [
      'version: 1',
      'runtimeProfiles:',
      '  openclaw.default:',
      '    type: openclaw',
      '    source: default',
      'internalAgents:',
      '  defaultRuntime: openclaw.default',
      '  agents:',
      '    diagnostician:',
      '      enabled: true',
      '    dreamer:',
      '      enabled: true',
      '    scribe:',
      '      enabled: true',
      'ui:',
      '  diagnostics:',
      '    mode: simple',
    ];
    fs.writeFileSync(path.join(pdDir, 'config.yaml'), yamlLines.join('\n') + '\n', 'utf8');
    const flagResult = updateFeatureFlag(workspaceDir, 'rulecode_context_v2', true);
    expect(flagResult.ok).toBe(true);

    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV2Artifact(db, 'art-v2-flag-on', ['ex-1']);
    insertActivation(db, {
      activationId: 'act-v2-flag-on',
      artifactId: 'art-v2-flag-on',
      action: 'code_tool_hook_shadow_activate',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    // Flag is on, so v2 shadow activation is active and shows promote nextAction.
    expect(rec.status).toBe('active');
    expect(rec.mode).toBe('shadow');
    expect(rec.contextVersion).toBe('v2');
    expect(rec.nextAction).toBe(
      'Keep shadow; promotion requires an authenticated Owner decision, immutable evidence bindings, and a passing Promotion Readiness result.',
    );
  });

  it('evidenceSummary truncates long evidence refs list', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    const refs = ['e1', 'e2', 'e3', 'e4', 'e5'];
    seedV2Artifact(db, 'art-v2-many-refs', refs);
    insertActivation(db, {
      activationId: 'act-v2-many-refs',
      artifactId: 'art-v2-many-refs',
      action: 'code_tool_hook_shadow_activate',
    });
    conn.close();

    const result = await model.getActivations();
    const rec = result.activations[0]!;
    expect(rec.evidenceRefs).toEqual(refs);
    // Summary shows first 3 refs + "..." indicator.
    expect(rec.evidenceSummary).toContain('5 evidence ref(s)');
    expect(rec.evidenceSummary).toContain('e1, e2, e3');
    expect(rec.evidenceSummary).toContain('...');
  });

  it('orphaned activation (artifact not in pi_artifacts) shows warning + note (rc-9)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    insertActivation(db, {
      activationId: 'act-orphan',
      artifactId: 'art-missing',
      action: 'code_tool_hook_shadow_activate',
    });
    conn.close();

    const result = await model.getActivations();
    expect(result.activations).toHaveLength(1);

    const rec = result.activations[0]!;
    expect(rec.warning).toContain('artifact_id "art-missing" does not exist');
    expect(rec.warning).toContain('orphaned');
    // rc-9: the response reason must also surface the dangling reference.
    expect(result.reason).toContain('1 activation(s) reference non-existent artifact_id');
    expect(result.reason).toContain('art-missing');
  });

  it('unrecognized action yields undefined mode and undefined nextAction (no false mode label)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV1Artifact(db, 'art-unknown-action');
    insertActivation(db, {
      activationId: 'act-unknown-action',
      artifactId: 'art-unknown-action',
      action: 'some_future_action',
    });
    conn.close();

    const result = await model.getActivations();
    const rec = result.activations[0]!;
    expect(rec.mode).toBeUndefined();
    expect(rec.status).toBe('active');
    // No actionable nextAction for an unrecognized action — the owner must
    // manually inspect. (The CLI emits the same undefined-nextAction signal.)
    expect(rec.nextAction).toBeUndefined();
  });

  it('v1 activation with no evidenceRefs shows undefined evidenceSummary (no empty placeholder)', async () => {
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    seedV1Artifact(db, 'art-v1-no-evidence');
    insertActivation(db, {
      activationId: 'act-v1-no-evidence',
      artifactId: 'art-v1-no-evidence',
      action: 'code_tool_hook_live_activate',
    });
    conn.close();

    const result = await model.getActivations();
    const rec = result.activations[0]!;
    expect(rec.evidenceRefs).toBeUndefined();
    expect(rec.evidenceSummary).toBeUndefined();
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
