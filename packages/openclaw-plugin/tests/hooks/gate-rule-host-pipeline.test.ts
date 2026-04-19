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

describe('Gate Rule Host Only Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
  });

  describe('Rule Host blocks', () => {
    it('should block with blockSource=rule-host when Rule Host returns block', () => {
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
          decision: 'allow',
        })
      );
    });
  });

  describe('Rule Host degradation', () => {
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
