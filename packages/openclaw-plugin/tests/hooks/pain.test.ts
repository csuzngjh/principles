import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAfterToolCall, classifyToolFailureSource } from '../../src/hooks/pain.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ioUtils from '../../src/utils/io.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { setInjectedProbationIds, clearSession } from '../../src/core/session-tracker.js';
import { resetPainDiagnosticGateForTest } from '../../src/core/pain-diagnostic-gate.js';

vi.mock('fs');
vi.mock('../../src/utils/io.js');
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

describe('classifyToolFailureSource', () => {
  it('empty toolName -> dispatch_error', () => {
    expect(classifyToolFailureSource(undefined, 'tool not found')).toBe('dispatch_error');
    expect(classifyToolFailureSource('', 'tool not found')).toBe('dispatch_error');
  });

  it('"Tool not found" (case insensitive) -> dispatch_error', () => {
    expect(classifyToolFailureSource('read', 'error: tool not found')).toBe('dispatch_error');
    expect(classifyToolFailureSource('read', 'Tool Not Found')).toBe('dispatch_error');
    // "tool <name> not found" also matches (e.g. "tool read_file not found")
    expect(classifyToolFailureSource('read', 'Tool read_file not found')).toBe('dispatch_error');
  });

  it('"Unknown tool" (case insensitive) -> dispatch_error', () => {
    expect(classifyToolFailureSource('read', 'error: unknown tool')).toBe('dispatch_error');
    expect(classifyToolFailureSource('read', 'Unknown Tool')).toBe('dispatch_error');
    expect(classifyToolFailureSource('read', 'failed: unknown tool read_file')).toBe('dispatch_error');
  });

  it('Warning-style messages containing "tool not found" -> dispatch_error', () => {
    // After dropping "error:" prefix, Warning messages with "tool not found" match the dispatch pattern
    expect(classifyToolFailureSource('read', 'Warning: tool not found was suppressed')).toBe('dispatch_error');
    expect(classifyToolFailureSource('read', 'Warning: tool not found - already handled')).toBe('dispatch_error');
  });

  it('real execution errors (ENOENT, EACCES) -> tool_failure', () => {
    expect(classifyToolFailureSource('read', 'ENOENT: no such file or directory')).toBe('tool_failure');
    expect(classifyToolFailureSource('write', 'EACCES: permission denied')).toBe('tool_failure');
    expect(classifyToolFailureSource('edit', 'Error: EIO: I/O error')).toBe('tool_failure');
  });

  it('edge cases: null/undefined/empty error', () => {
    expect(classifyToolFailureSource('read', null)).toBe('tool_failure');
    expect(classifyToolFailureSource('read', undefined)).toBe('tool_failure');
    expect(classifyToolFailureSource('read', '')).toBe('tool_failure');
    expect(classifyToolFailureSource('read', 123)).toBe('tool_failure');
  });

  it('word-boundary: "report_tool_not_found" does NOT match dispatch pattern', () => {
    expect(classifyToolFailureSource('read', 'report_tool_not_found')).toBe('tool_failure');
  });

  it('word-boundary: "atoolnotfound" (no spaces) does NOT match dispatch pattern', () => {
    expect(classifyToolFailureSource('read', 'atoolnotfound')).toBe('tool_failure');
  });

  it('word-boundary: "unknown_tool" (underscore, no space) does NOT match dispatch pattern', () => {
    expect(classifyToolFailureSource('read', 'unknown_tool')).toBe('tool_failure');
  });

  it('whitespace-only toolName -> dispatch_error', () => {
    expect(classifyToolFailureSource('   ', 'tool not found')).toBe('dispatch_error');
  });

  it('numeric error value -> tool_failure', () => {
    expect(classifyToolFailureSource('read', 42)).toBe('tool_failure');
  });

  it('object error value -> tool_failure', () => {
    expect(classifyToolFailureSource('read', { code: 'ENOENT' })).toBe('tool_failure');
  });

  it('"tool <name> not found" with multi-word tool name -> dispatch_error', () => {
    expect(classifyToolFailureSource('read', 'tool my_custom_tool not found')).toBe('dispatch_error');
  });

  it('partial match "not found" without "tool" prefix -> tool_failure', () => {
    expect(classifyToolFailureSource('read', 'file not found')).toBe('tool_failure');
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
    vi.spyOn(WorkspaceContext, 'fromHookContext').mockReturnValue(mockWctx as any);
    vi.spyOn(EventLogService, 'get').mockReturnValue(mockEventLog as any);
    clearSession('s-success');
    clearSession('s-low-value-failure');
    clearSession('s-repeated-failure');
    resetPainDiagnosticGateForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should ignore non-write tools', () => {
    const mockCtx = { workspaceDir, sessionId: 's1' };
    const mockEvent = { toolName: 'read', params: {}, result: { exitCode: 0 }, error: undefined };
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    
    // Should still create context
    expect(WorkspaceContext.fromHookContext).toHaveBeenCalled();
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

    expect(WorkspaceContext.fromHookContext).not.toHaveBeenCalled();
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

    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(mockEmitSync).not.toHaveBeenCalled();

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pain_detected',
      data: expect.objectContaining({
        painType: 'tool_failure',
        source: 'write',
        reason: expect.stringContaining('diagnosticGate=high_gfi'),
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

});
