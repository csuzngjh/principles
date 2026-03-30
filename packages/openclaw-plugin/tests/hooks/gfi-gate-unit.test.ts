import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkGfiGate } from '../../src/hooks/gfi-gate.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';
import { EvolutionTier } from '../../src/core/evolution-types.js';

vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/evolution-engine.js', async () => {
  const actual = await vi.importActual('../../src/core/evolution-engine.js');
  return {
    ...actual,
    getEvolutionEngine: vi.fn(),
  };
});

const mockEvolution = {
  getTier: vi.fn().mockReturnValue(EvolutionTier.Sapling),
  getPoints: vi.fn().mockReturnValue(200),
  getAvailablePoints: vi.fn().mockReturnValue(200),
  getTierDefinition: vi.fn().mockReturnValue({
    tier: EvolutionTier.Sapling,
    name: 'Sapling',
    requiredPoints: 200,
    permissions: { maxLinesPerWrite: 500, maxFilesPerTask: 10, allowRiskPath: true, allowSubagentSpawn: true }
  }),
};

describe('checkGfiGate', () => {
  const workspaceDir = '/mock/workspace';

  const mockWctx = {
    workspaceDir,
    evolution: mockEvolution,
  } as any;

  const mockLogger = {
    warn: vi.fn(),
  };

  const defaultConfig = {
    enabled: true,
    thresholds: {
      low_risk_block: 70,
      high_risk_block: 40,
    },
    large_change_lines: 50,
    ep_tier_multipliers: {
      '1': 0.5,
      '2': 0.75,
      '3': 1.0,
      '4': 1.5,
    },
    bash_safe_patterns: [
      '^(ls|dir|pwd|cat|echo)\\b',
      '^git\\s+(status|log)',
    ],
    bash_dangerous_patterns: [
      'rm\\s+.*-rf',
      'git\\s+push.*--force',
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sessionTracker.getSession).mockReturnValue({
      currentGfi: 0,
    } as any);
    mockEvolution.getTier.mockReturnValue(EvolutionTier.Sapling);
    mockEvolution.getPoints.mockReturnValue(200);
    mockEvolution.getAvailablePoints.mockReturnValue(200);
    mockEvolution.getTierDefinition.mockReturnValue({
      tier: EvolutionTier.Sapling,
      name: 'Sapling',
      requiredPoints: 200,
      permissions: { maxLinesPerWrite: 500, maxFilesPerTask: 10, allowRiskPath: true, allowSubagentSpawn: true }
    });
    vi.mocked(evolutionEngine.getEvolutionEngine).mockReturnValue(mockEvolution);
  });

  // ════════════════════════════════════════════════
  // Configuration
  // ════════════════════════════════════════════════
  describe('Configuration', () => {
    it('should return undefined when disabled', () => {
      const config = { ...defaultConfig, enabled: false };
      const event = {
        toolName: 'write',
        params: { file_path: 'test.txt' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', config, mockLogger);

      expect(result).toBeUndefined();
    });

    it('should return undefined when no sessionId', () => {
      const event = {
        toolName: 'write',
        params: { file_path: 'test.txt' },
      } as any;

      const result = checkGfiGate(event, mockWctx, undefined, defaultConfig, mockLogger);

      expect(result).toBeUndefined();
    });

    it('should return undefined when session not found', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue(undefined);
      const event = {
        toolName: 'write',
        params: { file_path: 'test.txt' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeUndefined();
    });
  });

  // ════════════════════════════════════════════════
  // TIER 3: Bash commands
  // ════════════════════════════════════════════════
  describe('TIER 3: Bash commands', () => {
    describe('Safe commands', () => {
      it('should allow safe bash commands regardless of GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 95 } as any);
        const event = {
          toolName: 'bash',
          params: { command: 'git status' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeUndefined();
      });

      it('should allow "ls -la"', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 90 } as any);
        const event = {
          toolName: 'run_shell_command',
          params: { command: 'ls -la' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeUndefined();
      });
    });

    describe('Dangerous commands', () => {
      it('should block dangerous commands regardless of GFI', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);
        mockEvolution.getTier.mockReturnValue(4);
        const event = {
          toolName: 'bash',
          params: { command: 'rm -rf node_modules' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('危险命令');
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Dangerous bash command blocked'));
      });

      it('should block "git push --force"', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 5 } as any);
        mockEvolution.getTier.mockReturnValue(4);
        const event = {
          toolName: 'bash',
          params: { command: 'git push origin main --force' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('危险命令');
      });
    });

    describe('Normal commands (GFI-based)', () => {
      it('should block normal bash when GFI exceeds threshold', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 80 } as any);
        mockEvolution.getTier.mockReturnValue(3);
        const event = {
          toolName: 'bash',
          params: { command: 'npm install lodash' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('GFI');
      });

      it('should allow normal bash when GFI below threshold', () => {
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 30 } as any);
        mockEvolution.getTier.mockReturnValue(3);
        const event = {
          toolName: 'bash',
          params: { command: 'npm install lodash' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeUndefined();
      });

      it('should apply trust stage multiplier to bash threshold', () => {
        // Stage 1: threshold = 70 * 0.5 = 35
        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 40 } as any);
        mockEvolution.getTier.mockReturnValue(1);
        const event = {
          toolName: 'bash',
          params: { command: 'npm test' },
        } as any;

        const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
      });
    });
  });

  // ════════════════════════════════════════════════
  // TIER 2: High-risk tools
  // ════════════════════════════════════════════════
  describe('TIER 2: High-risk tools', () => {
    it('should block delete_file when GFI >= 40', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 50 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'delete_file',
        params: { file_path: 'temp/file.txt' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should allow delete_file when GFI < 40', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 30 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'delete_file',
        params: { file_path: 'temp/file.txt' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeUndefined();
    });

    it('should block move_file when GFI >= 40', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 55 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'move_file',
        params: { source: 'old.ts', destination: 'new.ts' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });

    it('should apply trust stage multiplier to high-risk threshold', () => {
      // Stage 1: threshold = 40 * 0.5 = 20
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 25 } as any);
      mockEvolution.getTier.mockReturnValue(1);
      const event = {
        toolName: 'delete_file',
        params: { file_path: 'test.txt' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });
  });

  // ════════════════════════════════════════════════
  // TIER 1: Low-risk write tools
  // ════════════════════════════════════════════════
  describe('TIER 1: Low-risk write tools', () => {
    it('should block write when GFI >= 70', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 75 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'write',
        params: { file_path: 'test.txt', content: 'hello' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should allow write when GFI < 70', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 50 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'write',
        params: { file_path: 'test.txt', content: 'hello' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeUndefined();
    });

    it('should block edit when GFI >= 70', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 80 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'edit',
        params: { file_path: 'src/util.ts', oldText: 'foo', newText: 'bar' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });

    it('should apply trust stage multiplier to low-risk threshold', () => {
      // Stage 1: threshold = 70 * 0.5 = 35
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 40 } as any);
      mockEvolution.getTier.mockReturnValue(1);
      const event = {
        toolName: 'write',
        params: { file_path: 'test.txt', content: 'hello' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });
  });

  // ════════════════════════════════════════════════
  // AGENT_TOOLS: Subagent spawn protection
  // ════════════════════════════════════════════════
  describe('AGENT_TOOLS: Subagent spawn', () => {
    it('should block sessions_spawn when GFI >= 90', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 90 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'sessions_spawn',
        params: { task: 'Analyze code' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('禁止派生子智能体');
    });

    it('should allow sessions_spawn when GFI < 90', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'sessions_spawn',
        params: { task: 'Analyze code' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeUndefined();
    });

    it('should block agent spawn even at GFI=95 (critical threshold)', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 95 } as any);
      mockEvolution.getTier.mockReturnValue(4);
      const event = {
        toolName: 'sessions_spawn',
        params: { task: 'Critical task' },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });
  });

  // ════════════════════════════════════════════════
  // Large change threshold reduction
  // ════════════════════════════════════════════════
  describe('Large change reduction', () => {
    it('should lower threshold for large write operations', () => {
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 55 } as any);
      mockEvolution.getTier.mockReturnValue(3);
      const event = {
        toolName: 'write',
        params: { file_path: 'large.ts', content: 'x\n'.repeat(120) },
      } as any;

      const result = checkGfiGate(event, mockWctx, 'test-session', defaultConfig, mockLogger);

      // 120 lines > 50 (large_change_lines)
      // threshold = 70 * (1 - min(120/200, 0.5)) = 70 * 0.7 = 49
      // GFI=55 > 49, should block
      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
    });
  });
});
