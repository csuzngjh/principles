/**
 * Trajectory Collector — before_message_write hook tests (PRI-346)
 *
 * Cases A–F verify:
 *  A: hook registration via api.on('before_message_write', ...)
 *  B: assistant message → SQLite fallback when unauthorized
 *  C: user message → user_turns; non-user/assistant → skip
 *  D: authorized → no SQLite write (de-duplication)
 *  E: CONVERSATION_HOOK_BLOCKED observability log
 *  F: privacy / path redaction in sanitized text
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OpenClawPluginApi, PluginHookBeforeMessageWriteEvent, PluginHookAgentContext } from '../../src/openclaw-sdk.js';

// Mock heavy dependencies before importing the module under test
const mockRecordAssistantTurn = vi.fn(() => 42);
const mockRecordUserTurn = vi.fn(() => 1);

vi.mock('../../src/core/workspace-context.js', () => {
  return {
    WorkspaceContext: {
      fromHookContext: vi.fn(() => ({
        trajectory: {
          recordAssistantTurn: mockRecordAssistantTurn,
          recordUserTurn: mockRecordUserTurn,
        },
        workspaceDir: '/mock/workspace',
        stateDir: '/mock/workspace/.state',
      })),
    },
  };
});

vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: {
    log: vi.fn(),
  },
}));

vi.mock('../../src/hooks/message-sanitize.js', () => ({
  sanitizeForEvidence: vi.fn((text: string, _wsDir?: string) => {
    // Simulate path redaction: replace C:\Users\... patterns
    return text.replace(/C:\\Users\\[^\s]+/gi, '[PATH_REDACTED]');
  }),
}));

// fs mock: prevent real file I/O from writeTrajectoryRecord
vi.mock('fs', () => {
  const memfs: Record<string, string> = {};
  return {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    promises: {
      mkdir: vi.fn(),
      appendFile: vi.fn(async (filepath: string, data: string) => {
        memfs[filepath] = (memfs[filepath] ?? '') + data;
      }),
    },
    appendFile: vi.fn(),
    __memfs: memfs,
  };
});

import { handleBeforeMessageWrite } from '../../src/hooks/trajectory-collector.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { SystemLogger } from '../../src/core/system-logger.js';
import plugin from '../../src/index.js';

function makeEvent(role: string, content: string | unknown[]): PluginHookBeforeMessageWriteEvent {
  return {
    message: { role, content },
    sessionKey: 'sess-001',
    sessionId: 'sess-001',
    agentId: 'main',
  };
}

const unauthorizedConfig = { hooks: { allowConversationAccess: false } };
const authorizedConfig = { hooks: { allowConversationAccess: true } };

function makeCtx(pluginConfig: unknown, workspaceDir: string | null = '/mock/workspace') {
  return {
    workspaceDir: workspaceDir === null ? undefined : workspaceDir,
    pluginConfig,
    sessionId: 'sess-001',
    agentId: 'main',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as PluginHookAgentContext & { workspaceDir?: string; pluginConfig?: unknown };
}

describe('PRI-346: before_message_write hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case A: hook registration ──────────────────────────────────────────────
  describe('Case A — hook is registered', () => {
    it('calls api.on with "before_message_write"', () => {
      const onSpy = vi.fn();
      const mockApi = {
        rootDir: '/mock',
        pluginConfig: { language: 'en' },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: {},
        registerCommand: vi.fn(),
        registerService: vi.fn(),
        registerTool: vi.fn(),
        registerHttpRoute: vi.fn(),
        on: onSpy,
      } as unknown as OpenClawPluginApi;

      plugin.register(mockApi);

      const registeredEvents = onSpy.mock.calls.map((c: unknown[]) => c[0]);
      expect(registeredEvents).toContain('before_message_write');
    });
  });

  // ── Case B: assistant message → SQLite when unauthorized ───────────────────
  describe('Case B — assistant message writes to SQLite when unauthorized', () => {
    it('calls recordAssistantTurn once', () => {
      const event = makeEvent('assistant', 'Hello, how can I help?');
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(mockRecordAssistantTurn).toHaveBeenCalledTimes(1);
      const call = mockRecordAssistantTurn.mock.calls[0][0];
      expect(call.sessionId).toBe('sess-001');
      expect(call.runId).toBe('before_message_write_fallback');
      expect(call.provider).toBe('unknown');
      expect(call.model).toBe('unknown');
    });
  });

  // ── Case C: user → user_turns; tool → skip ─────────────────────────────────
  describe('Case C — user message and non-user/assistant', () => {
    it('calls recordUserTurn for role=user', () => {
      const event = makeEvent('user', 'Fix this bug please');
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(mockRecordUserTurn).toHaveBeenCalledTimes(1);
      expect(mockRecordAssistantTurn).not.toHaveBeenCalled();
    });

    it('skips writing for role=tool', () => {
      const event = makeEvent('tool', 'tool output here');
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(mockRecordAssistantTurn).not.toHaveBeenCalled();
      expect(mockRecordUserTurn).not.toHaveBeenCalled();
    });

    it('handles array content (multipart messages)', () => {
      const content = [
        { type: 'text', text: 'Part one' },
        { type: 'image_url', url: 'http://example.com/img.png' },
        { type: 'text', text: 'Part two' },
      ];
      const event = makeEvent('assistant', content);
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(mockRecordAssistantTurn).toHaveBeenCalledTimes(1);
      const call = mockRecordAssistantTurn.mock.calls[0][0];
      expect(call.rawText).toContain('Part one');
      expect(call.rawText).toContain('Part two');
    });
  });

  // ── Case D: de-duplication (authorized → no SQLite) ────────────────────────
  describe('Case D — authorized config skips SQLite (de-dup)', () => {
    it('does NOT call recordAssistantTurn when authorized', () => {
      const event = makeEvent('assistant', 'Normal response');
      const ctx = makeCtx(authorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(mockRecordAssistantTurn).not.toHaveBeenCalled();
      expect(mockRecordUserTurn).not.toHaveBeenCalled();
    });

    it('does NOT call SystemLogger.log when authorized', () => {
      const event = makeEvent('assistant', 'Normal response');
      const ctx = makeCtx(authorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(SystemLogger.log).not.toHaveBeenCalled();
    });
  });

  // ── Case E: CONVERSATION_HOOK_BLOCKED observability ─────────────────────────
  describe('Case E — CONVERSATION_HOOK_BLOCKED logged when unauthorized', () => {
    it('logs with reason + nextAction', () => {
      const event = makeEvent('assistant', 'Some response');
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(SystemLogger.log).toHaveBeenCalledWith(
        '/mock/workspace',
        'CONVERSATION_HOOK_BLOCKED',
        expect.any(String),
      );
      const payload = JSON.parse(
        (SystemLogger.log as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
      );
      expect(payload.reason).toBeDefined();
      expect(payload.nextAction).toBeDefined();
      expect(payload.hook).toBe('llm_output');
      expect(payload.fallback).toBe('before_message_write');
      expect(payload.role).toBe('assistant');
    });
  });

  // ── Case F: privacy / path redaction ────────────────────────────────────────
  describe('Case F — sensitive path is redacted in sanitizedText', () => {
    it('sanitizedText does not contain the raw path', () => {
      const sensitiveContent = 'The file is at C:\\Users\\sensitive\\path\\secret.txt please check it';
      const event = makeEvent('assistant', sensitiveContent);
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);

      expect(mockRecordAssistantTurn).toHaveBeenCalledTimes(1);
      const call = mockRecordAssistantTurn.mock.calls[0][0];
      expect(call.sanitizedText).not.toContain('C:\\Users\\sensitive\\path');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────
  describe('Edge cases', () => {
    it('returns early when workspaceDir is missing', () => {
      mockRecordAssistantTurn.mockReset();
      mockRecordUserTurn.mockReset();
      const event = makeEvent('assistant', 'Hello');
      const ctx = makeCtx(unauthorizedConfig, null);

      // Should not throw
      handleBeforeMessageWrite(event, ctx);
      expect(mockRecordAssistantTurn).not.toHaveBeenCalled();
    });

    it('returns early when message is null/undefined', () => {
      const event = { message: null as unknown as { role?: string }, sessionKey: 's' } as PluginHookBeforeMessageWriteEvent;
      const ctx = makeCtx(unauthorizedConfig);

      handleBeforeMessageWrite(event, ctx);
      expect(mockRecordAssistantTurn).not.toHaveBeenCalled();
    });

    it('handles missing pluginConfig gracefully', () => {
      const event = makeEvent('assistant', 'Hello');
      const ctx = makeCtx(undefined);

      handleBeforeMessageWrite(event, ctx);

      // pluginConfig undefined → unauthorized → fallback fires
      expect(mockRecordAssistantTurn).toHaveBeenCalledTimes(1);
    });
  });
});
