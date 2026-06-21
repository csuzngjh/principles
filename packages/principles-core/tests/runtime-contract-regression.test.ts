/**
 * Runtime Contract Reverse-Regression Tests — MVP Release Quality Task 17
 *
 * Reverse-regression tests for high-recurrence ERR patterns (ERR-001/002/008/048).
 * Each test deliberately violates a Runtime Contract rule and verifies the
 * defense mechanism catches it. If the defense breaks, the test fails —
 * preventing silent regression of the safeguards themselves.
 *
 * Pattern: "deliberately violate → should be caught"
 *
 * ERR checklist (considered + how avoided):
 * - ERR-001 (EP-01): `as` cast bypassing validation. Defense under test:
 *   DiagnosticianOutputV1Schema via Value.Check + SqliteDiagnosticianCommitter
 *   rejects malformed output even when the caller uses `as DiagnosticianOutputV1`.
 * - ERR-002 (EP-03): catch-and-degrade without reason. Defense under test:
 *   ApprovalCompletionService + ActivationDispatcher degraded results carry
 *   non-empty reason + nextAction (Runtime Contract Rule 9).
 * - ERR-008 (EP-07): cross-task lineage pollution. Defense under test:
 *   ActivationDispatcher refuses with approval_artifact_mismatch when the
 *   dispatch artifactId differs from the approved artifactId.
 * - ERR-048 (EP-02): activation write/read path inconsistency. Defense under
 *   test: SqliteActivationStateStore read methods return exactly the fields
 *   written by recordActivation (snake_case columns ↔ camelCase record).
 *
 * Uses real SQLite stores for ERR-001/008/048 (no mocks of the production
 * path). ERR-002 uses a MemoryApprovalQueueStore subclass whose getById
 * throws — the test target is the SERVICE catch-and-degrade behavior, not
 * the store, so a simulated store failure is the appropriate trigger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DiagnosticianOutputV1Schema,
  SqliteDiagnosticianCommitter,
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  ActivationDispatcher,
  ApprovalCompletionService,
  PromptWriter,
  MemoryApprovalQueueStore,
  MemoryActivationStateStore,
  MemoryArtifactReadModel,
  makeIdempotencyKey,
  PDRuntimeError,
} from '../src/runtime-v2/index.js';
import type {
  PIArtifactSnapshot,
  ApprovalRecord,
  ActivationStatusRecord,
} from '../src/runtime-v2/index.js';
import type { DiagnosticianOutputV1 } from '../src/runtime-v2/diagnostician-output.js';

// ── Test workspace setup (real SQLite, no mocks) ────────────────────────────

interface TestWorkspace {
  workspaceDir: string;
  connection: SqliteConnection;
  approvalStore: SqliteApprovalQueueStore;
  stateStore: SqliteActivationStateStore;
  committer: SqliteDiagnosticianCommitter;
  cleanup: () => void;
}

function createTestWorkspace(): TestWorkspace {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-err-regression-'));
  fs.mkdirSync(path.join(tmpDir, '.pd'), { recursive: true });

  const connection = new SqliteConnection({ workspaceDir: tmpDir });
  connection.getDb(); // trigger schema init

  return {
    workspaceDir: tmpDir,
    connection,
    approvalStore: new SqliteApprovalQueueStore(connection),
    stateStore: new SqliteActivationStateStore(connection),
    committer: new SqliteDiagnosticianCommitter(connection),
    cleanup: () => {
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PRINCIPLE_ID = 'principle-err-reg-001';
const PRINCIPLE_TEXT = 'Always read existing implementation before adding a parallel module';

function createPrincipleArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-err-reg-001',
    artifactKind: 'principle',
    sourceTaskId: 'task-pain-err-reg-001',
    sourcePrincipleId: PRINCIPLE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: PRINCIPLE_ID,
      text: PRINCIPLE_TEXT,
      language: 'en',
    }),
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A valid DiagnosticianOutputV1 used as the baseline for constructing
 * malformed variants. Fields conform to DiagnosticianOutputV1Schema.
 */
function createValidDiagnosticianOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-err-reg-001',
    summary: 'Agent duplicated a module without reading existing code',
    rootCause: 'Design: no pre-check before parallel module creation',
    violatedPrinciples: [
      { rationale: 'Read before write' },
    ],
    evidence: [
      { sourceRef: 'src/foo.ts', note: 'duplicated bar module' },
    ],
    recommendations: [
      { kind: 'principle', description: 'Read existing implementation first', abstractedPrinciple: 'Read before write' },
    ],
    confidence: 0.85,
  };
}

// ── ERR-001: `as` cast bypassing validation → schema rejects ────────────────

describe('ERR-001 reverse-regression: `as` cast cannot bypass schema validation', () => {
  it('Value.Check rejects a DiagnosticianOutputV1 missing required fields, even when cast with `as`', () => {
    // Deliberate violation: construct a malformed output (only `valid` present,
    // missing diagnosisId/summary/rootCause/violatedPrinciples/evidence/
    // recommendations/confidence) and use `as DiagnosticianOutputV1` to bypass
    // TypeScript. The runtime schema validator must still reject it.
    const malformed = { valid: true } as DiagnosticianOutputV1; // runtime-contract:exempt ERR-001 deliberate type violation to test runtime contract enforcement

    // The defense: Value.Check performs runtime structural validation
    expect(Value.Check(DiagnosticianOutputV1Schema, malformed)).toBe(false);
  });

  it('Value.Check rejects a DiagnosticianOutputV1 with wrong field type (confidence as string)', () => {
    // Deliberate violation: confidence is the string "0.85" instead of number.
    // `as unknown as` is the strongest assertion bypass — runtime validation
    // must still catch the type mismatch.
    const malformed = {
      ...createValidDiagnosticianOutput(),
      confidence: '0.85',
    } as unknown as DiagnosticianOutputV1; // runtime-contract:exempt ERR-001 deliberate type violation to test runtime contract enforcement

    expect(Value.Check(DiagnosticianOutputV1Schema, malformed)).toBe(false);
  });

  it('SqliteDiagnosticianCommitter.commit throws PDRuntimeError{input_invalid} for malformed output cast with `as`', async () => {
    const ws = createTestWorkspace();
    try {
      // Deliberate violation: `as` bypass — commit a malformed output that
      // TypeScript thinks is DiagnosticianOutputV1 but is not.
      const malformed = { valid: true } as DiagnosticianOutputV1; // runtime-contract:exempt ERR-001 deliberate type violation to test runtime contract enforcement

      // The defense: committer validates via Value.Check before any DB write
      // and throws PDRuntimeError with category 'input_invalid'.
      await expect(
        ws.committer.commit({
          runId: 'run-err-reg-001',
          taskId: 'task-err-reg-001',
          output: malformed,
          idempotencyKey: 'idem-err-reg-001',
        }),
      ).rejects.toBeInstanceOf(PDRuntimeError);

      await expect(
        ws.committer.commit({
          runId: 'run-err-reg-001b',
          taskId: 'task-err-reg-001',
          output: malformed,
          idempotencyKey: 'idem-err-reg-001b',
        }),
      ).rejects.toHaveProperty('category', 'input_invalid');
    } finally {
      ws.cleanup();
    }
  });

  it('a valid DiagnosticianOutputV1 passes Value.Check (defense does not over-reject)', () => {
    // Guard: ensure the defense is not vacuously true (rejecting everything).
    const valid = createValidDiagnosticianOutput();
    expect(Value.Check(DiagnosticianOutputV1Schema, valid)).toBe(true);
  });
});

// ── ERR-002: catch-and-degrade must carry reason + nextAction ────────────────

/**
 * ApprovalQueueStore wrapper whose getById throws, simulating a transient store
 * failure (e.g., disk I/O error, connection lost). Used to verify the
 * ApprovalCompletionService and ActivationDispatcher catch the throw and
 * degrade with a structured reason + nextAction (Runtime Contract Rule 9).
 *
 * Extends the real MemoryApprovalQueueStore (a production store implementation,
 * not a mock) — only getById is overridden to throw.
 */
class ThrowingApprovalQueueStore extends MemoryApprovalQueueStore {
  async getById(_approvalId: string): Promise<ApprovalRecord | null> {
    throw new Error('simulated store failure: getById unavailable');
  }
}

describe('ERR-002 reverse-regression: catch-and-degrade must include reason + nextAction', () => {
  it('ApprovalCompletionService returns reason + nextAction when approval store throws on read', async () => {
    // Setup: a real approved record (enqueue/approve succeed via the parent
    // MemoryApprovalQueueStore; only getById throws).
    const approvalStore = new ThrowingApprovalQueueStore();
    const enqueued = await approvalStore.enqueue({
      artifactId: 'art-err-reg-002',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-21T00:00:00.000Z');
    await approvalStore.approve(enqueued.approvalId, 'owner-001');

    const artifactReadModel = new MemoryArtifactReadModel();
    const stateStore = new MemoryActivationStateStore();
    const dispatcher = new ActivationDispatcher(artifactReadModel, stateStore, {
      writers: [new PromptWriter()],
      approvalQueueStore: approvalStore,
    });
    const completionService = new ApprovalCompletionService(
      approvalStore,
      dispatcher,
      stateStore,
    );

    // Deliberate violation: the store throws during completeApproval (getById).
    // The defense: the service catches and returns a degraded result with
    // reason + nextAction (Rule 9 — graceful degradation must include a reason).
    const result = await completionService.completeApproval({
      approvalId: enqueued.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-21T01:00:00.000Z',
    });

    // Assert degradation is observable (not silent) and actionable.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
      expect(typeof result.nextAction).toBe('string');
      expect(result.nextAction.length).toBeGreaterThan(0);
    }
  });

  it('ActivationDispatcher returns reason + nextAction when approval store throws on approved dispatch', async () => {
    // Setup: dispatcher with a throwing approval store. Direct dispatch with
    // rolloutDecision='approved' triggers the getById catch path inside the
    // dispatcher's approval-verification block.
    const approvalStore = new ThrowingApprovalQueueStore();
    const artifact = createPrincipleArtifact();
    const artifactReadModel = new MemoryArtifactReadModel();
    artifactReadModel.addArtifact(artifact);
    const stateStore = new MemoryActivationStateStore();
    const dispatcher = new ActivationDispatcher(artifactReadModel, stateStore, {
      writers: [new PromptWriter()],
      approvalQueueStore: approvalStore,
    });

    // Deliberate violation: store throws during approval verification.
    const result = await dispatcher.dispatch({
      artifactId: artifact.artifactId,
      channel: 'prompt',
      rolloutDecision: 'approved',
      approvalId: 'apr_nonexistent_002',
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-21T01:00:00.000Z',
      confirm: true,
    });

    // The defense: dispatcher catches and returns refused with reason + nextAction.
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
      expect(typeof result.nextAction).toBe('string');
      expect(result.nextAction.length).toBeGreaterThan(0);
    }

    // No activation side effect (degraded path must not mutate state).
    const allActivations = await stateStore.listAllActivations();
    expect(allActivations).toHaveLength(0);
  });
});

// ── ERR-008: cross-task lineage pollution → dispatcher refuses ──────────────

describe('ERR-008 reverse-regression: cross-task lineage pollution is refused', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('dispatcher.dispatch refuses with approval_artifact_mismatch when artifactId differs from approved artifactId', async () => {
    // Setup: two distinct artifacts from different pain tasks (different
    // sourceTaskId / sourcePrincipleId). Owner approves artifact A; caller
    // dispatches artifact B with A's approvalId. This is a lineage break —
    // the activation would attach owner approval for A to an unrelated
    // artifact B (cross-task lineage pollution, ERR-008).
    const artifactA = createPrincipleArtifact();
    const artifactB = createPrincipleArtifact({
      artifactId: 'art-err-reg-008-b',
      sourceTaskId: 'task-pain-err-reg-008-b',
      sourcePrincipleId: 'principle-err-reg-008-b',
      contentJson: JSON.stringify({
        principleId: 'principle-err-reg-008-b',
        text: 'Unrelated principle from a different pain task',
        language: 'en',
      }),
    });

    const artifactReadModel = new MemoryArtifactReadModel();
    artifactReadModel.addArtifact(artifactA);
    artifactReadModel.addArtifact(artifactB);

    // Owner approves artifact A (real SQLite approval store)
    const enqueued = await ws.approvalStore.enqueue({
      artifactId: artifactA.artifactId,
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-21T00:00:00.000Z');
    await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

    const dispatcher = new ActivationDispatcher(artifactReadModel, ws.stateStore, {
      writers: [new PromptWriter()],
      approvalQueueStore: ws.approvalStore,
    });

    // Deliberate violation: dispatch artifact B with artifact A's approvalId.
    const result = await dispatcher.dispatch({
      artifactId: artifactB.artifactId,
      channel: 'prompt',
      rolloutDecision: 'approved',
      approvalId: enqueued.approvalId,
      actor: { kind: 'human', userId: 'attacker' },
      now: '2026-06-21T01:00:00.000Z',
      confirm: true,
    });

    // The defense: dispatcher refuses with approval_artifact_mismatch.
    expect(result.decision).toBe('refused');
    if (result.decision === 'refused') {
      expect(result.reason).toContain('approval_artifact_mismatch');
      expect(typeof result.nextAction).toBe('string');
      expect(result.nextAction!.length).toBeGreaterThan(0);
    }

    // No activation side effect (lineage mismatch must not activate).
    const allActivations = await ws.stateStore.listAllActivations();
    expect(allActivations).toHaveLength(0);
  });

  it('completeApproval returns invalid_artifact when the approved artifact is absent from the read model (broken lineage)', async () => {
    // Setup: approval references an artifact that was never seeded into the
    // dispatcher's read model. completeApproval dispatches; the dispatcher
    // cannot find the artifact → invalid_artifact (artifact_not_found).
    const artifactReadModel = new MemoryArtifactReadModel(); // empty

    const enqueued = await ws.approvalStore.enqueue({
      artifactId: 'art-not-seeded-008',
      channel: 'prompt',
      riskLevel: 'low',
    }, '2026-06-21T00:00:00.000Z');
    await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

    const dispatcher = new ActivationDispatcher(artifactReadModel, ws.stateStore, {
      writers: [new PromptWriter()],
      approvalQueueStore: ws.approvalStore,
    });
    const completionService = new ApprovalCompletionService(
      ws.approvalStore,
      dispatcher,
      ws.stateStore,
    );

    const result = await completionService.completeApproval({
      approvalId: enqueued.approvalId,
      actor: { kind: 'human', userId: 'owner-001' },
      now: '2026-06-21T01:00:00.000Z',
    });

    // The defense: dispatch returns invalid_artifact (artifact_not_found).
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.decision).toBe('invalid_artifact');
      if (result.decision.decision === 'invalid_artifact') {
        expect(result.decision.reason).toContain('artifact_not_found');
        expect(typeof result.decision.nextAction).toBe('string');
        expect(result.decision.nextAction!.length).toBeGreaterThan(0);
      }
    }

    // No activation side effect.
    const allActivations = await ws.stateStore.listAllActivations();
    expect(allActivations).toHaveLength(0);
  });
});

// ── ERR-048: activation write/read path consistency ─────────────────────────

describe('ERR-048 reverse-regression: activation write path matches read path', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('recordActivation write is readable verbatim via listPromptActivations, getActivationStatus, and listAllActivations', async () => {
    // Deliberate consistency check: if the write path (recordActivation, using
    // camelCase ActivationStatusRecord fields) and the read path (mapRowToRecord,
    // using snake_case SQLite column names) diverge, the read would return null
    // or mismatched fields. This test fails if the two paths are inconsistent.
    const idempotencyKey = makeIdempotencyKey('art-err-reg-048', 'prompt');
    const written: ActivationStatusRecord = {
      activationId: 'act_prompt_principle-err-reg-048',
      idempotencyKey,
      artifactId: 'art-err-reg-048',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://principle-err-reg-048',
      activatedAt: '2026-06-21T01:00:00.000Z',
      deactivatedAt: null,
    };

    await ws.stateStore.recordActivation(written);

    // Read path 1: listPromptActivations (channel-filtered list)
    const byList = await ws.stateStore.listPromptActivations();
    expect(byList).toHaveLength(1);
    const fromList = byList[0];
    expect(fromList).toBeDefined();
    if (!fromList) throw new Error('expected activation from listPromptActivations');
    expect(fromList.activationId).toBe(written.activationId);
    expect(fromList.idempotencyKey).toBe(written.idempotencyKey);
    expect(fromList.artifactId).toBe(written.artifactId);
    expect(fromList.channel).toBe(written.channel);
    expect(fromList.action).toBe(written.action);
    expect(fromList.targetRef).toBe(written.targetRef);
    expect(fromList.activatedAt).toBe(written.activatedAt);
    expect(fromList.deactivatedAt).toBe(written.deactivatedAt);

    // Read path 2: getActivationStatus (by idempotency key)
    const byKey = await ws.stateStore.getActivationStatus(idempotencyKey);
    expect(byKey).not.toBeNull();
    if (!byKey) throw new Error('expected activation from getActivationStatus');
    expect(byKey.activationId).toBe(written.activationId);
    expect(byKey.idempotencyKey).toBe(written.idempotencyKey);
    expect(byKey.artifactId).toBe(written.artifactId);
    expect(byKey.channel).toBe(written.channel);
    expect(byKey.action).toBe(written.action);
    expect(byKey.targetRef).toBe(written.targetRef);
    expect(byKey.activatedAt).toBe(written.activatedAt);
    expect(byKey.deactivatedAt).toBe(written.deactivatedAt);

    // Read path 3: listAllActivations (unfiltered)
    const byAll = await ws.stateStore.listAllActivations();
    expect(byAll).toHaveLength(1);
    const fromAll = byAll[0];
    expect(fromAll).toBeDefined();
    if (!fromAll) throw new Error('expected activation from listAllActivations');
    expect(fromAll.activationId).toBe(written.activationId);
    expect(fromAll.channel).toBe(written.channel);
    expect(fromAll.action).toBe(written.action);
    expect(fromAll.targetRef).toBe(written.targetRef);
  });

  it('deactivateActivation write is reflected in the read path (deactivatedAt set, listPromptActivations excludes)', async () => {
    // Write/read consistency for the deactivation column: the write path sets
    // deactivated_at, and the read path (listPromptActivations default) must
    // exclude deactivated records while listPromptActivations(true) includes
    // them with the correct deactivatedAt value.
    const idempotencyKey = makeIdempotencyKey('art-err-reg-048b', 'prompt');
    const written: ActivationStatusRecord = {
      activationId: 'act_prompt_principle-err-reg-048b',
      idempotencyKey,
      artifactId: 'art-err-reg-048b',
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://principle-err-reg-048b',
      activatedAt: '2026-06-21T01:00:00.000Z',
      deactivatedAt: null,
    };
    await ws.stateStore.recordActivation(written);

    const deactivatedAt = '2026-06-21T02:00:00.000Z';
    const ok = await ws.stateStore.deactivateActivation(written.activationId, deactivatedAt);
    expect(ok).toBe(true);

    // Read path: listPromptActivations (default excludes deactivated)
    const activeOnly = await ws.stateStore.listPromptActivations();
    expect(activeOnly).toHaveLength(0);

    // Read path: listPromptActivations(true) includes deactivated
    const includingDeactivated = await ws.stateStore.listPromptActivations(true);
    expect(includingDeactivated).toHaveLength(1);
    const deactivated = includingDeactivated[0];
    expect(deactivated).toBeDefined();
    if (!deactivated) throw new Error('expected deactivated activation');
    expect(deactivated.deactivatedAt).toBe(deactivatedAt);
    expect(deactivated.activationId).toBe(written.activationId);
    expect(deactivated.channel).toBe(written.channel);
    expect(deactivated.action).toBe(written.action);

    // Read path: getActivationStatus still returns the record (with deactivatedAt)
    const byKey = await ws.stateStore.getActivationStatus(idempotencyKey);
    expect(byKey).not.toBeNull();
    if (!byKey) throw new Error('expected activation from getActivationStatus after deactivation');
    expect(byKey.deactivatedAt).toBe(deactivatedAt);
    expect(byKey.activationId).toBe(written.activationId);
  });
});
