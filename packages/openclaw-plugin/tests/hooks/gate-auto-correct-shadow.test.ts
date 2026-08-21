/**
 * PRI-114: Gate auto_correct shadow mode tests
 *
 * Verify that auto_correct decision in gate.ts:
 * - Never modifies event.params (shadow enforced)
 * - Emits rulehost_auto_correct_proposed telemetry
 * - Invalid proposals still emit telemetry (validationValid: false)
 * - Existing allow/block/requireApproval unchanged
 * - Config gate defaults to shadow even when live configured
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-ac-shadow';

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
  RuleHost: vi.fn(function(this: any, _stateDir: string, _logger: any) {
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

describe('PRI-114: Gate auto_correct shadow mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
  });

  it('auto_correct does NOT modify event.params', () => {
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo in content',
      ruleId: 'R_ac_001',
      correctionProposal: makeValidProposal(),
    });

    const event = makeWriteEvent(originalParams);
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx());

    // Shadow mode: returns undefined (allow), params unchanged
    expect(result).toBeUndefined();
    expect(event.params).toEqual(paramsCopy);
  });

  it('auto_correct with applicationMode live now modifies params (PRI-174 implemented)', () => {
    const originalParams = { file_path: '/mock/workspace/src/foo.ts', content: 'broken' };
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo',
      ruleId: 'R_ac_test',
      correctionProposal: makeValidProposal({ applicationMode: 'live' }),
    });

    const event = makeWriteEvent(originalParams);
    const result = handleBeforeToolCall(event, makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix typo in content',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    handleBeforeToolCall(makeWriteEvent(), makeCtx());

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
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: {
        // Invalid: proposedParams is a string, missing fields
        proposedParams: 'not-an-object',
      },
    });

    handleBeforeToolCall(makeWriteEvent(), makeCtx());

    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const call = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(call.validationValid).toBe(false);
  });

  it('block still takes precedence over auto_correct', () => {
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

  it('missing pluginConfig defaults to shadow (no crash)', () => {
    const proposal = makeValidProposal();
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const paramsCopy = { ...event.params };
    const result = handleBeforeToolCall(event, makeCtx({ pluginConfig: undefined }));

    expect(result).toBeUndefined();
    expect(event.params).toEqual(paramsCopy);
  });

  it('pluginConfig.autoCorrectLive true now applies live corrections (PRI-174 implemented)', () => {
    const proposal = makeValidProposal({ applicationMode: 'live' });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      correctionProposal: proposal,
    });

    const event = makeWriteEvent();
    const result = handleBeforeToolCall(event, makeCtx({
      pluginConfig: { autoCorrectLive: true },
    }));

    // PRI-174: Live mode applies corrections; PRI-529/D2: host contract field
    expect(event.params.content).toBe('fixed content');
    expect(result).toBeDefined();
    expect(result?.params).toMatchObject({ content: 'fixed content' });

    // Verify applied telemetry was emitted
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).toHaveBeenCalledTimes(1);
  });


  // PRI-114 review: auto_correct without correctionProposal still emits telemetry
  it('auto_correct without correctionProposal emits telemetry with validationValid false', () => {
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix but no proposal',
      ruleId: 'R_no_prop',
    });

    const result = handleBeforeToolCall(makeWriteEvent(), makeCtx());

    expect(result).toBeUndefined();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).toHaveBeenCalledTimes(1);
    const call = mockEventLogInstance.recordRuleHostAutoCorrectProposed.mock.calls[0][0];
    expect(call.validationValid).toBe(false);
    expect(call.reason).toContain('no proposal');
  });

  it('non-write/bash/agent tool does not trigger auto_correct evaluation', () => {
    const proposal = makeValidProposal({ applicationMode: 'live' });
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'auto_correct',
      matched: true,
      reason: 'fix',
      ruleId: proposal.ruleId,
      correctionProposal: proposal,
    });

    const event = {
      toolName: 'read',
      params: { file_path: '/mock/workspace/src/foo.ts', content: 'broken' },
    };
    const result = handleBeforeToolCall(event, makeCtx());

    expect(result).toBeUndefined();
    expect(_mockEvaluate).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectProposed).not.toHaveBeenCalled();
    expect(mockEventLogInstance.recordRuleHostAutoCorrectApplied).not.toHaveBeenCalled();
  });

});
