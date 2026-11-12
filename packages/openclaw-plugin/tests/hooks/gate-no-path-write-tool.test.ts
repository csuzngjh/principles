/**
 * Regression test: write tools without file_path must still be EVALUATED.
 *
 * PRI-286 P1: After removing confirm-first gate, write tools (apply_patch, patch, etc.)
 * that have no file_path/path/file/target param must NOT be silently allowed.
 * They must use a synthetic path `<tool:${toolName}>` and still reach the engine.
 *
 * PR-1 (legacy RuleHost retirement): migrated off the legacy
 * `handleBeforeToolCall` (no production wiring) onto the shared gate
 * `createProductionRuleHostGate` (host-runtime). The shared gate is the input
 * builder the live OpenClaw path uses, so the SAME path-derivation facts are
 * asserted through the input actually handed to the RuleCode engine:
 * `evaluateBatch(rules, input)` receives `input.action.normalizedPath`.
 *
 * Difference annotation: a block is now a `decision: 'deny'` result (the host
 * blocks) instead of a legacy `{ block: true, blockReason }` object.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';
import { createProductionRuleHostGate, type RuleBatchEvaluation, type RuleImplementationRuntime } from '@principles/host-runtime';
import type { HostEvent } from '@principles/core/host';

const RULE_ID = 'R_no_path_fixture';
const PRINCIPLE_ID = 'P_no_path_fixture';
const ARTIFACT_ID = 'art-no-path-fixture';
const ACTIVATION_ID = 'act_code_no-path-fixture';

const RULE_CONTENT_JSON = JSON.stringify({
  ruleId: RULE_ID,
  principleId: PRINCIPLE_ID,
  implementationCode: "function evaluate() { return { decision: 'allow', matched: false, reason: 'stub' }; }\nvar meta = { name: 'no-path-fixture', version: '1', ruleId: 'R_no_path_fixture', coversCondition: 'all' };",
  ruleHostGateDecision: 'accepted_shadow',
  affectedTools: ['write'],
});

/** The slice of the engine input these tests assert on. */
interface CapturedEvaluationInput {
  action: { toolName: string; normalizedPath: string };
}

let tempDirs: string[] = [];
let connections: SqliteConnection[] = [];
let capturedInputs: CapturedEvaluationInput[] = [];

async function seedLiveRuleWorkspace(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-no-path-'));
  const connection = new SqliteConnection(dir);
  connection.getDb();
  tempDirs.push(dir);
  connections.push(connection);
  const now = new Date().toISOString();
  connection.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'rule', ?, ?, ?, '[]', 'validated', ?, ?, ?)
  `).run(ARTIFACT_ID, 'task-no-path', PRINCIPLE_ID, RULE_ID, RULE_CONTENT_JSON, now, now);
  await new SqliteActivationStateStore(connection).recordActivation({
    activationId: ACTIVATION_ID,
    idempotencyKey: `${ARTIFACT_ID}::code_tool_hook`,
    artifactId: ARTIFACT_ID,
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: `impl://${RULE_ID}`,
    activatedAt: now,
    deactivatedAt: null,
  });
  return dir;
}

/** Runtime stub that records the exact `input` the gate hands the engine. */
function makeCapturingRuntime(result: Record<string, unknown>): RuleImplementationRuntime {
  return {
    evaluateBatch(_rules, input): RuleBatchEvaluation {
      capturedInputs.push(input as CapturedEvaluationInput);
      return { ok: true, results: [{ ok: true, result }] };
    },
  };
}

function makeHostEvent(dir: string, toolName: string, params: Record<string, unknown>): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir: dir, sessionId: 'test-no-path', toolName },
    rawPayload: { toolInput: { toolName, params } },
    source: 'test',
  };
}

describe('Write tools without file_path must go through RuleHost', () => {
  let dir: string;

  beforeEach(async () => {
    capturedInputs = [];
    dir = await seedLiveRuleWorkspace();
  });

  afterEach(() => {
    for (const connection of connections) {
      try { connection.close(); } catch { /* Windows may retain native handles */ }
    }
    connections = [];
    for (const tempDir of tempDirs) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
    tempDirs = [];
  });

  it('apply_patch with no path triggers RuleHost evaluate', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeCapturingRuntime({ decision: 'allow', matched: false, reason: 'ok' }),
    });

    const result = await gate(makeHostEvent(dir, 'apply_patch', { patch: 'some diff content' }));

    // Should not be blocked (engine returned allow)
    expect(result.decision).toBe('allow');
    // But the engine MUST have been called
    expect(capturedInputs).toHaveLength(1);
    // Verify synthetic path was used
    expect(capturedInputs[0].action.normalizedPath).toBe('<tool:apply_patch>');
    expect(capturedInputs[0].action.toolName).toBe('apply_patch');
  });

  it('apply_patch with no path: RuleHost block must return block', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeCapturingRuntime({
        decision: 'block',
        matched: true,
        reason: 'Test block: write tool without path',
        ruleId: 'R_TEST',
        principleId: 'P_TEST',
      }),
    });

    const result = await gate(makeHostEvent(dir, 'apply_patch', { patch: 'dangerous content' }));

    // Difference: the shared gate blocks via `decision: 'deny'` (no legacy
    // `{ block, blockReason }` object — the host encodes the block).
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Test block: write tool without path');
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].action.normalizedPath).toBe('<tool:apply_patch>');
    expect(capturedInputs[0].action.toolName).toBe('apply_patch');
  });

  it('write tool with no path still triggers RuleHost evaluate via the synthetic path', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeCapturingRuntime({ decision: 'allow', matched: false, reason: 'ok' }),
    });

    const result = await gate(makeHostEvent(dir, 'write', {}));

    expect(result.decision).toBe('allow');
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].action.normalizedPath).toBe('<tool:write>');
    expect(capturedInputs[0].action.toolName).toBe('write');
  });

  it('Write tool with valid file_path still uses real path', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeCapturingRuntime({ decision: 'allow', matched: false, reason: 'ok' }),
    });

    const result = await gate(makeHostEvent(dir, 'write', { file_path: `${dir}/src/app.ts`, content: 'x' }));

    expect(result.decision).toBe('allow');
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].action.normalizedPath).toBe('src/app.ts');
    expect(capturedInputs[0].action.toolName).toBe('write');
  });

  it('exec with no file target still goes through RuleHost (existing behavior)', async () => {
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeCapturingRuntime({ decision: 'allow', matched: false, reason: 'ok' }),
    });

    const result = await gate(makeHostEvent(dir, 'exec', { command: 'echo hello' }));

    expect(result.decision).toBe('allow');
    expect(capturedInputs).toHaveLength(1);
    // Shell without file target uses the full command as path (existing heuristic)
    expect(capturedInputs[0].action.normalizedPath).toContain('echo hello');
    expect(capturedInputs[0].action.toolName).toBe('exec');
  });
});
