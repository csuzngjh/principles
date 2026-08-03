/**
 * Property tests for ContextManifest well-formedness + ranking
 * (design §6.2, §6.6.1, tasks 5.3–5.4).
 *
 * CP-12: manifest well-formedness (built-in manifests + synthetic generators)
 * CP-13: unlisted fields sort last via rankOf
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.2, §6.6.1
 * @see .kiro/specs/internalization-progressive-disclosure/requirements.md Requirement 4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  validateManifest,
  rankOf,
  declaredFields,
  checkManifestCriterionAlignment,
  type ContextManifest,
} from '../context-manifest.js';
import {
  BUILTIN_MANIFESTS,
  DREAMER_MANIFEST,
  SCRIBE_MANIFEST,
  ARTIFICER_MANIFEST,
  EVALUATOR_STAGE1_MANIFEST,
  EVALUATOR_STAGE2_MANIFEST,
  MANIFEST_RUNNER_KINDS,
} from '../context-manifests.js';
import {
  DIMENSION_COVERAGE_POLICY,
  REQUIRED_FIDELITY_DIMENSIONS,
  ALL_DREAMER_DIMENSIONS,
} from '../dimension-coverage-policy.js';

// ── CP-12: manifest well-formedness ──────────────────────────────────────────

describe('CP-12 — manifest well-formedness', () => {
  it('BUILTIN_MANIFESTS has exactly 4 distinct runnerKinds (no diagnostic stage)', () => {
    // dreamer, scribe, artificer, evaluator — never diag_rootcause/distiller/router
    expect(MANIFEST_RUNNER_KINDS).toHaveLength(4);
    expect(new Set(MANIFEST_RUNNER_KINDS)).toEqual(new Set(['dreamer', 'scribe', 'artificer', 'evaluator']));
    for (const kind of MANIFEST_RUNNER_KINDS) {
      expect(kind).not.toMatch(/^diag_/);
    }
  });

  it('every built-in manifest is well-formed (non-adjudicator path)', () => {
    for (const m of BUILTIN_MANIFESTS) {
      // Pass isAdjudicator only for evaluator manifests.
      const isAdj = m.runnerKind === 'evaluator';
      const result = validateManifest(m, { isAdjudicator: isAdj });
      expect(result.ok, `manifest ${m.manifestId}: ${result.ok ? '' : JSON.stringify(result.error)}`).toBe(true);
    }
  });

  it('every built-in manifest has schemaVersion, positive budget, all-string tiers/priority', () => {
    for (const m of BUILTIN_MANIFESTS) {
      expect(m.schemaVersion).toBe(CONTEXT_MANIFEST_SCHEMA_VERSION);
      expect(m.budgetTokens).toBeGreaterThan(0);
      for (const arr of [m.tier0, m.tier1, m.tier2, m.priority]) {
        for (const el of arr) {
          expect(typeof el).toBe('string');
        }
      }
    }
  });

  it('priority covers every declared field in every built-in manifest', () => {
    // design §6.2: priority must cover tier0 ∪ tier1 ∪ tier2. The built-in
    // manifests list every field explicitly.
    for (const m of BUILTIN_MANIFESTS) {
      const declared = new Set(declaredFields(m));
      const priority = new Set(m.priority);
      for (const path of declared) {
        expect(priority.has(path), `${m.manifestId}: priority missing ${path}`).toBe(true);
      }
    }
  });

  it('budgetTokens not positive → validation fails', () => {
    const bad: ContextManifest = { ...DREAMER_MANIFEST, budgetTokens: 0 };
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('budget_not_positive');
  });

  it('non-string element in a tier → validation fails (rc-4)', () => {
    const bad = { ...DREAMER_MANIFEST, tier1: [...DREAMER_MANIFEST.tier1, 123 as unknown as string] };
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('non_string_element');
  });

  it('synthetic manifests with injected non-string elements are always rejected', () => {
    const validBase = DREAMER_MANIFEST;
    fc.assert(
      fc.property(
        fc.constantFrom('tier0', 'tier1', 'tier2', 'priority'),
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (arrayName, badElement) => {
          const arr = validBase[arrayName];
          const corrupted = [...arr, badElement as unknown as string];
          const manifest = { ...validBase, [arrayName]: corrupted } as ContextManifest;
          const result = validateManifest(manifest);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.kind).toBe('non_string_element');
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ── INV-MANIFEST-CRITERION (§6.6.1) ───────────────────────────────────────────

describe('INV-MANIFEST-CRITERION — adjudicator manifests inject all non-excluded dims', () => {
  it('both evaluator stage manifests inject all 4 non-excluded dreamer dimensions', () => {
    // strategicPerspective is excluded; the other 4 must be injectable.
    for (const m of [EVALUATOR_STAGE1_MANIFEST, EVALUATOR_STAGE2_MANIFEST]) {
      const allPaths = new Set([...m.tier0, ...m.tier1, ...m.tier2]);
      for (const dim of ALL_DREAMER_DIMENSIONS) {
        const path = `dreamer.summary.${dim}`;
        if (DIMENSION_COVERAGE_POLICY[dim] === 'excluded') {
          // excluded dims must NOT be injected (design §6.6.1).
          expect(allPaths.has(path), `${m.manifestId} must not inject excluded ${path}`).toBe(false);
        } else {
          expect(allPaths.has(path), `${m.manifestId} must inject ${path}`).toBe(true);
        }
      }
    }
  });

  it('promoting an excluded dim to required without adding its path fails alignment', () => {
    // Simulate the regression: take STAGE1 (valid), drop dreamer.summary.riskLevel,
    // and check alignment catches it.
    const tampered: ContextManifest = {
      ...EVALUATOR_STAGE1_MANIFEST,
      tier1: EVALUATOR_STAGE1_MANIFEST.tier1.filter((p) => p !== 'dreamer.summary.riskLevel'),
    };
    const err = checkManifestCriterionAlignment(tampered, true);
    expect(err).not.toBeNull();
    expect(err?.kind).toBe('manifest_criterion_misaligned');
    if (err && err.kind === 'manifest_criterion_misaligned') {
      expect(err.detail).toContain('riskLevel');
    }
  });

  it('non-evaluator manifests skip the alignment check (not adjudicators)', () => {
    for (const m of [DREAMER_MANIFEST, SCRIBE_MANIFEST, ARTIFICER_MANIFEST]) {
      expect(checkManifestCriterionAlignment(m, true)).toBeNull();
    }
  });

  it('validateManifest flags misaligned adjudicator when isAdjudicator=true', () => {
    const tampered: ContextManifest = {
      ...EVALUATOR_STAGE1_MANIFEST,
      tier1: EVALUATOR_STAGE1_MANIFEST.tier1.filter((p) => p !== 'dreamer.summary.betterDecision'),
    };
    const result = validateManifest(tampered, { isAdjudicator: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('manifest_criterion_misaligned');
  });
});

// ── CP-13: unlisted fields sort last ─────────────────────────────────────────

describe('CP-13 — unlisted fields sort last via rankOf', () => {
  it('rankOf(listed field) === its index in priority', () => {
    for (const m of BUILTIN_MANIFESTS) {
      m.priority.forEach((path, idx) => {
        expect(rankOf(path, m)).toBe(idx);
      });
    }
  });

  it('rankOf(unlisted declared field) is strictly greater than every listed field rank', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BUILTIN_MANIFESTS),
        fc.string({ minLength: 1, maxLength: 12 }).map((s) => `extra.${s}`),
        (m, extraPath) => {
          fc.pre(!m.priority.includes(extraPath));
          // Add extraPath to tier1 so it's "declared" but unlisted.
          const tier1WithExtra = [...m.tier1, extraPath];
          const manifest: ContextManifest = { ...m, tier1: tier1WithExtra };
          const extraRank = rankOf(extraPath, manifest);
          for (const listed of m.priority) {
            expect(extraRank).toBeGreaterThan(rankOf(listed, manifest));
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it('rankOf is deterministic: same input → same rank', () => {
    for (const m of BUILTIN_MANIFESTS) {
      for (const path of declaredFields(m)) {
        expect(rankOf(path, m)).toBe(rankOf(path, m));
      }
    }
  });
});

// ── dimension coverage policy sanity ─────────────────────────────────────────

describe('DIMENSION_COVERAGE_POLICY — single source of truth', () => {
  it('covers all 5 dreamer dimensions', () => {
    for (const dim of ALL_DREAMER_DIMENSIONS) {
      expect(Object.hasOwn(DIMENSION_COVERAGE_POLICY, dim)).toBe(true);
    }
    expect(Object.keys(DIMENSION_COVERAGE_POLICY)).toHaveLength(5);
  });

  it('REQUIRED_FIDELITY_DIMENSIONS = exactly the required ones', () => {
    expect(REQUIRED_FIDELITY_DIMENSIONS).toEqual(['betterDecision', 'rationale', 'riskLevel']);
  });

  it('strategicPerspective is the only excluded dimension', () => {
    const excluded = ALL_DREAMER_DIMENSIONS.filter((d) => DIMENSION_COVERAGE_POLICY[d] === 'excluded');
    expect(excluded).toEqual(['strategicPerspective']);
  });
});
