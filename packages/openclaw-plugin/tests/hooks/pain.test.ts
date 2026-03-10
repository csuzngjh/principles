import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAfterToolCall } from '../../src/hooks/pain';
import * as fs from 'fs';
import * as path from 'path';
import * as ioUtils from '../../src/utils/io';
import * as trustEngine from '../../src/core/trust-engine';

vi.mock('fs');
vi.mock('../../src/utils/io');
vi.mock('../../src/core/trust-engine');

describe('Post-Write Checks & Pain Hook', () => {
  const workspaceDir = '/mock/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should ignore non-write tools', () => {
    const mockCtx = { workspaceDir, sessionId: 's1' };
    const mockEvent = { toolName: 'read', params: {}, result: { exitCode: 0 }, error: undefined };
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(trustEngine.adjustTrustScore).not.toHaveBeenCalled();
  });

  it('should capture pain on tool error with correct source and decrement trust', () => {
    const mockCtx = { workspaceDir, sessionId: 's1' };
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

    // Ensure the output was serialized with 'source: tool_failure'
    expect(ioUtils.serializeKvLines).toHaveBeenCalled();
    const serializeArgs = vi.mocked(ioUtils.serializeKvLines).mock.calls[0];
    expect(serializeArgs[0]).toHaveProperty('source', 'tool_failure');

    // Verify trust decrement
    expect(trustEngine.adjustTrustScore).toHaveBeenCalledWith(workspaceDir, -10);
  });
});
