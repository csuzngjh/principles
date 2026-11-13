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
//
// PRI-1152: the write side also goes through the formal store entries
// (SqliteTaskStore.createTask, SqlitePIArtifactStore.createArtifact,
// SqliteActivationStateStore.recordActivation) — no row is inserted by hand
// and no approvals row is written, so the prompt route derives the honest
// `system_policy` authority for this isolated test fixture.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  SqlitePIArtifactStore,
  SqliteTaskStore,
  resolvePrincipleFromArtifact,
} from '@principles/core/runtime';

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Create `.pd/state.db` with exactly one prompt activation for one validated
 * principle artifact. Idempotent inputs; the caller supplies the frozen ids.
 */
export async function seedControlledWorkspace({
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
    const createdAt = activatedAt;
    const sourceTaskId = `task-${artifactId}`;
    const contentJson = JSON.stringify({ principleId, text: principleText, language: 'zh' });
    await new SqliteTaskStore(connection).createTask({
      taskId: sourceTaskId,
      taskKind: 'diagnosis',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
    });
    await new SqlitePIArtifactStore(connection).createArtifact({
      artifactId,
      artifactKind: 'principle',
      sourceTaskId,
      sourcePrincipleId: principleId,
      lineageArtifactIds: [],
      validationStatus: 'validated',
      contentJson,
      createdAt,
      updatedAt: createdAt,
    });
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId,
      idempotencyKey: `aa-prompt-${activationId}`,
      artifactId,
      channel: 'prompt',
      action: 'prompt_activate',
      // Production prompt activations always carry a ledger:// target; the
      // reader contract refuses any other shape, so the fixture must model the
      // real record instead of a filesystem path.
      targetRef: `ledger://${principleId}`,
      activatedAt,
      promotedAt: activatedAt,
      deactivatedAt: null,
    });
    // Checkpoint before closing so the frozen main file contains every page.
    const db = connection.getDb();
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
