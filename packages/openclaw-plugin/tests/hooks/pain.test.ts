import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAfterToolCall } from '../../src/hooks/pain';
import * as fs from 'fs';
import * as path from 'path';
import * as ioUtils from '../../src/utils/io';

vi.mock('fs');
vi.mock('../../src/utils/io');

describe('Post-Write Checks & Pain Hook', () => {
  const workspaceDir = '/mock/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should ignore non-write tools', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { toolName: 'read', params: {}, result: {}, error: undefined };
    handleAfterToolCall(mockEvent as any, mockCtx as any);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should capture pain on tool error', () => {
    const mockCtx = { workspaceDir };
    const mockEvent = { 
        toolName: 'write', 
        params: { file_path: 'src/main.ts' },
        error: 'Permission denied',
        result: { exitCode: 1 } 
    };

    vi.mocked(ioUtils.normalizePath).mockReturnValue('src/main.ts');
    vi.mocked(ioUtils.isRisky).mockReturnValue(false);
    
    vi.mocked(fs.existsSync).mockReturnValue(true);

    handleAfterToolCall(mockEvent as any, mockCtx as any);

    expect(fs.writeFileSync).toHaveBeenCalled();
    const callArgs = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(callArgs[0]).toContain('.pain_flag');
  });
});