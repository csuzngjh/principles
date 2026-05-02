# Phase m8-03: Real Environment UAT - Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

---

## Phase Boundary

**What this phase delivers:** Real environment acceptance test for M8 single-path pain→ledger chain. No mocks, no test-doubles — all verification against live OpenClaw gateway + real workspace at `D:/.openclaw/workspace`. M8 cannot be marked SHIPPED until this UAT passes.

---

## Implementation Decisions

### Pain Trigger Strategy
- **D-01:** Primary trigger = real tool failure (e.g., `cat /nonexistent/path/file.txt` via OpenClaw agent session)
- **D-02:** Fallback = `/pd pain --reason "UAT test pain" --score 80` if real tool failure doesn't naturally trigger pain hook
- **D-03:** Must verify pain_detected event was emitted (pain flag file, gateway logs, or SystemLogger BRIDGE_ERROR entry)

### Baseline Strategy
- **D-04:** Record current state (ledger entry count, legacy file counts, task counts) BEFORE triggering pain
- **D-05:** Compare post-UAT counts against baseline — diff must show NEW entries from this UAT, not just absolute counts
- **D-06:** Do NOT clear ledger entries before UAT — baseline comparison is more accurate

### Pass Criteria
- **D-07:** All 5 UAT items must pass for M8 SHIPPED — no pragmatic exceptions
- **D-08:** UAT-01 (full chain: task=succeeded + artifact + candidate + ledger probation entry) is the critical path
- **D-09:** UAT-02 (legacy NOT revived: no new .state/diagnostician_tasks.json entries, no new diagnostician_report_*.json, no new evolution_complete_*) is the regression gate
- **D-10:** UAT-03 (idempotency) — if same painId triggered twice, second run resets and re-runs without duplicates
- **D-11:** UAT-04 (runtime probe) — pd-cli probe shows diagnostician task succeeded
- **D-12:** UAT-05 (no errors) — no BRIDGE_ERROR in SystemLogger, no failed tasks in DB

### UAT Sequence
- **D-13:** Task 3 (baseline) before Task 4 (trigger) — never skip baseline
- **D-14:** Wait up to 5 minutes for DiagnosticianRunner to complete after pain trigger (T-m8-07 mitigation)
- **D-15:** Check pain flag file presence (`D:/.openclaw/workspace/.state/pain_*.json`) as evidence of hook trigger

---

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M8 Architecture
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` — PainSignalBridge idempotent upsert logic (status=succeeded→NO-OP, leased→SKIP, failed/retry_wait/pending→reset+re-run)
- `packages/openclaw-plugin/src/hooks/pain.ts` — PainSignalBridge wiring with `autoIntakeEnabled: true` at line ~100, `emitPainDetectedEvent()` function
- `.planning/phases/m8-01-Pain-Signal-Bridge/m8-01-CONTEXT.md` — M8 pipeline complete description, legacy code map classification
- `.planning/phases/m8-02-Pain-Signal-Bridge-E2E/m8-02-CONTEXT.md` — E2E strategy (temp workspace, no mocks), autoIntakeEnabled flip decision

### Runtime v2 Core
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner.run() with lease management
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` — CandidateIntakeService.intake()
- `packages/principles-core/src/runtime-v2/principle-tree-ledger.ts` — PRINCIPLE_TRAINING_FILE = 'principle_training_state.json' at stateDir

### Store/DB locations
- `D:/.openclaw/workspace/.pd/state.db` — SQLite with tables: tasks, runs, artifacts, commits, principle_candidates
- `D:/.openclaw/workspace/.state/principle_training_state.json` — ledger (confirmed path, NOT .principles/ledger/principles.jsonl)
- `D:/.openclaw/workspace/.state/diagnostician_tasks.json` — legacy file (must NOT receive new entries from new chain)

### UAT Plan
- `.planning/phases/m8-03-Real-Environment-UAT/m8-03-01-PLAN.md` — full 9-task UAT plan (Tasks 1-9)

---

## Existing Code Insights

### Reusable Assets
- `PainSignalBridge` — already wired with `autoIntakeEnabled: true`
- `SqliteTaskStore.createTask` — upsert (INSERT OR REPLACE) for idempotency
- `DiagnosticianRunner.run()` — manages lease lifecycle internally; bridge does NOT call createRun()

### Established Patterns
- PainSignalBridge fire-and-forget error handling (catch + SystemLogger) — not propagated
- Task status routing: succeeded→NO-OP, leased→SKIP (if not expired), failed/retry_wait/pending→reset+re-run
- Ledger path: `{stateDir}/principle_training_state.json` (JSON object keyed by principleId, not JSONL)

### Integration Points
- `pain.ts emitPainDetectedEvent()` → PainSignalBridge.onPainDetected() → stateManager → runner → committer → intakeService → ledger
- Ledger probation entry: `status=probation`, `sourceRef=candidate://<candidateId>`, `createdAt=<recent>`

---

## Specific Ideas

- PainId format: `pain_${Date.now()}_${computeHash(sessionId).slice(0, 8)}`
- Lease TTL: 300_000ms (5 minutes) — matches DiagnosticianRunner timeoutMs
- DiagnosticianOutputV1 parsing handles both raw JSON and `{recommendation}` wrapper format
- Ledger entry schema: `{ principleId: string, status: 'probation', evaluability: {...}, sourceRef: 'candidate://...', title: string, createdAt: ISO }`

---

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: m8-03-Real-Environment-UAT*
*Context gathered: 2026-04-28*