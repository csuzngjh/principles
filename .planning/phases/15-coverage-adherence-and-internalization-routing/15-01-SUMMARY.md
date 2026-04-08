---
phase: 15-coverage-adherence-and-internalization-routing
plan: 01
subsystem: core
tags: [typescript, vitest, replay, lifecycle, principle-tree]
requires:
  - phase: 13-replay-evaluation-and-manual-promotion-loop
    provides: replay reports and evaluation semantics for implementation evidence
  - phase: 14-nocturnal-ruleimplementationartifact-factory
    provides: candidate lineage and provenance for repeated-error evidence
provides:
  - deterministic lifecycle read-model across ledger, replay, and lineage data
  - replay-first rule coverage and false-positive calculators
  - structured deprecated-readiness assessment without status mutation
affects: [15-02 internalization routing, lifecycle reporting, operator decisions]
tech-stack:
  added: []
  patterns: [deterministic evidence read-model, locked ledger persistence, replay-first lifecycle metrics]
key-files:
  created:
    - packages/openclaw-plugin/src/core/principle-internalization/lifecycle-read-model.ts
    - packages/openclaw-plugin/src/core/principle-internalization/lifecycle-metrics.ts
    - packages/openclaw-plugin/src/core/principle-internalization/deprecated-readiness.ts
    - packages/openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts
    - packages/openclaw-plugin/tests/core/principle-internalization/lifecycle-metrics.test.ts
    - packages/openclaw-plugin/tests/core/principle-internalization/deprecated-readiness.test.ts
  modified:
    - packages/openclaw-plugin/src/core/principle-tree-ledger.ts
    - packages/openclaw-plugin/src/core/workspace-context.ts
key-decisions:
  - "Rule coverage stays replay-first and only uses coarse live penalties when durable lifecycle evidence exists."
  - "Deprecated readiness is recommendation-only and returns structured reasons instead of mutating Principle.status."
  - "Principle adherence is persisted through locked ledger helpers rather than direct file mutation."
patterns-established:
  - "Lifecycle read-model: aggregate ledger entities, latest replay reports, and candidate lineage before computing metrics."
  - "Lifecycle persistence: update rule/principle scalars through ledger helpers and value-metric writes."
requirements-completed: [COV-01, COV-02, COV-03, COV-04]
duration: 8min
completed: 2026-04-08
---

# Phase 15 Plan 01: Coverage, Adherence, and Internalization Routing Summary

**Deterministic lifecycle evidence aggregation with replay-first rule metrics, principle adherence persistence, and structured deprecated-readiness scoring**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-08T10:16:00+08:00
- **Completed:** 2026-04-08T10:23:53+08:00
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Added a lifecycle read-model that joins principle-tree ledger entities, replay reports, and nocturnal artifact lineage without mutating state.
- Added deterministic calculators for `Rule.coverageRate`, `Rule.falsePositiveRate`, and `Principle.adherenceRate`, then persisted them through ledger-safe helpers.
- Added structured deprecated-readiness scoring with supporting rule IDs and blocking reasons while keeping deprecation recommendation-only.

## Task Commits

1. **Task 1: Build lifecycle evidence read-model** - `c694e5c` (feat)
2. **Task 2: Compute rule coverage, false positives, and principle adherence** - `801cc7b` (feat)
3. **Task 3: Add deprecated readiness assessment** - `1bec956` (feat)

## Files Created/Modified
- `packages/openclaw-plugin/src/core/principle-internalization/lifecycle-read-model.ts` - Builds deterministic rule/principle lifecycle evidence from ledger, replay, and lineage sources.
- `packages/openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts` - Recomputes lifecycle metrics and persists them through ledger helpers.
- `packages/openclaw-plugin/src/core/principle-internalization/lifecycle-metrics.ts` - Computes replay-first rule coverage, false positives, and principle adherence.
- `packages/openclaw-plugin/src/core/principle-internalization/deprecated-readiness.ts` - Produces structured readiness status, score, reasons, and supporting rules.
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` - Adds locked `updatePrinciple` support for lifecycle metric persistence.
- `packages/openclaw-plugin/src/core/workspace-context.ts` - Exposes the safe principle update path through `WorkspaceContext`.
- `packages/openclaw-plugin/tests/core/principle-internalization/lifecycle-metrics.test.ts` - Covers sparse evidence, stable replay success, false positives, and rollback penalties.
- `packages/openclaw-plugin/tests/core/principle-internalization/deprecated-readiness.test.ts` - Covers ready, watch, and not-ready readiness outcomes.

## Decisions Made
- Used latest replay report per implementation as the durable replay input for lifecycle calculations so the read-model stays deterministic.
- Kept live evidence coarse and durable-only by looking at lifecycle state, disable/archive state, and rollback references rather than inventing richer telemetry.
- Persisted principle adherence back into both principle scalar fields and value metrics, but left deprecation as assessment-only for v1.9.0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added missing locked principle update helper**
- **Found during:** Task 1 (Build lifecycle evidence read-model)
- **Issue:** The current repo had ledger helpers for rules and value metrics, but no locked `updatePrinciple` path for persisting adherence back to principle records.
- **Fix:** Added `updatePrinciple` to the ledger and surfaced it through `WorkspaceContext` so lifecycle recomputation can persist principle metrics safely.
- **Files modified:** packages/openclaw-plugin/src/core/principle-tree-ledger.ts, packages/openclaw-plugin/src/core/workspace-context.ts
- **Verification:** `cd packages/openclaw-plugin && npx tsc --noEmit`
- **Committed in:** `c694e5c`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to satisfy the plan's persistence requirement. No scope creep beyond the lifecycle write path.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 15-02 can now consume deterministic lifecycle metrics instead of recomputing raw replay and lineage evidence ad hoc.
- Replay report semantics and nocturnal lineage behavior remained unchanged under the regression checks.

## Self-Check: PASSED

- Verified created/modified lifecycle files exist on disk.
- Verified task commits `c694e5c`, `801cc7b`, and `1bec956` exist in git history.

---
*Phase: 15-coverage-adherence-and-internalization-routing*
*Completed: 2026-04-08*
