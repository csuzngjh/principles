/**
 * PRI-1187 (Owner decision 2026-11-12) — the shared gate does NOT filter
 * evaluation by `affectedTools`.
 *
 * Safety first: over-blocking (a write-only rule also observing exec) is
 * tolerated noise; under-blocking is not. Three review rounds each found a
 * bypass that let a rule skip a call it was validated to block
 * (`host-liveness:` prefix, narrow declaration vs broad code, trace-only
 * guard), so the runtime keeps evaluating every active rule. This test pins
 * that decision: a rule declaring only the write family still blocks an exec
 * call. If someone re-introduces declaration-based skipping, this goes red.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteConnection,
  SqliteActivationStateStore,
  type PiArtifactRow,
} from '@principles/core/runtime';
import type { HostEvent } from '@principles/core/host';
import { createProductionRuleHostGate } from '../src/production-rulehost-gate.js';
import type { RuleBatchEvaluation, RuleBatchSource, RuleImplementationRuntime } from '../src/rule-implementation-runtime.js';

const RULE_ID = 'R_NO_DECLARATION_FILTER';
const PRINCIPLE_ID = 'P_NO_DECLARATION_FILTER';

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

async function seedWriteOnlyBlockingRule(): Promise<void> {
  const artifactId = 'art-no-declaration-filter';
  const content = JSON.stringify({
    principleId: PRINCIPLE_ID,
    ruleId: RULE_ID,
    implementationCode:
      "function evaluate() { return { decision: 'block', matched: true, reason: 'write-only rule fired' }; }",
    goldenTrace: {
      traceId: 'trace-no-declaration-filter',
      cases: [
        { caseId: 'case-block', kind: 'negative', toolName: 'write', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      ],
      createdAt: '2026-11-12T00:00:00.000Z',
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
    affectedTools: ['write'],
  });
  const row: PiArtifactRow = {
    artifact_id: artifactId,
    artifact_kind: 'rule',
    source_task_id: 'task-no-declaration-filter',
    source_principle_id: PRINCIPLE_ID,
    source_rule_id: RULE_ID,
    lineage_artifact_ids: '[]',
    validation_status: 'validated',
    content_json: content,
    created_at: '2026-11-12T00:00:00.000Z',
    updated_at: '2026-11-12T00:00:00.000Z',
  };
  sqliteConn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.artifact_id, row.artifact_kind, row.source_task_id, row.source_principle_id, row.source_rule_id, row.lineage_artifact_ids, row.validation_status, row.content_json, row.created_at, row.updated_at);
  await new SqliteActivationStateStore(sqliteConn).recordActivation({
    activationId: 'act-code-no-declaration-filter',
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

function makeCountingRuntime(): { runtime: RuleImplementationRuntime; batchSizes: number[] } {
  const batchSizes: number[] = [];
  const runtime: RuleImplementationRuntime = {
    evaluateBatch(rules: readonly RuleBatchSource[]): RuleBatchEvaluation {
      batchSizes.push(rules.length);
      return {
        ok: true,
        results: rules.map(() => ({
          ok: true as const,
          result: { decision: 'block', matched: true, reason: 'write-only rule fired' },
        })),
      };
    },
  };
  return { runtime, batchSizes };
}

function makeEvent(toolName: string, params: Record<string, unknown>): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir: tempWorkspaceDir, sessionId: 'no-declaration-filter', toolName },
    rawPayload: { toolInput: { toolName, params } },
    source: 'test',
  } as unknown as HostEvent;
}

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-no-declaration-filter-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('PRI-1187: affectedTools never filters runtime evaluation', () => {
  it('a write-only rule still blocks an exec call (over-block is accepted noise)', async () => {
    await seedWriteOnlyBlockingRule();
    const { runtime, batchSizes } = makeCountingRuntime();
    const gate = createProductionRuleHostGate({ implementationRuntime: runtime });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(batchSizes).toEqual([1]);
    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('write-only rule fired');
  });
});
