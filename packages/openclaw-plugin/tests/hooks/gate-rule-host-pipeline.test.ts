/**
 * Gate Rule Host Pipeline Integration Tests
 *
 * PURPOSE: Verify that the Rule Host is correctly wired into the gate chain
 * between GFI and Progressive Gate, with correct ordering and behavior.
 *
 * Tests:
 * 1. When GFI blocks, Rule Host is never called
 * 2. When Rule Host blocks, Progressive Gate is never called
 * 3. When Rule Host returns undefined (no active implementations), Progressive Gate runs normally
 * 4. When Rule Host throws, gate continues to Progressive Gate (D-08)
 * 5. Block result uses blockSource='rule-host'
 * 6. Existing gate flow still works when no active implementations exist
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBeforeToolCall } from '../../src/hooks/gate.js';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import * as sessionTracker from '../../src/core/session-tracker.js';
import * as evolutionEngine from '../../src/core/evolution-engine.js';

// Mock fs
vi.mock('fs');

// Mock workspace context
vi.mock('../../src/core/workspace-context.js');

// Mock session tracker
vi.mock('../../src/core/session-tracker.js', () => ({
  getSession: vi.fn(() => ({ currentGfi: 0 })),
  trackBlock: vi.fn(),
  hasRecentThinking: vi.fn(() => false),
}));

// Mock evolution engine
vi.mock('../../src/core/evolution-engine.js', async () => {
  const actual = await vi.importActual('../../src/core/evolution-engine.js');
  return {
    ...actual,
    checkEvolutionGate: vi.fn(() => ({ allowed: true, currentTier: 'SEED' })),
    getEvolutionEngine: vi.fn(),
  };
});

// Mock Rule Host module — controls RuleHost.evaluate behavior
// Use a shared mutable evaluate mock that tests can override
let _mockEvaluate: ReturnType<typeof vi.fn> = vi.fn().mockReturnValue(undefined);

vi.mock('../../src/core/rule-host.js', () => {
  return {
    RuleHost: vi.fn(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    }),
  };
});

// Mock ledger to avoid file reads
vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
  listImplementationsByLifecycleState: vi.fn(() => []),
}));

// Shared mock instance — exposed as module-level so test assertions can reference it
const _mockEventLogInstance = {
  recordGateBlock: vi.fn(),
  recordPlanApproval: vi.fn(),
  recordGateBypass: vi.fn(),
  recordRuleEnforced: vi.fn(),
  recordRuleHostRequireApproval: vi.fn(),
  recordRuleHostEvaluated: vi.fn(),
  recordPainSignal: vi.fn(),
};
vi.mock('../../src/core/event-log.js', () => ({
  EventLogService: { get: vi.fn(() => _mockEventLogInstance) },
  EventLog: {},
}));
// Export so test assertions can use vi.mocked() on the instance
export { _mockEventLogInstance };

import { RuleHost } from '../../src/core/rule-host.js';
import { EventLogService } from '../../src/core/event-log.js';
import * as sessionTrackerModule from '../../src/core/session-tracker.js';
import * as evolutionEngineModule from '../../src/core/evolution-engine.js';

const MockedRuleHost = vi.mocked(RuleHost);

const mockEvolution = {
  getTier: vi.fn().mockReturnValue(3),
  getPoints: vi.fn().mockReturnValue(200),
};

describe('Gate Rule Host Pipeline Integration', () => {
  const workspaceDir = '/mock/workspace';
  const sessionId = 'test-session-rh';

  const mockConfig = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'trust') return {
        limits: { stage_2_max_lines: 50, stage_3_max_lines: 300 }
      };
      if (key === 'gfi_gate') return {
        enabled: true,
        thresholds: { low_risk_block: 70, high_risk_block: 40 },
        bash_safe_patterns: ['^(ls|dir|pwd)$'],
        bash_dangerous_patterns: ['rm\\s+-rf'],
      };
      return undefined;
    })
  };

  const mockEventLog = {
    recordGateBlock: vi.fn(),
    recordPlanApproval: vi.fn(),
    recordGateBypass: vi.fn(),
    recordRuleEnforced: vi.fn(),
    recordRuleHostRequireApproval: vi.fn(),
  };

  const mockTrajectory = {
    recordGateBlock: vi.fn(),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    config: mockConfig,
    eventLog: mockEventLog,
    trajectory: mockTrajectory,
    evolution: mockEvolution,
    resolve: vi.fn().mockImplementation((key: string) => {
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
    // Reset the shared evaluate mock to default (returns undefined)
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
    MockedRuleHost.mockImplementation(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    });
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    vi.mocked(sessionTrackerModule.getSession).mockReturnValue({ currentGfi: 0 } as any);
    vi.mocked(sessionTrackerModule.trackBlock).mockImplementation(() => {});
    vi.mocked(evolutionEngineModule.getEvolutionEngine).mockReturnValue(mockEvolution);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper: create a standard write event
   */
  function makeWriteEvent(overrides?: Partial<any>) {
    return {
      toolName: 'write',
      params: {
        file_path: 'src/test.ts',
        content: 'const x = 1;',
      },
      ...overrides,
    };
  }

  /**
   * Helper: set up fs mocks for a profile with progressive gate enabled
   */
  function setupProfileMock(profileOverrides?: Record<string, unknown>) {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('PROFILE.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('PROFILE.json')) {
        return JSON.stringify({
          risk_paths: [],
          progressive_gate: { enabled: true },
          edit_verification: { enabled: true },
          ...profileOverrides,
        });
      }
      return '';
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: When GFI blocks, Rule Host is never called
  // ═══════════════════════════════════════════════════════════════════════════
  it('should not call Rule Host when GFI gate blocks', () => {
    // Set high GFI to trigger GFI block
    vi.mocked(sessionTrackerModule.getSession).mockReturnValue({ currentGfi: 85 } as any);
    setupProfileMock();

    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    // GFI should block
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('GFI');

    // RuleHost constructor should NOT have been called
    // (GFI returns before reaching Rule Host evaluation)
    expect(MockedRuleHost).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: When Rule Host blocks, Progressive Gate is never called
  // ═══════════════════════════════════════════════════════════════════════════
  it('should not reach Progressive Gate when Rule Host blocks', () => {
    setupProfileMock();

    // Mock RuleHost.evaluate to return a block
    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'block',
      matched: true,
      reason: 'Rule Host test block',
    });
    MockedRuleHost.mockImplementation(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    });

    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    // Rule Host should block
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);

    // The block should come from rule-host
    expect(mockEventLog.recordGateBlock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ blockSource: 'rule-host' })
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 3: When Rule Host returns undefined, Progressive Gate runs normally
  // ═══════════════════════════════════════════════════════════════════════════
  it('should continue to Progressive Gate when Rule Host returns undefined', () => {
    setupProfileMock();

    // Mock RuleHost.evaluate to return undefined (no active implementations)
    _mockEvaluate = vi.fn().mockReturnValue(undefined);
    MockedRuleHost.mockImplementation(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    });

    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    // Should pass through (no block from any gate)
    expect(result).toBeUndefined();

    // Rule Host was called
    expect(_mockEvaluate).toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 4: When Rule Host throws, gate continues to Progressive Gate (D-08)
  // ═══════════════════════════════════════════════════════════════════════════
  it('should continue to Progressive Gate when Rule Host throws (D-08)', () => {
    setupProfileMock();

    // Mock RuleHost.evaluate to throw
    _mockEvaluate = vi.fn().mockImplementation(() => {
      throw new Error('Host internal error');
    });
    MockedRuleHost.mockImplementation(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    });

    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    // Should pass through (host error is caught, degrades to Progressive Gate)
    // Progressive Gate will pass for this low-risk operation
    expect(result).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5: Block result uses blockSource='rule-host'
  // ═══════════════════════════════════════════════════════════════════════════
  it('should use blockSource=rule-host for Rule Host blocks', () => {
    setupProfileMock();

    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'block',
      matched: true,
      reason: 'Dangerous file modification',
    });
    MockedRuleHost.mockImplementation(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    });

    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    expect(result?.block).toBe(true);

    // Verify recordGateBlockAndReturn was called with blockSource='rule-host'
    expect(mockEventLog.recordGateBlock).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        blockSource: 'rule-host',
        reason: 'Dangerous file modification',
      })
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 5b: requireApproval result uses blockSource='rule-host' with reason
  // ═══════════════════════════════════════════════════════════════════════════
  it('should use blockSource=rule-host with approval prefix for requireApproval', () => {
    setupProfileMock();

    _mockEvaluate = vi.fn().mockReturnValue({
      decision: 'requireApproval',
      matched: true,
      reason: 'High-risk path requires approval',
    });
    MockedRuleHost.mockImplementation(function(this: any, _stateDir: string) {
      this.evaluate = _mockEvaluate;
    });

    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    expect(result?.block).toBeUndefined();
    // requireApproval records events but does not block — the operation proceeds
    // to the Progressive Trust Gate for further evaluation.
    // recordRuleEnforced takes a single object arg (no sessionId).
    expect(_mockEventLogInstance.recordRuleEnforced).toHaveBeenCalledWith(
      expect.objectContaining({ enforcement: 'requireApproval' })
    );
    expect(_mockEventLogInstance.recordGateBlock).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 6: Existing gate flow still works when no active implementations exist
  // ═══════════════════════════════════════════════════════════════════════════
  it('should allow operation through existing gate flow with no active implementations', () => {
    setupProfileMock();

    // Default mock: RuleHost.evaluate returns undefined (already set in beforeEach)
    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    // Should pass all gates — no block
    expect(result).toBeUndefined();
  });

  it('should block with GFI even when Rule Host would allow', () => {
    // High GFI triggers GFI block
    vi.mocked(sessionTrackerModule.getSession).mockReturnValue({ currentGfi: 85 } as any);
    setupProfileMock();

    // Even if RuleHost would allow, GFI blocks first
    const result = handleBeforeToolCall(makeWriteEvent() as any, { workspaceDir, sessionId } as any);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain('GFI');
  });

  it('should allow edit when oldText matches (full pipeline with Rule Host)', () => {
    const fileContent = 'const x = 1;\n';
    const editEvent = {
      toolName: 'edit',
      params: {
        file_path: 'src/example.ts',
        oldText: 'const x = 1;',
        newText: 'const x = 2;',
      },
    };

    setupProfileMock();

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
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('PROFILE.json')) return true;
      if (typeof p === 'string' && p.includes('example.ts')) return true;
      return false;
    });

    const result = handleBeforeToolCall(editEvent as any, { workspaceDir, sessionId } as any);

    expect(result).toBeUndefined();
  });
});
