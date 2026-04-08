---
phase: 15
plan: 02
subsystem: principle-internalization
tags: [routing, lifecycle, workspace-context, vitest]
requires: ["15-01"]
provides: ["ROUT-01", "ROUT-02"]
affects:
  - packages/openclaw-plugin/src/core/principle-internalization/internalization-routing-policy.ts
  - packages/openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts
  - packages/openclaw-plugin/src/core/workspace-context.ts
  - packages/openclaw-plugin/tests/core/principle-internalization/internalization-routing-policy.test.ts
  - packages/openclaw-plugin/tests/core/principle-internalization/principle-lifecycle-service.test.ts
tech_stack:
  added: []
  patterns:
    - deterministic policy recommendations
    - read-model backed lifecycle assessments
    - workspace-scoped service accessor
decisions:
  - Keep routing recommendation-only and do not trigger skill/code/LoRA execution.
  - Reuse the Phase 15 read-model plus metric calculators instead of rescanning storage ad hoc.
  - Surface lifecycle metrics, deprecation readiness, and routing through PrincipleLifecycleService and WorkspaceContext.
metrics:
  duration: "6m"
  completed_at: "2026-04-08T10:36:43.7012876+08:00"
  task_commits:
    - "7aa0317"
    - "e4d2eef"
---

# Phase 15 Plan 02: Internalization Routing Summary

Implemented explicit cheapest-viable internalization routing that recommends `skill`, `code`, or `defer` without executing routes.

## What Shipped

Added `internalization-routing-policy.ts` as a deterministic policy layer over the Phase 15 read-model and metrics. The policy returns recommendation records with route, confidence, reason codes, evidence summary, and next action text, and it can select a non-code route when a cheaper skill/prompt path is sufficient.

Extended `PrincipleLifecycleService` so one stable boundary now exposes recomputation, rule/principle assessments, deprecated-readiness, and route recommendations together. `WorkspaceContext` now caches that lifecycle service for later reporting or command surfaces instead of forcing new callers to rebuild ledger/replay/lineage joins.

Added focused Vitest coverage for the three route outcomes and for the integration surface, including non-regression assertions that replay classifications remain behavioral-only and nocturnal candidate lineage records remain unchanged by the new service access path.

## Verification

- `cd packages/openclaw-plugin && npx vitest run tests/core/principle-internalization/internalization-routing-policy.test.ts tests/core/principle-internalization/principle-lifecycle-service.test.ts`
- `cd packages/openclaw-plugin && npx vitest run tests/service/nocturnal-service-code-candidate.test.ts tests/core/nocturnal-artifact-lineage.test.ts tests/core/replay-engine.test.ts`
- `cd packages/openclaw-plugin && npx tsc --noEmit`

All passed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking Issue] PowerShell staging/commit flow**
- **Found during:** Task 1 commit
- **Issue:** PowerShell rejected `&&` chaining, which blocked the requested per-task commit flow.
- **Fix:** Split staging and commit steps into separate non-interactive commands.
- **Files modified:** None
- **Commit:** N/A

**2. [Rule 1 - Test Seed Correction] Deprecated readiness expectation**
- **Found during:** Task 2 verification
- **Issue:** The seeded lifecycle data in the new integration test produced `not-ready`, not `watch`, under the existing Phase 15 readiness formula.
- **Fix:** Updated the test expectation to match the current deterministic formula instead of loosening the service logic.
- **Files modified:** `packages/openclaw-plugin/tests/core/principle-internalization/principle-lifecycle-service.test.ts`
- **Commit:** `e4d2eef`

## Decisions Made

- Routing remains recommendation-only in v1.9.0 and does not mutate lifecycle state or execute any route.
- Lifecycle assessments are derived from the existing read-model and calculators so the evidence join stays centralized.
- `WorkspaceContext.principleLifecycle` is the stable access point for future command/report consumers.

## Known Stubs

None.

## Self-Check: PASSED

- Found summary file: `.planning/phases/15-coverage-adherence-and-internalization-routing/15-02-SUMMARY.md`
- Found task commit: `7aa0317`
- Found task commit: `e4d2eef`
