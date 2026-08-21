import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime-v2';
import { observeRuleCodeSafety, resetRuleCodeSafetyCircuitsForTests } from '../../src/core/rulecode-safety-circuit.js';

let workspace: string | null = null;
afterEach(() => { resetRuleCodeSafetyCircuitsForTests(); if (workspace) rmSync(workspace, { recursive: true, force: true }); workspace = null; });

describe('production RuleCode safety circuit', () => {
  it('durably isolates a live rule and fails open when it matches the recovery control plane', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pd-circuit-'));
    const connection = new SqliteConnection({ workspaceDir: workspace, readonly: false }); const db = connection.getDb(); const now = '2026-08-21T00:00:00.000Z';
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-1', 'diagnosis', 'pending', ?, ?)").run(now, now);
    db.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-1', 'rule', 'task-1', '[]', 'validated', '{}', ?, ?)").run(now, now);
    await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'activation-1', idempotencyKey: 'source-1', artifactId: 'artifact-1', channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: 'impl://rule-1', activatedAt: now, promotedAt: now, deactivatedAt: null }); connection.close();
    expect(observeRuleCodeSafety({ workspaceDir: workspace, activationId: 'activation-1', toolName: 'bash', params: { command: 'pd activation deactivate --activation-id activation-1' }, decision: 'block', matched: true })).toBe(true);
    await Promise.resolve();
    const verify = new SqliteConnection({ workspaceDir: workspace, readonly: true });
    expect(verify.getDb().prepare("SELECT enforcement FROM activation_control_states WHERE activation_id = 'activation-1'").get()).toEqual({ enforcement: 'safety_isolated' });
    expect(verify.getDb().prepare("SELECT decision, principal_kind FROM activation_decisions WHERE activation_id = 'activation-1'").get()).toEqual({ decision: 'safety_isolate', principal_kind: 'system_safety' }); verify.close();
  });

  it('isolates a live rule whose persisted approved tool scope is missing', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pd-circuit-scope-'));
    const connection = new SqliteConnection({ workspaceDir: workspace, readonly: false });
    const db = connection.getDb();
    const now = '2026-08-21T00:00:00.000Z';
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-1', 'diagnosis', 'pending', ?, ?)").run(now, now);
    db.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-1', 'rule', 'task-1', '[]', 'validated', '{}', ?, ?)").run(now, now);
    await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'activation-1', idempotencyKey: 'source-1', artifactId: 'artifact-1', channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: 'impl://rule-1', activatedAt: now, promotedAt: now, deactivatedAt: null });
    connection.close();

    expect(observeRuleCodeSafety({ workspaceDir: workspace, activationId: 'activation-1', toolName: 'bash', params: {}, decision: 'block', matched: true })).toBe(true);
    await Promise.resolve();

    const verify = new SqliteConnection({ workspaceDir: workspace, readonly: true });
    expect(verify.getDb().prepare("SELECT enforcement FROM activation_control_states WHERE activation_id = 'activation-1'").get()).toEqual({ enforcement: 'safety_isolated' });
    verify.close();
  });

  it('counts matches outside the persisted approved tool scope', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'pd-circuit-outside-scope-'));
    const connection = new SqliteConnection({ workspaceDir: workspace, readonly: false });
    const db = connection.getDb();
    const now = '2026-08-21T00:00:00.000Z';
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-1', 'diagnosis', 'pending', ?, ?)").run(now, now);
    db.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-1', 'rule', 'task-1', '[]', 'validated', ?, ?, ?)").run(JSON.stringify({ affectedTools: ['read'] }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({ activationId: 'activation-1', idempotencyKey: 'source-1', artifactId: 'artifact-1', channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', targetRef: 'impl://rule-1', activatedAt: now, promotedAt: now, deactivatedAt: null });
    connection.close();

    for (let index = 0; index < 17; index += 1) {
      expect(observeRuleCodeSafety({ workspaceDir: workspace, activationId: 'activation-1', toolName: 'bash', params: {}, decision: 'block', matched: true })).toBe(false);
    }
    for (let index = 0; index < 2; index += 1) {
      expect(observeRuleCodeSafety({ workspaceDir: workspace, activationId: 'activation-1', toolName: 'read', params: {}, decision: 'allow', matched: false })).toBe(false);
    }
    expect(observeRuleCodeSafety({ workspaceDir: workspace, activationId: 'activation-1', toolName: 'read', params: {}, decision: 'allow', matched: false })).toBe(true);
    await Promise.resolve();

    const verify = new SqliteConnection({ workspaceDir: workspace, readonly: true });
    expect(verify.getDb().prepare("SELECT enforcement FROM activation_control_states WHERE activation_id = 'activation-1'").get()).toEqual({ enforcement: 'safety_isolated' });
    verify.close();
  });
});
