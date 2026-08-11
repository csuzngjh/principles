/**
 * CodexHooksHostAdapter tests (ADR-0020 §2.5, SPEC v4.1 §5.3)
 */
import { describe, it, expect } from 'vitest';
import { CodexHooksHostAdapter } from '../src/host-adapter.js';
import { isHostAdapter } from '@principles/core/host';
import type { HostEventResult } from '@principles/core/host';

const adapter = new CodexHooksHostAdapter();

describe('CodexHooksHostAdapter', () => {
  describe('static contract', () => {
    it('has hostId "codex"', () => {
      expect(adapter.hostId).toBe('codex');
    });

    it('has hostKind "subprocess"', () => {
      expect(adapter.hostKind).toBe('subprocess');
    });

    it('subscribes to 4 MVP-Core events', () => {
      const events = adapter.subscribedEvents();
      expect(events).toContain('before_tool_call');
      expect(events).toContain('after_tool_call');
      expect(events).toContain('before_prompt_build');
      expect(events).toContain('session_start');
      expect(events).not.toContain('session_end'); // deferred
    });

    it('satisfies the HostAdapter contract via isHostAdapter guard', () => {
      // Sanity: isHostAdapter is exported from @principles/core/host and
      // accepts an instance with all required methods. (If the interface
      // drifts, the type system will fail compilation first.)
      expect(typeof adapter.decodeEvent).toBe('function');
      expect(typeof adapter.encodeOutput).toBe('function');
      expect(typeof adapter.subscribedEvents).toBe('function');
      void isHostAdapter; // type import smoke test
    });
  });

  describe('decodeEvent — PreToolUse', () => {
    it('decodes a valid PreToolUse payload', () => {
      const raw = {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-abc',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
        workspace_dir: '/ws',
      };
      const event = adapter.decodeEvent(raw);
      expect(event.kind).toBe('before_tool_call');
      expect(event.context.sessionId).toBe('sess-abc');
      expect(event.context.turnId).toBe('turn-1');
      expect(event.context.toolName).toBe('Bash');
      expect(event.context.toolInput).toEqual({ command: 'rm -rf /' });
      expect(event.source).toBe('codex:pretooluse');
    });

    it('fails loud when session_id missing (rc-3)', () => {
      const raw = {
        hook_event_name: 'PreToolUse',
        // session_id missing
        tool_name: 'Bash',
        workspace_dir: '/ws',
      };
      expect(() => adapter.decodeEvent(raw)).toThrow(/session_id/);
    });

    it('fails loud when tool_name missing (rc-3)', () => {
      const raw = {
        hook_event_name: 'PreToolUse',
        session_id: 'sess',
        workspace_dir: '/ws',
      };
      expect(() => adapter.decodeEvent(raw)).toThrow(/tool_name/);
    });

    it('fails loud when workspace_dir missing (rc-3)', () => {
      const raw = {
        hook_event_name: 'PreToolUse',
        session_id: 'sess',
        tool_name: 'Bash',
      };
      expect(() => adapter.decodeEvent(raw)).toThrow(/workspace_dir/);
    });

    it('rejects unknown hook_event_name', () => {
      const raw = {
        hook_event_name: 'SubagentStop',
        session_id: 'sess',
        workspace_dir: '/ws',
      };
      expect(() => adapter.decodeEvent(raw)).toThrow(/SubagentStop/);
    });

    it('rejects non-object payload (rc-1)', () => {
      expect(() => adapter.decodeEvent(null)).toThrow(/not a JSON object/);
      expect(() => adapter.decodeEvent('string')).toThrow(/not a JSON object/);
      expect(() => adapter.decodeEvent([1, 2, 3])).toThrow(/not a JSON object/);
    });
  });

  describe('decodeEvent — SessionStart (turn_id absent)', () => {
    it('omits turnId when Codex does not provide it (SPEC v4.1 §5.3.4)', () => {
      const raw = {
        hook_event_name: 'SessionStart',
        session_id: 'sess-xyz',
        source: 'startup',
        workspace_dir: '/ws',
        // NO turn_id field
      };
      const event = adapter.decodeEvent(raw);
      expect(event.kind).toBe('session_start');
      expect(event.context.turnId).toBeUndefined();
      expect(event.context.source).toBe('startup');
    });
  });

  describe('decodeEvent — PostToolUse', () => {
    it('decodes tool_response into toolOutput', () => {
      const raw = {
        hook_event_name: 'PostToolUse',
        session_id: 'sess',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_response: { stdout: 'done', exitCode: 0 },
        workspace_dir: '/ws',
      };
      const event = adapter.decodeEvent(raw);
      expect(event.kind).toBe('after_tool_call');
      expect(event.context.toolName).toBe('Bash');
      expect(event.context.toolOutput).toEqual({ stdout: 'done', exitCode: 0 });
    });
  });

  describe('decodeEvent — UserPromptSubmit', () => {
    it('decodes prompt into promptContent', () => {
      const raw = {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess',
        turn_id: 'turn-1',
        prompt: 'delete the database',
        workspace_dir: '/ws',
      };
      const event = adapter.decodeEvent(raw);
      expect(event.kind).toBe('before_prompt_build');
      expect(event.context.promptContent).toBe('delete the database');
    });
  });

  describe('encodeOutput — PreToolUse', () => {
    const allowResult: HostEventResult = {
      decision: 'allow',
      source: 'codex:pretooluse',
    };
    const denyResult: HostEventResult = {
      decision: 'deny',
      reason: 'Bash command targets protected path',
      source: 'codex:pretooluse',
    };

    it('hardcodes continue: true (gate-critical, fail-OPEN mitigation)', () => {
      const out = adapter.encodeOutput(allowResult, 'before_tool_call') as { continue: unknown };
      expect(out.continue).toBe(true);
    });

    it('translates decision "allow" → permissionDecision "allow"', () => {
      const out = adapter.encodeOutput(allowResult, 'before_tool_call') as { permissionDecision: string };
      expect(out.permissionDecision).toBe('allow');
    });

    it('translates decision "deny" → permissionDecision "deny" + reason', () => {
      const out = adapter.encodeOutput(denyResult, 'before_tool_call') as { permissionDecision: string; reason: string };
      expect(out.permissionDecision).toBe('deny');
      expect(out.reason).toBe('Bash command targets protected path');
    });

    it('NEVER emits permissionDecision "ask" (fail-OPEN mitigation)', () => {
      // Even if business logic returns some weird decision, never "ask".
      const weird: HostEventResult = {
        decision: 'observe',
        source: 'codex:pretooluse',
      };
      const out = adapter.encodeOutput(weird, 'before_tool_call') as { permissionDecision: string };
      expect(out.permissionDecision).not.toBe('ask');
      expect(['allow', 'deny']).toContain(out.permissionDecision);
    });

    it('rejects modifiedInput (Codex PreToolUse cannot rewrite tool input)', () => {
      const bad: HostEventResult = {
        decision: 'modify',
        modifiedInput: { command: 'echo safe' },
        source: 'codex:pretooluse',
      };
      expect(() => adapter.encodeOutput(bad, 'before_tool_call')).toThrow(/modifiedInput/);
    });

    // Regression (CodeRabbit #3758794602, rc-9): assertNoExtraFields MUST be
    // called for ALL event kinds, not just PreToolUse. Previously
    // modifiedInput was silently dropped on PostToolUse/UserPromptSubmit/
    // SessionStart because the check only lived in encodePreToolUse.
    it('rejects modifiedInput on PostToolUse (rc-9: no silent drop)', () => {
      const bad: HostEventResult = {
        decision: 'modify',
        modifiedInput: { foo: 'bar' },
        source: 'codex:posttooluse',
      };
      expect(() => adapter.encodeOutput(bad, 'after_tool_call')).toThrow(/modifiedInput/);
    });

    it('rejects modifiedInput on UserPromptSubmit (rc-9: no silent drop)', () => {
      const bad: HostEventResult = {
        decision: 'modify',
        modifiedInput: { prompt: 'safe' },
        source: 'codex:userpromptsubmit',
      };
      expect(() => adapter.encodeOutput(bad, 'before_prompt_build')).toThrow(/modifiedInput/);
    });

    it('rejects modifiedInput on SessionStart (rc-9: no silent drop)', () => {
      const bad: HostEventResult = {
        decision: 'modify',
        modifiedInput: { state: 'init' },
        source: 'codex:sessionstart',
      };
      expect(() => adapter.encodeOutput(bad, 'session_start')).toThrow(/modifiedInput/);
    });

    it('requires non-empty reason for deny', () => {
      const bad: HostEventResult = {
        decision: 'deny',
        reason: '',
        source: 'codex:pretooluse',
      };
      expect(() => adapter.encodeOutput(bad, 'before_tool_call')).toThrow(/non-empty reason/);
    });
  });

  describe('encodeOutput — PostToolUse (no should_stop / permissionDecision)', () => {
    it('emits continue: true only when allowed', () => {
      const result: HostEventResult = {
        decision: 'allow',
        source: 'codex:posttooluse',
      };
      const out = adapter.encodeOutput(result, 'after_tool_call') as Record<string, unknown>;
      expect(out.continue).toBe(true);
      expect(out).not.toHaveProperty('permissionDecision');
      expect(out).not.toHaveProperty('should_stop');
    });

    it('translates deny + reason into systemMessage (cannot block post-fact)', () => {
      const result: HostEventResult = {
        decision: 'deny',
        reason: 'tool produced forbidden output',
        source: 'codex:posttooluse',
      };
      const out = adapter.encodeOutput(result, 'after_tool_call') as { systemMessage: string };
      expect(out.systemMessage).toContain('tool produced forbidden output');
    });
  });

  describe('encodeOutput — UserPromptSubmit', () => {
    it('emits additionalContext when provided', () => {
      const result: HostEventResult = {
        decision: 'allow',
        additionalContext: 'Remember: never delete /etc',
        source: 'codex:userpromptsubmit',
      };
      const out = adapter.encodeOutput(result, 'before_prompt_build') as { additionalContext: string };
      expect(out.additionalContext).toBe('Remember: never delete /etc');
    });

    it('translates deny + reason into additionalContext (cannot block prompt submit)', () => {
      const result: HostEventResult = {
        decision: 'deny',
        reason: 'prompt looks unsafe',
        source: 'codex:userpromptsubmit',
      };
      const out = adapter.encodeOutput(result, 'before_prompt_build') as { additionalContext: string };
      expect(out.additionalContext).toContain('prompt looks unsafe');
    });

    // Regression (CodeRabbit #3758794608, rc-9): deny + reason MUST merge with
    // existing additionalContext, not overwrite it. Previously the deny branch
    // would silently replace the injected context with just `[PD] ${reason}`.
    it('merges deny+reason with existing additionalContext (not overwrite)', () => {
      const result: HostEventResult = {
        decision: 'deny',
        reason: 'prompt looks unsafe',
        additionalContext: 'Remember: never delete /etc',
        source: 'codex:userpromptsubmit',
      };
      const out = adapter.encodeOutput(result, 'before_prompt_build') as { additionalContext: string };
      // Both must be present — the injected context must NOT be silently dropped.
      expect(out.additionalContext).toContain('Remember: never delete /etc');
      expect(out.additionalContext).toContain('prompt looks unsafe');
      expect(out.additionalContext).toContain('[PD]');
    });
  });

  describe('encodeOutput — SessionStart', () => {
    it('emits continue: true + additionalContext', () => {
      const result: HostEventResult = {
        decision: 'allow',
        additionalContext: 'workspace state hydrated',
        source: 'codex:sessionstart',
      };
      const out = adapter.encodeOutput(result, 'session_start') as { continue: boolean; additionalContext: string };
      expect(out.continue).toBe(true);
      expect(out.additionalContext).toBe('workspace state hydrated');
    });
  });

  describe('encodeOutput — unknown kind', () => {
    it('throws CodexEncoderError on unsupported kind', () => {
      const result: HostEventResult = {
        decision: 'allow',
        source: 'codex:unknown',
      };
      // Cast to bypass TS: HostEventKind doesn't permit unknown strings,
      // but the encoder must still defend against unexpected runtime values.
      const unknownKind = 'permission_request' as unknown as Parameters<typeof adapter.encodeOutput>[1];
      expect(() => adapter.encodeOutput(result, unknownKind)).toThrow(/unknown event kind/);
    });
  });
});
