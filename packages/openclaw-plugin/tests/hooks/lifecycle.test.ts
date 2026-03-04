import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleBeforeReset, handleBeforeCompaction } from '../../src/hooks/lifecycle';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');

describe('Lifecycle Hooks', () => {
  const workspaceDir = '/mock/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleBeforeReset', () => {
    it('should append summary to MEMORY.md if pain points exist', async () => {
      const mockEvent = {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'error: something went wrong' }
        ],
        reason: 'Manual reset'
      };

      await handleBeforeReset(mockEvent, { workspaceDir });

      expect(fs.appendFileSync).toHaveBeenCalled();
      const callArgs = vi.mocked(fs.appendFileSync).mock.calls[0];
      expect(callArgs[0]).toContain('docs/MEMORY.md');
      expect(callArgs[1]).toContain('Session Reset Summary');
      expect(callArgs[1]).toContain('1 potential pain point(s)');
    });

    it('should not write if no pain points are found', async () => {
      const mockEvent = {
        messages: [{ role: 'assistant', content: 'all good' }]
      };
      await handleBeforeReset(mockEvent, { workspaceDir });
      expect(fs.appendFileSync).not.toHaveBeenCalled();
    });
  });

  describe('handleBeforeCompaction', () => {
    it('should write checkpoint to CHECKPOINT.md', async () => {
      const mockEvent = { messageCount: 50 };
      await handleBeforeCompaction(mockEvent, { workspaceDir });
      expect(fs.appendFileSync).toHaveBeenCalled();
      const callArgs = vi.mocked(fs.appendFileSync).mock.calls[0];
      expect(callArgs[0]).toContain('docs/CHECKPOINT.md');
      expect(callArgs[1]).toContain('Pre-Compaction Checkpoint');
    });
  });
});