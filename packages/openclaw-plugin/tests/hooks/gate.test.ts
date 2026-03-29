import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import { normalizeProfile, PROFILE_DEFAULTS } from '../../src/core/profile.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as riskCalculator from '../../src/core/risk-calculator.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/risk-calculator.js');
vi.mock('../../src/core/evolution-engine.js');

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
    trajectory: {
      recordGateBlock: vi.fn(),
    },
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

  it('should block risk path writes at Seed tier (EP system)', () => {
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
    // EP system blocks risk path at Seed tier
    vi.mocked(evolutionEngine.checkEvolutionGate).mockReturnValue({
      allowed: false,
      currentTier: 1,
      reason: 'Seed tier cannot modify risk paths'
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('risk path');
  });

  it('should block large writes at Seed tier (EP system)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'docs/readme.md' } 
    };

    mockTrust.getScore.mockReturnValue(50);
    mockTrust.getStage.mockReturnValue(2);
    vi.mocked(riskCalculator.estimateLineChanges).mockReturnValue(200);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], progressive_gate: { enabled: true } });
    });
    // EP system blocks 200 lines at Seed tier (limit is 150)
    vi.mocked(evolutionEngine.checkEvolutionGate).mockReturnValue({
      allowed: false,
      currentTier: 1,
      reason: 'Seed tier limit is 150 lines per write, requested 200'
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('150');
  });

  it('should allow risk paths at Sapling tier (EP system)', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/core.ts' } 
    };

    mockTrust.getScore.mockReturnValue(70);
    mockTrust.getStage.mockReturnValue(3);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
        return JSON.stringify({ risk_paths: ['src/'], progressive_gate: { enabled: true } });
    });
    // EP system allows at Sapling tier (risk path allowed)
    vi.mocked(evolutionEngine.checkEvolutionGate).mockReturnValue({
      allowed: true,
      currentTier: 3,
      reason: ''
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeUndefined(); // Allowed
  });

  it('should allow everything for Forest tier (EP system)', () => {
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
    // EP system allows everything at Forest tier
    vi.mocked(evolutionEngine.checkEvolutionGate).mockReturnValue({
      allowed: true,
      currentTier: 5,
      reason: ''
    });

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    expect(result).toBeUndefined(); // Allowed
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

// ═══════════════════════════════════════════════════════════════════════════
// Task 4: Default Values Consistency Tests
// ═══════════════════════════════════════════════════════════════════════════
describe('Gate Default Values Consistency', () => {
  /**
   * PURPOSE: Prove that gate.ts inline defaults match PROFILE_DEFAULTS.
   * If gate.ts has inline defaults that differ from normalizeProfile(),
   * this is a bug - the defaults should come from a single source of truth.
   *
   * IMPORTANT: gate.ts should use normalizeProfile({}) for defaults,
   * not maintain a separate inline object.
   */

  it('gate.ts uses PROFILE_DEFAULTS when PROFILE.json does not exist', () => {
    // When PROFILE.json doesn't exist, gate.ts should use defaults from normalizeProfile
    const expectedDefaults = normalizeProfile({});

    // Verify key defaults are correct
    expect(expectedDefaults.progressive_gate.enabled).toBe(true);
    expect(expectedDefaults.edit_verification.enabled).toBe(true);
    expect(expectedDefaults.thinking_checkpoint.enabled).toBe(false);
    expect(expectedDefaults.risk_paths).toEqual([]);
    expect(expectedDefaults.gate.require_plan_for_risk_paths).toBe(true);
  });

  it('gate.ts default behavior matches normalizeProfile({})', () => {
    const defaults = normalizeProfile({});

    // Test gate behavior with no PROFILE.json
    const mockCtx = { workspaceDir: '/test/workspace', sessionId: 'test-session' };
    const mockEvent = {
      toolName: 'write',
      params: { file_path: 'src/test.ts', content: 'test' }
    };

    vi.mocked(fs.existsSync).mockReturnValue(false); // No PROFILE.json
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      workspaceDir: '/test/workspace',
      trust: { getScore: () => 80, getStage: () => 4 },
      config: { get: () => undefined },
      eventLog: { recordGateBlock: () => {} },
      trajectory: { recordGateBlock: () => {} },
      resolve: (key: string) => `/test/workspace/.state/${key}.json`,
    } as any);

    // Should not throw, should use defaults
    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);

    // With defaults: progressive_gate.enabled=true, trust=Stage4, should allow
    // (Stage 4 bypasses progressive gate)
    expect(result).toBeUndefined();
  });

  it('gate.ts thinking_checkpoint default is OFF (false)', () => {
    const defaults = normalizeProfile({});

    // CRITICAL: thinking_checkpoint must default to false
    // Otherwise new users will be blocked by deep reflection requirement
    expect(defaults.thinking_checkpoint.enabled).toBe(false);

    // Verify gate.ts respects this default
    const mockCtx = { workspaceDir: '/test/workspace', sessionId: 'test-session' };
    const bashEvent = {
      toolName: 'run_shell_command',
      params: { command: 'ls -la' }
    };

    vi.mocked(fs.existsSync).mockReturnValue(false); // No PROFILE.json
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      workspaceDir: '/test/workspace',
      trust: { getScore: () => 80, getStage: () => 4 },
      config: { get: () => undefined },
      eventLog: { recordGateBlock: () => {} },
      trajectory: { recordGateBlock: () => {} },
      resolve: (key: string) => `/test/workspace/.state/${key}.json`,
    } as any);

    // Should NOT be blocked by thinking checkpoint (default OFF)
    const result = handleBeforeToolCall(bashEvent as any, mockCtx as any);
    expect(result).toBeUndefined();
  });
});
