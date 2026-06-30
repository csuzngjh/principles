# Plugin Core Inventory & Migration Classification

**Date:** 2026-05-21
**Scope:** `packages/openclaw-plugin/src/core/`
**Total TS Files:** 109 (107 source files + 2 test files)
**Total Lines:** 32,142 (including tests)

---

## 1. Legacy Execution Deletion Inventory (ADR-0005 amended by ADR-0012)

This section was originally written while Runtime V2 was still being proven and marked these files as frozen. ADR-0012 changes the action: do not add new behavior to them, but do remove them through dedicated retirement PRs once live callers are cut over. They are deletion inventory, not protected long-term architecture.

| File | Lines | Notes / ADR Context |
|------|-------|---------------------|
| `nocturnal-trinity.ts` | 2,870 | God-class containing duplicate execution pipeline. Retire after caller cutover. |
| `nocturnal-arbiter.ts` | 715 | Duplicate validation/execution contract. Retire after historical-read decision. |

> [!IMPORTANT]
> `nocturnal-service.ts` is also a retirement target under ADR-0012 but is located in `packages/openclaw-plugin/src/service/` rather than the `core/` subdirectory, and is therefore excluded from the counts here.

### Subtotal: 2 files, 3,585 lines (11.15% of total lines)

---

## 2. Pure Domain Logic Candidates

These files have absolutely NO I/O imports (no `fs`, `path`, `os`, `crypto`, `url`, `better-sqlite3`, `openclaw-sdk`, or local plugin utility imports). They depend only on `@principles/core`, `@sinclair/typebox`, or nothing at all. They are the safest to migrate to `@principles/core` with zero architectural risk.

| File | Lines | Imports / Dependencies | Migration Risk & Feasibility |
|------|-------|------------------------|------------------------------|
| `nocturnal-compliance.ts` | 1,146 | None (zero imports) | **Stateless computation** — extremely low risk. Largest candidate. |
| `trajectory-types.ts` | 243 | None (zero imports) | **Type definitions** — safe and highly recommended for domain modeling. |
| `profile.ts` | 228 | None (zero imports) | **Default profile constants** — pure static configuration. |
| `pain-signal.ts` | 139 | `@sinclair/typebox` | **Type schema** — safe schema definition. |
| `pd-task-types.ts` | 112 | `@sinclair/typebox` | **Type schema** — safe schema definition. |
| `evolution-types.ts` | 110 | `./trajectory-types.js` (pure local) | **Domain types** — ready to migrate once dependencies are moved. |
| `telemetry-event.ts` | 109 | `@sinclair/typebox` | **Type schema** — telemetry data structure definition. |
| `nocturnal-trinity-types.ts` | 30 | None (zero imports) | **Type definitions** — related to frozen legacy, but pure. |
| `nocturnal-candidate-scoring.ts` | 20 | None (zero imports) | **Stateless scoring types** — trivial migration. |
| `empathy-types.ts` | 18 | None (zero imports) | **Trivial** — type definitions. |
| `correction-types.ts` | 16 | None (zero imports) | **Trivial** — type definitions. |
| `principle-injection.ts` | 16 | None (zero imports) | **Pure logic** — selection and mapping. |
| `nocturnal-snapshot-contract.ts` | 14 | None (zero imports) | **Trivial** — interface contract. |
| `principle-compiler/template-generator.ts` | 8 | None (zero imports) | **Pure generator** — stateless template builder. |

### Subtotal: 14 files, 2,209 lines (6.87% of total lines)

---

## 3. Thin Adapter Candidates

These files reside at the I/O boundary but act strictly as thin adapters or wrappers around core logic. They wrap file/database persistence or local services into core runtime interfaces. They are excellent targets to keep in the plugin while extracting any nested pure computations to the core.

| File | Lines | Adapter Role / Target Interface |
|------|-------|---------------------------------|
| `local-worker-routing.ts` | 337 | Wraps model dispatch routing with plugin-specific capacity limits. |
| `principle-tree-migration.ts` | 196 | CLI adapter to migrate legacy principle state to ledger format. |
| `principle-internalization/principle-lifecycle-service.ts` | 170 | Orchestrates datasource and read model at the internalization boundary. |
| `principle-tree-ledger-adapter.ts` | 145 | Wires up the core `LedgerAdapter` interface to the database-backed ledger. |
| `principle-compiler/ledger-registrar.ts` | 116 | Registers compiled rules to the DB ledger. |
| `principle-compiler/code-validator.ts` | 93 | Wires filesystem validator to runtime evaluation. |
| `principle-injector.ts` | 84 | Formats prompts and passes values to pure injection logic. |
| `pd-task-service.ts` | 43 | Wraps openclaw-sdk types to expose a simple service facade. |
| `principle-internalization/lifecycle-read-model.ts` | 40 | Facade query model fed by a filesystem datasource. |
| `principle-internalization/filesystem-lifecycle-datasource.ts` | 31 | Concrete implementation of the core `LifecycleDatasource` using file I/O. |
| `config-service.ts` | 29 | Service wrapper providing access to config file variables. |
| `principle-compiler/index.ts` | 13 | **Compatibility Barrel** — Zero imports does not represent purity here. The target modules of the barrel exports (e.g. `compiler.ts`, `code-validator.ts`, `ledger-registrar.ts`) are I/O bound or plugin-bound APIs. Its boundary properties are determined by its exports. **Cannot be a core migration candidate.** |
| `principle-internalization/lifecycle-refresh.ts` | 11 | Instantiation helper for the internalization lifecycle. |

### Subtotal: 13 files, 1,308 lines (4.07% of total lines)

---

## 4. Do Not Move

These files are intrinsically plugin-specific runtime bindings, database schema definitions, or bootstrap sequences. They rely heavily on the local platform environment and **must remain in the plugin package**.

| File | Lines | Reason for Keeping in Plugin |
|------|-------|------------------------------|
| `event-log.ts` | 816 | Direct openclaw-sdk integration for tracking and event persistence. |
| `schema/schema-definitions.ts` | 650 | Core database SQLite schema definitions. |
| `path-resolver.ts` | 449 | Node `os`/`path`-dependent workspace path computation. |
| `init.ts` | 290 | Plugin bootstrap, initialization, and lifecycle registration. |
| `workspace-context.ts` | 256 | Plugin composition root, wiring together I/O datasources and services. |
| `reflection/reflection-context.ts` | 228 | VM sandboxing reflection layer for code evaluation. |
| `bootstrap-rules.ts` | 216 | Seed rules generation, filesystem, and ledger initializer. |
| `schema/migration-runner.ts` | 207 | DB SQLite migrations executor. |
| `rule-host.ts` | 197 | VM sandboxed execution environment executor. |
| `principle-training-state.ts` | 177 | Tracks in-memory runtime session state for the active agent. |
| `pain-diagnostic-gate.ts` | 149 | Orchestrates diagnostic validation, logging directly to local system logger. |
| `hygiene/tracker.ts` | 122 | Heartbeat and diagnostic reporting to openclaw-sdk. |
| `schema/migrations/002-init-central.ts` | 122 | SQLite migration script. |
| `workspace-dir-service.ts` | 119 | Tightly bound to openclaw-sdk workspace structures. |
| `paths.ts` | 92 | Plugin constants defining paths on the host system. |
| `schema/migrations/004-add-thinking-and-gfi.ts` | 74 | SQLite migration script. |
| `evolution-hook.ts` | 74 | OpenClaw plugin event handler hook binding. |
| `storage-adapter.ts` | 65 | Database low-level transaction mapper. |
| `schema/migrations/003-init-workflow.ts` | 55 | SQLite migration script. |
| `workspace-dir-validation.ts` | 43 | OS-level directory validation. |
| `pain-signal-adapter.ts` | 42 | Adapts incoming plugin events to domain pain models. |
| `rule-implementation-runtime.ts` | 38 | Polyfill layer for VM environments. |
| `detection-service.ts` | 31 | Service layer coordinating pain dictionary and detection funnel. |
| `schema/migrations/index.ts` | 31 | Migration definitions indexing. |
| `dictionary-service.ts` | 29 | Coordinates loading local dictionary files. |
| `schema/index.ts` | 26 | Entry point for DB schema setup. |
| `schema/db-types.ts` | 16 | SQLite query structures (tightly coupled to DB schema). |
| `rule-host-types.ts` | 14 | Rule host VM integration type definitions. |
| `rule-host-helpers.ts` | 9 | Helper methods for sandboxed rule execution. |
| `schema/migrations/001-init-trajectory.ts` | 211 | SQLite migration script. |

### Subtotal: 30 files, 4,848 lines (15.08% of total lines)

---

## 5. I/O Boundary

These files form the primary I/O-bound application layers. They operate on files, database connections, and model network calls. They cannot move to `@principles/core` as-is, but are major candidates for extracting pure logic functions.

| File | Lines | Core I/O Dependencies |
|------|-------|----------------------|
| `trajectory.ts` | 1,777 | `better-sqlite3`, `fs`, `path`, `crypto` |
| `evolution-reducer.ts` | 891 | `crypto`, `fs`, `path` |
| `promotion-gate.ts` | 854 | `fs`, `path`, `crypto` |
| `model-training-registry.ts` | 815 | `fs`, `path`, `crypto` |
| `nocturnal-dataset.ts` | 767 | `fs`, `path`, `crypto` |
| `focus-history.ts` | 763 | `fs`, `path` |
| `model-deployment-registry.ts` | 724 | `fs`, `path`, `crypto` |
| `training-program.ts` | 632 | `fs`, `path`, `url` |
| `replay-engine.ts` | 599 | `fs`, `path` |
| `external-training-contract.ts` | 530 | `crypto`, `fs`, `url` |
| `nocturnal-trajectory-extractor.ts` | 512 | `fs`, `path` (via `trajectory.ts` dependency) |
| `merge-gate-audit.ts` | 509 | `fs`, `path` |
| `shadow-observation-registry.ts` | 508 | `path`, `crypto` |
| `nocturnal-export.ts` | 499 | `fs`, `path`, `crypto` |
| `adaptive-thresholds.ts` | 484 | `fs`, `path` |
| `control-ui-db.ts` | 454 | `better-sqlite3`, `fs`, `path` |
| `nocturnal-executability.ts` | 428 | `fs` (via imports of sandbox and compliance) |
| `thinking-models.ts` | 397 | Tightly coupled with file-based config parsing |
| `nocturnal-artificer.ts` | 396 | Wires files and database logs for artifact building |
| `pd-task-reconciler.ts` | 380 | `fs`, `path`, `os` |
| `correction-cue-learner.ts` | 373 | `fs`, `path` |
| `nocturnal-reasoning-deriver.ts` | 343 | Operates on active workspaces |
| `principle-compiler/compiler.ts` | 327 | Dynamic module compilation using filesystem files |
| `pain.ts` | 309 | `fs`, `path` |
| `pain-context-extractor.ts` | 306 | `fs`, `path`, `os`, `fs/promises` |
| `config.ts` | 291 | `fs`, `path` |
| `nocturnal-rule-implementation-validator.ts` | 246 | filesystem check + dynamic import execution |
| `code-implementation-storage.ts` | 244 | `fs`, `path` |
| `nocturnal-paths.ts` | 240 | `fs`, `path` (I/O path generation) |
| `observability.ts` | 242 | `fs`, `path` |
| `file-storage-adapter.ts` | 203 | `fs`, `path` |
| `workflow-funnel-loader.ts` | 195 | `fs`, `path`, `yaml` |
| `dictionary.ts` | 174 | `fs`, `path` |
| `thinking-os-parser.ts` | 165 | `fs`, `path`, `url` |
| `system-logger.ts` | 127 | `fs`, `path` |
| `detection-funnel.ts` | 124 | `crypto` |
| `risk-calculator.ts` | 118 | `fs` |
| `nocturnal-artifact-lineage.ts` | 117 | `fs`, `path` |
| `migration.ts` | 95 | `fs`, `path` |
| `file-store.ts` | 80 | `fs`, `path` |
| `pd-task-store.ts` | 78 | `fs`, `path` |
| `evolution-migration.ts` | 77 | `fs`, `path` |
| `empathy-keyword-matcher.ts` | 64 | `fs`, `path` |
| `pain-lifecycle.ts` | 38 | `fs` |
| `session-tracker.ts` | 605 | `fs`, `path` |
| `principle-tree-ledger.ts` | 738 | `fs`, `path` |
| `evolution-logger.ts` | 357 | `crypto` |
| `evolution-engine.ts` | 613 | `fs`, `path` |

### Subtotal: 48 files, 19,808 lines (61.63% of total lines)

---

## 6. Test Files

These files are test suites and are not candidates for migration.

| File | Lines | Notes |
|------|-------|-------|
| `__tests__/focus-history.test.ts` | 210 | Test suite for focus history. |
| `principle-compiler/__tests__/compiler-replay-gate.test.ts` | 174 | Test suite for compiler replay gate. |

### Subtotal: 2 files, 384 lines (1.20% of total lines)

---

## 7. Summary of Categories

| Category | File Count | Line Count | Percentage of Total Lines |
|----------|------------|------------|---------------------------|
| **Legacy execution deletion inventory (ADR-0012)** | 2 | 3,585 | 11.15% |
| **Pure Domain Logic Candidates** | 14 | 2,209 | 6.87% |
| **Thin Adapter Candidates** | 13 | 1,308 | 4.07% |
| **Do Not Move** | 30 | 4,848 | 15.08% |
| **I/O Boundary** | 48 | 19,808 | 61.63% |
| **Test Files** | 2 | 384 | 1.20% |
| **Total** | **109** | **32,142** | **100.00%** |

---

## 8. Shortlist: 5 Safest Follow-Up Migration Candidates

Based on the complete inventory, the following 5 files have been selected as the safest and most valuable candidates for follow-up refactoring. They are ranked by migration safety and impact.

### #1. `nocturnal-compliance.ts` (1,146 lines, 0 imports)
* **Why Safe:** Has absolute zero imports, functioning as a stateless computation over event streams.
* **Why High Impact:** Moving this removes 1,146 lines of pure logic from the plugin core, representing the single largest pure chunk.
* **Refactoring Strategy:** Move the entire file to `@principles/core` and export it back from the plugin as a lightweight proxy/adapter.

### #2. `trajectory-types.ts` (243 lines, 0 imports)
* **Why Safe:** Pure TS type definitions with zero runtime dependencies.
* **Why High Impact:** Establishes the foundational types for the trajectory engine in the core package.
* **Refactoring Strategy:** Move to `@principles/core` and update plugin imports to reference core.

### #3. `profile.ts` (228 lines, 0 imports)
* **Why Safe:** Pure stateless constants and default profile values.
* **Why High Impact:** Standardizes system defaults at the core level.
* **Refactoring Strategy:** Move to core and update reference paths.

### #4. `pain-signal.ts` (139 lines, `@sinclair/typebox` only)
* **Why Safe:** Pure TypeBox schema definitions without any platform imports.
* **Why High Impact:** Wires the pain schema structurally to the core runtime-v2 engine where pain diagnostics are run.
* **Refactoring Strategy:** Move to core and register.

### #5. `pd-task-types.ts` (112 lines, `@sinclair/typebox` only)
* **Why Safe:** Pure TypeBox schema definitions for tasks with zero system side-effects.
* **Why High Impact:** Wires domain tasks directly into `@principles/core` task orchestration.
* **Refactoring Strategy:** Move to core and reference from the plugin.

---

## 9. Verification & Audit Trail

### Audit Commands
To verify the integrity of the inventory file counts, the following commands were run inside the workspace directory:

```bash
# Count total TypeScript files under core (should equal 109)
rg --files packages/openclaw-plugin/src/core -g '*.ts' | measure -Line

# Count test files under core (should equal 2)
rg --files packages/openclaw-plugin/src/core -g '*.test.ts' | measure -Line
```

### Statistics Result Verification
- **Total Tracked TS Files:** 109 (comprising 107 source files + 2 test files).
- **Comprehensive Database Check:** Every single `.ts` file under `packages/openclaw-plugin/src/core/` is accounted for and belongs to exactly **one** category above.
- **Legacy Retirement:** `nocturnal-trinity.ts` and `nocturnal-arbiter.ts` are excluded from ordinary utility extraction because they must be deleted through ordered caller-cutover retirement work, not refactored into new canonical modules.

---
*Verified and generated by the Principles Disciple Agent. This is a read-only architecture report — no source files were moved.*
