/**
 * Phase 7.2 P1-01 — SqliteCandidateStore recordOwnerDecision /
 * completeOwnerDecision REFUSED branches (codecov patch gap; the happy paths
 * run through the real manager in owner-decision-lifecycle.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

import { buildOwnerDecisionIntent } from '../../src/runtime/store/candidate/admission-document.js';
import { RuntimeStateManager } from '../../src/runtime/store/runtime-state-manager.js';

describe('Phase 7.2 P1-01 — Owner decision store refused branches (real SQLite)', () => {
  let workspaceDir: string;
  let stateManager: RuntimeStateManager;
  const intent = () => buildOwnerDecisionIntent({
    candidateId: 'c1', decision: 'create',
    ownerId: 'o', identitySource: 'env', reason: 'r',
  });

  beforeEach(async () => {
    workspaceDir = join(process.env.TEMP ?? '.', `pd-owner-store-${randomUUID()}`);
    mkdirSync(join(workspaceDir, '.pd'), { recursive: true });
    stateManager = new RuntimeStateManager({ workspaceDir });
    await stateManager.initialize();
  });

  afterEach(() => {
    try { stateManager.close(); } catch { /* best effort */ }
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function corruptAdmission(candidateId: string): void {
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      db.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?').run('{corrupt', candidateId);
    } finally {
      db.close();
    }
  }

  it('recordOwnerDecision: unknown candidate refuses', async () => {
    const out = await stateManager.recordOwnerDecision('no-such-candidate', intent());
    expect(out).toMatchObject({ status: 'refused', reason: 'candidate_not_found' });
  });

  it('recordOwnerDecision: unreadable admission document refuses with the parse reason', async () => {
    const { candidateId } = // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    await seedBareCandidate();
    corruptAdmission(candidateId);
    const out = await stateManager.recordOwnerDecision(candidateId, intent());
    expect(out).toMatchObject({ status: 'refused', reason: 'admission_json_unparseable' });
  });

  it('recordOwnerDecision: document that would exceed the size cap refuses (admission_json_size_exceeded)', async () => {
    const { candidateId } = // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    await seedBareCandidate();
    // Stuff the history near the cap so the serialized document overflows.
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    const huge = 'x'.repeat(95_000);
    try {
      db.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?')
        .run(JSON.stringify({ schemaVersion: 1, evaluations: [], currentEvaluationId: null, processing: { state: 'not_started', attempts: 0, lastFailure: { reason: huge, nextAction: huge, at: huge } } }), candidateId);
    } finally {
      db.close();
    }
    const out = await stateManager.recordOwnerDecision(candidateId, intent());
    expect(out).toMatchObject({ status: 'refused', reason: 'admission_json_size_exceeded' });
  });

  it('completeOwnerDecision: unknown candidate refuses', async () => {
    const out = await stateManager.completeOwnerDecision('no-such-candidate', 'od_x', { resultingPrincipleId: 'p' });
    expect(out).toMatchObject({ status: 'refused', reason: 'candidate_not_found' });
  });

  it('completeOwnerDecision: unreadable admission document refuses', async () => {
    const { candidateId } = // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    await seedBareCandidate();
    corruptAdmission(candidateId);
    const out = await stateManager.completeOwnerDecision(candidateId, 'od_x', { resultingPrincipleId: 'p' });
    expect(out).toMatchObject({ status: 'refused', reason: 'admission_json_unparseable' });
  });

  it('completeOwnerDecision: unknown decisionId refuses', async () => {
    const { candidateId } = // eslint-disable-next-line @typescript-eslint/no-use-before-define -- seeder is kept beside the describe body it serves
    await seedBareCandidate();
    const out = await stateManager.completeOwnerDecision(candidateId, 'od_missing', { resultingPrincipleId: 'p' });
    expect(out).toMatchObject({ status: 'refused', reason: 'owner_decision_not_found' });
  });

  /** A pending candidate row with no admission content (parse returns null). */
  async function seedBareCandidate(): Promise<{ candidateId: string }> {
    const candidateId = randomUUID();
    const artifactId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    // Minimal lineage rows (FK cascade) + the candidate, mirroring the
    // park-persistence fixture; admission_json stays NULL.
    await stateManager.taskStore.createTask({
      taskId, taskKind: 'diagnostician', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      leaseOwner: undefined, leaseExpiresAt: undefined, lastError: undefined,
      inputRef: `pain-${candidateId}`, resultRef: '',
      diagnosticJson: JSON.stringify({ sourcePainId: `pain-${candidateId}` }),
    });
    await stateManager.runStore.createRun({
      runId, taskId, runtimeKind: 'openclaw', attemptNumber: 1, executionStatus: 'succeeded',
      startedAt: now, endedAt: now, outputPayload: '{}',
    });
    const db = new Database(join(workspaceDir, '.pd', 'state.db'));
    try {
      db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(artifactId, runId, taskId, 'diagnostician_output', '{}', now);
      db.prepare("INSERT INTO commits (commit_id, task_id, run_id, artifact_id, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, 'committed', ?)")
        .run(randomUUID(), taskId, runId, artifactId, `c-${artifactId}`, now);
      db.prepare(`INSERT INTO principle_candidates
        (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence,
         source_recommendation_json, idempotency_key, status, created_at, recommendation_kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'principle')`)
        .run(candidateId, artifactId, taskId, runId, 'seeded', 'seeded', 0.9, '{}', `k-${artifactId}`, now);
    } finally {
      db.close();
    }
    return { candidateId };
  }
});
