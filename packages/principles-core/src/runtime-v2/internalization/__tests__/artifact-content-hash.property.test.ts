/**
 * Property test for `canonicalStringify` / `computeContentHash` (design §6.1,
 * task 3.7).
 *
 * CP-08: canonical serialization determinism & explicit truncation
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.1, §16
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirement 2.12
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';

import { canonicalStringify, computeContentHash, CANONICAL_JSON_MAX_CHARS, type HashFn } from '../artifact-content-hash.js';

const sha256: HashFn = (input) => createHash('sha256').update(input).digest('hex');

/** Shuffles the key order of a plain object (not its nested values) deterministically-but-randomly. */
function shuffleKeys(obj: Record<string, unknown>, seed: number): Record<string, unknown> {
  const keys = Object.keys(obj);
  const shuffled = [...keys];
  // Simple deterministic Fisher-Yates using the seed, good enough for a test helper.
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = shuffled[i];
    const b = shuffled[j];
    if (a !== undefined && b !== undefined) {
      shuffled[i] = b;
      shuffled[j] = a;
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of shuffled) out[key] = obj[key];
  return out;
}

const jsonSafeValueGen = fc.jsonValue({ maxDepth: 3 });

/**
 * Safe key generator: produces only lowercase-alpha keys 1–6 chars long,
 * avoiding `__proto__` / `constructor` / `toString` and other built-in /
 * prototype-polluting keys. Without this, `fc.dictionary` can emit
 * `{ __proto__: ... }`, which changes object semantics when re-inserted in a
 * different key order — the root cause of a flaky run under heavy parallel
 * load. The canonical-stringify invariant itself is unaffected; this just
 * keeps the generated object shape well-defined.
 */
const safeKeyGen = fc.array(fc.nat({ max: 25 }), { minLength: 1, maxLength: 6 })
  .map((codePoints) => codePoints.map((cp) => String.fromCharCode(97 + (cp % 26))).join(''));

describe('canonicalStringify — CP-08 determinism & explicit truncation', () => {
  it('is invariant to top-level key insertion order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(safeKeyGen, jsonSafeValueGen, { minKeys: 1, maxKeys: 8 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (obj, seed) => {
          const shuffled = shuffleKeys(obj, seed);
          expect(canonicalStringify(shuffled).text).toBe(canonicalStringify(obj).text);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is invariant to nested key insertion order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const nested = { z: { b: 1, a: 2 }, a: { d: 3, c: 4 } };
        const shuffledOuter = shuffleKeys(nested, seed);
        const shuffledInner = {
          ...shuffledOuter,
          z: shuffleKeys(nested.z, seed + 1),
          a: shuffleKeys(nested.a, seed + 2),
        };
        expect(canonicalStringify(shuffledInner).text).toBe(canonicalStringify(nested).text);
      }),
      { numRuns: 50 },
    );
  });

  it('produces the same string for the same input across repeated calls', () => {
    fc.assert(
      fc.property(jsonSafeValueGen, (value) => {
        const first = canonicalStringify(value);
        const second = canonicalStringify(value);
        expect(second.text).toBe(first.text);
        expect(second.truncated).toBe(first.truncated);
      }),
      { numRuns: 200 },
    );
  });

  it('never throws on adversarial values (cycles, BigInt, functions, Symbols, Date, Map, Set, NaN)', () => {
    const cyclic: Record<string, unknown> = { name: 'cyclic' };
    cyclic.self = cyclic;

    const adversarial: readonly unknown[] = [
      cyclic,
      { big: 10n },
      { fn: () => 1 },
      { sym: Symbol('x') },
      { date: new Date('2026-01-01T00:00:00Z') },
      { map: new Map([['a', 1], ['b', 2]]) },
      { set: new Set([1, 2, 3]) },
      { nan: Number.NaN, inf: Number.POSITIVE_INFINITY, ninf: Number.NEGATIVE_INFINITY },
      { proto: { __proto__: { polluted: true } } },
      undefined,
      null,
    ];

    for (const value of adversarial) {
      expect(() => canonicalStringify(value)).not.toThrow();
      expect(() => computeContentHash(value, sha256)).not.toThrow();
    }
  });

  it('truncates deterministically and explicitly beyond CANONICAL_JSON_MAX_CHARS', () => {
    fc.assert(
      fc.property(fc.integer({ min: CANONICAL_JSON_MAX_CHARS + 1000, max: CANONICAL_JSON_MAX_CHARS + 5000 }), (len) => {
        const huge = 'x'.repeat(len);
        const value = { payload: huge };
        const first = canonicalStringify(value);
        const second = canonicalStringify(value);

        expect(first.truncated).toBe(true);
        expect(first.text.length).toBeLessThanOrEqual(CANONICAL_JSON_MAX_CHARS);
        expect(first.text).toContain('[canonical-json-truncated]');
        // Deterministic: same oversized input truncates at the same position every time.
        expect(second.text).toBe(first.text);
      }),
      { numRuns: 20 },
    );
  });

  it('does not truncate content at or below CANONICAL_JSON_MAX_CHARS', () => {
    const value = { payload: 'x'.repeat(1000) };
    const result = canonicalStringify(value);
    expect(result.truncated).toBe(false);
    expect(result.text).not.toContain('[canonical-json-truncated]');
  });

  it('computeContentHash is deterministic for a fixed hash function', () => {
    fc.assert(
      fc.property(jsonSafeValueGen, (value) => {
        expect(computeContentHash(value, sha256)).toBe(computeContentHash(value, sha256));
      }),
      { numRuns: 100 },
    );
  });
});
