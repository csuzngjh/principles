# Phase m8-03: Real Environment UAT - Research

**Researched:** 2026-04-28
**Domain:** OpenClaw plugin runtime-v2 integration testing, real-environment acceptance
**Confidence:** HIGH

## Summary

M8-03 is a real-environment acceptance test (UAT) for the M8 single-path pain-to-ledger chain. The phase verifies the complete flow: real OpenClaw tool failure -> PainSignalBridge -> DiagnosticianRunner -> SqliteDiagnosticianCommitter -> CandidateIntakeService -> PrincipleTreeLedger probation entry. All verification is against live infrastructure: `D:/.openclaw/workspace` workspace, live OpenClaw gateway on port 18789, and `D:/.openclaw/workspace/.pd/state.db` SQLite store. No mocks, stubs, or test doubles are used in the final UAT pass criteria. The five UAT items are: UAT-01 (full chain with ledger probation entry), UAT-02 (legacy path NOT revived), UAT-03 (idempotency), UAT-04 (runtime probe), UAT-05 (no errors). All 5 must pass for M8 to be marked SHIPPED.

**Primary recommendation:** Use baseline comparison (pre-trigger state vs post-trigger state) rather than absolute counts, with a 5-minute wait window after pain trigger before checking results.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Primary trigger = real tool failure (e.g., `cat /nonexistent/path/file.txt` via OpenClaw agent session)
- **D-02:** Fallback = `/pd pain --reason "UAT test pain" --score 80` if real tool failure doesn't naturally trigger pain hook
- **D-03:** Must verify pain_detected event was emitted (pain flag file, gateway logs, or SystemLogger BRIDGE_ERROR entry)
- **D-04:** Record current state (ledger entry count, legacy file counts, task counts) BEFORE triggering pain
- **D-05:** Compare post-UAT counts against baseline -- diff must show NEW entries from this UAT, not just absolute counts
- **D-06:** Do NOT clear ledger entries before UAT -- baseline comparison is more accurate
- **D-07:** All 5 UAT items must pass for M8 SHIPPED -- no pragmatic exceptions
- **D-08:** UAT-01 (full chain: task=succeeded + artifact + candidate + ledger probation entry) is the critical path
- **D-09:** UAT-02 (legacy NOT revived: no new .state/diagnostician_tasks.json entries, no new diagnostician_report_*.json, no new evolution_complete_*) is the regression gate
- **D-10:** UAT-03 (idempotency) -- if same painId triggered twice, second run resets and re-runs without duplicates
- **D-11:** UAT-04 (runtime probe) -- pd-cli probe shows diagnostician task succeeded
- **D-12:** UAT-05 (no errors) -- no BRIDGE_ERROR in SystemLogger, no failed tasks in DB
- **D-13:** Task 3 (baseline) before Task 4 (trigger) -- never skip baseline
- **D-14:** Wait up to 5 minutes for DiagnosticianRunner to complete after pain trigger (T-m8-07 mitigation)
- **D-15:** Check pain flag file presence (`D:/.openclaw/workspace/.state/pain_*.json`) as evidence of hook trigger

### Deferred Ideas

None.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Pain detection + hook dispatch | openclaw-plugin (pain.ts) | openclaw-plugin (hooks/) | `after_tool_call` lives in plugin, fires `emitPainDetectedEvent` |
| PainSignalBridge (idempotent upsert + routing) | principles-core (runtime-v2/) | -- | Lives in principles-core, receives events from plugin via callback |
| DiagnosticianRunner (lease + run + commit) | principles-core (runtime-v2/runner/) | -- | Pure state machine, no plugin imports |
| SqliteDiagnosticianCommitter (artifact + candidates) | principles-core (runtime-v2/store/) | -- | SQLite transactions within same connection |
| CandidateIntakeService (ledger write) | principles-core (runtime-v2/) | -- | Reads candidate from DB, writes to ledger file |
| Ledger (principle_training_state.json) | openclaw-plugin (core/) | -- | Ledger adapter lives in openclaw-plugin, ledger file at `{stateDir}/principle_training_state.json` |
| Real workspace state | `D:/.openclaw/workspace` | -- | Lives outside repo, verified via SQL queries |
| Runtime probe | pd-cli | principles-core | `pd runtime probe` command uses `probeRuntime()` from principles-core |

---

## Standard Stack

### Core Libraries

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | latest | SQLite state store | Used by SqliteConnection for `.pd/state.db` |
| `@principles/core/runtime-v2` | (workspace) | PainSignalBridge, DiagnosticianRunner, CandidateIntakeService | M8 single-path runtime |
| `@principles/core` (openclaw-plugin) | (workspace) | PrincipleTreeLedger, SystemLogger | Ledger file operations |

### Supporting Commands

| Command | Purpose |
|---------|---------|
| `openclaw gateway start` | Start OpenClaw gateway on port 18789 |
| `openclaw agent --agent main` | Start OpenClaw agent session (primary pain trigger) |
| `node packages/pd-cli/dist/index.js runtime probe` | Runtime health check (UAT-04) |
| `sqlite3 D:/.openclaw/workspace/.pd/state.db "..."` | DB introspection for all UAT items |
| `python3 -c "..."` | Ledger file introspection (principle_training_state.json) |

---

## Architecture Patterns

### System Architecture Diagram

```
OpenClaw Agent (D:/.openclaw/workspace)
  |
  |-- tool failure occurs -->
  |   `after_tool_call` hook (pain.ts:handleAfterToolCall)
  |       --(isFailure==true)--> emitPainDetectedEvent(wctx, {type:'pain_detected', data: PainDetectedData})
  |
PainSignalBridge.onPainDetected(PainDetectedData)  [principles-core]
  |   (autoIntakeEnabled: true, per pain.ts:100)
  |
  |-- status check (getTask/painId) -->
  |   succeeded --> NO-OP (return painId)
  |   leased (not expired) --> SKIP (return painId)
  |   failed/retry_wait/pending --> reset + re-run
  |   (no existing task) --> createTask(taskId: painId, status: pending)
  |
DiagnosticianRunner.run(taskId)  [acquires lease internally]
  |   phase: BuildingContext -> Invoking -> Polling -> FetchingOutput -> Validating -> Committing
  |
SqliteDiagnosticianCommitter.commit({runId, taskId, output: DiagnosticianOutputV1, idempotencyKey})
  |   [transaction] INSERT INTO artifacts, commits, principle_candidates
  |
RuntimeStateManager.markTaskSucceeded(taskId, resultRef: "commit://{commitId}")
  |
CandidateIntakeService.intake(candidateId)  [autoIntakeEnabled=true]
  |   existsForCandidate(candidateId) --> idempotent NO-OP if already written
  |   Load candidate + artifact from DB
  |   Parse artifact.contentJson (DiagnosticianOutputV1) for recommendation
  |   Build LedgerPrincipleEntry (11 fields: id, title, text, triggerPattern, action, status:probation, evaluability, sourceRef, artifactRef, taskRef, createdAt)
  |
PrincipleTreeLedgerAdapter.writeProbationEntry(entry)
  |   addPrincipleToLedger(stateDir, ledgerPrinciple)
  |   --> writes to D:/.openclaw/workspace/.state/principle_training_state.json
  |       (file, not DB -- uses withLock + atomicWriteFileSync)
  |
D:/.openclaw/workspace/.state/principle_training_state.json
  |-- probation entry: { id, version:1, text, triggerPattern, action, status:'candidate', evaluability, derivedFromPainIds:[candidateId], ... }
```

### Ledger Entry Schema (probation entry in principle_training_state.json)

The ledger file is a JSON object keyed by `principleId` (NOT JSONL). The probation entry written by `addPrincipleToLedger` via `PrincipleTreeLedgerAdapter` becomes a `LedgerPrinciple`:

```json
{
  "id": "<randomUUID>",
  "version": 1,
  "text": "<recommendation.text from DiagnosticianOutputV1>",
  "triggerPattern": "<recommendation.triggerPattern>",
  "action": "<recommendation.action>",
  "status": "candidate",
  "evaluability": "weak_heuristic",
  "priority": "P1",
  "scope": "general",
  "valueScore": 0,
  "adherenceRate": 0,
  "painPreventedCount": 0,
  "derivedFromPainIds": ["<candidateId>"],
  "ruleIds": [],
  "conflictsWithPrincipleIds": [],
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

Key observations:
- `status` in the ledger file is `'candidate'` (not `'probation'`) -- HG-1 requires a ledger entry but the ledger format stores `'candidate'`
- The `sourceRef: 'candidate://{candidateId}'` is NOT stored in the ledger file (adapter extracts candidateId from sourceRef to check idempotency, but only stores `derivedFromPainIds`)
- `title` is NOT stored in LedgerPrinciple (it exists in CandidateRecord but not in LedgerPrinciple)
- Evaluability is always `'weak_heuristic'` for auto-intake entries

### Real Workspace State (D:/.openclaw/workspace/.pd/state.db)

Schema (from `sqlite-connection.ts:initSchema`):

```sql
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  task_kind TEXT NOT NULL,        -- 'diagnostician' for PainSignalBridge tasks
  status TEXT NOT NULL DEFAULT 'pending',  -- 'succeeded'|'failed'|'retry_wait'|'leased'|'pending'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,          -- ISO timestamp, checked against Date.now() - 300000ms
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  input_ref TEXT,
  result_ref TEXT,                -- set to 'commit://{commitId}' on success
  diagnostic_json TEXT
);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,          -- FK to tasks
  runtime_kind TEXT NOT NULL,     -- 'openclaw-cli' for real runs
  execution_status TEXT NOT NULL DEFAULT 'queued',  -- 'succeeded'|'failed'|'queued'
  started_at TEXT NOT NULL,
  ended_at TEXT,
  reason TEXT,
  output_ref TEXT,
  input_payload TEXT,            -- DiagnosticianPromptBuilder output
  output_payload TEXT,            -- DiagnosticianOutputV1 JSON string
  error_category TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,           -- FK to runs
  task_id TEXT NOT NULL,         -- FK to tasks
  artifact_kind TEXT NOT NULL,    -- 'diagnostician_output' for DiagnosticianOutputV1
  content_json TEXT NOT NULL,     -- Full DiagnosticianOutputV1 JSON string
  created_at TEXT NOT NULL
);

CREATE TABLE commits (
  commit_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  artifact_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,  -- '{taskId}:{runId}'
  status TEXT NOT NULL DEFAULT 'committed',
  created_at TEXT NOT NULL
);

CREATE TABLE principle_candidates (
  candidate_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  title TEXT NOT NULL,            -- First 200 chars of recommendation.description
  description TEXT NOT NULL,
  confidence REAL,
  source_recommendation_json TEXT,  -- Full JSON of the recommendation object
  idempotency_key TEXT NOT NULL UNIQUE,  -- '{commitId}:{recommendationIndex}'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'consumed'|'expired'
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
```

---

## Pain Signal Bridge: `after_tool_call` -> `emitPainDetectedEvent` -> `PainSignalBridge`

### Flow: pain.ts

```
handleAfterToolCall(event, ctx, api)
  |
  |-- isFailure == true? -->
  |     compute painScore, buildPainFlag, writePainFlag
  |     eventLog.recordPainSignal(...)
  |     evoLogger.logPainDetected(...)
  |     emitPainDetectedEvent(wctx, {type:'pain_detected', data: PainDetectedData})
  |
  |-- (manual pain tool: event.toolName === 'pain' || 'skill:pain') -->
  |     trackFriction(sessionId, 100, 'manual_pain', ...)
  |     emitPainDetectedEvent(wctx, {type:'pain_detected', data: PainDetectedData})
```

### PainId Format

```typescript
function createPainId(sessionId: string): string {
  return `pain_${Date.now()}_${computeHash(sessionId).slice(0, 8)}`;
}
```

`computeHash` is from `utils/hashing.ts` -- computes a hash of the sessionId.

### emitPainDetectedEvent (pain.ts:111)

```typescript
async function emitPainDetectedEvent(wctx: WorkspaceContext, event: EvolutionLoopEvent): Promise<void> {
  try {
    wctx.evolutionReducer.emitSync(event);
  } catch (e) {
    SystemLogger.log(wctx.workspaceDir, 'EVOLUTION_EMIT_WARN', `Failed to emit evolution event: ${String(e)}`);
  }
  // M8: Bridge pain_detected --> diagnostician pipeline (fire-and-forget)
  if (event.type === 'pain_detected') {
    const bridge = await getPainSignalBridge(wctx);  // lazy cache per workspace
    bridge.onPainDetected(event.data as PainDetectedData).catch((err) => {
      SystemLogger.log(wctx.workspaceDir, 'BRIDGE_ERROR', `PainSignalBridge failed: ${String(err)}`);
    });
  }
}
```

Key: `catch()` on `bridge.onPainDetected()` -- errors are fire-and-forget (not propagated). `BRIDGE_ERROR` in SystemLogger is the observable failure signal.

### PainSignalBridge.onPainDetected (pain-signal-bridge.ts:82)

```typescript
async onPainDetected(data: PainDetectedData): Promise<string> {
  const { painId } = data;
  const existingTask = await this.stateManager.getTask(painId);

  if (existingTask) {
    const { status, leaseExpiresAt } = existingTask;
    const LEASE_TTL_MS = 300_000;
    const leaseExpired = leaseExpiresAt && (Date.now() - new Date(leaseExpiresAt).getTime()) > LEASE_TTL_MS;
    if (status === 'leased' && !leaseExpired) {
      return painId;  // SKIP
    }
    if (status === 'leased' && leaseExpired) { /* fall through to reset */ }
    else if (status !== 'succeeded') {
      await this.stateManager.updateTask(painId, { status: 'pending', attemptCount: 0, lastError: null, resultRef: null });
    }
  } else {
    await this.stateManager.createTask({ taskId: painId, taskKind: 'diagnostician', inputRef: painId, status: 'pending', attemptCount: 0, maxAttempts: 3 });
  }

  const taskId = painId;
  const result = await this.runner.run(taskId);  // runner manages lease internally

  if (result.status !== 'succeeded') return taskId;

  const candidates = await this.stateManager.getCandidatesByTaskId(taskId);

  if (this.autoIntakeEnabled) {
    for (const candidate of candidates) {
      await this.intakeService.intake(candidate.candidateId);
    }
  }
  return taskId;
}
```

**Important**: Bridge does NOT call `createRun()` -- `acquireLease()` in `DiagnosticianRunner.run()` handles run creation.

### DiagnosticianRunner.run() Lifecycle (diagnostician-runner.ts:125)

```
1. acquireLease({taskId, owner, runtimeKind}) --> TaskRecord (leased)
2. resolveStoreRunId(taskId) --> get latest run's runId from store
3. buildContext(taskId) --> DiagnosticianContextPayload
4. invokeRuntime(context, taskId) --> RunHandle (spawns openclaw agent)
5. pollUntilTerminal(runHandle) --> RunStatus
6. handleRuntimeFailure() if non-success
7. fetchAndParseOutput(runId) --> DiagnosticianOutputV1
8. validate(output, taskId) --> validationResult
9. succeedTask({taskId, runId, output, task, contextHash}) -->
     updateRunOutput(runId, JSON.stringify(output))
     committer.commit({runId, taskId, output, idempotencyKey: `${taskId}:${runId}`})
     markTaskSucceeded(taskId, "commit://{commitId}")
```

Lease TTL: 300_000ms (5 minutes), matching `LEASE_TTL_MS` in PainSignalBridge.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Real environment pain trigger | Script a fake tool failure in unit test | Real OpenClaw agent session + actual tool failure | UAT-01 requires real `after_tool_call` hook execution |
| Ledger write verification | Query in-memory map | Read `principle_training_state.json` file directly | Ledger is a file, not DB; file read is authoritative |
| DB introspection | Trust schema assumptions | Introspect schema first (`PRAGMA table_info`, `.schema`) | Pre-existing DBs may have different column sets |
| Pain hook verification | Assume hook fired | Check pain flag file (`D:/.openclaw/workspace/.state/pain_*.json`) or gateway logs | Hook fires asynchronously; no synchronisation signal |

---

## Common Pitfalls

### Pitfall 1: Checking results before DiagnosticianRunner completes

**What goes wrong:** UAT fails because task is still `leased` or `pending` when checks run.
**Why it happens:** DiagnosticianRunner has a 5-minute timeout (`timeoutMs: 300_000`). The UAT plan waits up to 5 minutes (T-m8-07 mitigation), but naive scripts check immediately.
**How to avoid:** Always wait and re-poll. Use a loop that checks task status until `status='succeeded'` or 5 minutes elapse.
**Warning signs:** Task with `status='leased'` and recent `leaseExpiresAt` timestamp.

### Pitfall 2: Assuming ledger entry has `status='probation'`

**What goes wrong:** UAT checks for `status === 'probation'` but ledger stores `status: 'candidate'`.
**Why it happens:** `PrincipleTreeLedgerAdapter.writeProbationEntry()` expands `LedgerPrincipleEntry` (which has `status: 'probation'`) into `LedgerPrinciple` (which has `status: 'candidate'`). This is a format translation.
**How to avoid:** Check for `status === 'candidate'` in the ledger file, and `status === 'pending'` in the `principle_candidates` DB table. The `sourceRef: 'candidate://{id}'` is NOT stored in the ledger file -- `derivedFromPainIds` is used instead.

### Pitfall 3: Wrong ledger path assumption

**What goes wrong:** Querying `.principles/ledger/principles.jsonl` (wrong) instead of `.state/principle_training_state.json`.
**Why it happens:** Old path assumptions from pre-M7 architecture.
**How to avoid:** Confirmed path from `principle-tree-ledger.ts:PRINCIPLE_TRAINING_FILE = 'principle_training_state.json'` at `stateDir` = `D:/.openclaw/workspace/.state/`.

### Pitfall 4: Legacy file count comparison without baseline

**What goes wrong:** Absolute count of `diagnostician_tasks.json` tasks > 0, concluding the new chain is writing legacy files.
**Why it happens:** Legacy file may have pre-existing entries from old runs.
**How to avoid:** Always record baseline BEFORE trigger, then compare diff (post minus pre). UAT-02 passes only if counts are EQUAL to baseline.

### Pitfall 5: Pain hook not triggering

**What goes wrong:** Tool failure in agent session does not produce pain signal.
**Why it happens:** OpenClaw gateway not running, plugin not deployed, or hook registration issue.
**How to avoid:** Fallback to `/pd pain --reason "UAT test pain" --score 80` (D-02). Also check `D:/.openclaw/workspace/.state/pain_*.json` or gateway logs for evidence.

---

## Code Examples

### Checking Pain Flag File Presence (D-15)

```bash
ls -la D:/.openclaw/workspace/.state/pain_*.json 2>/dev/null | tail -3
```

Pain flag file naming: `pain_{timestamp}_{hash}.json` -- multiple files may exist. Check most recent.

### DB Schema Introspection (UAT-05, Task 5)

```bash
# Always introspect first -- do not assume schema
sqlite3 D:/.openclaw/workspace/.pd/state.db ".schema tasks"
sqlite3 D:/.openclaw/workspace/.pd/state.db ".schema principle_candidates"
sqlite3 D:/.openclaw/workspace/.pd/state.db ".schema artifacts"

# Then query actual data
sqlite3 D:/.openclaw/workspace/.pd/state.db "SELECT task_id, status, attempt_count FROM tasks WHERE task_kind='diagnostician' ORDER BY created_at DESC LIMIT 5;"
sqlite3 D:/.openclaw/workspace/.pd/state.db "SELECT * FROM principle_candidates ORDER BY created_at DESC LIMIT 5;"
```

### Ledger Probation Entry Query (UAT-01, Task 6)

```python
import json, os
ledger = 'D:/.openclaw/workspace/.state/principle_training_state.json'
with open(ledger) as f:
    data = json.load(f)
# Note: ledger is keyed by principleId, NOT by candidateId
# derivedFromPainIds array in each entry contains the candidateId
probation = {k: v for k, v in data.items()
              if isinstance(v, dict) and v.get('status') == 'candidate'
              and v.get('evaluability') == 'weak_heuristic'}
print(f'Probation entries: {len(probation)}')
for pid, entry in list(probation.items())[:3]:
    print(f'  {pid}: derivedFromPainIds={entry.get("derivedFromPainIds")}')
```

### Runtime Probe Command (UAT-04)

```bash
node packages/pd-cli/dist/index.js runtime probe \
  --runtime openclaw-cli \
  --openclaw-local \
  --agent main \
  --workspace D:/.openclaw/workspace \
  --json
```

Note: `--openclaw-local` required (not `--openclaw-gateway`). Agent must be `main` (not `diagnostician`) for real workspace runs.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `diagnostician_tasks.json` file | PD task/run store (SQLite) | M8 (m8-01) | Legacy file must NOT receive new entries |
| `<diagnostician_task>` in heartbeat prompt | PainSignalBridge + DiagnosticianRunner | M8 (m8-01) | No more prompt injection |
| Marker files (`evolution_complete_*`, `.diagnostician_report_*.json`) | SQLite commits + artifact registry | M8 (m8-01) | No more file polling |
| Manual candidate intake via CLI | `autoIntakeEnabled=true` in PainSignalBridge | M8 (m8-02) | Intake happens automatically after runner succeeds |
| In-memory idempotency (adapter instance) | In-memory Map + ledger file cross-check | M8 (m8-02) | Idempotency works across CLI invocations |

**Deprecated/outdated:**
- `PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED` env flag: removed in m8-01 (DEL-06)
- `.state/diagnostician_tasks.json`: deprecated, must NOT receive new entries (DEL-01)
- `diagnostician_report_*.json` files: deprecated, must NOT be created (DEL-04)
- `evolution_complete_*` marker files: deprecated, must NOT be created (DEL-03)

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `status='candidate'` in ledger file corresponds to probation entry from intake | Ledger Entry Schema | Ledger check uses wrong status field -- should verify against actual m8-02-e2e.test.ts output |
| A2 | PainId format `pain_${Date.now()}_${computeHash(sessionId).slice(0,8)}` matches what pain.ts emits | PainId Format | If hash function differs, painId lookup in getTask() fails |
| A3 | Gateway listens on localhost:18789 | Runtime Availability | If gateway uses different port, healthCheck fails |
| A4 | `openclaw` binary is in PATH for probe command | Runtime Availability | If not in PATH, healthCheck returns runtime_unavailable |
| A5 | Ledger file format uses `derivedFromPainIds` not `sourceRef` for candidate linkage | Ledger Entry Schema | Idempotency check in `existsForCandidate` uses `derivedFromPainIds.find(candidateId)` -- verified by adapter source |

**Items needing user confirmation:**
- A3: Confirm OpenClaw gateway port (default 18789) -- may vary on user's system
- A4: Confirm `openclaw` CLI is in PATH or use full path

---

## Open Questions

1. **Which OpenClaw runtime mode is configured for the real workspace?**
   - What we know: `runtimeMode: 'local'` is used in pain.ts bridge setup, and `--openclaw-local` is required for probe
   - What's unclear: Whether the real OpenClaw agent session at `D:/.openclaw/workspace` is running in local or gateway mode
   - Recommendation: Verify with `openclaw status` or check workspace config before UAT

2. **How to trigger a reliable tool failure in an OpenClaw agent session?**
   - What we know: `cat /nonexistent/path/file.txt` is suggested; `/pd pain` is fallback
   - What's unclear: Whether the `main` agent has the `cat` tool available
   - Recommendation: Use `/pd pain --reason "UAT test pain" --score 80` as primary trigger since it directly calls emitPainDetectedEvent without depending on tool availability

3. **What is the expected behavior if DiagnosticianRunner times out?**
   - What we know: `timeoutMs: 300_000` (5 minutes); task goes to `retry_wait` if retry policy says retry
   - What's unclear: Whether a timed-out task counts as UAT failure or just retry_wait
   - Recommendation: If task is `retry_wait` after 5 minutes, UAT should wait for retry or manually trigger a second pain signal

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| OpenClaw gateway | Pain hook delivery | ? | port 18789 (default) | `openclaw gateway start` |
| `openclaw` CLI | Runtime probe, agent session | ? | ? | Full path if not in PATH |
| `node` | pd-cli invocation | ✓ | Node.js v24.14.0 | — |
| `python3` | Ledger file introspection | ✓ (likely) | ? | Node.js JSON parsing via `node -e` |
| `sqlite3` CLI | DB introspection | ? (Windows may not have) | ? | `node + better-sqlite3` fallback |
| `better-sqlite3` npm | DB access from Node | ✓ (in node_modules) | ? | — |

**Missing dependencies with no fallback:**
- OpenClaw gateway: Must be running for pain hook to fire

**Missing dependencies with fallback:**
- `sqlite3` CLI: Use `node -e "const Database = require('better-sqlite3'); ..."` instead

---

## Validation Architecture

> Validation is the UAT itself -- there are no automated unit tests for this phase (all assertions are manual against real workspace state). Per D-07, all 5 UAT items must pass; no partial credit.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Manual UAT (no automated framework) |
| Config file | None |
| Quick run command | N/A -- all checks are manual |
| Full suite command | N/A |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Verification Method |
|--------|----------|-----------|---------------------|
| M8-D01 | Pain triggered via real OpenClaw tool failure | Manual | Check pain flag file or gateway logs |
| M8-D04 | Baseline recorded before trigger | Manual | Task 3 output with counts |
| M8-D05 | Post-trigger counts compared to baseline | Manual | Diff output showing only NEW entries |
| M8-D06 | UAT-01: full chain passes | Manual | SQL queries + ledger file read |
| M8-D07 | All 5 UAT items pass | Manual | m8-03-UAT.md sign-off |
| M8-D09 | No legacy file entries created | Manual | Count diff from baseline |

### Wave 0 Gaps

None -- UAT is wave 1 (no prior test infrastructure needed). Pre-conditions verified by Task 1 (npm run verify:merge).

---

## Security Domain

> UAT operates on real workspace data at `D:/.openclaw/workspace`. This section addresses the security implications of running acceptance tests against production data.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|--------|-----------------|
| V4 Access Control | No | N/A -- UAT only reads/writes to PD state files |
| V5 Input Validation | Yes | PainSignalBridge validates PainDetectedData shape; DiagnosticianOutputV1 validated by TypeBox schema |
| V6 Cryptography | No | No crypto operations in pain-to-ledger chain |

### Known Threat Patterns for This Phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| UAT reads stale ledger state | Information | Always compare baseline vs post-trigger |
| Concurrent pain signals during UAT | Denial | DiagnosticianRunner lease prevents concurrent runs for same painId |
| UAT polluting real workspace state | Tampering | UAT only ADDs entries; no cleanup required (per D-06) |
| Pain hook not firing silently | Denial | Fallback to `/pd pain` command (D-02) |

---

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` -- PainSignalBridge idempotent upsert logic, LEASE_TTL_MS=300_000
- `packages/openclaw-plugin/src/hooks/pain.ts` -- emitPainDetectedEvent wiring, autoIntakeEnabled:true at line ~100
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` -- Full schema: tasks, runs, artifacts, commits, principle_candidates tables
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` -- commit() idempotency via UNIQUE constraints
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` -- intake() with existsForCandidate idempotency check
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` -- `PRINCIPLE_TRAINING_FILE = 'principle_training_state.json'` at stateDir
- `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts` -- writeProbationEntry (status expansion: 'probation' -> 'candidate'), existsForCandidate uses `derivedFromPainIds`
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` -- run() with lease management, phase pipeline, timeoutMs:300_000
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` -- getCandidatesByTaskId, getCandidate, getArtifact, markTaskSucceeded
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` -- DiagnosticianOutputV1Schema (recommendation.kind: 'principle'|'rule'|...)
- `packages/principles-core/src/runtime-v2/cli/probe.ts` -- probeRuntime() interface
- `packages/pd-cli/src/commands/runtime.ts` -- handleRuntimeProbe with --openclaw-local flag requirement

### Secondary (MEDIUM confidence)
- `packages/principles-core/src/runtime-v2/runner/__tests__/m8-02-e2e.test.ts` -- Full chain E2E with StubRuntimeAdapter; confirms status='candidate' in ledger, not 'probation'
- `.planning/phases/m8-03-Real-Environment-UAT/m8-03-01-PLAN.md` -- 9-task UAT plan with baseline strategy
- `.planning/phases/m8-03-Real-Environment-UAT/m8-03-CONTEXT.md` -- Locked decisions (D-01 through D-15), canonical file paths

### Tertiary (LOW confidence)
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` -- healthCheck() with 3-probe strategy; confirmed correct but untested in isolation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries confirmed from source
- Architecture: HIGH -- all flows traced from source files
- Pitfalls: HIGH -- all identified from source inspection and m8-02-e2e.test.ts patterns

**Research date:** 2026-04-28
**Valid until:** 2026-05-28 (30 days -- M8 architecture is stable post m8-02)

---

## Phase Requirements (from m8-03-01-PLAN.md)

| ID | Description | Research Support |
|----|-------------|------------------|
| M8-D01 | Primary trigger = real tool failure via OpenClaw agent session | `pain.ts:handleAfterToolCall` fires on `isFailure`, fallback to `/pd pain` command |
| M8-D04 | Record baseline (ledger count, legacy file counts, task counts) BEFORE trigger | Baseline Task 3 in m8-03-01-PLAN.md |
| M8-D05 | Compare post-UAT counts against baseline -- diff must show NEW entries | Baseline comparison strategy in m8-03-01-PLAN.md Tasks 3/7 |
| M8-D06 | UAT-01 full chain: task=succeeded + artifact + candidate + ledger probation entry | Complete chain traced: pain.ts -> PainSignalBridge -> DiagnosticianRunner -> SqliteDiagnosticianCommitter -> CandidateIntakeService -> Ledger |
| M8-D07 | All 5 UAT items must pass for M8 SHIPPED | D-07 locked decision; m8-03-01-PLAN.md verification section |
| M8-D09 | Legacy NOT revived: no new entries in .state/diagnostician_tasks.json, diagnostician_report_*.json, evolution_complete_* | DEL-01 through DEL-05 from REQUIREMENTS.md; baseline diff in Task 7 |
