import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_AGENTS_DIR = path.join(os.tmpdir(), 'pd-test-agents-' + Date.now());

// Set env before module load
process.env.PD_TEST_AGENTS_DIR = TEST_AGENTS_DIR;

describe('Pain Context Extractor', () => {
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_AGENTS_DIR)) {
      fs.rmSync(TEST_AGENTS_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, 'main', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, 'builder', 'sessions'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_AGENTS_DIR)) {
      fs.rmSync(TEST_AGENTS_DIR, { recursive: true, force: true });
    }
  });

  function createSessionFile(
    sessionId: string,
    lines: string[],
    agentId: string = 'main',
  ): string {
    const dir = path.join(TEST_AGENTS_DIR, agentId, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return filePath;
  }

  function makeMessage(
    role: string,
    textParts: string[] = [],
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      type: 'message',
      message: {
        role,
        content: textParts.map((t) => ({ type: 'text', text: t })),
        ...extra,
      },
    });
  }

  function makeToolCallMessage(
    toolCalls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  ): string {
    return JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: toolCalls.map((tc) => ({
          type: 'toolCall',
          id: tc.id || 'tc1',
          name: tc.name || 'read_file',
          arguments: tc.arguments || {},
        })),
      },
    });
  }

  function makeToolResult(
    toolName: string,
    toolCallId: string,
    textParts: string[] = [],
    details: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolName,
        toolCallId,
        content: textParts.map((t) => ({ type: 'text', text: t })),
        details,
      },
    });
  }

  describe('extractRecentConversation', () => {
    it('returns empty string for non-existent session', async () => {
      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('nonexistent', 'main');
      expect(result).toBe('');
    });

    it('returns empty string for short session ID', async () => {
      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('ab', 'main');
      expect(result).toBe('');
    });

    it('rejects path traversal session IDs', async () => {
      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result1 = await extractRecentConversation('../../etc/passwd', 'main');
      expect(result1).toBe('');
      const result2 = await extractRecentConversation('sess/../../../etc/shadow', 'main');
      expect(result2).toBe('');
    });

    it('rejects path traversal agent IDs', async () => {
      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('sess1', '../../etc');
      expect(result).toBe('');
    });

    it('extracts user and assistant messages', async () => {
      createSessionFile('sess1', [
        makeMessage('user', ['Hello, please help me']),
        makeMessage('assistant', ['Sure, I can help with that']),
        makeMessage('user', ['Fix the bug in auth.ts']),
        makeMessage('assistant', ['I found the issue and fixed it']),
      ], 'main');

      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('sess1', 'main');

      expect(result).toContain('[User]');
      expect(result).toContain('[Assistant]');
    });

    it('skips system prompt injection patterns', async () => {
      createSessionFile('sess3', [
        makeMessage('user', ['<evolution_task><pain_score>50</pain_score>']),
        makeMessage('user', ['Real user input: fix the login bug']),
      ], 'main');

      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('sess3', 'main');

      expect(result).not.toContain('<evolution_task>');
      expect(result).toContain('Real user input');
    });

    it('handles empty file gracefully', async () => {
      const emptyPath = path.join(TEST_AGENTS_DIR, 'main', 'sessions', 'sess-empty.jsonl');
      fs.writeFileSync(emptyPath, '');

      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('sess-empty', 'main');
      expect(result).toBe('');
    });

    it('skips oversized lines (>100KB)', async () => {
      const bigLine = makeMessage('user', ['x'.repeat(150_000)]);
      createSessionFile('sess-big', [
        bigLine,
        makeMessage('user', ['Normal input']),
      ], 'main');

      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('sess-big', 'main');

      expect(result).toContain('Normal input');
    });

    it('uses custom agent ID', async () => {
      createSessionFile('sess-builder', [
        makeMessage('user', ['Builder task']),
      ], 'builder');

      const { extractRecentConversation } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractRecentConversation('sess-builder', 'builder');
      expect(result).toContain('Builder task');
    });
  });

  describe('extractFailedToolContext', () => {
    it('returns empty string for non-existent session', async () => {
      const { extractFailedToolContext } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractFailedToolContext('nonexistent', 'main', 'read_file');
      expect(result).toBe('');
    });

    it('returns empty string for missing toolName', async () => {
      const { extractFailedToolContext } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractFailedToolContext('sess1', 'main', '');
      expect(result).toBe('');
    });

    it('extracts failed tool call with correlation', async () => {
      createSessionFile('sess-fail', [
        makeMessage('user', ['system init']),  // safeTail strips first line for small files
        makeToolCallMessage([{
          id: 'tc-fail',
          name: 'read_file',
          arguments: { file_path: '/etc/passwd' },
        }]),
        makeToolResult('read_file', 'tc-fail', ['Permission denied'], {
          exitCode: 1,
          isError: true,
        }),
      ], 'main');

      const { extractFailedToolContext } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractFailedToolContext('sess-fail', 'main', 'read_file');

      expect(result).toContain('Tool Call: read_file');
      expect(result).toContain('Exit Code: 1');
    });

    it('ignores successful tool results', async () => {
      createSessionFile('sess-ok', [
        makeMessage('user', ['system init']),
        makeToolCallMessage([{ id: 'tc-ok', name: 'read_file' }]),
        makeToolResult('read_file', 'tc-ok', ['File contents'], {
          exitCode: 0,
          isError: false,
        }),
      ], 'main');

      const { extractFailedToolContext } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      const result = await extractFailedToolContext('sess-ok', 'main', 'read_file');

      expect(result).toBe('');
    });

    it('filters by file path when provided', async () => {
      createSessionFile('sess-filter', [
        makeMessage('user', ['system init']),
        makeToolCallMessage([{
          id: 'tc1',
          name: 'edit',
          arguments: { file_path: '/src/auth.ts' },
        }]),
        makeToolResult('edit', 'tc1', ['ENOENT'], { exitCode: 1, isError: true }),
      ], 'main');

      const { extractFailedToolContext } = await import(
        '../../src/core/pain-context-extractor.js'
      );
      // With matching file path, should return result
      const result = await extractFailedToolContext(
        'sess-filter',
        'main',
        'edit',
        '/src/auth.ts',
      );

      expect(result).toContain('Tool Call: edit');
      expect(result).toContain('Exit Code: 1');
    });
  });
});
