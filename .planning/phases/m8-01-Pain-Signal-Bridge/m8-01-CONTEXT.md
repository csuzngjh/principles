# m8-01 Context: Legacy Code Map + Single Path Cutover

**Phase:** m8-01
**Milestone:** v2.7 M8 — Pain Signal → Principle Single Path Cutover
**Created:** 2026-04-27
**Status:** Legacy map complete; implementation pending

---

## Domain

**What this phase delivers:** Complete the single-path cutover from legacy diagnostician execution to Runtime v2 — including legacy code map, deletion of old path, new pain signal bridge entry, and E2E verification.

---

## M8 Pipeline (single path, no fallback)

```
pain signal → PD task/run store → DiagnosticianRunner → OpenClawCliRuntimeAdapter
→ DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates
→ CandidateIntakeService → PrincipleTreeLedger probation entry
```

**M8 success endpoint:** PrincipleTreeLedger probation entry (NOT just pending candidate)
**Candidate intake:** Happy path的一部分（调试模式可禁用）

---

## Legacy Code Map

### 1. diagnostician-task-store.ts

**File:** `packages/openclaw-plugin/src/core/diagnostician-task-store.ts`

**Purpose:** Manages `.state/diagnostician_tasks.json` — file-based task queue for legacy heartbeat path

**Functions:**
- `addDiagnosticianTask(stateDir, taskId, prompt)` — write task to JSON file
- `completeDiagnosticianTask(stateDir, taskId)` — remove task from JSON file
- `getPendingDiagnosticianTasks(stateDir)` — read pending tasks from JSON
- `hasPendingDiagnosticianTasks(stateDir)` — check if any pending
- `requeueDiagnosticianTask(stateDir, taskId, maxRetries)` — re-queue with retry counter

**Classification: DELETE**

**Reason:** This entire store is specific to the legacy heartbeat injection path. Runtime v2 uses `SqliteTaskStore` / `SqliteRunStore` instead. No non-diagnostician functionality depends on this file.

**Delete after:** All references in evolution-worker.ts, prompt.ts, runtime-summary-service.ts are removed.

---

### 2. prompt.ts — Legacy Diagnostician Injection

**File:** `packages/openclaw-plugin/src/hooks/prompt.ts`

**Lines:** ~737-815 (PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED guard), ~774-799 (marker/report file references)

**Purpose:** Injects `<diagnostician_task>` XML blocks into heartbeat prompt when `PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED=true`

**Key code:**
```typescript
const legacyDiagnosticianEnabled = process.env.PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED === 'true';
if (!legacyDiagnosticianEnabled) {
  logger?.debug?.('[PD:Prompt] Legacy diagnostician heartbeat injection DISABLED...');
}
// Lines 774-799: builds <diagnostician_task> XML with marker .evolution_complete_<id>
// and report .diagnostician_report_<id>.json references
```

**References:**
- `getPendingDiagnosticianTasks(wctx.stateDir)` — reads legacy task store
- `.evolution_complete_<id>` — LLM writes completion marker
- `.diagnostician_report_<id>.json` — LLM writes diagnostic report
- `<diagnostician_task>` — XML tag injected into prompt

**Classification: DELETE**

**Reason:** This is the legacy heartbeat prompt injection path. M8 replaces it with runtime-v2 direct invocation via `DiagnosticianRunner.startRun()`.

**NOTE: Do NOT delete the entire prompt.ts.** Only the legacy diagnostician injection block (~lines 737-820) and the `PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED` guard. Other prompt.ts functionality (sleep reflection injection, keyword optimization, etc.) must be preserved if they are not exclusively serving the legacy diagnostician path.

**Verification:** After deletion, `rg "<diagnostician_task>" packages/` should return nothing (except test files that explicitly test the old format).

---

### 3. evolution-worker.ts — Legacy Marker File Polling

**File:** `packages/openclaw-plugin/src/service/evolution-worker.ts`

**Legacy references (all DELETE):**

| Line range | Purpose | Classification |
|------------|---------|----------------|
| ~920, 930 | Polls `.evolution_complete_<taskId>` and reads `.diagnostician_report_<taskId>.json` | DELETE |
| ~972 | `// Also delete the incomplete marker so next heartbeat re-runs` — marker file management | DELETE |
| ~1063, 1200, 1236, 1298 | `assigned_session_key = 'heartbeat:diagnostician:<id>'` pattern | DELETE |
| ~1151 | `cleanupReportPath` — cleanup of `.diagnostician_report_*.json` | DELETE |
| ~1213-1214 | Timeout handling: checks `completeMarker` and `reportPath` | DELETE |
| ~1256, 1264 | Late report path handling for `.diagnostician_report_<id>.json` | DELETE |
| ~1333-1334 | `markerFilePath` and `reportFilePath` for new task creation | DELETE |
| ~1479 | `assigned_session_key = 'heartbeat:diagnostician:<id>'` — task assignment | DELETE |
| ~1503-1504 | Error logging for `DIAGNOSTICIAN_TASK_WRITE_FAILED` | DELETE |
| ~2399 | `// with a diagnostician task, immediately trigger a heartbeat` — legacy trigger | DELETE |

**What to KEEP in evolution-worker.ts:**
- `pain_diagnosis` task kind handling (if it uses runtime-v2 task store)
- `sleep_reflection` task kind processing — this is NOT diagnostician-specific
- `keyword_optimization` task kind processing — NOT diagnostician-specific
- Nocturnal workflow management — NOT diagnostician-specific
- Event logging (`recordEvolutionTask`, etc.) — may need telemetry type update

**Non-diagnostician task kinds to preserve:**
- `sleep_reflection` — nocturnal reflection, not diagnostic
- `keyword_optimization` — correction keyword learning, not diagnostic
- (any other task kinds not related to diagnostician)

**Classification: DELETE** — All marker-file polling, `.state/diagnostician_tasks.json` write/read, and `heartbeat:diagnostician:<id>` session key patterns

---

### 4. runtime-summary-service.ts

**File:** `packages/openclaw-plugin/src/service/runtime-summary-service.ts`

**Line 67:** Comment referencing `diagnostician_tasks.json` pending count

```typescript
/** Tasks pending in diagnostician_tasks.json (not yet processed by heartbeat) */
```

**Classification: REPLACE_WITH_RUNTIME_V2**

**Action:** Update to reference PD task/run store pending diagnostician tasks via runtime-v2 query instead of the JSON file.

---

### 5. legacy-import.ts

**File:** `packages/pd-cli/src/legacy/legacy-import.ts`

**Purpose:** Migrates legacy `.state/diagnostician_tasks.json` into PD task/run store (as historical import)

**Classification: KEEP_NON_DIAGNOSTIC**

**Reason:** This is a data migration tool, not part of the active diagnostician execution path. It helps migrate historical data when users upgrade. It does not participate in the runtime diagnosis loop.

---

### 6. event-types.ts

**File:** `packages/openclaw-plugin/src/types/event-types.ts`

**`heartbeat_diagnosis` event type** (line 22):
```typescript
| 'heartbeat_diagnosis'  // Heartbeat injected diagnostician tasks
```

**Classification: REPLACE_WITH_RUNTIME_V2**

**Action:** Rename or add replacement event type for runtime-v2 diagnostician invocation (e.g., `runtime_diagnosis_started`, `diagnostician_output_received`). The legacy `heartbeat_diagnosis` type should be deprecated but can remain as reference for historical events.

---

### 7. telemetry-event.ts (principles-core)

**File:** `packages/principles-core/src/telemetry-event.ts`

**Lines 39, 44-46, 78:**
```typescript
* - diagnostician_task_leased — runner acquired lease on a task
* - diagnostician_task_succeeded — task marked succeeded
* - diagnostician_task_retried — task sent to retry_wait
* - diagnostician_task_failed — task permanently failed
Type.Literal('diagnostician_task_leased'),
```

**Classification: KEEP** — These are runtime-v2 telemetry events, not legacy heartbeat path

**Reason:** These telemetry events are part of the runtime-v2 task/run store (M2), not the legacy heartbeat path. They are already aligned with the new architecture.

---

## Implementation Order

1. **Phase 1: Legacy Code Map** (this document)
   - ✅ Map complete
   - ⏳ Awaiting user confirmation before implementation

2. **Phase 2: Delete legacy diagnostician-task-store.ts**
   - Confirm no remaining references
   - Delete `packages/openclaw-plugin/src/core/diagnostician-task-store.ts`
   - Delete compiled output: `dist/core/diagnostician-task-store.js`, `dist/core/diagnostician-task-store.d.ts`

3. **Phase 3: Remove prompt.ts legacy injection block**
   - Remove `PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED` guard (~line 737-744)
   - Remove `<diagnostician_task>` XML injection (~lines 746-815)
   - Keep: sleep_reflection injection, keyword_optimization injection, other non-diagnostician prompt logic

4. **Phase 4: Remove evolution-worker.ts legacy marker polling**
   - Remove `.evolution_complete_<id>` and `.diagnostician_report_<id>.json` file polling
   - Remove `diagnostician_tasks.json` read/write
   - Remove `assigned_session_key = 'heartbeat:diagnostician:<id>'` patterns
   - Keep: `sleep_reflection`, `keyword_optimization`, other non-diagnostician task kinds

5. **Phase 5: Update runtime-summary-service.ts**
   - Replace `diagnostician_tasks.json` reference with runtime-v2 task store query

6. **Phase 6: Update event-types.ts**
   - Deprecate `heartbeat_diagnosis` event type
   - Add runtime-v2 equivalent event types if not already present

7. **Phase 7: Pain Signal Bridge (new entry)**
   - Implement pain signal → PD task/run store → DiagnosticianRunner
   - Automatic candidate intake to probation entry (happy path)

8. **Phase 8: E2E Verification**
   - Real workspace: `D:\.openclaw\workspace`
   - Verify: pain signal → diagnosis → artifact → candidate → ledger probation entry

---

## Non-Diagnostician Features to Preserve

These are **NOT** part of the legacy diagnostician execution path — do NOT delete:

- `sleep_reflection` task kind in evolution-worker.ts
- `keyword_optimization` task kind in evolution-worker.ts
- Nocturnal workflow management (Dreamer, Philosopher, Scribe)
- Principle injection (`prompt.ts` — PD principle rules injection)
- Pain signal detection (PainSignalAdapter)
- All runtime-v2 components (DiagnosticianRunner, SqliteDiagnosticianCommitter, CandidateIntakeService, PrincipleTreeLedger)

---

## Canonical refs

- `packages/openclaw-plugin/src/core/diagnostician-task-store.ts` — legacy task store (DELETE)
- `packages/openclaw-plugin/src/hooks/prompt.ts` — legacy injection (~lines 737-815) (DELETE)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — legacy marker polling (DELETE)
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — task count reference (REPLACE_WITH_RUNTIME_V2)
- `packages/pd-cli/src/legacy/legacy-import.ts` — historical import (KEEP_NON_DIAGNOSTIC)
- `packages/openclaw-plugin/src/types/event-types.ts` — `heartbeat_diagnosis` event (REPLACE_WITH_RUNTIME_V2)
- `packages/principles-core/src/telemetry-event.ts` — runtime-v2 telemetry (KEEP)
- `packages/principles-core/src/runtime-v2/candidate-intake.ts` — M7 intake service (KEEP)
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — M4/M6 runner (KEEP)

---

## Decisions

1. **Legacy diagnostician-task-store.ts → DELETE** — Replaced by runtime-v2 SqliteTaskStore
2. **prompt.ts `<diagnostician_task>` injection → DELETE** — Replaced by runtime-v2 direct runner invocation
3. **evolution-worker.ts marker polling → DELETE** — Replaced by runtime-v2 task/run state transitions
4. **PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED → DELETE** — No longer needed, single path
5. **sleep_reflection / keyword_optimization → KEEP** — Not diagnostician-specific
6. **legacy-import.ts → KEEP** — Historical data migration tool
7. **runtime-summary-service.ts → REPLACE_WITH_RUNTIME_V2** — Update to query runtime-v2 task store
8. **heartbeat_diagnosis event → REPLACE_WITH_RUNTIME_V2** — Add/replace with runtime-v2 event type

---

## Deferred Ideas

(None for this phase — scope is clear)

---

## Next Step

Confirm this legacy code map is correct, then proceed to `/gsd-plan-phase m8-01` for implementation planning.