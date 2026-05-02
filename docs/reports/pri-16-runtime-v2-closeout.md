# PRI-16 Closeout Report: Runtime V2 Core Service Refactor

**Issue:** PRI-16 — Runtime V2 core service refactor
**Date:** 2026-05-02
**Branch:** `codex/pri-16-runtime-v2-closeout`
**Status:** CLOSED

## PR Stack

| PR | Description | Status |
|----|-------------|--------|
| #428 | ADR-0001: Runtime V2 service boundaries | Merged |
| #429 | PRI-18 Phase B: pd pain record migration | Merged |
| #430 | PRI-17 Phase A: PainToPrincipleService facade | Merged |
| #432 | PRI-12: PainToPrincipleService integration tests | Merged |
| #434 | PRI-13: OpenClaw plugin thinning | Merged |

## Architecture Boundaries (ADR-0001)

### Write Path (single entry)
```
openclaw-plugin after_tool_call  ─┐
pd pain record CLI               ─┴→ PainToPrincipleService → PainSignalBridge
```

### Read Path (single entry)
```
pd runtime trace show  ─┐
pd health --json        ┴→ PainChainReadModel → RuntimeStateManager + SQLite
```

### Ownership

| Boundary | Package | Owns |
|----------|---------|------|
| Core (domain) | `@principles/core` | Pain orchestration, state, read models, service contracts |
| CLI (UX) | `@principles/pd-cli` | Operator UX, output formatting, workspace resolution |
| Plugin (hooks) | `openclaw-plugin` | OpenClaw hook/event adaptation, GFI gate, diagnostic gate |
| Runtime adapters | `pi-ai` / openclaw-cli | Model/provider execution only |

## Code Audit Results

### ✅ CLI — clean service boundaries

- `pain-record.ts` — `PainToPrincipleService.recordPain()` directly, no bridge orchestration ✓
- `trace.ts` — `PainChainReadModel.traceByPainId()` only, no inline SQL ✓
- `health.ts` — `PainChainReadModel.getLastSuccessfulChain()` for lastSuccessfulChain; inline SQLite for metrics-only queries (`candidates`, `tasks` counts) — these are workspace stats, not pain-chain traversal, acceptable ✓

### ✅ Plugin — clean service boundary

- `pain.ts` `emitPainDetectedEvent()` — calls `PainToPrincipleService.recordPain()`, no `PainSignalBridge` direct use ✓
- No `createPainSignalBridge` in plugin hooks ✓
- Plugin retains: GFI gate, cooldown, `PainDiagnosticGate`, trajectory/event-log writes, observability recording via `recordObservability: true` ✓

### ⚠️ Notes (non-blocking)

- `health.ts` inline SQL for candidate/task counts is legacy metrics — acceptable, not pain-chain traversal
- `RuntimeStateManager` used in `candidate.ts`, `task.ts`, `run.ts`, `artifact.ts`, `diagnose.ts` for entity CRUD — these are domain operations, not pain-chain traversal

### Anti-patterns verified absent

```bash
# Verified NOT present in pd-cli/src/commands/ or openclaw-plugin/src/hooks/:
- createPainSignalBridge direct calls      ✓ absent
- RuntimeStateManager pain-chain traversal ✓ absent
- loadLedger direct chain building         ✓ absent
- pain_flag file writes                     ✓ absent
```

## Test Results

```
✅ @principles/core build         — tsc passed
✅ @principles/pd-cli build      — tsc passed
✅ openclaw-plugin build         — tsc passed
✅ pain-to-principle-service     — 16/16 passed
✅ pain-chain-read-model         — 13/13 passed
✅ auto-entry-gate               —  8/8  passed
✅ runtime-v2-pain-guard         —  4/4  passed
✅ pd pain record                — 10/10 passed
```

## Remaining Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Real OpenClaw trigger not exercised in CI | Low | UAT is plugin-level; CI tests pain-guard integration; real trigger deferred as "real-world validation" |
| `health.ts` metrics via raw SQL | Low | Acceptable — these are workspace stats, not pain-chain; future migration to read model if needed |
| `RuntimeStateManager` direct use in candidate/task/run/artifact | Low | These are entity CRUD, not pain-chain traversal — within scope |

## Non-Goals (verified not done)

- ❌ RuleHost / PrincipleCompiler migration
- ❌ Auto-pruning metrics/read model (PRI-15)
- ❌ Database schema changes
- ❌ GFI refactor
- ❌ Large directory restructuring

## Next Steps

**PRI-15** (recommended next): Dynamic pruning metrics/read model
- Extract `PainChainReadModel.getChainsByStatus()` for UAT dashboard
- `pd candidate prune --dry-run` using read model
- Metric: `getChainsByStatus('failed')` for pruning candidate selection

## Linear Update Log

- PRI-16 Phase A (ADR) → Done
- PRI-16 Phase B (PainToPrincipleService) → Done
- PRI-16 Phase C (plugin thinning PRI-13) → Done
- PRI-16 Phase D (read model PRI-14) → Done
- PRI-16 real-world validation → Deferred (not architecture blocker)
