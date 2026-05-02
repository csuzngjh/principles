---
phase: m9-02
plan: 01
status: complete
completed: "2026-04-29"
tasks_completed: 3
tasks_total: 3
---

# m9-02-01 SUMMARY: Policy + Factory Integration

## What Was Built

Extended `workflows.yaml` policy to include runtime configuration fields and refactored `PainSignalRuntimeFactory` to select the appropriate runtime adapter based on policy settings. RuntimeKind is now configurable rather than hardcoded.

## Key Changes

### 1. FunnelPolicy Interface Extension (`workflow-funnel-loader.ts`)
- Added `import type { RuntimeKind }` from runtime-protocol
- Extended `FunnelPolicy` with 5 new optional fields (D-01, flat, same level as `timeoutMs`):
  - `runtimeKind?: RuntimeKind` — defaults to `'pi-ai'` (D-04)
  - `provider?: string` — LLM provider name, required for pi-ai
  - `model?: string` — model ID, required for pi-ai
  - `apiKeyEnv?: string` — env var name for API key, required for pi-ai
  - `maxRetries?: number` — retry attempts for transient failures

### 2. Factory Refactoring (`pain-signal-runtime-factory.ts`)
- Renamed `resolveRunnerOptions` → `resolveRuntimeConfig` with expanded `RuntimeConfig` return type
- Added `RuntimeConfig` interface with all runtime fields
- Added `validateRuntimeConfig` function (D-02, D-06) — validates pi-ai required fields, throws plain `Error` with migration guidance
- Updated `bridgeCache` key format to `${workspaceDir}:${runtimeKind}` (D-03)
- Updated `invalidatePainSignalBridge` to accept optional `runtimeKind` parameter
- Replaced hardcoded `OpenClawCliRuntimeAdapter` with policy-driven switch:
  - `runtimeKind === 'pi-ai'` → `PiAiRuntimeAdapter`
  - else → `OpenClawCliRuntimeAdapter` (backward compat)
- `DiagnosticianRunner` receives dynamic `runtimeKind` from config

## Requirements Addressed

| ID | Status | Evidence |
|----|--------|----------|
| PL-01 | ✓ | FunnelPolicy extended with runtimeKind, provider, model, apiKeyEnv, maxRetries |
| PL-02 | ✓ | D-04: runtimeKind defaults to 'pi-ai'; D-05: missing provider/model/apiKeyEnv throws Error |
| PL-03 | ✓ | js-yaml auto-maps camelCase YAML keys; no WorkflowFunnelLoader code changes needed |
| FC-01 | ✓ | resolveRuntimeConfig reads runtimeKind from policy |
| FC-02 | ✓ | runtimeKind === 'pi-ai' creates PiAiRuntimeAdapter |
| FC-03 | ✓ | else branch creates OpenClawCliRuntimeAdapter |
| FC-04 | ✓ | No hardcoded runtimeKind; policy-driven throughout |

## Verification

- `npx tsc --noEmit` — passes (0 errors)
- `npm run build` — passes
- `npm test` — 574 passed, 1 failed (pre-existing `sqlite-trajectory-locator.test.ts` failure, unrelated)

## Files Modified

- `packages/principles-core/src/workflow-funnel-loader.ts` — FunnelPolicy interface extension + RuntimeKind import
- `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` — Factory refactoring, validation, adapter switch

## Deviations

None — implementation matches plan exactly.
