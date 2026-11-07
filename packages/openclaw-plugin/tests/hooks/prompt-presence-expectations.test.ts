import { describe, expect, it } from 'vitest';
import { renderPrinciplesToDirectives } from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { buildInjectedExpectations, normalizeForWireMatch } from '../../src/hooks/prompt-presence-expectations.js';

const BODY = '产出闭环验证：交付前必须以可观察证据校验产物新鲜度与正确性';

describe('buildInjectedExpectations (target double-escape regression)', () => {
  it('does not re-escape the already-rendered target directive (real renderer output)', () => {
    const rawBody = '必须将 "auto-fix" <b>关闭</b>，并保留 & 符号与 <tag>';
    const rendered = renderPrinciplesToDirectives(
      [{ principleId: 'p-target', text: rawBody, artifactId: 'art-t', activationId: 'act-t', authority: 'owner' }],
      new Set(['p-target']),
      { escapeFn: escapeXml },
    );
    const directiveSlice = rendered.slice(
      rendered.indexOf('<directive '),
      rendered.indexOf('</directive>') + '</directive>'.length,
    );
    // The renderer already escaped the body inside the directive: the slice is
    // exactly what assembly embeds. Re-escaping it must not happen.
    expect(directiveSlice).toContain(escapeXml(rawBody));
    expect(directiveSlice).not.toContain(escapeXml(escapeXml(rawBody)));
    const out = buildInjectedExpectations({
      finalAssembly: `governance header\n${directiveSlice}\nplain other body\ntail`,
      target: { activationId: 'act-t', body: directiveSlice, preEscaped: true },
      rendered: [{ activationId: 'act-other', body: 'plain other body' }],
      escape: escapeXml,
    });
    const target = out?.expectations.find((e) => e.activationId === 'act-t');
    expect(target).toBeDefined();
    expect(target?.bodyComplete).toBe(true);
    expect(target?.bodyText).toBe(directiveSlice);
    const other = out?.expectations.find((e) => e.activationId === 'act-other');
    expect(other?.bodyComplete).toBe(true);
    expect(other?.bodyText).toContain('plain other body');
  });

  it('raw rendered-path bodies still get escaped exactly once', () => {
    const rawBody = 'keep <this> & that';
    const out = buildInjectedExpectations({
      finalAssembly: `x ${escapeXml(rawBody)} y`,
      target: undefined,
      rendered: [{ activationId: 'act-raw', body: rawBody }],
      escape: escapeXml,
    });
    expect(out?.expectations[0]).toMatchObject({ activationId: 'act-raw', bodyComplete: true });
    expect(out?.expectations[0]?.bodyText).toBe(escapeXml(rawBody));
  });
});

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

  it('pinned: output entries are never empty-bodied and overflow never materializes entries', () => {
    // Mixed candidates: a valid one, an empty one, and enough entries to hit the cap.
    const rendered = [
      { activationId: 'act_valid', body: 'real body' },
      { activationId: 'act_empty', body: '   ' },
      ...Array.from({ length: 80 }, (_, i) => ({ activationId: `act_bulk_${i}`, body: `bulk ${i}` })),
    ];
    const out = buildInjectedExpectations({
      finalAssembly: 'real body ' + Array.from({ length: 80 }, (_, i) => `bulk ${i}`).join(' '),
      target: undefined,
      rendered,
      escape: (t) => t,
    });
    expect(out?.expectations.length).toBeLessThanOrEqual(64);
    expect(out?.overflowCount).toBeGreaterThanOrEqual(17);
    for (const entry of out?.expectations ?? []) {
      // No invalid (empty) entries may masquerade as expectations.
      expect(entry.bodyText.trim().length).toBeGreaterThan(0);
      expect(entry.bodyComplete === true || entry.bodyComplete === false).toBe(true);
    }
    expect(out?.expectations.find((e) => e.activationId === 'act_valid')).toMatchObject({
      bodyComplete: true,
    });
    // act_empty was skipped, not emitted as an invalid expectation.
    expect(out?.expectations.find((e) => e.activationId === 'act_empty')).toBeUndefined();
  });
});
