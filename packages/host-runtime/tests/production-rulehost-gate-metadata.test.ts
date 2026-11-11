/**
 * Shared-gate metadata for non-block verdicts (legacy fallback convergence).
 *
 * The OpenClaw adapter used to receive only `ruleDecision` for auto_correct /
 * requireApproval and re-evaluated the same activations through the legacy
 * RuleHost to obtain the proposal and attribution. These tests pin the
 * host-neutral facts the shared gate now carries instead:
 *   - winner ruleId / principleId
 *   - matched flag
 *   - the rule's reason
 *   - the already-merged correction proposal (auto_correct only)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteConnection,
  SqliteActivationStateStore,
  mapPiArtifactRow,
  type PiArtifactRow,
} from '@principles/core/runtime';
import type { HostEvent } from '@principles/core/host';
import { createProductionRuleHostGate } from '../src/production-rulehost-gate.js';
import type { RuleImplementationRuntime, RuleBatchEvaluation } from '../src/rule-implementation-runtime.js';

const RULE_ID = 'R_CONVERGENCE_META_001';
const ARTIFACT_ID = 'art-convergence-meta-001';
const ACTIVATION_ID = 'act_code_R_CONVERGENCE_META_001';
const PRINCIPLE_ID = 'P_CONVERGENCE_META_001';

const PROPOSAL = {
  proposedParams: { content: 'fixed content' },
  correctedFields: [
    { field: 'content', original: 'broken content', proposed: 'fixed content', reason: 'normalize' },
  ],
  applicationMode: 'live' as const,
  confidence: 0.9,
  ruleId: RULE_ID,
  principleId: PRINCIPLE_ID,
  notifyAgent: true,
};

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

function contentJson(): string {
  return JSON.stringify({
    principleId: PRINCIPLE_ID,
    ruleId: RULE_ID,
    implementationCode: `
function evaluate(input, helpers) {
  return { decision: 'allow', matched: false, reason: 'stub' };
}
var meta = { name: 'convergence-meta-rule', version: '1', ruleId: '${RULE_ID}', coversCondition: 'all' };
`,
    goldenTrace: {
      traceId: 'trace-convergence',
      cases: [
        { caseId: 'case-allow', kind: 'positive', toolName: 'write_file', params: { path: 'src/a.ts' }, expectedDecision: 'allow' },
      ],
      createdAt: '2026-09-22T00:00:00.000Z',
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write_file'],
    painReasonSummary: 'Test: metadata for non-block verdicts',
  });
}

async function seedActivation(): Promise<void> {
  const row: PiArtifactRow = {
    artifact_id: ARTIFACT_ID,
    artifact_kind: 'rule',
    source_task_id: 'task-convergence-001',
    source_principle_id: PRINCIPLE_ID,
    source_rule_id: RULE_ID,
    lineage_artifact_ids: '[]',
    validation_status: 'validated',
    content_json: contentJson(),
    created_at: '2026-09-22T00:00:00.000Z',
    updated_at: '2026-09-22T00:00:00.000Z',
  };
  sqliteConn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.artifact_id, row.artifact_kind, row.source_task_id, row.source_principle_id, row.source_rule_id, row.lineage_artifact_ids, row.validation_status, row.content_json, row.created_at, row.updated_at);
  // No activation_decisions row: legacy-shaped activation (digest gate N/A).
  expect(mapPiArtifactRow(row).sourceRuleId).toBe(RULE_ID);
  const store = new SqliteActivationStateStore(sqliteConn);
  await store.recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

function makeStubRuntime(result: Record<string, unknown>): RuleImplementationRuntime {
  return {
    evaluateBatch(): RuleBatchEvaluation {
      return { ok: true, results: [{ ok: true, result }] };
    },
  };
}

function makeEvent(): HostEvent {
  return {
    kind: 'before_tool_call',
    context: {
      workspaceDir: tempWorkspaceDir,
      sessionId: 'convergence-meta-session',
      toolName: 'write_file',
    },
    rawPayload: { toolInput: { toolName: 'write_file', params: { path: 'src/a.ts', content: 'broken content' } } },
    source: 'test',
  } as unknown as HostEvent;
}

beforeEach(async () => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-meta-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
  await seedActivation();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('production gate: non-block verdict metadata', () => {
  it('carries attribution, reason and the proposal for auto_correct', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeStubRuntime({
        decision: 'auto_correct',
        matched: true,
        reason: 'normalize content',
        correctionProposal: PROPOSAL,
      }),
    });
    const result = await gate(makeEvent());

    expect(result.decision).toBe('allow');
    expect(result.metadata?.['ruleDecision']).toBe('auto_correct');
    expect(result.metadata?.['ruleId']).toBe(RULE_ID);
    expect(result.metadata?.['principleId']).toBe(PRINCIPLE_ID);
    expect(result.metadata?.['matched']).toBe(true);
    expect(result.metadata?.['ruleReason']).toBe('normalize content');
    expect(result.metadata?.['correctionProposal']).toEqual(PROPOSAL);

    const evaluations = result.metadata?.['evaluations'];
    expect(Array.isArray(evaluations)).toBe(true);
    const liveEntry = (evaluations as Array<Record<string, unknown>>)
      .find((entry) => entry['activationMode'] === 'live');
    expect(liveEntry?.['activationId']).toBe(ACTIVATION_ID);
  });

  it('carries matched/reason for requireApproval without inventing a winner', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeStubRuntime({
        decision: 'requireApproval',
        matched: true,
        reason: 'needs owner approval',
      }),
    });
    const result = await gate(makeEvent());

    expect(result.decision).toBe('allow');
    expect(result.metadata?.['ruleDecision']).toBe('requireApproval');
    expect(result.metadata?.['matched']).toBe(true);
    expect(result.metadata?.['ruleReason']).toBe('needs owner approval');
    expect(result.metadata?.['correctionProposal']).toBeUndefined();
  });

  it('leaves the normal allow verdict unchanged (allow is implicit: no winner reason)', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeStubRuntime({ decision: 'allow', matched: false, reason: 'no opinion' }),
    });
    const result = await gate(makeEvent());

    expect(result.decision).toBe('allow');
    expect(result.metadata?.['ruleDecision']).toBe('allow');
    expect(result.metadata?.['matched']).toBe(false);
    // mergeDecisions returns undefined when nothing matched (allow is implicit),
    // so the gate must not invent a winner reason the merge never produced.
    expect(result.metadata?.['ruleReason']).toBeUndefined();
    expect(result.metadata?.['correctionProposal']).toBeUndefined();
  });
});
