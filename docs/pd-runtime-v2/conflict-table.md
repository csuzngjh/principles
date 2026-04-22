# PD Runtime v2 — Type Conflict Table

**Generated:** 2026-04-21
**Milestone:** M1 Foundation Contracts
**Purpose:** Documents canonical vs legacy type locations for M2 migration planning

## Canonical Definitions (M1)

| Type | Canonical Location | Schema Export | Status |
|------|-------------------|---------------|--------|
| PDErrorCategory | `principles-core/src/runtime-v2/error-categories.ts` | PDErrorCategorySchema | Canonical |
| AgentSpec | `principles-core/src/runtime-v2/agent-spec.ts` | AgentSpecSchema | Canonical |
| RuntimeKind | `principles-core/src/runtime-v2/runtime-protocol.ts` | RuntimeKindSchema | Canonical |
| PDTaskStatus | `principles-core/src/runtime-v2/task-status.ts` | PDTaskStatusSchema | Canonical |

## Legacy Overlaps

### TrinityRuntimeFailureCode → PDErrorCategory

| Location | Type | Values | Overlap with Canonical | Action |
|----------|------|--------|----------------------|--------|
| `openclaw-plugin/src/core/nocturnal-trinity.ts:448` | TrinityRuntimeFailureCode | `runtime_unavailable`, `invalid_runtime_request`, `runtime_run_failed`, `runtime_timeout`, `runtime_session_read_failed` | `runtime_unavailable` (exact match), `runtime_timeout` ≈ `timeout`, `runtime_run_failed` ≈ `execution_failed`, `invalid_runtime_request` ≈ `input_invalid` | @deprecated (DOC-01) |
| `principles-core/src/runtime-v2/error-categories.ts` | PDErrorCategory | 16 categories: `runtime_unavailable`, `capability_missing`, `input_invalid`, `lease_conflict`, `execution_failed`, `timeout`, `cancelled`, `output_invalid`, `artifact_commit_failed`, `max_attempts_exceeded`, `context_assembly_failed`, `history_not_found`, `trajectory_ambiguous`, `storage_unavailable`, `workspace_invalid`, `query_invalid` | Canonical | — |

**Overlap detail:** TrinityRuntimeFailureCode's 5 values map to 4 PDErrorCategory values. `runtime_session_read_failed` has no direct canonical equivalent (falls under `execution_failed` broadly).

### QueueStatus → PDTaskStatus

| Location | Type | Values | Overlap with Canonical | Action |
|----------|------|--------|----------------------|--------|
| `openclaw-plugin/src/service/evolution-worker.ts:110` | QueueStatus | `pending`, `in_progress`, `completed`, `failed`, `canceled` | `pending` (exact), `failed` (exact), `completed` ≈ `succeeded`, `in_progress` ≈ `leased`, `canceled` ≈ no direct mapping | @deprecated (DOC-01) |
| `openclaw-plugin/src/core/evolution-types.ts:472` | QueueStatus | `pending`, `in_progress`, `completed`, `failed`, `canceled` | Same as above | Track (M2) |
| `openclaw-plugin/src/service/evolution-queue-migration.ts:15` | QueueStatus | `pending`, `in_progress`, `completed`, `failed`, `canceled` | Same as above | Track (M2) |
| `openclaw-plugin/src/service/queue-migration.ts:11` | QueueStatus | `pending`, `in_progress`, `completed`, `failed` | Subset (no `canceled`) | Track (M2) |
| `principles-core/src/runtime-v2/task-status.ts` | PDTaskStatus | `pending`, `leased`, `succeeded`, `retry_wait`, `failed` | Canonical | — |

**Overlap detail:** 4 independent QueueStatus definitions exist. PDTaskStatus introduces `leased` and `retry_wait` (no legacy equivalent). Legacy `completed` → `succeeded`, `in_progress` → `leased`. Legacy `canceled` has no PDTaskStatus equivalent (handled via `PDErrorCategory.cancelled` error).

### TaskResolution (4 locations, no canonical equivalent)

| Location | Values | Notes | Action |
|----------|--------|-------|--------|
| `openclaw-plugin/src/service/evolution-worker.ts:111` | `marker_detected`, `auto_completed_timeout`, `failed_max_retries`, `runtime_unavailable`, `canceled`, `late_marker_principle_created`, `late_marker_no_principle`, `stub_fallback`, `skipped_thin_violation`, `noise_classified` | 10 values, evolution-specific | Track (M2) |
| `openclaw-plugin/src/core/evolution-types.ts:473` | Same 10 + `success`, `failure`, `skipped` = 13 values | Superset of worker version | Track (M2) |
| `openclaw-plugin/src/service/evolution-queue-migration.ts:20` | `marker_detected`, `auto_completed_timeout`, `failed_max_retries`, `runtime_unavailable`, `canceled`, `late_marker_principle_created`, `late_marker_no_principle`, `stub_fallback`, `skipped_thin_violation` | 9 values (subset — no `noise_classified`) | Track (M2) |
| `openclaw-plugin/src/service/queue-migration.ts:12` | `success`, `failure`, `skipped` | 3 values, oldest/simplest version | Track (M2) |

**Overlap detail:** No canonical TaskResolution exists in runtime-v2. The 4 definitions are internally inconsistent (3, 9, 10, 13 values). `runtime_unavailable` in TaskResolution overlaps with `PDErrorCategory.runtime_unavailable`. M2 should define a canonical TaskResolution schema.

### TaskKind (3 locations, no canonical equivalent)

| Location | Values | Notes | Action |
|----------|--------|-------|--------|
| `principles-core/src/evolution-store.ts:18` | `coding`, `debugging`, `reasoning`, `creative` | 4 values, generic task categories | Track (M2) |
| `openclaw-plugin/src/core/trajectory-types.ts:120` | `pain_diagnosis`, `sleep_reflection`, `model_eval`, `keyword_optimization` | 4 values, PD-specific task kinds | Track (M2) |
| `openclaw-plugin/src/service/failure-classifier.ts:23` | `sleep_reflection`, `keyword_optimization` | 2 values (ClassifiableTaskKind — subset) | Track (M2) |

**Overlap detail:** Two completely disjoint TaskKind taxonomies — generic (`coding`/`debugging`/`reasoning`/`creative`) vs PD-specific (`pain_diagnosis`/`sleep_reflection`/`model_eval`/`keyword_optimization`). No canonical TaskKind in runtime-v2. M2 should unify or explicitly separate these.

## Duplicate Check (VER-02)

| Type | Canonical Locations in `runtime-v2/` | Other Export Locations | VER-02 Status |
|------|--------------------------------------|----------------------|---------------|
| PDErrorCategory | 1 (`error-categories.ts`) | 1 re-export in `runtime-v2/index.ts` | PASS |
| AgentSpec | 1 (`agent-spec.ts`) | 1 re-export in `runtime-v2/index.ts` | PASS |
| RuntimeKind | 1 (`runtime-protocol.ts`) | 1 re-export in `runtime-v2/index.ts` | PASS |
| PDTaskStatus | 1 (`task-status.ts`) | 1 re-export in `runtime-v2/index.ts` | PASS |

All 4 canonical types have exactly one definition in `runtime-v2/`. The `index.ts` re-exports are expected (barrel file pattern, not duplicate definitions).

## Summary

| Category | Count | @deprecated | Track for M2 |
|----------|-------|-------------|--------------|
| Canonical (runtime-v2) | 4 types | — | — |
| Legacy → deprecated (DOC-01) | 2 types | TrinityRuntimeFailureCode, QueueStatus | — |
| Legacy → track only | 2 types | — | TaskResolution (4 locations), TaskKind (3 locations) |
| Total legacy definitions | 9 exports | 2 | 7 |

## Migration Priority (M2 Reference)

1. **High:** TrinityRuntimeFailureCode → PDErrorCategory (exact value overlap exists)
2. **High:** QueueStatus (evolution-worker) → PDTaskStatus (semantic overlap)
3. **Medium:** TaskResolution — needs canonical definition first
4. **Low:** TaskKind — two disjoint taxonomies need design decision
