# Phase 45: Queue Tests - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 45-Queue-Tests
**Areas discussed:** Test fixture + isolation strategy, Timer + concurrency approach, Snapshot format

---

## Area 1: Test Fixture + Isolation Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| tests/fixtures/legacy-queue-v1.json | Dedicated JSON file in tests/fixtures/ — matches existing production-mock-generator.ts pattern | ✓ |
| Inline factory function | Factory function in test file — self-contained, no extra file | |
| Programmatic generator | TypeScript generator in tests/fixtures/ — most flexible | |

**User's choice:** tests/fixtures/legacy-queue-v1.json

## Area 2: Timer + Concurrency Approach

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated tests/queue/async-lock.test.ts | New dedicated test file — clear ownership, matches project structure | ✓ |
| Extend tests/utils/file-lock.test.ts | Add to existing file-lock.test.ts — mixes concerns | |
| tests/service/evolution-worker.queue.test.ts | All queue tests together | |

**User's choice:** Dedicated tests/queue/async-lock.test.ts

## Area 3: Snapshot Format

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit assertions with input/expected pairs | Matches all existing tests in codebase, no snapshot files | ✓ |
| Vitest inline snapshots | toMatchInlineSnapshot — compact but requires test run to generate | |
| Separate .snap files | Dedicated snapshot files in tests/snapshots/ | |

**User's choice:** Explicit assertions with input/expected pairs

## Claude's Discretion

All decisions made by user — no areas deferred to Claude discretion.

## Deferred Ideas

None
