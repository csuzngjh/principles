---
phase: 03-manual-remediation
plan: "02"
subsystem: workflow-funnel
tags: [yaml, workflow-funnel, runtime-summary, openclaw-plugin]

# Dependency graph
requires:
  - phase: "03-01"
    provides: WorkflowFunnelLoader with re-entry guard, deep-clone, WORKFLOWS_YAML path in PD_FILES
provides:
  - RuntimeSummaryService accepts optional funnels Map parameter
  - evolution-status.ts owns WorkflowFunnelLoader lifecycle (D-12)
  - loader.watch() guarded against ENOENT for missing workflows.yaml
affects:
  - Workflow Funnel Runtime Integration
  - evolution-status command

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "D-12 loader lifecycle: command handler creates loader, calls watch(), re-entry guard prevents double-watch"

key-files:
  modified:
    - packages/openclaw-plugin/src/service/runtime-summary-service.ts
    - packages/openclaw-plugin/src/commands/evolution-status.ts
    - packages/openclaw-plugin/src/core/workflow-funnel-loader.ts

key-decisions:
  - "Optional funnels parameter preserves backward compat: when omitted, RuntimeSummaryService uses built-in default behavior"
  - "loader.watch() guarded against missing workflows.yaml to avoid ENOENT crash in test/fresh-workspace contexts"

patterns-established:
  - "Command-scoped loader lifecycle: WorkflowFunnelLoader instantiated per handleEvolutionStatusCommand call, re-entry guard handles concurrent safety"

requirements-completed:
  - YAML-FUNNEL-01
  - YAML-FUNNEL-02
  - YAML-FUNNEL-04

# Metrics
duration: 4min
completed: 2026-04-19
---

# Phase 03, Plan 02: Workflow Funnel Runtime Integration Summary

**RuntimeSummaryService.getSummary() now accepts optional funnels Map from WorkflowFunnelLoader; evolution-status.ts owns the loader lifecycle per D-12**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-19T10:09:00Z
- **Completed:** 2026-04-19T10:13:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- RuntimeSummaryService.getSummary() signature extended with optional `funnels?: Map<string, WorkflowStage[]>` parameter
- WorkflowFunnelLoader wired into evolution-status.ts command handler; loader lifecycle owned per D-12
- loader.watch() ENOENT guard added to prevent crash when workflows.yaml is absent (test/fresh-workspace safety)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add optional funnels parameter to RuntimeSummaryService.getSummary()** - `c0054346` (feat)
2. **Task 2: Wire WorkflowFunnelLoader into evolution-status.ts** - `c54e1ed4` (feat)
   - Fix: `c20b192c` (fix) - remove unused WORKFLOWS_YAML import
   - Fix: `9221b4f8` (fix) - guard WorkflowFunnelLoader.watch() against ENOENT

## Files Created/Modified

- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` - Added WorkflowStage import and optional funnels parameter to getSummary()
- `packages/openclaw-plugin/src/commands/evolution-status.ts` - Imported WorkflowFunnelLoader, resolvePdPath; instantiated loader, called getAllFunnels() and watch(); passed funnels to getSummary()
- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` - Added `fs.existsSync()` guard in watch() before calling fs.watch()

## Decisions Made
- **Backward compatibility:** When `funnels` is not passed to `getSummary()`, the service continues using built-in default behavior — no breaking change to existing callers
- **ENOENT guard:** WorkflowFunnelLoader.watch() now checks `fs.existsSync(configPath)` before calling `fs.watch()`, preventing crashes in test temp workspaces or fresh workspaces that have never bootstrapped `workflows.yaml`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] WorkflowFunnelLoader.watch() crashes with ENOENT when workflows.yaml absent**
- **Found during:** Task 2 (evolution-status test suite)
- **Issue:** fs.watch() throws ENOENT when the watched path does not exist — test temp workspaces have no .state/workflows.yaml
- **Fix:** Added `if (!fs.existsSync(this.configPath)) return;` guard at top of watch() method
- **Files modified:** `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts`
- **Verification:** All 40 tests in affected suites pass
- **Committed in:** `9221b4f8`

---

**Total deviations:** 1 auto-fixed (Rule 1 bug)
**Impact on plan:** Bug fix was necessary for correctness in test and fresh-workspace scenarios. No scope creep.

## Issues Encountered
- `WORKFLOWS_YAML` imported in evolution-status.ts but never used at runtime — removed via lint warning fix (`c20b192c`)
- ENOENT crash when `workflows.yaml` absent in test environment — fixed with existsSync guard (`9221b4f8`)

## Next Phase Readiness
- Task 3 (RuntimeSummaryService actual funnel consumption) is queued — this plan completes the wiring; actual funnel-driven stats field lookup is the next step
- All YAML-FUNNEL requirements for this wave satisfied

---
*Phase: 03-manual-remediation / 03-02*
*Completed: 2026-04-19*
