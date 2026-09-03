/**
 * Layer 1 — the built-in ContextManifests (design §6.6).
 *
 * Pure logic only (Core vs Plugin boundary). These are the single source of
 * truth for which manifest each peer runner uses.
 *
 * INV-MANIFEST-SCOPE: the frozen invariant is **4 manifest-owning runner
 * KINDS** — dreamer / scribe / artificer / evaluator, with evaluator carrying
 * a Stage 1 + Stage 2 variant. It is NOT a literal manifest-instance count: a
 * runner kind may own more than one manifest VARIANT when its context needs
 * genuinely differ (e.g. `artificer.repair`, which additionally needs replay /
 * repair evidence a normal artificer must never see). The three diagnostic
 * stages own NO manifest (design §4.7.1, requirement 2.14, guarded by the
 * scope-regression test from PR 1 task 3.21).
 *
 * Field-path naming convention (design §6.6):
 *   `<stage>.summary.<key>`        — read from an ArtifactSummary
 *   `<stage>.predecessorSummary.*` — read from a forwarded predecessor summary
 *   `<stage>.raw.<path>`           — read from tier2 full contentJson (Layer 2)
 *                                    or from a related-reference namespace
 *
 * `<stage>.raw.<path>` paths must be TRUTHFUL: `readRawField` resolves them
 * verbatim against the durable contentJson. Numeric segments address array
 * elements — e.g. `dreamer.raw.candidates.0.betterDecision`, because
 * DreamerOutput nests its 5 dimensions under `candidates[0]`.
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
 * dreamer context resolves as tier2 raw fields through CandidateLineage (PR B).
 *
 * The tier2 paths address `candidates[0]` explicitly because that is where the
 * durable DreamerOutput keeps the selected candidate's 5 dimensions — the same
 * element `resolveDreamerContext` (PRI-508, F2) reads on the flag-off path.
 * When `context_manifest_budget` is OFF, `resolveDreamerContext` stays the
 * injection channel and this manifest is not consulted (design §23).
 */
export const ARTIFICER_MANIFEST: ContextManifest = {
  manifestId: 'artificer.v1',
  schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
  runnerKind: 'artificer',
  tier0: ['scribe.summary.headline', 'scribe.predecessorSummary.headline'],
  tier1: ['scribe.summary.principleText', 'scribe.summary.scope', 'scribe.summary.exceptions'],
  tier2: [
    'dreamer.raw.candidates.0.betterDecision',
    'dreamer.raw.candidates.0.rationale',
    'dreamer.raw.candidates.0.riskLevel',
  ],
  budgetTokens: 2000,
  priority: [
    'scribe.summary.principleText',
    'dreamer.raw.candidates.0.betterDecision',
    'scribe.summary.scope',
    'dreamer.raw.candidates.0.rationale',
    'dreamer.raw.candidates.0.riskLevel',
    'scribe.summary.exceptions',
    'scribe.summary.headline',
    'scribe.predecessorSummary.headline',
  ],
};

/**
 * Artificer REPAIR manifest variant (design §35).
 *
 * A repair round is a different context job than a first-write: it additionally
 * needs the concrete deterministic replay evidence and the evaluator's required
 * changes. Those fields do NOT belong on the normal ARTIFICER_MANIFEST — a
 * first-write artificer has no replay to read and would only be polluted by
 * repair-only namespaces.
 *
 * `replay.*` is a RELATED reference, not ancestry: the source Evaluator
 * artifact is referenced by `RepairPayload.sourceEvaluatorTaskId`, never pushed
 * into `lineageArtifactIds` (design §33 / INV-LINEAGE-SCOPE). The values come
 * from the PR-A `RepairReplayContext`, so the ≤16 bound
 * (MAX_REPLAY_FAILURES_IN_REPAIR) is inherited rather than re-expanded
 * (design §43).
 *
 * Flag-off behaviour is unchanged: when `context_manifest_budget` is false this
 * manifest is never consulted and PR A's `repairFeedback` string remains the
 * replay-evidence channel (PRI-634 invariant §26).
 */
export const ARTIFICER_REPAIR_MANIFEST: ContextManifest = {
  manifestId: 'artificer.repair.v1',
  schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
  runnerKind: 'artificer',
  tier0: ['scribe.summary.principleText', 'replay.summary.passed', 'replay.summary.failedCaseCount'],
  tier1: ['repair.summary.requiredChanges', 'repair.summary.concerns', 'replay.summary.failureTypes'],
  tier2: ['replay.raw.traceFailures', 'replay.raw.systemFailures', 'replay.raw.globalViolations'],
  budgetTokens: 2400,
  priority: [
    'scribe.summary.principleText',
    'replay.raw.traceFailures',
    'repair.summary.requiredChanges',
    'replay.raw.systemFailures',
    'replay.raw.globalViolations',
    'repair.summary.concerns',
    'replay.summary.passed',
    'replay.summary.failedCaseCount',
    'replay.summary.failureTypes',
  ],
};

/**
 * Evaluator Stage 1 manifest — summary-level only (no tier2 raw fields).
 *
 * NAMESPACE CORRECTION (PR B, fresh-code verification): this manifest names
 * stages that are NOT the Evaluator's direct predecessor (its predecessor is
 * the Artificer; `scribe.*` / `dreamer.*` / `diagnostician.*` sit further up
 * the chain). Layer 1's `readSummaryField` strips the leading `<stage>.`
 * segment and reads only the single loaded predecessor, so those ancestor
 * namespaces are resolved by the PR-B ancestry channel (`resolveAncestryPaths`,
 * which matches a lineage node by taskKind) — not by Channel 1.
 *
 * `pain.*` becomes `diagnostician.*`: `pain` is a LOGICAL namespace inside the
 * Layer 1 reader, never a lineage node (see the Stage 2 note below for the same
 * correction on the raw side).
 *
 * If an ancestor summary is absent the path enters `absent` and surfaces as a
 * `summary_absent` degradation, never a silent empty.
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
    'diagnostician.summary.rootSymptom',
    'diagnostician.summary.category',
  ],
  tier2: [],
  budgetTokens: 3000,
  priority: [
    'scribe.summary.principleText',
    'dreamer.summary.betterDecision',
    'diagnostician.summary.rootSymptom',
    'artificer.summary.apiSurface',
    'dreamer.summary.riskLevel',
    'dreamer.summary.rationale',
    'scribe.summary.scope',
    'artificer.summary.risks',
    'diagnostician.summary.category',
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
 *
 * SPEC ASSUMPTION STALE (PR B Phase 0, fresh-code verification): the SPEC's
 * example path `pain.raw.evidence` assumed a `pain` stage node on the lineage.
 * The real durable chain has taskKind `diagnostician`, and the pain evidence's
 * durable form is `DiagnosticianOutputV1.evidence` — so the ancestry raw path
 * is `diagnostician.raw.evidence` (ancestry matching is by taskKind, and
 * `pain` is only a LOGICAL summary-namespace in the Layer 1 reader, never a
 * lineage node). `dreamer.raw.candidates` addresses `DreamerOutput.candidates`
 * directly — the whole array, exactly what the deep-evidence stage reviews.
 */
export const EVALUATOR_STAGE2_MANIFEST: ContextManifest = {
  ...EVALUATOR_STAGE1_MANIFEST,
  manifestId: 'evaluator.stage2.v1',
  tier2: ['diagnostician.raw.evidence', 'dreamer.raw.candidates'],
  budgetTokens: 4500,
  priority: [...EVALUATOR_STAGE1_MANIFEST.priority, 'dreamer.raw.candidates', 'diagnostician.raw.evidence'],
};

/**
 * The built-in manifest registry (INV-MANIFEST-SCOPE): 4 manifest-owning
 * runner KINDS across 6 manifest INSTANCES — dreamer, scribe, artificer,
 * artificer.repair, evaluator.stage1, evaluator.stage2. No diagnostic stage
 * owns a manifest (design §4.7.1, requirement 2.14). The scope-regression test
 * guards the runner-kind set, not the instance count.
 *
 * Exposed for: well-formedness enumeration (CP-12), the CLI's manifest
 * resolution, and the architecture-regression assertion that no diag kind is a
 * manifest's runnerKind.
 */
export const BUILTIN_MANIFESTS: readonly ContextManifest[] = [
  DREAMER_MANIFEST,
  SCRIBE_MANIFEST,
  ARTIFICER_MANIFEST,
  ARTIFICER_REPAIR_MANIFEST,
  EVALUATOR_STAGE1_MANIFEST,
  EVALUATOR_STAGE2_MANIFEST,
];

/**
 * The distinct runnerKinds that own a manifest. Always exactly 4 and always a
 * subset of {dreamer, scribe, artificer, evaluator} — never includes a
 * diagnostic kind. Adding a runner-kind VARIANT (not a new kind) leaves this
 * unchanged, which is the intended reading of INV-MANIFEST-SCOPE.
 */
export const MANIFEST_RUNNER_KINDS: readonly string[] = Array.from(
  new Set(BUILTIN_MANIFESTS.map((m) => m.runnerKind)),
);
