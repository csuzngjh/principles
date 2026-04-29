import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAfterToolCall } from '../../src/hooks/pain.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ioUtils from '../../src/utils/io.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { EventLogService } from '../../src/core/event-log.js';
import { setInjectedProbationIds, clearSession } from '../../src/core/session-tracker.js';

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
    expect(mockApi.runtime.agent.resolveAgentWorkspaceDir).toHaveBeenCalledWith(mockApi.config, 'main');
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

});
