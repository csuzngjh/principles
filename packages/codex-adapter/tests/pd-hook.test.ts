/**
 * pd-hook invocation tests (ADR-0020 §2.5)
 *
 * Verifies the single-script router correctly:
 *  - Short-circuits to {} + exit 0 when host.codex flag is OFF.
 *  - Decodes, processes, and encodes when flag is ON.
 *  - Fails OPEN (outputs {} + exit 0) on decode/encode/business errors.
 *  - Resolves workspace_dir from PD_WORKSPACE_DIR env when missing.
 */
import { describe, it, expect } from 'vitest';
import { processHookInvocation } from '../src/pd-hook.js';

describe('pd-hook.processHookInvocation', () => {
  describe('feature flag short-circuit (host.codex default OFF)', () => {
    it('returns {} + exit 0 when PD_HOST_CODEX_ENABLED is unset', () => {
      const result = processHookInvocation('{"hook_event_name":"PreToolUse"}', {});
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
      expect(result.stderr.some((l) => l.includes('host.codex flag is OFF'))).toBe(true);
    });

    it('returns {} + exit 0 when PD_HOST_CODEX_ENABLED=false', () => {
      const result = processHookInvocation('{"hook_event_name":"PreToolUse"}', {
        PD_HOST_CODEX_ENABLED: 'false',
      });
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
    });

    it('returns {} + exit 0 when PD_HOST_CODEX_ENABLED=0', () => {
      const result = processHookInvocation('{"hook_event_name":"PreToolUse"}', {
        PD_HOST_CODEX_ENABLED: '0',
      });
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
    });
  });

  describe('flag ON — PreToolUse allow path', () => {
    const env = { PD_HOST_CODEX_ENABLED: 'true' };
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    it('decodes + encodes successfully when workspace_dir is injected via env', () => {
      const result = processHookInvocation(stdin, {
        ...env,
        PD_WORKSPACE_DIR: '/tmp/ws',
      });
      expect(result.exitCode).toBe(0);
      const out = result.stdout as { continue: boolean; permissionDecision: string };
      expect(out.continue).toBe(true);
      expect(out.permissionDecision).toBe('allow');
    });

    it('falls back to process.cwd() when PD_WORKSPACE_DIR unset (rc-9 still proceeds)', () => {
      const result = processHookInvocation(stdin, env);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toHaveProperty('continue', true);
    });
  });

  describe('fail-OPEN on errors (rc-9)', () => {
    const env = { PD_HOST_CODEX_ENABLED: 'true', PD_WORKSPACE_DIR: '/ws' };

    it('returns {} + exit 0 on malformed stdin JSON', () => {
      const result = processHookInvocation('not-json', env);
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
      expect(result.stderr.some((l) => l.includes('JSON parse failed'))).toBe(true);
    });

    it('returns {} + exit 0 on missing required field (decode error)', () => {
      const stdin = JSON.stringify({
        hook_event_name: 'PreToolUse',
        // session_id missing
        tool_name: 'Bash',
      });
      const result = processHookInvocation(stdin, env);
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
      expect(result.stderr.some((l) => l.includes('decode failed'))).toBe(true);
    });

    it('returns {} + exit 0 on unknown hook_event_name', () => {
      const stdin = JSON.stringify({
        hook_event_name: 'Compact',
        session_id: 'sess',
      });
      const result = processHookInvocation(stdin, env);
      expect(result.stdout).toEqual({});
      expect(result.exitCode).toBe(0);
    });
  });

  describe('SessionStart — turn_id absent path', () => {
    const env = { PD_HOST_CODEX_ENABLED: 'true', PD_WORKSPACE_DIR: '/ws' };

    it('processes SessionStart without turn_id', () => {
      const stdin = JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'sess',
        source: 'startup',
      });
      const result = processHookInvocation(stdin, env);
      expect(result.exitCode).toBe(0);
      const out = result.stdout as { continue: boolean };
      expect(out.continue).toBe(true);
    });
  });
});
