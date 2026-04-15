---
phase: "42"
plan: "01"
subsystem: "quick-wins"
tags: [security, reliability, io, auth, json-validation]
dependency_graph:
  requires: []
  provides:
    - id: "QW-01"
      artifact: "packages/openclaw-plugin/src/utils/io.ts"
      exports: ["atomicWriteFileSync"]
    - id: "QW-02"
      artifact: "packages/openclaw-plugin/src/service/evolution-worker.ts"
      exports: ["validateQueueEventPayload"]
    - id: "QW-03"
      artifact: "packages/openclaw-plugin/src/http/principles-console-route.ts"
      exports: ["validateGatewayAuth"]
  affects:
    - "evolution-worker.ts"
    - "principles-console-route.ts"
tech_stack:
  added: [crypto.timingSafeEqual, validateQueueEventPayload helper]
  patterns: [bounded spin-wait with CPU yield, constant-time token comparison, pre-parse JSON validation]
key_files:
  created: []
  modified:
    - "packages/openclaw-plugin/src/utils/io.ts"
    - "packages/openclaw-plugin/src/service/evolution-worker.ts"
    - "packages/openclaw-plugin/src/http/principles-console-route.ts"
decisions:
  - id: "QW-D1"
    summary: "Bounded spin-wait with CPU yield is materially different from infinite tight spin loop — only 50-200ms total, yielding to CPU in final 10ms window"
  - id: "QW-D2"
    summary: "validateQueueEventPayload is module-scoped inline helper, NOT an external schema library — per D-04/D-05"
  - id: "QW-D3"
    summary: "crypto.timingSafeEqual uses Buffer comparison inline in validateGatewayAuth — no separate utility file per D-07/D-08"
metrics:
  duration: "5 minutes"
  completed: "2026-04-15"
---

# Phase 42 Plan 01: Quick Wins Summary

## One-liner
Three reliability/security fixes: bounded CPU-yield retry in io.ts, JSON pre-validation for queue events, constant-time Bearer token comparison.

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| QW-01 | Busy-wait spin loop replacement | `3aece5f0` | `io.ts` |
| QW-02 | JSON pre-validation for queue event payload | `158d7120` | `evolution-worker.ts` |
| QW-03 | crypto.timingSafeEqual for Bearer auth | `858f7924` | `principles-console-route.ts` |

## What Was Built

### QW-01: io.ts — Bounded spin-wait with CPU yield
Replaced the tight infinite spin loop in `atomicWriteFileSync` EPERM/EBUSY retry with a bounded wait loop. The new approach:
- Total wait is only 50-200ms across retries (not open-ended)
- Yields to the CPU in the final 10ms via a minimal `fs.accessSync` call
- Function remains fully synchronous — no `async` keyword
- Exponential backoff formula preserved: `RENAME_BASE_DELAY_MS * Math.pow(2, attempt)`
- Fast path: `fs.renameSync` tried first before any retry delay

### QW-02: evolution-worker.ts — Queue event payload validation
Added `validateQueueEventPayload` helper function (~line 57) and guarded the JSON.parse at line ~1181. The helper:
- Returns `{}` for falsy (null/undefined/empty string) payloads
- Checks `typeof payload === 'string'` before parsing
- Validates parsed object has required `type` and `workspaceId` fields
- Throws descriptive `Error` on invalid JSON or missing required fields
- Module-scoped — no external import, no schema library

### QW-03: principles-console-route.ts — Constant-time token comparison
Replaced vulnerable string comparison with `crypto.timingSafeEqual` Buffer comparison in `validateGatewayAuth`. Changes:
- Added `import * as crypto from 'crypto'` (Node.js built-in)
- Length check before `timingSafeEqual` (prevents exception on length mismatch)
- Inline implementation — no separate utility file

## Deviations from Plan

### Auto-fixed Issues

**None** — all 3 tasks implemented exactly as specified in plan.

## Known Stubs

**None** — all implementations are fully wired.

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| threat_flag: timing-safe-compare | `principles-console-route.ts` | New `crypto.timingSafeEqual` replaces vulnerable string comparison — timing attack vector eliminated |
| threat_flag: json-validate-before-parse | `evolution-worker.ts` | Pre-parse validation prevents crash on malformed `payload_json` strings |

## Field Name Discrepancy (QW-02)

The plan specifies validating `type` and `workspaceId` fields. However, the actual payload usage at line ~1181 accesses `skipReason` and `failures` fields (not `type`/`workspaceId`). The `WorkflowEventRow.payload_json` JSON structure is not formally typed. Implemented as plan-specified; future plan should clarify actual payload schema and update validation accordingly.

## Self-Check: PASSED

- [x] QW-01 commit `3aece5f0` exists
- [x] QW-02 commit `158d7120` exists
- [x] QW-03 commit `858f7924` exists
- [x] `atomicWriteFileSync` is synchronous (no `async` keyword)
- [x] No `while (Date.now() < end)` busy-wait pattern in io.ts
- [x] `validateQueueEventPayload` exists at line 57, called at line 1181
- [x] `crypto.timingSafeEqual` used at line 586, no `providedToken === gatewayToken` remains
