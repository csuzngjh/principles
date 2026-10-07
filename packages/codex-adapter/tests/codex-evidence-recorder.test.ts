/**
 * Codex Evidence Recorder tests (PD v2 Phase 1, Codex adapter).
 *
 * Real temp workspaces + real ingress; the full-path case drives the REAL
 * processHookInvocation (real dispatch, real prompt build) — proving the
 * wiring, not just the recorder. Codex honesty boundaries under test:
 * prompt attempts stay submitted/attempted, capability matrix declares
 * self_report Unsupported and enforcement Unknown (PRI-780 suspension).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { processHookInvocation } from '../src/pd-hook.js';
import {
  recordCodexPromptDeliveryEvidence,
  recordCodexDenyEvidence,
  codexCapabilityDeclarations,
} from '../src/codex-evidence-recorder.js';

const dirs: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-ev-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

/**
 * Isolated env so user-workspace resolution cannot adopt the DEVELOPER
 * MACHINE's real ~/.codex/pd-workspace (which would silently redirect the
 * test's evidence writes into real Owner state — exactly what happened in
 * the first draft of this test).
 */
function isolatedEnv(): { CODEX_HOME: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-ev-home-'));
  dirs.push(home);
  return { CODEX_HOME: home };
}

function seedPromptActivation(root: string): void {
  const conn = new SqliteConnection(root);
  const db = conn.getDb();
  const now = '2026-10-01T00:00:00Z';
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
              validation_status, content_json, created_at, updated_at)
              VALUES ('art-cx', 'principle', 'task-cx', 'princ-cx', 'validated', ?, ?, ?)`)
    .run(JSON.stringify({ principleId: 'princ-cx', text: '删除类操作必须先确认目标' }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
              VALUES ('act-cx', 'idem-cx', 'art-cx', 'prompt', 'prompt_activate', 'ref', ?)`)
    .run(now);
  conn.close();
}

function evidenceRows(root: string): { record_kind: string; observation_key: string; payload_json: string }[] {
  const conn = new SqliteConnection({ workspaceDir: root, readonly: true, bootstrapIfMissing: false });
  try {
    return conn.getDb()
      .prepare('SELECT record_kind, observation_key, payload_json FROM intervention_evidence_records')
      .all() as never;
  } finally {
    conn.close();
  }
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('codex evidence recorder', () => {
  it('records prompt delivery attempts as submitted/attempted after the durable source line', () => {
    const root = workspace();
    seedPromptActivation(root);
    const warnings: string[] = [];
    recordCodexPromptDeliveryEvidence({
      workspaceDir: root,
      sessionId: 'sess-cx',
      turnId: 'turn-1',
      injected: [{ principleId: 'princ-cx', activationId: 'act-cx', artifactId: 'art-cx' }],
      evidenceEnabled: true,
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toHaveLength(0);
    const rows = evidenceRows(root).filter((r) => r.record_kind === 'delivery');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted',
    });
    expect(rows[0]!.observation_key).toContain('turn-1');
  });

  it('writes nothing when evidence is flag-disabled', () => {
    const root = workspace();
    seedPromptActivation(root);
    recordCodexPromptDeliveryEvidence({
      workspaceDir: root,
      sessionId: 'sess-cx',
      injected: [{ principleId: 'princ-cx', activationId: 'act-cx' }],
      evidenceEnabled: false,
      warn: () => undefined,
    });
    expect(evidenceRows(root)).toHaveLength(0);
  });

  it('declares self_report Unsupported and enforcement Unknown — no false Codex capabilities', () => {
    const caps = codexCapabilityDeclarations();
    const byCapability = new Map(caps.map((c) => [c.capability, c]));
    expect(byCapability.get('application_self_report')?.status).toBe('unsupported');
    expect(byCapability.get('enforcement_delivery')?.status).toBe('unknown');
    expect(byCapability.get('application_runtime_verified')?.status).toBe('unknown');
    expect(byCapability.get('agent_context_delivery')?.status).toBe('supported');
    expect(byCapability.get('agent_context_delivery')?.maxConfirmation).toBe('submitted');
  });

  it('skips the deny chain without toolUseId — no hash fallback, no rows', () => {
    // A hash fallback would mint an episode with no native event key, which
    // the normalizer rejects (episode_requires_native_event_key) and drops
    // the WHOLE batch. Skipping with a warn is the honest degradation.
    const root = workspace();
    seedPromptActivation(root);
    const warnings: string[] = [];
    recordCodexDenyEvidence({
      workspaceDir: root,
      sessionId: 'sess-cx',
      toolName: 'write_file',
      activationId: 'act-cx',
      principleId: 'princ-cx',
      evidenceEnabled: true,
      warn: (line) => warnings.push(line),
    });
    expect(evidenceRows(root)).toHaveLength(0);
    expect(warnings.join(' ')).toContain('toolUseId');
  });
});

describe('pd-hook full path (real processHookInvocation)', () => {
  it('UserPromptSubmit with a prompt activation writes delivery evidence + capability rows', async () => {
    const root = workspace();
    seedPromptActivation(root);
    const stdin = JSON.stringify({
      session_id: 'sess-cx', turn_id: 'turn-9', transcript_path: null, cwd: root,
      model: 'gpt-5.6', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'help',
    });
    const result = await processHookInvocation(stdin, isolatedEnv(), root);
    expect(result.exitCode).toBe(0);

    const rows = evidenceRows(root);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const delivery = rows.find((r) => r.record_kind === 'delivery');
    expect(delivery).toBeDefined();
    expect(JSON.parse(delivery!.payload_json)).toMatchObject({
      targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted',
    });

    // Capability declarations rode the same batch.
    const conn = new SqliteConnection({ workspaceDir: root, readonly: true, bootstrapIfMissing: false });
    try {
      const caps = conn.getDb()
        .prepare('SELECT capability, status FROM intervention_capability_declarations WHERE host_kind = ?')
        .all('codex') as { capability: string; status: string }[];
      const selfReport = caps.find((c) => c.capability === 'application_self_report');
      expect(selfReport?.status).toBe('unsupported');
    } finally {
      conn.close();
    }
  });

  it('replaying the same prompt hook is idempotent — no duplicate delivery rows', async () => {
    const root = workspace();
    seedPromptActivation(root);
    const stdin = JSON.stringify({
      session_id: 'sess-cx', turn_id: 'turn-9', transcript_path: null, cwd: root,
      model: 'gpt-5.6', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'help',
    });
    await processHookInvocation(stdin, isolatedEnv(), root);
    await processHookInvocation(stdin, isolatedEnv(), root);
    const deliveries = evidenceRows(root).filter((r) => r.record_kind === 'delivery');
    expect(deliveries).toHaveLength(1);
  });

  it('Stop (turn_complete) with ingestion off keeps stdout neutral and writes no evidence', async () => {
    const root = workspace();
    seedPromptActivation(root);
    const stdin = JSON.stringify({
      session_id: 'sess-cx', turn_id: 'turn-9', transcript_path: null, cwd: root,
      model: 'gpt-5.6', permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false,
    });
    const result = await processHookInvocation(stdin, isolatedEnv(), root);
    expect(result.stdout).toEqual({});
    expect(evidenceRows(root)).toHaveLength(0);
  });
});
