# Architecture Audit Report — 2026-06

> **Date**: 2026-06-16
> **Scope**: Full monorepo (`packages/principles-core`, `openclaw-plugin`, `pd-cli`, `pd-console`, `create-principles-disciple`)
> **Method**: 5-Why root cause analysis + per-item deletion/retain verification
> **Status**: Draft — corrected after independent verification 2026-06-16

---

## Table of Contents

0. [Verification Addendum (2026-06-16)](#0-verification-addendum-2026-06-16)
1. [Root Cause Analysis](#1-root-cause-analysis)
2. [Deletion / Retain Decisions](#2-deletion--retain-decisions)
3. [Recurrence Prevention](#3-recurrence-prevention-mechanisms)
4. [Execution Plan](#4-execution-plan)

---

## 0. Verification Addendum (2026-06-16)

An independent pass re-verified this report against live source. The original
findings hold; the following **corrections and additions** are authoritative and
override any conflicting statement below.

### 0.1 Confirmed (sampled re-verification)

- RC-1 type duplication: confirmed. `InjectablePrinciple` (×3), `HybridLedgerStore`
  (×5+, more than originally listed — see 0.3), `atomicWriteFileSync` (×2:
  `principles-core/src/io.ts` + `openclaw-plugin/src/utils/io.ts`).
- RC-3 core I/O erosion: confirmed and **broader than "14+"** — `better-sqlite3`
  appears in ~10 `runtime-v2` files plus `evolution-store.ts`, `trajectory-store.ts`;
  `child_process` in `runtime-v2/utils/cli-process-runner.ts`.
- D7 (`deep-reflect.ts` = `export {}`), D11, D13 (duplicate `gfi` registration at
  `pd-cli/src/index.ts:494` and `:504`): confirmed.
- StorageAdapter zero-impl: confirmed in live `src/` (the `FileStorageAdapter`
  match is a **stale bundled `dist` artifact** in `create-principles-disciple` — see 0.4).

### 0.2 Corrections to existing items

- **D6 / M2 canonical-source error (BLOCKING for execution):** the report states the
  canonical `HybridLedgerStore` shape "is `PrincipleTreeStore` in `principle-tree-ledger.ts`".
  This conflates two different types in two different files:
  - `principles-core/src/principle-tree-ledger.ts` defines a type literally named
    `HybridLedgerStore` (`{ trainingStore, tree: LedgerTreeStore }`).
  - `openclaw-plugin/src/core/principle-tree-ledger.ts` uses `PrincipleTreeStore`
    (from `types/principle-tree-schema.ts`) and a richer `LegacyPrincipleTrainingState`.

  **Action required before D6/M2:** pick ONE authoritative ledger type + file (see A0
  in §4). Do not execute D6 until that decision is recorded.
- **Phase 0 execution-list numbering:** the lines `D8 NOCTURNAL_* path constants` and
  `D9 Nocturnal runtime defaults` in §4 are mislabeled — those are **G8 / G9**. D8/D9
  are file deletions (`run-nocturnal.mjs`, `principle_training_state.json`).

### 0.3 P0 finding the report under-weighted: two divergent ledger implementations

`principle-tree-ledger.ts` exists as a **full, independent implementation in BOTH**
`principles-core/src/` **and** `openclaw-plugin/src/core/`. Both read/write the same
on-disk file `principle_training_state.json`, but with **divergent schemas** (the plugin
copy carries `evaluability`, `deployedCheckpointIds`, etc.; the core copy does not).

This is not cosmetic duplication — it is a **correctness hazard** (two writers, two
contracts, last-writer-wins field loss) and the clearest instance of the "implementation
drift / which one do I build on" problem driving this audit. It should be treated as **P0**,
above the type-only items D6/M2, and is the precondition for canonical pain identity work
(see Linear PRI-390).

### 0.4 Additional findings not in the original report

- **Stale committed `dist` copies.** `create-principles-disciple/{core,plugin,pd-cli,console}/dist`
  contain built artifact copies that still reference symbols already deleted from live
  `src/` (e.g. `FileStorageAdapter implements StorageAdapter`). These poison `grep`-based
  audits ("a third source of truth"). Confirm they are git-ignored build output; if tracked,
  untrack them.
- **Encoding corruption in source.** `pd-cli/src/index.ts` command descriptions contain
  mojibake (e.g. `GFI workspace snapshot 鈥?active vs stale`). A repo-wide non-UTF-8 scan is
  warranted.

### 0.5 Optimization: reuse the existing guardrail harness

§3 proposes new `rg`-based CI scripts. The repo **already has** an extensible guardrail at
`packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` with
`FORBIDDEN_NODE_IO_MODULES` and `FORBIDDEN_RUNTIME_ORCHESTRATION_CLASSES` sets (currently
scoped to specific boundary files). Extend that harness rather than introducing a parallel
mechanism — adding a third enforcement system would itself be a duplication.

### 0.6 MVP-First governance constraint (ADR-0014)

**Phase 4 (new `@principles/contracts` + `@principles/runtime-engine` packages, 3–5 weeks)
is architectural expansion and is PAUSED under MVP-First.** Do not start it before the seed
customer is onboarded. Repackaging does not by itself remove drift and risks amplifying it
mid-migration. Sequence: do the deletion + single-source-of-truth convergence now (reduces
code volume, MVP-Gone-aligned), defer Phase 4 to the post-MVP conditional roadmap with an
explicit restart trigger (drift causes a production bug, or seed customer onboarded).

---

## 1. Root Cause Analysis

### Five root causes identified via 5-Why

| RC | Root Cause | Manifestation |
|----|-----------|---------------|
| RC-1 | **No "type single ownership" discipline + no shared type layer** | `InjectablePrinciple` ×3, `HybridLedgerStore` ×5, `TaskKind`/`TaskPriority` ×2, queue types ×2, `atomicWriteFileSync` ×2 |
| RC-2 | **No mandatory "off-ramp discipline" — code only added, never removed** | SDK layer (8 root files) coexists with runtime-v2; Nocturnal remnants; `recordPainSignal` lives beside `PainSignalBridge`; `StorageAdapter`/`EvolutionHook`/`WorkspaceResolver` zero-impl interfaces still exported |
| RC-3 | **Package structure frozen at 2-package design; new features always placed in "most convenient" package** | `principles-core` contains `better-sqlite3`, `fs`, `child_process`, LLM network calls; runtime-v2 is 68-file monolith with 8+ distinct concerns |
| RC-4 | **No public API surface control — export is zero-cost, delete is high-risk** | Top-level barrel ~80 exports, only ~10 consumed externally; runtime-v2 barrel 1594 lines / ~400+ symbols, 60-70% dead |
| RC-5 | **ADR decisions disconnected from execution — ADR says "delete" but no Linear issue tracks it** | ADR-0014 §2.6 lists MVP-Gone items (Trainer, model_training) but they remain exported; ADR-0012 §4 defines retirement sequence but Steps 4-6 not executed |

### 5-Why traces

#### RC-1: Type duplication

```
Why are types duplicated?
  → core cannot depend on plugin (unidirectional dependency rule)
    → Why no shared type package?
      → Each new type was "defined nearby + add comment to keep in sync" instead of splitting out a types package
        → Why? No "type must have one canonical owner" rule; AI assistant chose lowest-resistance path
```

#### RC-2: Code never removed

```
Why is dead code still here?
  → Nobody deleted it after migration
    → Why? "Stop calling" was chosen over "delete" for each migration (SDK→runtime-v2, Nocturnal→Runtime-v2)
      → Why? Fear of needing to rollback; no safe disable mechanism
        → Why no disable mechanism? No feature flags existed at migration time; ADR-0014 itself admits "every feature was added, none was ever turned off"
```

#### RC-3: Core I/O boundary erosion

```
Why does core have I/O?
  → runtime-v2 uses SQLite/FS extensively
    → Why is runtime-v2 in core?
      → Core is the only cross-package shared location; runtime-v2 needs to be used by both pd-cli and plugin
        → Why no intermediate package?
          → Initial 2-package structure was never re-evaluated; each new requirement chose "put it in core, it's convenient"
```

#### RC-4: Barrel bloat

```
Why is the barrel so large?
  → Every new module adds exports to the barrel
    → Why no filtering?
      → No tool or CI rule checks "exported but unconsumed" symbols
        → Why? TypeScript compiler treats all `export` equally — no distinction between "intentionally public" and "incidentally exposed"
          → Why no project-level supplement? Lack of awareness that public API surface has maintenance cost
```

#### RC-5: ADR→execution gap

```
Why are MVP-Gone items still in the codebase?
  → ADR-0014 says delete but nobody did
    → Why? ADR is a decision document, not an execution tracker — no Linear issue per ADR item
      → Why? ADR template has no "Execution Tracking" section linking to issues
```

---

## 2. Deletion / Retain Decisions

Each item below has been **verified against actual import/consumption data**. The "Impact" column lists every file that must change if this item is deleted.

### Legend

- ✅ = verified safe to delete (zero external consumers)
- ⚠️ = safe to delete after refactoring consumers first
- 🔄 = merge/consolidate (not delete)
- 🏛️ = retain (has live consumers)
- 📦 = move to different package (Phase 4)

---

### Phase 0: Zero-Risk Deletions (no consumers exist)

| ID | Item | Verdict | Verification Evidence | Impact (files to change) |
|----|------|---------|----------------------|--------------------------|
| D1 | `StorageAdapter` interface + barrel export | ✅ DELETE | Zero implementations. Zero imports outside `principles-core/src/index.ts` (barrel) and `principles-core/tests/exports-compile.ts` (compile test). The reference in `types.ts:33` is a comment only. | `principles-core/src/index.ts:30`, `principles-core/src/storage-adapter.ts`, `principles-core/tests/exports-compile.ts:43-44` |
| D2 | `EvolutionHook` interface + `noOpEvolutionHook` | ✅ DELETE | Zero implementations (only `noOpEvolutionHook`). Zero imports outside barrel and compile test. `telemetry-event.ts:8,25` are comments only ("aligned with EvolutionHook methods"). `StoreEventEmitter` in runtime-v2 has fully replaced this. | `principles-core/src/index.ts:22`, `principles-core/src/evolution-hook.ts`, `principles-core/tests/exports-compile.ts:27-30` |
| D3 | `WorkspaceResolver` interface + barrel export | ✅ DELETE | Zero implementations in any package. Zero imports outside barrel. The comment in `index.ts:39` says "impl in openclaw-plugin" but openclaw-plugin has no file implementing this interface. | `principles-core/src/index.ts:40`, `principles-core/src/types/workspace-resolver.ts` |
| D4 | `recordPainSignal` function + `PainSignalInput` type | ✅ DELETE | Zero imports from any external package. The function's own docstring says it was superseded by `pd pain record` (CLI) and `PainSignalBridge/emitPainDetectedEvent` (runtime). It only validates + returns a PainSignal — `validatePainSignal` already does validation. **Note**: openclaw-plugin's `eventLog.recordPainSignal()` is a **completely different method** on the EventLog class — not an import from core's `pain-recorder.ts`. | `principles-core/src/index.ts:46-47`, `principles-core/src/pain-recorder.ts`, `principles-core/src/io.ts:46` (singleton ref) |
| D5 | `resolvePainFlagPath` function | ✅ DELETE | Zero imports from any file. Pain flag file is no longer written (per pain-recorder.ts comments). | `principles-core/src/index.ts:50`, `principles-core/src/pain-flag-resolver.ts` |
| D6 | `InjectablePrinciple` + `HybridLedgerStore` in `types.ts` | ✅ DELETE (definitions only) — **BLOCKED on A0** | These are the **old duplicate copies**. The canonical `InjectablePrinciple` is in `prompt-builder/principle-selection.ts` (which openclaw-plugin already imports). **Correction (§0.2):** the canonical ledger type is NOT cleanly `PrincipleTreeStore` — core's `principle-tree-ledger.ts` defines `HybridLedgerStore`, plugin's uses `PrincipleTreeStore`. The authoritative type/file MUST be decided in A0 (§4) before this deletion. After deletion: `principle-injector.ts` (the only internal consumer of `InjectablePrinciple` from `types.ts`) must change to import from `prompt-builder/principle-selection.ts`. | `principles-core/src/types.ts`, `principles-core/src/principle-injector.ts:13` (change import source) |
| D7 | `openclaw-plugin/src/tools/deep-reflect.ts` | ✅ DELETE | Contains only `export {}`. Zero imports. | Just delete the file |
| D8 | `openclaw-plugin/run-nocturnal.mjs` | ✅ DELETE | Standalone script with hardcoded `/home/csuzngjh/.openclaw/` paths. Nocturnal is MVP-Gone (ADR-0014 §2.6). Not imported by any code. | Just delete the file |
| D9 | `openclaw-plugin/principle_training_state.json` | ✅ DELETE + .gitignore | Runtime state file committed to source. `init.ts` regenerates it. Should not be in version control. | Delete file, add to `.gitignore` |
| D10 | `pd-cli/src/principle-tree-ledger-adapter.ts` | ✅ DELETE | Pure re-export from `@principles/core/runtime-v2`. 3 command files import from it. They can import directly from core. **Note**: openclaw-plugin has its own `principle-tree-ledger-adapter.ts` (145 lines, real implementation) — that file is NOT a re-export and must NOT be deleted. | `pd-cli/src/commands/diagnose.ts:35`, `pd-cli/src/commands/candidate.ts:27`, `pd-cli/src/commands/pain-retry.ts:43` + 4 test files that mock this path |
| D11 | `isProductionWorkspaceAllowed()` in `pd-cli/src/utils/production-workspace-guard.ts:182` | ✅ DELETE | Always returns `false`. Zero callers. The real check is done via `opts.allowProductionWorkspaceForUat` in `runtime-uat.ts`. | Just delete the function |
| D12 | `_buildConversationEntries()` in `pd-cli/src/legacy/session-history-import.ts:205` | ✅ DELETE | Unused private function (underscore-prefixed). 27 lines of dead code. | Just delete the function |
| D13 | Duplicate `runtime gfi snapshot` command registration in `pd-cli/src/index.ts:502-512` | ✅ DELETE | Exact alias of `runtime health gfi` (line 494-500). Both call `handleRuntimeGfiSnapshot`. | Remove lines 502-512 in index.ts |

**Corrections from initial scan**:
- ~~D13: `node-vm-polyfill.ts`~~ → **RETAINED** (renamed to D13 above). `node-vm-polyfill.ts` has 2 real consumers: `rule-implementation-runtime.ts:1` and `principle-compiler/code-validator.ts:13`. Not dead code. The polyfill indirection is debatable but not removable without touching those consumers.

---

### Phase 1: MVP-Gone Execution (requires refactoring before deletion)

| ID | Item | Verdict | Prerequisite Refactoring | Impact |
|----|------|---------|------------------------|--------|
| G1 | `TrainerRunner` + `trainer-runner.ts` + `trainer-output.ts` + `trainer-prompt-builder.ts` | ⚠️ ARCHIVE | Remove from barrel exports. `pd-cli/src/commands/runtime-internalization-run-once.ts` imports `TrainerRunner` and `TrainerRunnerResult` — the `run-once` command's `--runner trainer` path must be removed or feature-flagged. Architecture regression test (`architecture-regression.test.ts:2159-2218`) has 6 assertions checking TrainerRunner is exported — these must be updated. | `principles-core/src/runtime-v2/index.ts:585-586,901-912`, `principles-core/src/runtime-v2/internalization/index.ts:110-111,383-394`, `pd-cli/src/commands/runtime-internalization-run-once.ts:11,26,62,78,567,627`, 6 test assertions |
| G2 | `MODEL_TRAINING_CHANNEL` + `TRAINER_KIND` | ⚠️ ARCHIVE | Must be archived alongside G1. `internalization-job-graph.ts:50-55,76-77` defines and uses them. Tests in `internalization-job-graph.test.ts:210-215` and `internalization-peer-runner-contracts.test.ts:271-286,417-425` reference them. | Same as G1 + `internalization-job-graph.ts`, 2 test files |
| G3 | `openclaw-plugin/src/core/model-training-registry.ts` | ⚠️ DELETE AFTER REFACTOR | **Has live callers**. `local-worker-routing.ts:38` imports `isCheckpointDeployable`. `model-deployment-registry.ts:37,39-41` imports `Checkpoint` type + functions. `promotion-gate.ts:51` imports functions. **Must first**: (a) stub `isCheckpointDeployable` to always return `false` (no training runs exist in MVP), (b) remove shadow routing from subagent hooks in `index.ts:437-513`, (c) simplify `local-worker-routing.ts` to pure-classification-only path. | `local-worker-routing.ts:38`, `model-deployment-registry.ts:37,39-41`, `promotion-gate.ts:51`, `principle-tree-ledger.ts:28,153` (`deployedCheckpointIds` field) |
| G4 | `openclaw-plugin/src/core/model-deployment-registry.ts` | ⚠️ DELETE AFTER REFACTOR | **Has live callers**. `index.ts:66` imports `WorkerProfile` type. `local-worker-routing.ts:33,35-37` imports type + functions. `PD_LOCAL_PROFILES` in `shadow-fingerprint.ts:13` uses same profile names. **Must first**: remove subagent shadow routing hooks from `index.ts`, then simplify `local-worker-routing.ts` to remove all deployment check paths. | `index.ts:66,452,458,469`, `local-worker-routing.ts:33,35-37`, `shadow-fingerprint.ts:13` |
| G5 | `openclaw-plugin/src/core/promotion-gate.ts` | ⚠️ DELETE AFTER REFACTOR | Depends on G3. `local-worker-routing.ts:39` imports `getPromotionState`. `model-deployment-registry.ts:42` imports it. **Must first**: complete G3+G4 refactoring, then this file has zero callers. | `local-worker-routing.ts:39`, `model-deployment-registry.ts:42` |
| G6 | `openclaw-plugin/src/core/external-training-contract.ts` | ⚠️ DELETE AFTER REFACTOR | Only imported by `promotion-gate.ts:52` for `TrainableWorkerProfile` type. After G5 is deleted, this file has zero callers. | `promotion-gate.ts:52` |
| G7 | `openclaw-plugin/src/core/shadow-observation-registry.ts` | ⚠️ DELETE AFTER REFACTOR | **Has live callers**. `index.ts:27` imports `recordShadowRouting` + `completeShadowObservation`. Called in subagent hooks (`index.ts:467,502`). `promotion-gate.ts:53` imports `computeShadowStats`. **Must first**: remove subagent shadow routing hooks from `index.ts`. | `index.ts:27,467,502`, `promotion-gate.ts:53` |
| G8 | `openclaw-plugin/src/core/paths.ts` — `NOCTURNAL_*` constants | ✅ DELETE | `NOCTURNAL_SAMPLES`, `NOCTURNAL_MEMORY`, `NOCTURNAL_EXPORTS` path constants. Zero imports (verified by grep). | Just delete the 3 constants |
| G9 | `openclaw-plugin/src/config/defaults/runtime.ts` — Nocturnal settings | ✅ DELETE | `DEFAULT_IDLE_THRESHOLD_MS`, `DEFAULT_QUOTA_WINDOW_MS`, `DEFAULT_COOLDOWN_MS`. Zero imports (these defaults are never referenced since nocturnal was retired). | Just delete the 3 constants + comment block |
| G10 | `pd-cli/src/commands/legacy-cleanup.ts` | ⚠️ ARCHIVE | One-time cleanup tool. Still registered as a command. No production workspace should still have these artifacts. Archive rather than delete. | `pd-cli/src/index.ts` (command registration) |
| G11 | `openclaw-plugin/src/core/local-worker-routing.ts` | ⚠️ SIMPLIFY (not delete) | After G3-G7 deletion, this file's I/O-bound code (deployment checks, promotion state, checkpoint deployability) can all be removed. What remains: pure-classification re-exports from `@principles/core/prompt-builder/routing-guidance.ts` + `classifyTask()` that does pure classification only (no deployment check). The `subagent_spawning`/`subagent_ended` hooks in `index.ts` that call `classifyTask` for shadow routing must also be removed or simplified. | `index.ts:26,437-513` (subagent hooks), `local-worker-routing.ts` (simplify), `shadow-fingerprint.ts` (may archive) |

**Critical insight for G3-G7**: These 5 files form a **dependency cluster** that is actively called from `index.ts` subagent hooks. The deletion sequence must be:

```
Step 1: Remove subagent shadow routing hooks from index.ts
         (safety: no user-visible change — shadow routing has no real deployments in MVP)
Step 2: Simplify local-worker-routing.ts to pure-classification-only
         (classifyTask → just call coreClassifyTaskKind, skip deployment checks)
Step 3: Now G3-G7 have zero callers → delete them
Step 4: Clean up WorkerProfile/PD_LOCAL_PROFILES/shadow-fingerprint.ts
```

---

### Phase 2: Merge / Consolidate (not deletion — unification)

| ID | Item | Verdict | Details | Impact |
|----|------|---------|---------|--------|
| M1 | Queue migration: `evolution-queue-migration.ts` vs `queue-migration.ts` | 🔄 MERGE | Two files define `EvolutionQueueItem`, `LegacyEvolutionQueueItem`, `migrateToV2()` with **conflicting type signatures** (`QueueStatus` and `TaskResolution` differ). `queue-migration.ts` is consumed by `evolution-worker.ts` + `queue-io.ts`. `evolution-queue-migration.ts` is consumed by `evolution-dedup.ts`. **Action**: Unify types into `queue-migration.ts` (the one with more consumers). Update `evolution-dedup.ts` to import from `queue-migration.ts`. Then delete `evolution-queue-migration.ts`. | `evolution-dedup.ts:8` (change import path) |
| M2 | `InjectablePrinciple` triple definition | 🔄 UNIFY | Three definitions: `types.ts:20-26` (literal union), `prompt-builder/principle-selection.ts:20-27` (uses `PrinciplePriority` enum), `openclaw-plugin/core/principle-injection.ts` (re-exports from prompt-builder). **Action**: After D6 deletes the `types.ts` copy, only two remain. The canonical source is `prompt-builder/principle-selection.ts` (already used by openclaw-plugin). Update `principle-injector.ts` to import from there. | `principle-injector.ts:13` |
| M3 | `openclaw-plugin/src/types/` directory (5 re-export files) | 🔄 PARTIAL DELETE | 4 of 5 files are pure re-exports from `@principles/core/runtime-v2` with zero added value: `event-types.ts`, `hygiene-types.ts`, `queue.ts`, `runtime-summary.ts`. Only `principle-tree-schema.ts` adds local extension (`evaluability` field). **Action**: Delete 4 pure re-export files. Update their consumers to import directly from core. Keep `principle-tree-schema.ts`. | Consumers of each file (grep-verified: `event-types.ts` → `empathy-keyword-matcher.ts`, `empathy-types.ts`; `hygiene-types.ts` → `hygiene-engine.ts`; `queue.ts` → `evolution-types.ts`; `runtime-summary.ts` → `runtime-summary-service.ts`) |
| M4 | `openclaw-plugin/src/core/principle-injection.ts` (thin re-export) | 🏛️ RETAIN (low priority) | Already a thin re-export from `@principles/core/prompt-builder`. 7 files import from it. Changing all 7 imports is low-value churn. Leave for now. | None |
| M5 | `openclaw-plugin/src/core/principle-training-state.ts` | 🏛️ RETAIN + @deprecated | Legacy adapter over the hybrid principle tree ledger. Still has consumers. Mark `@deprecated` with migration path to `principle-tree-ledger.ts`. | None (just add annotation) |
| M6 | `handleBeforeMessageWrite` naming collision | 🔄 RENAME | Two files export same name: `message-sanitize.ts:77` and `trajectory-collector.ts:163`. `index.ts` disambiguates via namespace (`TrajectoryCollector.handleBeforeMessageWrite`). **Action**: Rename to `sanitizeBeforeMessageWrite` and `collectBeforeMessageWrite` for clarity. | `index.ts` (registration), `message-sanitize.ts`, `trajectory-collector.ts` |
| M7 | `getAllImplementations()` duplicated in 4 impl commands | 🔄 EXTRACT | `rollback-impl.ts`, `archive-impl.ts`, `disable-impl.ts`, `promote-impl.ts` each inline the same helper. **Action**: Extract to `commands/impl-helpers.ts`. | 4 command files |
| M8 | `pd-cli/src/config-reader.ts` → merge into `pd-config-loader.ts` | 🔄 MERGE | Two independent YAML config readers. `config-reader.ts` only reads `outputLanguage`. `pd-config-loader.ts` reads full config. **Action**: Migrate `readOutputLanguageFromWorkspace` to call `loadPdConfig` internally. Then delete `config-reader.ts`. | `config-reader.ts` consumers (3 command files) |
| M9 | `pd-cli/src/services/feature-flag-loader.ts` → merge into `pd-config-loader.ts` | 🔄 MERGE | Reads `.pd/feature-flags.yaml` (superseded by `.pd/config.yaml` per PRI-305). Still used by `runtime-internalization-queue.ts` and `runtime-canary.ts`. **Action**: Migrate 2 consumers to `loadPdConfig + computeFeatureFlagsFromConfig`. Then delete. | 2 consumer files |
| M10 | `pd-console/src/server/config/feature-flags.ts` → migrate to pd-config path | 🔄 MIGRATE | pd-console reads `.pd/feature-flags.yaml` while pd-cli reads `.pd/config.yaml`. Same flags, different source. **Action**: Change pd-console to use `loadPdConfig + computeFeatureFlagsFromConfig`. | `pd-console/src/server/config/feature-flags.ts` and its consumers |
| M11 | `pd-cli/src/commands/central-sync.ts` | ⚠️ ARCHIVE | Uses `Function('specifier', 'return import(specifier)')` hack to cross-import from openclaw-plugin. The sync logic duplicates `CentralSyncService` in openclaw-plugin. ADR-0014 §2.5 lists Central Sync as MVP-Quiet. **Action**: Archive command. Sync should be owned by plugin, not CLI. | `pd-cli/src/index.ts:18` (remove registration) |

---

### Items Retained (live consumers, no action needed now)

| ID | Item | Why Retained |
|----|------|-------------|
| K1 | `principles-core/src/pain-signal.ts` + `validatePainSignal` + `PainSignalSchema` | Used internally by runtime-v2. `PainSeverity` is used in deriveSeverity return type |
| K2 | `principles-core/src/telemetry-event.ts` | Used by `StoreEventEmitter` in runtime-v2 |
| K3 | `principles-core/src/pain-signal-adapter.ts` (interface) | 3 implementations in `adapters/` directory — genuine seam |
| K4 | `principles-core/src/principle-injector.ts` + `DefaultPrincipleInjector` | Used in internal tests. Remove from barrel export (make internal), but don't delete file |
| K5 | `principles-core/src/prompt-builder/*` | Active dependency of openclaw-plugin (16 import sites) |
| K6 | `principles-core/src/quality-scorecard/*` | Active dependency of pd-cli quality-scorecard command (4 import sites) |
| K7 | `principles-core/src/evolution-store.ts` | Consumed by pd-cli (`evolution-tasks-show.ts`, `evolution-tasks-list.ts`). Has I/O (SQLite) — move to runtime-engine in Phase 4 |
| K8 | `principles-core/src/trajectory-store.ts` | Consumed by pd-cli (`samples-list.ts`, `samples-review.ts`). Has I/O (SQLite) — move to runtime-engine in Phase 4 |
| K9 | `principles-core/src/io.ts` / `atomicWriteFileSync` | Used by `principle-tree-ledger.ts`, `workflow-funnel-loader.ts`. Has I/O — move to runtime-engine in Phase 4 |
| K10 | `principles-core/src/workflow-funnel-loader.ts` | Consumed by pd-cli. Has I/O — move to runtime-engine in Phase 4 |
| K11 | runtime-v2 Store layer (`SqliteConnection`, `SqliteTaskStore`, etc.) | Heavy consumption by pd-cli and openclaw-plugin. Move to runtime-engine in Phase 4 |
| K12 | runtime-v2 type/schema definitions | Heavy consumption. Move to contracts package in Phase 4 |
| K13 | `pd-console` (entire package) | MVP-Core — essential for owner review UI |
| K14 | `openclaw-plugin/src/core/event-log.ts` | Its `recordPainSignal` method is openclaw-plugin's own method (not core's `recordPainSignal` function). Heavily used. |
| K15 | `openclaw-plugin/src/utils/node-vm-polyfill.ts` | **Correction**: Has 2 real consumers (`rule-implementation-runtime.ts`, `code-validator.ts`). Not dead code. |
| K16 | `openclaw-plugin/src/core/principle-tree-ledger-adapter.ts` | **Correction**: 145-line real implementation (not a re-export). Cannot delete. |
| K17 | `openclaw-plugin/src/core/replay-engine.ts` | Has 2 consumers (`filesystem-lifecycle-datasource.ts`, `promote-impl.ts`) + 3 test files. Not dead. |
| K18 | `openclaw-plugin/src/core/session-tracker.ts` — `recordThinkingCheckpoint` | Active in `hooks/llm.ts`. |

---

### Barrel Export Cleanup (companion to deletions above)

When D1-D6 are deleted, the following barrel exports must be removed from `principles-core/src/index.ts`:

```
Line 22:  export { EvolutionHook, noOpEvolutionHook } from './evolution-hook.js';
Line 23:  export type { PrincipleCreatedEvent, PrinciplePromotedEvent } from './evolution-hook.js';
Line 26:  export { TelemetryEventSchema, validateTelemetryEvent } from './telemetry-event.js';  // KEEP (internal use)
Line 27:  export type { TelemetryEvent, TelemetryEventValidationResult, TelemetryEventType } from './telemetry-event.js';  // KEEP
Line 30:  export { StorageAdapter } from './storage-adapter.js';
Line 36:  export type { InjectablePrinciple } from './types.js';  // DELETE (canonical is in prompt-builder)
Line 37:  export type { HybridLedgerStore } from './types.js';    // DELETE (canonical is in principle-tree-ledger)
Line 40:  export type { WorkspaceResolver } from './types/workspace-resolver.js';
Line 46:  export { recordPainSignal } from './pain-recorder.js';
Line 47:  export type { PainSignalInput } from './pain-recorder.js';
Line 50:  export { resolvePainFlagPath } from './pain-flag-resolver.js';
```

Additionally, consider removing from barrel (used only internally, no external consumers):
- `DefaultPrincipleInjector` / `PrincipleInjector` / `InjectionContext` (line 33) — only used in internal tests
- `PainSignalSchema` (line 15) — external consumers use `validatePainSignal` or `recordPainSignal`
- `PainSeverity` (line 15) — subsumed by `deriveSeverity`

These are lower priority — removing them is a breaking change for any consumer doing `import { X } from '@principles/core'`, but since there are zero known external consumers, the risk is low.

---

## 3. Recurrence Prevention Mechanisms

### Discipline 1: Type Single Ownership

**Rule**: Any type/interface shared across packages must be defined in exactly one package. Other packages must re-export, not re-define.

**Enforcement**:
- Create `@principles/contracts` package (Phase 4) as the canonical home for all cross-package types
- CI rule: `rg "^export interface (InjectablePrinciple|HybridLedgerStore|PainSignal|TaskRecord|RunRecord)" packages/ --type ts` must match exactly one file per type name
- Violation = CI red

**Pre-MVP shortcut** (before contracts package exists):
- When adding a type that crosses package boundaries, add a comment `// CANONICAL — re-export only in other packages` at the definition site
- The architecture regression test can enforce this with a simple grep

### Discipline 2: Migration Must Accompany Deletion

**Rule**: When a new code path replaces an old one, the old code must be deleted in the same PR or the immediately following PR. "Stop calling" is not completion.

**Enforcement**:
- Add to AGENTS.md: "Migration PR Definition of Done = old code deleted + old barrel exports removed + old tests deleted or migrated"
- PR template checkbox: "□ If this PR migrates functionality, has the old path been deleted?"
- Architecture regression test: check that deprecated/obsolete code paths don't accumulate

### Discipline 3: API Surface Whitelist

**Rule**: Each package's `index.ts` barrel only exports symbols listed in `API_SURFACE.md`. New exports must first be declared in the whitelist with a named consumer.

**Enforcement**:
- Each package creates `API_SURFACE.md` listing: symbol name, kind (value/type), consumer package(s), since-date
- CI script: diff between `index.ts` actual exports and `API_SURFACE.md` entries → non-empty diff = red
- New export = PR must update `API_SURFACE.md`
- 6 months without a listed consumer = candidate for deletion

### Discipline 4: Core I/O Zero-Tolerance

**Rule**: `@principles/core` must not depend on `better-sqlite3`, `node:fs`, `node:child_process`, or any network library.

**Enforcement**:
- `package.json` `dependencies` must not list these packages
- CI: `rg "from 'better-sqlite3'|from 'node:fs'|from 'node:child_process'|require\('better-sqlite3'\)" packages/principles-core/src/` → any hit = red
- Exception: `@principles/runtime-engine` (new package, Phase 4) is allowed I/O
- Existing violations migrated in Phase 4

### Discipline 5: ADR Execution Tracking

**Rule**: Every ADR's "Consequences" section must list associated Linear issue IDs. ADR merge ≠ complete; all linked issues closed = complete.

**Enforcement**:
- ADR template adds `## Execution Tracking` section
- ADR-0014 §2.6 MVP-Gone list: each item gets a Linear issue
- Monthly review: check ADR execution completion rate

---

## 4. Execution Plan

### A0: Precondition — decide the canonical ledger (BLOCKING, do first)

Before any D6/M2 work, record a one-line decision: **which file + type is the single
authoritative ledger** (`principles-core/src/principle-tree-ledger.ts::HybridLedgerStore`
vs `openclaw-plugin/src/core/principle-tree-ledger.ts::PrincipleTreeStore`). Recommended:
core is authoritative; plugin re-exports/adapts. Ship a **read-only schema-diff test** first
(detects divergence between the two implementations) so convergence is observable and safe.
This is the §0.3 P0 item and the precondition for Linear PRI-390.

**SSOT Decision (PRI-413, 2026-06-16)**: `principles-core/src/principle-tree-ledger.ts` is the
canonical source for `HybridLedgerStore`, `LegacyPrincipleTrainingState`, `LegacyPrincipleTrainingStore`,
`LedgerTreeStore`, `LedgerPrinciple`, `LedgerRule`, `Principle`, `Rule`, `Implementation`,
`PrincipleValueMetrics`, and all ledger mutation functions (`loadLedger`, `saveLedger`,
`addPrincipleToLedger`, `updatePrinciple`, `updatePrincipleValueMetrics`).

The openclaw-plugin copy at `openclaw-plugin/src/core/principle-tree-ledger.ts` is the richer
implementation (file-lock via `withLock`/`withLockAsync`, async `saveLedgerAsync`, full CRUD for
rules/implementations, lifecycle state transitions) and **MUST import its types from core**.
The plugin-local type definitions for `LegacyPrincipleTrainingState`, `LegacyPrincipleTrainingStore`,
`LedgerPrinciple`, `LedgerRule`, `LedgerTreeStore`, `HybridLedgerStore`, and `PrincipleSubtree`
(lines 18–65 of the plugin copy) are duplicates that should converge to imports from core.

Schema-diff guard: `packages/principles-core/tests/ledger-schema-diff.test.ts` detects field-set
divergence between the two copies and fails CI until they are reconciled.

### Phase 0: Zero-Risk Deletions (1-2 days, no refactoring needed)

```
D7   tools/deep-reflect.ts           → delete file
D8   run-nocturnal.mjs               → delete file
D9   principle_training_state.json   → delete + .gitignore
D11  isProductionWorkspaceAllowed()  → delete function
D12  _buildConversationEntries()     → delete function
D13  runtime gfi snapshot duplicate  → remove registration lines
G8   NOCTURNAL_* path constants      → delete 3 constants
G9   Nocturnal runtime defaults      → delete 3 constants
```

**Verification**: After each deletion, run:
```bash
cd packages/principles-core && npm run build && npm run test
cd packages/openclaw-plugin && npm run build && npm run test
cd packages/pd-cli && npm run build && npm run test
```

### Phase 1: Dead Export Cleanup (3-5 days)

```
D1   StorageAdapter          → delete file + barrel + compile test
D2   EvolutionHook/noOp      → delete file + barrel + compile test
D3   WorkspaceResolver       → delete file + barrel
D4   recordPainSignal/Input  → delete file + barrel + io.ts singleton ref
D5   resolvePainFlagPath     → delete file + barrel
D6   types.ts duplicates     → delete definitions, fix principle-injector.ts import
D10  pd-cli adapter re-export → delete file, fix 3 command imports + 4 test mocks
```

**Verification**: Same as Phase 0 + check that `@principles/core` still compiles when imported by each package.

### Phase 2: MVP-Gone Execution (5-7 days)

**Must be done in this exact sequence due to live call chain**:

```
Step 2a: Remove subagent shadow routing hooks from openclaw-plugin index.ts
         - Remove subagent_spawning and subagent_ended hook registrations (lines 437-513)
         - Remove imports: recordShadowRouting, completeShadowObservation,
           classifyTask, WorkerProfile, PD_LOCAL_PROFILES, shadow-fingerprint
         - SAFETY: No user-visible change (shadow routing has zero real deployments)
         - TEST: All existing tests should pass (shadow routing is not tested in unit tests)

Step 2b: Simplify local-worker-routing.ts
         - Remove all I/O-bound code (deployment checks, promotion state, checkpoint checks)
         - classifyTask() becomes: call coreClassifyTaskKind() → build reason/blockers → always stay_main
         - Remove imports: isCheckpointDeployable, getPromotionState, isRoutingEnabledForProfile, getDeployment
         - Remove WorkerProfile type dependency

Step 2c: Now G3-G7 have zero callers → delete them
         G3: model-training-registry.ts        → delete
         G4: model-deployment-registry.ts      → delete
         G5: promotion-gate.ts                 → delete
         G6: external-training-contract.ts     → delete
         G7: shadow-observation-registry.ts    → delete

Step 2d: Clean up remaining artifacts
         - shadow-fingerprint.ts: archive (no more callers)
         - local-worker-routing.ts: further simplify or archive
         - replay-engine.ts: check if still needed after G3-G7 deletion
           (it is — still used by promote-impl.ts and filesystem-lifecycle-datasource.ts)

Step 2e: Archive TrainerRunner
         G1: TrainerRunner + trainer-output + trainer-prompt-builder → move to _archived/
         G2: MODEL_TRAINING_CHANNEL + TRAINER_KIND → remove from internalization-job-graph
         - Update pd-cli run-once command to remove --runner trainer option
         - Update architecture regression test
```

**Verification after each step**:
```bash
cd packages/openclaw-plugin && npm run build && npm run test
cd packages/principles-core && npm run build && npm run test
cd packages/pd-cli && npm run build && npm run test
```

### Phase 3: Merge / Consolidate (5-7 days)

```
M1   Queue migration merge     → unify into queue-migration.ts
M2   InjectablePrinciple unify → after D6, just fix principle-injector.ts import
M3   types/ directory cleanup  → delete 4 pure re-export files, update consumers
M6   handleBeforeMessageWrite  → rename both functions
M7   getAllImplementations      → extract to impl-helpers.ts
M8   config-reader merge       → migrate to pd-config-loader
M9   feature-flag-loader merge → migrate 2 consumers, delete
M10  pd-console feature-flags  → migrate to pd-config path
M11  central-sync command      → archive
```

### Phase 4: Package Structure Refactoring (3-5 weeks, incremental)

```
Step 4a: Create @principles/contracts
         - Pure types + Zod/TypeBox schemas
         - Zero runtime deps (no better-sqlite3, no fs, no network)
         - Migrate all cross-package types here

Step 4b: Create @principles/runtime-engine
         - I/O layer (SQLite, fs, child_process, network)
         - Depends on contracts + core
         - Move: SqliteConnection, stores, evolution-store, trajectory-store,
           principle-tree-ledger, io.ts, workflow-funnel-loader,
           runtime adapters, pain-signal-observability, read models

Step 4c: Slim @principles/core
         - Pure logic + schema validation only
         - prompt-builder, quality-scorecard, state machines, validation functions
         - No better-sqlite3, no fs, no child_process

Step 4d: CI gates go live
         - Type single ownership check
         - Core I/O zero-tolerance check
         - API surface whitelist check
         - ADR execution tracking check
```

---

## Estimated Impact

| Metric | Current | After Phase 0-3 | After Phase 4 |
|--------|---------|-----------------|---------------|
| principles-core top-level barrel exports | ~80 | ~30 | ~15 (core) + ~40 (contracts) |
| runtime-v2 barrel lines | 1594 | ~1200 | Split into 3 sub-barrels |
| Duplicate type definitions | 6 families / 15 files | 0 | 0 (contracts = canonical) |
| Phantom abstractions (zero-impl interfaces) | 3 | 0 | 0 |
| MVP-Gone code still exported | Trainer (~550 lines) + Phase 4/5 (~2500 lines) | 0 | 0 |
| Core I/O violation files | 14+ | 14+ (Phase 4 resolves) | 0 |
| Estimated lines deleted | — | ~3500 | ~5000+ |

---

## Appendix: Verification Methodology

Every deletion item in this document was verified by:

1. **`grep` for the symbol name** across all `.ts` files in `packages/`
2. **Manual reading** of each hit to distinguish:
   - Actual runtime import (delete = breaking change)
   - Test import (must update test)
   - Comment-only reference (safe to delete)
   - Barrel export line (must remove from barrel)
3. **Call chain tracing** for complex items (G3-G7) to identify the full dependency graph
4. **Cross-reference with ADR-0014** to verify MVP-Quiet/Gone classification is accurate

Items marked ⚠️ have live callers and require refactoring before deletion. Items marked ✅ have zero external callers and can be deleted directly.
