import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseJsonlMessages,
  extractRecentConversation,
  extractFailedToolContext,
} from '../../src/core/pain-context-extractor.js';

describe('Pain Context Extractor', () => {
  let testDir: string;
  let agentsDir: string;
  let sessionsDir: string;

  const SAMPLE_SESSION_ID = 'test-session-123';
  const SAMPLE_AGENT_ID = 'main';

  // Sample JSONL content
  const SAMPLE_JSONL = [
    JSON.stringify({ type: 'session', version: 3, id: SAMPLE_SESSION_ID }),
    JSON.stringify({ type: 'model_change', provider: 'test', modelId: 'test-model' }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '请帮我写一个排序函数' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '用户需要一个排序函数...' },
          { type: 'text', text: '好的，我来写一个快速排序函数。' },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '这个实现有问题，边界情况没处理' }],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_1', name: 'write', arguments: { file_path: 'src/sort.ts' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'write',
        content: [{ type: 'text', text: 'Error: Permission denied' }],
        details: { exitCode: 1, durationMs: 100, isError: true },
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '抱歉，写入失败了。让我重试。' }],
      },
    }),
  ].join('\n');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ctx-test-'));
    agentsDir = path.join(testDir, 'agents');
    sessionsDir = path.join(agentsDir, SAMPLE_AGENT_ID, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Set environment variable to override AGENTS_DIR
    process.env.PD_TEST_AGENTS_DIR = agentsDir;
  });

  afterEach(() => {
    delete process.env.PD_TEST_AGENTS_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('parseJsonlMessages', () => {
    it('should parse valid JSONL file', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, SAMPLE_JSONL, 'utf8');

      const messages = await parseJsonlMessages(filePath);

      expect(messages.length).toBe(6); // Only message types
      expect(messages[0].message?.role).toBe('user');
      expect(messages[1].message?.role).toBe('assistant');
    });

    it('should return empty array for non-existent file', async () => {
      const messages = await parseJsonlMessages('/non/existent/file.jsonl');
      expect(messages).toEqual([]);
    });

    it('should skip malformed lines', async () => {
      const filePath = path.join(sessionsDir, 'malformed.jsonl');
      fs.writeFileSync(filePath, 'not json\n{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n', 'utf8');

      const messages = await parseJsonlMessages(filePath);
      expect(messages.length).toBe(1);
    });

    it('should skip non-message types', async () => {
      const filePath = path.join(sessionsDir, 'mixed.jsonl');
      const content = [
        JSON.stringify({ type: 'session', version: 3 }),
        JSON.stringify({ type: 'model_change', provider: 'test' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n');
      fs.writeFileSync(filePath, content, 'utf8');

      const messages = await parseJsonlMessages(filePath);
      expect(messages.length).toBe(1);
      expect(messages[0].message?.role).toBe('user');
    });
  });

  describe('extractRecentConversation', () => {
    beforeEach(() => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, SAMPLE_JSONL, 'utf8');
    });

    it('should return empty string for empty session_id', async () => {
      expect(await extractRecentConversation('', 'main')).toBe('');
    });

    it('should return empty string for non-existent file', async () => {
      expect(await extractRecentConversation('non-existent-session', 'main')).toBe('');
    });

    it('should extract recent conversation turns', async () => {
      const result = await extractRecentConversation(SAMPLE_SESSION_ID, SAMPLE_AGENT_ID, 5);

      expect(result).toContain('[User]:');
      expect(result).toContain('[Assistant]:');
      expect(result).toContain('边界情况没处理');
      expect(result).toContain('抱歉，写入失败了');
    });

    it('should include error tool results', async () => {
      const result = await extractRecentConversation(SAMPLE_SESSION_ID, SAMPLE_AGENT_ID, 5);

      expect(result).toContain('[Tool: write]');
      expect(result).toContain('FAILED');
      expect(result).toContain('Permission denied');
    });

    it('should limit output length', async () => {
      const result = await extractRecentConversation(SAMPLE_SESSION_ID, SAMPLE_AGENT_ID, 100);
      expect(result.length).toBeLessThanOrEqual(2000);
    });

    it('should skip thinking content', async () => {
      const result = await extractRecentConversation(SAMPLE_SESSION_ID, SAMPLE_AGENT_ID, 5);

      expect(result).not.toContain('用户需要一个排序函数');
      expect(result).toContain('好的，我来写一个快速排序函数');
    });
  });

  describe('extractFailedToolContext', () => {
    beforeEach(() => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, SAMPLE_JSONL, 'utf8');
    });

    it('should return empty string for empty parameters', async () => {
      expect(await extractFailedToolContext('', 'main', 'write')).toBe('');
    });

    it('should return empty string for non-existent file', async () => {
      expect(await extractFailedToolContext('non-existent', 'main', 'write')).toBe('');
    });

    it('should extract failed tool call context', async () => {
      const result = await extractFailedToolContext(SAMPLE_SESSION_ID, SAMPLE_AGENT_ID, 'write', 'src/sort.ts');

      expect(result).toContain('[Tool Call: write]');
      expect(result).toContain('file_path');
      expect(result).toContain('Permission denied');
    });

    it('should correlate tool call with result via toolCallId', async () => {
      const result = await extractFailedToolContext(SAMPLE_SESSION_ID, SAMPLE_AGENT_ID, 'write');

      // Should include both the call args and the error
      expect(result).toContain('src/sort.ts');
      expect(result).toContain('Exit Code: 1');
    });
  });
});
