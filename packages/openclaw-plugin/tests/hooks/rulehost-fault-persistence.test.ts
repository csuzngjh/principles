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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import { EventLogService } from '../../src/core/event-log.js';

type HookResult = Parameters<typeof handleSharedRuleHostResult>[2];

const logger = { warn: () => {}, info: () => {}, error: () => {} };

let workspaceDir: string;
let stateDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-rulehost-faults-'));
  // WorkspaceContext binds state to `<workspace>/.state` (PRI-824).
  stateDir = path.resolve(workspaceDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
