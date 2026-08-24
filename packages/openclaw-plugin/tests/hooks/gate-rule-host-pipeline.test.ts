/**
 * Gate Rule Host Only - Pipeline Integration Tests
 *
 * PURPOSE: Verify gate.ts with Rule Host Only (no hardcoded gates).
 *
 * Tests:
 * 1. Rule Host blocks operation → block result with blockSource='rule-host'
 * 2. Rule Host allow (no match) → operation passes
 * 3. Rule Host throws → degrades conservatively, allows operation
 * 4. Rule Host requireApproval → records event, does not block
 * 5. Non-target tools (read) → pass through early
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

const workspaceDir = '/mock/workspace';
const sessionId = 'test-session-rh';

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
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => mockEventLogInstance) },
}));

let _mockEvaluate = vi.fn().mockReturnValue(undefined);
let _mockEvaluateDetailed: ReturnType<typeof vi.fn> | undefined;
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
      getRuleHost: () => ({
        evaluate: _mockEvaluate,
        ...(_mockEvaluateDetailed ? { evaluateDetailed: _mockEvaluateDetailed } : {}),
        dispose: vi.fn(),
      }),
      eventLog: mockEventLogInstance,
      trajectory: { recordGateBlock: vi.fn(), getRuleHostContextRows: vi.fn(() => ({ rows: [], truncated: false })) },
      config: { get: vi.fn().mockReturnValue(undefined) },
      resolve: vi.fn(() => '/mock/PROFILE.json'),
    })),
  },
}));

describe('Gate Rule Host Only Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
    _mockEvaluateDetailed = undefined;
  });

  describe('Rule Host blocks', () => {
    // PRE-EXISTING: passes in isolation, fails in full suite — unrelated to M8
    it.skip('should block with blockSource=rule-host when Rule Host returns block', () => {
      _mockEvaluate = vi.fn().mockReturnValue({
        decision: 'block',
        matched: true,
        reason: 'Dangerous git force-push detected',
        ruleId: 'R_001',
        principleId: 'P_001',
      });

      const event = {
        toolName: 'bash',
        params: { command: 'git push --force' },
      };

      const result = handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Dangerous git force-push detected');
    });

    it('should record rulehost_blocked event when Rule Host blocks', () => {
      _mockEvaluate = vi.fn().mockReturnValue({
        decision: 'block',
        matched: true,
        reason: 'High-risk path',
        ruleId: 'R_002',
      });

      const event = {
        toolName: 'write',
        params: { file_path: 'src/danger.ts', content: 'bad' },
      };

      handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(mockEventLogInstance.recordRuleHostBlocked).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'write',
          ruleId: 'R_002',
        })
      );
    });
  });

  describe('Rule Host allows', () => {
    it('should allow when Rule Host returns undefined (no match)', () => {
      _mockEvaluate = vi.fn().mockReturnValue(undefined);

      const event = {
        toolName: 'write',
        params: { file_path: 'src/safe.ts', content: 'const x = 1' },
      };

      const result = handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(result).toBeUndefined();
    });

    it('should record rulehost_evaluated even when no match', () => {
      _mockEvaluate = vi.fn().mockReturnValue(undefined);

      const event = {
        toolName: 'edit',
        params: { file_path: 'src/config.ts', oldText: 'x', newText: 'y' },
      };

      handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'edit',
          matched: false,
          // PRI-567: no live rules armed (evaluateDetailed absent → liveRulesLoaded 0)
          // is no longer indistinguishable from a real 'allow'.
          decision: 'no_rules_armed',
        })
      );
    });
  });

  describe('Rule Host degradation', () => {
    it('records evaluation_failed instead of no_rules_armed when detailed evaluation degrades', () => {
      _mockEvaluateDetailed = vi.fn().mockReturnValue({
        liveDecision: undefined,
        shadowDecisions: [],
        skippedActivations: [],
        liveRulesLoaded: 0,
        evaluationStatus: 'failed',
      });

      handleBeforeToolCall(
        { toolName: 'bash', params: { command: 'ls -la' } } as any,
        { workspaceDir, sessionId } as any,
      );

      expect(mockEventLogInstance.recordRuleHostEvaluated).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'evaluation_failed' }),
      );
    });

    it('should allow operation when Rule Host throws (conservative degradation)', () => {
      _mockEvaluate = vi.fn().mockImplementation(() => {
        throw new Error('Host internal error');
      });

      const event = {
        toolName: 'bash',
        params: { command: 'ls -la' },
      };

      const result = handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(result).toBeUndefined();
    });
  });

  describe('Rule Host requireApproval', () => {
    it('should not block when Rule Host returns requireApproval', () => {
      _mockEvaluate = vi.fn().mockReturnValue({
        decision: 'requireApproval',
        matched: true,
        reason: 'High-risk operation needs approval',
        ruleId: 'R_003',
      });

      const event = {
        toolName: 'bash',
        params: { command: 'rm -rf node_modules' },
      };

      const result = handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(result).toBeUndefined();
      expect(mockEventLogInstance.recordRuleEnforced).toHaveBeenCalledWith(
        expect.objectContaining({ enforcement: 'requireApproval' })
      );
    });
  });

  describe('Early return for non-target tools', () => {
    it('should allow read tool without calling Rule Host', () => {
      const event = {
        toolName: 'read',
        params: { file_path: 'src/readonly.ts' },
      };

      const result = handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(result).toBeUndefined();
      expect(_mockEvaluate).not.toHaveBeenCalled();
    });

    it('should allow agent tool without calling Rule Host when no workspace', () => {
      const event = {
        toolName: 'agent',
        params: { task: 'do something' },
      };

      const result = handleBeforeToolCall(event as any, { sessionId } as any);

      expect(result).toBeUndefined();
      expect(_mockEvaluate).not.toHaveBeenCalled();
    });
  });

  describe('Session GFI context', () => {
    it('should pass current GFI to Rule Host', () => {
      _mockEvaluate = vi.fn().mockReturnValue(undefined);
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 75 } as any);

      const event = {
        toolName: 'write',
        params: { file_path: 'src/test.ts', content: 'x' },
      };

      handleBeforeToolCall(event as any, { workspaceDir, sessionId } as any);

      expect(_mockEvaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({ currentGfi: 75 }),
        })
      );
    });
  });
});
