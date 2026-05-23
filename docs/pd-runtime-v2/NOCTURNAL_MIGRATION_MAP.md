# Nocturnal → Runtime V2 Migration Map

**Status:** Retirement plan updated by ADR-0012
**Original Issue:** PRI-117
**Updated:** 2026-05-23

## Overview

`nocturnal-trinity.ts` and `nocturnal-service.ts` are legacy god classes whose strategic role has been superseded by Runtime V2 peer runners. This document inventories all public entry points for deletion/cutover. It no longer permits a permanent parallel execution path or an OpenClaw idle/night scheduler.

**Designation:** Runtime V2 is the canonical internalization path. All new code must use Runtime V2 peer runners, not Nocturnal god classes.

**ADR-0012 rule:** “Keep legacy-only” below means temporary historical-read or host-compatibility containment only. It does not justify new functionality or retention of legacy business execution. Plugin runtime/workspace configuration must move toward PD-owned config/SDK boundaries.

---

## nocturnal-trinity.ts (2861 lines)

### Entry Point Inventory

| Export | Type | Classification | Rationale | Follow-up Issue |
|--------|------|--------------|-----------|-----------------|
| `NOCTURNAL_DREAMER_PROMPT` | const string | **Retire** | Embeds in build; replaced by Runtime V2 prompt builders | PRI-117-F1 |
| `NOCTURNAL_PHILOSOPHER_PROMPT` | const string | **Retire** | Embeds in build; replaced by Runtime V2 prompt builders | PRI-117-F1 |
| `NOCTURNAL_SCRIBE_PROMPT` | const string | **Retire** | Embeds in build; replaced by Runtime V2 prompt builders | PRI-117-F1 |
| `ARTIFICER_SYSTEM_PROMPT` | const string | **Retire** | Embeds in build; replaced by Runtime V2 prompt builders | PRI-117-F1 |
| `TrinityRuntimeAdapter` | interface | **Keep legacy-only** | Plugin-specific runtime interface; OpenClawTrinityRuntimeAdapter is the only impl | — |
| `TrinityRuntimeFailureCode` | type | **Migrate to @principles/core** | `PDErrorCategory` in Runtime V2 covers this; `TrinityRuntimeFailureCode` is deprecated | PRI-117-F2 |
| `TrinityRuntimeContractError` | class | **Keep legacy-only** | Used only by OpenClawTrinityRuntimeAdapter | — |
| `formatReasoningContext` | function | **Migrate to @principles/core** | Pure utility; no OpenClaw dependencies | PRI-117-F3 |
| `OpenClurnTrinityRuntimeAdapter` | class | **Keep legacy-only** | Uses `api.runtime.agent.runEmbeddedPiAgent`; OpenClaw-specific | — |
| `TrinityConfig` | interface | **Thin adapter** | Config object; Runtime V2 uses different config shape | PRI-117-F4 |
| `TrinityArtificerContext` | interface | **Migrate to @principles/core** | Type only; should align with Runtime V2 `ArtificerOutput` | PRI-117-F5 |
| `TrinityDraftArtifact` | interface | **Migrate to @principles/core** | Core artifact type; Runtime V2 has equivalent | PRI-117-F5 |
| `TrinityTelemetry` | interface | **Migrate to @principles/core** | Telemetry type; Runtime V2 has equivalent | PRI-117-F5 |
| `TrinityResult` | interface | **Migrate to @principles/core** | Result type; Runtime V2 has equivalent | PRI-117-F5 |
| `TrinityStageFailure` | interface | **Migrate to @principles/core** | Failure type; Runtime V2 has equivalent | PRI-117-F5 |
| `RejectedAnalysis` | interface | **Migrate to @principles/core** | Analysis type; Runtime V2 has equivalent | PRI-117-F5 |
| `ChosenJustification` | interface | **Migrate to @principles/core** | Analysis type; Runtime V2 has equivalent | PRI-117-F5 |
| `ContrastiveAnalysis` | interface | **Migrate to @principles/core** | Analysis type; Runtime V2 has equivalent | PRI-117-F5 |
| `runTrinity` | function | **Retire** | Stub-only path; Runtime V2 uses `DreamerRunner` + orchestrator | PRI-117-F6 |
| `runTrinityAsync` | function | **Retire** | Real execution path; replaced by `InternalizationOrchestrator` + peer runners | PRI-117-F6 |
| `invokeStubDreamer` | function | **Retire** | Test stub; Runtime V2 has proper test doubles | PRI-117-F6 |
| `invokeStubPhilosopher` | function | **Retire** | Test stub; Runtime V2 has proper test doubles | PRI-117-F6 |
| `invokeStubScribe` | function | **Retire** | Test stub; Runtime V2 has proper test doubles | PRI-117-F6 |
| `validateDraftArtifact` | function | **Migrate to @principles/core** | Validation logic; Runtime V2 has `DefaultScribeValidator` | PRI-117-F7 |
| `validateExtraction` | function | **Migrate to @principles/core** | Hallucination detection; Runtime V2 has equivalent | PRI-117-F7 |
| `draftToArtifact` | function | **Retire** | Converts Trinity draft to artifact; Runtime V2 uses different artifact model | PRI-117-F6 |
| `DEFAULT_TRINITY_CONFIG` | const | **Retire** | Legacy config; Runtime V2 has its own config | PRI-117-F6 |

---

## nocturnal-service.ts (1814 lines)

### Entry Point Inventory

| Export | Type | Classification | Rationale | Follow-up Issue |
|--------|------|--------------|-----------|-----------------|
| `NocturnalRunResult` | interface | **Thin adapter** | Result type; Runtime V2 uses `InternalizationOrchestrator` result types | PRI-117-F8 |
| `NocturnalRunDiagnostics` | interface | **Thin adapter** | Diagnostics type; Runtime V2 has its own | PRI-117-F8 |
| `NocturnalArtificerDiagnostics` | interface | **Thin adapter** | Diagnostics type; Runtime V2 has its own | PRI-117-F8 |
| `NocturnalServiceOptions` | interface | **Thin adapter** | Options; Runtime V2 has its own options | PRI-117-F8 |
| `executeNocturnalReflection` | function | **Retire** | Main orchestrator; replaced by `InternalizationOrchestrator` | PRI-117-F9 |
| `executeNocturnalReflectionAsync` | function | **Retire** | Async orchestrator; replaced by `InternalizationOrchestrator` | PRI-117-F9 |
| `listApprovedNocturnalArtifacts` | function | **Migrate to @principles/core** | Query function; `PainChainReadModel` in Runtime V2 handles this | PRI-117-F10 |

---

## Architecture Guards

The following regression tests prevent Runtime V2 from importing Nocturnal god classes:

```typescript
// In architecture-regression.test.ts:

// RUNTIME_V2_NO_NOCTURNAL_IMPORT: runtime-v2 must not import nocturnal-trinity
test('runtime-v2 modules must not import nocturnal-trinity', async () => {
  // Grep runtime-v2 for nocturnal-trinity imports — must be zero
});

// RUNTIME_V2_NO_NOCTURNAL_SERVICE_IMPORT: runtime-v2 must not import nocturnal-service
test('runtime-v2 modules must not import nocturnal-service', async () => {
  // Grep runtime-v2 for nocturnal-service imports — must be zero
});

// OPENCLAW_TRINITY_RUNTIME_ADAPTER_IS_LEGACY: only OpenClawTrinityRuntimeAdapter uses api.runtime.agent
test('OpenClawTrinityRuntimeAdapter is the only Runtime V2 component using api.runtime.agent', async () => {
  // Verify only nocturnal-trinity.ts uses runEmbeddedPiAgent
});
```

---

## Migration Classification Definitions

| Classification | Meaning |
|---------------|---------|
| **Retire** | Function/constant that will be removed after migration; do not use in new code |
| **Thin adapter** | Plugin-specific shim that delegates to Runtime V2; will become a thin wrapper |
| **Migrate to @principles/core** | Pure domain logic that should move to Runtime V2; no OpenClaw dependencies |
| **Keep legacy-only** | Temporary containment for an explicitly evidenced read/export or host adapter need; never a second business pipeline |

---

## Follow-up Issues

| Issue | Description | Classification |
|-------|-------------|---------------|
| PRI-117-F1 | Retire embedded prompts (NOCTURNAL_DREAMER_PROMPT, etc.) | Retire |
| PRI-117-F2 | Migrate `TrinityRuntimeFailureCode` → `PDErrorCategory` | Migrate |
| PRI-117-F3 | Extract `formatReasoningContext` to core utils | Migrate |
| PRI-117-F4 | Thin `TrinityConfig` adapter around Runtime V2 config | Thin adapter |
| PRI-117-F5 | Migrate Trinity artifact/result types to Runtime V2 equivalents | Migrate |
| PRI-117-F6 | Retire `runTrinity*`, stub functions, `draftToArtifact` | Retire |
| PRI-117-F7 | Migrate validation functions to Runtime V2 validators | Migrate |
| PRI-117-F8 | Thin `NocturnalRunResult`/`Diagnostics` adapters | Thin adapter |
| PRI-117-F9 | Retire `executeNocturnalReflection*` → `InternalizationOrchestrator` | Retire |
| PRI-117-F10 | Migrate `listApprovedNocturnalArtifacts` → `PainChainReadModel` | Migrate |

---

## What NOT To Do

- **Do not** delete a module before its live caller has a tested Runtime V2 replacement
- **Do not** import Runtime V2 peer runners into Nocturnal god classes
- **Do not** add new features to Nocturnal modules
- **Do not** create bidirectional dependencies between Runtime V2 and Nocturnal
- **Do not** create or retain OpenClaw idle/night scheduling as a replacement trigger

## Revised Retirement Sequence (ADR-0012)

1. Identify live callers in plugin bootstrap, `EvolutionWorkerService`, workflow manager and commands.
2. Provide an explicit PD-owned config/SDK/operator scheduling boundary for Runtime V2.
3. Cut live callers over without adding behavior inside legacy modules.
4. Keep only proven read-only historical import/export adapters.
5. Delete duplicated execution modules and obsolete command/test surfaces.
6. Measure test/CI reduction while retaining Runtime V2 E2E, chaos and migration coverage.

## Verification

1. `pnpm --filter principles-core test -- --grep "architecture-regression"` — all pass
2. `grep -r "from.*nocturnal" packages/principles-core/src/runtime-v2` — zero results
3. Architecture guard tests in `architecture-regression.test.ts` — all pass
