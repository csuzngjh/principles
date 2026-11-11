/**
 * PRI-114: Gate auto_correct shadow mode tests — shared-gate path.
 *
 * PR-1 (legacy RuleHost retirement): these tests used to drive the legacy
 * `handleBeforeToolCall` (`src/hooks/gate.ts`), which has no production wiring
 * any more. The live path is:
 *   - `createProductionRuleHostGate` (host-runtime) — the DECISION / the input
 *     handed to the RuleCode engine;
 *   - `handleSharedRuleHostResult` (openclaw-plugin) — recording / applying /
 *     telemetry for the decision the shared gate already produced.
 *
 * Assertions are preserved per test, on the entry that now owns the behaviour:
 * - Never modifies event.params in shadow mode → a `shadow` correctionProposal
 *   is never applied.
 * - Emits rulehost_auto_correct_proposed telemetry (incl. invalid proposals).
 * - Existing block / requireApproval / allow behaviour unchanged.
 * - Live correction application returns `{ params }` (PRI-174 / PRI-529-D2).
 *
 * Differences are annotated inline:
 * - a deny no longer RETURNS a block object from this handler — the host has
 *   already blocked; the handler accounts the deny instead (blockSource
 *   'rule-host-shared', the retirement marker vs legacy 'rule-host');
 * - the shared gate has no tool-kind entry filter (see the `read` test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';
import { createProductionRuleHostGate, type RuleImplementationRuntime } from '@principles/host-runtime';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { HostEvent, HostEventResult } from '@principles/core/host';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-ac-shadow';

const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
  recordGateBlock: vi.fn(),
};

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

// The handler owns the shared-path recording; keep every sink observable and
// side-effect free so the tests assert the handler's calls, not disk state.
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({ ok: false, errors: [{ reason: 'test: no config' }] })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: true })),
}));

vi.mock('../../src/core/principle-application-ledger.js', () => ({
  recordPrincipleApplication: vi.fn(() => true),
}));

vi.mock('../../src/core/intervention-evidence-recorder.js', () => ({
  recordGateEnforcementEvidence: vi.fn(),
}));

vi.mock('../../src/core/rulecode-safety-circuit.js', () => ({
  observeRuleCodeSafety: vi.fn(() => false),
}));

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: `${ctx.workspaceDir ?? ''}/.state`,
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

// ── Real state.db fixture for the tests whose subject is the DECISION ───────
// `createProductionRuleHostGate` reads live activations from the workspace's
// state.db and evaluates them through the injected implementation runtime, so
// the decision tests need one seeded LIVE activation per temp workspace.

const RULE_ID = 'R_ac_shadow_fixture';
const PRINCIPLE_ID = 'P_ac_shadow_fixture';
const ARTIFACT_ID = 'art-ac-shadow-fixture';
const ACTIVATION_ID = 'act_code_ac-shadow-fixture';

const RULE_CONTENT_JSON = JSON.stringify({
  ruleId: RULE_ID,
  principleId: PRINCIPLE_ID,
  implementationCode: "function evaluate() { return { decision: 'allow', matched: false, reason: 'stub' }; }\nvar meta = { name: 'ac-shadow-fixture', version: '1', ruleId: 'R_ac_shadow_fixture', coversCondition: 'all' };",
  ruleHostGateDecision: 'accepted_shadow',
  affectedTools: ['write', 'read'],
});

let tempDirs: string[] = [];
let connections: SqliteConnection[] = [];

async function seedLiveRuleWorkspace(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ac-shadow-'));
  const connection = new SqliteConnection(dir);
  connection.getDb();
  tempDirs.push(dir);
  connections.push(connection);
  const now = new Date().toISOString();
  connection.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'rule', ?, ?, ?, '[]', 'validated', ?, ?, ?)
  `).run(ARTIFACT_ID, 'task-ac-shadow', PRINCIPLE_ID, RULE_ID, RULE_CONTENT_JSON, now, now);
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

function makeStubRuntime(result: Record<string, unknown>): RuleImplementationRuntime {
  return {
    evaluateBatch(): { ok: true; results: Array<{ ok: boolean; result?: unknown }> } {
      return { ok: true, results: [{ ok: true, result }] };
    },
  };
}

function makeHostEvent(dir: string, toolName: string, params: Record<string, unknown>): HostEvent {
  return {
    kind: 'before_tool_call',
    context: { workspaceDir: dir, sessionId, toolName },
    rawPayload: { toolInput: { toolName, params } },
    source: 'test',
  };
}

// ── Shared result / event fixtures ─────────────────────────────────────────

function makeValidProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposedParams: { content: 'fixed content' },
    correctedFields: [
      { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'typo' },
    ],
    applicationMode: 'shadow' as const,
    confidence: 0.9,
    ruleId: 'R_ac_test',
    principleId: 'P_ac_test',
    notifyAgent: true,
    ...overrides,
  };
}

function makeWriteEvent(params: Record<string, unknown> = {}) {
  return {
    toolName: 'write',
    params: { file_path: '/mock/workspace/src/foo.ts', content: 'broken', ...params },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceDir,
    sessionId,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

/** The host-neutral metadata the shared gate emits for a non-block verdict. */
function makeSharedMetadata(ruleDecision: string, extra: Record<string, unknown> = {}) {
  return {
    evaluatedLiveRules: 1,
    ruleDecision,
    evaluations: [
      {
        toolName: 'write',
        filePath: '/mock/workspace/src/foo.ts',
        matched: ruleDecision !== 'allow',
        decision: ruleDecision,
        ...(ruleDecision === 'allow' ? {} : { activationId: ACTIVATION_ID }),
        activationMode: 'live',
        hostKind: 'openclaw',
      },
    ],
    ...extra,
  };
}

function makeSharedResult(metadata: Record<string, unknown>): HostEventResult {
  return { decision: 'allow', source: 'before_tool_call', metadata };
}

describe('PRI-114: Gate auto_correct shadow mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const connection of connections) {
      try { connection.close(); } catch { /* Windows may retain native handles */ }
    }
    connections = [];
    for (const dir of tempDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
    tempDirs = [];
  });

  it('auto_correct does NOT modify event.params', () => {
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    const proposal = makeValidProposal();

    const event = makeWriteEvent(originalParams);
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        ruleId: 'R_ac_001',
        matched: true,
        ruleReason: 'fix typo in content',
        correctionProposal: proposal,
      })),
    );

    // Shadow mode: returns undefined (allow), params unchanged
    expect(result).toBeUndefined();
    expect(event.params).toEqual(paramsCopy);
  });

  it('auto_correct with applicationMode live now modifies params (PRI-174 implemented)', () => {
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    const proposal = makeValidProposal({ applicationMode: 'live' });

    const event = makeWriteEvent(originalParams);
    const result = handleSharedRuleHostResult(
      event,
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        ruleId: 'R_ac_test',
        principleId: 'P_ac_test',
        matched: true,
        ruleReason: 'fix typo',
        correctionProposal: proposal,
      })),
    );

    // PRI-174: Live mode now modifies params; PRI-529/D2: corrected params
    // returned via the host contract field
    expect(event.params.content).toBe('fixed content');
    expect(result).toBeDefined();
    expect(result?.params).toMatchObject({ content: 'fixed content' });
    expect(result?.block).toBeUndefined();

    // Verify applied telemetry was emitted
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.ruleId).toBe('R_ac_test');
  });

  it('auto_correct emits rulehost_auto_correct_proposed telemetry', () => {
    const proposal = makeValidProposal();

    handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        ruleId: proposal.ruleId,
        principleId: proposal.principleId,
        matched: true,
        ruleReason: 'fix typo in content',
        correctionProposal: proposal,
      })),
    );

    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const call = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(call.toolName).toBe('write');
    expect(call.ruleId).toBe(proposal.ruleId);
    expect(call.principleId).toBe(proposal.principleId);
    expect(call.confidence).toBe(0.9);
    expect(call.reason).toBe('fix typo in content');
    expect(call.applicationMode).toBe('shadow');
    expect(call.correctedFields).toEqual(['content']);
    expect(call.validationValid).toBe(true);
  });

  it('auto_correct with invalid proposal still emits telemetry with validationValid false', () => {
    handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        matched: true,
        ruleReason: 'fix',
        correctionProposal: {
          // Invalid: proposedParams is a string, missing fields
          proposedParams: 'not-an-object',
        },
      })),
    );

    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const call = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(call.validationValid).toBe(false);
  });

  it('block still takes precedence over auto_correct', async () => {
    // The precedence itself is the shared gate's merge decision: the engine's
    // `block` verdict becomes `decision: 'deny'`, never an auto_correct apply.
    const dir = await seedLiveRuleWorkspace();
    const gate = createProductionRuleHostGate({
      implementationRuntime: makeStubRuntime({
        decision: 'block',
        matched: true,
        reason: 'dangerous operation',
        ruleId: 'R_block',
      }),
    });
    const gateResult = await gate(makeHostEvent(dir, 'write', { file_path: `${dir}/src/foo.ts`, content: 'broken' }));

    expect(gateResult.decision).toBe('deny');

    const event = makeWriteEvent();
    const result = handleSharedRuleHostResult(event, makeCtx() as never, gateResult);

    // The deny wins over auto_correct and is returned as a block result
    // (PRI-1184 / F4); the host still blocks on the same decision.
    expect(result?.block).toBe(true);
    expect(mockEventLogInstance.recordRuleHostBlocked).toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).not.toHaveBeenCalled();
    // DIFF: blockSource is 'rule-host-shared' on the shared path (the legacy
    // hook wrote 'rule-host'). This is the retirement marker, not a regression.
    expect(mockEventLogInstance.recordGateBlock).toHaveBeenCalledTimes(1);
    expect(mockEventLogInstance.recordGateBlock.mock.calls[0][1].blockSource).toBe('rule-host-shared');
  });

  it('requireApproval still works unchanged', () => {
    const result = handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('requireApproval', {
        ruleId: 'R_approval',
        matched: true,
        ruleReason: 'sensitive write',
      })),
    );

    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostRequireApproval).toHaveBeenCalledTimes(1);
  });

  it('allow still works unchanged', () => {
    const result = handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('allow', {
        matched: false,
        ruleReason: 'safe',
      })),
    );

    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledTimes(1);
  });

  it('missing pluginConfig defaults to shadow (no crash)', () => {
    // DIFF: `pluginConfig.autoCorrectLive` is a legacy-hook setting that the
    // shared path does not read — there the proposal's `applicationMode` is the
    // only authority. The surviving intent (a shadow proposal is never applied,
    // and an absent pluginConfig cannot crash the handler) is asserted.
    const proposal = makeValidProposal();

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx({ pluginConfig: undefined }) as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        matched: true,
        ruleReason: 'fix',
        correctionProposal: proposal,
      })),
    );

    expect(result).toBeUndefined();
    expect(event.params).toEqual(paramsCopy);
  });

  it('pluginConfig.autoCorrectLive true now applies live corrections (PRI-174 implemented)', () => {
    // DIFF: the shared path applies because the proposal declares
    // `applicationMode: 'live'`; the legacy `pluginConfig.autoCorrectLive`
    // switch no longer participates. Behaviour under test is unchanged.
    const proposal = makeValidProposal({ applicationMode: 'live' });

    const event = makeWriteEvent();
    const result = handleSharedRuleHostResult(
      event,
      makeCtx({ pluginConfig: { autoCorrectLive: true } }) as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        matched: true,
        ruleReason: 'fix',
        correctionProposal: proposal,
      })),
    );

    // PRI-174: Live mode applies corrections; PRI-529/D2: host contract field
    expect(event.params.content).toBe('fixed content');
    expect(result).toBeDefined();
    expect(result?.params).toMatchObject({ content: 'fixed content' });

    // Verify applied telemetry was emitted
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
  });


  // PRI-114 review: auto_correct without correctionProposal still emits telemetry
  it('auto_correct without correctionProposal emits telemetry with validationValid false', () => {
    const result = handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx() as never,
      makeSharedResult(makeSharedMetadata('auto_correct', {
        ruleId: 'R_no_prop',
        matched: true,
        ruleReason: 'fix but no proposal',
      })),
    );

    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const call = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(call.validationValid).toBe(false);
    expect(call.reason).toContain('no proposal');
  });

  it('non-write/bash/agent tool does not trigger auto_correct evaluation', async () => {
    // PR-A F3': the shared gate restores the legacy routing contract through
    // the existing ToolSemanticRegistry authority. `read` is not in the
    // write/execute/agent families, so the RuleCode engine is never invoked —
    // even though this workspace has a live rule and the stub would propose an
    // auto_correct for any input it receives.
    const dir = await seedLiveRuleWorkspace();
    const stub = makeStubRuntime({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: makeValidProposal({ applicationMode: 'live' }),
    });
    const evaluateBatch = vi.fn(stub.evaluateBatch);
    const gate = createProductionRuleHostGate({ implementationRuntime: { evaluateBatch } });
    const gateResult = await gate(makeHostEvent(dir, 'read', {
      file_path: `${dir}/src/foo.ts`,
      content: 'broken',
    }));

    expect(gateResult.decision).toBe('allow');
    expect(evaluateBatch).not.toHaveBeenCalled();
    expect(gateResult.metadata?.['evaluations'] ?? []).toHaveLength(0);
  });

});
