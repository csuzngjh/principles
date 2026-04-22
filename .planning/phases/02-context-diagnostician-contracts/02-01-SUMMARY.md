---
phase: 02-context-diagnostician-contracts
plan: 01
status: complete
requirements: [CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, DIAG-01, DIAG-02]
---

# 02-01: Context Payload + Diagnostician Output TypeBox Schemas

## What was built

Upgraded context-payload.ts and diagnostician-output.ts from plain TypeScript interfaces to TypeBox schemas with Static type derivation, following the Phase 1 pattern. All 14 new schemas are re-exported from index.ts.

### Key Files

| File | Action | Lines |
|------|--------|-------|
| `packages/principles-core/src/runtime-v2/context-payload.ts` | Rewritten | 8 TypeBox schemas replacing 8 interfaces |
| `packages/principles-core/src/runtime-v2/diagnostician-output.ts` | Rewritten | 5 TypeBox schemas + 1 hybrid (schema + interface) |
| `packages/principles-core/src/runtime-v2/index.ts` | Updated | 14 new schema re-exports added |

### Schemas Created

**context-payload.ts (8 schemas):**
- `HistoryQueryEntrySchema` — role as 4-literal union (user, assistant, tool, system)
- `TrajectoryLocateQuerySchema` — all fields optional, timeRange as nested object
- `TrajectoryCandidateSchema` — confidence constrained 0-1
- `TrajectoryLocateResultSchema` — composes query + candidates array
- `HistoryQueryResultSchema` — sourceRef + entries + truncated flag
- `DiagnosisTargetSchema` — 5 optional fields (D-03 shared interface)
- `ContextPayloadSchema` — diagnosisTarget optional
- `DiagnosticianContextPayloadSchema` — diagnosisTarget required, plus contextHash/taskId/workspaceDir

**diagnostician-output.ts (6 schemas):**
- `DiagnosticianViolatedPrincipleSchema` — principleId/title optional, rationale required
- `DiagnosticianEvidenceSchema` — sourceRef + note
- `RecommendationKindSchema` — 5-literal union (principle, rule, implementation, prompt, defer)
- `DiagnosticianRecommendationSchema` — kind + description
- `DiagnosticianOutputV1Schema` — full diagnosis output with confidence 0-1
- `DiagnosticianInvocationInputSchema` — hybrid: schema uses Type.Unknown() for context, interface uses DiagnosticianContextPayload (D-02)

## Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D-01 | All types get independent TypeBox schemas | Consistent with Phase 1 pattern, enables runtime validation |
| D-02 | DiagnosticianInvocationInput.context typed as DiagnosticianContextPayload | Type safety at compile time; schema uses Type.Unknown() to avoid circular TypeBox refs |
| D-03 | DiagnosisTarget shared with 5 optional fields | Used by both ContextPayload (optional) and DiagnosticianContextPayload (required) |

## Verification

- `npx tsc --noEmit` passes (zero new errors, excluding pre-existing io.ts)
- All 14 schemas exported from index.ts
- All existing type exports preserved
- No `export interface` remains in context-payload.ts (fully replaced by Static types)
- DiagnosticianInvocationInput retains TypeScript interface alongside schema (hybrid pattern)

## Self-Check: PASSED
