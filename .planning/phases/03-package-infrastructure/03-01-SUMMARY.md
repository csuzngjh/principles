---
phase: 03-package-infrastructure
plan: 01
status: complete
requirements: [INFRA-01, INFRA-02, INFRA-03]
completed_at: "2026-04-21T23:00:00.000Z"
---

# Plan 03-01: Package Infrastructure — Re-exports, exports, wiring

## What was built

Wired all 30+ TypeBox schema value exports through the main barrel export (`packages/principles-core/src/index.ts`) so consumers can import from either `@principles/core` or `@principles/core/runtime-v2`.

## Changes

### Task 1: Add TypeBox schema re-exports to main index.ts

Replaced the minimal 6-export runtime-v2 block with organized logical groups containing all Phase 1 + Phase 2 schema value exports:

- **Versioning + error categories** (8 exports): `RUNTIME_V2_SCHEMA_VERSION`, `schemaRef`, `SchemaVersionRefSchema`, `RuntimeV2SchemaVersionSchema`, `PDErrorCategorySchema`, `PD_ERROR_CATEGORIES`, `PDRuntimeError`, `isPDErrorCategory`
- **Agent specification** (5 exports): `AGENT_IDS`, `AgentCapabilityRequirementsSchema`, `AgentTimeoutPolicySchema`, `AgentRetryPolicySchema`, `AgentSpecSchema`
- **Runtime protocol** (13 exports): `RuntimeKindSchema`, `RuntimeCapabilitiesSchema`, `RuntimeHealthSchema`, `RunHandleSchema`, `RunExecutionStatusSchema`, `RunStatusSchema`, `ContextItemSchema`, `AgentSpecRefSchema`, `WorkflowRefSchema`, `TaskRefSchema`, `StartRunInputSchema`, `StructuredRunOutputSchema`, `RuntimeArtifactRefSchema`
- **Task status** (3 exports): `PDTaskStatusSchema`, `TaskRecordSchema`, `DiagnosticianTaskRecordSchema`
- **Runtime selector** (1 export): `RuntimeSelectionCriteriaSchema`
- **Context payload — Phase 2** (8 exports): `HistoryQueryEntrySchema`, `TrajectoryLocateQuerySchema`, `TrajectoryCandidateSchema`, `TrajectoryLocateResultSchema`, `HistoryQueryResultSchema`, `DiagnosisTargetSchema`, `ContextPayloadSchema`, `DiagnosticianContextPayloadSchema`
- **Diagnostician output — Phase 2** (6 exports): `DiagnosticianViolatedPrincipleSchema`, `DiagnosticianEvidenceSchema`, `RecommendationKindSchema`, `DiagnosticianRecommendationSchema`, `DiagnosticianOutputV1Schema`, `DiagnosticianInvocationInputSchema`

Type exports (24+ type aliases) preserved unchanged.

### Task 2: Verify package.json exports and import paths

Verified:
- `package.json` exports has `./runtime-v2` entry with types + default conditions
- `package.json` exports has `.` entry (main barrel)
- `tsconfig.json` has `declaration: true`, `outDir: "./dist"`, `include: "src/**/*"`
- `npx tsc --noEmit` passes with zero new errors
- All four import patterns resolve correctly:
  - `import { PDErrorCategorySchema } from '@principles/core'` (value export)
  - `import type { AgentSpec } from '@principles/core'` (type export)
  - `import { AgentSpecSchema } from '@principles/core/runtime-v2'` (value export)
  - `import type { ContextPayload } from '@principles/core/runtime-v2'` (type export)

## key-files

### created

(no new files created — existing file modified)

### modified

- `packages/principles-core/src/index.ts` — Added 30+ TypeBox schema value exports in organized groups

## Acceptance Criteria

- [x] `import { PDErrorCategorySchema } from '@principles/core'` resolves
- [x] `import type { AgentSpec } from '@principles/core'` resolves
- [x] `package.json` exports contains `./runtime-v2` entry
- [x] `runtime-v2/index.ts` exports all Phase 1 + Phase 2 contracts
- [x] `npx tsc --noEmit` passes (excluding pre-existing io.ts error)
- [x] Main index.ts contains 30+ schema value exports
- [x] Type exports unchanged (24+ types still present)

## Self-Check: PASSED

All must_haves verified:
- main index.ts re-exports all runtime-v2 schema value exports alongside existing type exports
- `import { PDErrorCategorySchema } from '@principles/core'` resolves
- `import type { AgentSpec } from '@principles/core'` resolves
- package.json exports contains `./runtime-v2` entry with types and default conditions
- runtime-v2/index.ts exports all Phase 1 + Phase 2 contracts

## Issues

None.
