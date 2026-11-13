/**
 * PRI-1208 Stage 3 — shared-gate faults are persisted through the OpenClaw adapter.
 *
 * The gate returns structured `evaluationFaults`; it must never write host
 * state itself. This adapter maps `unhealthy` / `skipped` onto the existing
 * EventLog schema, deduplicated per process so a persistently broken rule does
 * not write one row per tool call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProductionHostRuntime } from '@principles/host-runtime';
import {
  getDefaultPdConfig,
  SqliteActivationStateStore,
  SqliteConnection,
} from '@principles/core/runtime';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import { EventLogService } from '../../src/core/event-log.js';

type HookResult = Parameters<typeof handleSharedRuleHostResult>[2];

const logger = { warn: () => {}, info: () => {}, error: () => {} };

const createdDirs: string[] = [];
let workspaceDir: string;
let stateDir: string;

function freshWorkspace(): void {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulehost-faults-'));
  createdDirs.push(workspaceDir);
  // WorkspaceContext binds state to `<workspace>/.state` (PRI-824); the gate
  // reads governance rows from `<workspace>/.pd/state.db`.
  stateDir = path.resolve(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
}

beforeEach(freshWorkspace);

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function makeEvent() {
  return {
    toolName: 'write_file',
    params: { file_path: '/tmp/rulehost-fault.txt' },
    toolUseId: 'tool-fault-1',
  } as unknown as Parameters<typeof handleSharedRuleHostResult>[0];
}

function makeResult(faults: unknown[]): HookResult {
  return {
    decision: 'allow',
    source: 'test:rulehost-faults',
    metadata: { evaluatedLiveRules: 0, evaluationFaults: faults },
  } as unknown as HookResult;
}

function dispatch(result: HookResult): void {
  handleSharedRuleHostResult(
    makeEvent(),
    { workspaceDir, sessionId: 'session-faults', toolName: 'write_file', logger } as never,
    result,
  );
  EventLogService.get(stateDir).flush();
}

function readEvents(): Array<Record<string, unknown>> {
  const logsDir = path.join(stateDir, 'logs');
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(logsDir, name), 'utf8').trim().split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('PRI-1208 stage 3: RuleHost evaluation faults are persisted', () => {
  it('writes one rulehost_unhealthy row per process for a repeated defect', () => {
    const fault = {
      kind: 'unhealthy',
      activationId: 'act-unhealthy-1',
      artifactId: 'art-unhealthy-1',
      ruleId: 'R_UNHEALTHY_1',
      mode: 'live',
      reason: 'implementation_unhealthy: SyntaxError',
      nextAction: 'fix the RuleCode and reactivate the rule',
    };

    dispatch(makeResult([fault]));
    dispatch(makeResult([fault]));

    const unhealthy = readEvents().filter((entry) => entry['type'] === 'rulehost_unhealthy');
    expect(unhealthy).toHaveLength(1);
    expect(unhealthy[0]?.['data']).toMatchObject({
      activationId: 'act-unhealthy-1',
      artifactId: 'art-unhealthy-1',
      ruleId: 'R_UNHEALTHY_1',
      reason: 'implementation_unhealthy: SyntaxError',
      nextAction: 'fix the RuleCode and reactivate the rule',
    });
  });

  it('writes rulehost_skipped with the activation mode', () => {
    dispatch(makeResult([{
      kind: 'skipped',
      activationId: 'act-skipped-1',
      artifactId: 'art-skipped-1',
      ruleId: 'R_SKIPPED_1',
      mode: 'shadow',
      reason: 'activation_safety_isolated: act-skipped-1',
      nextAction: 'recover the activation to shadow after reviewing safety evidence',
    }]));

    const skipped = readEvents().filter((entry) => entry['type'] === 'rulehost_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.['data']).toMatchObject({
      activationId: 'act-skipped-1',
      artifactId: 'art-skipped-1',
      ruleId: 'R_SKIPPED_1',
      mode: 'shadow',
    });
  });

  it('keeps distinct activations distinct', () => {
    const base = {
      kind: 'unhealthy' as const,
      artifactId: 'art-multi',
      reason: 'implementation_unhealthy: broken',
      nextAction: 'fix and reactivate',
    };
    dispatch(makeResult([
      { ...base, activationId: 'act-multi-a', ruleId: 'R_A' },
    ]));
    dispatch(makeResult([
      { ...base, activationId: 'act-multi-b', ruleId: 'R_B' },
    ]));

    const unhealthy = readEvents().filter((entry) => entry['type'] === 'rulehost_unhealthy');
    const activationIds = unhealthy.map((entry) => (entry['data'] as Record<string, unknown>)['activationId']);
    expect(activationIds).toEqual(expect.arrayContaining(['act-multi-a', 'act-multi-b']));
  });

  it('ignores malformed fault entries instead of persisting them', () => {
    dispatch(makeResult([{ kind: 'unhealthy', activationId: '' }]));
    expect(readEvents().filter((entry) => entry['type'] === 'rulehost_unhealthy')).toHaveLength(0);
  });
});

/**
 * PRI-1208 review fix 1: the end-to-end lane.
 *
 * The synthetic tests above prove the adapter translation. This one proves the
 * whole chain the deleted `rule-host-unhealthy-visibility.test.ts` covered:
 * a real bad rule is loaded by the shared gate, the gate emits a structured
 * unhealthy fault, and the adapter persists `rulehost_unhealthy` with
 * reason/nextAction. It also keeps the reverse assertion: a healthy rule does
 * NOT produce that event.
 */
describe('PRI-1208 stage 3 E2E: a real gate fault reaches EventLog', () => {
  async function seedRule(
    activationId: string,
    artifactId: string,
    ruleId: string,
    implementationCode: string,
    mode: 'live' | 'shadow' = 'live',
  ): Promise<void> {
    const connection = new SqliteConnection(workspaceDir);
    try {
      const now = new Date().toISOString();
      connection.getDb().prepare(`
        INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, 'rule', `task-${artifactId}`, `P_${ruleId}`, ruleId, '[]', 'validated',
        JSON.stringify({ principleId: `P_${ruleId}`, ruleId, implementationCode }),
        now, now,
      );
      await new SqliteActivationStateStore(connection).recordActivation({
        activationId,
        idempotencyKey: `${activationId}::${mode}`,
        artifactId,
        channel: 'code_tool_hook',
        action: mode === 'live' ? 'code_tool_hook_live_activate' : 'code_tool_hook_shadow_activate',
        targetRef: `impl://${ruleId}`,
        activatedAt: now,
        deactivatedAt: null,
      });
    } finally {
      connection.close();
    }
  }

  async function dispatchGate(toolName: string, params: Record<string, unknown>) {
    const runtime = createProductionHostRuntime({
      hostKind: 'openclaw',
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    return runtime.dispatch({
      kind: 'before_tool_call',
      context: { workspaceDir, sessionId: 'session-e2e', toolName },
      rawPayload: { toolInput: { toolName, params } },
      source: 'test:rulehost-e2e',
    });
  }

  function dispatchAdapter(result: HookResult): void {
    handleSharedRuleHostResult(
      makeEvent(),
      { workspaceDir, sessionId: 'session-e2e', toolName: 'write_file', logger } as never,
      result,
    );
    EventLogService.get(stateDir).flush();
  }

  it('persists rulehost_unhealthy for a rule that fails to compile, and not for a healthy rule', async () => {
    await seedRule('act-e2e-broken', 'art-e2e-broken', 'R_E2E_BROKEN', 'function evaluate(input) {');
    const broken = await dispatchGate('write_file', { file_path: '/tmp/e2e-broken.txt', content: 'x' });
    expect(broken.metadata?.['evaluationFaults']).toEqual([
      expect.objectContaining({
        kind: 'unhealthy',
        activationId: 'act-e2e-broken',
        artifactId: 'art-e2e-broken',
        ruleId: 'R_E2E_BROKEN',
        mode: 'live',
      }),
    ]);
    dispatchAdapter(broken);

    const unhealthy = readEvents().filter((entry) => entry['type'] === 'rulehost_unhealthy');
    expect(unhealthy).toHaveLength(1);
    expect(unhealthy[0]?.['data']).toMatchObject({
      activationId: 'act-e2e-broken',
      artifactId: 'art-e2e-broken',
      ruleId: 'R_E2E_BROKEN',
    });
    expect(String((unhealthy[0]?.['data'] as Record<string, unknown>)['reason'])).toContain('implementation_unhealthy');
    expect(String((unhealthy[0]?.['data'] as Record<string, unknown>)['nextAction'])).toContain('fix the RuleCode');

    // Reverse assertion in a fresh workspace: a healthy rule compiles and
    // produces no unhealthy event at all.
    freshWorkspace();
    await seedRule('act-e2e-healthy', 'art-e2e-healthy', 'R_E2E_HEALTHY',
      'function evaluate() { return { decision: "allow", matched: false, reason: "ok" }; }');
    const healthy = await dispatchGate('write_file', { file_path: '/tmp/e2e-healthy.txt', content: 'x' });
    expect(healthy.metadata?.['evaluationFaults']).toBeUndefined();
    dispatchAdapter(healthy);
    expect(readEvents().filter((entry) => entry['type'] === 'rulehost_unhealthy')).toHaveLength(0);
  });

  it('records evaluation_failed instead of allow when the live batch degrades', async () => {
    // A top-level infinite loop makes the VM child hit the gate deadline, which
    // is the live-path form of the legacy `evaluationStatus: 'failed'`.
    await seedRule('act-e2e-timeout', 'art-e2e-timeout', 'R_E2E_TIMEOUT',
      'function evaluate() { while (true) { /* burn the child deadline */ } }');
    const degraded = await dispatchGate('write_file', { file_path: '/tmp/e2e-timeout.txt', content: 'x' });
    expect(degraded.decision).toBe('allow');
    expect(degraded.metadata?.['evaluationStatus']).toBe('failed');
    expect(Array.isArray(degraded.metadata?.['evaluations'])).toBe(false);
    dispatchAdapter(degraded);

    const evaluated = readEvents().filter((entry) => entry['type'] === 'rulehost_evaluated');
    expect(evaluated.some((entry) => (entry['data'] as Record<string, unknown>)['decision'] === 'evaluation_failed')).toBe(true);
    expect(evaluated.some((entry) => (entry['data'] as Record<string, unknown>)['decision'] === 'allow')).toBe(false);
  }, 15_000);
});
