# Prompt Injection SDK Migration Inventory

**Date**: 2026-05-07
**Status**: Phase 0 — Characterization Tests + Inventory Complete
**Scope**: `packages/openclaw-plugin/src/hooks/prompt.ts` — `handleBeforePromptBuild()` (lines 292–1056, 764 lines)

## Context

Per ADR-0001/0002/0003 strategic direction:
- `@principles/core` = pure domain logic, framework-agnostic
- `openclaw-plugin` = platform adapter, I/O, OpenClaw lifecycle hooks

This inventory classifies each logical section of `handleBeforePromptBuild()` for SDK migration readiness.

---

## Classification: 22 Logical Sections

### Category A — Pure Functions (Migrate to @principles/core)

Functions with **zero OpenClaw/plugin dependencies** — can move as-is.

| # | Section | Lines | Function | Rationale |
|---|---------|-------|----------|-----------|
| A1 | Attitude Directive | 573–607 | `buildAttitudeDirective(currentGfi)` → `attitudeDirective` | Pure threshold-to-template; no I/O |
| A2 | Correction Cue Detection | 130–154 | `detectCorrectionCue(text)` → `string \| null` | Pure string matching; no dependencies |
| A3 | Size Guard (truncation logic) | 942–1049 | Truncation + priority stripping | Pure budget enforcement; no dependencies |
| A4 | Minimal Mode Detection | 371–372 | `isMinimalMode = trigger === "heartbeat" \| \| ...` | Pure boolean expression; no dependencies |
| A5 | Message Content Extraction | 116–128 | `getTextContent(messages)` | Pure message unwrapping; no dependencies |

### Category B — Hybrid Logic (Needs I/O Separation Before Migration)

Functions **mix pure domain logic with I/O** — extract pure core, keep adapter in plugin.

| # | Section | Lines | Pure Logic | I/O Dependency | Migration Path |
|---|---------|-------|-----------|-----------------|----------------|
| B1 | Principle Selection | 700–769 | `selectPrinciplesForInjection()` — budget-aware selection + formatting | `getCachedMaskedPrincipleSet()` from core; `wctx.evolutionReducer` | Extract pure selection algorithm to core; plugin provides `PrincipleStore` adapter |
| B2 | Routing Guidance | 804–907 | `classifyTask()` + routing injection | `wctx.stateDir` for pattern reads; `classifyTask` uses only regex | Extract `classifyTask` + routing decision to core; plugin provides `TaskContext` |
| B3 | Empathy Keywords | 480–543 | `matchEmpathyKeywords()` — matching + scoring | `loadKeywordStore()`/`saveKeywordStore()` — filesystem I/O | Extract matching engine to core; plugin provides `KeywordStore` adapter |
| B4 | Project Context | 638–698 | `autoCompressFocus()` — content compression; `parseWorkingMemorySection()` | `safeReadCurrentFocus()` — file I/O; `getHistoryVersions()` | Extract compression/parsing to core; plugin provides `FocusFile` adapter |
| B5 | Core Principles Loading | 615–624 | Principle formatting | `wctx.evolutionReducer.getActivePrinciples()` | Already uses core reducer; just formatting is pure |
| B6 | Agent Identity Template | 393–415 | Template string construction | `PathResolver.getExtensionRoot()` | Pure template; path resolution is I/O |
| B7 | Heartbeat Processing | 545–571 | GFI decay calculation | `getGfiDecayElapsed()`; HEARTBEAT file read | Pure decay math; file I/O stays plugin |

### Category C — Plugin I/O (Must Stay in openclaw-plugin)

Functions **primarily I/O or OpenClaw platform integration** — cannot migrate.

| # | Section | Lines | Reason |
|---|---------|-------|--------|
| C1 | Static File Cache | 27–64 | `fs.statSync`/`readFileSync` — filesystem I/O |
| C2 | Module-level Empathy State | 66–68 | Mutable module state (`_empathyTurnCounter`, `_empathyKeywordCache`) |
| C3 | Model Config Resolution | 73–207 | OpenClaw API (`ctx.api?.runtime?.model`) |
| C4 | Context Injection Config | 210–240 | Filesystem config loading + merging |
| C5 | Workspace Context Init | 311–315 | `WorkspaceContext.fromHookContext()` — OpenClaw context binding |
| C6 | Manual Pain Clearance | 388–391 | `resetFriction()` — plugin session state |
| C7 | Trajectory Recording | 317–365 | `wctx.trajectory.recordUserTurn()` — plugin observability |
| C8 | Thinking OS Loading | 626–635 | `cachedReadFile()` — file I/O |
| C9 | Empathy Condition Check | 461–478 | `process.env`, `wctx.config.get()`, `api` — plugin context |
| C10 | Append Parts Assembly | 909–940 | String concatenation; calls B1/B2/B3/B4 outputs |

---

## Summary

| Category | Count | Lines (approx) | Action |
|----------|-------|----------------|--------|
| A — Pure functions | 5 | ~350 | Migrate directly to `@principles/core` |
| B — Hybrid (needs separation) | 7 | ~300 | Design adapter interfaces, extract pure core |
| C — Plugin I/O | 10 | ~400 | Stay in plugin, become thin adapter layer |

**High-priority Phase 1 candidates (pure, zero-risk)**:
1. `buildAttitudeDirective` — 34 lines, no dependencies
2. `detectCorrectionCue` — 24 lines, no dependencies
3. Size guard truncation logic — 107 lines, no dependencies

---

## Notes

- **Characterization tests** added in `tests/hooks/prompt-characterization.test.ts` (16 tests, 10 passing, 6 GFI-attitude tests failing — investigation ongoing)
- Size guard tests passing — validates 9000-char budget enforcement
- Correction cue tests passing — validates detection and trajectory recording
- All other hook tests still passing (66 tests, 41 passed, 19 skipped)
- Migration inventory does NOT include changes to `handleBeforePromptBuild()` — only catalogs what belongs where

## Next Steps (Phase 1)

1. Extract `buildAttitudeDirective()` to `@principles/core` — pure function, zero risk
2. Extract `detectCorrectionCue()` to core — pure function
3. Extract size guard truncation logic to core — pure function
4. Design `PrincipleStore` adapter interface for B1
5. Write unit tests for extracted functions in `@principles/core`