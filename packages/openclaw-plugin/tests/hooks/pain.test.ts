import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAfterToolCall } from '../../src/hooks/pain.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ioUtils from '../../src/utils/io.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { setInjectedProbationIds, clearSession } from '../../src/core/session-tracker.js';
import { resetTriggerCooldownForTest } from '../../src/hooks/after-tool-call-helpers.js';
import { buildToolFailureObservation, resolveSourceKind } from '../../src/hooks/raw-observation-adapter.js';
import { loadFeatureFlagFromConfig } from '../../src/core/pd-config-loader.js';

vi.mock('fs');
vi.mock('../../src/utils/io.js');
vi.mock('../../src/core/pd-config-loader.js', () => ({
  loadPdConfigForPlugin: vi.fn(() => ({ ok: true, source: 'mock', effective: {}, errors: [] })),
  loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: false, source: 'mock' })),
}));
vi.mock('../../src/core/evolution-engine.js', () => ({
  recordEvolutionSuccess: vi.fn(),
  recordEvolutionFailure: vi.fn(),
}));
vi.mock('../../src/core/evolution-logger.js', () => ({
  createTraceId: vi.fn(() => 'trace-123'),
  getEvolutionLogger: vi.fn(() => ({
    logPainDetected: vi.fn(),
  })),
}));

const mockEmitSync = vi.fn();
const mockRecordProbationFeedback = vi.fn();
const mockUpdatePrincipleValueMetrics = vi.fn();

// PRI-360 S1: classifyToolFailureSource tests migrated to resolveSourceKind + buildToolFailureObservation
// See triage-adapter.test.ts for the unified RawObservation path tests

describe('buildToolFailureObservation + resolveSourceKind (replaces classifyToolFailureSource)', () => {
  it('empty toolName -> dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: undefined, error: 'tool not found', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
    const obs2 = buildToolFailureObservation({ toolName: '', error: 'tool not found', exitCode: 1 });
    expect(resolveSourceKind(obs2)).toBe('dispatch_error');
  });

  it('"Tool not found" (case insensitive) -> dispatch_error', () => {
    const cases = [
      'error: tool not found',
      'Tool Not Found',
      'Tool read_file not found',
    ];
    for (const err of cases) {
      const obs = buildToolFailureObservation({ toolName: 'read', error: err, exitCode: 1 });
      expect(resolveSourceKind(obs)).toBe('dispatch_error');
    }
  });

  it('"Unknown tool" (case insensitive) -> dispatch_error', () => {
    const cases = ['error: unknown tool', 'Unknown Tool', 'failed: unknown tool read_file'];
    for (const err of cases) {
      const obs = buildToolFailureObservation({ toolName: 'read', error: err, exitCode: 1 });
      expect(resolveSourceKind(obs)).toBe('dispatch_error');
    }
  });

  it('Warning-style messages containing "tool not found" -> dispatch_error', () => {
    const cases = ['Warning: tool not found was suppressed', 'Warning: tool not found - already handled'];
    for (const err of cases) {
      const obs = buildToolFailureObservation({ toolName: 'read', error: err, exitCode: 1 });
      expect(resolveSourceKind(obs)).toBe('dispatch_error');
    }
  });

  it('real execution errors (ENOENT, EACCES) -> tool_failure', () => {
    const cases = [
      { toolName: 'read' as const, error: 'ENOENT: no such file or directory' },
      { toolName: 'write' as const, error: 'EACCES: permission denied' },
      { toolName: 'edit' as const, error: 'Error: EIO: I/O error' },
    ];
    for (const { toolName, error } of cases) {
      const obs = buildToolFailureObservation({ toolName, error, exitCode: 1 });
      expect(resolveSourceKind(obs)).toBe('tool_failure');
    }
  });

  it('edge cases: null/undefined/empty error -> tool_failure', () => {
    // With valid toolName and non-zero exit, no error message → tool_failure
    const obs = buildToolFailureObservation({ toolName: 'read', error: undefined, exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('word-boundary: "report_tool_not_found" does NOT match dispatch pattern', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'report_tool_not_found', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('word-boundary: "atoolnotfound" (no spaces) does NOT match dispatch pattern', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'atoolnotfound', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('word-boundary: "unknown_tool" (underscore, no space) does NOT match dispatch pattern', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'unknown_tool', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });

  it('whitespace-only toolName -> dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: '   ', error: 'tool not found', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
  });

  it('"tool <name> not found" with multi-word tool name -> dispatch_error', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'tool my_custom_tool not found', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('dispatch_error');
  });

  it('partial match "not found" without "tool" prefix -> tool_failure', () => {
    const obs = buildToolFailureObservation({ toolName: 'read', error: 'file not found', exitCode: 1 });
    expect(resolveSourceKind(obs)).toBe('tool_failure');
  });
});

describe('Post-Write Checks & Pain Hook', () => {
  const workspaceDir = '/mock/workspace';
  const mockEventLog = {
    recordToolCall: vi.fn(),
    recordPainSignal: vi.fn(),
  };
  const mockConfig = {
    get: vi.fn().mockReturnValue(30),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    config: mockConfig,
    eventLog: mockEventLog,
    trajectory: {
      recordToolCall: vi.fn(),
      recordPainEvent: vi.fn(),
    },
    principleTreeLedger: {
      updatePrincipleValueMetrics: mockUpdatePrincipleValueMetrics,
    },
    evolutionReducer: {
      emitSync: mockEmitSync,
      recordProbationFeedback: mockRecordProbationFeedback,
      getPrincipleById: vi.fn().mockImplementation((id: string) => id === 'p-match' ? ({ contextTags: ['write'], trigger: 'write' }) : ({ contextTags: ['bash'], trigger: 'bash' })),
    },
    resolve: vi.fn().mockImplementation((key) => {
        if (key === 'PROFILE') return path.join(workspaceDir, '.principles', 'PROFILE.json');
        return '';
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitSync.mockReset();
    mockRecordProbationFeedback.mockReset();
    mockUpdatePrincipleValueMetrics.mockReset();
    vi.spyOn(WorkspaceContext, 'fromHookContextExplicit').mockReturnValue(mockWctx as any);
    vi.spyOn(EventLogService, 'get').mockReturnValue(mockEventLog as any);
    clearSession('s-success');
    clearSession('s-low-value-failure');
    clearSession('s-repeated-failure');
    resetTriggerCooldownForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should ignore non-write tools', () => {
    const mockCtx = { workspaceDir, sessionId: 's1' };
    const mockEvent = { toolName: 'read', params: {}, result: { exitCode: 0 }, error: undefined };
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    
    // Should still create context
    expect(WorkspaceContext.fromHookContextExplicit).toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(mockEmitSync).not.toHaveBeenCalled();
  });

  it('skips processing when no valid workspace can be resolved', () => {
    const mockCtx = { workspaceDir: undefined, agentId: 'main', sessionId: 's-invalid' };
    const mockEvent = { toolName: 'write', params: {}, result: { exitCode: 0 }, error: undefined };
    const mockApi = {
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: vi.fn().mockReturnValue(os.homedir()),
        },
      },
      config: {},
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };

    handleAfterToolCall(mockEvent as any, mockCtx as any, mockApi as any);

    expect(WorkspaceContext.fromHookContextExplicit).not.toHaveBeenCalled();
    expect(mockEmitSync).not.toHaveBeenCalled();
  });

  it('records ordinary write failures as friction only without Runtime V2 diagnosis', () => {
    const mockCtx = { workspaceDir, sessionId: 's-low-value-failure', api: { logger: {} } };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/main.ts' },
        error: 'Permission denied',
        result: { exitCode: 1 } 
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockEventLog.recordPainSignal).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordPainEvent).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-low-value-failure',
      toolName: 'write',
      outcome: 'failure',
    }));
  });

  it('emits Runtime V2 diagnosis after repeated same write failures', () => {
    const mockCtx = { workspaceDir, sessionId: 's-repeated-failure', api: { logger: {} } };
    const mockEvent = {
        toolName: 'write',
        params: { file_path: 'src/main.ts' },
        error: 'Permission denied',
        result: { exitCode: 1 }
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    // PRI-363: trigger controller requires consecutiveErrors >= 4 for upgrade
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(mockEmitSync).not.toHaveBeenCalled();

    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(mockEmitSync).not.toHaveBeenCalled();

    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(mockEmitSync).not.toHaveBeenCalled();

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pain_detected',
      data: expect.objectContaining({
        painType: 'tool_failure',
        source: 'write',
      }),
    }));
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-repeated-failure',
      toolName: 'write',
      outcome: 'failure',
    }));
  });


  it('should only attribute success feedback to matching probation principles', () => {
    const mockCtx = { workspaceDir, sessionId: 's-success', api: { logger: {} } };
    const mockEvent = {
      toolName: 'write',
      params: { file_path: 'src/main.ts' },
      result: { exitCode: 0 },
      error: undefined,
    };

    setInjectedProbationIds('s-success', ['p-match', 'p-other'], workspaceDir);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockRecordProbationFeedback).toHaveBeenCalledWith('p-match', true);
    expect(mockRecordProbationFeedback).not.toHaveBeenCalledWith('p-other', true);
  });

  it('should emit evolution pain event for manual pain command', () => {
    const mockCtx = { workspaceDir, sessionId: 's2', api: { logger: {} } };
    const mockEvent = {
      toolName: 'pain',
      params: { input: 'Need help' },
      result: { exitCode: 0 },
      error: undefined,
    };

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pain_detected',
      data: expect.objectContaining({
        painType: 'user_frustration',
        source: 'pain',
      }),
    }));
  });

  it('should persist matched principle valueMetrics through the locked ledger owner without raw training-state writes', () => {
    const mockCtx = { workspaceDir, sessionId: 's-metrics', api: { logger: {} } };
    const mockEvent = {
      toolName: 'write',
      params: { file_path: 'src/main.ts' },
      error: 'Delete failed for src/main.ts',
      result: { exitCode: 1 },
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(true);
    vi.mocked(ioUtils.serializeKvLines).mockReturnValue('mocked-pain-flag-content');
    vi.mocked(fs.existsSync).mockImplementation((filePath: fs.PathLike) => {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      return normalizedPath.includes('.principles/PROFILE.json');
    });

    mockWctx.evolutionReducer.getActivePrinciples = vi.fn().mockReturnValue([
      {
        id: 'p-match',
        trigger: 'delete src main',
        valueMetrics: undefined,
      },
    ]);
    mockWctx.evolutionReducer.getPrincipleById = vi.fn().mockReturnValue({
      id: 'p-match',
      trigger: 'delete src main',
      contextTags: ['write'],
    });

    // PRI-363: risky high-score write triggers admission via trigger controller
    // (isRisky=true + score >= 70 → risky_high_score upgrade → admit)
    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockUpdatePrincipleValueMetrics).toHaveBeenCalledWith(
      'p-match',
      expect.objectContaining({
        painPreventedCount: 1,
      }),
    );

    const trainingStateWrites = vi
      .mocked(fs.writeFileSync)
      .mock.calls
      .filter(([targetPath]) => String(targetPath).includes('principle_training_state.json'));

    expect(trainingStateWrites).toEqual([]);
  });

  it('should detect failure from nested details.exitCode (exec tool pattern)', () => {
    const mockCtx = { workspaceDir, sessionId: 's-exec-failure', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'npm test' },
      result: { details: { exitCode: 1 } },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-exec-failure',
      toolName: 'bash',
      outcome: 'failure',
    }));
  });

  it('should prefer result.exitCode over nested details.exitCode when both exist', () => {
    const mockCtx = { workspaceDir, sessionId: 's-exec-success', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'npm test' },
      result: { exitCode: 0, details: { exitCode: 1 } },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-exec-success',
      toolName: 'bash',
      outcome: 'success',
    }));
  });

  it('should treat undefined exitCode as success', () => {
    const mockCtx = { workspaceDir, sessionId: 's-no-exitcode', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'echo hello' },
      result: { output: 'hello' },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-no-exitcode',
      toolName: 'bash',
      outcome: 'success',
    }));
  });

  it('should treat exitCode 0 as success even when details.exitCode is non-zero', () => {
    const mockCtx = { workspaceDir, sessionId: 's-partial-success', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'npm test' },
      result: { exitCode: 0, details: { stderr: 'some warnings', exitCode: 2 } },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-partial-success',
      toolName: 'bash',
      outcome: 'success',
    }));
  });

  it('should treat string exitCode as 0 (not a failure)', () => {
    const mockCtx = { workspaceDir, sessionId: 's-string-exitcode', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'npm test' },
      result: { exitCode: '0' },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-string-exitcode',
      toolName: 'bash',
      outcome: 'success',
    }));
  });

  it('should treat non-numeric details.exitCode as 0 (not a failure)', () => {
    const mockCtx = { workspaceDir, sessionId: 's-non-numeric-details', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'npm test' },
      result: { details: { exitCode: '1' } },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).not.toHaveBeenCalled();
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-non-numeric-details',
      toolName: 'bash',
      outcome: 'success',
    }));
  });

  it('should fall back to numeric details.exitCode when top-level exitCode is non-numeric', () => {
    const mockCtx = { workspaceDir, sessionId: 's-fallback-numeric', api: { logger: {} } };
    const mockEvent = {
      toolName: 'bash',
      params: { arguments: 'npm test' },
      result: { exitCode: '0', details: { exitCode: 1 } },
      error: undefined,
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('package.json');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-fallback-numeric',
      toolName: 'bash',
      outcome: 'failure',
    }));
  });

  it('PEAT-B1: triage evidence_only returns early before TriggerController (no cooldown pollution)', () => {
    // Enable the evidence triage feature flag
    vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'test' });

    const mockCtx = { workspaceDir, sessionId: 's-triage-evidence', api: { logger: {} } };
    const mockEvent = {
      toolName: 'write',
      params: { file_path: 'src/main.ts' },
      error: 'Permission denied',
      result: { exitCode: 1 },
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(fs.existsSync).mockReturnValue(false);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    // Core assertion: pain_detected event is NOT emitted — gate was not reached
    expect(mockEmitSync).not.toHaveBeenCalled();
    // Core assertion: recordPainSignal is NOT called — triage prevented gate evaluation
    expect(mockEventLog.recordPainSignal).not.toHaveBeenCalled();
    // Core assertion: trajectory pain event is NOT recorded — cooldown not polluted
    expect(mockWctx.trajectory.recordPainEvent).not.toHaveBeenCalled();
    // But tool call IS still tracked (friction tracking, not diagnosis)
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's-triage-evidence',
      toolName: 'write',
      outcome: 'failure',
    }));
  });

  it('PEAT-B1: triage admit proceeds to TriggerController and cooldown', () => {
    // For owner_reported source kinds, triage admits, so gate IS reached
    vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'test' });

    const mockCtx = { workspaceDir, sessionId: 's-triage-admit', api: { logger: {} } };
    // Manual pain command — triggers the manual pain path
    const mockEvent = {
      toolName: 'pain',
      params: { input: 'test pain' },
      result: { exitCode: 0 },
      error: undefined,
    };

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    // Core assertion: pain_detected event IS emitted — gate WAS reached
    expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pain_detected',
    }));
    // Core assertion: recordPainSignal IS called
    expect(mockEventLog.recordPainSignal).toHaveBeenCalledWith(
      's-triage-admit',
      expect.objectContaining({ score: 100, source: 'manual' }),
    );
  });

});

// ── PRI-326: Decomposed Pipeline Tests ────────────────────────────────────────

import {
  classifyToolCallOutcome,
  buildToolCallObservation,
  handleProbationFeedback,
  evaluatePainAdmissionForToolCall,
} from '../../src/hooks/after-tool-call-helpers.js';
import type { ToolCallOutcome, ToolCallObservation } from '../../src/hooks/after-tool-call-types.js';

describe('PRI-326: classifyToolCallOutcome', () => {
  it('returns success for exitCode 0 with no error', () => {
    const result = classifyToolCallOutcome({
      toolName: 'read',
      params: {},
      result: { exitCode: 0 },
      error: undefined,
    } as any);
    expect(result.isFailure).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.failureSource).toBeUndefined();
  });

  it('detects failure from top-level exitCode', () => {
    const result = classifyToolCallOutcome({
      toolName: 'bash',
      params: {},
      result: { exitCode: 1 },
      error: undefined,
    } as any);
    expect(result.isFailure).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.failureSource).toBe('tool_failure');
  });

  it('falls back to nested details.exitCode', () => {
    const result = classifyToolCallOutcome({
      toolName: 'bash',
      params: {},
      result: { details: { exitCode: 2 } },
      error: undefined,
    } as any);
    expect(result.isFailure).toBe(true);
    expect(result.exitCode).toBe(2);
  });

  it('prefers top-level exitCode over nested', () => {
    const result = classifyToolCallOutcome({
      toolName: 'bash',
      params: {},
      result: { exitCode: 0, details: { exitCode: 1 } },
      error: undefined,
    } as any);
    expect(result.isFailure).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('detects failure from error field even with exitCode 0', () => {
    const result = classifyToolCallOutcome({
      toolName: 'write',
      params: {},
      result: { exitCode: 0 },
      error: 'Permission denied',
    } as any);
    expect(result.isFailure).toBe(true);
    expect(result.failureSource).toBe('tool_failure');
  });

  it('classifies dispatch_error for tool not found', () => {
    const result = classifyToolCallOutcome({
      toolName: 'read',
      params: {},
      result: { exitCode: 1 },
      error: 'tool read_file not found',
    } as any);
    expect(result.isFailure).toBe(true);
    expect(result.failureSource).toBe('dispatch_error');
  });

  it('treats non-numeric exitCode as 0', () => {
    const result = classifyToolCallOutcome({
      toolName: 'bash',
      params: {},
      result: { exitCode: '0' as any },
      error: undefined,
    } as any);
    expect(result.isFailure).toBe(false);
  });
});

describe('PRI-326: evaluatePainAdmissionForToolCall', () => {
  const workspaceDir = '/mock/workspace';
  const mockConfig = { get: vi.fn().mockReturnValue(undefined) };
  const baseOutcome: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };
  const baseObservation: ToolCallObservation = {
    params: { filePath: 'src/main.ts' },
    relPath: 'src/main.ts',
    isRisk: false,
    errorType: 'Other',
    errorHash: 'abc123',
    errorText: 'Permission denied',
    painScore: 10,
    traceId: 'trace-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetTriggerCooldownForTest();
    vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: false, source: 'test' });
  });

  it('returns not_applicable for non-write tool', () => {
    const result = evaluatePainAdmissionForToolCall(
      { toolName: 'read' } as any, baseObservation, baseOutcome, undefined, undefined, 's1', workspaceDir, mockConfig
    );
    expect(result.stage).toBe('not_applicable');
    expect(result.admitted).toBe(false);
  });

  it('returns not_applicable for success', () => {
    const successOutcome: ToolCallOutcome = { isFailure: false, exitCode: 0, failureSource: undefined };
    const result = evaluatePainAdmissionForToolCall(
      { toolName: 'write' } as any, baseObservation, successOutcome, undefined, undefined, 's1', workspaceDir, mockConfig
    );
    expect(result.stage).toBe('not_applicable');
  });

  it('returns trigger_rejected when tool_failure triage rejects', () => {
    vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'test' });

    const result = evaluatePainAdmissionForToolCall(
      { toolName: 'write' } as any, baseObservation, baseOutcome, undefined, undefined, 's1', workspaceDir, mockConfig
    );
    expect(result.stage).toBe('trigger_rejected');
    expect(result.admitted).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('returns trigger_admitted when consecutive errors exceed repeatedFailure threshold', () => {
    vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: false, source: 'test' });
    // consecutiveErrors=5 >= default repeatedFailure threshold of 4 → trigger admits via repeated_failure
    const highConsecutiveState = { currentGfi: 0, consecutiveErrors: 5, lastErrorHash: 'abc123' } as any;

    const result = evaluatePainAdmissionForToolCall(
      { toolName: 'write' } as any, baseObservation, baseOutcome, highConsecutiveState, undefined, 's-gate-admitted-test', workspaceDir, mockConfig
    );
    expect(result.stage).toBe('trigger_admitted');
    expect(result.admitted).toBe(true);
  });

  it('includes reason and detail in every decision', () => {
    const result = evaluatePainAdmissionForToolCall(
      { toolName: 'read' } as any, baseObservation, baseOutcome, undefined, undefined, 's1', workspaceDir, mockConfig
    );
    expect(result.reason).toBeTruthy();
    expect(result.detail).toBeTruthy();
  });
});

describe('PRI-326: buildToolCallObservation params defense', () => {
  const profile = { risk_paths: [] } as any;

  it('handles null params without crashing', () => {
    const outcome: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };
    const result = buildToolCallObservation(
      { params: null, error: 'fail', result: {} } as any,
      outcome, '/workspace', profile
    );
    expect(result.relPath).toBe('unknown');
    expect(result.params.filePath).toBeUndefined();
  });

  it('handles undefined params without crashing', () => {
    const outcome: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };
    const result = buildToolCallObservation(
      { params: undefined, error: 'fail', result: {} } as any,
      outcome, '/workspace', profile
    );
    expect(result.relPath).toBe('unknown');
  });

  it('handles array params without crashing', () => {
    const outcome: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };
    const result = buildToolCallObservation(
      { params: ['bad'], error: 'fail', result: {} } as any,
      outcome, '/workspace', profile
    );
    expect(result.relPath).toBe('unknown');
  });

  it('handles string params without crashing', () => {
    const outcome: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };
    const result = buildToolCallObservation(
      { params: 'not-an-object', error: 'fail', result: {} } as any,
      outcome, '/workspace', profile
    );
    expect(result.relPath).toBe('unknown');
  });
});

describe('PRI-326: buildToolCallObservation unserializable result defense', () => {
  const profile = { risk_paths: [] } as any;
  const outcome: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };

  it('handles BigInt result without crashing', () => {
    const result = buildToolCallObservation(
      { params: {}, error: undefined, result: { val: BigInt(42) } } as any,
      outcome, '/workspace', profile
    );
    expect(result.errorText).toContain('unserializable result');
  });

  it('handles circular reference result without crashing', () => {
    const circular: any = { name: 'loop' };
    circular.self = circular;
    const result = buildToolCallObservation(
      { params: {}, error: undefined, result: circular } as any,
      outcome, '/workspace', profile
    );
    expect(result.errorText).toContain('unserializable result');
  });
});
