/**
 * Codex output encoder whitelist contract test (ADR-0020 §6, gate-critical)
 *
 * Asserts encoded outputs contain ONLY fields allowed by Codex's schema
 * (`deny_unknown_fields`). Any violator triggers Codex's `invalid_reason`
 * path, which is fail-OPEN (the tool PROCEEDS — ADR-0020 §6 / SPEC v4.1 E3).
 *
 * This test MUST pass before `host.codex.enabled` can be flipped to `true`
 * (PRI-282 E2E gate).
 */
import { describe, it, expect } from 'vitest';
import { CodexHooksHostAdapter } from '../src/host-adapter.js';
import { codexOutputFieldsAreWhitelisted } from '../src/codec/index.js';
import type { HostEventResult } from '@principles/core/host';

const adapter = new CodexHooksHostAdapter();

describe('Codex output field whitelist (gate-critical, fail-OPEN mitigation)', () => {
  const cases: Array<{ name: string; result: HostEventResult; kind: Parameters<typeof adapter.encodeOutput>[1] }> = [
    { name: 'PreToolUse allow', result: { decision: 'allow', source: 'codex:pretooluse' }, kind: 'before_tool_call' },
    {
      name: 'PreToolUse deny',
      result: { decision: 'deny', reason: 'unsafe', source: 'codex:pretooluse' },
      kind: 'before_tool_call',
    },
    {
      name: 'PreToolUse allow + additionalContext',
      result: { decision: 'allow', additionalContext: 'remember X', source: 'codex:pretooluse' },
      kind: 'before_tool_call',
    },
    { name: 'PostToolUse allow', result: { decision: 'allow', source: 'codex:posttooluse' }, kind: 'after_tool_call' },
    {
      name: 'PostToolUse deny + reason (systemMessage)',
      result: { decision: 'deny', reason: 'observed unsafe', source: 'codex:posttooluse' },
      kind: 'after_tool_call',
    },
    {
      name: 'UserPromptSubmit allow + additionalContext',
      result: { decision: 'allow', additionalContext: 'inject principle', source: 'codex:userpromptsubmit' },
      kind: 'before_prompt_build',
    },
    {
      name: 'SessionStart allow + additionalContext',
      result: { decision: 'allow', additionalContext: 'hydration', source: 'codex:sessionstart' },
      kind: 'session_start',
    },
  ];

  for (const c of cases) {
    it(`${c.name} — output fields are all whitelisted`, () => {
      const out = adapter.encodeOutput(c.result, c.kind);
      const check = codexOutputFieldsAreWhitelisted(out);
      expect(check.ok).toBe(true);
      expect(check.violators).toEqual([]);
    });
  }

  it('whitelist rejects unknown fields (synthetic violation)', () => {
    const synthetic = { continue: true, bogusField: 'oops' };
    const check = codexOutputFieldsAreWhitelisted(synthetic);
    expect(check.ok).toBe(false);
    expect(check.violators).toContain('bogusField');
  });

  it('whitelist rejects non-object output', () => {
    expect(codexOutputFieldsAreWhitelisted(null).ok).toBe(false);
    expect(codexOutputFieldsAreWhitelisted('string').ok).toBe(false);
    expect(codexOutputFieldsAreWhitelisted([1, 2]).ok).toBe(false);
  });
});

describe('Codex output — permissionDecision never "ask" (gate-critical)', () => {
  // Even if business logic returns a weird decision, the encoder must NEVER
  // emit permissionDecision: "ask" — it unconditionally generates invalid_reason
  // (output_parser.rs:445-447), which is fail-OPEN (the tool PROCEEDS).
  it('decision "allow" → permissionDecision "allow" (never "ask")', () => {
    const out = adapter.encodeOutput({ decision: 'allow', source: 'x' }, 'before_tool_call') as {
      permissionDecision: string;
    };
    expect(out.permissionDecision).toBe('allow');
  });

  it('decision "observe" → permissionDecision "allow" (never "ask")', () => {
    const out = adapter.encodeOutput({ decision: 'observe', source: 'x' }, 'before_tool_call') as {
      permissionDecision: string;
    };
    expect(out.permissionDecision).toBe('allow');
  });

  it('decision "modify" → throws (Codex cannot rewrite tool input)', () => {
    expect(() =>
      adapter.encodeOutput(
        { decision: 'modify', modifiedInput: { x: 1 }, source: 'x' },
        'before_tool_call',
      ),
    ).toThrow(/modifiedInput/);
  });
});
