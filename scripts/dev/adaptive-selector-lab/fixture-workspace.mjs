// PRI-1122 fixture workspaces: throwaway SQLite workspaces seeded from frozen
// candidate specs. Shared by the offline tests and the approved real-call
// branch so both arms read the SAME Runtime V2 candidate source.
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  measureSharedDirectiveBlockChars,
  sharedDirectiveBaseChars,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { readPromptActivationCandidates } from '@principles/host-runtime';

export async function seedFixtureWorkspace(workspaceDir, specs) {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  const connection = new SqliteConnection(workspaceDir);
  try {
    const db = connection.getDb();
    const insertArtifact = db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `);
    const approve = db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, 'owner-test')
    `);
    const store = new SqliteActivationStateStore(connection);
    let index = 0;
    for (const spec of specs) {
      const at = new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + index * 1000).toISOString();
      index += 1;
      const artifactId = spec.artifactId ?? `art-${spec.key}`;
      const activationId = spec.activationId ?? `act-${spec.key}`;
      insertArtifact.run(artifactId, `task-${artifactId}`, spec.principleId, JSON.stringify({ principleId: spec.principleId, text: spec.text }), at, at);
      await store.recordActivation({
        activationId,
        idempotencyKey: `${artifactId}::prompt`,
        artifactId,
        channel: 'prompt',
        action: 'prompt_activate',
        targetRef: `ledger://${spec.principleId}`,
        activatedAt: at,
        deactivatedAt: null,
      });
      if (spec.approved !== false) approve.run(`approval-${artifactId}`, artifactId, at, at);
    }
  } finally {
    connection.close();
  }
}

export function mutateFixtureDb(workspaceDir, run) {
  const connection = new SqliteConnection(workspaceDir);
  try { run(connection.getDb()); } finally { connection.close(); }
}

// Budget arithmetic identical to the frozen assembly rule: the shared directive
// base plus one block per principle, measured through the production helper.
export async function measureFixtureCosts(workspaceDir) {
  const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
  const base = sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: false });
  const byPrincipleId = {};
  for (const principle of read.principles) {
    byPrincipleId[principle.principleId] = measureSharedDirectiveBlockChars(principle,
      { escapeFn: escapeXml, selfReportInstruction: false });
  }
  return { base, byPrincipleId, order: read.principles.map((principle) => principle.principleId) };
}
