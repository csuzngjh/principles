---
phase: m8-01
reviewers: [claude (self-review)]
reviewed_at: 2026-04-27T00:00:00.000Z
plans_reviewed: [m8-01-01-PLAN.md, m8-01-02-PLAN.md, m8-01-03-PLAN.md, m8-01-04-PLAN.md, m8-01-05-PLAN.md]
cli_status:
  gemini: unavailable (MODULE_NOT_FOUND — npm package installed but module file missing)
  codex: unavailable (MODULE_NOT_FOUND — npm package installed but module file missing)
  opencode: unavailable (MODULE_NOT_FOUND — npm package installed but module file missing)
---

# Cross-AI Plan Review — Phase m8-01

> **Note:** External CLIs (gemini, codex, opencode) were detected as available via `command -v` but failed to execute due to missing module files. This review is a structured self-review by the primary reviewer.

---

## Claude Review (Self-Review)

### Summary

All 5 plans for m8-01 (Legacy Code Map + Single Path Cutover) are well-structured and architecturally sound. The wave-based dependency ordering (wave 1: deletion/refactor → wave 2: bridge → wave 3: E2E) is correct. Plan 04 contains the most complex logic and has the highest risk — the event-based wiring approach is sound but relies on correct subscription ordering at plugin initialization. The self-contained `BridgePainSignalInput` type correctly avoids cross-package coupling. The runner-manages-own-run-lifecycle constraint (BRIDGE-02) is clearly documented and architecturally enforced. The main gap is a lack of explicit error handling for the SQLite query fallback in Plan 03 and no mention of transaction semantics for the multi-step bridge flow.

---

## Strengths

**Plan 01 (Delete diagnostician-task-store.ts):**
- Correctly verifies no remaining imports before deletion
- Checks both source imports and compiled output
- Clear dependency assumption (imports removed in Plans 02/03)

**Plan 02 (Remove legacy diagnostician blocks):**
- CRITICAL preservation reminders are prominent and correct
- Uses specific line ranges and code snippets for precise deletion
- Separate task per file (prompt.ts vs evolution-worker.ts)

**Plan 03 (runtime-summary-service.ts + event-types.ts):**
- SQLite query fallback to -1 (unknown) is pragmatic and safe
- Deprecating heartbeat_diagnosis while adding runtime_diagnosis maintains backwards compatibility for historical events
- Legacy metrics set to 0 is honest — they truly don't apply anymore

**Plan 04 (PainSignalBridge):**
- Self-contained `BridgePainSignalInput` — no openclaw-plugin import, correct architectural decision
- Runner-manages-own-run-lifecycle constraint prominently documented with rationale
- Real UUID candidateId via `getCandidatesByTaskId()` — correct over synthetic
- Event-based wiring (evolutionReducer subscription) — pain.ts NOT modified, correct decoupling
- Fire-and-forget with error logging — non-blocking, doesn't disrupt pain detection
- autoIntakeEnabled=true default — correct for HG-2 happy path

**Plan 05 (E2E + ROADMAP):**
- Real workspace D:\.openclaw\workspace as E2E target — correct (HG-5)
- Complete chain verification with exact SQL queries — actionable
- Human verify checkpoint with blocking gate — appropriate for sign-off

---

## Concerns

### HIGH

**Plan 04, Task 2 — Subscription ordering risk (CRITICAL):**
- `wctx.evolutionReducer.on('pain_detected', ...)` is registered during plugin initialization
- If evolutionReducer emits 'pain_detected' BEFORE the subscription is registered (e.g., pain signal fires during plugin startup), the event is missed
- **Fix needed:** Document the initialization order constraint: PainSignalBridge subscription must be registered BEFORE any code path that could emit 'pain_detected'
- Alternatively: use `emitSync` which is synchronous, but the subscription still needs to exist first

**Plan 04, Task 1 — No transaction semantics for multi-step flow:**
- `processPainSignal` does: createTask → run() → getCandidatesByTaskId() → intake() for each candidate
- If runner.run() succeeds but intake() fails for some candidates, partial intake occurs
- No rollback mechanism — if candidate 1 succeeds and candidate 2 fails, candidate 1's ledger entry stays
- **Assessment:** This is acceptable for M8 because intake is idempotent (probation entries are unique by candidateId+principle_hash). But should be documented.

### MEDIUM

**Plan 03, Task 1 — better-sqlite3 dependency:**
- Uses `await import('better-sqlite3')` — this adds a runtime dependency
- If better-sqlite3 is not available in the environment, the import catches and pendingTasks = -1
- This is fine but not tested in the acceptance criteria — `npm run build` only verifies compilation
- **Suggestion:** Add a runtime test or at minimum document that better-sqlite3 must be present

**Plan 04, Task 2 — Circular dependency risk:**
- `const { PainSignalBridge } = await import('@principles/core/runtime-v2')` — lazy import in index.ts
- This avoids load-time circular dependency but defers it to runtime
- If the import fails (e.g., package not built), the error surfaces at plugin initialization, not build time
- **Mitigation:** The try-catch around the lazy import would need to handle this gracefully — not currently documented

**Plan 04, Task 4 verify — rg exit code logic:**
- The verify script uses `FOUND=$((FOUND+1))` pattern correctly with `&&`
- However, `rg` exits 0 when matches ARE found (pattern exists), exits 1 when no matches
- So `FOUND=$((FOUND+1))` is triggered when legacy refs ARE found (bad) — this is correct
- The final `if [ $FOUND -gt 0 ]` then fails if any legacy refs found — correct

### LOW

**Plan 02 — Line ranges are approximate:**
- "lines ~913-1000", "~lines 1328-1464" — the tilde indicates approximate
- In a large file (~1500+ lines), these ranges could drift if the file changes before execution
- Not a blocker, but increases execution risk

**Plan 05, Task 3 — Manual E2E has no automated rollback:**
- If E2E fails mid-chain, workspace is left in dirty state
- Not a blocker for M8 sign-off but should be noted

---

## Suggestions

1. **Plan 04, Task 2:** Add explicit initialization order documentation — PainSignalBridge subscription must be registered before any 'pain_detected' emission. Consider adding an integration test that verifies subscription exists before emitting.

2. **Plan 04, Task 1:** Consider adding a `transactionId` or `bridgeRunId` to correlate all events in a single pain→intake chain. This aids debugging.

3. **Plan 03:** The `better-sqlite3` import pattern with `.catch(() => null)` is defensive. Consider logging a warning when the fallback is triggered so operators know pending task counts are unknown.

4. **Plan 04:** The `emitEvent` callback in PainSignalBridge is optional (`emitEvent?: ...`). Consider documenting what events the bridge emits (`pain_signal_bridged`, `intake_failed`) so operators can monitor bridge health.

5. **Plan 02:** Add a `read_first` directive for evolution-worker.ts that captures the full range (900-1500) in one read to help the executor locate all legacy blocks.

---

## Risk Assessment

**Overall Risk: MEDIUM**

| Plan | Risk | Justification |
|------|------|---------------|
| 01 | LOW | Simple deletion with pre-check |
| 02 | MEDIUM | Approximate line ranges in large file; non-diagnostician features could be accidentally deleted |
| 03 | LOW | Defensive fallback; backwards-compatible event types |
| 04 | MEDIUM | Subscription ordering; no transaction semantics; lazy import runtime failure |
| 05 | LOW | Human-gated E2E; verify:merge is structural check |

**Highest Priority Concerns:**
1. Plan 04 subscription ordering (HIGH) — must document initialization order constraint
2. Plan 02 approximate line ranges (MEDIUM) — executor must carefully verify before deletion
3. Plan 04 no transaction semantics (MEDIUM) — acceptable for M8 but should be documented

---

## Consensus Summary

*(Only one reviewer — no consensus possible. Primary concerns are listed above.)*

### Agreed Strengths
- Wave-based dependency ordering is correct (wave 1 → 2 → 3)
- Self-contained BridgePainSignalInput correctly avoids cross-package coupling
- Runner-manages-own-run-lifecycle constraint is clearly documented and enforced
- Event-based wiring (evolutionReducer subscription) keeps pain.ts unmodified
- Real UUID candidateId via getCandidatesByTaskId() over synthetic

### Agreed Concerns
- Subscription ordering: PainSignalBridge must be subscribed before any pain_detected emission
- Approximate line ranges in Plan 02 increase execution risk
- Multi-step bridge flow lacks transaction semantics (acceptable for M8 but should be documented)

### Divergent Views
N/A — single reviewer.

---

## Verdict

**Proceed with execution** — plans are ready. Address the subscription ordering concern in Plan 04 Task 2 before execution by adding explicit initialization order documentation.
