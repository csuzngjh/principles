import { describe, it, expect } from 'vitest';
import {
  resolveRecommendationKind,
  validateRecommendationKind,
  isPrincipleLedgerEligibleKind,
  VALID_RECOMMENDATION_KINDS,
  PRINCIPLE_LEDGER_KIND,
} from '../recommendation-kind-resolver.js';
import { CANDIDATE_KIND_TO_ROUTE } from '../../../internalization/intake-to-internalization-bridge.js';

describe('resolveRecommendationKind', () => {
  it('returns valid kinds as-is', () => {
    expect(resolveRecommendationKind('principle')).toBe('principle');
    expect(resolveRecommendationKind('rule')).toBe('rule');
    expect(resolveRecommendationKind('implementation')).toBe('implementation');
    expect(resolveRecommendationKind('prompt')).toBe('prompt');
    expect(resolveRecommendationKind('defer')).toBe('defer');
  });

  it('falls back to principle for strings outside whitelist', () => {
    expect(resolveRecommendationKind('skill')).toBe('principle');
    expect(resolveRecommendationKind('retired_channel')).toBe('principle');
    expect(resolveRecommendationKind('')).toBe('principle');
    expect(resolveRecommendationKind('PRINCIPLE')).toBe('principle');
  });

  it('falls back to principle for non-string types', () => {
    expect(resolveRecommendationKind(null)).toBe('principle');
    expect(resolveRecommendationKind(undefined)).toBe('principle');
    expect(resolveRecommendationKind(42)).toBe('principle');
    expect(resolveRecommendationKind(true)).toBe('principle');
    expect(resolveRecommendationKind({})).toBe('principle');
    expect(resolveRecommendationKind([])).toBe('principle');
  });

  it('VALID_RECOMMENDATION_KINDS contains exactly the five known kinds', () => {
    expect(VALID_RECOMMENDATION_KINDS.size).toBe(5);
    expect(VALID_RECOMMENDATION_KINDS.has('principle')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('rule')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('implementation')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('prompt')).toBe(true);
    expect(VALID_RECOMMENDATION_KINDS.has('defer')).toBe(true);
  });
});

// ── Phase 1 / PR1: strict, fail-closed validation ────────────────────────────
//
// `resolveRecommendationKind` above is deliberately FAIL-OPEN for read/display
// compatibility. The Principle Ledger write boundary must NOT use it — these
// cases pin the fail-closed counterpart the boundary is built on.

describe('validateRecommendationKind (fail closed)', () => {
  it('returns valid kinds unchanged', () => {
    for (const kind of VALID_RECOMMENDATION_KINDS) {
      expect(validateRecommendationKind(kind)).toBe(kind);
    }
  });

  it('returns null for unknown / malformed / non-string values', () => {
    for (const bad of ['skill', 'unknown_xyz', '', 'PRINCIPLE', 'principle ', null, undefined, 42, true, {}, []]) {
      expect(validateRecommendationKind(bad)).toBeNull();
    }
  });
});

describe('isPrincipleLedgerEligibleKind (Principle Ledger write boundary)', () => {
  it('admits ONLY the exact kind principle', () => {
    expect(isPrincipleLedgerEligibleKind('principle')).toBe(true);
    expect(PRINCIPLE_LEDGER_KIND).toBe('principle');
  });

  it('refuses every other valid kind', () => {
    for (const kind of ['rule', 'prompt', 'implementation', 'defer'] as const) {
      expect(isPrincipleLedgerEligibleKind(kind)).toBe(false);
    }
  });

  it('refuses unknown / missing / malformed values (never defaults to principle)', () => {
    for (const bad of ['unknown_xyz', '', 'PRINCIPLE', 'skill', null, undefined, 42, {}, []]) {
      expect(isPrincipleLedgerEligibleKind(bad)).toBe(false);
    }
  });

  // Single source of truth: the predicate must agree with the canonical
  // kind → route table for EVERY candidate kind. If a future kind is routed to
  // 'principle-ledger', this fails and forces the boundary to be revisited
  // rather than letting the two definitions silently drift apart.
  it('agrees with CANDIDATE_KIND_TO_ROUTE for every routed kind', () => {
    for (const kind of Object.keys(CANDIDATE_KIND_TO_ROUTE)) {
      expect(isPrincipleLedgerEligibleKind(kind)).toBe(
        CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger',
      );
    }
  });

  it('is the ONLY kind whose route is principle-ledger', () => {
    const ledgerKinds = Object.entries(CANDIDATE_KIND_TO_ROUTE)
      .filter(([, route]) => route === 'principle-ledger')
      .map(([kind]) => kind);
    expect(ledgerKinds).toEqual(['principle']);
  });
});
