import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteApprovalQueueStore } from '../sqlite-approval-store.js';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteIntentDecisionStore } from '../../store/intent/sqlite-intent-decision-store.js';
import { computeArtifactDigest } from '../promotion-evidence-snapshot.js';
import { evaluateStrategicConflictGate } from '../../intent/strategic-conflict-gate.js';

/**
 * SIA v1.2 Phase 3 (SPEC §10.3 / §10.5, TECH §8.5) — the server-side approval
 * gate. Every case drives the REAL `SqliteApprovalQueueStore.approve()`
 * transaction (not a helper), because the requirement is precisely that no
 * approval entry point can bypass the gate.
 */

const TASK_ID = 'task-sia';
const RUN_ID = 'run-sia';
const LEGACY_ARTIFACT_ID = 'art-sia';

function v1Contract(): Record<string, unknown> {
  return {
    ownerIntent: 'Owner intent text',
    targetBehavior: 'Agent checks the anchor before acting',
    forbiddenBehavior: 'Agent acts without checking the anchor',
    evidenceSource: 'pain-1',
    validationExpectation: 'An evaluator observes the anchor check',
  };
}

function v2Contract(overrides: {
  conflictStatus?: 'none' | 'potential' | 'confirmed';
  relevance?: string;
  includeIntentHash?: boolean;
  omitStrategicAssessment?: boolean;
  conflicts?: unknown;
}): Record<string, unknown> {
  const contract: Record<string, unknown> = {
    ...v1Contract(),
    schemaVersion: 2,
  };
  if (overrides.omitStrategicAssessment !== true) {
    contract.strategicAssessment = {
      relevance: overrides.relevance ?? 'relevant',
      rationale: 'Stage A judged this pain relevant to the Owner intent',
      conflictStatus: overrides.conflictStatus ?? 'none',
      ...(overrides.conflicts !== undefined ? { conflicts: overrides.conflicts } : {}),
    };
  }
  if (overrides.includeIntentHash !== false) {
    contract.strategicIntent = {
      contentHash: 'sha256:intent-a',
      capturedAt: '2026-11-14T00:00:00.000Z',
    };
  }
  return contract;
}

interface SeededApproval {
  approvalId: string;
  artifactId: string;
  artifactDigest: string;
}

describe('SIA v1.2 — server-side strategic conflict approval gate', () => {
  let connection: SqliteConnection;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sia-gate-'));
    connection = new SqliteConnection(tmpDir);
    const db = connection.getDb();
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'scribe', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(TASK_ID);
    db.prepare("INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, 'internal', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(RUN_ID, TASK_ID);
    // principle_candidates FKs the legacy `artifacts` table, not pi_artifacts.
    db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, 'principle', '{}', '2026-01-01T00:00:00Z')").run(LEGACY_ARTIFACT_ID, RUN_ID, TASK_ID);
  });

  afterEach(() => {
    connection?.close();
  });

  function seedApproval(content: Record<string, unknown>, candidates: readonly string[]): SeededApproval {
    const db = connection.getDb();
    // REVIEW FIX (PR #2652 P0-1): the gate now resolves candidates through the
    // authoritative dreamer lineage, so the fixture must model the PRODUCTION
    // relation instead of the old (never-matching) `principle_candidates.artifact_id`
    // join: approval artifact → sourceTrace.dreamerArtifactId → dreamer task
    // (`dreamer-<candidateId>-<channel>`) → task seed `candidateId`.
    const [primaryCandidate] = candidates;
    if (primaryCandidate === undefined) throw new Error('seedApproval requires a candidate');
    const dreamerTaskId = `dreamer-${primaryCandidate}-prompt`;
    const dreamerArtifactId = `pi-art-${dreamerTaskId}-run_legacy`;
    db.prepare(
      "INSERT INTO tasks (task_id, task_kind, status, diagnostic_json, created_at, updated_at) VALUES (?, 'dreamer', 'succeeded', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run(dreamerTaskId, JSON.stringify({ candidateId: primaryCandidate }));
    db.prepare(
      "INSERT OR REPLACE INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'dreamer_seed', ?, '[]', 'pending', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run(dreamerArtifactId, dreamerTaskId);

    const contentWithTrace = { ...content, sourceTrace: { dreamerArtifactId } };
    const contentJson = JSON.stringify(contentWithTrace);
    db.prepare(
      "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'principle', ?, '[]', 'pending', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run(LEGACY_ARTIFACT_ID, TASK_ID, contentJson);
    let index = 0;
    for (const candidateId of candidates) {
      index += 1;
      // The legacy `artifacts` row is DELIBERATELY a different id from the
      // approval's pi artifact: this is what production looks like, and it is
      // what makes the old `principle_candidates.artifact_id = <pi id>` join
      // fail. The gate must still resolve the candidate through the dreamer
      // lineage above.
      const legacyArtifactId = `legacy-art-${candidateId}`;
      db.prepare(
        "INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, 'principle', '{}', '2026-01-01T00:00:00Z')",
      ).run(legacyArtifactId, RUN_ID, TASK_ID);
      db.prepare(
        "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')",
      ).run(candidateId, legacyArtifactId, TASK_ID, RUN_ID, `candidate ${index}`, 'desc', `idem-${candidateId}`);
    }
    return {
      approvalId: '',
      artifactId: LEGACY_ARTIFACT_ID,
      artifactDigest: computeArtifactDigest({
        artifactId: LEGACY_ARTIFACT_ID,
        artifactKind: 'principle',
        sourceTaskId: TASK_ID,
        lineageArtifactIds: [],
        validationStatus: 'pending',
        contentJson,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    };
  }

  async function enqueue(seed: SeededApproval, store: SqliteApprovalQueueStore): Promise<string> {
    const record = await store.enqueue({ artifactId: seed.artifactId, channel: 'prompt', riskLevel: 'high' }, '2026-11-14T00:00:00Z');
    return record.approvalId;
  }

  async function recordResolution(input: {
    artifactId: string;
    candidateId: string;
    ownerAction?: 'confirm_drift' | 'observe';
  }): Promise<void> {
    const store = new SqliteIntentDecisionStore(connection);
    const id = `decision-${input.candidateId}-${input.ownerAction ?? 'confirm_drift'}`;
    await store.record({
      id,
      taskId: TASK_ID,
      intentDocHash: 'sha256:intent-a',
      source: 'action_drift',
      evidenceStrength: 'strong',
      relatedIntentFields: ['non_negotiables'],
      ownerAction: input.ownerAction ?? 'confirm_drift',
      evidenceRefs: ['evidence-1'],
      artifactId: input.artifactId,
    });
    await store.updateFollowUp(id, { resultingCandidateId: input.candidateId });
  }

  function readApprovalStatus(approvalId: string): string {
    const row: unknown = connection.getDb().prepare('SELECT status FROM approvals WHERE approval_id = ?').get(approvalId);
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('missing approval row');
    const status = Reflect.get(row, 'status');
    return typeof status === 'string' ? status : '';
  }

  it('does not gate a V1 artifact (historical approvals keep working)', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v1Contract() }, ['cand-v1']);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(true);
  });

  it('does not gate a V2 artifact whose conflictStatus is none', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({}) }, ['cand-none']);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(true);
  });

  it('does not gate a V2 artifact whose conflictStatus is only potential', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'potential' }) }, ['cand-potential']);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(true);
  });

  it('refuses a confirmed conflict with no resolution BEFORE any write', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval(
      {
        intentContract: v2Contract({
          conflictStatus: 'confirmed',
          conflicts: [{ against: 'core_principle', ref: 'CP-002', status: 'confirmed', evidenceRefs: ['evidence-1'] }],
        }),
      },
      ['cand-confirmed'],
    );
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('strategic_conflict_unconfirmed');
    if (result.error !== 'strategic_conflict_unconfirmed') throw new Error(`unexpected error: ${result.error}`);
    expect(result.reason).toContain('no_effective_resolution');
    expect(result.reason).toContain('core_principle:CP-002');
    expect(readApprovalStatus(approvalId)).toBe('pending');
  });

  it('refuses a confirmed conflict whose resolution bound a different candidate', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-target']);
    const approvalId = await enqueue(seed, store);
    await recordResolution({ artifactId: seed.artifactId, candidateId: 'cand-other' });
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    expect(readApprovalStatus(approvalId)).toBe('pending');
  });

  it('refuses when the resolution was recorded for a different intent hash', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-hash']);
    const approvalId = await enqueue(seed, store);
    await recordResolution({ artifactId: seed.artifactId, candidateId: 'cand-hash' });
    // Owner edits INTENT.md afterwards: the old resolution must not survive the
    // new anchor hash.
    connection.getDb().prepare('UPDATE intent_decisions SET intent_doc_hash = ? WHERE resulting_candidate_id = ?').run('sha256:intent-b', 'cand-hash');
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    expect(readApprovalStatus(approvalId)).toBe('pending');
  });

  it('invalidates a resolution when the contract digest changes (re-scribe)', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-digest']);
    const approvalId = await enqueue(seed, store);
    await recordResolution({ artifactId: seed.artifactId, candidateId: 'cand-digest' });
    // A re-scribe rewrites the artifact: the approval is now bound to a new
    // digest, so the old resolution must stop applying.
    const rewritten = JSON.stringify({ intentContract: v2Contract({ conflictStatus: 'confirmed' }), reScribed: true });
    connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ?, updated_at = ? WHERE artifact_id = ?')
      .run(rewritten, '2026-11-14T00:00:01Z', seed.artifactId);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    expect(readApprovalStatus(approvalId)).toBe('pending');
  });

  it('allows the approval when a matching resolution exists', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-ok']);
    const approvalId = await enqueue(seed, store);
    await recordResolution({ artifactId: seed.artifactId, candidateId: 'cand-ok' });
    const result = await store.approve(approvalId, 'owner', 'Owner confirmed the drift');
    expect(result.ok).toBe(true);
    expect(readApprovalStatus(approvalId)).toBe('approved');
  });

  it('does not accept a non-confirming Owner action as a resolution', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-observe']);
    const approvalId = await enqueue(seed, store);
    await recordResolution({ artifactId: seed.artifactId, candidateId: 'cand-observe', ownerAction: 'observe' });
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
  });

  it('hard-fails a V2 claim that is not a complete contract', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ omitStrategicAssessment: true }) }, ['cand-malformed']);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error !== 'strategic_conflict_unconfirmed') throw new Error(`unexpected error: ${result.error}`);
    expect(result.reason).toContain('malformed_strategic_contract');
    expect(readApprovalStatus(approvalId)).toBe('pending');
  });

  it('refuses a confirmed conflict that carries no server intent reference', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed', includeIntentHash: false }) }, ['cand-nohash']);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error !== 'strategic_conflict_unconfirmed') throw new Error(`unexpected error: ${result.error}`);
    expect(result.reason).toContain('missing_intent_reference');
  });

  it('binds the recorded resolution digest to the artifact SERVER-side (no client input)', async () => {
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-digest-bind']);
    const store = new SqliteIntentDecisionStore(connection);
    await store.record({
      id: 'decision-forged-digest',
      taskId: TASK_ID,
      intentDocHash: 'sha256:intent-a',
      source: 'action_drift',
      evidenceStrength: 'strong',
      relatedIntentFields: ['non_negotiables'],
      ownerAction: 'confirm_drift',
      evidenceRefs: ['evidence-1'],
      artifactId: seed.artifactId,
      // A client-supplied digest must be ignored (not part of the input type).
      contractDigest: 'sha256:forged',
    } as never);
    const row: unknown = connection.getDb().prepare('SELECT contract_digest FROM intent_decisions WHERE id = ?').get('decision-forged-digest');
    expect(row).toEqual({ contract_digest: seed.artifactDigest });
  });

  it('restores the contract_digest column on a database created before it existed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sia-migrate-'));
    const first = new SqliteConnection(tmpDir);
    // Simulate the pre-SIA schema: neither the column nor the digest-aware
    // unique index existed (SQLite refuses to drop a column an index uses).
    first.getDb().exec('DROP INDEX IF EXISTS idx_intent_decisions_pain_hash_action');
    first.getDb().exec('ALTER TABLE intent_decisions DROP COLUMN contract_digest');
    first.close();

    const reopened = new SqliteConnection(tmpDir);
    try {
      const columns: unknown = reopened.getDb().prepare('PRAGMA table_info(intent_decisions)').all();
      expect(Array.isArray(columns)).toBe(true);
      const names = (columns as unknown[])
        .map((column) => (column !== null && typeof column === 'object' ? Reflect.get(column, 'name') : undefined))
        .filter((name): name is string => typeof name === 'string');
      expect(names).toContain('contract_digest');
      // The digest-aware identity index is recreated as well.
      const indexSql: unknown = reopened.getDb().prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_intent_decisions_pain_hash_action'",
      ).get();
      expect(JSON.stringify(indexSql)).toContain('contract_digest');
    } finally {
      reopened.close();
    }
  });

  it('is atomic under concurrent approvals: exactly one write wins', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-race']);
    const approvalId = await enqueue(seed, store);
    await recordResolution({ artifactId: seed.artifactId, candidateId: 'cand-race' });
    const results = await Promise.all([
      store.approve(approvalId, 'owner', 'first'),
      store.approve(approvalId, 'owner', 'second'),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(readApprovalStatus(approvalId)).toBe('approved');
  });

  // ── P0-4: an incomplete / corrupted V2 claim must fail closed ──────────────
  // The old predicate only matched `schemaVersion === 2`, so an incomplete V2
  // silently fell into the V1 compatibility path and was approvable.
  // Contracts with NO V2-exclusive key stay on the legacy V1 path (SIA only
  // governs V2), including a partial V1 written before SIA existed.

  async function expectBlockedWith(content: Record<string, unknown>, reason: string, candidates: string[]): Promise<void> {
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval(content, candidates);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('strategic_conflict_unconfirmed');
    if (result.error !== 'strategic_conflict_unconfirmed') throw new Error(`unexpected error: ${result.error}`);
    expect(result.reason).toContain(reason);
    expect(readApprovalStatus(approvalId)).toBe('pending');
  }

  it('refuses a V2-shaped contract that omitted schemaVersion', async () => {
    const contract = v2Contract({});
    delete contract.schemaVersion;
    await expectBlockedWith({ intentContract: contract }, 'malformed_strategic_contract', ['cand-noschema']);
  });

  it('refuses an illegal schemaVersion instead of reading it as V1', async () => {
    await expectBlockedWith(
      { intentContract: { ...v1Contract(), schemaVersion: 3 } },
      'malformed_strategic_contract',
      ['cand-badschema'],
    );
  });

  it('refuses a V2 that is missing strategicAssessment', async () => {
    await expectBlockedWith(
      { intentContract: { ...v1Contract(), schemaVersion: 2 } },
      'malformed_strategic_contract',
      ['cand-noassessment'],
    );
  });

  it('refuses an illegal conflictStatus', async () => {
    const contract = v2Contract({});
    contract.strategicAssessment = {
      relevance: 'relevant',
      rationale: 'Stage A judged this pain relevant',
      conflictStatus: 'probably',
    };
    await expectBlockedWith({ intentContract: contract }, 'malformed_strategic_contract', ['cand-badstatus']);
  });

  it('keeps a legacy contract without any V2 key outside the SIA gate', async () => {
    // A pre-SIA artifact may carry a partial V1 contract. It makes no V2 claim,
    // so the strategic gate has no jurisdiction and must not freeze it.
    const store = new SqliteApprovalQueueStore(connection);
    const seed = seedApproval({ intentContract: { ownerIntent: 'legacy' } }, ['cand-legacycontract']);
    const approvalId = await enqueue(seed, store);
    const result = await store.approve(approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(true);
  });

  it('refuses a non-object intentContract', async () => {
    await expectBlockedWith({ intentContract: 'schemaVersion: 2' }, 'malformed_strategic_contract', ['cand-stringcontract']);
  });

  it('refuses an artifact whose content body cannot be parsed', async () => {
    const db = connection.getDb();
    const contentJson = '{"intentContract": {"schemaVersion": 2,';
    db.prepare(
      "INSERT OR REPLACE INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'principle', ?, '[]', 'pending', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).run(LEGACY_ARTIFACT_ID, TASK_ID, contentJson);
    const store = new SqliteApprovalQueueStore(connection);
    const record = await store.enqueue(
      { artifactId: LEGACY_ARTIFACT_ID, channel: 'prompt', riskLevel: 'high' },
      '2026-11-14T00:00:00Z',
    );
    const result = await store.approve(record.approvalId, 'owner', 'LGTM');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error !== 'strategic_conflict_unconfirmed') throw new Error(`unexpected error: ${result.error}`);
    expect(result.reason).toContain('unreadable_artifact_content');
    expect(readApprovalStatus(record.approvalId)).toBe('pending');
  });

  // ── P0-3: a recorded decision never migrates to a revised contract ─────────

  function decisionInput(id: string, artifactId: string): Parameters<SqliteIntentDecisionStore['record']>[0] {
    return {
      id,
      taskId: TASK_ID,
      intentDocHash: 'sha256:intent-a',
      source: 'action_drift',
      evidenceStrength: 'strong',
      relatedIntentFields: ['non_negotiables'],
      ownerAction: 'confirm_drift',
      evidenceRefs: ['evidence-1'],
      artifactId,
    };
  }

  function rewriteArtifactContract(artifactId: string, contract: Record<string, unknown>, revision: string): void {
    const row: unknown = connection.getDb()
      .prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?').get(artifactId);
    const raw = row !== null && typeof row === 'object' && !Array.isArray(row) ? Reflect.get(row, 'content_json') : undefined;
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : {};
    const next = { ...(parsed as Record<string, unknown>), intentContract: contract, revision };
    connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?')
      .run(JSON.stringify(next), artifactId);
  }

  async function enqueueOn(
    seed: SeededApproval,
    store: SqliteApprovalQueueStore,
    channel: Parameters<SqliteApprovalQueueStore['enqueue']>[0]['channel'],
  ): Promise<string> {
    const record = await store.enqueue({ artifactId: seed.artifactId, channel, riskLevel: 'high' }, '2026-11-14T00:00:00Z');
    return record.approvalId;
  }

  it('scenario A: the old decision stays on D0 and D1 is refused', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const decisions = new SqliteIntentDecisionStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-a']);
    const approvalId = await enqueue(seed, store);

    const first = await decisions.record(decisionInput('decision-A', seed.artifactId));
    expect(first.created).toBe(true);
    expect(first.record.contractDigest).toBe(seed.artifactDigest);
    const bound = await decisions.updateFollowUp('decision-A', { resultingCandidateId: 'cand-a' });
    expect(bound.ok).toBe(true);

    const approved = await store.approve(approvalId, 'owner', 'LGTM');
    expect(approved.ok).toBe(true);

    // Revise the Scribe artifact: same artifact id, different contract body.
    rewriteArtifactContract(seed.artifactId, v2Contract({ conflictStatus: 'confirmed' }), 'D1');
    const nextApproval = await enqueueOn(seed, store, 'skill');

    // Replaying the SAME decision id must not migrate it to D1.
    const replay = await decisions.record(decisionInput('decision-A', seed.artifactId));
    expect(replay.created).toBe(false);
    expect(replay.conflict?.reason).toBe('contract_digest_mismatch');
    expect(replay.record.contractDigest).toBe(seed.artifactDigest);

    // D1 therefore stays blocked; the old decision resolves D0 only.
    const blocked = await store.approve(nextApproval, 'owner', 'LGTM');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    if (blocked.error !== 'strategic_conflict_unconfirmed') throw new Error(`unexpected error: ${blocked.error}`);
    expect(blocked.reason).toContain('no_effective_resolution');
  });

  it('scenario B: a NEW decision for D1 resolves the revised contract', async () => {
    const store = new SqliteApprovalQueueStore(connection);
    const decisions = new SqliteIntentDecisionStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-b']);
    await enqueue(seed, store);

    const first = await decisions.record(decisionInput('decision-D0', seed.artifactId));
    expect(first.created).toBe(true);

    // A revision that keeps the lineage but changes the contract body.
    rewriteArtifactContract(seed.artifactId, v2Contract({ conflictStatus: 'confirmed' }), 'D1');
    const approvalId = await enqueueOn(seed, store, 'skill');

    // Same key, different contract → a genuinely new decision row.
    const second = await decisions.record(decisionInput('decision-D1', seed.artifactId));
    expect(second.created).toBe(true);
    expect(second.record.contractDigest).not.toBe(first.record.contractDigest);
    const bound = await decisions.updateFollowUp('decision-D1', { resultingCandidateId: 'cand-b' });
    expect(bound.ok).toBe(true);

    const approved = await store.approve(approvalId, 'owner', 'LGTM');
    expect(approved.ok).toBe(true);

    // Both decisions survive as independent audit rows.
    const all = await decisions.listByTaskId(TASK_ID);
    expect(all.map((record) => record.id).sort()).toEqual(['decision-D0', 'decision-D1']);
  });

  it('scenario C: concurrent identical submissions produce exactly one audit row', async () => {
    const decisions = new SqliteIntentDecisionStore(connection);
    const seed = seedApproval({ intentContract: v2Contract({ conflictStatus: 'confirmed' }) }, ['cand-c']);
    const results = await Promise.all([
      decisions.record({ ...decisionInput('decision-race-1', seed.artifactId), painId: 'pain-race' }),
      decisions.record({ ...decisionInput('decision-race-2', seed.artifactId), painId: 'pain-race' }),
    ]);
    // The unique index picks one winner; the loser adopts it instead of failing.
    expect(results.map((result) => result.record.id)).toEqual(['decision-race-1', 'decision-race-1']);
    const count: unknown = connection.getDb().prepare(
      'SELECT COUNT(*) AS cnt FROM intent_decisions WHERE pain_id = ?',
    ).get('pain-race');
    expect(count).toEqual({ cnt: 1 });
  });

  it('keeps the gate verdict identical for legacy artifacts with a malformed content body', async () => {
    const result = evaluateStrategicConflictGate({
      artifactContent: 'not-an-object',
      artifactDigest: 'sha256:x',
      candidateIds: [],
      resolutions: [],
    });
    expect(result.ok).toBe(true);
  });
});
