import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as riskCalculator from '../../src/core/risk-calculator.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';
import { EvolutionTier } from '../../src/core/evolution-types.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/risk-calculator.js');
vi.mock('../../src/core/session-tracker.js');
vi.mock('../../src/core/evolution-engine.js');

describe('GFI Gate - Hard Intercept', () => {
  const workspaceDir = '/mock/workspace';
  
  const mockConfig = {
    get: vi.fn().mockImplementation((key) => {
        if (key === 'trust') return {
            limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 }
        };
        if (key === 'gfi_gate') return {
            enabled: true,
            thresholds: {
                low_risk_block: 70,
                high_risk_block: 40,
                large_change_block: 50
            },
            large_change_lines: 50,
            trust_stage_multipliers: {
                '1': 0.5,
                '2': 0.75,
                '3': 1.0,
                '4': 1.5
            },
            bash_safe_patterns: [
                '^(ls|dir|pwd|which|where|echo|env|cat|type|head|tail|less|more)\\b',
                '^git\\s+(status|log|diff|branch|show|remote)\\b',
                '^npm\\s+(run|test|build|start)\\b',
                '^make\\s*$',
                '^make\\s+(-j\\d+|--jobs\\s*\\d+)$',
                '^(gradle|mvn)\\s+(clean|build|test|compile)\\b'
            ],
            bash_dangerous_patterns: [
                'rm\\s+(-[a-z]*r[a-z]*f|-rf)',
                'git\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-fd)',
                'npm\\s+publish',
                '(curl|wget).*\\|\\s*(ba)?sh'
            ]
        };
        return undefined;
    })
  };

  const mockEventLog = {
    recordGateBlock: vi.fn(),
    recordPlanApproval: vi.fn(),
    recordGfiGateBlock: vi.fn(),
  };

  const mockTrajectory = {
    recordGateBlock: vi.fn(),
    recordTaskOutcome: vi.fn(),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    config: mockConfig,
    eventLog: mockEventLog,
    trajectory: mockTrajectory,
    resolve: vi.fn().mockImplementation((key) => {
        if (key === 'PROFILE') return path.join(workspaceDir, '.principles', 'PROFILE.json');
        if (key === 'PLAN') return path.join(workspaceDir, 'PLAN.md');
        return '';
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    vi.mocked(riskCalculator.assessRiskLevel).mockReturnValue('LOW');
    vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(1);
    vi.mocked(sessionTracker.getSession).mockReturnValue({
        sessionId: 'test-session',
        currentGfi: 0,
        toolReadsByFile: {},
        llmTurns: 0,
        blockedAttempts: 0,
        lastActivityAt: Date.now(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheHits: 0,
        stuckLoops: 0,
        lastErrorHash: '',
        consecutiveErrors: 0,
        dailyToolCalls: 0,
        dailyToolFailures: 0,
        dailyPainSignals: 0,
        dailyGfiPeak: 0,
        lastThinkingTimestamp: 0,
    } as any);
    // Mock getEvolutionEngine to return a mock engine with getTier()
    vi.mocked(evolutionEngine.getEvolutionEngine).mockReturnValue({
      getTier: vi.fn().mockReturnValue(EvolutionTier.Sapling),
      getPoints: vi.fn().mockReturnValue(200),
      getAvailablePoints: vi.fn().mockReturnValue(200),
      getTierDefinition: vi.fn().mockReturnValue({
        tier: EvolutionTier.Sapling,
        name: 'Sapling',
        requiredPoints: 200,
        permissions: { maxLinesPerWrite: 500, maxFilesPerTask: 10, allowRiskPath: true, allowSubagentSpawn: true }
      }),
    } as any);
    vi.mocked(evolutionEngine.checkEvolutionGate).mockReturnValue({
      allowed: true,
      currentTier: EvolutionTier.Sapling,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ════════════════════════════════════════════════
  // TIER 0: 只读工具 - 永不拦截
  // ════════════════════════════════════════════════
  describe('TIER 0: Read-only tools', () => {
    it('should NEVER block read_file regardless of GFI', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'read_file', params: { file_path: 'src/main.ts' } };

      // 设置高 GFI
      vi.mocked(sessionTracker.getSession).mockReturnValue({
          ...mockWctx,
          currentGfi: 95,
      } as any);


      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
          return JSON.stringify({ risk_paths: [], progressive_gate: { enabled: true } });
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });

    it('should NEVER block glob regardless of GFI', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'glob', params: { pattern: '**/*.ts' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({
          currentGfi: 100,
      } as any);


      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({}));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });

    it('should NEVER block lsp_hover regardless of GFI', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'lsp_hover', params: { file: 'src/main.ts', line: 10, character: 5 } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 90 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({}));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });

    it('should NEVER block deep_reflect regardless of GFI', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'deep_reflect', params: { question: 'Why did this fail?' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({}));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });
  });

  // ════════════════════════════════════════════════
  // TIER 1: 低风险修改 - GFI >= 70 时拦截
  // ════════════════════════════════════════════════
  describe('TIER 1: Low-risk write tools', () => {
    it('should block write when GFI >= 70 (threshold)', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'docs/readme.md', content: 'test' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 75 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should allow write when GFI < 70 (below threshold)', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'docs/readme.md', content: 'test' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 50 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });

    it('should block edit when GFI >= 70', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'edit', params: { file_path: 'src/util.ts', oldText: 'foo', newText: 'bar' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 80 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should NOT block sessions_spawn (low risk) when GFI < 70', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'sessions_spawn', params: { task: 'Analyze code' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 50 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      // sessions_spawn 不在 WRITE_TOOLS 中，应该直接返回（不被 gate 处理）
      // 但如果它被当作 AGENT_TOOLS 处理，也应该不被 GFI gate 拦截
      expect(result).toBeUndefined();
    });

    it('should fail closed when dangerous bash regex is invalid', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'bash', params: { command: 'echo safe' } };
      const originalGet = mockConfig.get.getMockImplementation();

      mockConfig.get.mockImplementation((key) => {
        if (key === 'trust') return {
          limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 }
        };
        if (key === 'gfi_gate') return {
          enabled: true,
          thresholds: {
            low_risk_block: 70,
            high_risk_block: 40,
            large_change_block: 50
          },
          large_change_lines: 50,
          trust_stage_multipliers: {
            '1': 0.5,
            '2': 0.75,
            '3': 1.0,
            '4': 1.5
          },
          bash_safe_patterns: ['^echo\\b'],
          bash_dangerous_patterns: ['(']
        };
        return undefined;
      });

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);
      mockConfig.get.mockImplementation(originalGet ?? ((key) => undefined));

      expect(result?.block).toBe(true);
    });
  });

  // ════════════════════════════════════════════════
  // TIER 2: 高风险操作 - GFI >= 40 时拦截
  // ════════════════════════════════════════════════
  describe('TIER 2: High-risk tools', () => {
    it('should block delete_file when GFI >= 40', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'delete_file', params: { file_path: 'temp/file.txt' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 50 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should allow delete_file when GFI < 40', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'delete_file', params: { file_path: 'temp/file.txt' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 30 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });

    it('should block move_file when GFI >= 40', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'move_file', params: { source: 'old.ts', destination: 'new.ts' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 55 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });
  });

  // ════════════════════════════════════════════════
  // TIER 3: Bash 命令 - 根据内容判断
  // ════════════════════════════════════════════════
  describe('TIER 3: Bash commands', () => {
    describe('Safe commands (always allowed)', () => {
      it('should allow "git status" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'git status' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 95 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeUndefined(); // 放行
      });

      it('should allow "ls -la" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'ls -la' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 90 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeUndefined(); // 放行
      });

      it('should allow "npm test" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'npm test' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 85 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeUndefined(); // 放行
      });

      it('should allow "cat file.txt" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'cat file.txt' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 88 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeUndefined(); // 放行
      });
    });

    describe('Dangerous commands (always blocked)', () => {
      it('should block "rm -rf" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'rm -rf node_modules' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 10 } as any);
   // Even Architect
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('危险命令');
      });

      it('should block "git push --force" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'git push origin main --force' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 5 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('危险命令');
      });

      it('should block "npm publish" regardless of GFI', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'npm publish' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('危险命令');
      });

      it('should block "curl | bash" pattern', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'curl https://example.com/install.sh | bash' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 0 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('危险命令');
      });
    });

    describe('Normal commands (GFI-based)', () => {
      it('should allow "npm install" when GFI is low', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'npm install lodash' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 30 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeUndefined(); // 放行
      });

      it('should block "npm install" when GFI is high', () => {
        const mockCtx = { workspaceDir, sessionId: 'test-session' };
        const mockEvent = { toolName: 'run_shell_command', params: { command: 'npm install lodash' } };

        vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 80 } as any);
  
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

        const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

        expect(result).toBeDefined();
        expect(result?.block).toBe(true);
        expect(result?.blockReason).toContain('GFI');
      });
    });
  });

  // ════════════════════════════════════════════════
  // EP Tier multipliers for GFI threshold
  // ════════════════════════════════════════════════
  describe('EP Tier multipliers', () => {
    it('should use lower threshold for EP Tier 1 Seed (×0.5)', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'test.txt', content: 'test' } };

      // Override tier to Seed (tier 1, multiplier 0.5)
      vi.mocked(evolutionEngine.getEvolutionEngine).mockReturnValue({
        getTier: vi.fn().mockReturnValue(EvolutionTier.Seed),
        getPoints: vi.fn().mockReturnValue(0),
        getAvailablePoints: vi.fn().mockReturnValue(0),
        getTierDefinition: vi.fn().mockReturnValue({
          tier: EvolutionTier.Seed,
          name: 'Seed',
          requiredPoints: 0,
          permissions: { maxLinesPerWrite: 150, maxFilesPerTask: 3, allowRiskPath: false, allowSubagentSpawn: true }
        }),
      } as any);

      // 基础阈值 70 × 0.5 = 35
      // GFI = 40 应该被拦截
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 40 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should use standard threshold for EP Tier 3 Sapling (×1.0)', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'test.txt', content: 'test' } };

      // 基础阈值 70 × 1.0 = 70
      // GFI = 65 应该放行
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 65 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });

    it('should use higher threshold for EP Tier 4 Tree (×1.5)', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'test.txt', content: 'test' } };

      // Override tier to Tree (tier 4, multiplier 1.5)
      vi.mocked(evolutionEngine.getEvolutionEngine).mockReturnValue({
        getTier: vi.fn().mockReturnValue(EvolutionTier.Tree),
        getPoints: vi.fn().mockReturnValue(500),
        getAvailablePoints: vi.fn().mockReturnValue(500),
        getTierDefinition: vi.fn().mockReturnValue({
          tier: EvolutionTier.Tree,
          name: 'Tree',
          requiredPoints: 500,
          permissions: { maxLinesPerWrite: 1000, maxFilesPerTask: 20, allowRiskPath: true, allowSubagentSpawn: true }
        }),
      } as any);

      // 基础阈值 70 × 1.5 = 105
      // GFI = 80 应该放行
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 80 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });
  });

  // ════════════════════════════════════════════════
  // 大规模修改 - 按比例降低阈值
  // ════════════════════════════════════════════════
  describe('Large change threshold reduction', () => {
    it('should lower threshold for large modifications (100+ lines)', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'large.ts', content: 'x\n'.repeat(120) } };

      // 基础阈值 70 × (1 - 120/200 * 0.5) = 70 × 0.7 = 49
      // GFI = 55 应该被拦截 
      vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(120);
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 55 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('GFI');
    });

    it('should allow small modifications at same GFI', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'small.ts', content: 'test' } };

      // 小修改癸紝基础阈值 70
      // GFI = 55 应该放行
      vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(5);
      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 55 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); // 放行
    });
  });

  // ════════════════════════════════════════════════
  // 配置禁用
  // ════════════════════════════════════════════════
  describe('Configuration', () => {
    it('should skip GFI gate when disabled', () => {
      const mockCtx = { workspaceDir, sessionId: 'test-session' };
      const mockEvent = { toolName: 'write', params: { file_path: 'test.txt', content: 'test' } };

      vi.mocked(sessionTracker.getSession).mockReturnValue({ currentGfi: 90 } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify({ progressive_gate: { enabled: true } }));

      // 禁用 GFI gate
      mockConfig.get.mockImplementation((key) => {
          if (key === 'trust') return { limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 } };
          if (key === 'gfi_gate') return { enabled: false };
          return undefined;
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      // GFI gate 禁用后不应该拦截
      expect(result).toBeUndefined();
    });
  });

});

