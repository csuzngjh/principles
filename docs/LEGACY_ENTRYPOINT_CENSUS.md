# Legacy Entrypoint Census

> **PRI-227**: Static inventory of every legacy Nocturnal entrypoint in the
> `packages/openclaw-plugin/` source tree, including imports, hook registrations,
> command wiring, service triggers, and test files.
>
> **PRI-230 UPDATE**: All `delete_candidate` and `live_cutover` nocturnal modules
> have been physically deleted. The census now records what was removed and what
> remains. Runtime V2 nocturnal modules in `packages/principles-core/` are NOT
> legacy — they are the replacement.
>
> Generated: 2026-05-24 | Updated: 2026-05-25 (PRI-230)

---

## Classification Key

| Category | Tag | Meaning |
|---|---|---|
| **MVP-Core Dependency** | `mvp_core_dependency` | ADR-0014 MVP-Core activation paths (`prompt`, `code_tool_hook / RuleHost`, `defer_archive`). |
| **Deleted (PRI-230)** | `deleted_pri230` | Physically removed by PRI-230. No longer exists in the codebase. |
| **Runtime V2 Replacement** | `runtime_v2_replacement` | Replacement module in `packages/principles-core/src/runtime-v2/`. NOT legacy. |

---

## 1. Deleted Slash Commands (PRI-230)

All three nocturnal commands and the sleep_reflection trigger have been deleted.
Their registrations have been removed from `index.ts`.

| Command Name | Status | Notes |
|---|---|---|
| `pd-nocturnal-review` | `deleted_pri230` | Handler deleted, registration removed from index.ts |
| `nocturnal-train` | `deleted_pri230` | Handler deleted, registration removed from index.ts |
| `nocturnal-rollout` | `deleted_pri230` | Handler deleted, registration removed from index.ts |
| `pd-reflect` / `pdrl` | `deleted_pri230` | Manual sleep_reflection trigger deleted |

---

## 2. Deleted Core Nocturnal Modules (PRI-230)

All files under `src/core/nocturnal-*.ts` have been deleted.

| File | Status | Runtime V2 Replacement |
|---|---|---|
| `src/core/nocturnal-trinity.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/trinity-types.ts` + `dreamer-runner.ts` |
| `src/core/nocturnal-arbiter.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/nocturnal-compliance.ts` |
| `src/core/nocturnal-trajectory-extractor.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/snapshot-contract.ts` |
| `src/core/nocturnal-artificer.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-candidate-scoring.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/candidate-scoring.ts` |
| `src/core/nocturnal-dataset.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-executability.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-export.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-paths.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-reasoning-deriver.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-rule-implementation-validator.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-artifact-lineage.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/types/artifact-lineage.ts` |
| `src/core/nocturnal-snapshot-contract.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/snapshot-contract.ts` |
| `src/core/nocturnal-reviewed-subset-comparison.ts` | `deleted_pri230` | N/A (MVP-Gone) |
| `src/core/nocturnal-trinity-types.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/trinity-types.ts` |
| `src/core/nocturnal-compliance.ts` | `deleted_pri230` | `principles-core/src/runtime-v2/nocturnal/nocturnal-compliance.ts` |
| `src/core/adaptive-thresholds.ts` | `deleted_pri230` | N/A (MVP-Gone) |

---

## 3. Deleted Nocturnal Service Modules (PRI-230)

| File | Status | Notes |
|---|---|---|
| `src/service/nocturnal-service.ts` | `deleted_pri230` | 1814-line orchestrator deleted |
| `src/service/nocturnal-runtime.ts` | `deleted_pri230` | Idle detection deleted |
| `src/service/nocturnal-target-selector.ts` | `deleted_pri230` | Target selection deleted |
| `src/service/nocturnal-config.ts` | `deleted_pri230` | Config loader deleted |
| `src/service/sleep-cycle.ts` | `deleted_pri230` | Sleep cycle orchestrator deleted |
| `src/service/evolution-pain-context.ts` | `deleted_pri230` | Pain context for sleep_reflection deleted |
| `src/service/startup-reconciler.ts` | `deleted_pri230` | Entirely nocturnal; deleted |
| `src/service/cooldown-strategy.ts` | `deleted_pri230` | Entirely nocturnal; deleted |
| `src/service/subagent-workflow/nocturnal-workflow-manager.ts` | `deleted_pri230` | Nocturnal workflow wrapper deleted |

---

## 4. Deleted Nocturnal Test Files (PRI-230)

All test files that exclusively tested deleted nocturnal modules have been deleted.
Test files with mixed nocturnal/non-nocturnal tests were surgically cleaned.

| Test File | Status | Notes |
|---|---|---|
| `tests/commands/nocturnal-review.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/commands/nocturnal-train.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/core/nocturnal-*.test.ts` (14 files) | `deleted_pri230` | Purely nocturnal |
| `tests/service/nocturnal-*.test.ts` (5 files) | `deleted_pri230` | Purely nocturnal |
| `tests/service/evolution-worker.nocturnal.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/service/evolution-worker.nocturnal-cutover.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/service/cooldown-strategy.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/service/startup-reconciler.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/core/m10-artificer-core.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/core/m10-artificer-pipeline.test.ts` | `deleted_pri230` | Purely nocturnal |
| `tests/fixtures/nocturnal-reviewed-subset.json` | `deleted_pri230` | Fixture for deleted module |

---

## 5. Modified Mixed Files (Nocturnal Imports Removed)

These files had both nocturnal and non-nocturnal code. Nocturnal imports/references
were surgically removed; non-nocturnal functionality preserved.

| File | Changes |
|---|---|
| `src/service/evolution-worker.ts` | Removed nocturnal imports, sleep_reflection/keyword_optimization processing, idle check. Kept: compilation backfill, detection queue, watchdog. |
| `src/service/queue-io.ts` | Removed sleep_reflection/keyword_optimization enqueue paths. Kept: non-nocturnal queue I/O. |
| `src/core/merge-gate-audit.ts` | Removed nocturnal audit functions. Kept: replay evidence integrity, path contract checks. |
| `src/core/event-log.ts` | Removed nocturnal event type methods. Kept: non-nocturnal event logging. |
| `src/core/correction-cue-learner.ts` | Removed nocturnal-runtime import. Kept: non-nocturnal cue learning. |
| `src/core/reflection/reflection-context.ts` | Removed nocturnal-trajectory-extractor import. Kept: ReflectionContextCollector. |
| `src/core/replay-engine.ts` | Removed nocturnal-dataset/trajectory-extractor imports. Kept: Runtime V2 report listing. |
| `src/core/principle-internalization/filesystem-lifecycle-datasource.ts` | Removed nocturnal-artifact-lineage import. Kept: non-nocturnal lifecycle tracking. |
| `src/service/subagent-workflow/workflow-store.ts` | Removed nocturnal type imports. Kept: non-nocturnal workflow store. |
| `src/service/subagent-workflow/types.ts` | Removed nocturnal type definitions. Kept: non-nocturnal types. |
| `src/service/subagent-workflow/index.ts` | Removed nocturnal-workflow-manager re-exports. Kept: non-nocturnal re-exports. |
| `src/service/workflow-watchdog.ts` | Removed nocturnal workflow check. Kept: non-nocturnal watchdog. |
| `src/service/monitoring-query-service.ts` | Removed nocturnal query methods. Kept: non-nocturnal monitoring. |
| `src/commands/export.ts` | Removed ORPO export path. Kept: non-nocturnal export. |
| `src/commands/promote-impl.ts` | Removed eval command path. Kept: non-nocturnal promotion. |
| `src/index.ts` | Removed retired nocturnal commands, pd-reflect, RETIRED_NOCTURNAL_MSG. Kept: MVP-Core hooks, non-nocturnal commands, EvolutionWorkerService. |

---

## 6. Retained Files (Still in Codebase)

| File | Reason |
|---|---|
| `src/service/evolution-worker.ts` | Still performs compilation backfill, detection queue, watchdog — MVP-Core adjacent |
| `src/service/queue-io.ts` | Still needed for non-nocturnal queue operations |
| `src/service/keyword-optimization-service.ts` | MVP-Quiet; used by evolution-worker |
| `src/core/training-program.ts` | MVP-Quiet |
| `src/core/model-training-registry.ts` | MVP-Quiet |
| `src/core/model-deployment-registry.ts` | MVP-Quiet |
| `src/core/external-training-contract.ts` | MVP-Quiet |
| `src/core/code-implementation-storage.ts` | Used by non-nocturnal code |

---

## 7. Runtime V2 Nocturnal Modules (NOT Legacy)

These are in `packages/principles-core/src/runtime-v2/` and are the **replacement**
for legacy nocturnal modules. They are NOT legacy entrypoints.

| Runtime V2 File | Purpose |
|---|---|
| `runtime-v2/nocturnal/snapshot-contract.ts` | Snapshot ingress contract |
| `runtime-v2/nocturnal/trinity-types.ts` | Shared Trinity types |
| `runtime-v2/nocturnal/candidate-scoring.ts` | Candidate scoring |
| `runtime-v2/nocturnal/index.ts` | Barrel export |
| `runtime-v2/nocturnal/nocturnal-compliance.ts` | Compliance validation |
| `runtime-v2/types/artifact-lineage.ts` | Artifact lineage types |
| `runtime-v2/idle-trigger/` | Runtime V2 idle-trigger (pure logic) |

---

## Summary

| Category | Count | Description |
|---|---|---|
| `deleted_pri230` | 30 production + 29 test | All legacy nocturnal production modules and their tests physically deleted |
| `mvp_core_dependency` | 0 | No legacy nocturnal entrypoints remain in MVP-Core |
| `runtime_v2_replacement` | 7 | Runtime V2 nocturnal modules (NOT legacy) |

**Total legacy nocturnal entrypoints remaining: 0**

> **MVP-Core clarification**: ADR-0014 §2.4 defines MVP-Core as only three activation paths: `prompt`, `code_tool_hook / RuleHost`, `defer_archive`. The EvolutionWorker heartbeat, sleep_reflection enqueue, and idle/night dispatch paths are NOT MVP-Core — they have been deleted per PRI-230.
