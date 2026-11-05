import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
} from '@principles/core/runtime-v2';
import { buildActivePrinciplePromptContext, readPromptActivationCandidates, revalidateAdaptivePrinciple } from '../src/index.js';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-prompt-authority-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

async function seedOwnerApprovedPrompt(workspaceDir: string): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const db = connection.getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, 'principle', ?, ?, '[]', 'validated', ?, ?, ?)
    `).run('artifact-auth-1', 'task-auth-1', 'PRINCIPLE_AUTH_1', JSON.stringify({ principleId: 'PRINCIPLE_AUTH_1', text: 'Stable authorized body.' }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: 'activation-auth-1', idempotencyKey: 'artifact-auth-1::prompt', artifactId: 'artifact-auth-1',
      channel: 'prompt', action: 'prompt_activate', targetRef: 'ledger://PRINCIPLE_AUTH_1', activatedAt: now, deactivatedAt: null,
    });
    db.prepare(`
      INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, decided_at, decided_by)
      VALUES (?, ?, 'prompt', 'low', 'approved', 1, ?, ?, ?)
    `).run('approval-auth-1', 'artifact-auth-1', now, now, 'owner-1');
  } finally {
    connection.close();
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
  }
});

describe('prompt activation authority shared read', () => {
  it('does not spend the host soft budget waiting for a locked database during revalidation', async () => {
    const workspaceDir = tempWorkspace();
    await seedOwnerApprovedPrompt(workspaceDir);
    const expected = (await readPromptActivationCandidates({ workspaceDir, includeAuthority: true })).principles[0]!;
    const connection = new SqliteConnection(workspaceDir);
    const db = connection.getDb();
    db.pragma('journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
    const started = performance.now();
    let valid: boolean;
    try {
      valid = await revalidateAdaptivePrinciple(workspaceDir, expected, new AbortController().signal);
    } finally {
      db.exec('ROLLBACK');
      connection.close();
    }
    expect(valid).toBe(false);
    // A soft timer cannot interrupt synchronous SQLite's default five-second busy wait.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('opt-in authority makes owner approval observable to revalidation while default prompt bytes stay unchanged', async () => {
    const workspaceDir = tempWorkspace();
    await seedOwnerApprovedPrompt(workspaceDir);

    const nativeCandidates = await readPromptActivationCandidates({ workspaceDir });
    expect(nativeCandidates.principles[0]?.authority).toBeUndefined();
    const nativePrompt = await buildActivePrinciplePromptContext({ workspaceDir });
    expect(nativePrompt.additionalContext).not.toMatch(/<directive [^>]*authority=/);

    const verifiedCandidates = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const expected = verifiedCandidates.principles[0]!;
    expect(expected).toMatchObject({ authority: 'owner', approvedBy: 'owner-1' });
    expect(await revalidateAdaptivePrinciple(workspaceDir, expected, new AbortController().signal)).toBe(true);

    const connection = new SqliteConnection(workspaceDir);
    connection.getDb().prepare('UPDATE approvals SET decided_by = ? WHERE approval_id = ?').run('owner-2', 'approval-auth-1');
    connection.close();
    expect(await revalidateAdaptivePrinciple(workspaceDir, expected, new AbortController().signal)).toBe(false);

    const approvalRemoved = new SqliteConnection(workspaceDir);
    approvalRemoved.getDb().prepare('UPDATE approvals SET status = ? WHERE approval_id = ?').run('pending', 'approval-auth-1');
    approvalRemoved.close();
    const unapproved = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    expect(unapproved.principles[0]).toMatchObject({ authority: 'system_policy' });
    expect(await revalidateAdaptivePrinciple(workspaceDir, expected, new AbortController().signal)).toBe(false);
  });

  it('keeps missing approvals schema unknown and fails revalidation closed', async () => {
    const workspaceDir = tempWorkspace();
    await seedOwnerApprovedPrompt(workspaceDir);
    const expected = (await readPromptActivationCandidates({ workspaceDir, includeAuthority: true })).principles[0]!;
    const connection = new SqliteConnection(workspaceDir);
    connection.getDb().exec('DROP TABLE approvals');
    connection.close();

    const result = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    expect(result.principles[0]?.authority).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('prompt_activation_authority_unavailable'))).toBe(true);
    expect(await revalidateAdaptivePrinciple(workspaceDir, expected, new AbortController().signal)).toBe(false);
  });
});
