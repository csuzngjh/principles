/**
 * Regression test: write tools without file_path must still go through RuleHost.
 *
 * PRI-286 P1: After removing confirm-first gate, write tools (apply_patch, patch, etc.)
 * that have no file_path/path/file/target param must NOT be silently allowed.
 * They must use a synthetic path `<tool:${toolName}>` and still evaluate via RuleHost.
 *
 * Uses vi.hoisted + mock of WorkspaceContext to avoid isolation issues in full suite.
 * WorkspaceContext is the key — in full suite, other test files initialize the real
 * context which caches a real EventLogService that doesn't have our mock methods.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures these are available to vi.mock factories at hoist time
const { mockEvaluate, mockEventLog, mockEvolution } = vi.hoisted(() => {
  const mockEvaluate = vi.fn().mockReturnValue(undefined);
  const mockEventLog = {
    recordRuleHostEvaluated: vi.fn(),
    recordRuleEnforced: vi.fn(),
    recordRuleHostBlocked: vi.fn(),
    recordRuleHostRequireApproval: vi.fn(),
    recordRuleHostAutoCorrectProposed: vi.fn(),
    recordRuleHostAutoCorrectApplied: vi.fn(),
    recordGateBlock: vi.fn(),
    recordSession: vi.fn(),
  };
  const mockEvolution = {
    getTier: vi.fn().mockReturnValue(3),
    getPoints: vi.fn().mockReturnValue(200),
  };
  return { mockEvaluate, mockEventLog, mockEvolution };
});

vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  hasRecentThinking: vi.fn(() => false),
}));

vi.mock('../../src/core/evolution-engine.js', () => ({
  getEvolutionEngine: vi.fn(() => mockEvolution),
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLog) },
}));

vi.mock('../../src/core/rule-host.js', () => ({
  RuleHost: vi.fn(function(this: any, _stateDir: string, _logger: any) {
    this.evaluate = mockEvaluate;
  }),
}));

vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
}));

// Mock WorkspaceContext to return a controlled instance with our mockEventLog.
// This prevents full-suite caching of real WorkspaceContext instances.
vi.mock('../../src/core/workspace-context.js', () => {
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn((ctx: any) => ({
        workspaceDir: ctx.workspaceDir,
        stateDir: ctx.workspaceDir + '/.state',
        eventLog: mockEventLog,
        trajectory: {
          recordGateBlock: vi.fn(),
          recordPainEvent: vi.fn(),
          recordSession: vi.fn(),
        },
        config: {
          get: vi.fn().mockReturnValue(undefined),
        },
        // PRI-454: real WorkspaceContext exposes resolve(fileKey) for PD file paths.
        // Gate B path (now default-on) calls wctx.resolve('PROFILE') to read PROFILE.json
        // for risk-path classification. Return a non-existent path so fs.existsSync fails
        // and the profile falls back to non-risky defaults — keeping this test focused on
        // the RuleHost block behavior without depending on Gate B internals.
        resolve: vi.fn((fileKey: string) => `${ctx.workspaceDir}/.pd/${fileKey}.json`),
      })),
    },
  };
});

// Dynamic import AFTER mocks are set up
const { handleBeforeToolCall } = await import('../../src/hooks/gate.js');

const workspaceDir = '/mock/workspace';
const sessionId = 'test-no-path';

describe('Write tools without file_path must go through RuleHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluate.mockReturnValue(undefined);
  });

  it('apply_patch with no path triggers RuleHost evaluate', () => {
    mockEvaluate.mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'apply_patch', params: { patch: 'some diff content' } } as any,
      { workspaceDir, sessionId } as any,
    );

    // Should not be blocked (RuleHost returned undefined = allow)
    expect(result).toBeUndefined();
    // But RuleHost MUST have been called
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    // Verify synthetic path was used
    const input = mockEvaluate.mock.calls[0][0];
    expect(input.action.normalizedPath).toBe('<tool:apply_patch>');
  });

  it('apply_patch with no path: RuleHost block must return block', () => {
    mockEvaluate.mockReturnValue({
      decision: 'block',
      matched: true,
      reason: 'Test block: write tool without path',
      ruleId: 'R_TEST',
      principleId: 'P_TEST',
    });

    const result = handleBeforeToolCall(
      { toolName: 'apply_patch', params: { patch: 'dangerous content' } } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('Test block: write tool without path');
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate.mock.calls[0][0].action.normalizedPath).toBe('<tool:apply_patch>');
  });

  it('patch tool with no path triggers RuleHost evaluate', () => {
    mockEvaluate.mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'patch', params: {} } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeUndefined();
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate.mock.calls[0][0].action.normalizedPath).toBe('<tool:patch>');
  });

  it('Write tool with valid file_path still uses real path', () => {
    mockEvaluate.mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'write', params: { file_path: '/mock/workspace/src/app.ts', content: 'x' } } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeUndefined();
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate.mock.calls[0][0].action.normalizedPath).toBe('src/app.ts');
  });

  it('bash with no file target still goes through RuleHost (existing behavior)', () => {
    mockEvaluate.mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'bash', params: { command: 'echo hello' } } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeUndefined();
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    // Bash without file target uses the full command as path (existing heuristic)
    const input = mockEvaluate.mock.calls[0][0];
    expect(input.action.normalizedPath).toContain('echo hello');
  });
});
