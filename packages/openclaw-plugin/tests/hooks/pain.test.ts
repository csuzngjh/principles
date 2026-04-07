import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAfterToolCall } from '../../src/hooks/pain';
import * as fs from 'fs';
import * as path from 'path';
import * as ioUtils from '../../src/utils/io';
import { WorkspaceContext } from '../../src/core/workspace-context';
import { EventLogService } from '../../src/core/event-log';
import { setInjectedProbationIds, clearSession } from '../../src/core/session-tracker';
import * as principleTreeLedger from '../../src/core/principle-tree-ledger';

vi.mock('fs');
vi.mock('../../src/utils/io.js');
vi.mock('../../src/core/workspace-context');
vi.mock('../../src/core/event-log');
vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  updatePrincipleValueMetrics: vi.fn(),
}));

const mockEmitSync = vi.fn();
const mockRecordProbationFeedback = vi.fn();

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
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    vi.mocked(EventLogService.get).mockReturnValue(mockEventLog as any);
    clearSession('s-success');
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

  it('should capture pain on tool error with correct source', () => {
    const mockCtx = { workspaceDir, sessionId: 's1', api: { logger: {} } };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/main.ts' },
        error: 'Permission denied',
        result: { exitCode: 1 } 
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    vi.mocked(ioUtils.serializeKvLines).mockReturnValue('mocked-pain-flag-content');

    vi.mocked(fs.existsSync).mockReturnValue(true);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(fs.writeFileSync).toHaveBeenCalled();
    const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(callArgs[0]).toContain('.pain_flag');

    expect(mockEmitSync).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pain_detected',
      data: expect.objectContaining({
        painType: 'tool_failure',
        source: 'write',
      }),
    }));
    expect(mockWctx.trajectory.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
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
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
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

    expect(principleTreeLedger.updatePrincipleValueMetrics).toHaveBeenCalledWith(
      '/mock/state',
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
