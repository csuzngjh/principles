// PRI-1118 controlled-admission experiment — isolated workspace seed.
//
// The positive arm can only prove an intervention if Runtime V2 actually has an
// active target in the frozen workspace. The experiment therefore seeds its OWN
// isolated workspace with one validated principle artifact and one prompt
// activation, then freezes the resulting state.db hash so P0 and the run read
// exactly the same bytes. Nothing here touches a production workspace.
//
// The read side uses the same production stores/resolver the plugin uses; the
// directive id asserted by the gate is the resolved principleId.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  resolvePrincipleFromArtifact,
} from '@principles/core/runtime-v2';

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Create `.pd/state.db` with exactly one prompt activation for one validated
 * principle artifact. Idempotent inputs; the caller supplies the frozen ids.
 */
export function seedControlledWorkspace({
  workspaceDir,
  artifactId,
  activationId,
  principleId,
  principleText,
  activatedAt = new Date().toISOString(),
}) {
  if (!workspaceDir || !artifactId || !activationId || !principleId || !principleText) {
    throw new Error('seedControlledWorkspace: workspaceDir, artifactId, activationId, principleId and principleText are required');
  }
  const pdDir = join(workspaceDir, '.pd');
  mkdirSync(pdDir, { recursive: true });
  const stateDbPath = join(pdDir, 'state.db');
  if (existsSync(stateDbPath)) throw new Error(`workspace state.db already exists: ${stateDbPath}`);

  const connection = new SqliteConnection({ workspaceDir });
  try {
    const db = connection.getDb();
    const createdAt = activatedAt;
    const contentJson = JSON.stringify({ principleId, text: principleText, language: 'zh' });
    db.prepare(
      "INSERT OR IGNORE INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'diagnosis', 'pending', ?, ?)",
    ).run(`task-${artifactId}`, createdAt, createdAt);
    db.prepare(
      `INSERT OR IGNORE INTO pi_artifacts
         (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)`,
    ).run(artifactId, `task-${artifactId}`, principleId, contentJson, createdAt, createdAt);
    new SqliteActivationStateStore(connection).recordActivation({
      activationId,
      idempotencyKey: `aa-prompt-${activationId}`,
      artifactId,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: workspaceDir,
      activatedAt,
      promotedAt: activatedAt,
      deactivatedAt: null,
    });
    // Checkpoint before closing so the frozen main file contains every page.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* default journal mode has no WAL */ }
  } finally {
    connection.close();
  }

  return {
    stateDbPath,
    stateDbSha256: sha256File(stateDbPath),
    artifactId,
    activationId,
    principleId,
    principleTextSha256: createHash('sha256').update(principleText, 'utf8').digest('hex'),
  };
}

/**
 * Read-only verification of the seeded target. Uses the production stores and
 * the production resolver, so a passing check means the plugin will see the
 * same activation and the same principleId.
 */
export async function readControlledWorkspaceTarget({ workspaceDir, artifactId, activationId }) {
  const stateDbPath = join(workspaceDir, '.pd', 'state.db');
  if (!existsSync(stateDbPath)) {
    return { ok: false, reason: 'state_db_missing', stateDbPath };
  }
  const connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false, busyTimeoutMs: 0 });
  try {
    const activations = await new SqliteActivationStateStore(connection)
      .listPromptActivations();
    const matches = activations.filter((row) => row.artifactId === artifactId && row.activationId === activationId);
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: matches.length === 0 ? 'activation_missing' : 'activation_ambiguous',
        stateDbPath,
        promptActivationCount: activations.length,
      };
    }
    const artifact = await new SqlitePIArtifactStore(connection).getArtifactById(artifactId);
    if (artifact === null) return { ok: false, reason: 'artifact_missing', stateDbPath };
    const resolved = resolvePrincipleFromArtifact({
      artifact_id: artifact.artifactId,
      artifact_kind: artifact.artifactKind,
      content_json: artifact.contentJson,
      validation_status: artifact.validationStatus,
    }, matches[0]);
    if (!resolved.ok) return { ok: false, reason: 'artifact_unresolved', detail: resolved.warning, stateDbPath };
    return {
      ok: true,
      stateDbPath,
      stateDbSha256: sha256File(stateDbPath),
      promptActivationCount: activations.length,
      artifactId,
      activationId,
      principleId: resolved.principle.principleId,
    };
  } finally {
    connection.close();
  }
}
