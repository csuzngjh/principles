/**
 * SIA v1.2 — Approval GROUP must never share one artifact's verdict.
 *
 * Owner wrap-up requirement (PR #2652): two artifacts in the SAME group, with
 * different strategic-conflict states, must render independently — and a
 * resolution recorded for one must not change the other.
 *
 * The fixture is a REAL ledger integration: `<workspace>/.state` is written by
 * `PrincipleTreeLedgerAdapter.writeProbationEntry`, both scribe artifacts share
 * one candidate lineage (`candidate://cand-shared`), and the grouped model
 * resolves the ledger principle through the production resolver — so the two
 * approvals genuinely land in ONE group keyed by a ledger-validated principle.
 */
import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { computeArtifactDigest, PrincipleTreeLedgerAdapter, SqliteConnection } from '@principles/core/runtime';
import { ApprovalsGroupedConsoleModel } from '../../src/server/models/ApprovalsGroupedConsoleModel.js';

const NOW = '2026-11-15T00:00:00.000Z';
const CANDIDATE_ID = 'cand-shared';
const PRINCIPLE_ID = '11111111-1111-4111-8111-111111111111';
const INTENT_HASH = 'sha256:intent-shared';
const DREAMER_TASK_ID = 'dreamer-shared';
const DREAMER_ARTIFACT_ID = 'pi-art-dreamer-shared';

const STATUS_COPY = {
  confirmed: 'Do not drop the strategic non-negotiable.',
  none: 'Confirmed conflict copy.',
} as const;

type ConflictStatus = keyof typeof STATUS_COPY;

function v2Contract(status: ConflictStatus): Record<string, unknown> {
  return {
    ownerIntent: STATUS_COPY[status],
    targetBehavior: `behavior for ${status}`,
    forbiddenBehavior: `forbidden for ${status}`,
    evidenceSource: 'pain-1',
    validationExpectation: 'An evaluator observes the check.',
    schemaVersion: 2,
    strategicIntent: { contentHash: INTENT_HASH, capturedAt: NOW },
    strategicAssessment: {
      relevance: 'relevant',
      rationale: 'Stage A bound this pain to the non_negotiables section.',
      conflictStatus: status,
      ...(status === 'confirmed'
        ? { conflicts: [{ against: 'core_principle', ref: 'CP-002', status: 'confirmed', evidenceRefs: ['evidence-1'] }] }
        : {}),
    },
    corePrincipleRefs: ['CP-002'],
  };
}

function seedWorkspace(aStatus: ConflictStatus, bStatus: ConflictStatus): {
  readonly workspaceDir: string;
  readonly conn: SqliteConnection;
  readonly artifactA: { id: string; digest: string };
  readonly artifactB: { id: string; digest: string };
} {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sia-group-'));
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  // REAL ledger: one principle derived from the shared candidate.
  const ledger = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
  ledger.writeProbationEntry({
    id: PRINCIPLE_ID,
    title: 'Shared strategic principle',
    text: 'Check the non-negotiable before acting.',
    triggerPattern: 'before_tool_call',
    action: 'inject review note',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: `candidate://${CANDIDATE_ID}`,
    createdAt: NOW,
  });

  const conn = new SqliteConnection({ workspaceDir });
  const db = conn.getDb();
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('diag-shared', 'diagnostician', 'succeeded', ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES ('run-shared', 'diag-shared', 'internal', 'succeeded', ?, ?, ?)").run(NOW, NOW, NOW);
  db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES ('legacy-art-shared', 'run-shared', 'diag-shared', 'principle', '{}', ?)").run(NOW);
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, diagnostic_json, created_at, updated_at) VALUES (?, 'dreamer', 'succeeded', ?, ?, ?)")
    .run(DREAMER_TASK_ID, JSON.stringify({ candidateId: CANDIDATE_ID, dependencyTaskIds: ['diag-shared'] }), NOW, NOW);
  db.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'dreamer_seed', ?, '[]', 'pending', '{}', ?, ?)")
    .run(DREAMER_ARTIFACT_ID, DREAMER_TASK_ID, NOW, NOW);
  db.prepare("INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, recommendation_kind, title, description, idempotency_key, created_at) VALUES (?, 'legacy-art-shared', 'diag-shared', 'run-shared', 'prompt', 'Shared candidate', 'desc', 'idem-shared', ?)")
    .run(CANDIDATE_ID, NOW);

  const seedArtifact = (suffix: 'a' | 'b', status: ConflictStatus) => {
    const artifactId = `pi-art-${suffix}`;
    const taskId = `scribe-${suffix}`;
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, diagnostic_json, created_at, updated_at) VALUES (?, 'scribe', 'succeeded', ?, ?, ?)")
      .run(taskId, JSON.stringify({ dependencyTaskIds: [DREAMER_TASK_ID] }), NOW, NOW);
    const contentJson = JSON.stringify({
      principleDraft: { title: `Candidate ${suffix}`, statement: `statement ${suffix}` },
      intentContract: v2Contract(status),
      sourceTrace: { dreamerArtifactId: DREAMER_ARTIFACT_ID },
    });
    db.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'principle', ?, '[]', 'pending', ?, ?, ?)")
      .run(artifactId, taskId, contentJson, NOW, NOW);
    db.prepare("INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason) VALUES (?, ?, 'defer_archive', 'low', 'pending', 0.85, ?, ?, 'seed')")
      .run(`apr-${suffix}`, artifactId, NOW, `approval ${suffix}`);
    const digest = computeArtifactDigest({
      artifactId,
      artifactKind: 'principle',
      sourceTaskId: taskId,
      lineageArtifactIds: [],
      validationStatus: 'pending',
      contentJson,
      createdAt: NOW,
      updatedAt: NOW,
    });
    return { id: artifactId, digest };
  };

  return { workspaceDir, conn, artifactA: seedArtifact('a', aStatus), artifactB: seedArtifact('b', bStatus) };
}

function cleanup(fixture: { workspaceDir: string; conn: SqliteConnection }): void {
  try { fixture.conn.close(); } catch { /* ignore */ }
  try { fs.rmSync(fixture.workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function readGroup(fixture: { workspaceDir: string }) {
  const model = new ApprovalsGroupedConsoleModel(fixture.workspaceDir);
  const { groups } = await model.getApprovalsGrouped();
  const group = groups.find((entry) => entry.records.some((record) => record.artifactId === 'pi-art-a'));
  if (group === undefined) throw new Error('shared group not found');
  return group;
}

describe('SIA approval group — two artifacts, independent verdicts', () => {
  it('A confirmed / B none: A is blocked, B is approvable; resolving A leaves B untouched', async () => {
    const fixture = seedWorkspace('confirmed', 'none');
    try {
      const group = await readGroup(fixture);
      // Both approvals really share the SAME ledger group key.
      expect(group.records.map((record) => record.artifactId).sort()).toEqual(['pi-art-a', 'pi-art-b']);
      expect(group.principleId).toBe(PRINCIPLE_ID);

      const recordA = group.records.find((record) => record.artifactId === fixture.artifactA.id);
      const recordB = group.records.find((record) => record.artifactId === fixture.artifactB.id);
      expect(recordA?.strategicConflict?.conflictStatus).toBe('confirmed');
      expect(recordA?.approveBlock?.code).toBe('strategic_conflict_unconfirmed');
      expect(recordB?.strategicConflict?.conflictStatus).toBe('none');
      expect(recordB?.approveBlock).toBeUndefined();

      fixture.conn.getDb().prepare(
        `INSERT INTO intent_decisions (id, task_id, intent_doc_hash, source, evidence_strength, related_intent_fields, owner_action, evidence_refs, source_snapshot, evidence_strength_snapshot, related_intent_fields_snapshot, evidence_refs_snapshot, resulting_candidate_id, contract_digest, created_at)
         VALUES ('decision-a', 'scribe-a', ?, 'action_drift', 'strong', '["non_negotiables"]', 'confirm_drift', '["evidence-1"]', 'action_drift', 'strong', '["non_negotiables"]', '["evidence-1"]', ?, ?, ?)`,
      ).run(INTENT_HASH, CANDIDATE_ID, fixture.artifactA.digest, NOW);

      const after = await readGroup(fixture);
      const solvedA = after.records.find((record) => record.artifactId === fixture.artifactA.id);
      const unchangedB = after.records.find((record) => record.artifactId === fixture.artifactB.id);
      expect(solvedA?.strategicConflict?.resolved).toBe(true);
      expect(solvedA?.approveBlock).toBeUndefined();
      expect(unchangedB?.strategicConflict?.conflictStatus).toBe('none');
      // Strongest invariance: B's ENTIRE verdict is byte-identical to before.
      expect(unchangedB?.strategicConflict).toEqual(recordB?.strategicConflict);
      expect(unchangedB?.approveBlock).toBeUndefined();
    } finally {
      cleanup(fixture);
    }
  });

  it('reverse: A none / B confirmed: only B is blocked and only B changes after resolution', async () => {
    const fixture = seedWorkspace('none', 'confirmed');
    try {
      const group = await readGroup(fixture);
      const recordA = group.records.find((record) => record.artifactId === fixture.artifactA.id);
      const recordB = group.records.find((record) => record.artifactId === fixture.artifactB.id);
      expect(recordA?.strategicConflict?.conflictStatus).toBe('none');
      expect(recordA?.approveBlock).toBeUndefined();
      expect(recordB?.strategicConflict?.conflictStatus).toBe('confirmed');
      expect(recordB?.approveBlock?.code).toBe('strategic_conflict_unconfirmed');

      fixture.conn.getDb().prepare(
        `INSERT INTO intent_decisions (id, task_id, intent_doc_hash, source, evidence_strength, related_intent_fields, owner_action, evidence_refs, source_snapshot, evidence_strength_snapshot, related_intent_fields_snapshot, evidence_refs_snapshot, resulting_candidate_id, contract_digest, created_at)
         VALUES ('decision-b', 'scribe-b', ?, 'action_drift', 'strong', '["non_negotiables"]', 'confirm_drift', '["evidence-1"]', 'action_drift', 'strong', '["non_negotiables"]', '["evidence-1"]', ?, ?, ?)`,
      ).run(INTENT_HASH, CANDIDATE_ID, fixture.artifactB.digest, NOW);

      const after = await readGroup(fixture);
      const unchangedA = after.records.find((record) => record.artifactId === fixture.artifactA.id);
      const solvedB = after.records.find((record) => record.artifactId === fixture.artifactB.id);
      expect(unchangedA?.strategicConflict?.conflictStatus).toBe('none');
      expect(unchangedA?.strategicConflict).toEqual(recordA?.strategicConflict);
      expect(solvedB?.strategicConflict?.resolved).toBe(true);
      expect(solvedB?.approveBlock).toBeUndefined();
    } finally {
      cleanup(fixture);
    }
  });
});
