/**
 * Output Schema Registry — shared mapping from `outputSchemaRef` string to the
 * TypeBox schema that validates a runtime adapter's parsed output.
 *
 * Single source of truth for both PiAiRuntimeAdapter and OpenClawCliRuntimeAdapter
 * (and any future PDRuntimeAdapter). Extracted from pi-ai-runtime-adapter.ts so
 * the OpenClaw adapter can validate Stage A/B outputs against the correct schema
 * instead of hardcoding DiagnosticianOutputV1Schema.
 *
 * Why this matters: the split diagnostician pipeline runs three stages, each
 * producing a DIFFERENT output shape:
 *   - Stage A (diag_rootcause) → DiagRootCauseOutputV1 (causalChain, rootCauseCategory)
 *   - Stage B (diag_distiller) → DiagDistillerOutputV1 (abstractedPrinciple, rationale)
 *   - Stage C (diag_router)    → DiagnosticianOutputV1  (violatedPrinciples, recommendations)
 * Stage runners pass `outputSchemaRef` on StartRunInput to name which shape they
 * expect; adapters MUST resolve the schema from this registry rather than assume
 * DiagnosticianOutputV1 (which only matches Stage C).
 */
import type { TSchema } from '@sinclair/typebox';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import { DiagRootCauseOutputV1Schema } from '../diagnostician/diag-rootcause-output.js';
import { DiagDistillerOutputV1Schema } from '../diagnostician/diag-distiller-output.js';
import { DreamerOutputV1Schema } from '../internalization/dreamer-output.js';
import { PhilosopherOutputV1Schema } from '../internalization/philosopher-output.js';
import { ScribeOutputV1Schema } from '../internalization/scribe-output.js';
import { ArtificerRuleOutputSchema } from '../internalization/artificer-output.js';
import { EvaluatorOutputV1Schema } from '../internalization/evaluator-output.js';
import { RolloutReviewerOutputV1Schema } from '../internalization/rollout-reviewer-output.js';
import { EmpathyObserverOutputV1Schema } from '../observer/empathy-observer.js';
import { CorrectionObserverOutputV1Schema } from '../observer/correction-observer.js';
import { SignalClassificationOutputV1Schema } from '../signal-collector/types.js';

/**
 * Map of `outputSchemaRef` string → TypeBox schema. Keys match the
 * `outputSchemaRef` values passed by each runner's `invokeRuntime()`.
 */
export const OUTPUT_SCHEMA_REGISTRY: ReadonlyMap<string, TSchema> = new Map<string, TSchema>([
  ['diagnostician-output-v1', DiagnosticianOutputV1Schema],
  ['diag-rootcause-output-v1', DiagRootCauseOutputV1Schema],
  ['diag-distiller-output-v1', DiagDistillerOutputV1Schema],
  ['dreamer-output-v1', DreamerOutputV1Schema],
  ['philosopher-output-v1', PhilosopherOutputV1Schema],
  ['scribe-output-v1', ScribeOutputV1Schema],
  ['artificer-rule-output-v2', ArtificerRuleOutputSchema],
  ['evaluator-output-v1', EvaluatorOutputV1Schema],
  ['rollout-reviewer-output-v1', RolloutReviewerOutputV1Schema],
  ['empathy-observer-output-v1', EmpathyObserverOutputV1Schema],
  ['correction-observer-output-v1', CorrectionObserverOutputV1Schema],
  ['signal-classification-output-v1', SignalClassificationOutputV1Schema],
]);

/**
 * Resolve the TypeBox schema for a given `outputSchemaRef`.
 *
 * @param ref - the outputSchemaRef string passed by a runner (e.g. 'diag-rootcause-output-v1').
 * @returns the matching schema, or `undefined` when:
 *   - `ref` is undefined/null/empty (caller should apply its own default), OR
 *   - `ref` is a non-empty string not present in the registry (caller should fail loud).
 * Callers MUST distinguish these two cases: an absent ref is "use default", an
 * unknown ref is a bug (fail loud per rc-3-fail-loud-missing).
 */
export function resolveOutputSchema(ref: string | undefined | null): TSchema | undefined {
  if (!ref) return undefined;
  return OUTPUT_SCHEMA_REGISTRY.get(ref);
}
