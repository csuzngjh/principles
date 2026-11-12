/**
 * Adaptive principle selection output contract (Phase-1 stability S5).
 *
 * The host-runtime selector (`adaptive-selection.ts`) asks the model to pick at
 * most ONE principle for the current turn. Before S5 that call reached the
 * runtime adapter without an `outputSchemaRef`, so the answer was accepted as
 * plain JSON and only the host's own `parseSelectionShape` guard could reject
 * it — the adapter scored every other runner but not this one.
 *
 * Registered in OUTPUT_SCHEMA_REGISTRY under `adaptive-selection-output`.
 * The three branches mirror `parseSelectionShape` exactly:
 *   - selected      → id + digest are both REQUIRED (a candidate can only be
 *                     chosen by copying the locally precomputed digest);
 *   - none_applicable / uncertain → id and digest must be absent or null.
 *
 * `digest` is copied, never computed by the model (see adaptive-selection.ts
 * contract notes), so the schema only enforces presence/non-emptiness, not a
 * hash format; hash verification stays a host-side authority (P4).
 */
import { Type } from '@sinclair/typebox';

export const AdaptiveSelectionOutputV1Schema = Type.Union([
  Type.Object({
    status: Type.Literal('selected'),
    id: Type.String({ minLength: 1 }),
    digest: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    status: Type.Literal('none_applicable'),
    id: Type.Optional(Type.Null()),
    digest: Type.Optional(Type.Null()),
  }),
  Type.Object({
    status: Type.Literal('uncertain'),
    id: Type.Optional(Type.Null()),
    digest: Type.Optional(Type.Null()),
  }),
]);

