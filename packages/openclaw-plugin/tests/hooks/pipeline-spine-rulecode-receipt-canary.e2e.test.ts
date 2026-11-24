/**
 * RuleCode canary — RuleHost gate + interception receipt + lineage —
 * SPEC-PD-PIPELINE-SPINE-001 v0.9 §4.5 Layer A / review round 2 (PRI-1291).
 *
 * Executed for REAL (production services, real SQLite, no mocks of the
 * production path):
 *   rule artifact (the contract the Evaluator persists: artifact_kind 'rule',
 *   validated, lineage in the pi_artifacts COLUMNS) → live code_tool_hook
 *   activation (SqliteActivationStateStore.recordActivation) → the REAL
 *   production RuleHost gate (createProductionRuleHostGate) → the REAL plugin
 *   interception adapter (handleSharedRuleHostResult) → the receipt rows.
 *
 * Lineage — verified in the PRODUCTION shape (measured on the production
 * workspace, read-only, 2026-11-24; `rule-host-writer.ts` writes it):
 *   principle UUID : pi_artifacts.source_principle_id  ==  principle_applications.principle_id
 *   rule identity  : pi_artifacts.source_rule_id  ==  activations.target_ref
 *                    (`impl://<ruleId>_<artifactVersion>`)  ==  principle_applications.rule_id
 *   activation     : gate metadata.evaluations[].activationId  ==  principle_applications.activation_id
 * `activations.target_ref` is a RULE identity by design, never a principle
 * UUID — the SPEC's "three equal UUIDs" wording is read with that reality.
 *
 * INCOMPLETE (not executed by this canary — see the final delivery report):
 *   - the upstream chain Dreamer → Philosopher → Scribe → Owner binding →
 *     Artificer (L2) → Evaluator → RolloutReviewer through the real
 *     consumer-cycle runners: the rule artifact here is persisted in the
 *     Evaluator's output contract, not produced by those runners;
 *   - Owner approval + live promotion through RuleCodeOwnerDecisionService
 *     (covered separately by the host-runtime rulecode canary).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  RuntimeStateManager,
  SqliteActivationStateStore,
  SqliteConnection,
} from '@principles/core/runtime';
import { createProductionRuleHostGate } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { PluginHookBeforeToolCallEvent, PluginHookToolContext } from '../../src/openclaw-sdk.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

// ── Production-shaped identities ───────────────────────────────────────────
// A principle UUID, and the rule id the Evaluator mints (`rule-<evaluatorTaskId>`).
const PRINCIPLE_ID = '2d23707d-11a3-4484-a35d-124e19904eac';
const EVALUATOR_TASK_ID = 'canary-rule-eval-001';
const RULE_ID = `rule-${EVALUATOR_TASK_ID}`;
const ARTIFACT_ID = `pi-rule-${EVALUATOR_TASK_ID}-run_canary-rule-eval_1`;
// the version segment and the activation id exactly as the production
// RuleHostWriter derives them (sha256 of the artifact id — rule-host-writer.ts)
const ARTIFACT_VERSION = createHash('sha256').update(ARTIFACT_ID, 'utf8').digest('hex');
const ACTIVATION_ID = `act_code_${RULE_ID}_${ARTIFACT_VERSION}`;
const SESSION_ID = 'canary-rulecode-session';
const CANARY_BLOCK_REASON = 'CANARY_RULE_BLOCK_5e2a: system directory';

const BLOCK_CODE = `
function evaluate(input, helpers) {
  var p = input.action.normalizedPath || '';
  if (p.indexOf('/etc/') === 0 || p === '/etc') {
    return { decision: 'block', matched: true, reason: '${CANARY_BLOCK_REASON}' };
  }
  return { decision: 'allow', matched: false, reason: 'Not matched' };
}
var meta = { name: 'canary-rulecode-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`;

let workspaceDir: string;
let sqliteConn: SqliteConnection;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulecode-canary-'));
  WorkspaceContext.clearCache();
  sqliteConn = new SqliteConnection(workspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  WorkspaceContext.clearCache();
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows */ }
});

/** The rule artifact exactly as the Evaluator persists it: validated rule
 * kind, lineage in the COLUMNS (its content carries neither ruleId nor
 * principleId — the gate reads identity from the columns). */
async function persistEvaluatorRuleArtifact(): Promise<void> {
  const now = new Date().toISOString();
  const sm = new RuntimeStateManager({ workspaceDir });
  await sm.initialize();
  try {
    await sm.piArtifactStore.upsertArtifact({
      artifactId: ARTIFACT_ID,
      artifactKind: 'rule',
      sourceTaskId: EVALUATOR_TASK_ID,
      sourcePrincipleId: PRINCIPLE_ID,
      sourceRuleId: RULE_ID,
      lineageArtifactIds: ['pi-art-scribe-canary-001'],
      validationStatus: 'validated',
      contentJson: JSON.stringify({
        implementationCode: BLOCK_CODE,
        goldenTrace: {
          traceId: 'trace-canary-rulecode',
          version: 1,
          createdAt: now,
          cases: [
            { caseId: 'negative-1', kind: 'negative', toolName: 'write', params: { file_path: '/etc/passwd' }, expectedDecision: 'block' },
            { caseId: 'positive-1', kind: 'positive', toolName: 'write', params: { file_path: '/project/file.txt' }, expectedDecision: 'allow' },
          ],
        },
        ruleHostGateDecision: 'accepted_shadow',
        affectedTools: ['write'],
        painReasonSummary: 'Canary: block /etc writes via gate',
      }),
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    await sm.close();
  }
}

async function activateLive(): Promise<void> {
  const store = new SqliteActivationStateStore(sqliteConn);
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}_${ARTIFACT_VERSION}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

function makeHostEvent(filePath: string, toolCallId: string): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir, sessionId: SESSION_ID, toolName: 'write', toolCallId },
    rawPayload: { toolInput: { toolName: 'write', params: { file_path: filePath, content: 'payload' } } },
    source: 'openclaw:before_tool_call',
  };
}

function makePluginEvent(filePath: string, toolUseId: string): PluginHookBeforeToolCallEvent {
  return {
    toolName: 'write',
    params: { file_path: filePath, content: 'payload' },
    toolUseId,
  } as PluginHookBeforeToolCallEvent;
}

function makeCtx(): PluginHookToolContext & { workspaceDir: string } {
  return { workspaceDir, sessionId: SESSION_ID, logger: { warn: () => undefined, error: () => undefined, info: () => undefined } };
}

describe('RuleCode canary — real RuleHost gate, interception receipt and lineage', () => {
  it('before activation the rule is not enforced; a non-matching call is never blocked', async () => {
    await persistEvaluatorRuleArtifact();
    const gate = createProductionRuleHostGate();
    // no activation → nothing to evaluate
    const before = await gate(makeHostEvent('/etc/passwd', 'toolu-canary-0'));
    expect(before.decision).toBe('allow');

    await activateLive();
    // activated, but the call does not match the rule → allowed, rule evaluated
    const unmatched = await gate(makeHostEvent('/project/file.txt', 'toolu-canary-1'));
    expect(unmatched.decision).toBe('allow');
    expect((unmatched.metadata as { evaluatedLiveRules?: number }).evaluatedLiveRules).toBe(1);
  }, 60_000);

  it('live rule: the gate really executes the rule, denies, and the receipt carries the activated rule\'s lineage', async () => {
    await persistEvaluatorRuleArtifact();
    await activateLive();

    // ── RuleHost Gate (real) ──
    const gate = createProductionRuleHostGate();
    const gateResult = await gate(makeHostEvent('/etc/passwd', 'toolu-canary-2'));
    expect(gateResult.decision).toBe('deny');
    expect(gateResult.reason).toContain(CANARY_BLOCK_REASON);
    const metadata = gateResult.metadata as { ruleId?: string; principleId?: string; evaluations?: { activationId?: string }[] };
    expect(metadata.ruleId).toBe(RULE_ID);
    expect(metadata.principleId).toBe(PRINCIPLE_ID);

    // ── Interception receipt (real plugin adapter) ──
    const handled = handleSharedRuleHostResult(makePluginEvent('/etc/passwd', 'toolu-canary-2'), makeCtx(), gateResult);
    expect(handled?.block).toBe(true);

    // ── the database carries the proof ──
    const db = sqliteConn.getDb();
    const artifact = db.prepare('SELECT source_principle_id AS p, source_rule_id AS r FROM pi_artifacts WHERE artifact_id = ?')
      .get(ARTIFACT_ID) as { p: string; r: string };
    const activation = db.prepare('SELECT activation_id AS id, target_ref AS t, action AS a FROM activations WHERE artifact_id = ?')
      .get(ARTIFACT_ID) as { id: string; t: string; a: string };
    const applications = db.prepare(
      'SELECT principle_id AS p, rule_id AS r, activation_id AS a, kind AS k, channel AS c, tool_name AS tool FROM principle_applications WHERE kind = ?',
    ).all('rule_blocked') as { p: string; r: string; a: string | null; k: string; c: string; tool: string }[];

    expect(activation.a).toBe('code_tool_hook_live_activate');
    expect(metadata.evaluations?.some((evaluation) => evaluation.activationId === activation.id)).toBe(true);
    expect(applications).toHaveLength(1);
    const receipt = applications[0];
    // principle UUID: pi_artifacts.source_principle_id == principle_applications.principle_id
    expect(receipt?.p).toBe(artifact.p);
    // rule identity: pi_artifacts.source_rule_id == activations.target_ref == principle_applications.rule_id
    expect(activation.t).toBe(`impl://${artifact.r}_${ARTIFACT_VERSION}`);
    expect(receipt?.r).toBe(artifact.r);
    // interception receipt corresponds to the activated rule
    expect(receipt?.a).toBe(activation.id);
    expect(receipt?.c).toBe('code_tool_hook');
    expect(receipt?.tool).toBe('write');

    // gate_blocks row in the workspace trajectory database
    const trajectory = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true });
    try {
      const blocks = trajectory.prepare('SELECT tool_name AS tool, reason AS reason FROM gate_blocks').all() as { tool: string; reason: string }[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.tool).toBe('write');
      expect(blocks[0]?.reason).toContain(CANARY_BLOCK_REASON);
    } finally {
      trajectory.close();
    }
  }, 60_000);
});
