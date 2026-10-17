/**
 * SPEC-RULECODE-QUALITY-001 A3 / Q10 / Q19 / Q24 — mandatory runtime
 * suspension of context-dependent (requiresContextVersion: 2) rules.
 *
 * The negative-control rule below deliberately LACKS the unavailable
 * self-protection a well-formed v2 rule carries. Before the fix, a truthy
 * UNAVAILABLE_RULE_CONTEXT (provider fault) or a schema-valid unavailable
 * context passed the `!context` isolation check and the rule still EXECUTED
 * (isolated probe: deny + 1 evaluation). After the fix the shared gate must
 * skip the rule BEFORE compilation/evaluation for every fault kind:
 *
 *   Q10  provider absent / returns undefined / returns invalid object /
 *        throws / returns schema-valid unavailable / gate deadline exceeded —
 *        each asserted as its own real path (not one merged exception class);
 *        provider available → the rule DOES run (positive control).
 *   Q19  a healthy context-free (v1) live rule keeps evaluating while the v2
 *        sibling is suspended, and a suspended v2 SHADOW observation never
 *        influences the live decision.
 *   Q24  a degraded allow (deadline) records evaluatedLiveRules=0 and never
 *        reads as successful governance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  getDefaultPdConfig,
  SqliteActivationStateStore,
  SqliteConnection,
  type RuleContextV2,
} from '@principles/core/runtime-v2';
import { createProductionHostRuntime } from '../src/index.js';

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-v2-isolation-'));
  tempDirs.push(workspaceDir);
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(getDefaultPdConfig()), 'utf8');
  return workspaceDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

/**
 * The negative-control v2 rule: NO unavailable self-protection. If the gate
 * ever lets it execute, it blocks unconditionally — deny proves execution.
 */
const V2_NO_SELF_PROTECTION_CODE = `
function evaluate(input) {
  return { decision: 'block', matched: true, reason: 'V2_NO_SELF_PROTECTION_EXECUTED_995' };
}
var meta = { name: 'v2-no-self-protection', version: '1', ruleId: 'R_V2_NOSELF_995', coversCondition: 'all' };
`;

/** Context-free (v1) healthy rule: blocks only /etc/passwd. */
const V1_HEALTHY_CODE = `
function evaluate(input) {
  if (input.action.normalizedPath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'V1_HEALTHY_BLOCK_995' };
  }
  return { decision: 'allow', matched: false, reason: 'V1_HEALTHY_ALLOW_995' };
}
var meta = { name: 'v1-healthy', version: '1', ruleId: 'R_V1_HEALTHY_995', coversCondition: 'all' };
`;

interface SeedOptions {
  implementationCode: string;
  requiresContextVersion?: 2;
  action: 'code_tool_hook_live_activate' | 'code_tool_hook_shadow_activate';
  suffix: string;
  ruleId: string;
}

async function seedRule(workspaceDir: string, options: SeedOptions): Promise<void> {
  const connection = new SqliteConnection(workspaceDir);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(`
      INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `art-${options.suffix}`, 'rule', `task-${options.suffix}`, `P_${options.suffix}`, options.ruleId, '[]', 'validated',
      JSON.stringify({
        principleId: `P_${options.suffix}`, ruleId: options.ruleId, implementationCode: options.implementationCode,
        ...(options.requiresContextVersion === 2 ? { requiresContextVersion: 2 } : {}),
      }),
      now, now,
    );
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${options.suffix}`, idempotencyKey: `${options.suffix}::${options.action}`, artifactId: `art-${options.suffix}`,
      channel: 'code_tool_hook', action: options.action, targetRef: `impl://${options.ruleId}`,
      activatedAt: now, deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

function gateEvent(workspaceDir: string, filePath: string) {
  return {
    kind: 'before_tool_call' as const,
    context: { workspaceDir, sessionId: 'session-v2-isolation', toolName: 'write_file' },
    rawPayload: { toolInput: { toolName: 'write_file', params: { file_path: filePath, content: 'x' } } },
    source: 'test:v2-isolation',
  };
}

const AVAILABLE_CONTEXT: RuleContextV2 = {
  version: 2,
  history: { status: 'available', truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'no', readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: 0 },
};

/** Schema-VALID unavailable context (a real host may legitimately declare this). */
const SCHEMA_VALID_UNAVAILABLE: RuleContextV2 = {
  version: 2,
  history: { status: 'unavailable', unavailableReason: 'history window not persisted for this session', truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown', readCount: null, writeCount: null, uniqueWritePathCount: null, sameActionBlockCount: null },
};

async function seedV2Rule(workspaceDir: string): Promise<void> {
  await seedRule(workspaceDir, {
    implementationCode: V2_NO_SELF_PROTECTION_CODE, requiresContextVersion: 2,
    action: 'code_tool_hook_live_activate', suffix: 'v2noself', ruleId: 'R_V2_NOSELF_995',
  });
}

describe('production rulehost gate — mandatory v2 suspension (SPEC-RULECODE-QUALITY-001 A3)', () => {
  it('Q10 positive control: an available context lets the v2 rule execute', async () => {
    const workspaceDir = tempWorkspace();
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => AVAILABLE_CONTEXT,
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    await expect(runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'))).resolves.toMatchObject({
      decision: 'deny', reason: 'V2_NO_SELF_PROTECTION_EXECUTED_995',
      metadata: { evaluatedLiveRules: 1 },
    });
  });

  it('Q10 suspends the v2 rule when no provider is configured', async () => {
    const workspaceDir = tempWorkspace();
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
    expect(result.decision).toBe('allow');
    expect(result.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_absent/);
    expect(result.metadata?.evaluatedLiveRules).toBe(0);
    expect(JSON.stringify(result.metadata?.evaluations)).not.toContain('R_V2_NOSELF_995');
  });

  it('Q10 suspends the v2 rule when the provider returns undefined', async () => {
    const workspaceDir = tempWorkspace();
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => undefined,
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
    expect(result.decision).toBe('allow');
    expect(result.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_returned_undefined/);
    expect(result.metadata?.evaluatedLiveRules).toBe(0);
  });

  it('Q10 suspends the v2 rule when the provider returns an invalid object', async () => {
    const workspaceDir = tempWorkspace();
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => ({ version: 3, bogus: true }),
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
    expect(result.decision).toBe('allow');
    expect(result.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_invalid/);
    expect(result.metadata?.evaluatedLiveRules).toBe(0);
  });

  it('Q10 suspends the v2 rule when the provider throws', async () => {
    const workspaceDir = tempWorkspace();
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => { throw new Error('PROVIDER_EXPLODED_995'); },
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
    expect(result.decision).toBe('allow');
    expect(result.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_failed/);
    expect(result.warnings?.join('\n')).toContain('PROVIDER_EXPLODED_995');
    expect(result.metadata?.evaluatedLiveRules).toBe(0);
  });

  it('Q10 suspends the v2 rule when the provider returns a schema-valid unavailable context', async () => {
    const workspaceDir = tempWorkspace();
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => SCHEMA_VALID_UNAVAILABLE,
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });
    const result = await runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
    expect(result.decision).toBe('allow');
    expect(result.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*history_unavailable/);
    expect(result.metadata?.evaluatedLiveRules).toBe(0);
  });

  it('Q10/Q24 suspends every rule when the overall gate deadline is exhausted and never records governance success', async () => {
    vi.useFakeTimers();
    try {
      const workspaceDir = tempWorkspace();
      await seedV2Rule(workspaceDir);
      const runtime = createProductionHostRuntime({
        ruleContextProvider: () => new Promise(() => { /* never settles inside the gate budget */ }),
        afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
      });
      const pending = runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
      await vi.advanceTimersByTimeAsync(3_100);
      const result = await pending;
      expect(result.decision).toBe('allow');
      expect(result.warnings?.join('\n')).toMatch(/gate_deadline_exceeded.*nextAction=/);
      expect(result.metadata?.evaluatedLiveRules).toBe(0);
      const evaluations = result.metadata?.evaluations;
      if (Array.isArray(evaluations) && evaluations.length > 0) {
        expect(evaluations[0]).toMatchObject({ decision: 'no_rules_armed' });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('Q19 a healthy v1 live rule keeps enforcing while the faulting provider suspends only the v2 sibling', async () => {
    const workspaceDir = tempWorkspace();
    await seedRule(workspaceDir, {
      implementationCode: V1_HEALTHY_CODE,
      action: 'code_tool_hook_live_activate', suffix: 'v1healthy', ruleId: 'R_V1_HEALTHY_995',
    });
    await seedV2Rule(workspaceDir);
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => { throw new Error('PROVIDER_EXPLODED_995'); },
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });

    const denied = await runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'));
    expect(denied).toMatchObject({ decision: 'deny', reason: 'V1_HEALTHY_BLOCK_995' });
    expect(denied.metadata?.evaluatedLiveRules).toBe(1);
    expect(denied.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_failed/);

    const allowed = await runtime.dispatch(gateEvent(workspaceDir, '/project/file.txt'));
    expect(allowed.decision).toBe('allow');
    expect(allowed.metadata?.evaluatedLiveRules).toBe(1);
  });

  it('Q19 a suspended v2 shadow observation never influences the live decision', async () => {
    const workspaceDir = tempWorkspace();
    await seedRule(workspaceDir, {
      implementationCode: V1_HEALTHY_CODE,
      action: 'code_tool_hook_live_activate', suffix: 'v1healthy', ruleId: 'R_V1_HEALTHY_995',
    });
    await seedRule(workspaceDir, {
      implementationCode: V2_NO_SELF_PROTECTION_CODE, requiresContextVersion: 2,
      action: 'code_tool_hook_shadow_activate', suffix: 'v2shadow', ruleId: 'R_V2_SHADOW_995',
    });
    const runtime = createProductionHostRuntime({
      ruleContextProvider: () => undefined,
      afterToolCall: async (event) => ({ decision: 'observe', source: event.source }),
    });

    const denied = await runtime.dispatch(gateEvent(workspaceDir, '/etc/passwd'));
    expect(denied).toMatchObject({ decision: 'deny', reason: 'V1_HEALTHY_BLOCK_995', metadata: { evaluatedLiveRules: 1 } });
    // The suspended shadow rule contributes NO evaluation fact — its would-be
    // unconditional block must not appear anywhere in the result.
    expect(JSON.stringify(denied.metadata)).not.toContain('R_V2_SHADOW_995');
    expect(denied.warnings?.join('\n')).toMatch(/rule_context_v2_unavailable.*provider_returned_undefined/);
  });
});
