---
phase: 21-runtime-contract-and-end-to-end-hardening
status: passed
verified: 2026-04-11
---

# Phase 21 Verification: Runtime Contract and End-to-End Hardening

## Phase Goal

Background runtime checks and the nocturnal main path are backed by explicit contracts and pipeline-level tests.

## Goal-Backward Analysis

### Observable Truths

1. Runtime capability detection does not rely on `constructor.name === 'AsyncFunction'`.
2. Runtime-unavailable and downstream-workflow-failed produce different observable states.
3. Manual trigger paths use the same runtime/workspace contract semantics as the worker path.
4. A valid pain signal preserves `session_id` from write to queue to nocturnal input.
5. Hook/command writes stay under the active workspace `.state`.
6. Candidate session selection is bounded to the triggering pain/task timestamp (no future-session drift).

### Evidence

| Truth | Evidence | Source |
|-------|----------|--------|
| T1 | `rg "constructor\.name === 'AsyncFunction'" packages/openclaw-plugin/src` returns no source matches; explicit callable-shape checks used instead | 21-VALIDATION.md: Execution Evidence |
| T2 | `runtime_unavailable` state separated from generic downstream failures in sleep-reflection task resolution | 21-VALIDATION.md: Outcome Summary |
| T3 | Shared workspace/manual-trigger tests passing — `pd-reflect`, workspace-dir service, workspace-dir integration | 21-VALIDATION.md: Outcome Summary |
| T4 | Preserved `session_id` flow from `.pain_flag` into sleep-reflection context and nocturnal snapshot selection | 21-VALIDATION.md: Outcome Summary |
| T5 | Workspace-dir unit/integration coverage and manual trigger tests passing | 21-VALIDATION.md: Outcome Summary |
| T6 | Fallback nocturnal session selection bounded to triggering task timestamp | 21-VALIDATION.md: Outcome Summary |
| Tests | 9 test files, 61 tests passing | 21-VALIDATION.md: Execution Evidence |
| Build | `npx tsc --noEmit` passes | 21-VALIDATION.md: Execution Evidence |

### Gaps

None — all truths are backed by execution evidence.

## Requirement Traceability

| REQ-ID | Description | Verification Method | Status |
|--------|------------|---------------------|--------|
| RT-01 | No `constructor.name` capability checks | Grep for `constructor.name === 'AsyncFunction'` returns zero source matches; explicit callable-shape tests | satisfied |
| RT-02 | Runtime-unavailable vs downstream failure distinction | Unit tests for `runtime_unavailable` state vs generic failures | satisfied |
| RT-03 | Manual triggers use shared contracts | Unit/integration tests for `pd-reflect`, workspace-dir service, workspace-dir integration | satisfied |
| E2E-01 | Pain signal `session_id` preserved end-to-end | Integration tests for `.pain_flag` → queue → nocturnal context flow | satisfied |
| E2E-02 | Writes stay under active workspace | Workspace-dir unit/integration tests; hook/command tests | satisfied |
| E2E-03 | Time-bounded session selection | Unit tests for bounded nocturnal session selection | satisfied |
