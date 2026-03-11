import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import * as trustEngine from '../../src/core/trust-engine-v2.js';
import * as riskCalculator from '../../src/core/risk-calculator.js';

vi.mock('fs');
vi.mock('../../src/core/trust-engine-v2.js');
vi.mock('../../src/core/risk-calculator.js');

describe('Progressive Gate Hook', () => {
  const workspaceDir = '/mock/workspace';
  
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation for risk calculator
    vi.mocked(riskCalculator.assessRiskLevel).mockReturnValue('LOW');
    vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(1);
  });

  it('should block ALL risk path writes for Stage 1 (Bankruptcy)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/main.ts' } 
    };

    // Trust < 30 => Stage 1
    vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
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
        params: { file_path: 'docs/readme.md', content: 'a\n'.repeat(15) } 
    };

    // Trust 50 => Stage 2
    vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 50 });
    vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(15);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
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

    // Trust 70 => Stage 3
    vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 70 });
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
        params: { file_path: 'src/core.ts', content: 'dangerous refactor' } 
    };

    // Trust 90 => Stage 4
    vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 90 });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
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

      // Trust < 30 => Stage 1
      vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
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

      expect(result).toBeUndefined(); // Should be allowed
    });

    it('should block operation when PLAN is not READY', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = {
        toolName: 'write',
        params: { file_path: 'skills/my-skill.md' }
      };

      vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
      vi.mocked(riskCalculator.assessRiskLevel).mockReturnValue('MEDIUM'); // Make it risky
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
        if (p.includes('PLAN.md')) return 'STATUS: DRAFT\n';
        return '';
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Trust score too low');
    });

    it('should block operation when path does not match patterns', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = {
        toolName: 'write',
        params: { file_path: 'src/other.ts' }
      };

      vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
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

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Trust score too low');
    });

    it('should block operation when tool is not in allowed_operations', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = {
        toolName: 'edit', // Not in allowed_operations
        params: { file_path: 'skills/my-skill.md' }
      };

      vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
      vi.mocked(riskCalculator.assessRiskLevel).mockReturnValue('MEDIUM'); // Make it risky
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
                allowed_patterns: ['**'],
                allowed_operations: ['write'] // edit not included
              }
            }
          });
        }
        if (p.includes('PLAN.md')) return 'STATUS: READY\n';
        return '';
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Trust score too low');
    });

    it('should respect max_lines_override when set', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = {
        toolName: 'write',
        params: { file_path: 'skills/my-skill.md', content: 'a\n'.repeat(20) }
      };

      vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
      vi.mocked(riskCalculator.assessRiskLevel).mockReturnValue('MEDIUM'); // Make it risky
      vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(20);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: ['src/'],
            progressive_gate: {
              enabled: true,
              plan_approvals: {
                enabled: true,
                max_lines_override: 10, // Max 10 lines
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

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Trust score too low');
    });

    it('should block when plan_approvals is not enabled', () => {
      const mockCtx = { workspaceDir };
      const mockEvent = {
        toolName: 'write',
        params: { file_path: 'src/main.ts' }
      };

      vi.mocked(trustEngine.getAgentScorecard).mockReturnValue({ trust_score: 25 });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (p.includes('PROFILE.json')) {
          return JSON.stringify({
            risk_paths: ['src/'],
            progressive_gate: {
              enabled: true,
              plan_approvals: {
                enabled: false // Not enabled
              }
            }
          });
        }
        return '';
      });

      const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

      expect(result).toBeDefined();
      expect(result?.block).toBe(true);
      expect(result?.blockReason).toContain('Trust score too low');
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
      if (p.includes('PLAN.md')) {
        return 'STATUS: DRAFT\n';
      }
      return '';
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('No READY plan found');
  });
});
