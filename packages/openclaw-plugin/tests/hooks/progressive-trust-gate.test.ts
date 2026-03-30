/**
 * Tests for Progressive Trust Gate Module (EP-Only Version)
 *
 * 2026-03-29: EP System 是唯一的门控机制
 * - 不再有 Trust Score (30-100) 系统
 * - 不再有 Stage 1-4 分级
 * - 不再有基于行数的限制
 * - EP (Evolution Points) 是唯一的门控机制
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginHookBeforeToolCallEvent } from '../../src/openclaw-sdk.js';
import {
  checkProgressiveTrustGate,
  buildEvolutionGateReason,
} from '../../src/hooks/progressive-trust-gate.js';
import { checkEvolutionGate } from '../../src/core/evolution-engine.js';

// Mock dependencies
vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => mockWctx)
  }
}));

vi.mock('../../src/utils/io.js', () => ({
  planStatus: vi.fn(() => 'READY'),
  normalizePath: vi.fn((p) => p),
  isRisky: vi.fn(() => false)
}));

vi.mock('../../src/utils/glob-match.js', () => ({
  matchesAnyPattern: vi.fn(() => false)
}));

vi.mock('../../src/core/risk-calculator.js', () => ({
  assessRiskLevel: vi.fn(() => 'LOW'),
  estimateLineChanges: vi.fn(() => 10)
}));

vi.mock('../../src/core/evolution-engine.js', () => ({
  checkEvolutionGate: vi.fn(() => ({ allowed: true, currentTier: 1 }))
}));

vi.mock('../../src/hooks/gate-block-helper.js', () => ({
  recordGateBlockAndReturn: vi.fn((wctx, params) => ({
    block: true,
    blockReason: params.reason || 'Blocked'
  }))
}));

// Mock workspace context - simplified for EP-only
const mockWctx = {
  config: {
    get: vi.fn(() => ({}))
  },
  eventLog: {
    recordGateBlock: vi.fn(),
    recordPlanApproval: vi.fn()
  },
  trajectory: {
    recordGateBlock: vi.fn()
  },
  resolve: vi.fn((key) => key)
};

describe('progressive-trust-gate (EP-Only)', () => {
  describe('checkProgressiveTrustGate - EP System', () => {
    let mockEvent: PluginHookBeforeToolCallEvent;
    let mockLogger: any;

    beforeEach(() => {
      mockEvent = {
        toolName: 'edit',
        params: {
          file_path: '/test/file.ts',
          content: 'test content\n'.repeat(10)
        }
      } as any;

      mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      };

      // Reset EP mock
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 1 });

      vi.clearAllMocks();
    });

    it('should allow when EP system allows', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 1 });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        100, // Even large changes are allowed by EP
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session' },
        {}
      );

      // EP allows, so result should be undefined (allow)
      expect(result).toBeUndefined();
    });

    it('should block when EP system denies', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({
        allowed: false,
        currentTier: 1,
        reason: 'EP Tier 1 limit: 150 lines max'
      });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        200,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session' },
        {}
      );

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('EP');
    });

    it('should log EP decision info', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 2 });

      checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        10,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session' },
        {}
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('EP Gate:')
      );
    });

    it('should allow risky path when EP allows', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({
        allowed: true,
        currentTier: 4, // Tree tier - can access risk paths
        reason: 'Tier 4 unlocked'
      });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/risk-path',
        true, // risky
        500,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session' },
        {}
      );

      expect(result).toBeUndefined();
    });

    it('should block risky path when EP denies', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({
        allowed: false,
        currentTier: 2, // Sprout tier - cannot access risk paths
        reason: 'Risk paths require Tree tier'
      });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/risk-path',
        true, // risky
        10,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session' },
        {}
      );

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });

    it('should skip check when no workspaceDir', () => {
      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        10,
        mockLogger,
        { sessionId: 'test-session' }, // No workspaceDir
        {}
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No workspaceDir')
      );
    });

    it('should pass correct parameters to checkEvolutionGate', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 1 });

      checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        true, // isRiskPath
        100,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session' },
        {}
      );

      expect(checkEvolutionGate).toHaveBeenCalledWith('/test', {
        toolName: 'edit',
        isRiskPath: true,
      });
    });
  });

  describe('buildEvolutionGateReason', () => {
    it('should build EP gate rejection reason with tier info', () => {
      const reason = buildEvolutionGateReason(2, 'Sprout', 'Max 50 lines');

      expect(reason).toContain('EP Gate');
      expect(reason).toContain('Tier 2');
      expect(reason).toContain('Sprout');
      expect(reason).toContain('Max 50 lines');
    });

    it('should handle unknown tier name', () => {
      const reason = buildEvolutionGateReason(99, 'Unknown', 'Some restriction');

      expect(reason).toContain('EP Gate');
      expect(reason).toContain('Tier 99');
      expect(reason).toContain('Unknown');
    });
  });

  describe('EP Tier Names', () => {
    it('should pass correct tier info to checkEvolutionGate', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 1 });
      const event = { toolName: 'edit', params: { file_path: '/test.ts', content: '' } } as any;
      const logger = { info: vi.fn() };

      checkProgressiveTrustGate(
        event,
        mockWctx as any,
        '/test.ts',
        false,
        10,
        logger,
        { workspaceDir: '/test' },
        {}
      );

      expect(checkEvolutionGate).toHaveBeenCalledWith('/test', {
        toolName: 'edit',
        isRiskPath: false,
      });
    });
  });
});
