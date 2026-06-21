/**
 * Story A Full-Chain Happy-Path Test — MVP Release Quality Task 10
 *
 * Single test covering the complete Story A happy path from pain signal to
 * rollback. Complements story-a-acceptance.test.ts which starts from a
 * pre-built artifact and covers boundary scenarios (reject, edit, idempotency,
 * feature disabled, malformed JSON). This test starts from a SIMULATED pain
 * signal and covers the happy-path full chain in one test.
 *
 * Full chain (single test):
 *   pain signal (simulated, no real LLM) → diagnosis produces principle
 *   candidate (seed artifact with sourceTaskId linking back to the pain task)
 *   → owner review (approve) → ApprovalCompletionService orchestrates
 *   → ActivationDispatcher dispatches → PromptWriter writes prompt activation
 *   → observable behavior change (listPromptActivations + filterPromptActivations
 *     + resolvePrincipleFromArtifact + renderPrinciplesToDirectives)
 *   → owner rollback → behavior restored (listPromptActivations returns empty)
 *
 * Plus lineage mismatch rejection (ERR-004/008):
 *   - completeApproval fails when the approval references an artifact that is
 *     NOT the seeded diagnosis output (broken lineage → invalid_artifact).
 *   - dispatcher.dispatch directly rejects a mismatched artifactId+approvalId
 *     pair (approval_artifact_mismatch security boundary).
 *
 * Uses real SQLite stores + production services + production PromptWriter.
 * No mocks of the production path. No "function was called" assertions. No
 * "success or failure both pass" assertions.
 *
 * Difference from story-a-acceptance.test.ts:
 * - story-a-acceptance starts from a pre-built artifact and covers BOUNDARY
 *   scenarios (reject, edit, idempotency, feature disabled, malformed JSON,
 *   unrelated task, rollback reader contract).
 * - This test starts from a SIMULATED PAIN SIGNAL and covers the HAPPY PATH
 *   full chain in a single test, including the renderPrinciplesToDirectives
 *   observation step (write/read path consistency, ERR-048) that
 *   story-a-acceptance does not exercise.
 *
 * ERR checklist:
 * - ERR-001: All parsed JSON treated as unknown, validated at runtime
 * - ERR-002: Every failure path carries reason + nextAction
 * - ERR-004/008: Lineage fields from same source, mismatch tested
 * - ERR-009: Required fields fail loud
 * - ERR-015: Idempotency state distinguished from current dispatch
 * - ERR-025: Production-path test, not demo helper
 * - ERR-048: Write/read path consistency — activation written by PromptWriter
 *   is readable by filterPromptActivations + resolvePrincipleFromArtifact
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqliteActivationStateStore,
  SqlitePIArtifactStore,
  ActivationDispatcher,
  ApprovalCompletionService,
  PromptWriter,
  filterPromptActivations,
  resolvePrincipleFromArtifact,
  trimToBudget,
  renderPrinciplesToDirectives,
  makeIdempotencyKey,
} from '../../index.js';
import type {
  PIArtifactSnapshot,
} from '../activation-types.js';
import type { Database } from 'better-sqlite3';

// ── Test workspace setup ────────────────────────────────────────────────────

interface TestWorkspace {
  workspaceDir: string;
  connection: SqliteConnection;
  approvalStore: SqliteApprovalQueueStore;
  stateStore: SqliteActivationStateStore;
  artifactStore: SqlitePIArtifactStore;
  cleanup: () => void;
}

function createTestWorkspace(): TestWorkspace {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-story-a-fullchain-'));
  const pdDir = path.join(tmpDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });

  const connection = new SqliteConnection({ workspaceDir: tmpDir });
  // Trigger DB initialization (getDb runs schema setup)
  connection.getDb();

  const approvalStore = new SqliteApprovalQueueStore(connection);
  const stateStore = new SqliteActivationStateStore(connection);
  const artifactStore = new SqlitePIArtifactStore(connection);

  return {
    workspaceDir: tmpDir,
    connection,
    approvalStore,
    stateStore,
    artifactStore,
    cleanup: () => {
      connection.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ── Artifact fixtures ───────────────────────────────────────────────────────

// The pain signal is simulated (no real LLM call). It is represented by a
// task ID and a human-readable description. The diagnosis step produces a
// principle candidate artifact whose sourceTaskId links back to this pain task
// (lineage consistency, ERR-004/008).
const PAIN_TASK_ID = 'task-pain-fullchain-001';
const PAIN_DESCRIPTION =
  'Agent added a parallel module without reading the existing implementation, causing duplication.';

const PRINCIPLE_ID = 'principle-fullchain-001';
const PRINCIPLE_TEXT =
  'Always read existing implementation before adding a parallel module';

/**
 * Diagnosis output: a validated principle candidate artifact. The sourceTaskId
 * links this artifact back to the pain task (lineage). contentJson includes
 * principleId + text so PromptWriter.canActivate (extractPrincipleId) and
 * resolvePrincipleFromArtifact (render path) both succeed.
 */
function createDiagnosisArtifact(overrides: Partial<PIArtifactSnapshot> = {}): PIArtifactSnapshot {
  return {
    artifactId: 'art-principle-fullchain-001',
    artifactKind: 'principle',
    sourceTaskId: PAIN_TASK_ID,
    sourcePrincipleId: PRINCIPLE_ID,
    lineageArtifactIds: [],
    validationStatus: 'validated',
    contentJson: JSON.stringify({
      principleId: PRINCIPLE_ID,
      text: PRINCIPLE_TEXT,
      language: 'en',
      // Diagnosis metadata — how this principle was derived from the pain
      derivedFrom: PAIN_DESCRIPTION,
    }),
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeArtifactReadModel(artifacts: PIArtifactSnapshot[]): {
  getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null>;
} {
  const map = new Map(artifacts.map(a => [a.artifactId, a]));
  return {
    getArtifactById: async (id: string) => map.get(id) ?? null,
  };
}

function createPromptDispatcher(
  artifactReadModel: { getArtifactById: (id: string) => Promise<PIArtifactSnapshot | null> },
  stateStore: SqliteActivationStateStore,
  approvalStore: SqliteApprovalQueueStore,
): ActivationDispatcher {
  // Production dispatcher configured with only the PromptWriter — the
  // low-risk channel for a validated principle artifact.
  return new ActivationDispatcher(
    artifactReadModel,
    stateStore,
    {
      writers: [new PromptWriter()],
      approvalQueueStore: approvalStore,
    },
  );
}

/**
 * Convert a PIArtifactSnapshot/PIArtifactRecord (camelCase) to the snake_case
 * row shape expected by resolvePrincipleFromArtifact. The reader contract
 * function treats its input as unknown and validates fields by snake_case name
 * (artifact_id, artifact_kind, content_json, validation_status) — matching
 * the raw SQLite row format. This conversion bridges the typed snapshot and
 * the untyped reader contract (same pattern as activation-prompt-e2e.test.ts).
 */
function toArtifactRow(artifact: {
  artifactId: string;
  artifactKind: string;
  contentJson: string;
  validationStatus: string;
}): Record<string, unknown> {
  return {
    artifact_id: artifact.artifactId,
    artifact_kind: artifact.artifactKind,
    content_json: artifact.contentJson,
    validation_status: artifact.validationStatus,
  };
}

// ── DB snapshot helpers (MVP Quality Task 18) ───────────────────────────────
// Capture raw SQLite table state for golden-file comparison. Strips
// non-deterministic timestamps and UUIDs but PRESERVES lineage fields
// (source_task_id, source_principle_id, source_rule_id, previous_artifact_id,
// lineage_artifact_ids) so ERR-004/008/015 (lineage inconsistency, stale loop
// state) surface as snapshot diffs.

interface DbSnapshot {
  [tableName: string]: Record<string, unknown>[];
}

const TIMESTAMP_FIELDS = new Set([
  'created_at', 'updated_at', 'createdAt', 'updatedAt',
  'activated_at', 'deactivated_at', 'decided_at', 'requested_at', 'edited_at',
]);

const LINEAGE_FIELDS = new Set([
  'source_task_id', 'source_principle_id', 'source_rule_id',
  'previous_artifact_id', 'lineage_artifact_ids',
]);

const ID_FIELDS = new Set([
  'activation_id', 'artifact_id', 'approval_id', 'idempotency_key', 'run_id',
]);

const UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}/;

const TABLE_ORDER_BY: Record<string, string> = {
  activations: 'activated_at, activation_id',
  approvals: 'approval_id',
  pi_artifacts: 'artifact_id',
};

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (TIMESTAMP_FIELDS.has(key) && typeof value === 'string') {
      // Only strip actual timestamp strings; preserve null (e.g. deactivated_at
      // before rollback) so the snapshot distinguishes "not set" from "set".
      out[key] = '<TIMESTAMP>';
    } else if (LINEAGE_FIELDS.has(key)) {
      // Preserve lineage fields as-is (ERR-004/008/015 consistency check)
      out[key] = value;
    } else if (ID_FIELDS.has(key) && typeof value === 'string' && UUID_PREFIX_RE.test(value)) {
      out[key] = '<UUID>';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function snapshotDb(db: Database, tables: readonly string[]): DbSnapshot {
  const result: DbSnapshot = {};
  for (const table of tables) {
    const order = TABLE_ORDER_BY[table] ?? 'rowid';
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    result[table] = (Array.isArray(rows) ? rows : []).map((row) =>
      normalizeRow(row as Record<string, unknown>),
    );
  }
  return result;
}

// ── Full-Chain Tests ────────────────────────────────────────────────────────

describe('Story A full-chain happy-path (MVP Quality Task 10)', () => {
  let ws: TestWorkspace;

  beforeEach(() => {
    ws = createTestWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  describe('happy path: pain → diagnosis → approve → activate → observe → rollback', () => {
    it('completes the full six-step chain in a single test with real SQLite stores', async () => {
      // ── Step 1: Pain signal (simulated) ──
      // A real pain signal would come from observing an agent action. Here we
      // simulate it as a task ID + description. No real LLM is called.
      // The pain task ID is the lineage root for the diagnosis output.
      expect(PAIN_TASK_ID).toBeDefined();
      expect(PAIN_DESCRIPTION.length).toBeGreaterThan(0);

      // ── Step 2: Diagnosis produces a principle candidate (seed artifact) ──
      // The diagnosis step (simulated) produces a validated principle artifact.
      // Lineage: artifact.sourceTaskId === PAIN_TASK_ID (ERR-004/008 — lineage
      // fields must trace back to the same pain source).
      const principleArtifact = createDiagnosisArtifact();

      // Lineage consistency check: the diagnosis output traces back to the pain
      expect(principleArtifact.sourceTaskId).toBe(PAIN_TASK_ID);
      expect(principleArtifact.validationStatus).toBe('validated');
      expect(principleArtifact.artifactKind).toBe('principle');

      // Seed the artifact into the REAL SQLite artifact store (production path)
      await ws.artifactStore.createArtifact(principleArtifact);

      // Also build a Map-based read model for the dispatcher (matches the
      // story-a-acceptance pattern — dispatcher expects PIArtifactSnapshot).
      const artifactReadModel = makeArtifactReadModel([principleArtifact]);

      // ── Step 3: Owner review (approve) ──
      // The low-risk principle goes through the prompt channel. Owner reviews
      // and approves the activation request.
      const enqueued = await ws.approvalStore.enqueue({
        artifactId: principleArtifact.artifactId,
        channel: 'prompt',
        riskLevel: 'low',
        summary: PRINCIPLE_TEXT,
        triggerReason: 'pain-signal-detected',
      }, '2026-06-18T00:00:00.000Z');

      expect(enqueued.status).toBe('pending');
      expect(enqueued.channel).toBe('prompt');
      expect(enqueued.riskLevel).toBe('low');
      expect(enqueued.artifactId).toBe(principleArtifact.artifactId);

      const approveResult = await ws.approvalStore.approve(
        enqueued.approvalId,
        'owner-001',
        'Approved — principle is safe for prompt activation',
      );
      expect(approveResult.ok).toBe(true);

      // ── Step 4: ApprovalCompletionService orchestrates activation ──
      // The service reads the approved record, checks idempotency, and dispatches
      // with rolloutDecision='approved'. The dispatcher independently verifies
      // the approval record (security boundary) and calls PromptWriter.activate.
      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );
      const completionService = new ApprovalCompletionService(
        ws.approvalStore,
        dispatcher,
        ws.stateStore,
      );

      const completionResult = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
      });

      expect(completionResult.ok).toBe(true);
      if (completionResult.ok) {
        expect(completionResult.decision.decision).toBe('activated');
        expect(completionResult.activationId).toBe(`act_prompt_${PRINCIPLE_ID}`);
      }

      // ── Step 5: Observable behavior change ──
      // 5a. listPromptActivations returns the activation record (write path).
      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(1);

      const [activation] = promptActivations;
      expect(activation).toBeDefined();
      if (!activation) throw new Error('expected activation to be defined');
      expect(activation.artifactId).toBe(principleArtifact.artifactId);
      expect(activation.channel).toBe('prompt');
      expect(activation.action).toBe('prompt_activate');
      expect(activation.activationId).toBe(`act_prompt_${PRINCIPLE_ID}`);
      expect(activation.targetRef).toBe(`ledger://${PRINCIPLE_ID}`);
      expect(activation.deactivatedAt).toBeNull();
      expect(activation.activatedAt).toBe('2026-06-18T01:00:00.000Z');

      // 5b. filterPromptActivations keeps only active prompt/prompt_activate records.
      const filtered = filterPromptActivations(promptActivations);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.activationId).toBe(activation.activationId);

      // 5c. resolvePrincipleFromArtifact + renderPrinciplesToDirectives (read path).
      // ERR-048: write/read path consistency — the activation written by
      // PromptWriter must be readable by the prompt-activation-reader contract.
      // Retrieve the artifact from the REAL SQLite artifact store (not the Map).
      const artifactRow = await ws.artifactStore.getArtifactById(activation.artifactId);
      expect(artifactRow).not.toBeNull();
      if (!artifactRow) throw new Error('expected artifact to exist');

      const resolved = resolvePrincipleFromArtifact(
        toArtifactRow(artifactRow),
        activation,
      );
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.principle.principleId).toBe(PRINCIPLE_ID);
        expect(resolved.principle.text).toBe(PRINCIPLE_TEXT);
        expect(resolved.principle.artifactId).toBe(principleArtifact.artifactId);
        expect(resolved.principle.activationId).toBe(activation.activationId);
      }

      // 5d. Render the resolved principles to directive text — this is the
      // observable behavior change the owner sees in the agent's system prompt.
      const principles = resolved.ok ? [resolved.principle] : [];
      const { injectedIds } = trimToBudget(principles, 2000);
      expect(injectedIds.has(PRINCIPLE_ID)).toBe(true);

      const directiveText = renderPrinciplesToDirectives(principles, injectedIds);
      expect(directiveText).toContain(PRINCIPLE_TEXT);
      expect(directiveText).toContain(PRINCIPLE_ID);
      expect(directiveText).toContain('OWNER-APPROVED BEHAVIOR DIRECTIVES');
      expect(directiveText).toContain('MANDATORY');

      // ── DB state snapshot (MVP Quality Task 18) ──
      // Verify database state matches a golden snapshot. Strips timestamps/UUIDs
      // but preserves lineage fields to catch ERR-004/008/015 (lineage
      // inconsistency, stale loop state). Snapshot is taken AFTER activation
      // and BEFORE rollback so the golden file reflects the active state.
      const db = ws.connection.getDb();
      const dbSnapshot = snapshotDb(db, ['activations', 'approvals', 'pi_artifacts']);
      await expect(dbSnapshot).toMatchFileSnapshot(
        './__snapshots__/story-a-full-chain-after-activation.db.json',
      );

      // Lineage consistency (ERR-004/008): pi_artifacts.source_task_id must
      // trace back to the original pain task. The activation and approval
      // records must reference the same artifact_id (cross-table lineage).
      for (const row of dbSnapshot.pi_artifacts ?? []) {
        if (row.artifact_id === principleArtifact.artifactId) {
          expect(row.source_task_id).toBe(principleArtifact.sourceTaskId);
          expect(row.source_principle_id).toBe(principleArtifact.sourcePrincipleId);
        }
      }
      for (const row of dbSnapshot.activations ?? []) {
        expect(row.artifact_id).toBe(principleArtifact.artifactId);
      }
      for (const row of dbSnapshot.approvals ?? []) {
        expect(row.artifact_id).toBe(principleArtifact.artifactId);
      }

      // ── Step 6: Owner rollback → behavior restored ──
      // The owner deactivates the activation. After rollback, listPromptActivations
      // no longer returns it (only active records), and the directive render path
      // would no longer include the principle.
      const deactivatedAt = '2026-06-18T02:00:00.000Z';
      const rollbackOk = await ws.stateStore.deactivateActivation(
        activation.activationId,
        deactivatedAt,
      );
      expect(rollbackOk).toBe(true);

      // Behavior restored: listPromptActivations returns empty (excludes deactivated)
      const activeAfterRollback = await ws.stateStore.listPromptActivations();
      expect(activeAfterRollback).toHaveLength(0);

      // filterPromptActivations also excludes the deactivated record
      const allPromptIncludingDeactivated = await ws.stateStore.listPromptActivations(true);
      expect(allPromptIncludingDeactivated).toHaveLength(1);
      const filteredAfterDeactivation = filterPromptActivations(allPromptIncludingDeactivated);
      expect(filteredAfterDeactivation).toHaveLength(0);

      // Audit trail preserved: listAllActivations still includes the deactivated record
      const allAfterRollback = await ws.stateStore.listAllActivations();
      expect(allAfterRollback).toHaveLength(1);
      expect(allAfterRollback[0]?.deactivatedAt).toBe(deactivatedAt);
      expect(allAfterRollback[0]?.artifactId).toBe(principleArtifact.artifactId);

      // Idempotency key no longer resolves to an ACTIVE activation (behavior
      // restored — re-dispatching the same artifact would create a new activation).
      const idempotencyKey = makeIdempotencyKey(principleArtifact.artifactId, 'prompt');
      const statusAfterRollback = await ws.stateStore.getActivationStatus(idempotencyKey);
      // getActivationStatus returns the record regardless of deactivation status
      // (it is the raw lookup). The BEHAVIORAL change is observed via
      // listPromptActivations (which excludes deactivated) — verified above.
      expect(statusAfterRollback).not.toBeNull();
      expect(statusAfterRollback?.deactivatedAt).toBe(deactivatedAt);
    });
  });

  describe('lineage mismatch rejection (ERR-004/008)', () => {
    it('completeApproval fails when the approval references an artifact not in the read model (broken lineage)', async () => {
      // Scenario: the diagnosis output is artifact A (seeded), but the approval
      // references artifact B (a different artifactId, NOT seeded). This is a
      // lineage break — the approval does not reference the diagnosis output.
      // completeApproval must fail to activate (no activation record).
      const diagnosisArtifact = createDiagnosisArtifact();
      const artifactReadModel = makeArtifactReadModel([diagnosisArtifact]);

      // Enqueue approval for a DIFFERENT artifact (not in the read model)
      const enqueued = await ws.approvalStore.enqueue({
        artifactId: 'art-DIFFERENT-not-seeded',
        channel: 'prompt',
        riskLevel: 'low',
        summary: 'Stale or misrouted artifact',
        triggerReason: 'pain-signal-detected',
      }, '2026-06-18T00:00:00.000Z');
      await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );
      const completionService = new ApprovalCompletionService(
        ws.approvalStore,
        dispatcher,
        ws.stateStore,
      );

      const result = await completionService.completeApproval({
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
      });

      // completeApproval returns ok=true (service-level success) but the
      // dispatch decision is invalid_artifact (artifact_not_found) — the
      // activation FAILED. No activation record is written.
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.decision.decision).toBe('invalid_artifact');
        if (result.decision.decision === 'invalid_artifact') {
          expect(result.decision.reason).toContain('artifact_not_found');
          expect(result.decision.nextAction).toBeDefined();
        }
      }

      // No activation side effect (ERR-004/008: lineage mismatch must not activate)
      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(0);

      const allActivations = await ws.stateStore.listAllActivations();
      expect(allActivations).toHaveLength(0);
    });

    it('dispatcher.dispatch rejects a mismatched artifactId+approvalId pair (security boundary)', async () => {
      // Scenario: an attacker (or bug) calls dispatcher.dispatch directly with
      // rolloutDecision='approved' and an approvalId for artifact A, but passes
      // a DIFFERENT artifactId (artifact B). The dispatcher's security boundary
      // (approval_artifact_mismatch) must refuse — this prevents bypassing the
      // owner approval boundary (ERR-004/008).
      //
      // Note: artifact B MUST exist in the read model — otherwise the dispatcher
      // returns invalid_artifact (artifact_not_found) before reaching the
      // approval mismatch check. The mismatch check specifically catches the
      // case where both artifacts exist but the dispatch artifact differs from
      // the approved artifact.
      const diagnosisArtifact = createDiagnosisArtifact();
      const attackArtifact = createDiagnosisArtifact({
        artifactId: 'art-attack-002',
        sourcePrincipleId: 'principle-attack-002',
        contentJson: JSON.stringify({
          principleId: 'principle-attack-002',
          text: 'Malicious or unrelated principle',
          language: 'en',
        }),
      });
      const artifactReadModel = makeArtifactReadModel([diagnosisArtifact, attackArtifact]);

      // Enqueue and approve the REAL diagnosis artifact
      const enqueued = await ws.approvalStore.enqueue({
        artifactId: diagnosisArtifact.artifactId,
        channel: 'prompt',
        riskLevel: 'low',
      }, '2026-06-18T00:00:00.000Z');
      await ws.approvalStore.approve(enqueued.approvalId, 'owner-001');

      const dispatcher = createPromptDispatcher(
        artifactReadModel,
        ws.stateStore,
        ws.approvalStore,
      );

      // Direct dispatch with a MISMATCHED artifactId (exists in read model, but
      // not what was approved). This triggers approval_artifact_mismatch.
      const mismatchedResult = await dispatcher.dispatch({
        artifactId: attackArtifact.artifactId,
        channel: 'prompt',
        rolloutDecision: 'approved',
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'attacker' },
        now: '2026-06-18T01:00:00.000Z',
        confirm: true,
      });

      expect(mismatchedResult.decision).toBe('refused');
      if (mismatchedResult.decision === 'refused') {
        expect(mismatchedResult.reason).toContain('approval_artifact_mismatch');
        expect(mismatchedResult.nextAction).toBeDefined();
      }

      // No activation side effect
      const allActivations = await ws.stateStore.listAllActivations();
      expect(allActivations).toHaveLength(0);

      // Contrast: dispatching with the CORRECT artifactId+approvalId succeeds
      const correctResult = await dispatcher.dispatch({
        artifactId: diagnosisArtifact.artifactId,
        channel: 'prompt',
        rolloutDecision: 'approved',
        approvalId: enqueued.approvalId,
        actor: { kind: 'human', userId: 'owner-001' },
        now: '2026-06-18T01:00:00.000Z',
        confirm: true,
      });
      expect(correctResult.decision).toBe('activated');

      // Exactly one activation record (the correct one)
      const promptActivations = await ws.stateStore.listPromptActivations();
      expect(promptActivations).toHaveLength(1);
      expect(promptActivations[0]?.artifactId).toBe(diagnosisArtifact.artifactId);
    });
  });
});
