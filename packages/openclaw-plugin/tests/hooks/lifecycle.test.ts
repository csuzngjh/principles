import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleBeforeReset, handleBeforeCompaction, extractPainFromSessionFile } from '../../src/hooks/lifecycle';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';

vi.mock('fs');

describe('Lifecycle Hooks', () => {
  const workspaceDir = '/mock/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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
      expect(callArgs[0]).toContain('MEMORY.md');
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
      expect(callArgs[0]).toContain(path.join('memory'));
      expect(callArgs[1]).toContain('Pre-Compaction Checkpoint');
    });
  });

  describe('extractPainFromSessionFile', () => {
    const tempSessionFile = path.join(os.tmpdir(), 'test_session.jsonl');

    beforeEach(() => {
      // Create memory directories so our test can write to them without erroring
      const dailyLogDir = path.join(workspaceDir, 'memory');
      const painLogDir = path.join(dailyLogDir, 'pain');
      fs.mkdirSync(painLogDir, { recursive: true });
    });

    afterEach(() => {
      // Clean up the temp jsonl
      if (fs.existsSync(tempSessionFile)) fs.unlinkSync(tempSessionFile);
    });

    it('should extract FATAL INTERCEPT from openclawAbort', async () => {
      const loggerMock = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const jsonlContent = [
        JSON.stringify({ role: 'user', content: 'Do something' }),
        JSON.stringify({
          role: 'assistant',
          content: 'I will modify the file directly',
          openclawAbort: { aborted: true, origin: 'rpc', runId: 'test-run-123' }
        })
      ].join('\n') + '\n';

      // Temporarily mock fs.existsSync true strictly for our file, and unmock createReadStream
      vi.mocked(fs.existsSync).mockImplementation((p: any) => p === tempSessionFile || String(p).includes('memory'));
      vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        // We use actual fs for reading our temp file which we write actually unmocked below
        return Readable.from([jsonlContent]) as any;
      });

      await extractPainFromSessionFile(tempSessionFile, { workspaceDir, logger: loggerMock });

      expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('Detected hard-abort snapshot (runId: test-run-123)'));
      expect(fs.appendFileSync).toHaveBeenCalled();

      // Check that what was appended to MEMORY contains FATAL INTERCEPT
      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      const memoryWrite = calls.find((call: any) => String(call[0]).endsWith('.md') && !String(call[0]).includes('confusion_samples'));
      expect(memoryWrite).toBeDefined();
      expect(memoryWrite![1]).toContain('[FATAL INTERCEPT]');
      expect(memoryWrite![1]).toContain('I will modify the file directly');
    });

    it('should extract COGNITIVE OVERLOAD from oversized placeholder', async () => {
      const loggerMock = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const jsonlContent = [
        JSON.stringify({
          role: 'assistant',
          content: 'Reading massive file',
          __openclaw: { truncated: true, reason: 'oversized' }
        })
      ].join('\n') + '\n';

      vi.mocked(fs.existsSync).mockImplementation((p: any) => p === tempSessionFile || String(p).includes('memory'));
      vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        return Readable.from([jsonlContent]) as any;
      });

      await extractPainFromSessionFile(tempSessionFile, { workspaceDir, logger: loggerMock });

      expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('Detected oversized data truncation placeholder'));

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      const memoryWrite = calls.find((call: any) => String(call[0]).endsWith('.md') && !String(call[0]).includes('confusion_samples'));
      expect(memoryWrite).toBeDefined();
      expect(memoryWrite![1]).toContain('[COGNITIVE OVERLOAD]');
    });

    it('should fallback to semantic guessing for i am sorry', async () => {
      const loggerMock = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const jsonlContent = [
        JSON.stringify({
          role: 'assistant',
          content: 'I\'m sorry, but I\'m still getting an error.'
        })
      ].join('\n') + '\n';

      vi.mocked(fs.existsSync).mockImplementation((p: any) => p === tempSessionFile || String(p).includes('memory'));
      vi.spyOn(fs, 'createReadStream').mockImplementation((...args: any[]) => {
        return Readable.from([jsonlContent]) as any;
      });

      await extractPainFromSessionFile(tempSessionFile, { workspaceDir, logger: loggerMock });

      expect(loggerMock.debug).toHaveBeenCalledWith(expect.stringContaining('Detected semantic confusion string'));

      const calls = vi.mocked(fs.appendFileSync).mock.calls;
      const memoryWrite = calls.find((call: any) => String(call[0]).endsWith('.md') && !String(call[0]).includes('confusion_samples'));
      expect(memoryWrite).toBeDefined();
      expect(memoryWrite![1]).toContain('I\'m sorry, but I\'m still getting');
    });
  });
});