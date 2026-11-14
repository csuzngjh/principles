# PROMPT_SCHEMA_BASELINE — PD-SPEC-001 Phase 0

> Frozen baseline of every output contract touched by the six target agents.
> V1 base commit: `0485046e71d2aeba4769725adb4f2aac35a5dd9b` (origin/main, worktree `ai/adhoc-20261115-prompt-v2-k4wz9t`).
> **Freeze rule (SPEC §1.3 / §8.1):** the V2 prompt work must not modify any file listed here. Verification method: `git diff 0485046e7..HEAD -- <files>` must be empty for all of them at handoff.

## 1. Schema registry and the validation path

- `packages/principles-core/src/runtime/adapter/output-schema-registry.ts:50-74` maps `outputSchemaRef` → TypeBox schema:
  - `diagnostician-output` → `DiagnosticianOutputV2Schema` (Router, Stage C)
  - `diag-rootcause-output` → `DiagRootCauseOutputV1Schema` (Stage A)
  - `diag-distiller-output` → `DiagDistillerOutputV1Schema` (Stage B)
  - `dreamer-output` → `DreamerOutputV1Schema`
  - `philosopher-output` → `PhilosopherOutputV1Schema`
  - `scribe-output` → `ScribeOutputV1Schema`
- **Adapter-level structural validation runs on the RAW model output before any runner transform** (`pi-ai-runtime-adapter.ts:1073` `Value.Check(schema, parsedOutput)`; tool-call and JSON-mode paths are schema-gated the same way). A failing raw output enters the structured-output repair loop (extra LLM round-trips) and can end as `output_invalid`.
- Runner-level validation runs AFTER `postFetchTransform` (`runner/base-peer-runner.ts:402-406`). For the Router, `postFetchTransform` (`internalization/diag-router-runner.ts:738-876`) overrides `rootCause`/`evidence`/`confidence` from Stage A/B and injects `abstractedPrinciple` from Stage B — i.e. **adapter validation sees the model's raw fields first; the runner's authority is applied only afterwards**.

## 2. Stage A — DiagRootCauseOutputV1 (`diagnostician/diag-rootcause-output.ts:206-230`)

| Field | Shape |
|---|---|
| `valid` | boolean (validator requires `true`) |
| `diagnosisId` | string ≥1 — **required** |
| `taskId` | string ≥1 (ERR-008 lineage; validator re-injects known sibling-prefix echoes) |
| `summary` | string ≥1 |
| `causalChain` | array of `{why: int 1..5, statement: string ≥1, evidenceRefs: string[] minItems 1}` — **no maxItems on the array; each entry needs ≥1 evidenceRef** |
| `rootCause` | string ≥1, MUST carry category prefix (`"People: "` etc.) |
| `rootCauseCategory` | enum `People \| Design \| Assumption \| Tooling` |
| `evidence` | array of `{sourceRef ≥1, note ≥1}` |
| `confidence` | number 0..1 |
| `ambiguityNotes` | optional string[] |
| `intentTension` | optional object (PRI-468; `additionalProperties:false`, `confidence` forbidden inside) |

Semantic validator `DefaultDiagRootCauseValidator` (same file, lines 268-405): taskId lineage, category-prefix consistency, per-entry causalChain/evidence checks, intentTension shape.

## 3. Stage B — DiagDistillerOutputV1 (`diagnostician/diag-distiller-output.ts:38-61`)

| Field | Shape |
|---|---|
| `valid` | boolean |
| `taskId` | string ≥1 |
| `sourceRootCauseArtifactId` | string ≥1 (lineage match) |
| `abstractedPrinciple` | string 1..200 |
| `rationale` | string ≥1 |
| `groundedOnCorePrincipleIds` | string[] — validated against T-01..T-10 registry at runtime; **empty array is valid** |
| `scope` | enum `general \| domain \| scenario` |
| `confidence` | number 0..1 |
| `ambiguityNotes` | optional string[] |

Validator `DefaultDiagDistillerValidator` (lines 102-170): sibling-prefix taskId re-injection, TypeBox check, registry membership for axiom ids.

## 4. Stage C — DiagnosticianOutputV2 (`diagnostician-output.ts:161-190`, `additionalProperties: false`)

Required root fields: `valid`, `diagnosisId`, `summary`, `rootCause`, `violatedPrinciples[]`, `evidence[]`, `recommendations[] (minItems 1)`, `confidence`, `schemaVersion: "diagnostician-output-v2"`. Optional: `ambiguityNotes`, `intentTension` (additive passthrough only — SPEC §18.2, hallucinated ones are stripped by the runner).

Recommendations are a discriminated union (lines 122-157):
- `kind:"rule"` → `triggerPattern` + `action` + `principleAssociation` structurally required
- `kind:"principle"` → `abstractedPrinciple` structurally **optional** (injected from Stage B by the runner before final validation; the semantic validator enforces non-empty at the last gate)
- other kinds (`implementation|prompt|defer`) → `recommendationRef` + `description`
- all kinds → artifact-locally-unique `recommendationRef`

`principleAssociation` (lines 84-103): `linked{implements, target: recommendation_ref|canonical_principle, rationale, evidenceRefs minItems 1}` or `unresolved{reason: no_supported_target|ambiguous_target|insufficient_evidence|principle_not_in_context}` — `additionalProperties:false`.

Extra runner check: at most ONE `kind:"principle"` entry (`diag-router-runner.ts:537-546`).

## 5. DreamerOutputV1 (`internalization/dreamer-output.ts:67-79`)

`valid`, `taskId`, `candidates (minItems 1, **maxItems 5 — GLOBAL cap**)` of `{candidateIndex, badDecision, betterDecision, rationale, confidence 0..1, riskLevel: low|medium|high, strategicPerspective}`, optional `sourcePrincipleId`/`sourcePainId`, `contextRefs`, `generatedAt`, optional `reason`.

## 6. PhilosopherOutputV1 (`internalization/philosopher-output.ts:33-46`)

`taskId`, `sourceDreamerArtifactId`, `thesis`, `principleCandidate{title, rationale, scope, confidence 0..1}`, `risks: string[]`, `generatedAt`. Exactly one thesis + one candidate (no rejectedCandidates array — SPEC V2 keeps this shape).

## 7. ScribeOutputV1 (`internalization/scribe-output.ts:71-121`)

`taskId`, `sourcePhilosopherArtifactId`, `principleDraft{title, statement, rationale, applicability[], antiPatterns[], confidence}`, `intentContract{ownerIntent, targetBehavior, forbiddenBehavior, evidenceSource, validationExpectation}` (all five required non-empty), `sourceTrace{philosopherArtifactId, dreamerArtifactId?}`, `risks[]`, `executionConditions{version: 1, requiredFacts[{factKind, required, textualBasis}]}` (required; `requiredFacts: []` valid), optional `ownerRequirementGaps: string[]`, `generatedAt`. Prompt contract version: `scribe-output-v1.prompt.v10` (scribe-prompt-builder.ts:307).

## 8. Confirmed schema↔prompt frictions (V1 evidence for SPEC Part III)

1. **Router raw-output conflict** — V2 schema requires `rootCause`/`evidence`/`confidence`/`diagnosisId` at the adapter gate, but the V1 Router prompt instructs the model NOT to generate `rootCause`/`evidence`/`confidence` (router-prompt-builder.ts:272-275) and never mentions `diagnosisId`. Real-failure corroboration: `diag-router-runner.ts:323-326` cites the 2026-11-12 experiment's "three identical schema rejections" that motivated repair feedback (P1-3).
2. **Distiller axiom-example channel** — `adapter/schema-prompt-adapter.ts:74-81` (`SEMANTIC_FIELD_EXAMPLES`) injects `groundedOnCorePrincipleIds: ["T-01"]` into the example regardless of whether the Core Axioms block was supplied; `T-01` passes the registry validator, so nothing structural stops unsupported grounding.
3. **Dreamer candidate-cap mismatch** — schema caps `candidates` at 5 globally; the V1 prompt says "For each identified root cause, generate 1-5 alternative decision candidates" (dreamer-prompt-builder.ts:84), which invites >5 total whenever the diagnosis lists several root causes/why-levels.

## 9. Frozen file list (V2 must not touch)

```
packages/principles-core/src/runtime/diagnostician-output.ts
packages/principles-core/src/runtime/diagnostician/diag-rootcause-output.ts
packages/principles-core/src/runtime/diagnostician/diag-distiller-output.ts
packages/principles-core/src/runtime/internalization/dreamer-output.ts
packages/principles-core/src/runtime/internalization/philosopher-output.ts
packages/principles-core/src/runtime/internalization/scribe-output.ts
packages/principles-core/src/runtime/adapter/output-schema-registry.ts
packages/principles-core/src/runtime/runner/base-peer-runner.ts          (validation order — unchanged by V2)
packages/principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts   (validation/repair path — unchanged by V2)
```

Note: `schema-prompt-adapter.ts` is NOT in the frozen list — SPEC §3.3 explicitly authorizes the example fix (`groundedOnCorePrincipleIds` default `[]`); the change is prompt-layer only, the adapter's schema validation semantics stay identical.
