---
phase: m9-04
plan: 01
status: complete
completed: 2026-04-29
---

## m9-04-01: Adapter Integration Test

**What was built:**
`packages/principles-core/src/runtime-v2/runner/__tests__/m9-adapter-integration.test.ts` (194 lines)

E2E integration test proving PiAiRuntimeAdapter + DiagnosticianRunner are wired correctly:
- Creates task directly via stateManager (no PainSignalBridge)
- Mocks `@mariozechner/pi-ai` via module-level `vi.mock` — real adapter code runs, only LLM API intercepted
- Verifies full chain: task → run → DiagnosticianOutputV1 artifact → >= 2 candidate records

**Test result:** `✓ PASSED` — artifact with `artifact_kind='diagnostician_output'` written, >= 2 candidates created

**Key design decisions:**
- Used `sqliteConn.getDb().prepare()` (not `sqliteConn.prepare()`) for direct SQL queries
- Used snake_case column names (`artifact_id`, `artifact_kind`) matching DB schema
- `createRunner()` pattern from m6-06-e2e with `pollIntervalMs: 50`, `timeoutMs: 5000`
- `makeDiagnosticianOutputWithCandidates()` fixture from m6-06-e2e with `diag-m9-adapter` prefix

**Deviations from plan:**
- None significant — plan followed exactly

**Commits:**
- `feat(m9-04): add m9-adapter-integration.test.ts — PiAiRuntimeAdapter + DiagnosticianRunner E2E`
