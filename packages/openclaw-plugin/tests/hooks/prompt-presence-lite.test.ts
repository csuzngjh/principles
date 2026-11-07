import { describe, expect, it } from 'vitest';
import { checkAssemblyPresence } from '../../src/hooks/prompt-presence-lite.js';

const BODY = '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性';

function expectation(overrides: Partial<{ activationId: string; bodyText: string; bodyChars: number; bodyComplete: boolean }> = {}) {
  return {
    activationId: 'act_target',
    bodyText: BODY,
    bodyChars: BODY.length,
    bodyComplete: true,
    ...overrides,
  };
}

describe('prompt presence lite checker (Path A minimal, single-string observation)', () => {
  it('full_hit when the frozen body is contained in the observed system prompt', () => {
    const check = checkAssemblyPresence({
      observedText: `governance\n${BODY}\ntail`,
      expectations: [expectation()],
    });
    expect(check.checked).toBe(true);
    expect(check.results[0]).toMatchObject({ outcome: 'full_hit', activationId: 'act_target' });
    expect(check.observationChars).toBe(`governance\n${BODY}\ntail`.length);
  });

  it('checked_missing when the complete body is absent', () => {
    const check = checkAssemblyPresence({ observedText: 'no principles here', expectations: [expectation()] });
    expect(check.results[0]?.outcome).toBe('checked_missing');
  });

  it('invalid_body: empty/whitespace body is unknown, never a vacuous hit', () => {
    for (const body of ['', '   \n\t ']) {
      const check = checkAssemblyPresence({
        observedText: 'anything at all',
        expectations: [expectation({ bodyText: body, bodyChars: body.length })],
      });
      expect(check.results[0]).toMatchObject({ outcome: 'unknown', reason: 'invalid_body' });
    }
  });

  it('assembly_truncated: a fragment is unknown and never a full_hit', () => {
    const check = checkAssemblyPresence({
      observedText: BODY.slice(0, 20),
      expectations: [expectation({ bodyComplete: false })],
    });
    expect(check.results[0]).toMatchObject({ outcome: 'unknown', reason: 'assembly_truncated' });
  });

  it('body over the limit is unknown (never a truncated match)', () => {
    const check = checkAssemblyPresence({
      observedText: 'short',
      expectations: [expectation({ bodyText: 'z'.repeat(128 * 1024), bodyChars: 128 * 1024 })],
    });
    expect(check.results[0]).toMatchObject({ outcome: 'unknown', reason: 'body_over_limit' });
  });

  it('observation over the scan ceiling degrades every expectation to unknown', () => {
    const check = checkAssemblyPresence({
      observedText: 'q'.repeat(33 * 1024 * 1024),
      expectations: [expectation()],
    });
    expect(check.results[0]).toMatchObject({ outcome: 'unknown', reason: 'observation_over_limit' });
    expect(check.limitsExceeded?.observationChars).toBeGreaterThan(32 * 1024 * 1024);
  });

  it('unparseable observation (non-string) is reported, not treated as absence', () => {
    const check = checkAssemblyPresence({ observedText: undefined, expectations: [expectation()] });
    expect(check.checked).toBe(false);
    expect(check.observationChars).toBe(0);
  });

  it('internal failure surfaces as check_failed without throwing', () => {
    const poisoned = {
      activationId: 'act_bad',
      get bodyText(): string {
        throw new Error('poisoned getter');
      },
      bodyChars: 5,
      bodyComplete: true,
    };
    const check = checkAssemblyPresence({ observedText: 'text', expectations: [poisoned] });
    expect(check.results[0]).toMatchObject({ outcome: 'unknown', reason: 'check_failed' });
    expect(check.checkFailedReason).toContain('exception');
  });

  it('empty expectation set: checked=true with zero results (the registry/handler layer reports empty_snapshot separately)', () => {
    const check = checkAssemblyPresence({ observedText: 'text', expectations: [] });
    expect(check.checked).toBe(true);
    expect(check.results).toHaveLength(0);
  });

  it('result output is bounded at MAX_RESULTS', () => {
    const expectations = Array.from({ length: 100 }, (_, i) =>
      expectation({ activationId: `act_${i}`, bodyText: `body ${i}` }));
    const check = checkAssemblyPresence({
      observedText: 'body 0 body 1',
      expectations,
    });
    expect(check.results.length).toBeLessThanOrEqual(64);
  });
});
