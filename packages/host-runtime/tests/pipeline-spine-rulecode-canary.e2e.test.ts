/**
 * RuleCode canary — Owner approval gate and activation —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §4.5 Layer A / review round 2 (PRI-1291).
 *
 * Executed for REAL (production services over real SQLite, no mocks of the
 * production path):
 *   validated rule artifact persisted by the real artifact store (the
 *   contract the Evaluator writes: artifact_kind 'rule', lineage in the
 *   pi_artifacts columns) → approval request (SqliteApprovalQueueStore) →
 *   ApprovalCompletionService → ActivationDispatcher → RuleHostWriter →
 *   the REAL production RuleHost gate (createProductionRuleHostGate).
 *
 *   - Owner has NOT authorized (approval still pending): completion does NOT
 *     activate — zero activation rows ("Owner 未授权时不能激活");
 *   - Owner approves: the real RuleHostWriter creates the shadow activation
 *     (`code_tool_hook_shadow_activate`, target_ref = impl://<ruleId>_<version>);
 *   - shadow never denies at the gate.
 *
 * Lineage is read back from the database: the activation targets the rule
 * identity of `pi_artifacts.source_rule_id`; the gate sees the same rule.
 *
 * INCOMPLETE (not executed here — stated, not simulated):
 *   - Dreamer → Philosopher → Scribe → Owner binding → Artificer (L2) →
 *     Evaluator → RolloutReviewer through the real consumer-cycle runners;
 *   - live promotion through RuleCodeOwnerDecisionService.promote (its ten
 *     readiness checks need a governed workspace this canary does not build).
 *   The live gate + interception receipt are covered by
 *   openclaw-plugin/tests/hooks/pipeline-spine-rulecode-receipt-canary.e2e.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import {
  ActivationDispatcher,
  ApprovalCompletionService,
  DeferArchiveWriter,
  PromptWriter,
  RuleHostWriter,
  RuntimeStateManager,
  SqliteActivationStateStore,
  SqliteApprovalQueueStore,
  SqliteConnection,
  createProductionGateDeps,
  disposePainSignalBridgesForWorkspace,
} from '@principles/core/runtime';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';

const PRINCIPLE_ID = 'a0000000-0000-4000-8000-00000000c4a1';
const EVALUATOR_TASK_ID = 'canary-approval-eval-001';
const RULE_ID = `rule-${EVALUATOR_TASK_ID}`;
const ARTIFACT_ID = `pi-rule-${EVALUATOR_TASK_ID}-run_canary-approval_1`;
const SESSION_ID = 'canary-rulecode-approval';
const OWNER = { kind: 'human', userId: 'owner-canary' } as const;
const T0 = '2026-11-24T00:00:00.000Z';
const T1 = '2026-11-24T01:00:00.000Z';

const workspaces: string[] = [];

/** The rule content contract the refiner sandbox accepts (edit tool). */
const RULE_CONTENT = {
  implementationCode: `
function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  if (helpers.getToolName() === 'edit' && p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'CANARY_RULE_BLOCK_5e2a: system path blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'CANARY_RULE_ALLOW_5e2a: safe path' };
}
`,
  goldenTrace: {
    traceId: 'trace-canary-approval',
    version: 1,
    createdAt: T0,
    cases: [
      { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { filePath: '/etc/passwd' }, expectedDecision: 'block' },
      { caseId: 'positive-1', kind: 'positive', toolName: 'edit', params: { filePath: '/src/index.ts' }, expectedDecision: 'allow' },
    ],
  },
  ruleHostGateDecision: 'accepted_shadow',
  affectedTools: ['edit'],
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspaceDir of workspaces.splice(0)) {
    await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows handle latency; the vitest temp keeper sweeps leftovers
    }
  }
});

interface World {
  workspaceDir: string;
  connection: SqliteConnection;
  stateStore: SqliteActivationStateStore;
  approvalStore: SqliteApprovalQueueStore;
  rows: (sql: string, ...params: unknown[]) => Record<string, unknown>[];
}

async function createWorld(): Promise<World> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-approval-canary-'));
  workspaces.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });

  // the Evaluator's persisted output contract, through the real artifact store
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  try {
    await stateManager.piArtifactStore.upsertArtifact({
      artifactId: ARTIFACT_ID,
      artifactKind: 'rule',
      sourceTaskId: EVALUATOR_TASK_ID,
      sourcePrincipleId: PRINCIPLE_ID,
      sourceRuleId: RULE_ID,
      lineageArtifactIds: ['pi-art-scribe-canary-approval-001'],
      validationStatus: 'validated',
      contentJson: JSON.stringify(RULE_CONTENT),
      createdAt: T0,
      updatedAt: T0,
    });
  } finally {
    await stateManager.close();
  }

  const connection = new SqliteConnection(workspaceDir);
  connection.getDb();
  return {
    workspaceDir,
    connection,
    stateStore: new SqliteActivationStateStore(connection),
    approvalStore: new SqliteApprovalQueueStore(connection),
    rows: (sql, ...params) => connection.getDb().prepare(sql).all(...params) as Record<string, unknown>[],
  };
}

/** The production dispatcher wiring (PromptWriter + RuleHostWriter with the
 * production gate deps + DeferArchiveWriter) over the real artifact store.
 * The state manager stays open until `close()` — the dispatcher reads
 * artifacts through it. */
async function makeDispatcher(world: World): Promise<{ dispatcher: ActivationDispatcher; close: () => Promise<void> }> {
  const stateManager = new RuntimeStateManager({ workspaceDir: world.workspaceDir });
  await stateManager.initialize();
  return {
    dispatcher: new ActivationDispatcher(
      stateManager.piArtifactStore,
      world.stateStore,
      {
        writers: [
          new PromptWriter(),
          new RuleHostWriter({ gateDeps: createProductionGateDeps() }),
          new DeferArchiveWriter(),
        ],
        approvalQueueStore: world.approvalStore,
      },
    ),
    close: () => stateManager.close(),
  };
}

function matchingHostEvent(workspaceDir: string): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir, sessionId: SESSION_ID, toolName: 'edit', toolCallId: 'toolu-canary-approval' },
    rawPayload: { toolInput: { toolName: 'edit', params: { file_path: '/etc/passwd', old_string: 'x', new_string: 'y' } } },
    source: 'openclaw:before_tool_call',
  };
}

describe('RuleCode canary — Owner approval gate, shadow activation and the gate', () => {
  it('without the Owner approval nothing activates; with it the real RuleHostWriter creates the shadow activation', async () => {
    const world = await createWorld();
    const { dispatcher, close } = await makeDispatcher(world);
    try {
      // ── Approval request ──
      const enqueued = await world.approvalStore.enqueue({
        artifactId: ARTIFACT_ID,
        channel: 'code_tool_hook',
        riskLevel: 'high',
        summary: 'Block edits to system paths',
        triggerReason: 'pain-signal-detected',
      }, T0);
      expect(enqueued.status).toBe('pending');
      const completionService = new ApprovalCompletionService(world.approvalStore, dispatcher, world.stateStore);

      // ── Owner has NOT authorized: the completion must not activate ──
      const unauthorized = await completionService.completeApproval({ approvalId: enqueued.approvalId, actor: OWNER, now: T1 });
      expect(unauthorized.ok).toBe(false);
      expect(world.rows('SELECT activation_id FROM activations')).toEqual([]);
      // and the gate has nothing to enforce
      const gateBefore = createProductionRuleHostGate();
      expect((await gateBefore(matchingHostEvent(world.workspaceDir))).decision).toBe('allow');

      // ── Owner approves ──
      const approved = await world.approvalStore.approve(enqueued.approvalId, OWNER.userId, 'Approved by the Owner');
      expect(approved.ok).toBe(true);

      // ── completion → ActivationDispatcher → RuleHostWriter ──
      const completed = await completionService.completeApproval({ approvalId: enqueued.approvalId, actor: OWNER, now: T1 });
      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.decision.decision).toBe('activated');
      expect(completed.activationId).toMatch(/^act_code_/);

      // ── the database carries the proof ──
      const activations = world.rows('SELECT activation_id, action, channel, target_ref, artifact_id, promoted_at FROM activations');
      expect(activations).toHaveLength(1);
      const activation = activations[0];
      expect(activation?.action).toBe('code_tool_hook_shadow_activate');
      expect(activation?.channel).toBe('code_tool_hook');
      expect(activation?.artifact_id).toBe(ARTIFACT_ID);
      // the activation targets the RULE identity of the artifact column, with
      // the version segment the production writer derives (sha256 of the
      // artifact id — rule-host-writer.ts)
      const artifact = world.rows('SELECT source_rule_id, source_principle_id FROM pi_artifacts WHERE artifact_id = ?', ARTIFACT_ID)[0];
      expect(artifact?.source_rule_id).toBe(RULE_ID);
      expect(artifact?.source_principle_id).toBe(PRINCIPLE_ID);
      const artifactVersion = createHash('sha256').update(ARTIFACT_ID, 'utf8').digest('hex');
      expect(activation?.target_ref).toBe(`impl://${RULE_ID}_${artifactVersion}`);
      expect(activation?.activation_id).toBe(`act_code_${RULE_ID}_${artifactVersion}`);
      // a shadow activation is not live
      expect(activation?.promoted_at ?? null).toBeNull();

      // ── shadow never denies at the real gate ──
      const gate = createProductionRuleHostGate();
      const shadowResult = await gate(matchingHostEvent(world.workspaceDir));
      expect(shadowResult.decision).toBe('allow');
    } finally {
      await close().catch(() => undefined);
      world.connection.close();
    }
  }, 120_000);
});
