# ADR-0001: Runtime V2 Service Boundaries

**Status:** Accepted
**Date:** 2026-05-02
**Issues:** PRI-16, PRI-17, PRI-12, PRI-13, PRI-14, PRI-18

## Problem Statement

`pd-cli` and `openclaw-plugin` independently orchestrate the same pain-to-principle pipeline:

- Bridge creation via `createPainSignalBridge()`
- Observability writes via `recordPainSignalObservability()`
- Error classification (`classifyResult` / `classifyCatch`)
- Latency measurement with `Date.now()`

This duplication creates drift risk: pd-cli's `pain-record.ts` and openclaw-plugin's pain hook implement slightly different classification logic, observability call patterns, and error handling. When one changes, the other is easily missed.

## Target Architecture

Four ownership boundaries:

| Boundary | Package | Owns |
|----------|---------|------|
| **Core (domain)** | `@principles/core` | Pain-to-principle orchestration, state, read models, service contracts |
| **CLI (UX)** | `@principles/pd-cli` | Operator UX, output formatting, workspace resolution |
| **Plugin (hooks)** | `openclaw-plugin` | OpenClaw hook/event adaptation, platform-specific context |
| **Runtime adapters** | `pi-ai` / openclaw-cli | Model/provider execution only |

## First Boundary: PainToPrincipleService

A core-owned facade wrapping the existing pain-to-principle chain:

```typescript
class PainToPrincipleService {
  constructor(opts: PainToPrincipleServiceOptions)
  async recordPain(input: PainToPrincipleInput): Promise<PainToPrincipleOutput>
}
```

Owning: normalized pain input, optional observability write, bridge creation + invocation, latency measurement, failure category mapping, structured result output.

**Reuse rule:** Service internally calls `createPainSignalBridge()`, `recordPainSignalObservability()`, and `FAILURE_CATEGORY_MAP`. It does NOT reassemble `RuntimeStateManager`, `DiagnosticianRunner`, or `CandidateIntakeService` directly.

## Follow-up Boundary: PainChainReadModel

`PainChainReadModel` / `RuntimeChainInspector` for read-side queries (trace by painId, last successful chain, recent chains, missing links). Currently duplicated as inline SQL in `pd runtime trace show` and `pd health --json`.

## Plugin Logic Inventory

Logic that should migrate from callers to core over subsequent issues:

| Logic | Current Owner | Target Owner | Issue |
|-------|--------------|--------------|-------|
| Pain observability write | pd-cli manual | `PainToPrincipleService` | PRI-12 |
| Bridge creation + invocation | pd-cli / plugin | `PainToPrincipleService` | PRI-12 |
| Failure category mapping | pd-cli `classifyResult`/`classifyCatch` | `PainToPrincipleService` | PRI-12 |
| Latency measurement | pd-cli manual | `PainToPrincipleService` | PRI-12 |
| Runtime V2 diagnostician invocation | openclaw-plugin | Core via service | PRI-13 |
| Pain-chain read model (trace/health) | pd-cli inline SQL | Core `PainChainReadModel` | PRI-14 |

Logic that stays in plugin:

| Logic | Owner | Reason |
|-------|-------|--------|
| after_tool_call integration | openclaw-plugin | OpenClaw platform hook |
| GFI/session tracking | openclaw-plugin | OpenClaw session lifecycle |
| Diagnostic gate evaluation | openclaw-plugin | Gate logic is plugin-specific |
| Platform context extraction | openclaw-plugin | OpenClaw-specific metadata |
| Trajectory/event-log writes (OpenClaw-specific) | openclaw-plugin | Plugin-internal observability |

## Migration Plan

| Phase | Scope | Issue |
|-------|-------|-------|
| **A (this round)** | Implement `PainToPrincipleService` + exports, no callers migrated | PRI-17, PRI-12 |
| **B** | Migrate `pd pain record` to call service | PRI-18 |
| **C** | Thin openclaw-plugin pain hook to adapter | PRI-13 |
| **D** | Extract read model, deprecate inline factory | PRI-14 |

## Recommended Public API (post-consolidation)

| API | Role | Consumers |
|-----|------|-----------|
| `PainToPrincipleService` | Write-side orchestration (record pain, run pipeline) | CLI, plugin |
| `PainChainReadModel` | Read-side pain-chain traversal (trace, health) | CLI |
| `PruningReadModel` | Non-destructive pruning metrics | CLI |

**Internal implementation details (DO NOT import from CLI/plugin):**

| API | Reason |
|-----|--------|
| `createPainSignalBridge` | Internal factory — use `PainToPrincipleService` constructor |
| `recordPainSignalObservability` | Handled automatically by `PainToPrincipleService` |
| `PainSignalBridge` class | Core implementation — use `PainToPrincipleService.recordPain()` |
| `RuntimeStateManager` | Core state management — use `PainChainReadModel` for reads |
| `loadLedger` | Core ledger — use `PainChainReadModel` for reads |

## Compatibility Rules

- `PainToPrincipleService` is the **only** write-side orchestration API for CLI and plugin
- `PainChainReadModel` is the **only** read-side API for pain-chain traversal
- `createPainSignalBridge` is a core-internal factory, not for direct CLI/plugin use
- `recordPainSignalObservability` is handled automatically by PainToPrincipleService (never called manually from entry points)
- `PainSignalBridge` class remains as core implementation detail
- No database schema changes
- No behavior changes in this round

## Error Classification Contract

Service uses chain-integrity-first classification (moved from pd-cli):

1. If bridge result has `errorCategory` → map via `FAILURE_CATEGORY_MAP`
2. If `status=failed` and `candidateIds=[]` → `'candidate_missing'` (not `runtime_unavailable`)
3. If `status=failed` and `ledgerEntryIds=[]` → `'ledger_write_failed'` (not `runtime_unavailable`)
4. On thrown `PDRuntimeError` → map via `FAILURE_CATEGORY_MAP[err.category]`
5. On thrown generic Error → regex fallback (`config_missing`, `runtime_timeout`, `output_invalid`, default `runtime_unavailable`)

## Deferred

- No `RuleHost` / `PrincipleCompiler` move
- No auto-pruning design (PRI-15)
- No runtime provider selection change

## Rollback

Delete `pain-to-principle-service.ts` + test + exports from `index.ts`. Zero blast radius since no callers are migrated in this round.

## Testing

- Unit tests: mock `createPainSignalBridge` + `recordPainSignalObservability`, test service external contract
- Error classification parity: iterate all 17 `PDErrorCategory` values, verify mapping matches `FAILURE_CATEGORY_MAP`
- Idempotent scenarios: bridge returning `succeeded` (existing) and `skipped` (leased)
- Chain integrity: `candidate_missing` and `ledger_write_failed` must not map to `runtime_unavailable`
- Existing `PainSignalBridge` tests remain unchanged
