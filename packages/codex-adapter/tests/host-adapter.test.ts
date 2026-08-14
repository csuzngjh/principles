import { describe, expect, it } from 'vitest';
import { CodexHooksHostAdapter } from '../src/host-adapter.js';
import type { HostEventResult } from '@principles/core/host';

const adapter = new CodexHooksHostAdapter();
const common = {
  session_id: 'sess-523', turn_id: 'turn-523', transcript_path: null,
  cwd: '/workspace', model: 'gpt-5.6', permission_mode: 'default',
};

describe('CodexHooksHostAdapter pinned to codex-cli 0.147.0', () => {
  it('decodes the real PreToolUse input shape and cwd', () => {
    expect(adapter.decodeEvent({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'call-1' })).toMatchObject({
      kind: 'before_tool_call', source: 'codex:pre_tool_use',
      context: { workspaceDir: '/workspace', sessionId: 'sess-523', turnId: 'turn-523', toolName: 'Bash', toolInput: { command: 'pwd' } },
    });
  });

  it('requires every real common field instead of accepting a remembered payload', () => {
    for (const key of ['session_id', 'turn_id', 'transcript_path', 'cwd', 'model', 'permission_mode', 'tool_use_id']) {
      const payload: Record<string, unknown> = { ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'call-1' };
      delete payload[key];
      expect(() => adapter.decodeEvent(payload), key).toThrow(new RegExp(key));
    }
  });

  it('decodes PostToolUse input plus response and original input', () => {
    expect(adapter.decodeEvent({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'false' }, tool_response: { exitCode: 1 }, tool_use_id: 'call-2' })).toMatchObject({
      kind: 'after_tool_call', source: 'codex:post_tool_use',
      context: { toolName: 'Bash', toolInput: { command: 'false' }, toolOutput: { exitCode: 1 } },
    });
  });

  it('decodes UserPromptSubmit and SessionStart without inventing a turn id', () => {
    expect(adapter.decodeEvent({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'help' })).toMatchObject({ kind: 'before_prompt_build', context: { promptContent: 'help' } });
    expect(adapter.decodeEvent({ session_id: 'sess-523', transcript_path: null, cwd: '/workspace', hook_event_name: 'SessionStart', model: 'gpt-5.6', permission_mode: 'default', source: 'startup' })).toMatchObject({
      kind: 'session_start', source: 'codex:session_start', context: { workspaceDir: '/workspace', sessionId: 'sess-523', source: 'startup' },
    });
  });

  it('encodes neutral allow by omitting unsupported permissionDecision:allow', () => {
    expect(adapter.encodeOutput({ decision: 'allow', source: 'codex:pre_tool_use' }, 'before_tool_call')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse' },
    });
  });

  it('encodes a deny using the required nested permissionDecisionReason', () => {
    expect(adapter.encodeOutput({ decision: 'deny', reason: 'owner rule denied it', source: 'codex:pre_tool_use' }, 'before_tool_call')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'owner rule denied it' },
    });
  });

  it.each([
    ['after_tool_call', 'PostToolUse'],
    ['before_prompt_build', 'UserPromptSubmit'],
    ['session_start', 'SessionStart'],
  ] as const)('encodes %s context under hookSpecificOutput', (kind, hookEventName) => {
    expect(adapter.encodeOutput({ decision: kind === 'after_tool_call' ? 'observe' : 'modify', additionalContext: 'approved context', source: 'codex:test' }, kind)).toEqual({
      hookSpecificOutput: { hookEventName, additionalContext: 'approved context' },
    });
  });

  it.each(['after_tool_call', 'before_prompt_build', 'session_start'] as const)('fails loud rather than silently translating deny for %s', (kind) => {
    const result: HostEventResult = { decision: 'deny', reason: 'unsupported decision', source: 'codex:test' };
    expect(() => adapter.encodeOutput(result, kind)).toThrow(/deny/);
  });

  it('rejects unknown inputs and unsupported modifiedInput', () => {
    expect(() => adapter.decodeEvent(null)).toThrow(/JSON object/);
    expect(() => adapter.decodeEvent({ ...common, hook_event_name: '__proto__' })).toThrow(/unknown hook_event_name/);
    expect(() => adapter.encodeOutput({ decision: 'modify', modifiedInput: {}, source: 'codex:test' }, 'before_tool_call')).toThrow(/modifiedInput/);
  });
});
