/**
 * PRI-1187 — `affectedTools` execution filter.
 *
 * Regression: the shared gate evaluated EVERY active rule for EVERY gated
 * call, so a rule declaring `affectedTools: ['write_file']` also blocked
 * `exec` (and, before PRI-1184 routed read/search away, `read`) calls it was
 * never meant to govern.
 *
 * These tests pin BOTH directions:
 *   - a declared write-only rule does NOT participate in exec/read calls;
 *   - the same rule still blocks write calls;
 *   - an UNDECLARED rule keeps pre-PRI-1187 behavior (still evaluated);
 *   - an UNKNOWN declared name keeps the rule (fail-safe: an unrecognized
 *     tool name must never be the reason a rule stops enforcing).
 *
 * Reverse control: commenting out the `ruleGovernsCanonicalKind` call in
 * production-rulehost-gate.ts makes the exec case red ("does not participate
 * in exec calls"), proving these tests measure the filter itself.
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

const RULE_ID = 'R_AFFECTED_TOOLS_001';
const PRINCIPLE_ID = 'P_AFFECTED_TOOLS_001';

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;
let seq = 0;

/** Artifact whose implementation ALWAYS blocks when it is evaluated. */
function artifactContent(affectedTools?: readonly string[]): string {
  const base = {
    principleId: PRINCIPLE_ID,
    ruleId: RULE_ID,
    implementationCode:
      "function evaluate(input) { return { decision: 'block', matched: true, reason: 'declared-scope rule fired' }; }",
    goldenTrace: {
      traceId: 'trace-affected-tools',
      cases: [
        { caseId: 'case-block', kind: 'negative', toolName: 'write_file', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      ],
      createdAt: '2026-11-12T00:00:00.000Z',
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
  };
  return JSON.stringify(affectedTools === undefined ? base : { ...base, affectedTools });
}

async function seedRule(affectedTools?: readonly string[]): Promise<void> {
  seq += 1;
  const artifactId = `art-affected-tools-${seq}`;
  const activationId = `act-code-R_AFFECTED_TOOLS_001-${seq}`;
  const content = artifactContent(affectedTools);
  const row: PiArtifactRow = {
    artifact_id: artifactId,
    artifact_kind: 'rule',
    source_task_id: 'task-affected-tools-001',
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
  // No activation_decisions row: legacy-shaped activation (digest gate N/A).
  await new SqliteActivationStateStore(sqliteConn).recordActivation({
    activationId,
    idempotencyKey: `${artifactId}::code_tool_hook`,
    artifactId,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}-${seq}`,
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  });
}

/** Runtime stub: always blocks, and records how many candidates it evaluated. */
function makeCountingRuntime(): { runtime: RuleImplementationRuntime; batchSizes: number[] } {
  const batchSizes: number[] = [];
  const runtime: RuleImplementationRuntime = {
    evaluateBatch(rules: readonly RuleBatchSource[]): RuleBatchEvaluation {
      batchSizes.push(rules.length);
      return {
        ok: true,
        results: rules.map(() => ({
          ok: true as const,
          result: { decision: 'block', matched: true, reason: 'declared-scope rule fired' },
        })),
      };
    },
  };
  return { runtime, batchSizes };
}

function makeEvent(toolName: string, params: Record<string, unknown>): HostEvent {
  return {
    kind: 'before_tool_call',
    context: {
      workspaceDir: tempWorkspaceDir,
      sessionId: 'affected-tools-session',
      toolName,
    },
    rawPayload: { toolInput: { toolName, params } },
    source: 'test',
  } as unknown as HostEvent;
}

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-affected-tools-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe('PRI-1187: declared affectedTools scope gates participation', () => {
  it('does not participate in read calls (allow, zero evaluations)', async () => {
    await seedRule(['write_file']);
    const { runtime, batchSizes } = makeCountingRuntime();
    const gate = createProductionRuleHostGate({ implementationRuntime: runtime });

    const result = await gate(makeEvent('read_file', { path: 'src/a.ts' }));

    expect(result.decision).toBe('allow');
    expect(batchSizes).toHaveLength(0);
    expect(result.metadata?.['evaluatedLiveRules']).toBe(0);
  });

  it('does not participate in exec calls (allow, zero evaluations)', async () => {
    await seedRule(['write_file']);
    const { runtime, batchSizes } = makeCountingRuntime();
    const gate = createProductionRuleHostGate({ implementationRuntime: runtime });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(result.decision).toBe('allow');
    expect(batchSizes).toHaveLength(0);
    expect(result.metadata?.['evaluatedLiveRules']).toBe(0);
    const evaluations = result.metadata?.['evaluations'] as Array<Record<string, unknown>>;
    expect(evaluations[0]?.['decision']).toBe('no_rules_armed');
  });

  it('still blocks the write call it declared', async () => {
    await seedRule(['write_file']);
    const { runtime, batchSizes } = makeCountingRuntime();
    const gate = createProductionRuleHostGate({ implementationRuntime: runtime });

    const result = await gate(makeEvent('write_file', { path: 'src/a.ts', content: 'x' }));

    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('declared-scope rule fired');
    expect(batchSizes).toEqual([1]);
  });

  it('keeps an UNKNOWN declared tool name in the evaluation set (fail-safe)', async () => {
    await seedRule(['totally_unknown_tool_xyz']);
    const { runtime, batchSizes } = makeCountingRuntime();
    const gate = createProductionRuleHostGate({ implementationRuntime: runtime });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(result.decision).toBe('deny');
    expect(batchSizes).toEqual([1]);
  });

  it('keeps an UNDECLARED rule evaluated exactly as before', async () => {
    await seedRule(undefined);
    const { runtime, batchSizes } = makeCountingRuntime();
    const gate = createProductionRuleHostGate({ implementationRuntime: runtime });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(result.decision).toBe('deny');
    expect(batchSizes).toEqual([1]);
  });
});
