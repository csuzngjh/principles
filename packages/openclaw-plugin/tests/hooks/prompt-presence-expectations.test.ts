import { describe, expect, it } from 'vitest';
import { buildInjectedExpectations, normalizeForWireMatch } from '../../src/hooks/prompt-presence-expectations.js';

const BODY = '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性';

describe('buildInjectedExpectations (prompt presence forensics, review-round fixes)', () => {
  it('complete body present in the final assembly: bodyComplete=true', () => {
    const out = buildInjectedExpectations({
      finalAssembly: `header\n${BODY}\ntail`,
      target: { activationId: 'act_prompt_target', body: BODY },
      rendered: [],
    });
    expect(out?.overflowCount).toBe(0);
    expect(out?.expectations[0]).toMatchObject({
      activationId: 'act_prompt_target',
      bodyComplete: true,
      revision: 'unknown',
    });
  });

  it('truncation without fallback: pre-guard fragment is bodyComplete=false, never full_hit', () => {
    const preGuard = `header\n${BODY}\nmore that got stripped`;
    const out = buildInjectedExpectations({
      finalAssembly: BODY.slice(0, 20),
      preGuardAssembly: preGuard,
      target: { activationId: 'act_prompt_target', body: BODY },
      rendered: [],
    });
    expect(out?.expectations[0]).toMatchObject({
      activationId: 'act_prompt_target',
      bodyComplete: false,
    });
  });

  it('defect-3 fallback counterexamples: a removed target is excluded entirely', () => {
    // Final revalidation failure / deadline / final budget / target removed:
    // after restore the target body is in NEITHER the final assembly (replaced
    // by the native baseline) nor a pre-guard snapshot we may cite — excluded.
    const baselineOnly = 'baseline principle one\nbaseline principle two';
    const out = buildInjectedExpectations({
      finalAssembly: baselineOnly,
      target: { activationId: 'act_target_removed', body: BODY },
      rendered: [
        { activationId: 'act_baseline_1', body: 'baseline principle one' },
        { activationId: 'act_baseline_2', body: 'baseline principle two' },
      ],
    });
    expect(out?.expectations.map((e) => e.activationId)).toEqual(['act_baseline_1', 'act_baseline_2']);
  });

  it('pre-guard classification is suppressed after a fallback (no stale fragments)', () => {
    // If a caller wrongly passes the pre-guard snapshot after a restore, the
    // helper would resurrect removed bodies — so the hook omits it; this test
    // pins that omitting preGuardAssembly excludes removed entries.
    const out = buildInjectedExpectations({
      finalAssembly: 'baseline principle one',
      target: { activationId: 'act_target_removed', body: BODY },
      rendered: [{ activationId: 'act_baseline_1', body: 'baseline principle one' }],
    });
    expect(out?.expectations.map((e) => e.activationId)).toEqual(['act_baseline_1']);
  });

  it('deduplicates the target against the rendered path and keeps order', () => {
    const out = buildInjectedExpectations({
      finalAssembly: `${BODY}\nsecond body`,
      target: { activationId: 'act_target', body: BODY },
      rendered: [
        { activationId: 'act_target', body: BODY },
        { activationId: 'act_second', body: 'second body' },
      ],
    });
    expect(out?.expectations.map((e) => e.activationId)).toEqual(['act_target', 'act_second']);
  });

  it('escape is applied to kept entries only and containment runs on the escaped text', () => {
    const rawBody = 'body with <tag> & "quote"';
    const escaped = rawBody
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const out = buildInjectedExpectations({
      finalAssembly: `prefix ${escaped} suffix`,
      target: undefined,
      rendered: [{ activationId: 'act_escaped', body: rawBody }],
      escape: (text) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    });
    expect(out?.expectations[0]?.bodyText).toBe(escaped);
    expect(out?.expectations[0]?.bodyComplete).toBe(true);
  });

  it('normalizes CRLF and trailing whitespace before containment (host parity)', () => {
    const bodyWithCrlf = BODY.replace(/\n/g, '\r\n') + '   ';
    const assembled = `header\r\n${BODY}\r\n`;
    const out = buildInjectedExpectations({
      finalAssembly: assembled,
      target: { activationId: 'act_prompt_target', body: bodyWithCrlf },
      rendered: [],
    });
    expect(normalizeForWireMatch(bodyWithCrlf)).toBe(BODY);
    expect(out?.expectations[0]?.bodyComplete).toBe(true);
    expect(out?.expectations[0]?.bodyText).toBe(BODY);
  });

  it('defect-4: collection cap keeps an overflow fact and stops materializing bodies', () => {
    const rendered = Array.from({ length: 70 }, (_, i) => ({
      activationId: `act_${i}`,
      body: `body ${i}`,
    }));
    let escapeCalls = 0;
    const out = buildInjectedExpectations({
      finalAssembly: rendered.map((r) => r.body).join('\n'),
      target: undefined,
      rendered,
      escape: (text) => {
        escapeCalls += 1;
        return text;
      },
    });
    expect(out?.expectations).toHaveLength(64);
    expect(out?.overflowCount).toBe(6);
    // Bounded collection: escape ran only for kept entries (+ target none).
    expect(escapeCalls).toBe(64);
  });

  it('returns undefined for empty assemblies and skips empty bodies', () => {
    expect(
      buildInjectedExpectations({ finalAssembly: '', target: undefined, rendered: [] }),
    ).toBeUndefined();
    expect(
      buildInjectedExpectations({
        finalAssembly: 'text',
        target: undefined,
        rendered: [{ activationId: 'act_x', body: '   ' }],
      }),
    ).toBeUndefined();
  });

  it('fails open: invalid input never throws', () => {
    expect(() =>
      buildInjectedExpectations({
        finalAssembly: null as unknown as string,
        target: undefined,
        rendered: null as unknown as { activationId: string; body: string }[],
      }),
    ).not.toThrow();
  });
});
