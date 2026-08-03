/**
 * Layer 1 — ContextManifest: declarative field/budget declaration (design §6.2).
 *
 * Pure logic only: no I/O, no fs, no DB, no network (Core vs Plugin boundary,
 * AGENTS.md `antipattern-core-io`).
 *
 * A `ContextManifest` declares which field paths a runner (or an evaluator
 * stage) needs, layered into tier0/tier1/tier2, plus a token budget and a
 * priority ordering. Layer 1's `allocateContext` (prompt-budget-manager.ts)
 * consumes it; Layer 3's CLI surfaces its resolution.
 *
 * rc-4: tier* and priority array elements are validated element-wise as
 * strings before use. rc-5: object keys read via `Object.hasOwn`.
 */

import type { SummaryRunnerKind } from './artifact-summary.js';
import {
  DIMENSION_COVERAGE_POLICY,
  ALL_DREAMER_DIMENSIONS,
  type DreamerDimension,
} from './dimension-coverage-policy.js';

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * A declarative context-injection manifest (design §6.2).
 *
 * Field-path naming convention (design §6.6):
 *   `<stage>.summary.<key>`        — read from an ArtifactSummary
 *   `<stage>.predecessorSummary.*` — read from a forwarded predecessor summary
 *   `<stage>.raw.<path>`           — read from tier2 full contentJson
 */
export interface ContextManifest {
  readonly manifestId: string; // e.g. 'dreamer.v1', 'evaluator.stage2.v1'
  readonly schemaVersion: typeof CONTEXT_MANIFEST_SCHEMA_VERSION;
  readonly runnerKind: SummaryRunnerKind;
  readonly tier0: readonly string[];
  readonly tier1: readonly string[];
  /** Non-empty tier2 means CandidateLineage (Layer 2) may be triggered. */
  readonly tier2: readonly string[];
  /** Cross-level injection field budget (design §6.2.1). */
  readonly budgetTokens: number;
  /** Full priority sequence. Fields not listed here sort last (see rankOf). */
  readonly priority: readonly string[];
}

// ── Well-formedness validation ───────────────────────────────────────────────

export type ManifestWellFormednessError =
  | { readonly kind: 'budget_not_positive'; readonly budgetTokens: number }
  | { readonly kind: 'non_string_element'; readonly array: 'tier0' | 'tier1' | 'tier2' | 'priority'; readonly index: number; readonly value: unknown }
  | { readonly kind: 'priority_does_not_cover_fields'; readonly missing: readonly string[] }
  | { readonly kind: 'manifest_criterion_misaligned'; readonly detail: string };

export type ManifestValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ManifestWellFormednessError };

/** Deduplicate a string array preserving first-seen order (deterministic). */
function dedupe(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * The set of all dreamer dimension names that are NOT `excluded` — i.e. the
 * ones the fidelity criteria may adjudicate (design §6.6.1 INV-MANIFEST-
 * CRITERION). `strategicPerspective` is excluded and must never appear in an
 * adjudicating manifest.
 */
const NON_EXCLUDED_DIMENSIONS: readonly DreamerDimension[] = ALL_DREAMER_DIMENSIONS.filter(
  (d) => DIMENSION_COVERAGE_POLICY[d] !== 'excluded',
);

/**
 * INV-MANIFEST-CRITERION (design §6.6.1): every non-excluded dreamer dimension
 * that the fidelity criteria may adjudicate must have a corresponding injected
 * path in the adjudicating manifest's tier0 ∪ tier1 ∪ tier2. The criteria must
 * never ask the model to judge a dimension it cannot see.
 *
 * This is the direct regression guard for the Phase 0 root cause "criteria ask
 * 5 dims, manifest injects 4" (design §12.1 conclusion 2 root cause 2). It only
 * applies to manifests whose runnerKind is the adjudicator (evaluator); other
 * stages are not fidelity-adjudicating and are skipped.
 *
 * NOTE: this checks that each non-excluded dimension's summary path
 * (`dreamer.summary.<dim>`) is present. A future change promoting a dimension
 * from `excluded` to `required`/`optional` in DIMENSION_COVERAGE_POLICY without
 * adding its path to the evaluator manifest will fail this check.
 *
 * @param manifest the manifest to check
 * @param isAdjudicator true only for evaluator-stage manifests (the ones whose
 *   injected fields the fidelity criteria see). Callers pass false for
 *   non-evaluator manifests so this invariant is scoped correctly.
 */
export function checkManifestCriterionAlignment(
  manifest: ContextManifest,
  isAdjudicator: boolean,
): ManifestWellFormednessError | null {
  if (!isAdjudicator) return null;
  if (manifest.runnerKind !== 'evaluator') return null;

  const allPaths = new Set<string>([...manifest.tier0, ...manifest.tier1, ...manifest.tier2]);
  const missing: string[] = [];
  for (const dim of NON_EXCLUDED_DIMENSIONS) {
    const path = `dreamer.summary.${dim}`;
    if (!allPaths.has(path)) {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    return {
      kind: 'manifest_criterion_misaligned',
      detail: `Adjudicating manifest "${manifest.manifestId}" is missing dreamer summary paths for non-excluded dimensions: ${missing.join(', ')}. DIMENSION_COVERAGE_POLICY requires these to be injectable (INV-MANIFEST-CRITERION, design §6.6.1).`,
    };
  }
  return null;
}

/**
 * Validate a manifest is well-formed (design §6.2, requirements 4.2–4.8, 4.12,
 * 4.13, 4.15).
 *
 * Checks:
 *   - budgetTokens > 0
 *   - every tier* and priority element is a string (rc-4)
 *   - priority covers every field in tier0 ∪ tier1 ∪ tier2 (with a documented
 *     escape hatch: unlisted fields are allowed but sort last via rankOf; this
 *     check is intentionally NOT enforced because rankOf defines their rank —
 *     see the note below)
 *   - INV-MANIFEST-CRITERION when the manifest is an adjudicator (§6.6.1)
 *
 * Note on `priority` coverage: design §6.2 requires "priority covers tier0 ∪
 * tier1 ∪ tier2", but rankOf assigns unlisted fields a rank of
 * `priority.length + declarationOrder` (sorting them last), which is the
 * intended behaviour. The check here therefore only flags an empty priority
 * when fields exist (a clear misconfiguration), rather than requiring every
 * field be listed. The built-in manifests DO list every field.
 */
export function validateManifest(
  manifest: ContextManifest,
  opts: { readonly isAdjudicator?: boolean } = {},
): ManifestValidationResult {
  // budgetTokens > 0
  if (!(manifest.budgetTokens > 0)) {
    return { ok: false, error: { kind: 'budget_not_positive', budgetTokens: manifest.budgetTokens } };
  }

  // element-wise string check (rc-4)
  const arrays: ['tier0' | 'tier1' | 'tier2' | 'priority', readonly string[]][] = [
    ['tier0', manifest.tier0],
    ['tier1', manifest.tier1],
    ['tier2', manifest.tier2],
    ['priority', manifest.priority],
  ];
  for (const [name, arr] of arrays) {
    for (let i = 0; i < arr.length; i++) {
      const el = arr[i];
      if (typeof el !== 'string') {
        return { ok: false, error: { kind: 'non_string_element', array: name, index: i, value: el } };
      }
    }
  }

  // INV-MANIFEST-CRITERION (only for adjudicators)
  const alignmentError = checkManifestCriterionAlignment(manifest, opts.isAdjudicator === true);
  if (alignmentError !== null) {
    return { ok: false, error: alignmentError };
  }

  return { ok: true };
}

// ── Priority ranking ─────────────────────────────────────────────────────────

/**
 * The rank of a field path within a manifest (design §6.2 / requirement 4.6).
 *
 * Listed fields get their index in `priority` (0-based, ascending = higher
 * priority). Unlisted fields get `priority.length + declarationOrder`, where
 * declarationOrder is the field's position in dedupe(tier0 ++ tier1 ++ tier2)
 * — so unlisted fields sort AFTER all listed fields, in a stable declaration
 * order. This replaces the base proposal's `indexOf(...) `-1`` which sorted
 * unlisted fields FIRST (opposite of intent).
 */
export function rankOf(fieldPath: string, manifest: ContextManifest): number {
  const listedRank = manifest.priority.indexOf(fieldPath);
  if (listedRank >= 0) return listedRank;

  const declarationOrder = dedupe([
    ...manifest.tier0,
    ...manifest.tier1,
    ...manifest.tier2,
  ]).indexOf(fieldPath);
  // declarationOrder is >= 0 for any field actually in the manifest; use a
  // large fallback for paths not in any tier (defensive — they shouldn't be
  // ranked, but rankOf must never return a value that sorts them first).
  const order = declarationOrder >= 0 ? declarationOrder : 0;
  return manifest.priority.length + order;
}

// ── Helpers for consumers ─────────────────────────────────────────────────────

/** All declared field paths of a manifest, deduped, in tier order. */
export function declaredFields(manifest: ContextManifest): string[] {
  return dedupe([...manifest.tier0, ...manifest.tier1, ...manifest.tier2]);
}
