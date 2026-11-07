import { describe, expect, it } from 'vitest';
import { buildInjectedExpectations, normalizeForWireMatch } from '../../src/hooks/prompt-presence-expectations.js';

const BODY = '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性';

describe('buildInjectedExpectations (prompt presence forensics)', () => {
  it('marks complete bodies and judges containment against the post-guard assembly', () => {
    const out = buildInjectedExpectations({
      assembledPrependSystemContext: `header\n${BODY}\ntail`,
      target: { activationId: 'act_prompt_target', body: BODY },
      rendered: [],
    });
    expect(out).toHaveLength(1);
    expect(out?.[0]).toMatchObject({
      activationId: 'act_prompt_target',
      bodyComplete: true,
      revision: 'unknown',
    });
    expect(out?.[0]?.bodyText).toBe(BODY);
  });

  it('marks truncated fragments bodyComplete=false (never yields full_hit)', () => {
    const fragment = BODY.slice(0, 20);
    const out = buildInjectedExpectations({
      assembledPrependSystemContext: fragment,
      target: { activationId: 'act_prompt_target', body: BODY },
      rendered: [],
    });
    expect(out?.[0]?.bodyComplete).toBe(false);
    expect(out?.[0]?.bodyText).toBe(BODY);
  });

  it('deduplicates the target against the rendered path and keeps order', () => {
    const out = buildInjectedExpectations({
      assembledPrependSystemContext: `${BODY}\nsecond body`,
      target: { activationId: 'act_target', body: BODY },
      rendered: [
        { activationId: 'act_target', body: BODY },
        { activationId: 'act_second', body: 'second body' },
      ],
    });
    expect(out?.map((e) => e.activationId)).toEqual(['act_target', 'act_second']);
  });

  it('normalizes CRLF and trailing whitespace before containment (host parity)', () => {
    const bodyWithCrlf = BODY.replace(/\n/g, '\r\n') + '   ';
    const assembled = `header\r\n${BODY}\r\n`;
    const out = buildInjectedExpectations({
      assembledPrependSystemContext: assembled,
      target: { activationId: 'act_prompt_target', body: bodyWithCrlf },
      rendered: [],
    });
    expect(normalizeForWireMatch(bodyWithCrlf)).toBe(BODY);
    expect(out?.[0]?.bodyComplete).toBe(true);
    expect(out?.[0]?.bodyText).toBe(BODY);
  });

  it('returns undefined for empty assemblies and skips empty bodies', () => {
    expect(
      buildInjectedExpectations({ assembledPrependSystemContext: '', target: undefined, rendered: [] }),
    ).toBeUndefined();
    expect(
      buildInjectedExpectations({
        assembledPrependSystemContext: 'text',
        target: undefined,
        rendered: [{ activationId: 'act_x', body: '   ' }],
      }),
    ).toBeUndefined();
  });

  it('caps the expectation set at 64 entries', () => {
    const rendered = Array.from({ length: 70 }, (_, i) => ({
      activationId: `act_${i}`,
      body: `body ${i}`,
    }));
    const out = buildInjectedExpectations({
      assembledPrependSystemContext: rendered.map((r) => r.body).join('\n'),
      target: undefined,
      rendered,
    });
    expect(out).toHaveLength(64);
  });

  it('fails open: invalid input never throws', () => {
    expect(() =>
      buildInjectedExpectations({
        assembledPrependSystemContext: null as unknown as string,
        target: undefined,
        rendered: null as unknown as { activationId: string; body: string }[],
      }),
    ).not.toThrow();
  });
});
