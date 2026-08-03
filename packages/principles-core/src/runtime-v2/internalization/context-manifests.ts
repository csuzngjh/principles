/**
 * Layer 1 — the 4 built-in ContextManifests (design §6.6).
 *
 * Pure logic only (Core vs Plugin boundary). These are the single source of
 * truth for which manifest each peer runner uses; the manifest count is
 * exactly 4 (dreamer / scribe / artificer / evaluator, with evaluator carrying
 * a Stage 1 + Stage 2 variant). The three diagnostic stages own NO manifest
 * (design §4.7.1, requirement 2.14, guarded by the scope-regression test from
 * PR 1 task 3.21).
 *
 * Field-path naming convention (design §6.6):
 *   `<stage>.summary.<key>`        — read from an ArtifactSummary
 *   `<stage>.predecessorSummary.*` — read from a forwarded predecessor summary
 *   `<stage>.raw.<path>`           — read from tier2 full contentJson (Layer 2)
 *
 * budgetTokens semantics (design §6.2.1 / §6.3): the budget covers ONLY these
 * manifest-declared injection fields. It does NOT include core grounding text
 * (the quiet but default-on `internalization_core_grounding` flag), runner
 * base instructions, or output-schema descriptions. `usedTokens <= budgetTokens`
 * is therefore an injection-field budget ceiling, NOT a prompt-total-length
 * hard cap. If prompt-total-length control is ever needed, a separate total
 * budget must be declared with an explicit priority relation to budgetTokens.
 */

import type { ContextManifest } from './context-manifest.js';
import { CONTEXT_MANIFEST_SCHEMA_VERSION } from './context-manifest.js';

/**
 * Dreamer manifest. `pain.summary.*` / `diagnosis.summary.*` resolve to the
 * diagnostic-chain writer-side summaries forwarded via the diag_router →
 * dreamer `predecessorSummary` (PR 1, design §4.7.1). tier2 empty → dreamer
 * does not read raw large fields.
 */
export const DREAMER_MANIFEST: ContextManifest = {
  manifestId: 'dreamer.v1',
  schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
  runnerKind: 'dreamer',
  tier0: ['pain.summary.headline', 'diagnosis.summary.headline'],
  tier1: [
    'pain.summary.category',
    'pain.summary.severity',
    'pain.summary.rootSymptom',
    'diagnosis.summary.rootCause',
    'diagnosis.summary.affectedComponents',
  ],
  tier2: [],
  budgetTokens: 1500,
  priority: [
    'diagnosis.summary.rootCause',
    'pain.summary.rootSymptom',
    'pain.summary.category',
    'pain.summary.severity',
    'diagnosis.summary.affectedComponents',
    'pain.summary.headline',
    'diagnosis.summary.headline',
  ],
};

/**
 * Scribe manifest. Reads the dreamer 5 dimensions through
 * `philosopher.predecessorSummary.*` (the value of PR 1's writer-side
 * forwarding — design §4.7 修正七). tier2 empty.
 */
export const SCRIBE_MANIFEST: ContextManifest = {
  manifestId: 'scribe.v1',
  schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
  runnerKind: 'scribe',
  tier0: ['philosopher.summary.headline', 'philosopher.predecessorSummary.headline'],
  tier1: [
    'philosopher.summary.thesis',
    'philosopher.summary.principleTitle',
    'philosopher.summary.principleScope',
    // dreamer 5 dims forwarded via philosopher writer (修正七's value)
    'philosopher.predecessorSummary.badDecision',
    'philosopher.predecessorSummary.betterDecision',
    'philosopher.predecessorSummary.rationale',
    'philosopher.predecessorSummary.riskLevel',
    'philosopher.predecessorSummary.strategicPerspective',
  ],
  tier2: [],
  budgetTokens: 1800,
  priority: [
    'philosopher.summary.principleTitle',
    'philosopher.summary.thesis',
    'philosopher.predecessorSummary.betterDecision',
    'philosopher.predecessorSummary.riskLevel',
    'philosopher.predecessorSummary.rationale',
    'philosopher.summary.principleScope',
    'philosopher.predecessorSummary.badDecision',
    'philosopher.predecessorSummary.strategicPerspective',
    'philosopher.summary.headline',
    'philosopher.predecessorSummary.headline',
  ],
};

/**
 * Artificer manifest. Under the one-level-redundancy rule, dreamer 5 dims are
 * NOT in scribe.predecessorSummary (that holds philosopher); so artificer's
 * dreamer context continues to flow through PRI-508's `resolveDreamerContext`
 * (F2) as tier2 raw fields.
 */
export const ARTIFICER_MANIFEST: ContextManifest = {
  manifestId: 'artificer.v1',
  schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
  runnerKind: 'artificer',
  tier0: ['scribe.summary.headline', 'scribe.predecessorSummary.headline'],
  tier1: ['scribe.summary.principleText', 'scribe.summary.scope', 'scribe.summary.exceptions'],
  tier2: ['dreamer.raw.betterDecision', 'dreamer.raw.rationale', 'dreamer.raw.riskLevel'],
  budgetTokens: 2000,
  priority: [
    'scribe.summary.principleText',
    'dreamer.raw.betterDecision',
    'scribe.summary.scope',
    'dreamer.raw.rationale',
    'dreamer.raw.riskLevel',
    'scribe.summary.exceptions',
    'scribe.summary.headline',
    'scribe.predecessorSummary.headline',
  ],
};

/**
 * Evaluator Stage 1 manifest — summary-level only (no tier2 raw fields).
 * Stage 1's `dreamer.summary.*` / `pain.summary.*` are read at the summary
 * level via CandidateLineage (Layer 2); if a summary is absent the path enters
 * `absent` and surfaces as a `summary_absent` degradation, never a silent empty.
 */
export const EVALUATOR_STAGE1_MANIFEST: ContextManifest = {
  manifestId: 'evaluator.stage1.v1',
  schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
  runnerKind: 'evaluator',
  tier0: ['artificer.summary.headline', 'artificer.predecessorSummary.headline'],
  tier1: [
    'scribe.summary.principleText',
    'scribe.summary.scope',
    'artificer.summary.changedFiles',
    'artificer.summary.apiSurface',
    'artificer.summary.risks',
    'dreamer.summary.badDecision',
    'dreamer.summary.betterDecision',
    'dreamer.summary.rationale',
    'dreamer.summary.riskLevel',
    'pain.summary.rootSymptom',
    'pain.summary.category',
  ],
  tier2: [],
  budgetTokens: 3000,
  priority: [
    'scribe.summary.principleText',
    'dreamer.summary.betterDecision',
    'pain.summary.rootSymptom',
    'artificer.summary.apiSurface',
    'dreamer.summary.riskLevel',
    'dreamer.summary.rationale',
    'scribe.summary.scope',
    'artificer.summary.risks',
    'pain.summary.category',
    'artificer.summary.changedFiles',
    'dreamer.summary.badDecision',
    'artificer.summary.headline',
    'artificer.predecessorSummary.headline',
  ],
};

/**
 * Evaluator Stage 2 manifest — Stage 1 plus tier2 raw fields for the
 * independent re-evaluation (design §6.5). budgetTokens is larger to
 * accommodate the raw fields.
 */
export const EVALUATOR_STAGE2_MANIFEST: ContextManifest = {
  ...EVALUATOR_STAGE1_MANIFEST,
  manifestId: 'evaluator.stage2.v1',
  tier2: ['pain.raw.evidence', 'dreamer.raw.candidates'],
  budgetTokens: 4500,
  priority: [...EVALUATOR_STAGE1_MANIFEST.priority, 'pain.raw.evidence', 'dreamer.raw.candidates'],
};

/**
 * The built-in manifest registry. **Always exactly 4** manifests (dreamer /
 * scribe / artificer / evaluator-with-two-variants). The three diagnostic
 * stages own NO manifest (design §4.7.1, requirement 2.14). The scope-
 * regression test (PR 1 task 3.21) guards this count.
 *
 * Exposed for: well-formedness enumeration (CP-12), the CLI's manifest
 * resolution, and the architecture-regression assertion that no diag kind is a
 * manifest's runnerKind.
 */
export const BUILTIN_MANIFESTS: readonly ContextManifest[] = [
  DREAMER_MANIFEST,
  SCRIBE_MANIFEST,
  ARTIFICER_MANIFEST,
  EVALUATOR_STAGE1_MANIFEST,
  EVALUATOR_STAGE2_MANIFEST,
];

/**
 * The distinct runnerKinds that own a manifest. Always a subset of
 * {dreamer, scribe, artificer, evaluator} — never includes a diagnostic kind.
 */
export const MANIFEST_RUNNER_KINDS: readonly string[] = Array.from(
  new Set(BUILTIN_MANIFESTS.map((m) => m.runnerKind)),
);
