# ADR-0002: Hard Internalization Core Boundary

**Status:** Accepted
**Date:** 2026-05-03
**Issues:** PRI-41, PRI-42, PRI-43, PRI-44, PRI-45, PRI-46, PRI-47
**Supersedes:** ADR-0001 Deferred section ("No RuleHost / PrincipleCompiler move")

## Context (extends ADR-0001)

ADR-0001 drew the first architectural boundary: `PainToPrincipleService` stays in the plugin; all other runtime-v2 services moved to `@principles/core`. This ADR draws the second boundary: where does rule-internalization logic live after the runtime cutover?

ADR-0001 explicitly deferred the RuleHost / PrincipleCompiler question ("No move in this phase"). ADR-0002 answers that deferred question with a data-driven inventory and a staged migration order.

## Problem Statement

After ADR-0001 established pain-to-principle service boundaries, domain-heavy logic for rule execution, code compilation, lifecycle metrics, and internalization routing still lives in `openclaw-plugin`. These modules contain 70-100% pure domain logic with zero OpenClaw SDK dependency, yet they are inaccessible to `pd-cli` or future non-OpenClaw hosts.

Specific symptoms:
- `rule-host-types.ts`, `rule-host-helpers.ts` are pure domain contracts locked in plugin
- `lifecycle-metrics.ts`, `internalization-routing-policy.ts`, `deprecated-readiness.ts` are pure computation inaccessible to CLI
- `template-generator.ts` generates RuleHost sandbox code but can't be reused outside OpenClaw
- `nocturnal-rule-implementation-validator.ts` performs security validation with no OpenClaw dependency

## Current Plugin Domain Logic Inventory

### A. RuleHost System

| File | Path | Lines | Pure Domain | Dependencies |
|------|------|-------|-------------|--------------|
| `rule-host-types.ts` | `openclaw-plugin/src/core/` | 86 | 100% | None |
| `rule-host-helpers.ts` | `openclaw-plugin/src/core/` | 39 | 100% | `rule-host-types` |
| `nocturnal-rule-implementation-validator.ts` | `openclaw-plugin/src/core/` | 246 | 90% | `rule-host-types`, `rule-host-helpers`, `rule-implementation-runtime` |
| `rule-host.ts` | `openclaw-plugin/src/core/` | 254 | 70% | `fs`, `principle-tree-ledger`, `code-implementation-storage`, `rule-implementation-runtime` |
| `rule-implementation-runtime.ts` | `openclaw-plugin/src/core/` | 39 | 50% | `node:vm` polyfill |

### B. Principle Compiler

| File | Path | Lines | Pure Domain | Dependencies |
|------|------|-------|-------------|--------------|
| `template-generator.ts` | `openclaw-plugin/src/core/principle-compiler/` | 109 | 100% | None |
| `code-validator.ts` | `openclaw-plugin/src/core/principle-compiler/` | 121 | 70% | `node:vm`, `rule-implementation-runtime` |
| `compiler.ts` | `openclaw-plugin/src/core/principle-compiler/` | 243 | 40% | `reflection-context`, `trajectory`, `code-implementation-storage` |
| `ledger-registrar.ts` | `openclaw-plugin/src/core/principle-compiler/` | 117 | 30% | `principle-tree-ledger` |

### C. Principle Internalization

| File | Path | Lines | Pure Domain | Dependencies |
|------|------|-------|-------------|--------------|
| `lifecycle-metrics.ts` | `openclaw-plugin/src/core/principle-internalization/` | 153 | 100% | `lifecycle-read-model` (types only) |
| `internalization-routing-policy.ts` | `openclaw-plugin/src/core/principle-internalization/` | 209 | 100% | `lifecycle-read-model` (types), `lifecycle-metrics` |
| `deprecated-readiness.ts` | `openclaw-plugin/src/core/principle-internalization/` | 94 | 100% | `lifecycle-read-model` (types), `lifecycle-metrics` |
| `lifecycle-read-model.ts` | `openclaw-plugin/src/core/principle-internalization/` | 244 | 80% | `principle-tree-ledger`, `replay-engine`, `nocturnal-artifact-lineage` |
| `principle-lifecycle-service.ts` | `openclaw-plugin/src/core/principle-internalization/` | 169 | 40% | `principle-tree-ledger`, `lifecycle-read-model`, `lifecycle-metrics`, `deprecated-readiness`, `internalization-routing-policy` |

### D. OpenClaw-Specific (Stay in Plugin)

> ⚠️ Note: `compiler.ts` and `ledger-registrar.ts` also appear in Section B with a "Pure Domain" percentage. Both listings are correct — Section B shows how much pure domain logic each file contains; this section shows how much infrastructure (filesystem/OpenClaw) each file ultimately requires. Files land in this section when their infrastructure dependency prevents extraction.

| File | Path | Lines | OpenClaw % | Reason to Keep |
|------|------|-------|------------|----------------|
| `gate.ts` | `openclaw-plugin/src/hooks/` | 239 | 60% | OpenClaw hook lifecycle |
| `code-implementation-storage.ts` | `openclaw-plugin/src/core/` | 245 | 0% | Filesystem I/O bound |
| `principle-tree-ledger.ts` | `openclaw-plugin/src/core/` | 739 | 0% | Filesystem persistence |
| `replay-engine.ts` | `openclaw-plugin/src/core/` | 599 | 0% | Filesystem + VM I/O |
| `compiler.ts` | `openclaw-plugin/src/core/principle-compiler/` | 243 | 0% | Orchestration with I/O |
| `ledger-registrar.ts` | `openclaw-plugin/src/core/principle-compiler/` | 117 | 0% | Ledger I/O |

## Migration Classification

### 1. Move to @principles/core (Pure Domain)

| Module | Source | Lines | Target in Core |
|--------|--------|-------|----------------|
| RuleHost types | `rule-host-types.ts` | 86 | `runtime-v2/internalization/rule-host-contracts.ts` |
| RuleHost helpers | `rule-host-helpers.ts` | 39 | `runtime-v2/internalization/rule-host-helpers.ts` |
| Rule validation | `nocturnal-rule-implementation-validator.ts` | 246 | `runtime-v2/internalization/rule-validator.ts` |
| Template generation | `template-generator.ts` | 109 | `runtime-v2/internalization/template-generator.ts` |
| Lifecycle metrics | `lifecycle-metrics.ts` | 153 | `runtime-v2/internalization/lifecycle-metrics.ts` |
| Routing policy | `internalization-routing-policy.ts` | 209 | `runtime-v2/internalization/routing-policy.ts` |
| Deprecated readiness | `deprecated-readiness.ts` | 94 | `runtime-v2/internalization/readiness.ts` |

**Total pure domain logic to extract: ~936 lines**

### 2. Move Core Logic, Keep Adapter in Plugin

| Module | Core Part | Plugin Adapter |
|--------|-----------|----------------|
| `rule-host.ts` | Decision merge logic (block short-circuits, requireApproval collects, conservative degradation D-08) | `RuleHostStorage` adapter for ledger/filesystem |
| `code-validator.ts` | Forbidden pattern detection, export validation, return shape validation | `RuleHostRuntime` adapter for VM sandbox |
| `lifecycle-read-model.ts` | Type definitions (`LifecycleReadModel`, `PrincipleLifecycleEvidence`, etc.), evidence aggregation transforms | `LifecycleDatasource` adapter for replay/lineage data |

### 3. Stay in Plugin (Infrastructure-Bound)

| Module | Reason |
|--------|--------|
| `gate.ts` | OpenClaw `before_tool_call` hook — platform lifecycle |
| `code-implementation-storage.ts` | Filesystem asset management |
| `principle-tree-ledger.ts` | Filesystem ledger persistence |
| `replay-engine.ts` | Dataset loading + VM execution |
| `compiler.ts` | Orchestrates I/O (reflection context, trajectory DB, storage) |
| `ledger-registrar.ts` | Ledger CRUD operations |
| `principle-lifecycle-service.ts` | Orchestrates ledger reads/writes |
| `rule-implementation-runtime.ts` | Node.js VM binding |

## Proposed Adapter Interfaces

> All adapter methods follow the same error contract: on failure they **throw** a descriptive `Error`. Callers (plugin orchestration layer) are responsible for try/catch and rollback. Implementations guarantee atomicity within a single call — no partial state on error.

```typescript
// ── Storage: load active implementations ──
interface RuleHostStorage {
  /**
   * @throws Error if stateDir is invalid or ledger unreadable
   */
  loadActiveImplementations(stateDir: string): Promise<Implementation[]>;
  /**
   * @throws Error if implId not found or source file unreadable
   */
  loadImplementationSource(stateDir: string, implId: string): Promise<string>;
}

// ── Runtime: compile and execute rule code ──
interface RuleHostRuntime {
  /**
   * Compiles and evaluates rule source against input.
   * @throws Error if source is invalid, vm fails, or execution times out
   * @returns Promise<RuleHostResult> with matched/error field populated
   */
  compile(source: string, input: RuleHostInput): Promise<RuleHostResult>;
}

// ── Ledger: principle tree CRUD ──
interface LedgerAccess {
  /**
   * @throws Error if stateDir unreadable
   */
  loadLedger(stateDir: string): Promise<PrincipleTree>;
  /**
   * @throws Error on write failure — caller must handle rollback
   */
  updatePrinciple(stateDir: string, id: string, patch: Partial<Principle>): Promise<void>;
  /**
   * @throws Error on write failure — caller must handle rollback
   */
  updateRule(stateDir: string, principleId: string, ruleId: string, patch: Partial<Rule>): Promise<void>;
}

// ── Datasource: replay and lineage evidence (read-only, no error recovery needed) ──
interface LifecycleDatasource {
  /**
   * @returns undefined if no report exists for implId (not an error)
   */
  loadReplayReport(stateDir: string, implId: string): Promise<ReplayReport | undefined>;
  /**
   * @throws Error if stateDir or lineage store is inaccessible
   */
  listLineageRecords(stateDir: string, kind: string): Promise<ArtifactLineageRecord[]>;
}
```

## Proposed Core Module Structure

```
packages/principles-core/src/runtime-v2/internalization/
├── index.ts                    # Barrel exports
├── rule-host-contracts.ts      # RuleHostInput, RuleHostDecision, RuleHostResult, etc.
├── rule-host-helpers.ts        # createRuleHostHelpers
├── rule-validator.ts           # validateRuleImplementationCandidate
├── template-generator.ts       # generateFromTemplate, PainPattern
├── lifecycle-metrics.ts        # computeRuleMetrics, computePrincipleAdherence
├── routing-policy.ts           # recommendInternalizationRoute, InternalizationRoute
├── readiness.ts                # assessDeprecatedReadiness
├── internalization-route.ts    # PRI-43: maps recommendation kind → route (new)
└── adapters.ts                 # Adapter interfaces (RuleHostStorage, etc.)
```

## Execution Order

> Milestone mapping: **M4** = "Core Internalization Boundary", **M5** = "RuleHost Adapter Thinning", **M6** = "Operator Visibility". PRI-47 is post-milestone cleanup.

Dependencies drive a strict order. Each issue builds on the previous.

```
PRI-42  ──→  PRI-43  ──→  PRI-44  ──→  PRI-45  ──→  PRI-46  ──→  PRI-47
M4            M4            M5            M5            M6            post-boundary
```

| Order | Issue | Scope | Risk | Depends On |
|-------|-------|-------|------|------------|
| 1 | **PRI-42** | Extract RuleHost contract types + helpers to core | Low | PRI-41 (this ADR) |
| 2 | **PRI-43** | Define core `InternalizationRoute` model (maps `RecommendationKind` → route) | Low | PRI-31 taxonomy |
| 3 | **PRI-44** | Extract pure PrincipleCompiler components (template-gen, validation) | Medium | PRI-41, PRI-43 |
| 4 | **PRI-45** | Thin OpenClaw RuleHost adapter around core contracts | Medium | PRI-42 |
| 5 | **PRI-46** | Add operator CLI inspect commands for internalization readiness | Low | PRI-43 |
| 6 | **PRI-47** | Stage PRI-39 store modularization after boundary stabilizes | Low | PRI-42, PRI-45 |

### Dependency Rationale

- **PRI-42 first**: Zero-risk pure type extraction. Unblocks PRI-45.
- **PRI-43 second**: Builds on PRI-31's 5-kind taxonomy. Pure model, no I/O. Unblocks PRI-46.
- **PRI-44 third**: Template generation and validation depend on rule-host contracts from PRI-42.
- **PRI-45 fourth**: Thins the plugin adapter. Requires PRI-42 contracts in core.
- **PRI-46 fifth**: CLI visibility. Requires PRI-43 route model.
- **PRI-47 last**: Store cleanup must wait until core/plugin boundary is stable to avoid merge churn.

### PRI-39 (Store Modularization)

PRI-39 is explicitly **not** in the critical path. Per PRI-47, store directory restructuring should only proceed after PRI-42 and PRI-45 land. Moving store files before core/plugin boundaries stabilize risks merge conflicts and rework.

## Architecture Guards

> ⚠️ The following test names are **placeholders for future implementation**. Implement each as a real test in `packages/principles-core/src/__tests__/architecture-regression.test.ts` when PRI-N lands. Until then, these serve as an explicit checklist, not a passing test suite.

After migration, add architecture regression tests:

```typescript
// architecture-regression.test.ts additions:

// 1. No duplicate RuleHost contract definitions in plugin
test('plugin must not re-define RuleHostInput/RuleHostResult/RuleHostDecision', () => {
  // Grep openclaw-plugin for these type names — they must come from @principles/core
});

// 2. Core internalization module exports are non-empty
test('@principles/core exports internalization contracts', () => {
  // Verify RuleHostInput, InternalizationRoute, etc. are exported
});

// 3. Plugin imports core contracts, not local copies
test('plugin rule-host imports from @principles/core/runtime-v2', () => {
  // Verify import paths point to core, not local re-definitions
});

// 4. No OpenClaw SDK imports in core internalization module
test('core internalization has zero openclaw-plugin dependencies', () => {
  // Grep core/internalization/ for openclaw-plugin imports
});
```

## Compatibility Rules

- Plugin switches imports from local files to `@principles/core/runtime-v2` — no behavior change
- Core module does NOT import from `openclaw-plugin` — import direction is strictly core ← plugin
- `gate.ts` remains unchanged — it consumes `RuleHost` which delegates to core contracts
- No database schema changes
- No RuleHost evaluation behavior changes
- `RecommendationKind` taxonomy (from PRI-31) remains canonical in `diagnostician-output.ts`

## Risks

| Risk | Mitigation |
|------|------------|
| Circular dependency if core imports plugin types | Architecture guard: core internalization must not import from plugin |
| Duplicate type definitions during migration | Architecture guard: grep for re-defined contracts in plugin |
| VM runtime abstraction leaks into core | Keep `rule-implementation-runtime.ts` in plugin behind `RuleHostRuntime` adapter |
| Lifecycle read model split creates two copies of types | Core owns types; plugin imports from core and adds datasource-specific construction |
| Merge conflicts with PRI-39 store moves | Sequence PRI-39 after all internalization boundary issues (PRI-47) |

## Non-Goals

- No RuleHost behavior changes (block/approval/allow logic stays identical)
- No store layer restructuring (PRI-39/PRI-47)
- No auto-pruning or auto-compilation
- No OpenClaw gateway dependency in core
- No filesystem abstraction beyond the adapter interfaces above
- No CLI command changes (PRI-46 handles that separately)

## Rollback

Delete `packages/principles-core/src/runtime-v2/internalization/` directory, revert plugin imports to local files. Zero blast radius until PRI-42 starts switching imports.

## Testing

- PRI-42: Export/compile tests in core, plugin typecheck regression
- PRI-43: Unit tests for all 5 recommendation kinds → route mapping
- PRI-44: Template generation tests in core, existing compiler tests in plugin
- PRI-45: Adapter contract tests proving OpenClaw gate still maps to core `RuleHostInput`
- PRI-46: CLI command tests, reuse PRI-43 route model
