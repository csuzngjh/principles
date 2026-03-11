import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAfterToolCall } from '../../src/hooks/pain';
import * as fs from 'fs';
import * as path from 'path';
import * as ioUtils from '../../src/utils/io';
import { WorkspaceContext } from '../../src/core/workspace-context';
import { EventLogService } from '../../src/core/event-log';

vi.mock('fs');
vi.mock('../../src/utils/io.js');
vi.mock('../../src/core/workspace-context');
vi.mock('../../src/core/event-log');

describe('Post-Write Checks & Pain Hook', () => {
  const workspaceDir = '/mock/workspace';
  const mockEventLog = {
    recordToolCall: vi.fn(),
    recordPainSignal: vi.fn(),
    recordTrustChange: vi.fn(),
  };
  const mockTrust = {
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  };
  const mockConfig = {
    get: vi.fn().mockReturnValue(30),
  };

  const mockWctx = {
    workspaceDir,
    stateDir: '/mock/state',
    config: mockConfig,
    eventLog: mockEventLog,
    trust: mockTrust,
    resolve: vi.fn().mockImplementation((key) => {
        if (key === 'PROFILE') return path.join(workspaceDir, '.principles', 'PROFILE.json');
        return '';
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue(mockWctx as any);
    vi.mocked(EventLogService.get).mockReturnValue(mockEventLog as any);
  });

  it('should ignore non-write tools', () => {
    const mockCtx = { workspaceDir, sessionId: 's1' };
    const mockEvent = { toolName: 'read', params: {}, result: { exitCode: 0 }, error: undefined };
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    
    // Should still create context
    expect(WorkspaceContext.fromHookContext).toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(mockTrust.recordFailure).not.toHaveBeenCalled();
  });

  it('should capture pain on tool error with correct source and record failure', () => {
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

    // Verify recordFailure call through context
    expect(mockTrust.recordFailure).toHaveBeenCalledWith(
        'tool',
        expect.objectContaining({ sessionId: 's1' })
    );
  });
});
