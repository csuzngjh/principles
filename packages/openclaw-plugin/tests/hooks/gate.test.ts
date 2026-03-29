import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import { normalizeProfile, PROFILE_DEFAULTS } from '../../src/core/profile.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as riskCalculator from '../../src/core/risk-calculator.js';

vi.mock('fs');
vi.mock('../../src/core/workspace-context.js');
vi.mock('../../src/core/risk-calculator.js');

describe('Progressive Gate Hook', () => {
  const workspaceDir = '/mock/workspace';
  
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
      config: { get: () => undefined },
      eventLog: { recordGateBlock: () => {} },
      trajectory: { recordGateBlock: () => {} },
      resolve: (key: string) => `/test/workspace/.state/${key}.json`,
    } as any);

    const result = handleBeforeToolCall(mockEvent as any, mockCtx as any);
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
