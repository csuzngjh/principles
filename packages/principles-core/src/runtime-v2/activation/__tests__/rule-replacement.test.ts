import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import { detectRuleReplacementTarget } from '../rule-replacement.js';
import type { ActivationStatusRecord, PIArtifactSnapshot } from '../activation-types.js';

/**
 * SPEC-RULECODE-APPROVED-REVISION-001 §A/§B (core level): a revised RuleCode
 * artifact owns a distinct activation identity and control state, and the
 * superseded shadow is retired in the SAME transaction. The old version is
 * never lost on failure, and replay never duplicates rows or decisions.
 */

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rule-replacement-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.pd'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

const RULE_ID = 'rule-evaluator-task-1-code_tool_hook';

function seedRuleArtifact(connection: SqliteConnection, artifactId: string, taskId = 'evaluator-task-1', revisionEpoch = 0): void {
  // The store keys artifacts by (task, kind, revision_epoch); a revision is a
  // NEW artifact of the same evaluator task, so it lands on a later epoch.
  connection.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id,
      lineage_artifact_ids, validation_status, content_json, created_at, updated_at, revision_epoch)
    VALUES (?, 'rule', ?, NULL, ?, '[]', 'validated', ?, ?, ?, ?)
  `).run(artifactId, taskId, RULE_ID, JSON.stringify({ implementationCode: `// ${artifactId}` }),
    '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', revisionEpoch);
}

async function seedShadow(store: SqliteActivationStateStore, activationId: string, artifactId: string): Promise<void> {
  await store.recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_shadow_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: '2026-11-01T00:00:00.000Z',
    deactivatedAt: null,
  });
}

/** Typed snapshot lookup; the store rows are untyped SQLite records. */
function artifactLookup(connection: SqliteConnection) {
  return async (artifactId: string): Promise<PIArtifactSnapshot | null> => {
    const row = connection.getDb().prepare('SELECT * FROM pi_artifacts WHERE artifact_id = ?').get(artifactId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const snapshot: PIArtifactSnapshot = {
      artifactId: String(row.artifact_id),
      artifactKind: 'rule',
      sourceTaskId: String(row.source_task_id),
      sourceRuleId: String(row.source_rule_id),
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson: String(row.content_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    return snapshot;
  };
}

const newRecord = (artifactId: string, activationId: string): ActivationStatusRecord => ({
  activationId,
  idempotencyKey: `${artifactId}::code_tool_hook`,
  artifactId,
  channel: 'code_tool_hook',
  action: 'code_tool_hook_shadow_activate',
  targetRef: `impl://${RULE_ID}-v2`,
  activatedAt: '2026-11-01T01:00:00.000Z',
  deactivatedAt: null,
});

const commit = (artifactId: string, activationId: string) => ({
  newRecord: newRecord(artifactId, activationId),
  supersededActivationId: 'act-old',
  supersededArtifactId: 'art-old',
  decidedBy: 'isolated-test-owner',
  decidedAt: '2026-11-01T01:00:00.000Z',
  reasonCode: 'rule_revision_replacement',
  note: 'revised version approved',
});

describe('SPEC-RULECODE-APPROVED-REVISION-001 §B: rule activation replacement', () => {
  it('commits the new version, retires the old one and seeds its own control state', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedRuleArtifact(connection, 'art-old');
      seedRuleArtifact(connection, 'art-new', 'evaluator-task-1', 1);
      const store = new SqliteActivationStateStore(connection);
      await seedShadow(store, 'act-old', 'art-old');

      const outcome = await store.replaceRuleActivation(commit('art-new', 'act-new'));

      expect(outcome.status).toBe('replaced');
      const rows = await store.listCodeToolHookActivations(true);
      expect(rows.map((row) => [row.activationId, row.artifactId, row.deactivatedAt === null])).toEqual([
        ['act-old', 'art-old', false],
        ['act-new', 'art-new', true],
      ]);
      // Control state is keyed by activation id: the new version must own a
      // fresh eligible row, or the gate skips it as invalid.
      const controls = connection.getDb().prepare(
        "SELECT activation_id, enforcement, version FROM activation_control_states WHERE activation_id LIKE 'act-%' ORDER BY activation_id",
      ).all();
      expect(controls).toEqual([
        { activation_id: 'act-new', enforcement: 'eligible', version: 1 },
        { activation_id: 'act-old', enforcement: 'eligible', version: 1 },
      ]);
      const decisions = connection.getDb().prepare(
        "SELECT decision, activation_id, artifact_id FROM activation_decisions WHERE decision='supersede'",
      ).all();
      expect(decisions).toEqual([{ decision: 'supersede', activation_id: 'act-old', artifact_id: 'art-old' }]);
    } finally { connection.close(); }
  });

  it('is idempotent on replay: no second row, no second decision', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedRuleArtifact(connection, 'art-old');
      seedRuleArtifact(connection, 'art-new', 'evaluator-task-1', 1);
      const store = new SqliteActivationStateStore(connection);
      await seedShadow(store, 'act-old', 'art-old');

      await store.replaceRuleActivation(commit('art-new', 'act-new'));
      const replay = await store.replaceRuleActivation(commit('art-new', 'act-new'));

      expect(replay.status).toBe('already_replaced');
      expect((await store.listCodeToolHookActivations(true)).length).toBe(2);
      const supersedeCount = connection.getDb().prepare(
        "SELECT COUNT(*) AS n FROM activation_decisions WHERE decision='supersede'",
      ).get() as { n: number };
      expect(supersedeCount.n).toBe(1);
    } finally { connection.close(); }
  });

  it('rolls back to the old-only state when the commit fails', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedRuleArtifact(connection, 'art-old');
      seedRuleArtifact(connection, 'art-new', 'evaluator-task-1', 1);
      const store = new SqliteActivationStateStore(connection);
      await seedShadow(store, 'act-old', 'art-old');
      connection.getDb().exec(
        "CREATE TRIGGER fail_supersede BEFORE UPDATE ON activations WHEN NEW.deactivated_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'simulated crash'); END",
      );

      await expect(store.replaceRuleActivation(commit('art-new', 'act-new'))).rejects.toThrow('simulated crash');

      const rows = await store.listCodeToolHookActivations(true);
      expect(rows.map((row) => [row.activationId, row.deactivatedAt === null])).toEqual([['act-old', true]]);
      const supersedeCount = connection.getDb().prepare(
        "SELECT COUNT(*) AS n FROM activation_decisions WHERE decision='supersede'",
      ).get() as { n: number };
      expect(supersedeCount.n).toBe(0);
    } finally { connection.close(); }
  });

  it('refuses a replacement whose identity collides with the version being replaced', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedRuleArtifact(connection, 'art-old');
      const store = new SqliteActivationStateStore(connection);
      await seedShadow(store, 'act-old', 'art-old');
      await expect(store.replaceRuleActivation({
        ...commit('art-old', 'act-old'),
        newRecord: newRecord('art-old', 'act-old'),
      })).rejects.toThrow(/must be distinct/);
    } finally { connection.close(); }
  });

  it('detects only the shadow of the same evaluator chain and refuses to shadow a live rule', async () => {
    const dir = tempWorkspace();
    const connection = new SqliteConnection({ workspaceDir: dir });
    try {
      seedRuleArtifact(connection, 'art-old');
      seedRuleArtifact(connection, 'art-new', 'evaluator-task-1', 1);
      seedRuleArtifact(connection, 'art-other', 'evaluator-task-other', 0);
      const store = new SqliteActivationStateStore(connection);
      await seedShadow(store, 'act-old', 'art-old');
      await seedShadow(store, 'act-other', 'art-other');

      const detection = await detectRuleReplacementTarget({
        approvalArtifactId: 'art-new',
        getArtifactById: artifactLookup(connection),
        listRuleActivations: () => store.listCodeToolHookActivations(),
      });
      expect(detection).toEqual({ ok: true, target: { supersededActivationId: 'act-old', supersededArtifactId: 'art-old' } });

      connection.getDb().prepare("UPDATE activations SET action='code_tool_hook_live_activate' WHERE activation_id='act-old'").run();
      const liveRefusal = await detectRuleReplacementTarget({
        approvalArtifactId: 'art-new',
        getArtifactById: artifactLookup(connection),
        listRuleActivations: () => store.listCodeToolHookActivations(),
      });
      expect(liveRefusal.ok).toBe(false);
    } finally { connection.close(); }
  });
});
