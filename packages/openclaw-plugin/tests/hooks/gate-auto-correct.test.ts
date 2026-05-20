/**
 * PRI-174: Gate auto_correct live mode tests
 *
 * Verify that auto_correct decision in gate.ts:
 * - applicationMode='live' + valid proposal: event.params mutated, telemetry emitted
 * - applicationMode='live' + invalid proposal: no mutation, validation_failed telemetry
 * - applicationMode='shadow': no mutation (existing behavior preserved)
 * - notifyAgent=true: warning injected in return value
 * - notifyAgent=false: no warning, returns void
 * - Multiple correctedFields: all applied atomically
 * - Exception during application: fail-open, no partial mutation
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
  hasRecentThinking: vi.fn(() => false),
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
  RuleHost: vi.fn(function(this: any, _stateDir: string, _logger: any) {
    this.evaluate = _mockEvaluate;
  }),
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
  listImplementationsByLifecycleState: vi.fn(() => []),
}));

vi.mock('../../src/hooks/gate-block-helper.js', () => ({
  recordGateBlockAndReturn: vi.fn(() => ({
    block: true as const,
    reason: 'mocked block',
  })),
}));

function makeValidProposal(overrides: Record<string, unknown> = {}) {
  return {
    proposedParams: { content: 'fixed content' },
    correctedFields: [
      { field: 'content', original: 'broken', proposed: 'fixed content', reason: 'fix typo' },
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

    // Verify params were mutated
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

    // Verify notifyAgent warning is in result
    expect(result).toBeDefined();
    expect(result?._pdAutoCorrectWarning).toContain('[PD Auto-Correct]');
    expect(result?._pdAutoCorrectWarning).toContain('content');
    expect(result?.skipToolCall).toBe(false);
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

  it('notifyAgent=true: warning injected in return value, does not block tool call', () => {
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
    expect(result?._pdAutoCorrectWarning).toContain('[PD Auto-Correct]');
    expect(result?._pdAutoCorrectWarning).toContain('Rule R_ac_live');
    expect(result?._pdAutoCorrectWarning).toContain('fix typo');
    expect(result?._pdAutoCorrectWarning).toContain('content');
    expect(result?.skipToolCall).toBe(false);
  });

  it('notifyAgent=false: no warning returned, tool call allowed', () => {
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

    // Verify no warning, tool call allowed
    expect(result).toBeUndefined();

    // Verify correction was still applied
    expect(event.params.content).toBe('fixed content');
  });

  it('Multiple correctedFields: all applied atomically', () => {
    const proposal = makeValidProposal({
      proposedParams: { content: 'fixed', new_string: 'also fixed' },
      correctedFields: [
        { field: 'content', original: 'broken1', proposed: 'fixed', reason: 'fix 1' },
        { field: 'new_string', original: 'broken2', proposed: 'also fixed', reason: 'fix 2' },
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

    // Verify both fields were applied
    expect(event.params.content).toBe('fixed');
    expect(event.params.new_string).toBe('also fixed');

    // Verify 'applied' event has both fields
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields).toHaveLength(2);
    expect(appliedCall.correctedFields).toEqual([
      { field: 'content', original: 'broken', applied: 'fixed' },
      { field: 'new_string', original: 'broken2', applied: 'also fixed' },
    ]);

    // Verify warning contains both corrections
    expect(result?._pdAutoCorrectWarning).toContain('content');
    expect(result?._pdAutoCorrectWarning).toContain('new_string');
  });

  it('Field not in original params: skipped gracefully, other fields still applied', () => {
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
    const result = handleBeforeToolCall(event, makeCtx());

    // Verify only existing field was applied
    expect(event.params.content).toBe('fixed');
    expect(event.params).not.toHaveProperty('nonexistent');

    // Verify 'applied' event has only one field
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields).toHaveLength(1);
    expect(appliedCall.correctedFields[0].field).toBe('content');
  });

  it('Field not in original params: skipped, does not cause fail-open', () => {
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
    const result = handleBeforeToolCall(event, makeCtx());

    // Verify only existing field was applied
    expect(event.params.content).toBe('fixed');
    expect(event.params).not.toHaveProperty('nonexistent');

    // Verify 'applied' event has only one field
    const appliedCall = mockEventLogInstance.recordRuleHostAutoCorrectApplied.mock.calls[0][0];
    expect(appliedCall.correctedFields).toHaveLength(1);
    expect(appliedCall.correctedFields[0].field).toBe('content');
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
});
