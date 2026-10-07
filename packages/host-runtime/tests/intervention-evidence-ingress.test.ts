/**
 * Intervention Evidence Ingress tests (PD v2 Phase 1, PR3).
 *
 * Real temp workspaces and the real core store — no mocks. Covers the
 * failure contract (never throws, structured reasons), scope identity
 * stability, and the activation occurrence snapshot resolution used by
 * both host adapters.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteConnection } from '@principles/core/runtime-v2';
import {
  createInterventionEvidenceIngress,
} from '../src/intervention-evidence-ingress.js';

const ingress = createInterventionEvidenceIngress();

let workspaceDir = '';
let conn: SqliteConnection;

function validDeliveryBatch() {
  return {
    evidenceScopeId: 'placeholder-overridden-by-ingress',
    sourceKind: 'openclaw_plugin_event_log' as const,
    adapterVersion: 'test-adapter@1',
    recordedAt: new Date().toISOString(),
    observations: [
      {
        observationKey: 'openclaw|delivery|agent_context|sess-1|run-1|act-1',
        sourceLocator: 'openclaw-plugin-event-log:sess-1',
        kind: 'delivery' as const,
        nativeRefs: { hostKind: 'openclaw' as const, sessionId: 'sess-1', runId: 'run-1' },
        principleId: 'T-01',
        contentRef: { principleId: 'T-01', payloadDigest: 'sha256:aa', resolution: 'resolved' as const },
        activationRef: { activationId: 'act-1', sourceSnapshotDigest: 'sha256:bb' },
        payload: { targetKind: 'agent_context' as const, confirmation: 'submitted' as const, outcome: 'attempted' as const },
      },
    ],
  };
}

function seedActivation(workspace: string, activationId: string): void {
  const c = new SqliteConnection(workspace);
  const db = c.getDb();
  const now = '2026-10-01T00:00:00Z';
  db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
              content_json, created_at, updated_at)
              VALUES (?, 'principle', 'task-1', 'T-01', ?, ?, ?)`)
    .run('art-1', JSON.stringify({ text: '原则内容' }), now, now);
  db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
              VALUES (?, ?, 'art-1', 'prompt', 'prompt_activate', 'ref', ?)`)
    .run(activationId, `idem-${activationId}`, now);
  c.close();
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iev-ingress-'));
  conn = new SqliteConnection(workspaceDir);
});

afterEach(() => {
  conn.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('intervention evidence ingress', () => {
  it('appends a normalized batch into the workspace state.db evidence ledger', () => {
    seedActivation(workspaceDir, 'act-1');
    const result = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch() });
    expect(result.ok).toBe(true);
    expect(result.insertedCount).toBe(1);

    const row = conn.getDb()
      .prepare("SELECT record_kind, payload_json FROM intervention_evidence_records WHERE observation_key LIKE '%act-1'")
      .get() as { record_kind: string; payload_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.record_kind).toBe('delivery');
    expect(JSON.parse(row?.payload_json ?? '{}')).toMatchObject({ outcome: 'attempted', confirmation: 'submitted' });
  });

  it('never throws on a malformed batch — returns a structured rejection', () => {
    const result = ingress.appendObservationBatch({
      workspaceDir,
      batch: { ...validDeliveryBatch(), observations: [{ ...validDeliveryBatch().observations[0]!, payload: { targetKind: 'agent_context' } }] },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('evidence_batch_rejected');
    expect(result.nextAction).toBeTruthy();
    const count = (conn.getDb().prepare('SELECT COUNT(*) AS n FROM intervention_evidence_records').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('never throws on storage failure — returns a structured storage reason', () => {
    // A workspace path nested under a regular FILE cannot host .pd/state.db.
    const blocker = path.join(workspaceDir, 'blocker.txt');
    fs.writeFileSync(blocker, 'x');
    const badWorkspace = path.join(blocker, 'nested');
    const result = ingress.appendObservationBatch({ workspaceDir: badWorkspace, batch: validDeliveryBatch() });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('evidence_storage_failed');
    expect(result.nextAction).toContain('replay');
  });

  it('derives a stable scope id per workspace and distinct ids across workspaces', () => {
    const a1 = ingress.evidenceScopeIdFor(workspaceDir);
    const a2 = ingress.evidenceScopeIdFor(workspaceDir);
    expect(a1).toBe(a2);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iev-ingress-b-'));
    try {
      expect(ingress.evidenceScopeIdFor(other)).not.toBe(a1);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('maps a symlink alias of the same workspace to the same scope id', () => {
    // realpath normalization: the same state.db reached through two path
    // spellings must not fork the ledger into evidence_scope_mismatch.
    const link = `${workspaceDir}-link`;
    try {
      fs.symlinkSync(workspaceDir, link, 'junction');
    } catch {
      return; // symlink privileges unavailable on this runner — skip, not fail
    }
    try {
      expect(ingress.evidenceScopeIdFor(link)).toBe(ingress.evidenceScopeIdFor(workspaceDir));
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it('overrides the batch scope with the workspace-derived scope so the ledger stays single-scope', () => {
    seedActivation(workspaceDir, 'act-1');
    const first = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch() });
    expect(first.ok).toBe(true);
    // Same producer batch replayed — scope id differs in the payload but the
    // ingress rewrites it to the workspace scope, so replay stays idempotent.
    const second = ingress.appendObservationBatch({
      workspaceDir,
      batch: { ...validDeliveryBatch(), evidenceScopeId: 'producer-local-scope' },
    });
    expect(second.ok).toBe(true);
    expect(second.duplicateCount).toBe(1);
  });

  it('resolves the activation occurrence snapshot from activations + pi_artifacts', () => {
    seedActivation(workspaceDir, 'act-1');
    const ref = ingress.resolveActivationOccurrenceRef(workspaceDir, 'act-1');
    expect(ref).not.toBeNull();
    expect(ref?.activationId).toBe('act-1');
    expect(ref?.artifactId).toBe('art-1');
    expect(ref?.channel).toBe('prompt');
    expect(ref?.activatedAt).toBe('2026-10-01T00:00:00Z');
    expect(ref?.sourceSnapshotDigest.startsWith('sha256:')).toBe(true);
  });

  it('returns null (honest gap) for an unresolvable activation', () => {
    expect(ingress.resolveActivationOccurrenceRef(workspaceDir, 'act-missing')).toBeNull();
  });

  it('replaying the same batch after connection recycle is idempotent', () => {
    seedActivation(workspaceDir, 'act-1');
    ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch() });
    conn.close();
    conn = new SqliteConnection(workspaceDir);
    const replay = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch() });
    expect(replay.ok).toBe(true);
    expect(replay.insertedCount).toBe(0);
    expect(replay.duplicateCount).toBe(1);
  });
});
