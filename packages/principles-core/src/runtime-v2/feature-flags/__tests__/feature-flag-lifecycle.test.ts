import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_FLAGS } from '../feature-flag-contract.js';
import {
  QUIET_FLAG_LIFECYCLE,
  type QuietFlagLifecycleDecision,
} from '../feature-flag-lifecycle.js';

/**
 * PRI-610 — Feature Flag lifecycle contract.
 *
 * Enforces "feature purgatory = 0": no quiet flag may exist in the registry
 * without an evidence-backed lifecycle decision (KEEP_QUIET / GRADUATE /
 * RETIRE / STAGED), and no lifecycle entry may reference an unknown flag.
 * A new quiet flag added to DEFAULT_FEATURE_FLAGS without a lifecycle entry
 * here FAILS this test — the census must be updated in the same PR.
 */

const VALID_DECISIONS: readonly QuietFlagLifecycleDecision[] = ['KEEP_QUIET', 'GRADUATE', 'RETIRE', 'STAGED'];

const quietFlags = DEFAULT_FEATURE_FLAGS.filter(f => f.category === 'quiet');
const goneFlags = DEFAULT_FEATURE_FLAGS.filter(f => f.category === 'gone');
const legacyRetireFlags = DEFAULT_FEATURE_FLAGS.filter(f => f.category === 'legacy_retire');

describe('PRI-610 feature flag lifecycle census', () => {
  it('every quiet flag has a lifecycle decision (feature purgatory = 0)', () => {
    expect(quietFlags.length).toBeGreaterThan(0);
    for (const flag of quietFlags) {
      expect(
        Object.hasOwn(QUIET_FLAG_LIFECYCLE, flag.id),
        `quiet flag '${flag.id}' has no lifecycle entry — add one to QUIET_FLAG_LIFECYCLE (Purpose/Default/Rollback/Graduation/Retirement/Exit) in the same PR`,
      ).toBe(true);
    }
  });

  it('no lifecycle entry references an unregistered or non-quiet flag (no orphan census rows)', () => {
    const quietIds = new Set(quietFlags.map(f => f.id));
    for (const id of Object.keys(QUIET_FLAG_LIFECYCLE)) {
      expect(
        quietIds.has(id),
        `lifecycle entry '${id}' does not match a registered quiet flag — stale census row (removed flag? category change?)`,
      ).toBe(true);
    }
  });

  it('every lifecycle entry is complete: decision, consumers, evidence, decided date, exit criteria', () => {
    for (const [id, entry] of Object.entries(QUIET_FLAG_LIFECYCLE)) {
      expect(VALID_DECISIONS.includes(entry.decision), `${id}: invalid decision '${entry.decision}'`).toBe(true);
      expect(entry.consumers.length, `${id}: consumers evidence must not be empty`).toBeGreaterThan(0);
      expect(entry.evidence.length, `${id}: evidence must not be empty`).toBeGreaterThan(0);
      expect(entry.decided, `${id}: decided date required (YYYY-MM-DD)`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Exit path is mandatory for every lifecycle state — a flag with no
      // disappearance condition is permanent by construction (Phase 1 §G3).
      expect(entry.retirementCriteria.length, `${id}: retirementCriteria (exit path) required`).toBeGreaterThan(0);
      if (entry.decision === 'KEEP_QUIET' || entry.decision === 'STAGED') {
        expect(entry.graduationCriteria.length, `${id}: graduationCriteria required for ${entry.decision}`).toBeGreaterThan(0);
      }
    }
  });

  it('STAGED flags must document why they are staged (roadmap ownership)', () => {
    for (const [id, entry] of Object.entries(QUIET_FLAG_LIFECYCLE)) {
      if (entry.decision === 'STAGED') {
        expect(
          entry.consumers.some(c => c.includes('staged') || c.includes('none yet')),
          `${id}: STAGED flags must state that activation wiring is pending and where it lands`,
        ).toBe(true);
      }
    }
  });

  it('GRADUATE decisions record executed graduation evidence (no aspirational GRADUATE rows)', () => {
    for (const [id, entry] of Object.entries(QUIET_FLAG_LIFECYCLE)) {
      if (entry.decision === 'GRADUATE') {
        const registered = quietFlags.find(f => f.id === id);
        expect(registered, `${id}: GRADUATE flag must still be registered`).toBeDefined();
        expect(
          registered?.enabled,
          `${id}: GRADUATE decision means default-on in the registry`,
        ).toBe(true);
        expect(
          entry.graduationCriteria.toUpperCase().includes('MET') || entry.evidence.includes('graduated'),
          `${id}: GRADUATE rows must record executed graduation evidence, not a future intent (use KEEP_QUIET until validated)`,
        ).toBe(true);
        // 'decided' is the decision date (field contract). For an executed
        // graduation the decision IS the graduation, so the decided date must
        // be corroborated by the executed-graduation record itself (criteria
        // or evidence) — the ledger cannot claim a decision date that its own
        // graduation evidence does not support.
        expect(
          entry.graduationCriteria.includes(entry.decided) || entry.evidence.includes(entry.decided),
          `${id}: GRADUATE decided date '${entry.decided}' must appear in the executed graduation record (graduationCriteria or evidence)`,
        ).toBe(true);
      }
    }
  });

  it('gone flags are permanently disabled and never carry lifecycle entries (terminal state)', () => {
    expect(goneFlags.length).toBeGreaterThan(0);
    for (const flag of goneFlags) {
      expect(flag.enabled, `gone flag '${flag.id}' must default false`).toBe(false);
      expect(
        Object.hasOwn(QUIET_FLAG_LIFECYCLE, flag.id),
        `gone flag '${flag.id}' is terminal — lifecycle decisions apply to quiet flags only`,
      ).toBe(false);
    }
  });

  it('legacy_retire category is a recognized, currently-empty transition state (documented semantics)', () => {
    // Category semantics (docs/governance/feature-flag-lifecycle-census.md):
    // - gone        = retired; can never be re-enabled; code deleted or inert.
    // - legacy_retire = deletion approved and scheduled; behaves like quiet
    //   (config override still honored) until the code removal PR lands, then
    //   flips to gone. Currently no flag is in transition.
    expect(legacyRetireFlags.length).toBe(0);
  });
});
