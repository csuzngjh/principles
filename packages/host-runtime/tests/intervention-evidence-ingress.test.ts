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
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SqliteConnection } from '@principles/core/runtime-v2';
import {
  createInterventionEvidenceIngress,
  type InterventionIngressAppendResult,
} from '../src/intervention-evidence-ingress.js';

const ingress = createInterventionEvidenceIngress();

let workspaceDir = '';
let conn: SqliteConnection;

function validDeliveryBatch(evidenceScopeId = 'placeholder-overridden-by-ingress') {
  return {
    evidenceScopeId,
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
    const result = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)) });
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
      batch: { ...validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)), observations: [{ ...validDeliveryBatch().observations[0]!, payload: { targetKind: 'agent_context' } }] },
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
    const result = ingress.appendObservationBatch({ workspaceDir: badWorkspace, batch: validDeliveryBatch(ingress.evidenceScopeIdFor(badWorkspace)) });
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

  it('reuses the persisted scope after moving the workspace and accepts further writes', () => {
    const firstScope = ingress.evidenceScopeIdFor(workspaceDir);
    const first = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)) });
    expect(first.ok).toBe(true);

    conn.close();
    const movedDir = `${workspaceDir}-moved`;
    fs.renameSync(workspaceDir, movedDir);
    workspaceDir = movedDir;
    conn = new SqliteConnection(workspaceDir);

    expect(ingress.evidenceScopeIdFor(workspaceDir)).toBe(firstScope);
    const second = ingress.appendObservationBatch({
      workspaceDir,
      batch: {
        ...validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)),
        observations: [{ ...validDeliveryBatch().observations[0]!, observationKey: 'relocated-write' }],
      },
    });
    expect(second.ok).toBe(true);
    expect(second.insertedCount).toBe(1);
  });

  it('keeps first-scope creation consistent across simultaneous ingress workers', async () => {
    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { getInterventionEvidenceIngress } = await import('@principles/host-runtime');
        const ingress = getInterventionEvidenceIngress();
        const evidenceScopeId = ingress.evidenceScopeIdFor(workerData.workspaceDir);
        parentPort.postMessage({ ready: true, evidenceScopeId });
        await new Promise((resolve) => parentPort.once('message', resolve));
        const batch = JSON.parse(workerData.batchJson);
        batch.evidenceScopeId = evidenceScopeId;
        batch.observations[0].observationKey = workerData.observationKey;
        parentPort.postMessage({ done: true, evidenceScopeId, observationKey: workerData.observationKey, result: ingress.appendObservationBatch({ workspaceDir: workerData.workspaceDir, batch }) });
      })().catch((error) => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));
    `;
    const workerData = (observationKey: string) => ({
      workspaceDir,
      batchJson: JSON.stringify(validDeliveryBatch()),
      observationKey,
    });
    const workers = [
      new Worker(workerSource, { eval: true, workerData: workerData('concurrent-first-a') }),
      new Worker(workerSource, { eval: true, workerData: workerData('concurrent-first-b') }),
    ];
    const nextMessage = (worker: Worker) => new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with ${code}`)); });
    });
    try {
      const ready = await Promise.all(workers.map(nextMessage));
      expect(ready.map((message) => message.evidenceScopeId)).toEqual([ready[0]?.evidenceScopeId, ready[0]?.evidenceScopeId]);
      workers.forEach((worker) => worker.postMessage('append'));
      const completed = await Promise.all(workers.map(nextMessage));
      expect(completed.every((message) => message.done === true)).toBe(true);
      const results = completed.map((message) => message.result as InterventionIngressAppendResult);
      for (const [index, result] of results.entries()) {
        if (result.ok) {
          expect(result.insertedCount).toBe(1);
          continue;
        }
        expect(result.reason).toContain('evidence_storage_failed');
        const retryBatch = validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir));
        retryBatch.observations[0]!.observationKey = String(completed[index]?.observationKey);
        const retry = createInterventionEvidenceIngress().appendObservationBatch({
          workspaceDir,
          batch: retryBatch,
        });
        expect(retry.ok).toBe(true);
      }
      const scopeRows = conn.getDb().prepare('SELECT scope_id FROM intervention_evidence_scope').all();
      expect(scopeRows).toHaveLength(1);
      const recordCount = (conn.getDb().prepare('SELECT COUNT(*) AS n FROM intervention_evidence_records').get() as { n: number }).n;
      expect(recordCount).toBe(2);
    } finally {
      for (const worker of workers) await worker.terminate();
    }
  });

  it('does not cache a path candidate when reading an existing ledger temporarily fails', () => {
    conn.getDb().prepare('INSERT INTO intervention_evidence_scope (scope_id, established_at) VALUES (?, ?)')
      .run('persisted-scope-after-retry', '2026-10-01T00:00:00Z');
    conn.close();
    const stateDb = path.join(workspaceDir, '.pd', 'state.db');
    const backupDb = `${stateDb}.backup`;
    fs.renameSync(stateDb, backupDb);
    fs.writeFileSync(stateDb, 'temporarily unreadable database');
    try {
      const fallback = ingress.evidenceScopeIdFor(workspaceDir);
      expect(fallback).not.toBe('persisted-scope-after-retry');
    } finally {
      fs.rmSync(stateDb, { force: true });
      fs.renameSync(backupDb, stateDb);
    }
    expect(ingress.evidenceScopeIdFor(workspaceDir)).toBe('persisted-scope-after-retry');
    conn = new SqliteConnection(workspaceDir);
  });

  it('overrides the batch scope with the workspace-derived scope so the ledger stays single-scope', () => {
    seedActivation(workspaceDir, 'act-1');
    const first = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)) });
    expect(first.ok).toBe(true);
    const mismatchedScope = ingress.appendObservationBatch({
      workspaceDir,
      batch: { ...validDeliveryBatch(), evidenceScopeId: 'producer-local-scope' },
    });
    expect(mismatchedScope.ok).toBe(false);
    expect(mismatchedScope.reason).toContain('evidence_scope_mismatch');
    const second = ingress.appendObservationBatch({
      workspaceDir,
      batch: validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)),
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
    const contentRef = ingress.resolveInterventionContentRef(workspaceDir, ref!, 'T-01');
    expect(contentRef).toMatchObject({
      principleId: 'T-01', artifactId: 'art-1',
      payloadDigest: `sha256:${createHash('sha256').update(JSON.stringify({ text: '原则内容' })).digest('hex')}`,
      resolution: 'resolved',
    });
    expect(contentRef?.payloadDigest).not.toBe(ref?.sourceSnapshotDigest);
  });

  it('does not resolve content for an activation that references a missing artifact', () => {
    const c = new SqliteConnection(workspaceDir);
    c.getDb().prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at)
                       VALUES ('act-orphan', 'idem-orphan', 'art-missing', 'prompt', 'prompt_activate', 'ref', '2026-10-01T00:00:00Z')`).run();
    c.close();
    const activationRef = ingress.resolveActivationOccurrenceRef(workspaceDir, 'act-orphan');
    expect(activationRef).not.toBeNull();
    expect(activationRef?.sourceSnapshotDigest.startsWith('sha256:')).toBe(true);
    expect(ingress.resolveInterventionContentRef(workspaceDir, activationRef!, 'T-01')).toBeNull();
  });

  it('returns null (honest gap) for an unresolvable activation', () => {
    expect(ingress.resolveActivationOccurrenceRef(workspaceDir, 'act-missing')).toBeNull();
  });

  it('replaying the same batch after connection recycle is idempotent', () => {
    seedActivation(workspaceDir, 'act-1');
    ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)) });
    conn.close();
    conn = new SqliteConnection(workspaceDir);
    const replay = ingress.appendObservationBatch({ workspaceDir, batch: validDeliveryBatch(ingress.evidenceScopeIdFor(workspaceDir)) });
    expect(replay.ok).toBe(true);
    expect(replay.insertedCount).toBe(0);
    expect(replay.duplicateCount).toBe(1);
  });
});
