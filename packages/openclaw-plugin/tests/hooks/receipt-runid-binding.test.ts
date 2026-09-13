import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  handleFrictionTrackingForFailure,
  handleFrictionTrackingForSuccess,
  resetTriggerCooldownForTest,
} from '../../src/hooks/after-tool-call-helpers.js';
import { clearSession } from '../../src/core/session-tracker.js';
import type { ToolCallOutcome, ToolCallObservation } from '../../src/hooks/after-tool-call-types.js';

const outcomeFailure: ToolCallOutcome = { isFailure: true, exitCode: 1, failureSource: 'tool_failure' };
const outcomeSuccess: ToolCallOutcome = { isFailure: false, exitCode: 0, failureSource: undefined };
const observation: ToolCallObservation = {
  params: { filePath: 'x.txt' },
  relPath: 'x.txt',
  isRisk: false,
  errorType: 'Other',
  errorHash: 'hash-1',
  errorText: 'boom',
  painScore: 0,
  traceId: 'trace-1',
};

describe('PRI-750 receipt chain runId/toolCallId binding (OpenClaw after_tool_call)', () => {
  let workspaceDir: string;
  let mockEventLog: { recordToolCall: ReturnType<typeof vi.fn> };
  let mockWctx: Record<string, unknown>;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri750-rb-'));
    mockEventLog = { recordToolCall: vi.fn(), recordPainSignal: vi.fn() };
    mockWctx = {
      workspaceDir,
      config: { get: vi.fn().mockReturnValue(30) },
      eventLog: mockEventLog,
      trajectory: { recordToolCall: vi.fn(), recordPainEvent: vi.fn() },
    };
    clearSession('s-runid');
    resetTriggerCooldownForTest();
  });

  it('failure path writes runId + toolCallId into the tool event when the host supplies them', () => {
    const event = {
      toolName: 'edit',
      params: { file_path: 'x.txt' },
      result: { exitCode: 1 },
      error: 'boom',
      runId: 'run-abc',
      toolCallId: 'call-123',
    };
    handleFrictionTrackingForFailure('s-runid', event as never, outcomeFailure, observation, 0, workspaceDir, mockWctx.config as never, mockWctx as never, { recordTrajectory: false });
    expect(mockEventLog.recordToolCall).toHaveBeenCalledWith(
      's-runid',
      expect.objectContaining({ toolName: 'edit', runId: 'run-abc', toolCallId: 'call-123' }),
    );
  });

  it('success path writes runId + toolCallId into the tool event when the host supplies them', () => {
    const event = { toolName: 'read', params: {}, result: { exitCode: 0 }, runId: 'run-abc', toolCallId: 'call-123' };
    handleFrictionTrackingForSuccess('s-runid', event as never, outcomeSuccess, observation, 0, workspaceDir, mockWctx as never, { recordTrajectory: false });
    expect(mockEventLog.recordToolCall).toHaveBeenCalledWith(
      's-runid',
      expect.objectContaining({ toolName: 'read', runId: 'run-abc', toolCallId: 'call-123' }),
    );
  });

  it('stays compatible when the host supplies no runId/toolCallId', () => {
    const event = { toolName: 'edit', params: { file_path: 'x.txt' }, result: { exitCode: 1 }, error: 'boom' };
    handleFrictionTrackingForFailure('s-runid', event as never, outcomeFailure, observation, 0, workspaceDir, mockWctx.config as never, mockWctx as never, { recordTrajectory: false });
    expect(mockEventLog.recordToolCall).toHaveBeenCalledWith('s-runid', expect.objectContaining({ toolName: 'edit' }));
    const data = mockEventLog.recordToolCall.mock.calls[0][1] as Record<string, unknown>;
    expect(data.runId).toBeUndefined();
    expect(data.toolCallId).toBeUndefined();
  });
});
