/**
 * Gate Pipeline Integration Tests
 *
 * PURPOSE: Prove that gate.ts has ONE authoritative orchestration path.
 *
 * These tests verify:
 * 1. Progressive gate enabled + edit verification required => verification still runs
 * 2. Progressive gate enabled + GFI block => block still uses the same persistence path
 * 3. Progressive gate enabled + thinking checkpoint => checkpoint still participates in default flow
 * 4. Gate block has ONE authoritative persistence implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  hasRecentThinking: vi.fn(() => false),
}));
vi.mock('../../src/core/evolution-engine.js', () => ({
  checkEvolutionGate: vi.fn(() => ({ allowed: true, currentTier: 'SEED' })),
}));

// Import the mocked hasRecentThinking for test manipulation
const mockedHasRecentThinking = vi.mocked(sessionTracker.hasRecentThinking);

describe('Gate Pipeline Integration - Single Authoritative Path', () => {
  const workspaceDir = '/mock/workspace';
  const sessionId = 'test-session-123';

  const mockConfig = {
    get: vi.fn().mockImplementation((key) => {
      if (key === 'trust') return {
        limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
      };
      if (key === 'gfi_gate') return {
        enabled: true,
        thresholds: { low_risk_block: 70, high_risk_block: 40 },
        bash_safe_patterns: ['^(ls|dir|pwd)$'],
        bash_dangerous_patterns: ['rm\s+-rf'],
      };
      return undefined;
    })
  };

  const mockEventLog = {
    recordGateBlock: vi.fn(),
    recordPlanApproval: vi.fn(),
    recordGateBypass: vi.fn(),
  };

  const mockTrajectory = {
    recordGateBlock: vi.fn(),
  };

  const mockEvolution = {
    getTier: vi.fn().mockReturnValue(3),
    getPoints: vi.fn().mockReturnValue(200),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    config: mockConfig,
    eventLog: mockEventLog,
    trajectory: mockTrajectory,
    evolution: mockEvolution,
    resolve: vi.fn().mockImplementation((key) => {
      if (key === 'PROFILE') return path.join(workspaceDir, '.principles', 'PROFILE.json');
      if (key === 'PLAN') return path.join(workspaceDir, 'PLAN.md');
      if (key === 'STATE_DIR') return path.join(workspaceDir, '.state');
      if (typeof key === 'string' && !key.includes(':')) {
        return path.join(workspaceDir, key);
      }
      return key;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);
    vi.mocked(sessionTracker.trackBlock).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: Progressive gate enabled + edit verification => verification runs
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Edit Verification Integration', () => {
    it('should run edit verification when progressive gate is enabled and operation is allowed', () => {
      const fileContent = 'const x = 1;\n';
      const editEvent = {
        toolName: 'edit',
        params: {
          file_path: 'src/example.ts',
          oldText: 'wrong text that does not exist', // This should trigger edit verification
          newText: 'const x = 2;',
        },
      };

      // Progressive gate enabled
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true }, // ENABLED
            edit_verification: { enabled: true },
          });
        }
        if (typeof p === 'string' && p.includes('example.ts')) {
          return fileContent;
        }
        return '';
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

      const result = handleBeforeToolCall(editEvent as any, { workspaceDir, sessionId } as any);

      // EXPECTED: Edit verification should run and block because oldText doesn't match
      // CURRENT BEHAVIOR (BUG): progressive gate returns early, edit verification never runs
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('P-03'); // Matches [P-03 Violation] or [P-03 Error]
    });

    it('should allow edit when oldText matches (progressive gate enabled)', () => {
      const fileContent = 'const x = 1;\n';
      const editEvent = {
        toolName: 'edit',
        params: {
          file_path: 'src/example.ts',
          oldText: 'const x = 1;', // Exact match (file has \n at end but we match without)
          newText: 'const x = 2;',
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
            edit_verification: { enabled: true },
          });
        }
        if (typeof p === 'string' && p.includes('example.ts')) {
          return fileContent;
        }
        return '';
      });
      vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);

      const result = handleBeforeToolCall(editEvent as any, { workspaceDir, sessionId } as any);

      // Should pass edit verification - fuzzy match should find the content
      // If exact match fails, fuzzy match (0.8 threshold) should pass
      expect(result).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: GFI block uses single persistence path
  // ═══════════════════════════════════════════════════════════════════════════
  describe('GFI Gate Block Persistence', () => {
    it('should use single authoritative block path when GFI gate blocks', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);

      const writeEvent = {
        toolName: 'write',
        params: {
          file_path: 'src/test.ts',
          content: 'new content',
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
          });
        }
        return '';
      });

      const result = handleBeforeToolCall(writeEvent as any, { workspaceDir, sessionId } as any);

      // EXPECTED: Block through GFI gate, with single persistence path
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
      
      // CRITICAL: trackBlock should be called exactly once (single persistence)
      expect(sessionTracker.trackBlock).toHaveBeenCalledTimes(1);
      expect(sessionTracker.trackBlock).toHaveBeenCalledWith(sessionId);
      
      // EventLog should record the block
      expect(mockEventLog.recordGateBlock).toHaveBeenCalled();
    });

    it('should persist trajectory gate block with retry on failure', async () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);

      const writeEvent = {
        toolName: 'write',
        params: {
          file_path: 'src/test.ts',
          content: 'new content',
        },
      };

      // Make trajectory.recordGateBlock fail initially
      mockTrajectory.recordGateBlock.mockImplementation(() => {
        throw new Error('DB locked');
      });

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
          });
        }
        return '';
      });

      const result = handleBeforeToolCall(writeEvent as any, { workspaceDir, sessionId } as any);

      expect(result?.block).toBe(true);

      // Advance timers to trigger retry
      await vi.advanceTimersByTimeAsync(100);

      // Should have attempted trajectory persistence (with retry)
      expect(mockTrajectory.recordGateBlock).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: Thinking checkpoint participates in default flow
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Thinking Checkpoint Integration', () => {
    it('should run thinking checkpoint before progressive gate (when enabled)', () => {
      // Setup: Enable thinking checkpoint
      const bashEvent = {
        toolName: 'run_shell_command',
        params: {
          command: 'rm -rf node_modules',
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
            thinking_checkpoint: {
              enabled: true,
              window_ms: 300000,
              high_risk_tools: ['run_shell_command', 'delete_file'],
            },
          });
        }
        return '';
      });

      // Mock session without recent thinking
      vi.mocked(sessionTracker.getSession).mockReturnValue({
        currentGfi: 0,
        lastThinkingAt: Date.now() - 600000, // 10 min ago
      } as any);
      mockedHasRecentThinking.mockReturnValue(false);

      const result = handleBeforeToolCall(bashEvent as any, { workspaceDir, sessionId } as any);

      // EXPECTED: Thinking checkpoint should block before progressive gate
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      // Check for Chinese message (thinking-checkpoint.ts uses Chinese)
      expect(result?.blockReason).toContain('深度思考');
    });

    it('should allow operation after thinking checkpoint passes', () => {
      const bashEvent = {
        toolName: 'run_shell_command',
        params: {
          command: 'ls -la',
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
            thinking_checkpoint: {
              enabled: true,
              window_ms: 300000,
              high_risk_tools: ['run_shell_command', 'delete_file'],
            },
          });
        }
        return '';
      });

      // Mock session WITH recent thinking (checkpoint passes)
      vi.mocked(sessionTracker.getSession).mockReturnValue({
        currentGfi: 0,
        lastThinkingAt: Date.now() - 60000, // 1 min ago (within window)
      } as any);
      mockedHasRecentThinking.mockReturnValue(true);

      const result = handleBeforeToolCall(bashEvent as any, { workspaceDir, sessionId } as any);

      // Thinking checkpoint passes, no GFI concern, Stage 4 allows
      expect(result).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: Single block persistence implementation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Single Block Persistence Implementation', () => {
    it('should have only ONE trackBlock call per gate block (no duplicate tracking)', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);

      const writeEvent = {
        toolName: 'write',
        params: {
          file_path: 'src/test.ts',
          content: 'x'.repeat(100),
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
          });
        }
        return '';
      });

      handleBeforeToolCall(writeEvent as any, { workspaceDir, sessionId } as any);

      // CRITICAL: trackBlock should be called exactly ONCE
      // If called multiple times, there are multiple block implementations
      expect(sessionTracker.trackBlock).toHaveBeenCalledTimes(1);
    });

    it('should have only ONE eventLog.recordGateBlock call per gate block', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);

      const writeEvent = {
        toolName: 'write',
        params: {
          file_path: 'src/test.ts',
          content: 'x'.repeat(100),
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: [],
            progressive_gate: { enabled: true },
          });
        }
        return '';
      });

      handleBeforeToolCall(writeEvent as any, { workspaceDir, sessionId } as any);

      // Event log should record exactly once
      expect(mockEventLog.recordGateBlock).toHaveBeenCalledTimes(1);
    });
  });
});
