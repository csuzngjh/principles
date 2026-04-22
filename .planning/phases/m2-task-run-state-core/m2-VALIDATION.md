---
phase: m2
slug: task-run-state-core
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-22
---

# Phase M2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (via `npx vitest`) |
| **Config file** | `packages/principles-core/vitest.config.ts` (inherited from root `vitest.config.ts`) |
| **Quick run command** | `cd packages/principles-core && npx vitest run --reporter=verbose` |
| **Full suite command** | `cd packages/principles-core && npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~30 seconds (5 test files, ~50 tests) |

---

## Sampling Rate

- **After every task commit:** `cd packages/principles-core && npx vitest run` (fast enough for per-task)
- **After every plan wave:** Full suite + `npx tsc --noEmit`
- **Before `/gsd-verify-work`:** Full suite must be green + TypeScript clean
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| m2-01-01 | 01 | 1 | REQ-M2-TaskStore | T-m2-01 / T-m2-02 | Parameterized SQL, Value.Check() on read | unit | `vitest run store/sqlite-connection` | ❌ W0 | ⬜ pending |
| m2-01-02 | 01 | 1 | REQ-M2-TaskStore | T-m2-03 | Atomic transaction for lease | unit | `vitest run store/task-store` | ❌ W0 | ⬜ pending |
| m2-01-03 | 01 | 1 | REQ-M2-TaskStore | — | No M1 drift | typecheck | `npx tsc --noEmit` | ✅ | ⬜ pending |
| m2-02-01 | 02 | 2 | REQ-M2-RunStore | T-m2-01 / T-m2-02 | Parameterized SQL, Value.Check() on read | unit | `vitest run store/run-store` | ❌ W0 | ⬜ pending |
| m2-02-02 | 02 | 2 | REQ-M2-RunStore | T-m2-03 | Atomic transaction for lease | unit | `vitest run store/sqlite-run-store` | ❌ W0 | ⬜ pending |
| m2-03-01 | 03 | 3 | REQ-M2-Lease | T-m2-03 | db.transaction() for atomicity | unit | `vitest run store/lease-manager` | ❌ W0 | ⬜ pending |
| m2-03-02 | 03 | 3 | REQ-M2-Retry | — | Exponential backoff bounded | unit | `vitest run store/retry-policy` | ❌ W0 | ⬜ pending |
| m2-04-01 | 04 | 4 | REQ-M2-Recovery | T-m2-04 | Idempotent UPDATE, telemetry emission | unit | `vitest run store/recovery-sweep` | ❌ W0 | ⬜ pending |
| m2-04-02 | 04 | 4 | REQ-M2-Recovery | — | No M1 drift, all exports added | typecheck | `npx tsc --noEmit` | ✅ | ⬜ pending |
| m2-05-01 | 05 | 5 | REQ-M2-Tests | — | Test infrastructure | unit | `vitest run store/task-store` | ❌ W0 | ⬜ pending |
| m2-05-02 | 05 | 5 | REQ-M2-Tests | — | Concurrent lease test | unit | `vitest run store/lease-manager` | ❌ W0 | ⬜ pending |
| m2-05-03 | 05 | 5 | REQ-M2-Tests | — | Idempotent recovery test | unit | `vitest run store/recovery-sweep` | ❌ W0 | ⬜ pending |
| m2-05-04 | 05 | 5 | REQ-M2-Tests | — | Schema conformance test | unit | `vitest run store/sqlite-task-store` | ❌ W0 | ⬜ pending |
| m2-05-05 | 05 | 5 | REQ-M2-Tests | — | Full suite integration | integration | `vitest run` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/principles-core/src/runtime-v2/store/sqlite-connection.test.ts` — SqliteConnection init, WAL, schema
- [ ] `packages/principles-core/src/runtime-v2/store/task-store.test.ts` — TaskStore interface contract
- [ ] `packages/principles-core/src/runtime-v2/store/sqlite-task-store.test.ts` — SqliteTaskStore CRUD + row mapping
- [ ] `packages/principles-core/src/runtime-v2/store/run-store.test.ts` — RunStore interface contract
- [ ] `packages/principles-core/src/runtime-v2/store/sqlite-run-store.test.ts` — SqliteRunStore CRUD + row mapping
- [ ] `packages/principles-core/src/runtime-v2/store/lease-manager.test.ts` — Lease acquire/release/expire
- [ ] `packages/principles-core/src/runtime-v2/store/retry-policy.test.ts` — Backoff + shouldRetry
- [ ] `packages/principles-core/src/runtime-v2/store/recovery-sweep.test.ts` — Detect + recover idempotency
- [ ] `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` — W0 stub: imports better-sqlite3, creates .pd/ dir

*Wave 0 creates test infrastructure stubs. Implementation in Plans 01-04.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Concurrent lease from multiple processes | REQ-M2-Lease | Requires multi-process spawn | Open 2 terminal tabs, run concurrent lease acquisition, verify only 1 wins |
| WAL checkpoint on Windows | REQ-M2-TaskStore | Platform-specific behavior | Close DB cleanly, verify -wal and -shm files are removed |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
