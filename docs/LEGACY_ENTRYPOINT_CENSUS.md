# Legacy Entrypoint Census

> **PRI-227**: Static inventory of every legacy Nocturnal entrypoint in the
> `packages/openclaw-plugin/` source tree, including imports, hook registrations,
> command wiring, service triggers, and test files. All Nocturnal modules are
> frozen per **ADR-0005** -- no new features, no structural changes.
>
> Generated: 2026-05-24

---

## Classification Key

| Category | Tag | Meaning |
|---|---|---|
| **MVP-Core Dependency** | `mvp_core_dependency` | ADR-0014 MVP-Core activation paths (`prompt`, `code_tool_hook / RuleHost`, `defer_archive`). These are the "good" entrypoints: the evolution-worker loop and sleep-cycle orchestrator that the Runtime V2 Peer Runners will replace. |
| **Live Cutover** | `live_cutover` | Still has live callers in the current codebase that need to be migrated to Runtime V2 before the legacy module can be deleted. |
| **Compatibility Alias** | `compat_alias` | Re-export or thin alias that exists only for backwards compatibility. Can be removed when all consumers migrate. |
| **Historical Read Export** | `historical_read_export` | Read-only export path (type re-export, barrel export). Does not call into Nocturnal logic at runtime. |
| **Delete Candidate** | `delete_candidate` | Can be deleted when the retirement plan (Runtime V2 Peer Runners) completes. Includes frozen legacy modules (`nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, `nocturnal-service.ts`) and their test mirrors. |

---

## 1. Slash Command Registrations (index.ts)

All three nocturnal commands are registered in `packages/openclaw-plugin/src/index.ts`.

| Command Name | Line | Handler Import | Category | Notes |
|---|---|---|---|---|
| `pd-nocturnal-review` | 622-636 | `./commands/nocturnal-review.js` | `live_cutover` | Human review queue for nocturnal dataset. Needs Runtime V2 review dashboard. |
| `nocturnal-train` | 637-652 | `./commands/nocturnal-train.js` | `live_cutover` | Training experiment management. Needs Runtime V2 training workflow. |
| `nocturnal-rollout` | 653-667 | `./commands/nocturnal-rollout.js` | `live_cutover` | Rollout/promotion gate. Needs Runtime V2 deployment pipeline. |

### Command Handler Source Files

| File | Category | Notes |
|---|---|---|
| `src/commands/nocturnal-review.ts` | `live_cutover` | Depends on nocturnal-dataset, nocturnal-arbiter types. Still wired in index.ts. |
| `src/commands/nocturnal-train.ts` | `live_cutover` | Training experiment lifecycle. Still wired in index.ts. |
| `src/commands/nocturnal-rollout.ts` | `live_cutover` | Checkpoint promotion/routing. Still wired in index.ts. |

### Sleep Reflection Trigger Command

| File | Category | Notes |
|---|---|---|
| `src/commands/pd-reflect.ts` | `live_cutover` | Manual sleep_reflection trigger. Creates sleep_reflection task via queue-io, bypassing idle check. |
---

## 2. Core Nocturnal Modules (Frozen per ADR-0005)

All files under `src/core/nocturnal-*.ts` are `delete_candidate` -- they are frozen
legacy code that must not be modified. Runtime V2 equivalents live in
`packages/principles-core/src/runtime-v2/nocturnal/`.

| File | Category | Notes | Runtime V2 Replacement |
|---|---|---|---|
| `src/core/nocturnal-trinity.ts` | `delete_candidate` | Trinity chain (Dreamer/Philosopher/Scribe). Frozen god-class. | `principles-core/src/runtime-v2/nocturnal/trinity-types.ts` + `dreamer-runner.ts` |
| `src/core/nocturnal-arbiter.ts` | `delete_candidate` | Deterministic artifact validation. Pure functions. | `principles-core/src/runtime-v2/nocturnal/nocturnal-compliance.ts` |
| `src/core/nocturnal-trajectory-extractor.ts` | `delete_candidate` | Session snapshot extraction for Trinity. | `principles-core/src/runtime-v2/nocturnal/snapshot-contract.ts` |
| `src/core/nocturnal-artificer.ts` | `delete_candidate` | Code implementation candidate generation. | TBD |
| `src/core/nocturnal-candidate-scoring.ts` | `delete_candidate` | Tournament selection for candidates. | `principles-core/src/runtime-v2/nocturnal/candidate-scoring.ts` |
| `src/core/nocturnal-dataset.ts` | `delete_candidate` | Dataset registry for approved samples. | TBD |
| `src/core/nocturnal-executability.ts` | `delete_candidate` | Action executability validation. | TBD |
| `src/core/nocturnal-export.ts` | `delete_candidate` | Training data export. | TBD |
| `src/core/nocturnal-paths.ts` | `delete_candidate` | Path resolver for nocturnal artifacts. | TBD |
| `src/core/nocturnal-reasoning-deriver.ts` | `delete_candidate` | Reasoning chain derivation. | TBD |
| `src/core/nocturnal-rule-implementation-validator.ts` | `delete_candidate` | Rule implementation AST validation. | TBD |
| `src/core/nocturnal-artifact-lineage.ts` | `delete_candidate` | Lineage tracking for artifacts. | `principles-core/src/runtime-v2/types/artifact-lineage.ts` |
| `src/core/nocturnal-snapshot-contract.ts` | `delete_candidate` | Snapshot ingress validation. | `principles-core/src/runtime-v2/nocturnal/snapshot-contract.ts` |
| `src/core/nocturnal-reviewed-subset-comparison.ts` | `delete_candidate` | Post-review quality comparison. | TBD |
| `src/core/adaptive-thresholds.ts` | `delete_candidate` | Adaptive quality thresholds shared with nocturnal. | TBD |

---

## 3. Nocturnal Service Modules

| File | Category | Notes |
|---|---|---|
| `src/service/nocturnal-service.ts` | `delete_candidate` | Main orchestrator (executeNocturnalReflection / executeNocturnalReflectionAsync). 1814 lines. Frozen per ADR-0005. |
| `src/service/nocturnal-runtime.ts` | `live_cutover` | Idle detection (`checkWorkspaceIdle`), cooldown, preflight checks. STILL CALLED by `sleep-cycle.ts` and `evolution-worker.ts`. |
| `src/service/nocturnal-target-selector.ts` | `live_cutover` | Principle + session selection for reflection. Called by `nocturnal-service.ts` (via `executeNocturnalReflection`). |
| `src/service/nocturnal-config.ts` | `live_cutover` | Configuration loader. Called by `evolution-worker.ts` and `sleep-cycle.ts`. |
| `src/service/sleep-cycle.ts` | `live_cutover` | Sleep cycle orchestrator extracted from evolution-worker. Uses nocturnal-runtime + queue-io. **Still wired into the heartbeat loop in evolution-worker.ts** (approximately lines 1449-1494). |
| `src/service/queue-io.ts` | `mvp_core_dependency` | Queue I/O including `enqueueSleepReflectionTask`. This is ADR-0014 evolution queue code, not pure nocturnal -- but it contains the sleep_reflection task enqueue path. |

### startup-reconciler.ts

| File | Import | Category | Notes |
|---|---|---|---|
| `src/service/startup-reconciler.ts` | `writeState`, `readStateSync` from `./nocturnal-runtime.js` (line 16) | `live_cutover` | Startup reconciliation validates and resets nocturnal-runtime.json state. Called from EvolutionWorker heartbeat initial delay (evolution-worker.ts line 1594). |

### cooldown-strategy.ts

| File | Import | Category | Notes |
|---|---|---|---|
| `src/service/cooldown-strategy.ts` | `readState`, `readStateSync`, `writeState` from `./nocturnal-runtime.js`; `CooldownEscalationConfig`, `loadCooldownEscalationConfig` from `./nocturnal-config.js` | `live_cutover` | Cooldown escalation reads/writes nocturnal-runtime state and loads config from nocturnal-config. |

### evolution-pain-context.ts

| File | Reference | Category | Notes |
|---|---|---|---|
| `src/service/evolution-pain-context.ts` | `sleep_reflection` task kind (string literal) | `live_cutover` | Builds pain context metadata for sleep_reflection tasks. References sleep_reflection as a task kind filter. |

### Evolution Worker Nocturnal References

The file `src/service/evolution-worker.ts` has multiple nocturnal entrypoint paths:

| Location | Reference | Category | Notes |
|---|---|---|---|
| Line 23 | Re-export `enqueueSleepReflectionTask` | `compat_alias` | Re-export from queue-io.ts |
| Line 28 | Import `checkWorkspaceIdle`, `checkCooldown`, `recordCooldown` from `nocturnal-runtime.ts` | `live_cutover` | Sleep cycle uses these. |
| Line 51 | Import `OpenClawTrinityRuntimeAdapter` from `../core/nocturnal-trinity.js` | `live_cutover` | Used in NocturnalWorkflowManager construction for sleep_reflection task processing and workflow sweeping. |
| Lines 640-975 | `sleep_reflection` task processing path | `mvp_core_dependency` | The evolution queue processing loop (ADR-0014) processes sleep_reflection tasks. This is the core evolution machinery. |
| Lines 1449-1494 | Idle check and sleep_reflection enqueue in heartbeat cycle | `live_cutover` | The heartbeat cycle triggers both idle-based and periodic sleep reflection. Runtime V2 Peer Runners will replace this. |

---

## 4. NocturnalWorkflowManager

| File | Category | Notes |
|---|---|---|
| `src/service/subagent-workflow/nocturnal-workflow-manager.ts` | `live_cutover` | Wraps `executeNocturnalReflectionAsync` + `OpenClawTrinityRuntimeAdapter` in WorkflowManager interface. Called from `evolution-worker.ts` for sleep_reflection processing and sweepExpiredWorkflows. |

---

## 5. Import Entrypoints (Cross-Module)

These are the actual import sites that keep legacy nocturnal modules alive.
**If all of these are removed, the nocturnal modules become dead code.**

### Imports of `nocturnal-trinity.ts`

| Source File | Import | Category | Notes |
|---|---|---|---|
| `src/service/nocturnal-service.ts` | Multiple (runTrinity, TrinityConfig, TrinityResult, etc.) | `delete_candidate` | Both files are delete candidates together. |
| `src/service/evolution-worker.ts` | `OpenClawTrinityRuntimeAdapter` (line 51) | `live_cutover` | Used in NocturnalWorkflowManager construction. |
| `src/core/merge-gate-audit.ts` | `OpenClawTrinityRuntimeAdapter` (line 7) | `live_cutover` | Used for merge gate audit workflow. |
| `src/service/subagent-workflow/nocturnal-workflow-manager.ts` | TrinityStageFailure, TrinityResult (line 37-38) | `live_cutover` | Type-only imports. |
| `src/service/subagent-workflow/workflow-store.ts` | DreamerOutput, PhilosopherOutput (line 6) | `historical_read_export` | Type-only imports for workflow event payloads. |

### Imports of `nocturnal-service.ts`

| Source File | Import | Category | Notes |
|---|---|---|---|
| `src/service/subagent-workflow/nocturnal-workflow-manager.ts` | `executeNocturnalReflectionAsync`, `NocturnalRunResult` | `live_cutover` | Core call path. |

### Imports of `nocturnal-arbiter.ts`

| Source File | Import | Category | Notes |
|---|---|---|---|
| `src/core/nocturnal-executability.ts` | `parseAndValidateArtifact` | `delete_candidate` | Both are delete candidates. |
| `src/core/nocturnal-dataset.ts` | `NocturnalArtifact` type | `delete_candidate` | Type-only import. |


### Imports of `nocturnal-runtime.ts`

| Source File | Import | Category | Notes |
|---|---|---|---|
| `src/service/cooldown-strategy.ts` | `readState`, `readStateSync`, `writeState` | `live_cutover` | Cooldown state read/write. |

### Imports of `nocturnal-config.ts`

| Source File | Import | Category | Notes |
|---|---|---|---|
| `src/service/cooldown-strategy.ts` | `CooldownEscalationConfig`, `loadCooldownEscalationConfig` | `live_cutover` | Cooldown escalation config. |

### Imports of `nocturnal-artifact-lineage.ts`

| Source File | Import | Category | Notes |
|---|---|---|---|
| `src/core/principle-internalization/filesystem-lifecycle-datasource.ts` | `listArtifactLineageRecords` | `live_cutover` | Reads artifact lineage records for filesystem lifecycle tracking. |
---

## 6. Hook Trigger Paths (index.ts)

The `before_prompt_build` hook in index.ts (lines 103-150) starts the `EvolutionWorkerService`
for each workspace. This is the **sole trigger path** that activates the entire nocturnal
pipeline chain:

1. `before_prompt_build` hook (line 120-129): starts `EvolutionWorkerService`
2. `EvolutionWorkerService.start` (line 1376): creates heartbeat timer
3. Heartbeat `runCycle` (evolution-worker.ts, line 1412): checks idle, enqueues sleep_reflection
4. sleep_reflection task processing (evolution-worker.ts, lines 640-975): creates `NocturnalWorkflowManager`
5. `NocturnalWorkflowManager.startWorkflow` (nocturnal-workflow-manager.ts): calls `executeNocturnalReflectionAsync`
6. `executeNocturnalReflectionAsync`: imports from frozen nocturnal modules

| Hook | Location | Category | Notes |
|---|---|---|---|
| `before_prompt_build` (EvolutionWorker start) | index.ts:120-129 | `mvp_core_dependency` | This is the ADR-0014 entry point. The EvolutionWorker service registration is core infrastructure, not nocturnal-specific. |
| `api.registerService(EvolutionWorkerService)` | index.ts:360-362 | `mvp_core_dependency` | Service registration is core infrastructure. |

---

## 7. Nocturnal Test Files

All test files that reference nocturnal modules. Test files are `historical_read_export` --
they verify existing behavior but must be retired with the production code.

| Test File | Category | Notes |
|---|---|---|
| `tests/commands/nocturnal-review.test.ts` | `historical_read_export` | Tests for pd-nocturnal-review command. |
| `tests/commands/nocturnal-train.test.ts` | `historical_read_export` | Tests for nocturnal-train command. |
| `tests/core/nocturnal-arbiter.test.ts` | `historical_read_export` | Tests for frozen nocturnal-arbiter. |
| `tests/core/nocturnal-artifact-lineage.test.ts` | `historical_read_export` | Tests for frozen artifact lineage. |
| `tests/core/nocturnal-artificer.test.ts` | `historical_read_export` | Tests for frozen nocturnal-artificer. |
| `tests/core/nocturnal-candidate-scoring.test.ts` | `historical_read_export` | Tests for frozen candidate scoring. |
| `tests/core/nocturnal-compliance-p-principles.test.ts` | `historical_read_export` | Compliance test. |
| `tests/core/nocturnal-compliance.test.ts` | `historical_read_export` | Compliance test. |
| `tests/core/nocturnal-dataset.test.ts` | `historical_read_export` | Tests for frozen nocturnal-dataset. |
| `tests/core/nocturnal-e2e.test.ts` | `historical_read_export` | E2E test. |
| `tests/core/nocturnal-executability.test.ts` | `historical_read_export` | Tests for frozen executability. |
| `tests/core/nocturnal-export.test.ts` | `historical_read_export` | Tests for frozen export. |
| `tests/core/nocturnal-reasoning-deriver.test.ts` | `historical_read_export` | Tests for frozen reasoning deriver. |
| `tests/core/nocturnal-reviewed-subset-comparison.test.ts` | `historical_read_export` | Reviewed subset comparison test. |
| `tests/core/nocturnal-rule-implementation-validator.test.ts` | `historical_read_export` | Implementation validator test. |
| `tests/core/nocturnal-snapshot-contract.test.ts` | `historical_read_export` | Snapshot contract test. |
| `tests/core/nocturnal-trinity.test.ts` | `historical_read_export` | Tests for frozen nocturnal-trinity. |
| `tests/service/evolution-worker.nocturnal.test.ts` | `historical_read_export` | Evolution worker nocturnal tests. |
| `tests/service/nocturnal-runtime-hardening.test.ts` | `historical_read_export` | Runtime hardening test. |
| `tests/service/nocturnal-runtime.test.ts` | `historical_read_export` | Runtime test. |
| `tests/service/nocturnal-service-code-candidate.test.ts` | `historical_read_export` | Service code candidate test. |
| `tests/service/nocturnal-target-selector.test.ts` | `historical_read_export` | Target selector test. |
| `tests/service/nocturnal-workflow-manager.test.ts` | `historical_read_export` | Workflow manager test. |
| `tests/fixtures/nocturnal-reviewed-subset.json` | `historical_read_export` | Test fixture. |

### Architecture Regression Test Files

| Test File | Category | Notes |
|---|---|---|
| `principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` | `historical_read_export` | Contains guards: "adapter does not import nocturnal-trinity" and "RUNTIME_V2_NO_NOCTURNAL_TRINITY_IMPORT". These verify the Runtime V2 boundary. |
| `principles-core/src/runtime-v2/__tests__/nocturnal-compliance-trust-boundary.test.ts` | `historical_read_export` | Compliance trust boundary test. |
| `principles-core/src/runtime-v2/__tests__/dreamer-runner.test.ts` | `historical_read_export` | Dreamer runner test -- tests the Runtime V2 replacement. |
| `openclaw-plugin/tests/integration/internalization-trigger-guard.test.ts` | `historical_read_export` | Guard: adapter does not import nocturnal-trinity / runTrinity. |

---

## 8. Idle/Night Dispatch in Hooks

| Hook | File | Description | Category |
|---|---|---|---|
| `before_prompt_build` | index.ts:120-129 | Starts EvolutionWorkerService per workspace | `mvp_core_dependency` |
| EvolutionWorker heartbeat | evolution-worker.ts:1412 | Periodic cycle that checks idle, enqueues sleep_reflection | `mvp_core_dependency` |
| EvolutionWorker sleep_reflection processing | evolution-worker.ts:640-975 | Processes sleep_reflection queue items via NocturnalWorkflowManager | `mvp_core_dependency` |
| runCycle (sleep-cycle.ts) | sleep-cycle.ts:72 | Extracted sleep-cycle orchestrator | `live_cutover` |

---

## 9. Runtime V2 Nocturnal References (For Reference Only)

These are in `packages/principles-core/src/runtime-v2/` and are the **replacement**
for legacy nocturnal modules. They are NOT legacy entrypoints.

| Runtime V2 File | Purpose |
|---|---|
| `runtime-v2/nocturnal/snapshot-contract.ts` | Snapshot ingress contract (replaces nocturnal-snapshot-contract.ts) |
| `runtime-v2/nocturnal/trinity-types.ts` | Shared Trinity types (replaces nocturnal-trinity-types.ts in plugin) |
| `runtime-v2/nocturnal/candidate-scoring.ts` | Candidate scoring (replaces nocturnal-candidate-scoring.ts in plugin) |
| `runtime-v2/nocturnal/index.ts` | Barrel export |
| `runtime-v2/nocturnal/nocturnal-compliance.ts` | Compliance validation (replaces nocturnal-arbiter.ts) |
| `runtime-v2/internalization/correction-proposal.ts` | Correction proposal (replaces parts of nocturnal-trinity) |
| `runtime-v2/types/artifact-lineage.ts` | Artifact lineage types (replaces nocturnal-artifact-lineage types) |

---

## Summary


| Category | Count | Description |
|---|---|---|
| `mvp_core_dependency` | 4 | EvolutionWorker service registration (1), before_prompt_build hook trigger (1), evolution queue processing loop (1), queue-io sleep_reflection enqueue (1). ADR-0014 core. |
| `live_cutover` | 22 | Nocturnal commands (3), command handlers (3), sleep_reflection trigger (1: pd-reflect.ts), service modules still called (4), evolution-worker import sites (3), NocturnalWorkflowManager references (3), cross-module imports (3: merge-gate-audit, cooldown-strategy, filesystem-lifecycle-datasource), startup-reconciler (1), pain context (1: evolution-pain-context.ts). |
| `compat_alias` | 1 | Re-export of enqueueSleepReflectionTask from evolution-worker.ts. |
| `historical_read_export` | 29 | Test files (24 regular + 4 architecture regression), type-only imports (1: workflow-store.ts). |
| `delete_candidate` | 16 | Frozen core modules (14 nocturnal-*.ts + 1 adaptive-thresholds.ts), service orchestrator (1: nocturnal-service.ts). |

**Total unique entrypoints classified: 72**

> **Counting rule**: Each entrypoint is counted once in its highest-priority category. Priority order: `mvp_core_dependency` > `live_cutover` > `compat_alias` > `historical_read_export` > `delete_candidate`. A single file with multiple import sites (e.g. evolution-worker.ts) counts as multiple entrypoints, one per distinct import/reference site listed in the detailed sections above. Sub-item sums in the Description column must equal the Count column value.
