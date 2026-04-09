---
phase: 17-overview-page-data-fix
verified: 2026-04-09T00:00:00Z
status: gaps_found
score: 0/3 must-haves verified
gaps:
  - truth: "Overview page shows correct KPIs from /api/central/overview"
    status: failed
    reason: "Inline route assembly at lines 137-196 of principles-console-route.ts still has hardcoded zeros and empty arrays. CentralOverviewService was never created. Git history shows commits were made on branch fix/v1.9.1-issues-207-215 but main was reset to e5511b7a BEFORE those commits, discarding the work."
    artifacts:
      - path: "packages/openclaw-plugin/src/service/central-overview-service.ts"
        issue: "File does not exist - CentralOverviewService was never created"
      - path: "packages/openclaw-plugin/src/http/principles-console-route.ts"
        issue: "Lines 137-196 still contain inline IIFE assembly with hardcoded values: principleEventCount: 0, gateBlocks: 0, taskOutcomes: 0, sampleQueue.preview: [], dataFreshness using alphabetically first workspace"
  - truth: "HealthQueryService persists GFI state to database"
    status: failed
    reason: "HealthQueryService has no GFI persistence methods. No initGfiState(), readGfiState(), or writeGfiState() exist. Constructor does not call initGfiState(). ControlUiDatabase has no execute() or run() methods."
    artifacts:
      - path: "packages/openclaw-plugin/src/service/health-query-service.ts"
        issue: "No gfiState field, no initGfiState/readGfiState/writeGfiState methods. GFI is still in-memory only."
      - path: "packages/openclaw-plugin/src/core/control-ui-db.ts"
        issue: "No execute() or run() methods. Only has all() and get() methods."
  - truth: "ControlUiQueryService.getOverview() returns correct data shape"
    status: uncertain
    reason: "Cannot verify /api/overview endpoint behavior without running server. Code inspection shows no changes claimed in Plan 01 for this endpoint (D-09 stated no changes needed), but actual runtime behavior is unknown."
    artifacts:
      - path: "packages/openclaw-plugin/src/service/control-ui-query-service.ts"
        issue: "Unable to verify runtime behavior - needs human testing"
deferred: []
---

# Phase 17: Overview Page Data Fix Verification Report

**Phase Goal:** Fix `/api/central/overview` inline route assembly, `/api/overview` ControlUiQueryService, and `/api/overview/health` HealthQueryService
**Verified:** 2026-04-09
**Status:** gaps_found
**Score:** 0/3 must-haves verified

## Critical Finding

The SUMMARYs claim Phase 17 work is complete, but the **current codebase does not contain any of the promised changes**. Git reflog analysis reveals:

1. Phase 17 commits (`df95fb3b`, `2c563981`, `7e9ead54`, `15185c89`) were made on branch `fix/v1.9.1-issues-207-215`
2. Main branch was reset to `e5511b7a` which predates those commits
3. The commits were never merged to main

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Overview page shows correct KPIs from /api/central/overview | FAILED | Inline IIFE at lines 137-196 still has hardcoded zeros (principleEventCount:0, gateBlocks:0, taskOutcomes:0), empty preview array, and dataFreshness uses alphabetically first workspace. CentralOverviewService does not exist. |
| 2 | HealthQueryService persists GFI state to database | FAILED | HealthQueryService has no gfiState field, no persistence methods. ControlUiDatabase has no execute()/run() methods. |
| 3 | ControlUiQueryService.getOverview() returns correct data shape | UNCERTAIN | D-09 in 17-CONTEXT.md states no changes needed. Cannot verify runtime behavior without running server. |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|------------|-------------|--------|----------|
| OVER-01 | Fix /api/central/overview inline route assembly | BLOCKED | Inline assembly still present with hardcoded zeros; CentralOverviewService not created |
| OVER-02 | Fix /api/overview ControlUiQueryService | UNCERTAIN | No changes claimed; runtime behavior unknown |
| OVER-03 | Fix /api/overview/health HealthQueryService | BLOCKED | No GFI persistence; ControlUiDatabase lacks execute()/run() |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/service/central-overview-service.ts` | CentralOverviewService class | MISSING | File does not exist |
| `src/http/principles-console-route.ts` | Uses CentralOverviewService | STUB | Still has inline 60-line IIFE assembly at lines 137-196 |
| `src/service/health-query-service.ts` | GFI persistence methods | STUB | No initGfiState/readGfiState/writeGfiState methods |
| `src/core/control-ui-db.ts` | execute() and run() methods | STUB | Only has all() and get() |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| Route handler | CentralOverviewService | Not wired | NOT_WIRED | Service does not exist |
| HealthQueryService | trajectory.db | writeGfiState() | NOT_WIRED | Method does not exist |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| /api/central/overview | taskOutcomes | Hardcoded 0 | No | DISCONNECTED |
| /api/central/overview | sampleQueue.preview | Hardcoded [] | No | DISCONNECTED |
| /api/central/overview | dataFreshness | workspaces[0] (alphabetical) | No | STATIC |

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| principles-console-route.ts | 166-168 | Hardcoded zeros for taskOutcomes, gateBlocks, principleEventCount | Blocker | Overview page shows incorrect/fake data |
| principles-console-route.ts | 178 | Hardcoded empty array for sampleQueue.preview | Blocker | Sample preview never shows real data |
| principles-console-route.ts | 150 | dataFreshness uses workspaces[0] (alphabetical first) | Blocker | Shows wrong workspace's sync time |

## Human Verification Required

### 1. /api/overview endpoint runtime test

**Test:** Start the plugin and call `GET /api/overview`
**Expected:** Returns correct OverviewResponse with real data from ControlUiQueryService
**Why human:** Cannot verify runtime behavior without running the OpenClaw plugin server

### 2. /api/overview/health endpoint runtime test

**Test:** Start the plugin and call `GET /api/overview/health`
**Expected:** Returns correct health metrics including GFI (current and peakToday)
**Why human:** Cannot verify runtime behavior without running the OpenClaw plugin server

## Gaps Summary

**Three critical gaps prevent Phase 17 goal achievement:**

1. **CentralOverviewService was never created** - The SUMMARYs claim this service was extracted from inline assembly, but the file does not exist in the codebase. Git history shows the commits were made on a feature branch that was never merged to main.

2. **Inline route assembly still has hardcoded fake data** - `/api/central/overview` still returns zeros for taskOutcomes, gateBlocks, principleEventCount and empty arrays for sampleQueue.preview. The dataFreshness field still uses alphabetically first workspace instead of most recently synced.

3. **GFI persistence was never implemented** - HealthQueryService has no persistence methods. ControlUiDatabase lacks execute()/run() methods. GFI state is still in-memory only and resets on service restart.

**Root Cause:** The work was committed to a feature branch (`fix/v1.9.1-issues-207-215`) but that branch was not merged. Main was reset to a prior commit (`e5511b7a`), discarding the Phase 17 work.

---

_Verified: 2026-04-09_
_Verifier: Claude (gsd-verifier)_
