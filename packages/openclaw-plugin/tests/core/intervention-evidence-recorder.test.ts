/**
 * Intervention Evidence Recorder tests (PD v2 Phase 1, OpenClaw adapter).
 *
 * Real temp workspaces, real ingress + state.db — no mocks. Covers the
 * recorder's honesty boundaries (submitted-not-delivered prompt attempts,
 * runtime_verified enforcement chains, agent_claimed self-reports) and the
 * flag gate (principle_receipt_ledger off → zero evidence rows).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteConnection, getDefaultPdConfig } from '@principles/core/runtime-v2';
import {
  recordPromptDeliveryEvidence,
  recordGateEnforcementEvidence,
  recordSelfReportEvidence,
} from '../../src/core/intervention-evidence-recorder.js';

let workspaceDir = '';
let conn: SqliteConnection;

function seedActivation(activationId: string, artifactId: string): void {
  const now = '2026-10-01T00:00:00Z';
  const db = conn.getDb();
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
              content_json, created_at, updated_at)
              VALUES (?, 'principle', 'task-1', 'T-01', ?, ?, ?)`)
    .run(artifactId, JSON.stringify({ principleId: 'T-01', text: '删除类操作必须先确认目标' }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
              VALUES (?, ?, ?, 'code_tool_hook', 'code_tool_hook_live_activate', 'ref', ?)`)
    .run(activationId, `idem-${activationId}`, artifactId, now);
}

function evidenceRows(): { record_kind: string; observation_key: string; payload_json: string; episode_key: string | null; principle_id: string | null }[] {
  return conn.getDb()
    .prepare('SELECT record_kind, observation_key, payload_json, episode_key, principle_id FROM intervention_evidence_records')
    .all() as never;
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iev-recorder-'));
  conn = new SqliteConnection(workspaceDir);
});

afterEach(() => {
  conn.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('intervention evidence recorder (openclaw adapter)', () => {
  it('records prompt delivery attempts as submitted/attempted — never delivered', () => {
    seedActivation('act-p1', 'art-p1');
    recordPromptDeliveryEvidence({
      workspaceDir,
      sessionId: 'sess-1',
      runId: 'run-1',
      injected: [{ principleId: 'T-01', activationId: 'act-p1', artifactId: 'art-p1' }],
    });
    const rows = evidenceRows().filter((r) => r.record_kind === 'delivery');
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload).toMatchObject({ targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' });
    expect(payload.outcome).not.toBe('delivered');
  });

  it('skips prompt delivery for unresolvable activations with an honest gap (no row)', () => {
    const warn = [];
    recordPromptDeliveryEvidence({
      workspaceDir,
      sessionId: 'sess-1',
      injected: [{ principleId: 'T-01', activationId: 'act-missing' }],
      logger: { warn: (m: string) => warn.push(m) },
    });
    expect(evidenceRows()).toHaveLength(0);
    expect(warn.join(' ')).toContain('act-missing');
  });

  it('records the full enforcement chain with exact cross-references', () => {
    seedActivation('act-g1', 'art-g1');
    recordGateEnforcementEvidence({
      workspaceDir,
      sessionId: 'sess-1',
      runId: 'run-9',
      toolCallId: 'tool-9',
      toolName: 'write_file',
      filePath: 'src/x.ts',
      activationId: 'act-g1',
      principleId: 'T-01',
      ruleId: 'R-1',
      reason: '删除类操作必须先确认目标',
      decision: 'block',
    });

    const rows = evidenceRows();
    expect(rows.map((r) => r.record_kind).sort()).toEqual(['application', 'behavior_episode', 'delivery', 'effect']);

    const delivery = rows.find((r) => r.record_kind === 'delivery')!;
    expect(JSON.parse(delivery.payload_json)).toMatchObject({
      targetKind: 'runtime_enforcement', confirmation: 'runtime_loaded', outcome: 'delivered',
    });

    const application = rows.find((r) => r.record_kind === 'application')!;
    expect(JSON.parse(application.payload_json)).toMatchObject({
      proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'pd_gate_block_returned_to_host',
    });

    const episode = rows.find((r) => r.record_kind === 'behavior_episode')!;
    const effect = rows.find((r) => r.record_kind === 'effect')!;
    expect(application.episode_key).toBe(episode.observation_key);
    expect(effect.episode_key).toBe(episode.observation_key);
    expect(effect.principle_id).toBe('T-01');
  });

  it('replaying the same enforcement chain is idempotent (no duplicate rows)', () => {
    seedActivation('act-g1', 'art-g1');
    const input = {
      workspaceDir,
      sessionId: 'sess-1' as const,
      runId: 'run-9',
      toolCallId: 'tool-9',
      toolName: 'write_file',
      filePath: 'src/x.ts',
      activationId: 'act-g1',
      principleId: 'T-01',
      ruleId: 'R-1',
      decision: 'block' as const,
    };
    recordGateEnforcementEvidence(input);
    recordGateEnforcementEvidence(input);
    expect(evidenceRows()).toHaveLength(4);
  });

  it('records self-reports as agent_claimed only', () => {
    seedActivation('act-s1', 'art-s1');
    recordSelfReportEvidence({
      workspaceDir,
      sessionId: 'sess-1',
      principleId: 'T-01',
      activationId: 'act-s1',
      claimText: '删除前确认了目标',
    });
    const rows = evidenceRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      proofMethod: 'agent_claimed', action: 'self_reported',
    });
  });

  it('writes nothing when principle_receipt_ledger is disabled', () => {
    const cfg = getDefaultPdConfig() as unknown as {
      features: Record<string, { category?: string; enabled: boolean }>;
    };
    cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: false };
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
    // Re-open so the config read sees the fresh file (config loader reads per call).
    conn.close();
    conn = new SqliteConnection(workspaceDir);
    seedActivation('act-x', 'art-x');

    recordPromptDeliveryEvidence({
      workspaceDir,
      sessionId: 'sess-1',
      injected: [{ principleId: 'T-01', activationId: 'act-x' }],
    });
    recordGateEnforcementEvidence({
      workspaceDir, sessionId: 'sess-1', toolName: 'write_file', filePath: 'a.ts',
      activationId: 'act-x', principleId: 'T-01', decision: 'block',
    });
    recordSelfReportEvidence({ workspaceDir, sessionId: 'sess-1', principleId: 'T-01', claimText: 'x' });
    expect(evidenceRows()).toHaveLength(0);
  });

  it('declares the OpenClaw capability matrix on every append', () => {
    seedActivation('act-s1', 'art-s1');
    recordSelfReportEvidence({ workspaceDir, sessionId: 'sess-1', principleId: 'T-01', claimText: 'x' });
    const caps = conn.getDb()
      .prepare('SELECT host_kind, capability, status FROM intervention_capability_declarations')
      .all() as { host_kind: string; capability: string; status: string }[];
    expect(caps.length).toBeGreaterThanOrEqual(6);
    const outcome = caps.find((c) => c.capability === 'outcome_observation');
    expect(outcome?.status).toBe('unknown');
    const enforcement = caps.find((c) => c.capability === 'enforcement_delivery');
    expect(enforcement?.status).toBe('supported');
  });
});
