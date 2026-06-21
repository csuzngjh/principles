/**
 * PRI-439 — typebox redeclaration of ArtificerRuleOutput for the L2 agent loop.
 *
 * Why this file exists (mirrors dreamer-output-typebox.ts):
 *   pi-agent-core's `AgentTool<TParameters extends TSchema>` requires a schema built
 *   with the `typebox` package (the earendil fork), NOT PD's usual `@sinclair/typebox`.
 *   The two packages are nominally incompatible TS types and PD's Runtime Contract
 *   forbids `as` to bridge them. The `submit_rulecode` tool's parameter schema must
 *   therefore be declared with `typebox` directly.
 *
 *   This file redeclares the ArtificerRuleOutput shape with `typebox`, structured so
 *   the `submit_rulecode` tool can require the model to return a complete
 *   implementationCode + goldenTraceCases payload. The authoritative runtime
 *   validator remains `DefaultArtificerValidator` (which validates `unknown`
 *   field-by-field) — the schema here is the LLM-facing tool contract only.
 *
 * Consistency guarantee:
 *   `artificer-output-typebox.test.ts` proves that for a shared sample set (valid +
 *   invalid candidates), this typebox schema's structural requirements match the
 *   @sinclair/typebox `ArtificerRuleOutputSchema` requirements. No `as`, no cast —
 *   the proof is behavioural (both reject the same invalid shapes).
 *
 * Boundary: pure data, zero I/O. Lives in core. No `node:*` imports.
 */
import { Type } from 'typebox';

/**
 * typebox redeclaration of GoldenTraceCaseInput (artificer-output.ts).
 * Field-for-field equivalent — see artificer-output-typebox.test.ts for the proof.
 */
export const GoldenTraceCaseInputTypebox = Type.Object({
  caseId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal('positive'), Type.Literal('negative')]),
  toolName: Type.String({ minLength: 1 }),
  params: Type.Record(Type.String(), Type.Unknown()),
  expectedDecision: Type.Union([
    Type.Literal('allow'),
    Type.Literal('block'),
    Type.Literal('propose_correction'),
  ]),
  expectedProposedParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  expectedApplicationMode: Type.Optional(Type.Union([Type.Literal('shadow'), Type.Literal('live')])),
});

/**
 * typebox redeclaration of ArtificerSourceTrace (artificer-output.ts).
 */
export const ArtificerSourceTraceTypebox = Type.Object({
  scribeArtifactId: Type.String({ minLength: 1 }),
  philosopherArtifactId: Type.Optional(Type.String()),
  dreamerArtifactId: Type.Optional(Type.String()),
});

/**
 * typebox redeclaration of ArtificerRuleOutputSchema.
 *
 * Used as the parameter schema of the `submit_rulecode` tool in the L2 artificer
 * loop. Field-for-field equivalent to the @sinclair/typebox
 * ArtificerRuleOutputSchema — see artificer-output-typebox.test.ts for the
 * consistency proof.
 */
export const ArtificerRuleOutputTypebox = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  sourceScribeArtifactId: Type.String({ minLength: 1 }),
  implementationCode: Type.String({ minLength: 1 }),
  goldenTraceCases: Type.Array(GoldenTraceCaseInputTypebox, { minItems: 2, maxItems: 10 }),
  affectedTools: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  implementationSummary: Type.String({ minLength: 1 }),
  risks: Type.Array(Type.String()),
  sourceTrace: ArtificerSourceTraceTypebox,
  generatedAt: Type.String({ minLength: 1 }),
});
