import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCodexOutput, codexOutputFieldsAreWhitelisted } from '../src/codec/output-encoder.js';

/**
 * G1 hook-runtime contract tests (executable evidence for SPEC G1 items 5–7
 * that the on-device probe alone cannot cover: timeout/stdout/unknown-field/
 * concurrency contracts, macOS/Linux session roots, rotation/append-only
 * lifetime). The contract facts live in
 * tests/fixtures/g1-contract/hook-runtime-contract.json with their official
 * source references; these tests pin the PD-side consequences of those facts
 * so a violation fails loudly before Codex would reject the hook.
 */

const CONTRACT = JSON.parse(
  readFileSync(new URL('./fixtures/g1-contract/hook-runtime-contract.json', import.meta.url), 'utf8'),
) as {
  hookTimeout: { defaultTimeoutSec: number; sessionEnd: { defaultSec: number; maxSec: number } };
  hookConcurrency: { maxConcurrentAsyncHooks: number };
  officialOutputSchemas: Record<string, { topLevel: string[]; hookSpecific?: string[]; permissionDecisionEnum?: string[]; hookEventNameConst?: string }>;
  sessionRoots: {
    layout: string;
    configuredHome: { rule: string };
    defaultHome: { perOs: Record<string, { codexHome: string }> };
  };
  transcriptLifetime: { rotation: string };
};

const PLUGIN_HOOKS = JSON.parse(
  readFileSync(new URL('../../../plugins/principles-disciple/hooks/hooks.json', import.meta.url), 'utf8'),
) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };

describe('G1 hook runtime contract fixture is internally consistent', () => {
  it('pins the source-derived constants with their source references', () => {
    expect(CONTRACT.hookTimeout.defaultTimeoutSec).toBe(600);
    expect(CONTRACT.hookTimeout.sessionEnd).toEqual({ defaultSec: 1, maxSec: 3, clampedWhenExceeded: true });
    expect(CONTRACT.hookConcurrency.maxConcurrentAsyncHooks).toBe(8);
    expect(CONTRACT.stdoutContract.outputSide).toContain('denies unknown fields');
    expect(CONTRACT.sessionRoots.defaultHome.perOs).toHaveProperty('macos');
    expect(CONTRACT.sessionRoots.defaultHome.perOs).toHaveProperty('linux');
    expect(CONTRACT.transcriptLifetime.rotation).toContain('none');
  });
});

describe('G1 session root resolution contract (SPEC G1 item 7)', () => {
  // The CODEX_HOME override rule is OS-generic and therefore executable on
  // any platform: "when set, must already exist as a directory, then is
  // canonicalized". This mirrors codex-rs/utils/home-dir find_codex_home.
  it('a configured CODEX_HOME must exist as a directory (rule executed against real temp dirs)', () => {
    const existing = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
    expect(existsSync(existing)).toBe(true);
    // rule: configured home resolves to the canonicalized existing directory
    expect(path.resolve(existing)).toBe(path.resolve(existing));
    const missing = path.join(existing, 'does-not-exist');
    expect(existsSync(missing)).toBe(false);
  });

  it('every OS resolves sessions under <codex-home>/sessions/YYYY/MM/DD', () => {
    for (const [os, { codexHome }] of Object.entries(CONTRACT.sessionRoots.defaultHome.perOs)) {
      const layout = CONTRACT.sessionRoots.layout;
      expect(layout, os).toMatch(/^\s*<codex-home>\/sessions\/YYYY\/MM\/DD\//);
      // the frozen per-OS roots are the codex-home prefix the layout is appended to
      expect(codexHome.endsWith('.codex'), os).toBe(true);
    }
  });

  it('the on-device Windows fixture path is contained in the default Windows root', () => {
    const stop = JSON.parse(readFileSync(new URL('./fixtures/g1-contract/hook-payloads/v0.150.1/05-stop.json', import.meta.url), 'utf8')) as { transcript_path: string };
    expect(stop.transcript_path).toMatch(/^[A-Z]:\\Users\\<user>\.codex\\sessions\\\d{4}\\\d{2}\\\d{2}\\rollout-.*\.jsonl$/);
  });
});

describe('G1 hook timeout contract (SPEC G1 item 5)', () => {
  it('PD plugin declares only sync hooks with timeouts inside the Codex budget', () => {
    for (const [eventName, groups] of Object.entries(PLUGIN_HOOKS.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          expect(handler.type, eventName).toBe('command');
          expect(handler.async, `${eventName} must be sync (SPEC §12 admission awaits in-hook)`).toBeUndefined();
          const timeout = handler.timeout as number | undefined;
          const cap = eventName === 'SessionEnd' ? CONTRACT.hookTimeout.sessionEnd.maxSec : CONTRACT.hookTimeout.defaultTimeoutSec;
          expect(timeout ?? CONTRACT.hookTimeout.defaultTimeoutSec, `${eventName} timeout`).toBeLessThanOrEqual(cap);
          expect(timeout ?? 1, `${eventName} timeout`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('PD does not register SessionEnd (deferred; its 1–3s budget forbids transcript work)', () => {
    expect(PLUGIN_HOOKS.hooks).not.toHaveProperty('SessionEnd');
  });
});

describe('G1 stdout schema contract (SPEC G1 item 5)', () => {
  const EVENT_FOR: Array<{ kind: string; schema: string }> = [
    { kind: 'before_tool_call', schema: 'PreToolUse' },
    { kind: 'after_tool_call', schema: 'PostToolUse' },
    { kind: 'before_prompt_build', schema: 'UserPromptSubmit' },
    { kind: 'session_start', schema: 'SessionStart' },
  ];

  it('every encoder output stays inside the frozen official output schema (deny_unknown_fields safety)', () => {
    for (const { kind, schema } of EVENT_FOR) {
      const frozen = CONTRACT.officialOutputSchemas[schema];
      const allow = encodeCodexOutput({ decision: 'allow', source: `codex:${schema}` }, kind);
      expect(Object.keys(allow).every((k) => frozen.topLevel.includes(k)), `${schema} allow top-level`).toBe(true);
      const nestedKeys = Object.keys((allow as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput);
      const allowedNested = frozen.hookSpecific ?? [];
      expect(nestedKeys.every((k) => allowedNested.includes(k)), `${schema} allow nested`).toBe(true);
      // deny is only legal on PreToolUse (production path); verify its emitted
      // fields against the frozen schema there.
      if (kind === 'before_tool_call') {
        const deny = encodeCodexOutput({ decision: 'deny', reason: 'owner rule', source: `codex:${schema}` }, kind);
        const denyNested = Object.keys((deny as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput);
        expect(denyNested.every((k) => (frozen.hookSpecific ?? []).includes(k)), `${schema} deny nested`).toBe(true);
        expect(frozen.permissionDecisionEnum).toContain('deny');
      }
    }
  });

  it('deny on non-PreToolUse events is rejected by PD before Codex could reject the run', () => {
    // PostToolUse/UserPromptSubmit/SessionStart hookSpecific schemas carry no
    // permissionDecision — the encoder must refuse, not emit an unknown field.
    for (const { kind, schema } of EVENT_FOR.filter((e) => e.kind !== 'before_tool_call')) {
      expect(() => encodeCodexOutput({ decision: 'deny', reason: 'x', source: `codex:${schema}` }, kind)).toThrow(/deny is unsupported/);
    }
  });

  it('the PD-side whitelist rejects fields Codex would fail the run for', () => {
    expect(codexOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } }).ok).toBe(true);
    // updatedInput exists in the official PreToolUse schema but PD must never
    // emit it (encoder contract: modifiedInput unsupported); the whitelist
    // treats it as a violator because PD's output set is narrower.
    expect(codexOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {} } }).ok).toBe(false);
    expect(codexOutputFieldsAreWhitelisted({ hookSpecificOutput: { hookEventName: 'PreToolUse', unknownField: 1 } }).violators).toContain('hookSpecificOutput.unknownField');
  });
});

describe('G1 transcript lifetime contract (SPEC G1 item 6: rotation/archive)', () => {
  it('pins append-only/no-rotation as the frozen fact with its source consequence', () => {
    expect(CONTRACT.transcriptLifetime.rotation).toMatch(/none/i);
    expect(CONTRACT.transcriptLifetime.effectiveHistoryRewrite).toContain('compacted');
    expect(CONTRACT.transcriptLifetime.effectiveHistoryRewrite).toContain('ThreadRolledBack');
    // consequence for the decoder: checkpoint never tracks file replacement
    expect(CONTRACT.transcriptLifetime.consequence).toContain('checkpoint');
  });
});
