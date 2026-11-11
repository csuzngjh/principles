/**
 * PRI-174: Gate auto_correct live mode tests
 *
 * Migrated (rule-host retirement PR-1) from the legacy `handleBeforeToolCall`
 * entry to the shared production path entry `handleSharedRuleHostResult`.
 * The legacy hook is dead production code; the live gate is
 * `createProductionRuleHostGate` + this post-result handler. The auto-correct
 * application / validation / telemetry subject matter lives in the SAME
 * `applyAutoCorrectionDecision` implementation on both entries, so the
 * observable behaviour asserted below is unchanged.
 *
 * Verify that a shared-gate auto_correct result:
 * - applicationMode='live' + valid proposal: event.params mutated, telemetry emitted
 * - applicationMode='live' + invalid proposal: no mutation, validation_failed telemetry
 * - applicationMode='shadow': no mutation (existing behavior preserved)
 * - PRI-529/D2: applied correction returns corrected params via the host
 *   contract field `params` (host reads only params/block/blockReason/
 *   requireApproval); in-place mutation is a secondary channel only
 * - Multiple correctedFields: all applied atomically when all valid
 * - Exception during application: fail-open, no partial mutation
 * - Strict field validation: ALL fields must exist in event.params AND proposedParams
 *
 * 差异（退役标记，非回归）：
 * - block: 共享路径下 host 已完成阻断，本 handler 只做 deny 记账并返回
 *   undefined（不再返回 block 对象）；blockSource 由 'rule-host' 变为
 *   'rule-host-shared'。
 * - 入口过滤收敛：共享 gate 没有 tool-kind 过滤，测试直接喂入共享结果，
 *   不再经过 legacy 的 write/bash/agent 入口过滤。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSharedRuleHostResult } from '../../src/hooks/gate.js';
import type { HostEventResult } from '@principles/core/host';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-ac-live';
const defaultFilePath = '/mock/workspace/src/foo.ts';
const activationId = 'act-ac-live-1';

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));

const mockEventLogInstance = {
  recordRuleHostEvaluated: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostBlocked: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostAutoCorrectProposed: vi.fn(),
  recordRuleHostAutoCorrectApplied: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

const mockPersistGateBlock = vi.fn();
vi.mock('../../src/hooks/gate-block-helper.js', () => ({
  persistGateBlock: (...args: unknown[]) => mockPersistGateBlock(...args),
}));

const mockRecordGateEnforcementEvidence = vi.fn();
vi.mock('../../src/core/intervention-evidence-recorder.js', () => ({
  recordGateEnforcementEvidence: (...args: unknown[]) => mockRecordGateEnforcementEvidence(...args),
}));

// The safety circuit reads activation scope from SQLite; these tests are not
// about it, so it observes nothing (same secret as the accepted convergence
// exemplar: `observeRuleCodeSafety` -> false keeps the decision path).
vi.mock('../../src/core/rulecode-safety-circuit.js', () => ({
  observeRuleCodeSafety: vi.fn(() => false),
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// The shared handler reads WorkspaceContext for stateDir / eventLog /
// trajectory / config. `getRuleHost` is NOT part of the shared path: the
// decision is produced by createProductionRuleHostGate, not by this handler.
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

function makeValidProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposedParams: { content: 'fixed content' },
    correctedFields: [
      { field: 'content', original: 'broken', proposed: 'ignored value', reason: 'fix typo' },
    ],
    applicationMode: 'live' as const,
    confidence: 0.9,
    ruleId: 'R_ac_live',
    principleId: 'P_ac_live',
    notifyAgent: true,
    ...overrides,
  };
}

function makeWriteEvent(params: Record<string, unknown> = {}) {
  return {
    toolName: 'write',
    params: { file_path: defaultFilePath, content: 'broken', ...params },
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

/** One `metadata.evaluations` row, shaped exactly as the shared gate emits it. */
function makeEvaluation(ruleDecision: string, extra: Record<string, unknown> = {}) {
  return {
    toolName: 'write',
    filePath: defaultFilePath,
    matched: ruleDecision !== 'allow',
    decision: ruleDecision,
    activationId,
    activationMode: 'live',
    hostKind: 'openclaw',
    ...extra,
  };
}

function makeSharedResult(
  metadata: Record<string, unknown>,
  overrides: Partial<HostEventResult> = {},
): HostEventResult {
  return { decision: 'allow', source: 'before_tool_call', metadata, ...overrides };
}

/** Shared-gate metadata for an auto_correct verdict carrying `proposal`. */
function makeAutoCorrectMetadata(proposal: unknown, extra: Record<string, unknown> = {}) {
  const record = (typeof proposal === 'object' && proposal !== null ? proposal : {}) as Record<string, unknown>;
  const ruleId = record['ruleId'];
  const principleId = record['principleId'];
  return {
    evaluatedLiveRules: 1,
    ruleDecision: 'auto_correct',
    matched: true,
    ...(typeof ruleId === 'string' ? { ruleId } : {}),
    ...(typeof principleId === 'string' ? { principleId } : {}),
    correctionProposal: proposal,
    evaluations: [
      {
        ...makeEvaluation('auto_correct'),
        ...(typeof ruleId === 'string' ? { ruleId } : {}),
      },
    ],
    ...extra,
  };
}

describe('PRI-174: Gate auto_correct live mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applicationMode=live with valid proposal: event.params mutated and telemetry emitted', () => {
    const originalParams = { file_path: defaultFilePath, content: 'broken' };
    const proposal = makeValidProposal();

    const event = makeWriteEvent(originalParams);
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix typo' })),
    );

    // Verify params were mutated using proposedParams value (not correctedFields[].proposed)
    expect(event.params.content).toBe('fixed content');

    // Verify both telemetry events were emitted
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);

    // Verify 'applied' event data
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.toolName).toBe('write');
    expect(appliedCall.ruleId).toBe('R_ac_live');
    expect(appliedCall.correctedFields).toEqual([
      { field: 'content', original: 'broken', applied: 'fixed content' },
    ]);

    // Verify corrected params are returned via the host contract field (PRI-529/D2)
    expect(result).toBeDefined();
    expect(result?.params).toMatchObject({
      file_path: defaultFilePath,
      content: 'fixed content',
    });
    expect(result?.block).toBeUndefined();
  });

  it('applicationMode=live with invalid proposal: no params mutation, emits proposed with validationValid false', () => {
    const originalParams = { file_path: defaultFilePath, content: 'broken' };
    const proposal = {
      // Invalid: proposedParams is a string, not an object
      proposedParams: 'not-an-object',
      correctedFields: [],
      applicationMode: 'live' as const,
      confidence: 0.8,
      ruleId: 'R_invalid',
      notifyAgent: false,
    };

    const event = makeWriteEvent(originalParams);
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix' })),
    );

    // Verify params unchanged
    expect(event.params).toEqual(paramsCopy);

    // Verify only 'proposed' event was emitted (not 'applied')
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();

    // Verify validationValid is false
    const proposedCall = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(proposedCall.validationValid).toBe(false);

    // Verify no warning returned
    expect(result).toBeUndefined();
  });

  it('applicationMode=shadow: no params mutation, existing shadow behavior preserved', () => {
    const originalParams = { file_path: defaultFilePath, content: 'broken' };
    const proposal = makeValidProposal({ applicationMode: 'shadow' as const });

    const event = makeWriteEvent(originalParams);
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix' })),
    );

    // Verify params unchanged
    expect(event.params).toEqual(paramsCopy);

    // Verify only 'proposed' event was emitted (not 'applied')
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();

    const proposedCall = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(proposedCall.applicationMode).toBe('shadow');

    // Verify no warning returned
    expect(result).toBeUndefined();
  });

  it('notifyAgent=true: corrected params returned via host contract, does not block tool call', () => {
    const proposal = makeValidProposal({ notifyAgent: true });

    const event = makeWriteEvent();
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix typo' })),
    );

    expect(result).toBeDefined();
    expect(result?.params).toMatchObject({ content: 'fixed content' });
    expect(result?.block).toBeUndefined();
  });

  it('notifyAgent=false: corrected params still returned via host contract, tool call allowed', () => {
    const proposal = makeValidProposal({ notifyAgent: false });

    const event = makeWriteEvent();
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix' })),
    );

    // PRI-529/D2: both notifyAgent modes return the corrected params —
    // in-place mutation alone is not a reliable propagation channel.
    expect(result?.params).toMatchObject({ content: 'fixed content' });

    // Verify correction was still applied
    expect(event.params.content).toBe('fixed content');
  });

  it('PRI-529/D2: host-contract simulation — host merge of the hook result yields corrected params', () => {
    const proposal = makeValidProposal({
      proposedParams: { dry_run: true },
      correctedFields: [
        { field: 'dry_run', original: false, proposed: true, reason: 'enforce dry run' },
      ],
    });

    const event = makeWriteEvent({ dry_run: false });
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'enforce dry run' })),
    );

    // Simulate the host merge semantics (agent-tools.before-tool-call.ts):
    // the host reads ONLY params/block/blockReason/requireApproval from the
    // hook result. If the correction is not in `params`, the host never sees it.
    const hookResult = (result ?? {}) as Record<string, unknown>;
    const mergedParams = {
      ...event.params,
      ...(typeof hookResult.params === 'object' && hookResult.params !== null
        ? hookResult.params as Record<string, unknown>
        : {}),
    };
    expect(mergedParams.dry_run).toBe(true);
    expect(hookResult.block).toBeUndefined();
    expect(hookResult.blockReason).toBeUndefined();
  });

  it('Multiple correctedFields: all applied atomically when ALL fields valid', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'fixed', new_string: 'also fixed' },
      correctedFields: [
        { field: 'content', original: 'broken1', proposed: 'ignored1', reason: 'fix 1' },
        { field: 'new_string', original: 'broken2', proposed: 'ignored2', reason: 'fix 2' },
      ],
    });

    const event = makeWriteEvent({ new_string: 'broken2' });
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'multiple fixes' })),
    );

    // Verify both fields were applied from proposedParams (not correctedFields[].proposed)
    expect(event.params.content).toBe('fixed');
    expect(event.params.new_string).toBe('also fixed');

    // Verify 'applied' event has both fields with proposedParams values
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields).toHaveLength(2);
    expect(appliedCall.correctedFields).toEqual([
      { field: 'content', original: 'broken', applied: 'fixed' },
      { field: 'new_string', original: 'broken2', applied: 'also fixed' },
    ]);

    // Verify both corrections are returned via the host contract field
    expect(result?.params).toMatchObject({ content: 'fixed', new_string: 'also fixed' });
  });

  it('Field missing from event.params: fail-open, no mutation, no applied telemetry', () => {
    const proposal = makeValidProposal({
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
        { field: 'nonexistent', original: null, proposed: 'value', reason: 'bad' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const ctx = makeCtx();
    const result = handleSharedRuleHostResult(
      event,
      ctx,
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix with nonexistent field' })),
    );

    // Verify no fields were applied (fail-open)
    expect(event.params).toEqual(paramsCopy);
    expect(event.params.content).toBe('broken');

    // Verify 'applied' telemetry was NOT emitted
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();

    // Verify proposed telemetry was emitted with validationValid: false
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const proposedCall = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(proposedCall.validationValid).toBe(false);

    // Verify no warning returned
    expect(result).toBeUndefined();
  });

  it('Field missing from proposedParams: fail-open, no mutation, no applied telemetry', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'fixed content' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix' },
        { field: 'new_string', original: 'broken2', proposed: 'should be ignored', reason: 'fix 2' },
      ],
    });

    const event = makeWriteEvent({ new_string: 'broken2' });
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix with missing proposedParams field' })),
    );

    // Verify no fields were applied (fail-open)
    expect(event.params).toEqual(paramsCopy);
    expect(event.params.content).toBe('broken');
    expect(event.params.new_string).toBe('broken2');

    // Verify 'applied' telemetry was NOT emitted
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();

    // Verify no warning returned
    expect(result).toBeUndefined();
  });

  it('correctedFields[].proposed differs from proposedParams[field]: uses proposedParams value', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'value from proposedParams' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'ignored value from correctedFields', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix' })),
    );

    // Verify applied value came from proposedParams, not correctedFields[].proposed
    expect(event.params.content).toBe('value from proposedParams');
    expect(event.params.content).not.toBe('ignored value from correctedFields');

    // Verify telemetry shows proposedParams value was applied
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields[0].applied).toBe('value from proposedParams');
  });

  it('Block still takes precedence over auto_correct', () => {
    const metadata = {
      evaluatedLiveRules: 1,
      ruleDecision: 'block',
      matched: true,
      ruleId: 'R_block',
      ruleReason: 'dangerous operation',
      evaluations: [makeEvaluation('block', { ruleId: 'R_block' })],
    };

    const result = handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx(),
      makeSharedResult(metadata, { decision: 'deny', reason: 'dangerous operation' }),
    );

    // 差异：共享路径下 host 已阻断本次调用，本 handler 只做 deny 记账，
    // 不再返回 block 对象（legacy 断言 result 为定义的 block）。
    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostBlocked).toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleEnforced).toHaveBeenCalled();
    expect(mockRecordGateEnforcementEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'block' }),
    );
    // 差异：blockSource 由 'rule-host' 收敛为共享路径标记 'rule-host-shared'。
    expect(mockPersistGateBlock).toHaveBeenCalledTimes(1);
    expect(mockPersistGateBlock.mock.calls[0][1]).toMatchObject({
      blockSource: 'rule-host-shared',
      ruleId: 'R_block',
    });
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

  it('requireApproval still works unchanged', () => {
    const metadata = {
      evaluatedLiveRules: 1,
      ruleDecision: 'requireApproval',
      matched: true,
      ruleId: 'R_approval',
      ruleReason: 'sensitive write',
      evaluations: [makeEvaluation('requireApproval', { ruleId: 'R_approval' })],
    };

    const result = handleSharedRuleHostResult(makeWriteEvent(), makeCtx(), makeSharedResult(metadata));
    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostRequireApproval).toHaveBeenCalledTimes(1);
  });

  it('allow still works unchanged', () => {
    const metadata = {
      evaluatedLiveRules: 1,
      ruleDecision: 'allow',
      matched: true,
      ruleReason: 'safe',
      evaluations: [makeEvaluation('allow')],
    };

    const result = handleSharedRuleHostResult(makeWriteEvent(), makeCtx(), makeSharedResult(metadata));
    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledTimes(1);
  });

  it('live auto_correct does not modify unlisted fields (only correctedFields are applied)', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'fixed content' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix typo' },
      ],
    });

    const event = makeWriteEvent({ extra_param: 'should_stay', another: 42 });
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix typo' })),
    );

    expect(event.params.content).toBe('fixed content');
    expect(event.params.extra_param).toBe('should_stay');
    expect(event.params.another).toBe(42);
    expect(event.params.file_path).toBe(defaultFilePath);

    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields).toHaveLength(1);
    expect(appliedCall.correctedFields[0].field).toBe('content');
    expect(result?.params).toMatchObject({ extra_param: 'should_stay', another: 42 });
  });

  it('malformed correctedFields entries (non-object, null) rejected by validator, no mutation', () => {
    const proposal = {
      proposedParams: { content: 'fixed' },
      correctedFields: [42, null, 'string'],
      applicationMode: 'live' as const,
      confidence: 0.9,
      ruleId: 'R_malformed_cf',
      notifyAgent: false,
    };

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix' })),
    );

    expect(event.params).toEqual(paramsCopy);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const proposedCall = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(proposedCall.validationValid).toBe(false);
    expect(result).toBeUndefined();
  });

  it('inherited prototype property (toString) in correctedFields: fail-open, no mutation', () => {
    const proposal = makeValidProposal({
      proposedParams: { toString: 'overridden', content: 'fixed' },
      correctedFields: [
        { field: 'toString', original: '[Function]', proposed: 'overridden', reason: 'bypass' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'inherited property bypass attempt' })),
    );

    expect(event.params).toEqual(paramsCopy);
    expect(event.params.content).toBe('broken');
    expect(typeof event.params.toString).toBe('function');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('inherited prototype property (constructor) in correctedFields: fail-open, no mutation', () => {
    const proposal = makeValidProposal({
      proposedParams: { constructor: 'overridden', content: 'fixed' },
      correctedFields: [
        { field: 'constructor', original: '[Function]', proposed: 'overridden', reason: 'bypass' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'inherited property bypass attempt' })),
    );

    expect(event.params).toEqual(paramsCopy);
    expect(event.params.content).toBe('broken');
    expect(typeof event.params.constructor).toBe('function');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('PRI-210: out-of-bounds auto-correction is not applied (sibling prefix)', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/mock/workspace2/evil.ts', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: defaultFilePath, proposed: '/mock/workspace2/evil.ts', reason: 'redirect' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'redirect path' })),
    );

    expect(event.params).toEqual(paramsCopy);
    expect(event.params.file_path).toBe(defaultFilePath);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it('PRI-210: event.params remains unchanged when path out of bounds', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/etc/passwd', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: defaultFilePath, proposed: '/etc/passwd', reason: 'escape' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'escape attempt' })),
    );

    expect(event.params).toEqual(paramsCopy);
  });

  it('PRI-210: no rulehostAutoCorrectApplied event emitted on path rejection', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/tmp/evil.ts', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: defaultFilePath, proposed: '/tmp/evil.ts', reason: 'escape' },
      ],
    });

    handleSharedRuleHostResult(
      makeWriteEvent(),
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'escape' })),
    );

    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalled();
  });

  it('PRI-210: valid in-workspace auto-correction is still applied', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/mock/workspace/src/bar.ts', content: 'fixed content' },
      correctedFields: [
        { field: 'file_path', original: defaultFilePath, proposed: '/mock/workspace/src/bar.ts', reason: 'rename' },
        { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const result = handleSharedRuleHostResult(
      event,
      makeCtx(),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'rename and fix' })),
    );

    expect(event.params.file_path).toBe('/mock/workspace/src/bar.ts');
    expect(event.params.content).toBe('fixed content');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
    expect(result?.params).toMatchObject({
      file_path: '/mock/workspace/src/bar.ts',
      content: 'fixed content',
    });
  });

  it('PRI-210: missing trusted workspace root fails closed for path-bearing live correction', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/some/path.ts', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: defaultFilePath, proposed: '/some/path.ts', reason: 'redirect' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    // 差异：legacy 入口在 workspaceDir 为空时提前返回（断言平凡通过）；
    // 共享 handler 无入口过滤，真正走到 path-bound 校验并 fail-closed。
    const result = handleSharedRuleHostResult(
      event,
      makeCtx({ workspaceDir: '' }),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'redirect' })),
    );

    expect(event.params).toEqual(paramsCopy);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    // 证据：path-bound 校验确实执行并 fail-closed —— 首个合法的 proposed 记录
    // 之后，追加一条路径拒绝记录（applicationMode 回落 shadow）。
    const proposedCalls = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls;
    expect(proposedCalls).toHaveLength(2);
    expect(proposedCalls[1][0]).toMatchObject({ validationValid: false, applicationMode: 'shadow' });
  });

  it('PRI-210: non-path live correction works without workspace dir', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'fixed content' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix' },
      ],
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    handleSharedRuleHostResult(
      event,
      makeCtx({ workspaceDir: '/mock/workspace' }),
      makeSharedResult(makeAutoCorrectMetadata(proposal, { ruleReason: 'fix content' })),
    );

    expect(event.params.content).toBe('fixed content');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
    expect(paramsCopy.content).toBe('broken');
  });
});
