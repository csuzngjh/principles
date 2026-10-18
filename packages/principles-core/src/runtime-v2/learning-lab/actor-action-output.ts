/**
 * Learning Lab real-actor round contract (PRI-966 G2 / SPEC-PD-PL-001 §4.2).
 *
 * One structured output per interactive round: the real actor reads its
 * arm-allowed inputs (world manual + task text + same-channel delivered
 * payload + observations so far) and answers with exactly ONE environment
 * action for the mechanical oracle to execute. Terminal semantics belong to
 * the oracle (`proceed`/`decline` terminate the run); this schema never
 * carries outcomes, scores or gold information.
 *
 * The action-name union mirrors the lab-owned oracle registry
 * (scripts/dev/principle-learning-lab/lib/oracle.mjs ACTION_COSTS). The lab's
 * regression suite machine-checks the two lists stay identical — the same
 * discipline the world-manual cost table already uses — so a drifted action
 * name fails tests instead of silently narrowing the actor's action space.
 *
 * Registered in OUTPUT_SCHEMA_REGISTRY so the production PiAiRuntimeAdapter
 * serves this ref through its standard structured-output machinery
 * (tool-call / json_schema rewrite / bounded repair) — the lab reuses the
 * production model-call path instead of building a second one. Production
 * runners never pass this ref; it exists for the research actor only.
 */
import { Type, type Static } from '@sinclair/typebox';

export const LearningLabActorActionV1Schema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('key-usage-grep'),
      Type.Literal('consumer-graph-query'),
      Type.Literal('contract-harness-run'),
      Type.Literal('harness-status'),
      Type.Literal('full-config-audit'),
      Type.Literal('staged-rollout'),
      Type.Literal('compat-shim'),
      Type.Literal('ask-owner'),
      Type.Literal('proceed'),
      Type.Literal('decline'),
    ]),
    args: Type.Optional(
      Type.Object({
        key: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        harness: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        consumer: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        question: Type.Optional(Type.String({ maxLength: 1000 })),
        reason: Type.Optional(Type.String({ maxLength: 1000 })),
        requestType: Type.Optional(Type.String({ maxLength: 100 })),
        targetKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
    ),
    narrative: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  { additionalProperties: false },
);

export type LearningLabActorActionV1 = Static<typeof LearningLabActorActionV1Schema>;

/** The outputSchemaRef string the lab passes on StartRunInput. */
export const LEARNING_LAB_ACTOR_ACTION_REF = 'learning-lab-actor-action-v1';

/** Action-name list mirrored from the oracle registry (cross-checked by tests). */
export const LEARNING_LAB_ACTOR_ACTION_NAMES: readonly string[] = [
  'key-usage-grep',
  'consumer-graph-query',
  'contract-harness-run',
  'harness-status',
  'full-config-audit',
  'staged-rollout',
  'compat-shim',
  'ask-owner',
  'proceed',
  'decline',
];
