---
---

Tests only: `pain-recall-service.test.ts` stops materializing the production state.db schema (and the trajectory table) once per test. Each test used to spend ~56ms of its ~65ms on throwaway SQLite DDL + fsync, so vitest's 5s per-test budget was measuring temp-disk behaviour rather than the read model — that is the exposure that turned a CI disk stall into `Test timed out in 5000ms` (run 43220422519 / job 131190367614). The schemas are now built once per run and copied per fixture.

No release intent: no runtime, type-declaration, or fixture-semantics change.
