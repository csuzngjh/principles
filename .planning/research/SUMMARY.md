# Project Research Summary

**Project:** v1.21.1 Workflow Funnel Runtime
**Domain:** YAML runtime integration (WorkflowFunnelLoader wiring into RuntimeSummaryService)
**Researched:** 2026-04-19
**Confidence:** HIGH

## Executive Summary

v1.21.1 is a wiring-only release. `WorkflowFunnelLoader` is fully implemented, `js-yaml@^4.1.1` is already in deps, and `fs.watch()` with 100ms debounce is already working. The only substantive work is connecting these existing components: add `WORKFLOWS_YAML` to `PD_FILES`, wire `WorkflowFunnelLoader.getAllFunnels()` into `RuntimeSummaryService.getSummary()`, and add lifecycle management (`watch()`/`dispose()`) in `evolution-status.ts`.

The architecture is minimal: two files change (`evolution-status.ts`, `RuntimeSummaryService`), one file stays unchanged but is the core deliverable (`WorkflowFunnelLoader`). Backward compatibility is preserved because `RuntimeSummaryService` falls back to hardcoded behavior when the `funnels` parameter is not provided. No new patterns, no new dependencies, no new event types.

The primary risks are operational: FSWatcher leaks from double-watch without guards, YAML parse warnings invisible to consumers, and cross-platform watcher behavior on Windows. All are preventable with targeted fixes before the watcher goes into production.

## Key Findings

### Recommended Stack

No new dependencies required. The stack is fully in place:

- **`js-yaml@^4.1.1`** — already in deps; safe `DEFAULT_SCHEMA` prevents code execution; industry standard
- **`fs.watch()`** — Node.js built-in; 100ms debounce already implemented; sufficient for single-file watch
- **`chokidar`** — not needed initially; add only if `fs.watch()` proves unreliable on Windows in testing
- **`workflows.yaml`** — lives at `.state/workflows.yaml` per workspace; path must be registered in `PD_FILES`

**Missing integration step:** `WORKFLOWS_YAML` path must be added to `src/core/paths.ts` in `PD_FILES`. This is the first code change required.

### Expected Features

This is a single-feature release. The entire deliverable is wiring the loader into the summary service.

**Must have (table stakes):**
- YAML-defined funnel stages visible in `/pd-evolution-status` output — core SSOT value proposition
- Hot-reload: editing `workflows.yaml` reflects in status without restart — already works via `fs.watch`
- Graceful degraded states — missing YAML yields empty funnel + warning; malformed YAML preserves last valid + warning

**Should have (differentiators):**
- YAML-driven stage-to-event mapping — replaces hardcoded event type matching in `RuntimeSummaryService`
- Warning propagation — YAML parse errors must surface in `RuntimeSummaryService.metadata.warnings` (currently only `console.warn`, invisible to consumers)

**Defer to v1.x:**
- `statsField` dot-path resolution (P3) — inferred counts from event type matching work adequately
- Per-workflowId event filtering (P2) — requires event data schema consistency across all event types

### Architecture Approach

Two files change, one is unchanged but is the product:

1. **`evolution-status.ts`** — instantiates `WorkflowFunnelLoader(stateDir)`, calls `watch()`, passes `getAllFunnels()` to `RuntimeSummaryService`, owns lifecycle (`dispose()` on plugin shutdown)
2. **`RuntimeSummaryService.getSummary()`** — gains optional `funnels?: Map<string, WorkflowStage[]>` parameter; falls back to hardcoded behavior when absent
3. **`WorkflowFunnelLoader`** — NO changes; fully implemented and correct

Build order is strictly linear: (1) add `WORKFLOWS_YAML` to `PD_FILES`, (2) update `RuntimeSummaryService` signature with fallback, (3) wire in `evolution-status.ts`.

### Critical Pitfalls

1. **FSWatcher leak on double-watch** — `watch()` has no guard against re-invocation; calling it twice leaks the first handle. Fix: add `if (this.watchHandle) return;` at top of `watch()`.
2. **Silent fallback — loader never integrated** — `WorkflowFunnelLoader` is inert without the wiring. The loader loads correctly but produces no visible output. This is the core deliverable, not a nice-to-have.
3. **YAML parse errors invisible to consumers** — `console.warn` inside the loader is invisible; `RuntimeSummaryService.metadata.warnings` has no mechanism to receive them. Need a callback or `getLastLoadWarnings()` method.
4. **100ms debounce too short for editor save patterns** — VS Code and others write files in multiple rapid sub-writes; 100ms may fire on incomplete file. Fix: validate `version` field before committing new config.
5. **Shared array references in `getAllFunnels()`** — returns `new Map(this.funnels)` but stage arrays are shared; consumer mutation corrupts loader state. Fix: deep-clone or freeze the arrays.

## Implications for Roadmap

### Phase 1: YAML Funnel Runtime Wiring

**Rationale:** This is the entire v1.21.1 release. All work is interconnected wiring of existing components. No phase splitting is meaningful.

**Delivers:**
- `WORKFLOWS_YAML` added to `PD_FILES` (`src/core/paths.ts`)
- `RuntimeSummaryService.getSummary()` accepts optional `funnels` parameter with fallback to hardcoded behavior
- `evolution-status.ts` instantiates loader, calls `watch()`, passes funnels to summary service
- `dispose()` wired into lifecycle hook (plugin shutdown / workspace switch)
- FSWatcher double-watch guard added (`if (this.watchHandle) return;`)
- YAML parse warnings propagated to `RuntimeSummaryService.metadata.warnings`
- `version` field validation before committing new config (editor save pattern fix)
- Deep-clone or freeze in `getAllFunnels()` to prevent shared reference mutation
- `rename` event handling added alongside `change` for Windows compatibility

**Avoids:** All 7 pitfalls from PITFALLS.md

**Research Flags:** None — all patterns are verified from existing implementation. No external research needed.

### Phase Ordering Rationale

- Single-phase because the entire deliverable is one wire-up task
- All 7 pitfalls map to Phase 1 and can be resolved in one implementation pass
- `WorkflowFunnelLoader` is already tested in isolation; integration tests cover the wiring

### Research Flags

Phases with standard patterns (skip research-phase):
- **Phase 1:** Well-documented existing implementation; all source is in-repo; no external research needed

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | `js-yaml@^4.1.1` verified in package.json; `fs.watch()` verified in loader implementation |
| Features | HIGH | Wiring-only; all features already implemented in existing components |
| Architecture | HIGH | Two-file change verified from source; backward compat contract documented |
| Pitfalls | MEDIUM-HIGH | Pitfalls derived from code inspection; some (Windows rename events, editor save patterns) need runtime validation |

**Overall confidence:** HIGH

### Gaps to Address

- **Windows `rename` event handling** — code inspection shows guard exists but has not been tested on Windows with VS Code atomic-save pattern; validate during implementation
- **Editor debounce adequacy** — 100ms debounce may be too short for multi-write editor saves; needs empirical testing with target editors before declaring watcher production-ready

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` — loader implementation (170 lines), FSWatcher, debounce, failure semantics
- `packages/openclaw-plugin/src/core/paths.ts` — `PD_FILES` constant; `workflows.yaml` path not yet registered
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — current summary service (810 lines), target integration point
- `packages/openclaw-plugin/src/commands/evolution-status.ts` — command entry point (211 lines), current wiring
- `packages/openclaw-plugin/package.json` — verified `js-yaml@^4.1.1` in deps

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/src/core/event-log.ts` — event types for stage aggregation
- `packages/openclaw-plugin/src/types/event-types.ts` — event type definitions

---

*Research completed: 2026-04-19*
*Ready for roadmap: yes*
