---
phase: 01-core-protocol-contracts
plan: 02
status: complete
completed: "2026-04-21T21:10:00.000Z"
---

# Plan 01-02: Runtime Protocol TypeBox Schemas — Complete

## What was built

Upgraded runtime-protocol, task-status, and runtime-selector from pure TypeScript types to TypeBox schemas with Static type derivation.

## Tasks

| # | Task | Status |
|---|------|--------|
| 1 | Upgrade runtime-protocol.ts to TypeBox schemas | Done |
| 2 | Upgrade task-status.ts to TypeBox schemas | Done |
| 3 | Upgrade runtime-selector.ts to TypeBox schemas | Done |

## Key Decisions

- RuntimeKindSchema uses `Type.Union` with 5 literals (openclaw, codex-cli, gemini-cli, local-worker, test-double)
- TaskRecordSchema uses `PDErrorCategorySchema` for the lastError field (cross-file reference)
- DiagnosticianTaskRecordSchema uses `Type.Intersect` to extend TaskRecordSchema
- RuntimeSelectionCriteriaSchema inlines the agent spec shape (avoids circular cross-file TypeBox refs)
- RuntimeSelectionResult kept as TypeScript interface (contains PDRuntimeAdapter which has methods)
- RuntimeSelector interface kept as pure TypeScript (has methods)

## Files

### key-files.created
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RuntimeKindSchema + all run lifecycle schemas + PDRuntimeAdapter interface
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatusSchema + TaskRecordSchema + DiagnosticianTaskRecordSchema
- `packages/principles-core/src/runtime-v2/runtime-selector.ts` — RuntimeSelectionCriteriaSchema + RuntimeSelector interface
- `packages/principles-core/src/runtime-v2/index.ts` — Schema re-exports updated

## Verification

- `npx tsc --noEmit` passes (zero errors)
- All 5 RuntimeKind values present
- All 5 PDTaskStatus values present
- PDRuntimeAdapter and RuntimeSelector remain as TypeScript interfaces
- All types derived via `Static<typeof XxxSchema>`

## Issues

None.
