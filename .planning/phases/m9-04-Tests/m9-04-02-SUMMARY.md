---
phase: m9-04
plan: 02
status: complete
completed: 2026-04-29
---

## m9-04-02: Full Chain E2E Test

**What was built:**
`packages/principles-core/src/runtime-v2/runner/__tests__/m9-e2e.test.ts` (199 lines)

Full chain E2E proving PainSignalBridge + PiAiRuntimeAdapter + CandidateIntakeService + InMemoryLedgerAdapter chain:
- Pain → task → run → DiagnosticianOutputV1 artifact → candidates → ledger probation entry
- Idempotency: same painId twice produces no duplicate candidates/ledger entries

**Tests (3 total across 2 files):**
- `m9-adapter-integration.test.ts`: 1 test — PiAiRuntimeAdapter + DiagnosticianRunner integration
- `m9-e2e.test.ts`: 2 tests — full chain + idempotency

**Key design decisions:**
- Used `sqliteConn.getDb().prepare()` for direct SQL queries
- Used snake_case column names (`artifact_id`, `artifact_kind`, `candidate_id`) matching DB schema
- InMemoryLedgerAdapter from m8-02-e2e pattern
- Module-level `vi.mock('@mariozechner/pi-ai')` — real adapter code runs

**Commits:**
- `feat(m9-04): add m9-e2e.test.ts — PainSignalBridge + PiAiRuntimeAdapter full chain E2E`
