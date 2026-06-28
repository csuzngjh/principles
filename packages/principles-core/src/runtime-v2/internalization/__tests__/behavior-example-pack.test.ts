/**
 * PRI-484 — Phase 5 BehaviorExamplePack tests (behavior-example-pack.ts)
 *
 * Strict TDD: this file was written BEFORE the implementation. It pins
 * the public surface (BehaviorExamplePack type + validator) and the
 * critical invariants from spec §7.2 + the ticket acceptance criteria.
 *
 * ERR coverage:
 *   - ERR-001 (unknown validation): validator is fed hostile primitives
 *     (null, arrays, wrong types) and must reject them.
 *   - ERR-069 (Artificer shared schema): fail loud on invalid pack,
 *     no silent fallback to empty pack.
 *   - ERR-076 (structural validation): prototype-pollution keys
 *     (__proto__, constructor, prototype) are rejected by structure.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §7.2
 */
import { describe, it, expect } from 'vitest';
import {
  validateBehaviorExamplePack,
} from '../behavior-example-pack.js';
import type {
  BehaviorExamplePack,
} from '../behavior-example-pack.js';
import type { GoldenTraceCaseInput } from '../artificer-output.js';

// ── helpers ───────────────────────────────────────────────────────────────

function makeNegativeCase(overrides: Partial<GoldenTraceCaseInput> = {}): GoldenTraceCaseInput {
  return {
    caseId: 'neg-1',
    kind: 'negative',
    toolName: 'write_file',
    params: { path: 'src/a.ts' },
    expectedDecision: 'block',
    ...overrides,
  };
}

function makePositiveCase(overrides: Partial<GoldenTraceCaseInput> = {}): GoldenTraceCaseInput {
  return {
    caseId: 'pos-1',
    kind: 'positive',
    toolName: 'write_file',
    params: { path: 'src/b.ts' },
    expectedDecision: 'allow',
    ...overrides,
  };
}

function makeValidPack(overrides: Partial<BehaviorExamplePack> = {}): BehaviorExamplePack {
  return {
    sourceNegativeCase: makeNegativeCase(),
    ownerDesiredOutcome: 'Owner wants to block writes to src/a.ts without prior read',
    positiveCounterexamples: [makePositiveCase()],
    evidenceRefs: ['pain-001'],
    redactionNotes: [],
    ...overrides,
  };
}

// ── A. validateBehaviorExamplePack — happy path ───────────────────────────

describe('PRI-484 BehaviorExamplePack validator — happy path', () => {
  it('accepts a minimal valid pack (1 negative + 1 positive + 1 evidenceRef)', () => {
    const pack = makeValidPack();
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a boundary pack (3 positives + 5 evidenceRefs)', () => {
    const pack = makeValidPack({
      positiveCounterexamples: [
        makePositiveCase({ caseId: 'pos-1' }),
        makePositiveCase({ caseId: 'pos-2' }),
        makePositiveCase({ caseId: 'pos-3' }),
      ],
      evidenceRefs: ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5'],
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(true);
  });

  it('accepts a pack with empty redactionNotes', () => {
    const pack = makeValidPack({ redactionNotes: [] });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(true);
  });
});

// ── B. positiveCounterexamples boundary ───────────────────────────────────

describe('PRI-484 BehaviorExamplePack validator — positiveCounterexamples boundary', () => {
  it('rejects >3 positives (4 positives)', () => {
    const pack = makeValidPack({
      positiveCounterexamples: [
        makePositiveCase({ caseId: 'pos-1' }),
        makePositiveCase({ caseId: 'pos-2' }),
        makePositiveCase({ caseId: 'pos-3' }),
        makePositiveCase({ caseId: 'pos-4' }),
      ],
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('positiveCounterexamples'))).toBe(true);
  });

  it('rejects empty positiveCounterexamples (≥1 required)', () => {
    const pack = makeValidPack({ positiveCounterexamples: [] });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('positiveCounterexamples'))).toBe(true);
  });

  it('rejects positiveCounterexamples with wrong kind (negative instead of positive)', () => {
    const pack = makeValidPack({
      positiveCounterexamples: [makeNegativeCase({ caseId: 'pos-1', kind: 'negative' })],
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('positive'))).toBe(true);
  });
});

// ── C. evidenceRefs boundary ──────────────────────────────────────────────

describe('PRI-484 BehaviorExamplePack validator — evidenceRefs boundary', () => {
  it('rejects >5 evidenceRefs (6 refs)', () => {
    const pack = makeValidPack({
      evidenceRefs: ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6'],
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('evidenceRefs'))).toBe(true);
  });

  it('rejects empty evidenceRefs (≥1 required)', () => {
    const pack = makeValidPack({ evidenceRefs: [] });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('evidenceRefs'))).toBe(true);
  });

  it('rejects evidenceRefs with non-string element', () => {
    const pack = makeValidPack({
      evidenceRefs: ['ref-1', 123 as unknown as string],
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('evidenceRefs'))).toBe(true);
  });
});

// ── D. ownerDesiredOutcome ────────────────────────────────────────────────

describe('PRI-484 BehaviorExamplePack validator — ownerDesiredOutcome', () => {
  it('rejects empty ownerDesiredOutcome', () => {
    const pack = makeValidPack({ ownerDesiredOutcome: '' });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ownerDesiredOutcome'))).toBe(true);
  });

  it('rejects whitespace-only ownerDesiredOutcome', () => {
    const pack = makeValidPack({ ownerDesiredOutcome: '   ' });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ownerDesiredOutcome'))).toBe(true);
  });

  it('rejects non-string ownerDesiredOutcome', () => {
    const pack = makeValidPack({ ownerDesiredOutcome: 123 as unknown as string });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ownerDesiredOutcome'))).toBe(true);
  });
});

// ── E. sourceNegativeCase ─────────────────────────────────────────────────

describe('PRI-484 BehaviorExamplePack validator — sourceNegativeCase', () => {
  it('rejects missing sourceNegativeCase', () => {
    const pack = makeValidPack();
    delete (pack as Record<string, unknown>).sourceNegativeCase;
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceNegativeCase'))).toBe(true);
  });

  it('rejects sourceNegativeCase with wrong kind (positive instead of negative)', () => {
    const pack = makeValidPack({
      sourceNegativeCase: makePositiveCase({ caseId: 'neg-1', kind: 'positive' }),
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceNegativeCase'))).toBe(true);
  });

  it('rejects sourceNegativeCase with empty caseId', () => {
    const pack = makeValidPack({
      sourceNegativeCase: makeNegativeCase({ caseId: '' }),
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('sourceNegativeCase'))).toBe(true);
  });
});

// ── F. redactionNotes ────────────────────────────────────────────────────

describe('PRI-484 BehaviorExamplePack validator — redactionNotes', () => {
  it('rejects non-array redactionNotes', () => {
    const pack = makeValidPack({ redactionNotes: 'not-an-array' as unknown as string[] });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('redactionNotes'))).toBe(true);
  });

  it('rejects redactionNotes with non-string element', () => {
    const pack = makeValidPack({
      redactionNotes: ['note-1', 456 as unknown as string],
    });
    const result = validateBehaviorExamplePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('redactionNotes'))).toBe(true);
  });
});

// ── G. hostile input — ERR-001 / ERR-076 ─────────────────────────────────

describe('PRI-484 BehaviorExamplePack validator — hostile input (ERR-001 / ERR-076)', () => {
  it('rejects null', () => {
    const result = validateBehaviorExamplePack(null);
    expect(result.valid).toBe(false);
  });

  it('rejects undefined', () => {
    const result = validateBehaviorExamplePack(undefined);
    expect(result.valid).toBe(false);
  });

  it('rejects array', () => {
    const result = validateBehaviorExamplePack([]);
    expect(result.valid).toBe(false);
  });

  it('rejects string', () => {
    const result = validateBehaviorExamplePack('not-an-object');
    expect(result.valid).toBe(false);
  });

  it('rejects object with __proto__ key (prototype pollution)', () => {
    const pack = makeValidPack();
    const hostile = JSON.parse(JSON.stringify(pack));
    Object.defineProperty(hostile, '__proto__', { value: 'polluted', enumerable: true });
    const result = validateBehaviorExamplePack(hostile);
    expect(result.valid).toBe(false);
  });

  it('rejects object with constructor key (prototype pollution)', () => {
    const pack = makeValidPack();
    const hostile = { ...pack, constructor: 'polluted' };
    const result = validateBehaviorExamplePack(hostile);
    expect(result.valid).toBe(false);
  });
});
