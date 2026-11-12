/**
 * PRI-1187 follow-up — observation-only `affectedTools` mismatch signal.
 *
 * The runtime deliberately does NOT filter by declaration (over-block is
 * accepted noise). To decide later whether that tradeoff stays, the gate
 * records when a declared scope did not cover the action while the rule was
 * still evaluated. These tests pin:
 *   - the signal fires with rule id, declared families, action family, decision;
 *   - the verdict is unchanged (still deny);
 *   - matching declarations, undeclared rules, `enabled:false` and
 *     PD_AFFECTED_TOOLS_OBSERVABILITY=0 emit nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteConnection,
  SqliteActivationStateStore,
  type PiArtifactRow,
} from '@principles/core/runtime';
import type { HostEvent } from '@principles/core/host';
import { createProductionRuleHostGate, type AffectedToolsMismatchEvent } from '../src/production-rulehost-gate.js';
import type { RuleBatchEvaluation, RuleBatchSource, RuleImplementationRuntime } from '../src/rule-implementation-runtime.js';

const RULE_ID = 'R_AFFECTED_TOOLS_OBS';
const PRINCIPLE_ID = 'P_AFFECTED_TOOLS_OBS';

let tempWorkspaceDir: string;
let sqliteConn: SqliteConnection;

async function seedRule(affectedTools?: readonly string[]): Promise<void> {
  const artifactId = 'art-affected-tools-obs';
  const base = {
    principleId: PRINCIPLE_ID,
    ruleId: RULE_ID,
    implementationCode:
      "function evaluate() { return { decision: 'block', matched: true, reason: 'declared-scope rule fired' }; }",
    goldenTrace: {
      traceId: 'trace-affected-tools-obs',
      cases: [
        { caseId: 'case-block', kind: 'negative', toolName: 'write', params: { path: '/etc/passwd' }, expectedDecision: 'block' },
      ],
      createdAt: '2026-11-12T00:00:00.000Z',
      version: 1,
    },
    ruleHostGateDecision: 'accepted_shadow',
  };
  const content = JSON.stringify(affectedTools === undefined ? base : { ...base, affectedTools });
  const row: PiArtifactRow = {
    artifact_id: artifactId,
    artifact_kind: 'rule',
    source_task_id: 'task-affected-tools-obs',
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
    activationId: 'act-code-affected-tools-obs',
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
    context: { workspaceDir: tempWorkspaceDir, sessionId: 'affected-tools-obs', toolName },
    rawPayload: { toolInput: { toolName, params } },
    source: 'test',
  } as unknown as HostEvent;
}

beforeEach(() => {
  tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-affected-tools-obs-'));
  sqliteConn = new SqliteConnection(tempWorkspaceDir);
  sqliteConn.getDb();
});

afterEach(() => {
  try { sqliteConn?.close(); } catch { /* best-effort */ }
  try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* Windows */ }
  vi.unstubAllEnvs();
});

describe('PRI-1187 observation: declared scope vs evaluated action', () => {
  it('emits one event for a write-only rule evaluated on exec — and the verdict is unchanged', async () => {
    await seedRule(['write']);
    const { runtime, batchSizes } = makeCountingRuntime();
    const events: AffectedToolsMismatchEvent[] = [];
    const gate = createProductionRuleHostGate({
      implementationRuntime: runtime,
      affectedToolsObservability: { sink: (event) => events.push(event) },
    });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(batchSizes).toEqual([1]);
    expect(result.decision).toBe('deny');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ruleId: RULE_ID,
      activationId: 'act-code-affected-tools-obs',
      activationMode: 'live',
      toolName: 'exec',
      actionFamily: 'execute',
      declaredTools: ['write'],
      declaredFamilies: ['write'],
      decision: 'block',
    });
  });

  it('emits nothing when the declaration covers the action', async () => {
    await seedRule(['write']);
    const { runtime } = makeCountingRuntime();
    const events: AffectedToolsMismatchEvent[] = [];
    const gate = createProductionRuleHostGate({
      implementationRuntime: runtime,
      affectedToolsObservability: { sink: (event) => events.push(event) },
    });

    const result = await gate(makeEvent('write', { path: 'src/a.ts', content: 'x' }));

    expect(result.decision).toBe('deny');
    expect(events).toHaveLength(0);
  });

  it('emits nothing for an UNDECLARED rule', async () => {
    await seedRule(undefined);
    const { runtime } = makeCountingRuntime();
    const events: AffectedToolsMismatchEvent[] = [];
    const gate = createProductionRuleHostGate({
      implementationRuntime: runtime,
      affectedToolsObservability: { sink: (event) => events.push(event) },
    });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(result.decision).toBe('deny');
    expect(events).toHaveLength(0);
  });

  it('can be disabled by config without changing the verdict', async () => {
    await seedRule(['write']);
    const { runtime } = makeCountingRuntime();
    const events: AffectedToolsMismatchEvent[] = [];
    const gate = createProductionRuleHostGate({
      implementationRuntime: runtime,
      affectedToolsObservability: { enabled: false, sink: (event) => events.push(event) },
    });

    const result = await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    expect(result.decision).toBe('deny');
    expect(events).toHaveLength(0);
  });

  it('can be disabled by PD_AFFECTED_TOOLS_OBSERVABILITY=0 (default is on)', async () => {
    await seedRule(['write']);
    const { runtime } = makeCountingRuntime();
    const events: AffectedToolsMismatchEvent[] = [];
    const gate = createProductionRuleHostGate({
      implementationRuntime: runtime,
      affectedToolsObservability: { sink: (event) => events.push(event) },
    });
    vi.stubEnv('PD_AFFECTED_TOOLS_OBSERVABILITY', '0');
    // The sink is resolved per gate construction, so rebuild after stubbing.
    const disabledGate = createProductionRuleHostGate({
      implementationRuntime: runtime,
      affectedToolsObservability: { sink: (event) => events.push(event) },
    });

    await gate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));
    await disabledGate(makeEvent('exec', { path: 'src/a.ts', command: 'npm test' }));

    // Only the gate constructed before the env flip emitted.
    expect(events).toHaveLength(1);
  });
});
