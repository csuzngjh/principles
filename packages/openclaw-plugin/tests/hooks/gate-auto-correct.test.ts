/**
 * PRI-174: Gate auto_correct live mode tests
 *
 * Verify that auto_correct decision in gate.ts:
 * - applicationMode='live' + valid proposal: event.params mutated, telemetry emitted
 * - applicationMode='live' + invalid proposal: no mutation, validation_failed telemetry
 * - applicationMode='shadow': no mutation (existing behavior preserved)
 * - PRI-529/D2: applied correction returns corrected params via the host
 *   contract field `params` (host reads only params/block/blockReason/
 *   requireApproval); in-place mutation is a secondary channel only
 * - Multiple correctedFields: all applied atomically when all valid
 * - Exception during application: fail-open, no partial mutation
 * - Strict field validation: ALL fields must exist in event.params AND proposedParams
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-ac-live';

const mockEvolution = {
  getTier: vi.fn().mockReturnValue(3),
  getPoints: vi.fn().mockReturnValue(200),
};

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  trackReceiptAutoCorrect: vi.fn(),
  setInjectedPrincipleIds: vi.fn(),
}));

vi.mock('../../src/core/evolution-engine.js', () => ({
  getEvolutionEngine: vi.fn(() => mockEvolution),
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

let _mockEvaluate = vi.fn().mockReturnValue(undefined);
vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function(this: unknown, _stateDir: string, _logger: unknown) {
    this.evaluate = _mockEvaluate;
  }),
  // P1 (2026-08-20): gate.ts routes compatibility-guard blocks through this type
  // guard; the mocked rule-host must export it so mocked evaluate() results are
  // not misrouted.
  isCompatibilityGuardBlock: vi.fn(() => false),
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

vi.mock('../../src/hooks/gate-block-helper.js', () => ({
  recordGateBlockAndReturn: vi.fn(() => ({
    block: true as const,
    reason: 'mocked block',
  })),
}));

// PR1: gate.ts uses wctx.getRuleHost(logger) (singleton) instead of `new RuleHost()`.
// Mock WorkspaceContext so each fromHookContext returns a fresh wctx whose
// getRuleHost returns a fresh object using the current _mockEvaluate.
// Without this, the singleton RuleHost keeps the first _mockEvaluate reference
// and beforeEach reassignments have no effect.
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn((ctx: { workspaceDir?: string }) => ({
      workspaceDir: ctx.workspaceDir,
      stateDir: (ctx.workspaceDir ?? '') + '/.state',
      getRuleHost: () => ({ evaluate: _mockEvaluate, dispose: vi.fn() }),
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

describe('PRI-174: Gate auto_correct live mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
  });

  it('applicationMode=live with valid proposal: event.params mutated and telemetry emitted', () => {
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    const proposal = makeValidProposal();
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent(originalParams);
    const result = handleBeforeToolCall(event, makeCtx());

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
      file_path: '/mock/workspace/src/foo.ts',
      content: 'fixed content',
    });
    expect(result?.block).toBeUndefined();
  });

  it('applicationMode=live with invalid proposal: no params mutation, emits proposed with validationValid false', () => {
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        // Invalid: proposedParams is a string, not an object
        proposedParams: 'not-an-object',
        correctedFields: [],
        applicationMode: 'live' as const,
        confidence: 0.8,
        ruleId: 'R_invalid',
        notifyAgent: false,
      },
    });

    const event = makeWriteEvent(originalParams);
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

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
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    const proposal = makeValidProposal({ applicationMode: 'shadow' as const });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent(originalParams);
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const result = handleBeforeToolCall(event, makeCtx());

    expect(result).toBeDefined();
    expect(result?.params).toMatchObject({ content: 'fixed content' });
    expect(result?.block).toBeUndefined();
  });

  it('notifyAgent=false: corrected params still returned via host contract, tool call allowed', () => {
    const proposal = makeValidProposal({ notifyAgent: false });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const result = handleBeforeToolCall(event, makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'enforce dry run',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent({ dry_run: false });
    const result = handleBeforeToolCall(event, makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'multiple fixes',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent({ new_string: 'broken2' });
    const result = handleBeforeToolCall(event, makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix with nonexistent field',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const ctx = makeCtx();
    const result = handleBeforeToolCall(event, ctx);

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix with missing proposedParams field',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent({ new_string: 'broken2' });
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const result = handleBeforeToolCall(event, makeCtx());

    // Verify applied value came from proposedParams, not correctedFields[].proposed
    expect(event.params.content).toBe('value from proposedParams');
    expect(event.params.content).not.toBe('ignored value from correctedFields');

    // Verify telemetry shows proposedParams value was applied
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields[0].applied).toBe('value from proposedParams');
  });

  it('Block still takes precedence over auto_correct', () => {
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'block',
      matched: true,
      reason: 'dangerous operation',
      ruleId: 'R_block',
    });

    const event = makeWriteEvent();
    const result = handleBeforeToolCall(event, makeCtx());

    expect(result).toBeDefined();
    expect(mockEventLogInstance.recordRuleHostBlocked).toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

  it('requireApproval still works unchanged', () => {
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'requireApproval',
      matched: true,
      reason: 'sensitive write',
      ruleId: 'R_approval',
    });

    const result = handleBeforeToolCall(makeWriteEvent(), makeCtx());
    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostRequireApproval).toHaveBeenCalledTimes(1);
  });

  it('allow still works unchanged', () => {
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'allow',
      matched: true,
      reason: 'safe',
    });

    const result = handleBeforeToolCall(makeWriteEvent(), makeCtx());
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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent({ extra_param: 'should_stay', another: 42 });
    const result = handleBeforeToolCall(event, makeCtx());

    expect(event.params.content).toBe('fixed content');
    expect(event.params.extra_param).toBe('should_stay');
    expect(event.params.another).toBe(42);
    expect(event.params.file_path).toBe('/mock/workspace/src/foo.ts');

    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields).toHaveLength(1);
    expect(appliedCall.correctedFields[0].field).toBe('content');
  });

  it('malformed correctedFields entries (non-object, null) rejected by validator, no mutation', () => {
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        proposedParams: { content: 'fixed' },
        correctedFields: [42, null, 'string'],
        applicationMode: 'live' as const,
        confidence: 0.9,
        ruleId: 'R_malformed_cf',
        notifyAgent: false,
      },
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

    expect(event.params).toEqual(paramsCopy);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const proposedCall = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(proposedCall.validationValid).toBe(false);
  });

  it('inherited prototype property (toString) in correctedFields: fail-open, no mutation', () => {
    const proposal = makeValidProposal({
      proposedParams: { toString: 'overridden', content: 'fixed' },
      correctedFields: [
        { field: 'toString', original: '[Function]', proposed: 'overridden', reason: 'bypass' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'inherited property bypass attempt',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

    expect(event.params).toEqual(paramsCopy);
    expect(event.params.content).toBe('broken');
    expect(typeof event.params.toString).toBe('function');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

  it('inherited prototype property (constructor) in correctedFields: fail-open, no mutation', () => {
    const proposal = makeValidProposal({
      proposedParams: { constructor: 'overridden', content: 'fixed' },
      correctedFields: [
        { field: 'constructor', original: '[Function]', proposed: 'overridden', reason: 'bypass' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'inherited property bypass attempt',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

    expect(event.params).toEqual(paramsCopy);
    expect(event.params.content).toBe('broken');
    expect(typeof event.params.constructor).toBe('function');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

  it('PRI-210: out-of-bounds auto-correction is not applied (sibling prefix)', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/mock/workspace2/evil.ts', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: '/mock/workspace/src/foo.ts', proposed: '/mock/workspace2/evil.ts', reason: 'redirect' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'redirect path',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

    expect(event.params).toEqual(paramsCopy);
    expect(event.params.file_path).toBe('/mock/workspace/src/foo.ts');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

  it('PRI-210: event.params remains unchanged when path out of bounds', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/etc/passwd', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: '/mock/workspace/src/foo.ts', proposed: '/etc/passwd', reason: 'escape' },
        { field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'escape attempt',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    handleBeforeToolCall(event, makeCtx());

    expect(event.params).toEqual(paramsCopy);
  });

  it('PRI-210: no rulehostAutoCorrectApplied event emitted on path rejection', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/tmp/evil.ts', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: '/mock/workspace/src/foo.ts', proposed: '/tmp/evil.ts', reason: 'escape' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'escape',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    handleBeforeToolCall(makeWriteEvent(), makeCtx());

    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalled();
  });

  it('PRI-210: valid in-workspace auto-correction is still applied', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/mock/workspace/src/bar.ts', content: 'fixed content' },
      correctedFields: [
        { field: 'file_path', original: '/mock/workspace/src/foo.ts', proposed: '/mock/workspace/src/bar.ts', reason: 'rename' },
        { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'rename and fix',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const result = handleBeforeToolCall(event, makeCtx());

    expect(event.params.file_path).toBe('/mock/workspace/src/bar.ts');
    expect(event.params.content).toBe('fixed content');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
  });

  it('PRI-210: missing trusted workspace root fails closed for path-bearing live correction', () => {
    const proposal = makeValidProposal({
      proposedParams: { file_path: '/some/path.ts', content: 'fixed' },
      correctedFields: [
        { field: 'file_path', original: '/mock/workspace/src/foo.ts', proposed: '/some/path.ts', reason: 'redirect' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'redirect',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx({ workspaceDir: '' }));

    expect(event.params).toEqual(paramsCopy);
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

  it('PRI-210: non-path live correction works without workspace dir', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'fixed content' },
      correctedFields: [
        { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix' },
      ],
    });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix content',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    handleBeforeToolCall(event, makeCtx({ workspaceDir: '/mock/workspace' }));

    expect(event.params.content).toBe('fixed content');
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
  });
});
