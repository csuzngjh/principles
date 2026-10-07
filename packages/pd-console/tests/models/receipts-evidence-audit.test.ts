/**
 * ReceiptsConsoleModel evidence-audit tests (PD v2 Phase 1, PR5).
 *
 * Real temp workspace + real evidence ledger writes through the store; the
 * model is exercised through its public GET-facing method. Covers the four
 * selector shapes, degradation honesty (missing DB / pre-evidence schema),
 * and the no-success-rate contract (payload summaries only).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { SqliteConnection, SqliteInterventionEvidenceStore, getDefaultPdConfig } from '@principles/core/runtime-v2';
import { normalizeInterventionEvidenceBatch } from '@principles/core/runtime-v2';
import { ReceiptsConsoleModel } from '../../src/server/models/ReceiptsConsoleModel.js';

let workspaceDir = '';
let conn: SqliteConnection;

function writeLedgerEnabledConfig(): void {
  const cfg = getDefaultPdConfig() as unknown as {
    features: Record<string, { category?: string; enabled: boolean }>;
  };
  cfg.features.principle_receipt_ledger = { category: 'quiet', enabled: true };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(cfg));
}

function seedChain(): void {
  const now = '2026-10-07T08:00:00Z';
  const db = conn.getDb();
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, validation_status, content_json, created_at, updated_at)
              VALUES ('art-a1', 'principle', 'task-1', 'princ-A', 'validated', ?, ?, ?)`)
    .run(JSON.stringify({ principleId: 'princ-A', text: '删除类操作必须先确认目标' }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
              VALUES ('act-a1', 'idem-a1', 'art-a1', 'code_tool_hook', 'code_tool_hook_live_activate', 'ref', ?)`)
    .run(now);

  const batch = normalizeInterventionEvidenceBatch({
    evidenceScopeId: 'scope-seed',
    sourceKind: 'openclaw_plugin_event_log',
    adapterVersion: 'test@1',
    recordedAt: now,
    observations: [
      {
        observationKey: 'openclaw|delivery|enforcement|sess-1|tool-1|act-a1',
        sourceLocator: 'log:1', kind: 'delivery',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', toolCallId: 'tool-1', toolName: 'exec' },
        principleId: 'princ-A',
        contentRef: { principleId: 'princ-A', payloadDigest: 'sha256:a', resolution: 'resolved' },
        activationRef: { activationId: 'act-a1', sourceSnapshotDigest: 'sha256:s' },
        payload: { targetKind: 'runtime_enforcement', confirmation: 'runtime_loaded', outcome: 'delivered' },
      },
      {
        observationKey: 'openclaw|episode|sess-1|tool-1',
        sourceLocator: 'log:2', kind: 'behavior_episode',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', toolCallId: 'tool-1', toolName: 'exec' },
        payload: { status: 'closed', actionSummary: 'exec rm', resultSummary: 'blocked' },
      },
      {
        observationKey: 'openclaw|application|runtime_verified|sess-1|tool-1|act-a1',
        sourceLocator: 'log:3', kind: 'application',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', toolCallId: 'tool-1', toolName: 'exec' },
        principleId: 'princ-A',
        activationRef: { activationId: 'act-a1', sourceSnapshotDigest: 'sha256:s' },
        episodeKey: 'openclaw|episode|sess-1|tool-1',
        payload: { proofMethod: 'runtime_verified', action: 'tool_blocked', enforcementBoundary: 'pd_gate_block_returned_to_host' },
      },
      {
        observationKey: 'openclaw|effect|sess-1|tool-1|act-a1',
        sourceLocator: 'log:4', kind: 'effect',
        nativeRefs: { hostKind: 'openclaw', sessionId: 'sess-1', toolCallId: 'tool-1', toolName: 'exec' },
        principleId: 'princ-A', episodeKey: 'openclaw|episode|sess-1|tool-1',
        contentRef: { principleId: 'princ-A', payloadDigest: 'sha256:a', resolution: 'resolved' },
        activationRef: { activationId: 'act-a1', sourceSnapshotDigest: 'sha256:s' },
        payload: { status: 'observed', observationSummary: 'rule R-1 blocked exec' },
      },
      {
        observationKey: 'owner|outcome|openclaw|episode|sess-1|tool-1',
        sourceLocator: 'console:1', kind: 'outcome',
        nativeRefs: { hostKind: 'openclaw' },
        episodeKey: 'openclaw|episode|sess-1|tool-1',
        payload: { outcomeSource: 'owner_feedback', observationSummary: '测试文件未被创建', actorId: 'owner-1' },
      },
    ],
  });
  expect(batch.ok).toBe(true);
  if (!batch.ok) throw new Error(batch.reason);
  new SqliteInterventionEvidenceStore(conn).appendObservationBatch(batch.batch);
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ev-model-'));
  conn = new SqliteConnection(workspaceDir);
  writeLedgerEnabledConfig();
});

afterEach(() => {
  conn.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('ReceiptsConsoleModel.getEvidenceAudit (SPEC §13.8 four queries)', () => {
  it('Q1 principle selector returns the full chain sections', async () => {
    seedChain();
    const model = new ReceiptsConsoleModel(workspaceDir);
    const result = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-A' });
    expect(result.status).toBe('ok');
    expect(result.deliveries).toHaveLength(1);
    expect(result.applications).toHaveLength(1);
    expect(result.effects).toHaveLength(1);
    expect(result.outcomes).toHaveLength(1);
    // Episodes are not principle-scoped by design; they answer via their own
    // selector (Q3) — the principle chain reaches them via episodeKey refs.
    expect(result.episodes).toHaveLength(0);
    expect(result.coverage.sourceStatus).toBe('available');
    expect(result.asOf).toBeTruthy();
  });

  it('Q2 activation selector separates agent-claimed from runtime-verified applications', async () => {
    seedChain();
    const model = new ReceiptsConsoleModel(workspaceDir);
    const result = await model.getEvidenceAudit({ type: 'activation', activationId: 'act-a1' });
    expect(result.status).toBe('ok');
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]!.payload).toMatchObject({ proofMethod: 'runtime_verified' });
  });

  it('Q3 episode selector returns the episode and its linked records', async () => {
    seedChain();
    const model = new ReceiptsConsoleModel(workspaceDir);
    const result = await model.getEvidenceAudit({ type: 'episode', observationKey: 'openclaw|episode|sess-1|tool-1' });
    expect(result.status).toBe('ok');
    expect(result.episodes).toHaveLength(1);
    expect(result.applications[0]!.associationStatus).toBe('linked');
  });

  it('Q4 effect selector returns the effect and its outcome', async () => {
    seedChain();
    const model = new ReceiptsConsoleModel(workspaceDir);
    const result = await model.getEvidenceAudit({ type: 'effect', observationKey: 'openclaw|effect|sess-1|tool-1|act-a1' });
    expect(result.status).toBe('ok');
    expect(result.effects).toHaveLength(1);
    expect(result.outcomes).toHaveLength(1);
  });

  it('degrades honestly when state.db does not exist', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ev-model-none-'));
    try {
      const model = new ReceiptsConsoleModel(emptyDir);
      const result = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-A' });
      expect(result.status).toBe('degraded');
      expect(result.reason).toContain('state.db');
      expect(result.coverage.sourceStatus).toBe('unavailable');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('degrades honestly on a pre-evidence database (schema never bootstrapped by a GET)', async () => {
    seedChain();
    const db = conn.getDb();
    db.prepare('DROP TRIGGER IF EXISTS intervention_evidence_records_no_update').run();
    db.prepare('DROP TRIGGER IF EXISTS intervention_evidence_records_no_delete').run();
    db.prepare('DROP TABLE IF EXISTS intervention_evidence_records').run();
    db.prepare('DROP TABLE IF EXISTS intervention_evidence_scope').run();
    db.prepare('DROP TABLE IF EXISTS intervention_capability_declarations').run();
    conn.close();
    conn = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
    const model = new ReceiptsConsoleModel(workspaceDir);
    const result = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-A' });
    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('evidence_schema_not_initialized');
    expect(result.nextAction).toBeTruthy();
  });

  it('empty sections stay empty observations — no success-rate anywhere in the response', async () => {
    seedChain();
    const model = new ReceiptsConsoleModel(workspaceDir);
    const result = await model.getEvidenceAudit({ type: 'principle', principleId: 'princ-NONE' });
    expect(result.status).toBe('ok');
    expect(result.deliveries).toHaveLength(0);
    expect(result.coverage.sourceStatus).toBe('available');
    expect(JSON.stringify(result)).not.toMatch(/successRate|effectiveness|score/i);
  });
});
