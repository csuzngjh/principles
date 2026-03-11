import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as riskCalculator from '../../src/core/risk-calculator.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/risk-calculator.js');

describe('Progressive Gate Hook', () => {
  const workspaceDir = '/mock/workspace';
  
  const mockTrust = {
    getScorecard: vi.fn(),
    getScore: vi.fn(),
    getStage: vi.fn(),
  };

  const mockConfig = {
    get: vi.fn().mockImplementation((key) => {
        if (key === 'trust') return {
            limits: { stage_2_max_lines: 10, stage_3_max_lines: 100 }
        };
        return undefined;
    })
  };

  const mockEventLog = {
    recordGateBlock: vi.fn(),
    recordPlanApproval: vi.fn(),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    trust: mockTrust,
    config: mockConfig,
    eventLog: mockEventLog,
    resolve: vi.fn().mockImplementation((key) => {
        if (key === 'PROFILE') return path.join(workspaceDir, '.principles', 'PROFILE.json');
        if (key === 'PLAN') return path.join(workspaceDir, 'PLAN.md');
        return '';
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    vi.mocked(riskCalculator.assessRiskLevel).mockReturnValue('LOW');
    vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(1);
  });

  it('should block ALL risk path writes for Stage 1 (Bankruptcy)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/main.ts' } 
    };

    mockTrust.getScore.mockReturnValue(25);
    mockTrust.getStage.mockReturnValue(1);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], progressive_gate: { enabled: true } });
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('Trust score too low');
  });

  it('should block large writes (>10 lines) for Stage 2 (Editor)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'docs/readme.md' } 
    };

    mockTrust.getScore.mockReturnValue(50);
    mockTrust.getStage.mockReturnValue(2);
    vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(15);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], progressive_gate: { enabled: true } });
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('Modification too large');
  });

  it('should require PLAN for risk paths in Stage 3 (Developer)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/core.ts' } 
    };

    mockTrust.getScore.mockReturnValue(70);
    mockTrust.getStage.mockReturnValue(3);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (p.includes('PROFILE.json')) return JSON.stringify({ risk_paths: ['src/'], progressive_gate: { enabled: true } });
        if (p.includes('PLAN.md')) return 'STATUS: DRAFT\n';
        return '';
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('No READY plan found');
  });

  it('should allow everything for Stage 4 (Architect)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/core.ts' } 
    };

    mockTrust.getScore.mockReturnValue(90);
    mockTrust.getStage.mockReturnValue(4);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], progressive_gate: { enabled: true } });
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeUndefined(); // Allowed
  });

  describe('Stage 1 PLAN Approvals', () => {
    it('should allow operation when PLAN is READY and matches whitelist', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = {
        toolName: 'write',
        params: { file_path: 'skills/my-skill.md' }
      };

      mockTrust.getScore.mockReturnValue(25);
      mockTrust.getStage.mockReturnValue(1);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: ['src/'],
            progressive_gate: {
              enabled: true,
              plan_approvals: {
                enabled: true,
                max_lines_override: -1,
                allowed_patterns: ['skills/**'],
                allowed_operations: ['write']
              }
            }
          });
        }
        if (p.includes('PLAN.md')) return 'STATUS: READY\n';
        return '';
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeUndefined(); 
    });
  });

  it('should fall back to original logic if progressive gate is disabled', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/db/user.ts' } 
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p.includes('PROFILE.json')) {
        return JSON.stringify({ risk_paths: ['src/db/'], gate: { require_plan_for_risk_paths: true }, progressive_gate: { enabled: false } });
      }
      if (p.includes('PLAN.md')) return 'STATUS: DRAFT\n';
      return '';
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('No READY plan found');
  });
});
