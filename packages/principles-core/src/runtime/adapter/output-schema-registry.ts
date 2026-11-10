/**
 * Output Schema Registry — shared mapping from `outputSchemaRef` string to the
 * TypeBox schema that validates a runtime adapter's parsed output.
 *
 * Single source of truth for PiAiRuntimeAdapter (and any future
 * PDRuntimeAdapter). Extracted from pi-ai-runtime-adapter.ts so every caller
 * validates Stage A/B outputs against the correct schema
 * instead of hardcoding a stage-specific schema.
 *
 * Why this matters: the split diagnostician pipeline runs three stages, each
 * producing a DIFFERENT output shape:
 *   - Stage A (diag_rootcause) → DiagRootCauseOutputV1 (causalChain, rootCauseCategory)
 *   - Stage B (diag_distiller) → DiagDistillerOutputV1 (abstractedPrinciple, rationale)
 *   - Stage C (diag_router)    → DiagnosticianOutputV2 (violatedPrinciples,
 *     recommendations with recommendationRef + principleAssociation — PRI-1146 V2 Only)
 * Stage runners pass `outputSchemaRef` on StartRunInput to name which shape they
 * expect; adapters MUST resolve the schema from this registry rather than assume
 * a single stage's shape.
 */
import type { TSchema } from '@sinclair/typebox';
import { DiagnosticianOutputV2Schema } from '../diagnostician-output.js';
import { DiagRootCauseOutputV1Schema } from '../diagnostician/diag-rootcause-output.js';
import { DiagDistillerOutputV1Schema } from '../diagnostician/diag-distiller-output.js';
import { DreamerOutputV1Schema } from '../internalization/dreamer-output.js';
import { PhilosopherOutputV1Schema } from '../internalization/philosopher-output.js';
import { ScribeOutputV1Schema } from '../internalization/scribe-output.js';
import { ArtificerRuleOutputSchema } from '../internalization/artificer-output.js';
import { EvaluatorOutputV1Schema } from '../internalization/evaluator-output.js';
import { RolloutReviewerOutputV1Schema } from '../internalization/rollout-reviewer-output.js';
import { CorrectionObserverOutputV1Schema } from '../observer/correction-observer.js';
import { SignalClassificationOutputV2Schema } from '../signal-collector/types.js';
import { ReuseEvaluationOutputV1Schema } from '../principle-reuse/reuse-evaluation-output.js';
import { LearningLabActorActionV1Schema } from '../learning-lab/actor-action-output.js';

/**
 * Map of `outputSchemaRef` string → TypeBox schema. Keys match the
 * `outputSchemaRef` values passed by each runner's `invokeRuntime()`.
 */
export const OUTPUT_SCHEMA_REGISTRY: ReadonlyMap<string, TSchema> = new Map<string, TSchema>([
  // PRI-1139 (PR-6 cutover): the registry keys are version-NEUTRAL and are the
  // only current write standard. The versioned spelling each runner passed
  // before the cutover still resolves through OUTPUT_SCHEMA_REF_ALIASES below,
  // so historical refs stay readable while every production writer uses the
  // canonical key.
  // PRI-1146 (V2 Only / Clean Break): `diagnostician-output` now resolves to
  // the V2 schema, and Diagnostician's own versioned alias pair was REMOVED —
  // `diagnostician-output-v1` intentionally no longer resolves (fail-loud
  // `Unknown outputSchemaRef`). Every other stage keeps its alias pair.
  ['diagnostician-output', DiagnosticianOutputV2Schema],
  ['diag-rootcause-output', DiagRootCauseOutputV1Schema],
  ['diag-distiller-output', DiagDistillerOutputV1Schema],
  ['dreamer-output', DreamerOutputV1Schema],
  ['philosopher-output', PhilosopherOutputV1Schema],
  ['scribe-output', ScribeOutputV1Schema],
  ['artificer-rule-output', ArtificerRuleOutputSchema],
  ['evaluator-output', EvaluatorOutputV1Schema],
  ['rollout-reviewer-output', RolloutReviewerOutputV1Schema],
  ['correction-observer-output', CorrectionObserverOutputV1Schema],
  ['signal-classification-output', SignalClassificationOutputV2Schema],
  // PRI-917 v0.3.2: the Semantic Reuse Evaluation Capability's proposal contract
  // (proposal-only — its outputs are never persisted; SPEC section 4.2/10).
  ['reuse-evaluation-output', ReuseEvaluationOutputV1Schema],
  // PRI-966 G2: the Learning Lab real-actor round contract — one environment
  // action per interactive round for the research actor. Production runners
  // never pass this ref; see learning-lab/actor-action-output.ts.
  ['learning-lab-actor-action', LearningLabActorActionV1Schema],
]);

/**
 * PRI-1104 Stage 0 (expand) — version-neutral ↔ versioned contract refs.
 *
 * One declaration, no shadow list. Both directions are registered up front so
 * this table never needs to change during the single-version convergence:
 *   - PR-1..PR-5: the registry still owned versioned keys, so a
 *     version-neutral ref resolved FORWARD through this table;
 *   - PR-6 (PRI-1139, now): registry keys are version-neutral, so historical
 *     versioned refs resolve BACKWARD through the same table.
 *
 * `resolveOutputSchema` always tries an exact registry hit first, so this
 * table is inert for every ref already registered. PR-6 can therefore be
 * reverted independently: whichever ref the writer uses, the reader resolves.
 *
 * Deliberately NOT listed: retired v1 refs such as
 * `signal-classification-output-v1` — and, since PRI-1146, Diagnostician's
 * own `diagnostician-output-v1`. Those were removed as an intentional
 * breaking change (Clean Break); re-admitting them would hide the
 * fail-loud `Unknown outputSchemaRef` contract.
 */
const CONTRACT_REF_PAIRS: readonly (readonly [string, string])[] = [
  ['diag-rootcause-output', 'diag-rootcause-output-v1'],
  ['diag-distiller-output', 'diag-distiller-output-v1'],
  ['dreamer-output', 'dreamer-output-v1'],
  ['philosopher-output', 'philosopher-output-v1'],
  ['scribe-output', 'scribe-output-v1'],
  ['artificer-rule-output', 'artificer-rule-output-v2'],
  ['evaluator-output', 'evaluator-output-v1'],
  ['rollout-reviewer-output', 'rollout-reviewer-output-v1'],
  ['correction-observer-output', 'correction-observer-output-v1'],
  ['signal-classification-output', 'signal-classification-output-v2'],
  ['reuse-evaluation-output', 'reuse-evaluation-output-v1'],
  ['learning-lab-actor-action', 'learning-lab-actor-action-v1'],
];

const aliasEntries: [string, string][] = [];
for (const [neutral, versioned] of CONTRACT_REF_PAIRS) {
  aliasEntries.push([neutral, versioned], [versioned, neutral]);
}
export const OUTPUT_SCHEMA_REF_ALIASES: ReadonlyMap<string, string> = new Map(aliasEntries);

/**
 * Resolve the TypeBox schema for a given `outputSchemaRef`.
 *
 * @param ref - the outputSchemaRef string passed by a runner (e.g. 'diag-rootcause-output').
 * @returns the matching schema, or `undefined` when:
 *   - `ref` is undefined/null/empty (caller should apply its own default), OR
 *   - `ref` is a non-empty string not present in the registry or the PRI-1104
 *     alias table (caller should fail loud).
 * Callers MUST distinguish these two cases: an absent ref is "use default", an
 * unknown ref is a bug (fail loud per rc-3-fail-loud-missing).
 */
export function resolveOutputSchema(ref: string | undefined | null): TSchema | undefined {
  if (!ref) return undefined;
  const direct = OUTPUT_SCHEMA_REGISTRY.get(ref);
  if (direct !== undefined) return direct;
  const alias = OUTPUT_SCHEMA_REF_ALIASES.get(ref);
  return alias === undefined ? undefined : OUTPUT_SCHEMA_REGISTRY.get(alias);
}
