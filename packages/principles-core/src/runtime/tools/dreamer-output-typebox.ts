/**
 * PRI-419 — typebox redeclaration of DreamerOutputV1 for the L2 agent loop.
 *
 * Why this file exists (PLAN §M6 / review P0-4):
 *   pi-agent-core's `AgentTool<TParameters extends TSchema>` requires a schema built
 *   with the `typebox` package (the earendil fork), NOT PD's usual `@sinclair/typebox`.
 *   The two packages are nominally incompatible TS types and PD's Runtime Contract
 *   forbids `as` to bridge them. The `submit_output` tool's parameter schema must
 *   therefore be declared with `typebox` directly.
 *
 *   This file redeclares the DreamerOutputV1 shape with `typebox`, structured so the
 *   `submit_output` tool can require the model to return a complete candidate set. The
 *   authoritative runtime validator remains `DefaultDreamerValidator` (which validates
 *   `unknown` field-by-field) — the schema here is the LLM-facing tool contract only.
 *
 * Consistency guarantee:
 *   `dreamer-output-typebox.test.ts` proves that for a shared sample set (valid +
 *   invalid candidates), this typebox schema's structural requirements match the
 *   @sinclair/typebox `DreamerOutputV1Schema` requirements. No `as`, no cast — the
 *   proof is behavioural (both reject the same invalid shapes).
 *
 * Boundary: pure data, zero I/O. Lives in core. No `node:*` imports.
 */
import { Type } from 'typebox';

/**
 * Minimal typebox schema for a single dreamer candidate, matching
 * DreamerCandidateSchema (dreamer-output.ts) field-for-field.
 */
export const DreamerCandidateTypebox = Type.Object({
  candidateIndex: Type.Number(),
  badDecision: Type.String({ minLength: 1 }),
  betterDecision: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  riskLevel: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  strategicPerspective: Type.String({ minLength: 1 }),
});

/**
 * typebox redeclaration of DreamerOutputV1Schema.
 *
 * Used as the parameter schema of the `submit_output` tool in the L2 dreamer loop.
 * Field-for-field equivalent to the @sinclair/typebox DreamerOutputV1Schema — see
 * dreamer-output-typebox.test.ts for the consistency proof.
 */
export const DreamerOutputV1Typebox = Type.Object({
  valid: Type.Boolean(),
  taskId: Type.String({ minLength: 1 }),
  candidates: Type.Array(DreamerCandidateTypebox, { minItems: 1, maxItems: 5 }),
  sourcePrincipleId: Type.Optional(Type.String()),
  sourcePainId: Type.Optional(Type.String()),
  contextRefs: Type.Array(Type.String()),
  generatedAt: Type.String({ minLength: 1 }),
  reason: Type.Optional(Type.String()),
});
