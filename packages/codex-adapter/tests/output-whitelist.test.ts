import { describe, expect, it } from 'vitest';
import { CodexHooksHostAdapter } from '../src/host-adapter.js';
import { codexOutputFieldsAreWhitelisted } from '../src/codec/index.js';

const adapter = new CodexHooksHostAdapter();

describe('Codex 0.147 strict output schema', () => {
  it.each([
    [{ decision: 'allow', source: 'x' } as const, 'before_tool_call' as const],
    [{ decision: 'deny', reason: 'unsafe', source: 'x' } as const, 'before_tool_call' as const],
    [{ decision: 'observe', source: 'x' } as const, 'after_tool_call' as const],
    [{ decision: 'modify', additionalContext: 'context', source: 'x' } as const, 'before_prompt_build' as const],
    [{ decision: 'modify', additionalContext: 'context', source: 'x' } as const, 'session_start' as const],
  ])('emits only the exact per-event nested fields', (result, kind) => {
    expect(codexOutputFieldsAreWhitelisted(adapter.encodeOutput(result, kind))).toEqual({ ok: true, violators: [] });
  });

  it('rejects top-level remembered-schema fields and unknown nested fields', () => {
    expect(codexOutputFieldsAreWhitelisted({ permissionDecision: 'deny' }).ok).toBe(false);
    expect(codexOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', reason: 'wrong field' } }).ok).toBe(false);
  });
});
