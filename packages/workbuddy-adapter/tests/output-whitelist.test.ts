/**
 * Output whitelist tests (SPEC §4.3 / OD-06, frozen by probes P02/P04).
 *
 * The WorkBuddy host injects ANY raw stdout into model-visible context, so
 * the encoder contract is: at most ONE JSON document, only whitelisted
 * hookSpecificOutput fields, permissionDecision only ever "deny" (an "allow"
 * bypasses the host permission ask — P02), and NEUTRAL = null → EMPTY stdout.
 * modifiedInput/updatedToolOutput/ask/continue:false are rejected outright.
 */
import { describe, expect, it } from 'vitest';
import type { HostEventResult } from '@principles/core/host';
import { encodeWorkbuddyOutput, workbuddyOutputFieldsAreWhitelisted, isWorkBuddyHookOutput, WorkBuddyEncoderError } from '../src/codec/output-encoder.js';

function encodeError(result: HostEventResult, kind: string): WorkBuddyEncoderError {
  try {
    encodeWorkbuddyOutput(result, kind);
  } catch (error) {
    if (error instanceof WorkBuddyEncoderError) return error;
    throw error;
  }
  throw new Error('expected encodeWorkbuddyOutput to throw');
}

describe('encodeWorkbuddyOutput', () => {
  it('encodes a deny on before_tool_call with the exact whitelisted shape', () => {
    const output = encodeWorkbuddyOutput({ decision: 'deny', reason: '  PD: protected path  ', source: 'workbuddy:pre_tool_use' }, 'before_tool_call');
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'PD: protected path' } });
    expect(workbuddyOutputFieldsAreWhitelisted(output).ok).toBe(true);
  });

  it('neutral results encode to null (EMPTY stdout) for every event kind', () => {
    for (const kind of ['before_tool_call', 'after_tool_call', 'before_prompt_build', 'session_start'] as const) {
      expect(encodeWorkbuddyOutput({ decision: 'allow', source: 'workbuddy:x' }, kind)).toBeNull();
      expect(encodeWorkbuddyOutput({ decision: 'observe', source: 'workbuddy:x' }, kind)).toBeNull();
    }
  });

  it('encodes UserPromptSubmit additionalContext (the P04-verified injection channel)', () => {
    const output = encodeWorkbuddyOutput({ decision: 'modify', additionalContext: 'PD principles …', source: 'workbuddy:user_prompt_submit' }, 'before_prompt_build');
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'PD principles …' } });
    expect(workbuddyOutputFieldsAreWhitelisted(output).ok).toBe(true);
  });

  it('never emits permissionDecision "allow" or "ask" anywhere (P02: allow bypasses the host permission ask)', () => {
    const outputs = [
      encodeWorkbuddyOutput({ decision: 'deny', reason: 'r', source: 'workbuddy:pre_tool_use' }, 'before_tool_call'),
      encodeWorkbuddyOutput({ decision: 'modify', additionalContext: 'ctx', source: 'workbuddy:user_prompt_submit' }, 'before_prompt_build'),
    ];
    for (const output of outputs) {
      if (output === null) continue;
      const decision = (output.hookSpecificOutput as Record<string, unknown>)['permissionDecision'];
      expect(decision === undefined || decision === 'deny').toBe(true);
    }
  });

  it('rejects deny without a non-empty reason', () => {
    expect(encodeError({ decision: 'deny', reason: '', source: 'workbuddy:pre_tool_use' }, 'before_tool_call').reason).toContain('non-empty reason');
    expect(encodeError({ decision: 'deny', source: 'workbuddy:pre_tool_use' }, 'before_tool_call').reason).toContain('non-empty reason');
  });

  it('rejects deny on every non-PreToolUse kind (SPEC §4.3: deny is before_tool_call-only)', () => {
    for (const kind of ['after_tool_call', 'before_prompt_build', 'session_start'] as const) {
      expect(encodeError({ decision: 'deny', reason: 'r', source: 'workbuddy:x' }, kind).reason).toContain('deny is unsupported');
    }
    // Unknown kinds (e.g. turn_complete) are rejected as unknown before the
    // deny check can even apply.
    expect(encodeError({ decision: 'deny', reason: 'r', source: 'workbuddy:x' }, 'turn_complete').reason).toContain('unknown event kind');
  });

  it('rejects reason without deny', () => {
    expect(encodeError({ decision: 'allow', reason: 'r', source: 'workbuddy:x' }, 'before_tool_call').reason).toContain('reason without deny');
  });

  it('rejects modifiedInput (OD-06 + updatedToolOutput/ask stay out of the vocabulary)', () => {
    expect(encodeError({ decision: 'modify', modifiedInput: { a: 1 }, source: 'workbuddy:x' }, 'before_tool_call').reason).toContain('modifiedInput');
  });

  it('rejects empty additionalContext and additionalContext outside before_prompt_build (v1 channel discipline)', () => {
    expect(encodeError({ decision: 'modify', additionalContext: '  ', source: 'workbuddy:x' }, 'before_prompt_build').reason).toContain('non-empty');
    for (const kind of ['before_tool_call', 'after_tool_call', 'session_start'] as const) {
      expect(encodeError({ decision: 'allow', additionalContext: 'ctx', source: 'workbuddy:x' }, kind).reason).toContain('additionalContext is unsupported');
    }
  });

  it('rejects unknown event kinds', () => {
    expect(encodeError({ decision: 'allow', source: 'workbuddy:x' }, 'turn_complete').reason).toContain('unknown event kind');
  });
});

describe('workbuddyOutputFieldsAreWhitelisted (guard)', () => {
  it('accepts the encoder-produced documents and rejects every forbidden field', () => {
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } }).ok).toBe(true);
    // forbiddenForV1 (frozen contract): modifiedInput/updatedInput, updatedToolOutput, ask, continue
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse' }, continue: false }).violators).toContain('continue');
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', modifiedInput: {} } }).violators).toContain('hookSpecificOutput.modifiedInput');
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'x' } }).violators).toContain('hookSpecificOutput.updatedToolOutput');
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }).violators).toContain('hookSpecificOutput.permissionDecision');
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }).violators).toContain('hookSpecificOutput.permissionDecision');
    expect(workbuddyOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'Notification' } }).ok).toBe(false);
    expect(workbuddyOutputFieldsAreWhitelisted('not an object').ok).toBe(false);
  });

  it('isWorkBuddyHookOutput narrows only whitelisted documents (rc-2 guard, no as-cast)', () => {
    expect(isWorkBuddyHookOutput(null)).toBe(false);
    expect(isWorkBuddyHookOutput({ hookSpecificOutput: { hookEventName: 'SessionStart' } })).toBe(true);
    expect(isWorkBuddyHookOutput({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })).toBe(false);
  });
});
