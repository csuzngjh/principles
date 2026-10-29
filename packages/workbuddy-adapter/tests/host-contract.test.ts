/**
 * Frozen host-contract decode tests (SPEC §4.2).
 *
 * Primary inputs are the 11 REAL sanitized Phase 0 fixtures under
 * tests/fixtures/host-contract/events/ — 10 hook payload fixtures (probes
 * P00/P01b/P03) plus the P04 model-request injection-shapes capture, which is
 * NOT an event payload and must fail loud when fed to the decoder. Every
 * required-field decision mirrors hook-runtime-contract.json per-event
 * payloadFields.required exactly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkBuddyHooksHostAdapter } from '../src/host-adapter.js';
import { decodeWorkbuddyInput, WorkBuddyDecoderError } from '../src/codec/input-decoder.js';

const EVENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'host-contract', 'events');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, name), 'utf8')) as Record<string, unknown>;
}

function payloadOf(name: string): Record<string, unknown> {
  const fixture = loadFixture(name);
  const payload = fixture['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error(`fixture ${name} carries no payload object`);
  return payload as Record<string, unknown>;
}

function decodeError(raw: unknown): WorkBuddyDecoderError {
  try {
    decodeWorkbuddyInput(raw);
  } catch (error) {
    if (error instanceof WorkBuddyDecoderError) return error;
    throw error;
  }
  throw new Error('expected decodeWorkbuddyInput to throw');
}

describe('frozen fixture payloads decode with exact field mapping', () => {
  it('SessionStart (startup): no cwd, source mapped, generation_id → turnId', () => {
    const event = decodeWorkbuddyInput(payloadOf('session-start-startup.json'));
    expect(event.kind).toBe('session_start');
    expect(event.source).toBe('workbuddy:session_start');
    expect(event.context.sessionId).toBe('01a130ba-6a85-7e11-9562-eb776861ef22');
    expect(event.context.turnId).toBe('01a130ba6ac7721393a571685d0f778d');
    expect(event.context.source).toBe('startup');
    // Frozen contract: SessionStart carries NO cwd — the entry replaces the
    // empty placeholder with the resolved governance workspace before dispatch.
    expect(event.context.workspaceDir).toBe('');
    expect(event.context.toolCallId).toBeUndefined();
  });

  it('UserPromptSubmit: prompt mapped to promptContent, cwd carried, turn stable', () => {
    const event = decodeWorkbuddyInput(payloadOf('user-prompt-submit.json'));
    expect(event.kind).toBe('before_prompt_build');
    expect(event.source).toBe('workbuddy:user_prompt_submit');
    expect(event.context.promptContent).toBe('say SECOND');
    expect(event.context.workspaceDir).toBe('d:\\Code\\_worktrees\\wb-probe-lab\\proj-a');
    expect(event.context.turnId).toBe('01a130bb9b5c733996d17a9b5a775ac4');
  });

  for (const name of ['pre-tool-use-read.json', 'pre-tool-use-bash.json', 'pre-tool-use-write.json', 'pre-tool-use-write-denied.json']) {
    it(`${name}: before_tool_call with rawPayload.toolInput tuple for the shared gate`, () => {
      const payload = payloadOf(name);
      const event = decodeWorkbuddyInput(payload);
      expect(event.kind).toBe('before_tool_call');
      expect(event.source).toBe('workbuddy:pre_tool_use');
      expect(event.context.sessionId).toBe(payload['session_id']);
      expect(event.context.toolName).toBe(payload['tool_name']);
      expect(event.context.toolInput).toEqual(payload['tool_input']);
      expect(event.context.toolCallId).toBe(payload['call_id']);
      expect(event.context.turnId).toBe(payload['generation_id']);
      expect(event.rawPayload).toEqual({ toolInput: { toolName: payload['tool_name'], params: payload['tool_input'] } });
    });
  }

  it('PostToolUse Read success: STRING tool_response wraps into the channel-contract completion envelope (SPEC R2 wiring)', () => {
    const payload = payloadOf('post-tool-use-read-success.json');
    const event = decodeWorkbuddyInput(payload);
    expect(event.kind).toBe('after_tool_call');
    // SPEC-RULECODE-HOST-PROMOTION-001 R2: on the PostToolUse channel the
    // frozen host contract is completion evidence (PostToolUseFailure is a
    // separate registration). The rendered text rides verbatim inside the
    // envelope; the record shape classifies as success for the shared writer
    // so the durable row is provable WorkBuddy history. No failure marker is
    // invented on either side.
    expect(event.context.toolOutput).toEqual({ toolResponse: '   1→hello from proj-a\n   2→' });
    expect(event.context.toolCallId).toBe('toolu_p03_success');
  });

  it('PostToolUse Read is_error WITHOUT exitCode: normalized to an EXPLICIT failure envelope (never defaulted to success)', () => {
    const payload = payloadOf('post-tool-use-read-iserror.json');
    const event = decodeWorkbuddyInput(payload);
    expect(event.kind).toBe('after_tool_call');
    const toolOutput = event.context.toolOutput as { result: unknown; error: string };
    expect(typeof toolOutput).toBe('object');
    expect(toolOutput.error).toContain('is_error=true');
    expect(toolOutput.error).toContain('tool_error_code=1001');
    expect(toolOutput.result).toEqual(payload['tool_response']);
  });

  it('PostToolUse Bash exit 7: explicit error preserved, raw response kept inside result', () => {
    const payload = payloadOf('post-tool-use-bash-exit7.json');
    const event = decodeWorkbuddyInput(payload);
    const toolOutput = event.context.toolOutput as { result: Record<string, unknown>; error: string };
    expect(toolOutput.error).toBe('cat: /d/Code/_worktrees/wb-probe-lab/proj-a/ABSENT.txt: No such file or directory\n');
    expect(toolOutput.result).toEqual(payload['tool_response']);
  });

  it('PostToolUseFailure (thrown tool error): decodes onto after_tool_call with a failure envelope — thrown error verbatim, raw payload (incl. tool_error_code) inside result', () => {
    const payload = payloadOf('post-tool-use-failure-write-notread.json');
    const event = decodeWorkbuddyInput(payload);
    expect(event.kind).toBe('after_tool_call');
    expect(event.source).toBe('workbuddy:post_tool_use_failure');
    const toolOutput = event.context.toolOutput as { error: string; result: Record<string, unknown> };
    // The thrown error is the failure attribution — verbatim, never swapped
    // for a success marker (this event is registered in hooks.json since the
    // 2026-10-13 re-verification proved this failure class emits ONLY it,
    // never PostToolUse: engine 2.161.0, sha256 1b1a01bc…).
    expect(toolOutput.error).toBe('File has not been read yet: D:\\Code\\_worktrees\\wb-probe-lab\\proj-a\\guarded-preset2.txt. Read it first before writing to it.');
    expect(toolOutput.result).toEqual(payload);
    expect(toolOutput.result['tool_error_code']).toBe('2009');
    expect(Object.hasOwn(toolOutput.result, 'tool_response')).toBe(false);
    expect(event.context.toolCallId).toBe('toolu_p03_throw');
    expect(event.context.toolName).toBe('Write');
  });

  it('model-request-injection-shapes fixture is NOT an event payload: decode fails loud', () => {
    // P04 evidence capture (probe output shapes) must never be accepted as a
    // hook event — it has no hook_event_name (rc-3, no silent skip).
    const error = decodeError(loadFixture('model-request-injection-shapes.json'));
    expect(error.reason).toContain('hook_event_name');
  });
});

describe('decoder fail-loud matrix (rc-1/rc-2/rc-3)', () => {
  const base = {
    session_id: 'sess-1',
    transcript_path: 'D:\\transcript.jsonl',
    cwd: 'D:\\Code\\proj',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: 'D:\\Code\\proj\\a.txt', content: 'x' },
    call_id: 'toolu_1',
    generation_id: 'gen-1',
  };

  it('rejects unknown hook_event_name', () => {
    expect(decodeError({ ...base, hook_event_name: 'Notification' }).reason).toContain('unknown hook_event_name "Notification"');
  });

  it('rejects non-object stdin payloads', () => {
    expect(decodeError('nope').reason).toContain('not a JSON object');
    expect(decodeError([1, 2]).reason).toContain('not a JSON object');
  });

  it('rejects relative cwd (SPEC §4.2: cwd must be absolute)', () => {
    expect(decodeError({ ...base, cwd: 'proj-a' }).reason).toContain('absolute');
  });

  it('rejects missing cwd on UserPromptSubmit', () => {
    const { cwd, ...noCwd } = { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
    void cwd;
    expect(decodeError(noCwd).reason).toContain('"cwd"');
  });

  it('rejects missing/empty prompt on UserPromptSubmit', () => {
    expect(decodeError({ ...base, hook_event_name: 'UserPromptSubmit', prompt: undefined }).reason).toContain('"prompt"');
    expect(decodeError({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '   ' }).reason).toContain('"prompt"');
  });

  it('rejects missing/empty tool_name and missing/non-object tool_input on tool events', () => {
    expect(decodeError({ ...base, tool_name: '' }).reason).toContain('"tool_name"');
    const { tool_name, ...noName } = base;
    void tool_name;
    expect(decodeError(noName).reason).toContain('"tool_name"');
    expect(decodeError({ ...base, tool_input: 'echo hi' }).reason).toContain('"tool_input"');
    const { tool_input, ...noInput } = base;
    void tool_input;
    expect(decodeError(noInput).reason).toContain('"tool_input"');
  });

  it('rejects missing and non-string/object tool_response on PostToolUse', () => {
    const post = { ...base, hook_event_name: 'PostToolUse', tool_response: undefined };
    expect(decodeError(post).reason).toContain('"tool_response"');
    expect(decodeError({ ...base, hook_event_name: 'PostToolUse', tool_response: 7 }).reason).toContain('"tool_response"');
  });

  it('rejects missing error on PostToolUseFailure', () => {
    expect(decodeError({ ...base, hook_event_name: 'PostToolUseFailure' }).reason).toContain('"error"');
  });

  it('rejects malformed session_id and transcript_path types', () => {
    expect(decodeError({ ...base, session_id: 42 }).reason).toContain('"session_id"');
    expect(decodeError({ ...base, transcript_path: 42 }).reason).toContain('"transcript_path"');
  });

  it('accepts null transcript_path without opening it', () => {
    const event = decodeWorkbuddyInput({ ...base, hook_event_name: 'PostToolUse', tool_response: 'ok', transcript_path: null });
    expect(event.kind).toBe('after_tool_call');
  });

  it('rejects malformed CONSUMED optional ids (rc-6: present-but-invalid fails loud)', () => {
    expect(decodeError({ ...base, generation_id: 42 }).reason).toContain('"generation_id"');
    expect(decodeError({ ...base, call_id: 42 }).reason).toContain('"call_id"');
  });

  it('rejects malformed permission_mode type (retained without granting authority)', () => {
    expect(decodeError({ ...base, permission_mode: 7 }).reason).toContain('"permission_mode"');
    const event = decodeWorkbuddyInput({ ...base, permission_mode: 'bypassPermissions' });
    // bypassPermissions NEVER bypasses governance: decoded identically.
    expect(event.kind).toBe('before_tool_call');
  });

  it('tool_use_id is the fallback id source; both missing → toolCallId stays undefined (never fabricated)', () => {
    const { call_id, ...noCall } = base;
    void call_id;
    const viaToolUseId = decodeWorkbuddyInput({ ...noCall, tool_use_id: 'toolu_fallback' });
    expect(viaToolUseId.context.toolCallId).toBe('toolu_fallback');
    const neither = decodeWorkbuddyInput(noCall);
    expect(neither.context.toolCallId).toBeUndefined();
  });

  it('SessionStart required set: source/permission_mode/client/version (frozen contract), cwd NOT required', () => {
    const ok = decodeWorkbuddyInput({
      session_id: 's', transcript_path: null, hook_event_name: 'SessionStart',
      source: 'resume', permission_mode: 'default', client: 'CLI', version: '2.161.0',
    });
    expect(ok.context.source).toBe('resume');
    for (const missing of ['source', 'permission_mode', 'client', 'version'] as const) {
      const payload: Record<string, unknown> = {
        session_id: 's', transcript_path: null, hook_event_name: 'SessionStart',
        source: 'startup', permission_mode: 'default', client: 'CLI', version: '2.161.0',
      };
      delete payload[missing];
      expect(decodeError(payload).reason).toContain(`"${missing}"`);
    }
  });

  it('PostToolUse object WITHOUT failure markers (e.g. Bash exit 0) passes through unmodified', () => {
    const response = { exitCode: 0, signal: null, interrupted: false };
    const event = decodeWorkbuddyInput({ ...base, hook_event_name: 'PostToolUse', tool_response: response });
    expect(event.context.toolOutput).toBe(response);
  });

  it('PostToolUse is_error:true with exitCode 0 still normalizes to failure', () => {
    const event = decodeWorkbuddyInput({ ...base, hook_event_name: 'PostToolUse', tool_response: { is_error: true, exitCode: 0 } });
    const toolOutput = event.context.toolOutput as { error: string };
    expect(toolOutput.error).toContain('is_error=true');
  });
});

describe('WorkBuddyHooksHostAdapter (HostAdapter implementation)', () => {
  const adapter = new WorkBuddyHooksHostAdapter();

  it('declares hostId workbuddy, subprocess model, and the four-event v1 subscription', () => {
    expect(adapter.hostId).toBe('workbuddy');
    expect(adapter.hostKind).toBe('subprocess');
    expect(adapter.subscribedEvents()).toEqual(['before_tool_call', 'after_tool_call', 'before_prompt_build', 'session_start']);
  });

  it('decodeEvent/encodeOutput delegate to the codec', () => {
    const event = adapter.decodeEvent(payloadOf('pre-tool-use-write.json'));
    expect(event.kind).toBe('before_tool_call');
    expect(adapter.encodeOutput({ decision: 'allow', source: event.source }, 'before_tool_call')).toBeNull();
  });
});
