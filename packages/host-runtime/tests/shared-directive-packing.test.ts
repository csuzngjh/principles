import { describe, expect, it } from 'vitest';
import {
  measureSharedDirectiveBlockChars,
  renderPrinciplesToDirectives,
  sharedDirectiveBaseChars,
  type ActivatedPrinciple,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import {
  packSharedDirectives,
  planSharedDirectivePacking,
  MAX_SHARED_DIAGNOSTIC_IDS,
} from '../src/active-principle-prompt.js';
import { adaptiveTargetAuthorizationChanged } from '../src/active-principle-prompt.js';

/**
 * PRI-1137 final review P1-2 (CodeRabbit Major): `packSharedDirectives` moved
 * from "re-render the whole growing prefix per candidate" (O(N²) string work
 * per pack) to additive arithmetic (`baseChars + Σ blockChars`) with ONE final
 * render. These tests lock that the optimization is behavior-preserving:
 *
 * 1. Additivity property: for random sets, `render(set).length` equals the
 *    arithmetic sum, and appending a block costs exactly its measured chars.
 * 2. Characterization: the new packer is byte-identical to a naive reference
 *    implementation (the retired algorithm, inlined here as the oracle).
 * 3. The string-free `planSharedDirectivePacking` (used by the rotation
 *    reachability replay) decides identically with precomputed costs.
 */

/** Deterministic PRNG so a failure always reproduces (no Math.random drift). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPrinciples(seed: number, count: number, budget: number): ActivatedPrinciple[] {
  const rng = mulberry32(seed);
  const alphabet = 'abcdefghij单位字符宽度检查';
  return Array.from({ length: count }, (_, i) => {
    const textLen = Math.floor(rng() * 600) + 1;
    const text = Array.from({ length: textLen }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
    return {
      principleId: `P_${String(i).padStart(4, '0')}`,
      activationId: `act_P_${String(i).padStart(4, '0')}`,
      artifactId: `art_${i}`,
      text: text.length > budget ? text.slice(0, budget + 200) : text,
      activatedAt: new Date(2026, 0, 1 + i).toISOString(),
      authority: rng() < 0.3 ? 'owner' : rng() < 0.5 ? 'system_policy' : undefined,
    } as ActivatedPrinciple;
  });
}

describe('P1-2: additive measurement of the shared directive render', () => {
  it.for([false, true])('render length === baseChars + Σ blockChars for random sets (selfReport=%s)', (selfReport) => {
    const rng = mulberry32(20261107);
    const options = { escapeFn: escapeXml, selfReportInstruction: selfReport };
    for (let trial = 0; trial < 25; trial += 1) {
      const principles = randomPrinciples(Math.floor(rng() * 1e9), 1 + Math.floor(rng() * 12), 4000);
      const injected = new Set(principles.map((p) => p.principleId));
      const rendered = renderPrinciplesToDirectives(principles, injected, options);
      const arithmetic = sharedDirectiveBaseChars(options)
        + principles.reduce((sum, p) => sum + measureSharedDirectiveBlockChars(p, options), 0);
      expect(arithmetic, `trial ${trial}`).toBe(rendered.length);
    }
  });

  it('appending one block costs exactly its measured marginal chars', () => {
    const options = { escapeFn: escapeXml };
    const a = randomPrinciples(7, 5, 4000);
    const withA = renderPrinciplesToDirectives(a, new Set(a.map((p) => p.principleId)), options);
    for (const extra of randomPrinciples(8, 5, 4000)) {
      const set = [...a, extra];
      const withB = renderPrinciplesToDirectives(set, new Set(set.map((p) => p.principleId)), options);
      expect(withB.length - withA.length).toBe(measureSharedDirectiveBlockChars(extra, options));
    }
  });
});

/**
 * The retired packing algorithm, verbatim — the oracle the optimized packer
 * must reproduce byte-for-byte (it re-renders the candidate prefix per entry).
 */
function naiveReferencePack(
  scanOrder: ActivatedPrinciple[],
  budgetChars: number,
  selfReportEnabled: boolean,
  continueOnNonFit: boolean,
): { included: ActivatedPrinciple[]; additionalContext: string; truncated: boolean; dropped: string[]; oversized: string[] } {
  const included: ActivatedPrinciple[] = [];
  let additionalContext = '';
  let truncated = false;
  const dropped: string[] = [];
  const oversized: string[] = [];
  const standaloneFits = (principle: ActivatedPrinciple): boolean =>
    renderPrinciplesToDirectives([principle], new Set([principle.principleId]), { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled }).length
    <= budgetChars;
  for (const principle of scanOrder) {
    const candidate = [...included, principle];
    const candidateContext = renderPrinciplesToDirectives(
      candidate,
      new Set(candidate.map((entry) => entry.principleId)),
      { escapeFn: escapeXml, selfReportInstruction: selfReportEnabled },
    );
    if (candidateContext.length > budgetChars) {
      if (standaloneFits(principle)) {
        truncated = true;
        if (dropped.length < MAX_SHARED_DIAGNOSTIC_IDS) dropped.push(principle.activationId);
      } else if (oversized.length < MAX_SHARED_DIAGNOSTIC_IDS) {
        oversized.push(principle.activationId);
      }
      if (!continueOnNonFit) break;
      continue;
    }
    included.push(principle);
    additionalContext = candidateContext;
  }
  return { included, additionalContext, truncated, dropped, oversized };
}

describe('P1-2: packSharedDirectives is byte-identical to the retired algorithm', () => {
  it.for([
    { budget: 4000, selfReport: false, continueOnNonFit: true },
    { budget: 4000, selfReport: true, continueOnNonFit: true },
    { budget: 1200, selfReport: false, continueOnNonFit: false },
    { budget: 800, selfReport: true, continueOnNonFit: true },
  ] as const)('case %#: budget=%j', ({ budget, selfReport, continueOnNonFit }) => {
    const rng = mulberry32(budget * 31 + (selfReport ? 7 : 13));
    for (let trial = 0; trial < 15; trial += 1) {
      const principles = randomPrinciples(Math.floor(rng() * 1e9), 1 + Math.floor(rng() * 14), budget);
      const expected = naiveReferencePack(principles, budget, selfReport, continueOnNonFit);
      const actual = packSharedDirectives({
        scanOrder: principles, budgetChars: budget, selfReportEnabled: selfReport, continueOnNonFit,
      });
      expect(actual.additionalContext, `trial ${trial} context`).toBe(expected.additionalContext);
      expect(actual.included.map((p) => p.activationId), `trial ${trial} included`).toEqual(expected.included.map((p) => p.activationId));
      expect(actual.truncated).toBe(expected.truncated);
      expect(actual.dropped).toEqual(expected.dropped);
      expect(actual.oversized).toEqual(expected.oversized);
    }
  });

  it('planSharedDirectivePacking decides identically with and without precomputed costs', () => {
    const rng = mulberry32(99);
    for (let trial = 0; trial < 15; trial += 1) {
      const principles = randomPrinciples(Math.floor(rng() * 1e9), 2 + Math.floor(rng() * 12), 4000);
      const measured = planSharedDirectivePacking({
        scanOrder: principles, budgetChars: 4000, selfReportEnabled: true, continueOnNonFit: true,
      });
      const blockChars = new Map(principles.map((p) => [
        p.activationId,
        measureSharedDirectiveBlockChars(p, { escapeFn: escapeXml, selfReportInstruction: true }),
      ] as const));
      const precomputed = planSharedDirectivePacking({
        scanOrder: principles, budgetChars: 4000, selfReportEnabled: true, continueOnNonFit: true,
        blockCharsByActivationId: blockChars,
      });
      expect(precomputed.included.map((p) => p.activationId)).toEqual(measured.included.map((p) => p.activationId));
      expect(precomputed.truncated).toBe(measured.truncated);
      expect(precomputed.dropped).toEqual(measured.dropped);
      expect(precomputed.oversized).toEqual(measured.oversized);
    }
  });
});

describe('P1-5: adaptive authorization-snapshot drift is detectable', () => {
  // The packed directive carries the FIRST snapshot's authority annotation, so
  // drift between the two reads must be recognizable as a change.
  it('identical authority + approver → no change', () => {
    expect(adaptiveTargetAuthorizationChanged(
      { authority: 'owner', approvedBy: 'owner-1' },
      { authority: 'owner', approvedBy: 'owner-1' },
    )).toBe(false);
    expect(adaptiveTargetAuthorizationChanged({}, {})).toBe(false);
  });

  it('authority drift (owner → system_policy, or appearing/disappearing) is a change', () => {
    expect(adaptiveTargetAuthorizationChanged(
      { authority: 'owner' }, { authority: 'system_policy' },
    )).toBe(true);
    expect(adaptiveTargetAuthorizationChanged(
      { authority: 'owner' }, {},
    )).toBe(true);
    expect(adaptiveTargetAuthorizationChanged(
      {}, { authority: 'system_policy' },
    )).toBe(true);
  });

  it('approver drift under the same authority is a change', () => {
    expect(adaptiveTargetAuthorizationChanged(
      { authority: 'owner', approvedBy: 'owner-a' },
      { authority: 'owner', approvedBy: 'owner-b' },
    )).toBe(true);
    expect(adaptiveTargetAuthorizationChanged(
      { authority: 'owner', approvedBy: 'owner-a' },
      { authority: 'owner' },
    )).toBe(true);
  });
});
