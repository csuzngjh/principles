/**
 * PRI-439 — consistency proof: artificer-output-typebox.ts (typebox) matches
 * artificer-output.ts (@sinclair/typebox) ArtificerRuleOutputSchema.
 *
 * Mirrors dreamer-output-typebox.test.ts: for a shared sample set (valid +
 * invalid candidates), both schemas must accept/reject the same shapes. No `as`,
 * no cast — the proof is behavioural.
 *
 * Boundary: pure test, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { Value as SinclairValue } from '@sinclair/typebox/value';
import { Value as TypeboxValue } from 'typebox/value';
import { ArtificerRuleOutputSchema } from '../../internalization/artificer-output.js';
import {
  ArtificerRuleOutputTypebox,
  GoldenTraceCaseInputTypebox,
} from '../artificer-output-typebox.js';

// Minimal valid sample — extended/modified per test case.
const VALID_OUTPUT = {
  taskId: 'task-001',
  sourceScribeArtifactId: 'pi-art-scribe-001',
  implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
  goldenTraceCases: [
    { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/x' }, expectedDecision: 'block' },
    { caseId: 'positive-1', kind: 'positive', toolName: 'read', params: { path: '/tmp/y' }, expectedDecision: 'allow' },
  ],
  affectedTools: ['edit'],
  implementationSummary: 'Block writes to system dirs',
  risks: [],
  sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
  generatedAt: '2026-06-17T00:00:00.000Z',
};

function checkSinclair(value: unknown): boolean {
  return SinclairValue.Check(ArtificerRuleOutputSchema, value);
}

function checkTypebox(value: unknown): boolean {
  return TypeboxValue.Check(ArtificerRuleOutputTypebox, value);
}

describe('PRI-439 artificer-output-typebox consistency with @sinclair/typebox schema', () => {
  it('both schemas accept the valid sample', () => {
    expect(checkSinclair(VALID_OUTPUT)).toBe(true);
    expect(checkTypebox(VALID_OUTPUT)).toBe(true);
  });

  it('both schemas reject missing implementationCode', () => {
    const bad = { ...VALID_OUTPUT, implementationCode: undefined };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject empty implementationCode', () => {
    const bad = { ...VALID_OUTPUT, implementationCode: '' };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject missing taskId', () => {
    const bad = { ...VALID_OUTPUT, taskId: undefined };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject empty affectedTools', () => {
    const bad = { ...VALID_OUTPUT, affectedTools: [] };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject fewer than 2 goldenTraceCases', () => {
    const bad = { ...VALID_OUTPUT, goldenTraceCases: [VALID_OUTPUT.goldenTraceCases[0]] };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject more than 10 goldenTraceCases', () => {
    const cases = Array.from({ length: 11 }, (_, i) => ({
      caseId: `case-${i}`,
      kind: i % 2 === 0 ? 'positive' : 'negative',
      toolName: 'edit',
      params: { path: `/p/${i}` },
      expectedDecision: i % 2 === 0 ? 'allow' : 'block',
    }));
    const bad = { ...VALID_OUTPUT, goldenTraceCases: cases };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject invalid kind', () => {
    const bad = {
      ...VALID_OUTPUT,
      goldenTraceCases: [
        { ...VALID_OUTPUT.goldenTraceCases[0], kind: 'invalid' },
        VALID_OUTPUT.goldenTraceCases[1],
      ],
    };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject invalid expectedDecision', () => {
    const bad = {
      ...VALID_OUTPUT,
      goldenTraceCases: [
        { ...VALID_OUTPUT.goldenTraceCases[0], expectedDecision: 'invalid' },
        VALID_OUTPUT.goldenTraceCases[1],
      ],
    };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject missing sourceTrace', () => {
    const bad = { ...VALID_OUTPUT, sourceTrace: undefined };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas reject missing implementationSummary', () => {
    const bad = { ...VALID_OUTPUT, implementationSummary: undefined };
    expect(checkSinclair(bad)).toBe(false);
    expect(checkTypebox(bad)).toBe(false);
  });

  it('both schemas accept optional philosopherArtifactId in sourceTrace', () => {
    const good = {
      ...VALID_OUTPUT,
      sourceTrace: { scribeArtifactId: 'pi-art-scribe-001', philosopherArtifactId: 'pi-art-phil-001' },
    };
    expect(checkSinclair(good)).toBe(true);
    expect(checkTypebox(good)).toBe(true);
  });

  it('both schemas accept optional expectedProposedParams + expectedApplicationMode on a case', () => {
    const good = {
      ...VALID_OUTPUT,
      goldenTraceCases: [
        ...VALID_OUTPUT.goldenTraceCases,
        {
          caseId: 'correction-1',
          kind: 'negative',
          toolName: 'edit',
          params: { path: '/tmp/z' },
          expectedDecision: 'propose_correction',
          expectedProposedParams: { path: '/workspace/z' },
          expectedApplicationMode: 'shadow',
        },
      ],
    };
    expect(checkSinclair(good)).toBe(true);
    expect(checkTypebox(good)).toBe(true);
  });
});

describe('PRI-439 GoldenTraceCaseInputTypebox standalone', () => {
  it('accepts a valid case', () => {
    const valid = VALID_OUTPUT.goldenTraceCases[0];
    expect(TypeboxValue.Check(GoldenTraceCaseInputTypebox, valid)).toBe(true);
  });

  it('rejects a case missing caseId', () => {
    const bad = { ...VALID_OUTPUT.goldenTraceCases[0], caseId: undefined };
    expect(TypeboxValue.Check(GoldenTraceCaseInputTypebox, bad)).toBe(false);
  });
});
