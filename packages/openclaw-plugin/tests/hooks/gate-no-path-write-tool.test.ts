/**
 * Regression test: write tools without file_path must still go through RuleHost.
 *
 * PRI-286 P1: After removing confirm-first gate, write tools (apply_patch, patch, etc.)
 * that have no file_path/path/file/target param must NOT be silently allowed.
 * They must use a synthetic path `<tool:${toolName}>` and still evaluate via RuleHost.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-no-path';

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

describe('Write tools without file_path must go through RuleHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
  });

  it('apply_patch with no path triggers RuleHost evaluate', () => {
    _mockEvaluate = vi.fn().mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'apply_patch', params: { patch: 'some diff content' } } as any,
      { workspaceDir, sessionId } as any,
    );

    // Should not be blocked (RuleHost returned undefined = allow)
    expect(result).toBeUndefined();
    // But RuleHost MUST have been called
    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    // Verify synthetic path was used
    const input = _mockEvaluate.mock.calls[0][0];
    expect(input.action.normalizedPath).toBe('<tool:apply_patch>');
  });

  it('apply_patch with no path: RuleHost block must return block', () => {
    _mockEvaluate = vi.fn().mockReturnValue({
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
    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    expect(_mockEvaluate.mock.calls[0][0].action.normalizedPath).toBe('<tool:apply_patch>');
  });

  it('patch tool with no path triggers RuleHost evaluate', () => {
    _mockEvaluate = vi.fn().mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'patch', params: {} } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeUndefined();
    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    expect(_mockEvaluate.mock.calls[0][0].action.normalizedPath).toBe('<tool:patch>');
  });

  it('Write tool with valid file_path still uses real path', () => {
    _mockEvaluate = vi.fn().mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'write', params: { file_path: '/mock/workspace/src/app.ts', content: 'x' } } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeUndefined();
    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    expect(_mockEvaluate.mock.calls[0][0].action.normalizedPath).toBe('src/app.ts');
  });

  it('bash with no file target still goes through RuleHost (existing behavior)', () => {
    _mockEvaluate = vi.fn().mockReturnValue(undefined); // allow

    const result = handleBeforeToolCall(
      { toolName: 'bash', params: { command: 'echo hello' } } as any,
      { workspaceDir, sessionId } as any,
    );

    expect(result).toBeUndefined();
    expect(_mockEvaluate).toHaveBeenCalledTimes(1);
    // Bash without file target uses the full command as path (existing heuristic)
    const input = _mockEvaluate.mock.calls[0][0];
    expect(input.action.normalizedPath).toContain('echo hello');
  });
});
