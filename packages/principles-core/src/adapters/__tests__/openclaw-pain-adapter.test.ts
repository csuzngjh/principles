import { describe, it, expect } from 'vitest';
import { OpenClawPainAdapter } from '../coding/openclaw-pain-adapter.js';
import { deriveSeverity } from '../../pain-signal.js';
import type { PluginHookAfterToolCallEvent } from '../coding/openclaw-event-types.js';

describe('OpenClawPainAdapter', () => {
  const adapter = new OpenClawPainAdapter();

  const baseEvent: PluginHookAfterToolCallEvent = {
    toolName: 'write',
    error: 'some error',
    params: {},
    sessionId: 'sess-123',
    agentId: 'agent-1',
  };

  // ---------------------------------------------------------------------------
  // Null-return paths
  // ---------------------------------------------------------------------------

  it('returns null for non-failure event (no error field)', () => {
    const event: PluginHookAfterToolCallEvent = { ...baseEvent, error: undefined };
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for malformed event (missing toolName)', () => {
    const event = { ...baseEvent, toolName: '' } as PluginHookAfterToolCallEvent;
    expect(adapter.capture(event)).toBeNull();
  });

  it('returns null for malformed event (toolName is not a string)', () => {
    const event = { ...baseEvent, toolName: 42 as unknown as string } as PluginHookAfterToolCallEvent;
    expect(adapter.capture(event)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // deriveScoreFromError mappings
  // ---------------------------------------------------------------------------

  it('maps permission denied error to score 95, severity critical', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'permission denied' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(95);
    expect(signal!.severity).toBe('critical');
  });

  it('maps EACCES error to score 95', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'EACCES: access denied' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(95);
  });

  it('maps ENOENT error to score 80, severity high', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'ENOENT: no such file or directory' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(80);
    expect(signal!.severity).toBe('high');
  });

  it('maps "no such file" error to score 80', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'no such file found' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(80);
  });

  it('maps EISDIR error to score 85', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'EISDIR: illegal operation' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(85);
  });

  it('maps EISFDIR error to score 85', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'EISFDIR: expected file' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(85);
  });

  it('maps SyntaxError to score 82', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'SyntaxError: unexpected token' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(82);
  });

  it('maps ParseError to score 82', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'ParseError: invalid JSON' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(82);
  });

  it('maps TypeError to score 75', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'TypeError: cannot read property' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(75);
  });

  it('maps "invalid type" error to score 75', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'invalid type: expected string' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(75);
  });

  it('maps ReferenceError to score 72', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'ReferenceError: x is not defined' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(72);
  });

  it('maps timeout error to score 60, severity medium', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'timeout: request exceeded 30s' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(60);
    expect(signal!.severity).toBe('medium');
  });

  it('maps ETIMEDOUT error to score 60', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'ETIMEDOUT: connection timed out' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(60);
  });

  it('maps ECONNREFUSED error to score 65', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'ECONNREFUSED: connection refused' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(65);
  });

  it('maps network error to score 65', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'network error: unreachable' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(65);
  });

  it('maps ENOTEMPTY error to score 55', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'ENOTEMPTY: directory not empty' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(55);
  });

  it('maps EEXIST error to score 55', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'EEXIST: file already exists' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(55);
  });

  it('maps unknown error to default score 50, severity medium', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'something unexpected happened' });
    expect(signal).not.toBeNull();
    expect(signal!.score).toBe(50);
    expect(signal!.severity).toBe('medium');
  });

  // ---------------------------------------------------------------------------
  // PainSignal structure
  // ---------------------------------------------------------------------------

  it('returns PainSignal with correct structure', () => {
    const signal = adapter.capture(baseEvent);
    expect(signal).not.toBeNull();
    expect(signal!.source).toBe('tool_failure');
    expect(signal!.timestamp).toBeTruthy();
    expect(new Date(signal!.timestamp).toISOString()).toBe(signal!.timestamp);
    expect(signal!.reason).toBe(`Tool ${baseEvent.toolName} failed: ${baseEvent.error}`);
    expect(signal!.sessionId).toBe(baseEvent.sessionId);
    expect(signal!.agentId).toBe(baseEvent.agentId);
    expect(signal!.traceId).toBe(baseEvent.sessionId);
    expect(signal!.domain).toBe('coding');
    expect(typeof signal!.severity).toBe('string');
    expect(signal!.context).toEqual({
      toolName: baseEvent.toolName,
      hasParams: true,
    });
  });

  it('uses "unknown" for sessionId/agentId/traceId when not provided', () => {
    const event: PluginHookAfterToolCallEvent = {
      toolName: 'write',
      error: 'some error',
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.sessionId).toBe('unknown');
    expect(signal!.agentId).toBe('unknown');
    expect(signal!.traceId).toBe('unknown');
  });

  // ---------------------------------------------------------------------------
  // deriveSeverity integration
  // ---------------------------------------------------------------------------

  it('uses deriveSeverity from pain-signal.js for severity derivation', () => {
    const signal = adapter.capture({ ...baseEvent, error: 'permission denied' });
    expect(signal!.score).toBe(95);
    expect(signal!.severity).toBe(deriveSeverity(95));
  });

  // ---------------------------------------------------------------------------
  // buildTriggerPreview
  // ---------------------------------------------------------------------------

  it('builds trigger preview with file_path from params', () => {
    const event: PluginHookAfterToolCallEvent = {
      ...baseEvent,
      params: { file_path: '/src/index.ts' },
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe('write(/src/index.ts)');
  });

  it('builds trigger preview with path from params', () => {
    const event: PluginHookAfterToolCallEvent = {
      ...baseEvent,
      params: { path: '/src/util.ts' },
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe('write(/src/util.ts)');
  });

  it('builds trigger preview with file from params', () => {
    const event: PluginHookAfterToolCallEvent = {
      ...baseEvent,
      params: { file: '/src/config.ts' },
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe('write(/src/config.ts)');
  });

  it('truncates content to 50 chars in trigger preview when no file_path', () => {
    const longContent = 'a'.repeat(80);
    const event: PluginHookAfterToolCallEvent = {
      ...baseEvent,
      params: { content: longContent },
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe(`write(${longContent.slice(0, 50)}...)`);
  });

  it('returns tool name only when no file_path or content in params', () => {
    const event: PluginHookAfterToolCallEvent = {
      ...baseEvent,
      params: { some_other_key: 'value' },
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe('write');
  });

  it('returns empty trigger preview when params is undefined', () => {
    const event: PluginHookAfterToolCallEvent = {
      ...baseEvent,
      params: undefined,
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe('');
  });

  it('returns empty trigger preview when params has no relevant keys', () => {
    const event: PluginHookAfterToolCallEvent = {
      toolName: 'bash',
      error: 'command failed',
      params: {},
    };
    const signal = adapter.capture(event);
    expect(signal).not.toBeNull();
    expect(signal!.triggerTextPreview).toBe('bash');
  });
});
