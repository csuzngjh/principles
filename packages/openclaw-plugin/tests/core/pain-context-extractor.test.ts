import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractRecentConversation,
  extractFailedToolContext,
} from '../../src/core/pain-context-extractor.js';

describe('Pain Context Extractor (real-data-based)', () => {
  let testDir: string;
  let agentsDir: string;
  let sessionsDir: string;

  const SAMPLE_SESSION_ID = 'test-session-123';

  // Real OpenClaw JSONL format — based on actual session files
  const SHORT_SESSION_JSONL = [
    JSON.stringify({ type: 'session', version: 3, id: SAMPLE_SESSION_ID, timestamp: '2026-04-06T00:00:00Z', cwd: '/test' }),
    JSON.stringify({ type: 'model_change', id: 'a', parentId: null, timestamp: '2026-04-06T00:00:01Z', provider: 'test', modelId: 'test' }),
    JSON.stringify({ type: 'thinking_level_change', id: 'b', parentId: 'a', timestamp: '2026-04-06T00:00:01Z', thinkingLevel: 'low' }),
    JSON.stringify({ type: 'custom', customType: 'model-snapshot', id: 'c', parentId: 'b', timestamp: '2026-04-06T00:00:01Z', data: {} }),
    // Simulated HEARTBEAT injection (11MB in real files, but we use smaller for tests)
    JSON.stringify({
      type: 'message',
      id: 'd', parentId: 'c', timestamp: '2026-04-06T00:00:02Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<evolution_task priority="critical">\nTASK: "Diagnose pain"\n</evolution_task>' }],
      },
    }),
    // Empty assistant (common in short sessions)
    JSON.stringify({
      type: 'message',
      id: 'e', parentId: 'd', timestamp: '2026-04-06T00:00:03Z',
      message: { role: 'assistant', content: [], api: 'test', provider: 'test', model: 'test', usage: {} },
    }),
  ].join('\n');

  // Multi-turn conversation — based on real 632-line session
  const MULTI_TURN_JSONL = [
    JSON.stringify({ type: 'session', version: 3, id: SAMPLE_SESSION_ID }),
    JSON.stringify({
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: '帮我修复这个 git 冲突' }] },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '需要检查冲突...' }, { type: 'toolCall', id: 'call_1', name: 'exec', arguments: { command: 'git status' } }],
        stopReason: 'toolUse',
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1', toolName: 'exec',
        content: [{ type: 'text', text: 'On branch main\nChanges not staged for commit:\n  modified:   src/foo.ts' }],
        details: { exitCode: 0, durationMs: 100 },
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_2', name: 'edit', arguments: { file_path: 'src/foo.ts' } }],
        stopReason: 'toolUse',
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_2', toolName: 'edit',
        content: [{ type: 'text', text: 'Error: Could not find exact text' }],
        details: { exitCode: 1, durationMs: 50, isError: true },
      },
    }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '编辑失败了，换个方式...' }, { type: 'text', text: '编辑失败，让我用 write_file 重写。' }],
        stopReason: 'stop',
      },
    }),
  ].join('\n');

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ctx-test-'));
    agentsDir = path.join(testDir, 'agents');
    sessionsDir = path.join(agentsDir, 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    process.env.PD_TEST_AGENTS_DIR = agentsDir;
  });

  afterEach(() => {
    delete process.env.PD_TEST_AGENTS_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('extractRecentConversation', () => {
    it('should handle short session (HEARTBEAT injection, no real conversation)', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, SHORT_SESSION_JSONL, 'utf8');

      const result = await extractRecentConversation(SAMPLE_SESSION_ID, 'main', 8);
      // Short session has no real conversation — user message is system injection, assistant is empty
      expect(result.length).toBeLessThanOrEqual(1500);
    });

    it('should extract multi-turn conversation with tool calls', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, MULTI_TURN_JSONL, 'utf8');

      const result = await extractRecentConversation(SAMPLE_SESSION_ID, 'main', 8);

      expect(result).toContain('[User]:');
      expect(result).toContain('[Assistant');
      expect(result).toContain('exec');
    });

    it('should include failed tool results', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, MULTI_TURN_JSONL, 'utf8');

      const result = await extractRecentConversation(SAMPLE_SESSION_ID, 'main', 8);

      expect(result).toContain('FAILED');
      expect(result).toContain('edit');
    });

    it('should return empty for non-existent session', async () => {
      const result = await extractRecentConversation('non-existent', 'main');
      expect(result).toBe('');
    });

    it('should return empty for empty session_id', async () => {
      const result = await extractRecentConversation('', 'main');
      expect(result).toBe('');
    });

    it('should cap output length', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, MULTI_TURN_JSONL, 'utf8');

      const result = await extractRecentConversation(SAMPLE_SESSION_ID, 'main', 100);
      expect(result.length).toBeLessThanOrEqual(1500);
    });

    it('should skip system injection patterns in user messages', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      const injectionOnly = [
        JSON.stringify({ type: 'session', version: 3, id: SAMPLE_SESSION_ID }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<evolution_task>\nTASK: "Diagnose"\n</evolution_task>\nYou are an empathy observer' }],
          },
        }),
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', content: [] },
        }),
      ].join('\n');
      fs.writeFileSync(filePath, injectionOnly, 'utf8');

      const result = await extractRecentConversation(SAMPLE_SESSION_ID, 'main', 5);
      // Should skip injection, return empty or very short
      expect(result.length).toBeLessThan(100);
    });
  });

  describe('extractFailedToolContext', () => {
    it('should extract failed tool call with arguments', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, MULTI_TURN_JSONL, 'utf8');

      const result = await extractFailedToolContext(SAMPLE_SESSION_ID, 'main', 'edit', 'src/foo.ts');

      expect(result).toContain('[Tool Call: edit]');
      expect(result).toContain('file_path');
      expect(result).toContain('Exit Code: 1');
      expect(result).toContain('Error:');
    });

    it('should return empty for non-matching tool', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, MULTI_TURN_JSONL, 'utf8');

      const result = await extractFailedToolContext(SAMPLE_SESSION_ID, 'main', 'nonexistent');
      expect(result).toBe('');
    });

    it('should return empty for empty parameters', async () => {
      expect(await extractFailedToolContext('', 'main', 'edit')).toBe('');
      expect(await extractFailedToolContext('x', 'main', '')).toBe('');
    });

    it('should correlate tool call with result via toolCallId', async () => {
      const filePath = path.join(sessionsDir, `${SAMPLE_SESSION_ID}.jsonl`);
      fs.writeFileSync(filePath, MULTI_TURN_JSONL, 'utf8');

      const result = await extractFailedToolContext(SAMPLE_SESSION_ID, 'main', 'edit');

      // Should show correlated arguments
      expect(result).toContain('file_path');
    });
  });
});
