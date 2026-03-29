/**
 * Tests for Progressive Trust Gate Module (EP-Only Version)
 *
 * EP (Evolution Points) 是唯一的门控机制。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginHookBeforeToolCallEvent } from '../../src/openclaw-sdk.js';
import { checkProgressiveTrustGate } from '../../src/hooks/progressive-trust-gate.js';
import { checkEvolutionGate } from '../../src/core/evolution-engine.js';

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => mockWctx)
  }
}));

vi.mock('../../src/core/evolution-engine.js', () => ({
  checkEvolutionGate: vi.fn()
}));

import * as fs from 'fs';
import * as path from 'path';

const mockWctx = {
  config: {
    get: vi.fn(() => ({}))
  },
  eventLog: {
    recordGateBlock: vi.fn()
  },
  trajectory: {
    recordGateBlock: vi.fn()
  },
  resolve: vi.fn((key) => key)
};

describe('progressive-trust-gate', () => {
  describe('checkProgressiveTrustGate', () => {
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

      vi.clearAllMocks();
    });

    it('should allow when EP gate permits', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 1 });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        10,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session', pluginConfig: {} }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('EP Gate')
      );
    });

    it('should block when EP gate denies', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: false, currentTier: 1, reason: 'Insufficient EP' });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        10,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session', pluginConfig: {} }
      );

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('EP Gate');
      expect(result?.blockReason).toContain('Insufficient EP');
    });

    it('should handle risk path decisions via EP gate', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: true, currentTier: 4 });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/risk-path',
        true,
        10,
        mockLogger,
        { workspaceDir: '/test', sessionId: 'test-session', pluginConfig: {} }
      );

      expect(result).toBeUndefined();
      expect(checkEvolutionGate).toHaveBeenCalledWith('/test', {
        toolName: 'edit',
        isRiskPath: true
      });
    });

    it('should skip gate when workspaceDir is missing', () => {
      vi.mocked(checkEvolutionGate).mockReturnValue({ allowed: false, currentTier: 1 });

      const result = checkProgressiveTrustGate(
        mockEvent,
        mockWctx as any,
        '/test/file.ts',
        false,
        10,
        mockLogger,
        { sessionId: 'test-session' }
      );

      expect(result).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No workspaceDir')
      );
      expect(checkEvolutionGate).not.toHaveBeenCalled();
    });
  });
});
