---
phase: 01-core-protocol-contracts
plan: 01
status: complete
completed: "2026-04-21T21:00:00.000Z"
---

# Plan 01-01: Foundation TypeBox Schemas — Complete

## What was built

Upgraded error-categories, agent-spec, and schema-version from pure TypeScript types to TypeBox schemas with Static type derivation, matching the existing PainSignalSchema pattern.

## Tasks

| # | Task | Status |
|---|------|--------|
| 1 | Upgrade error-categories.ts to TypeBox schemas | Done |
| 2 | Upgrade agent-spec.ts to TypeBox schemas | Done |
| 3 | Upgrade schema-version.ts with TypeBox version schema | Done |

## Key Decisions

- PDErrorCategorySchema uses `Type.Union` with 16 literals + `Value.Check` for type guard
- AgentSpecSchema uses `Type.String()` array for preferredRuntimeKinds (avoids cross-file TypeBox references)
- SchemaVersionRefSchema uses `Type.TemplateLiteral` for "kind-vN" format validation

## Files

### key-files.created
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategorySchema + isPDErrorCategory guard
- `packages/principles-core/src/runtime-v2/agent-spec.ts` — AgentSpecSchema + sub-schemas
- `packages/principles-core/src/runtime-v2/schema-version.ts` — SchemaVersionRefSchema + RuntimeV2SchemaVersionSchema
- `packages/principles-core/src/runtime-v2/index.ts` — Schema re-exports

## Verification

- `npx tsc --noEmit` passes (zero errors)
- All 16 PDErrorCategory literals present
- AgentSpec has all 10 required fields
- All types derived via `Static<typeof XxxSchema>`

## Issues

None.
