/**
 * Property tests for resolveInjection information-floor fallback
 * (design §6.2.2, task 5.11).
 *
 * CP-34: injection information floor — Layer 1 must not produce a thinner
 * prompt than the flag-off baseline. When the manifest resolution is too
 * sparse (empty / all tier1 absent / absent ratio > threshold), resolveInjection
 * falls back to the legacy full-predecessor injection and emits exactly one
 * manifest_resolution_insufficient event.
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.2.2
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirement 13
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  resolveInjection,
  MANIFEST_ABSENT_RATIO_THRESHOLD,
  type ResolveInjectionEmit,
} from '../resolve-injection.js';
import {
  allocateContext,
  type ContextTruncatedEvent,
} from '../prompt-budget-manager.js';
import { CONTEXT_MANIFEST_SCHEMA_VERSION, type ContextManifest } from '../context-manifest.js';

/** Build a manifest with N tier1 fields, all in priority. */
function mkManifest(tier1Fields: readonly string[], budget = 1000): ContextManifest {
  return {
    manifestId: 'test.v1',
    schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
    runnerKind: 'dreamer',
    tier0: [],
    tier1: tier1Fields,
    tier2: [],
    budgetTokens: budget,
    priority: tier1Fields,
  };
}

function capture() {
  const events: ResolveInjectionEmit[] = [];
  return { emit: (e: ResolveInjectionEmit) => events.push(e), events };
}

function isFallback(e: ResolveInjectionEmit): e is Extract<ResolveInjectionEmit, { type: 'manifest_resolution_insufficient' }> {
  return e.type === 'manifest_resolution_insufficient';
}

// ── CP-34: information floor ─────────────────────────────────────────────────

describe('CP-34 — resolveInjection information-floor fallback', () => {
  it('threshold is 0.5 (documented constant)', () => {
    expect(MANIFEST_ABSENT_RATIO_THRESHOLD).toBe(0.5);
  });

  it('focused when all fields present (absent ratio 0)', () => {
    const m = mkManifest(['a', 'b', 'c', 'd']);
    const map = new Map([['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']]);
    const c = capture();
    const result = resolveInjection(m, map, c.emit);
    expect(result.kind).toBe('focused');
    expect(result.fellBack).toBe(false);
    expect(c.events.filter(isFallback)).toHaveLength(0);
  });

  it('falls back when allocation is empty (no field resolved)', () => {
    const m = mkManifest(['a', 'b']);
    const map = new Map(); // nothing available
    const c = capture();
    const result = resolveInjection(m, map, c.emit);
    expect(result.kind).toBe('fallback');
    expect(result.fellBack).toBe(true);
    const fb = c.events.filter(isFallback);
    expect(fb).toHaveLength(1);
    expect(fb[0]?.fallback).toBe('full_predecessor_injection');
    expect(fb[0]?.absentCount).toBe(2);
    expect(fb[0]?.declaredCount).toBe(2);
  });

  it('falls back when all tier1 fields are absent', () => {
    const m = mkManifest(['a', 'b', 'c']); // all tier1
    const map = new Map(); // all absent
    const c = capture();
    const result = resolveInjection(m, map, c.emit);
    expect(result.kind).toBe('fallback');
    // empty-allocation trigger fires first (all absent → nothing allocated)
    if (result.kind === 'fallback') {
      expect(['empty_allocation', 'tier1_all_absent']).toContain(result.reason);
    }
  });

  it('falls back when absent ratio > threshold (0.5)', () => {
    // 4 declared, 3 absent → ratio 0.75 > 0.5. The 1 present field is in tier1
    // (so tier1_all_absent is false), forcing the ratio trigger.
    const m = mkManifest(['a', 'b', 'c', 'd']);
    const map = new Map([['a', '1']]); // only 'a' present
    const c = capture();
    const result = resolveInjection(m, map, c.emit);
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.absentRatio).toBe(0.75);
    }
  });

  it('stays focused at exactly the threshold boundary (ratio == 0.5, not >)', () => {
    // 4 declared, 2 absent → ratio exactly 0.5. Trigger is `> threshold`, so
    // this must NOT fall back (boundary is inclusive of focused).
    const m = mkManifest(['a', 'b', 'c', 'd']);
    const map = new Map([['a', '1'], ['b', '2']]);
    const c = capture();
    const result = resolveInjection(m, map, c.emit);
    expect(result.kind).toBe('focused');
    expect(c.events.filter(isFallback)).toHaveLength(0);
  });

  it('property: fallback fires iff absentRatio > 0.5 OR allocation empty OR tier1 all absent', () => {
    // Generate a 4-field manifest, randomly present each field, and verify the
    // fallback decision matches the documented rule exactly.
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        (presentMask) => {
          const m = mkManifest(['a', 'b', 'c', 'd']);
          const map = new Map<string, unknown>();
          const fields = ['a', 'b', 'c', 'd'] as const;
          presentMask.forEach((present, i) => {
            const f = fields[i];
            if (present && f !== undefined) map.set(f, `v${i}`);
          });
          const c = capture();
          const result = resolveInjection(m, map, c.emit);
          const presentCount = presentMask.filter(Boolean).length;
          const absentCount = 4 - presentCount;
          const absentRatio = absentCount / 4;
          const shouldFallback =
            presentCount === 0 // empty allocation
            || absentRatio > MANIFEST_ABSENT_RATIO_THRESHOLD; // tier1_all_absent coincides with all-absent here

          expect(result.fellBack).toBe(shouldFallback);
          // Exactly one fallback event when fallback, zero otherwise.
          const fbCount = c.events.filter(isFallback).length;
          expect(fbCount).toBe(shouldFallback ? 1 : 0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('fallback event carries absentCount, declaredCount, absentRatio, fallback (rc-9)', () => {
    const m = mkManifest(['a', 'b', 'c', 'd']);
    const map = new Map([['a', '1']]); // 3 absent
    const c = capture();
    resolveInjection(m, map, c.emit);
    const fb = c.events.filter(isFallback);
    expect(fb).toHaveLength(1);
    expect(fb[0]?.absentCount).toBe(3);
    expect(fb[0]?.declaredCount).toBe(4);
    expect(fb[0]?.absentRatio).toBeCloseTo(0.75, 5);
    expect(fb[0]?.fallback).toBe('full_predecessor_injection');
  });

  it('context_truncated events from the allocation attempt are preserved on fallback', () => {
    // When fallback fires, the allocateContext that ran first may have emitted
    // context_truncated events; those must still be in the event stream (design
    // §6.3: they record "what would have been truncated").
    const m = mkManifest(['a', 'b'], 1); // budget=1 forces truncation
    const map = new Map([['a', 'x'.repeat(100)], ['b', 'y'.repeat(100)]]);
    const c = capture();
    const result = resolveInjection(m, map, c.emit);
    // Budget too small → both fields likely dropped → empty allocation → fallback.
    expect(result.kind).toBe('fallback');
    const truncated = c.events.filter((e) => e.type === 'context_truncated');
    // At least the context_truncated events from the attempt are present.
    expect(truncated.length).toBeGreaterThan(0);
  });
});
