# M4: Diagnostician Runner v2 — Requirements

> Status: Active
> Date: 2026-04-23
> Predecessor: M3 History Retrieval + Context Build (PR #392, #393, m3-08/m3-09 closure pending)
> Source: runtime-v2-milestone-roadmap.md Section M4, diagnostician-v2-detailed-design.md

## 1. Goal

Replace heartbeat-prompt-driven diagnostician execution with explicit runner-driven execution.

The diagnostician must become a deterministic PD execution chain:
- task leased through M2 lease manager
- context assembled by M3 PD-owned retrieval
- runtime invoked through PDRuntimeAdapter
- output validated by DiagnosticianValidator
- state advanced by runner (not by LLM side effects)

Heartbeat prompt injection ceases to be the primary diagnostician execution path. It becomes at most a trigger/liveness signal.

## 2. Scope (IN Scope)

### 2.1 DiagnosticianRunner

The central orchestrator that manages one diagnostician task lifecycle:

```
lease task -> build context -> start run -> wait/poll -> fetch output -> validate -> succeed/fail task
```

Required behavior:
- Lease a pending diagnostician task from SqliteTaskStore
- Build DiagnosticianContextPayload via SqliteContextAssembler (M3)
- Create a RunRecord for the execution attempt
- Invoke runtime adapter with DiagnosticianInvocationInput
- Poll until terminal state or timeout
- Fetch structured output
- Pass output to DiagnosticianValidator
- On valid: transition task to succeeded, register result
- On invalid or failure: attach failure reason, release or retry task

### 2.2 Runtime Invocation Path

Diagnostician must execute through `PDRuntimeAdapter.startRun()`, not through:
- heartbeat prompt injection
- direct prompt text appended to a session
- marker file side effects

The invocation path:
1. Runner constructs `StartRunInput` with `agentSpec: diagnostician`
2. Runner calls `runtimeAdapter.startRun(input)`
3. Runner polls via `runtimeAdapter.pollRun(runId)`
4. Runner fetches output via `runtimeAdapter.fetchOutput(runId)`

First adapter implementation: `TestDoubleRuntimeAdapter` for deterministic testing.
Production adapter: deferred to M6 (OpenClaw adapter demotion) unless early integration is needed.

### 2.3 DiagnosticianValidator

Validates `DiagnosticianOutputV1` before any state advancement:

- Schema correctness (TypeBox validation against DiagnosticianOutputSchema)
- Non-empty summary and rootCause
- Task identity match (output.taskId === leased task.taskId)
- Bounded evidence array
- Recommendations array shape
- Confidence range [0, 1]
- Best-effort evidence back-check (sourceRef existence)

On validation failure:
- Task must NOT be marked succeeded
- No success artifact may be registered
- Failure reason attached to task/run state
- Output categorized into PDErrorCategory.output_invalid

### 2.4 Runner State Transitions

The runner manages task state transitions explicitly:

```
pending -> leased (via LeaseManager)
leased -> running (internal runner state, not a TaskStatus)
running -> validating (internal)
validating -> succeeded (via TaskStore.updateTask)
validating -> retry_wait (via RetryPolicy + TaskStore)
running -> retry_wait (on runtime failure)
running -> failed (on max_attempts_exceeded)
```

Internal runner states are NOT new TaskStatus values. They are runner-local tracking.
Only TaskStatus values from M1 contracts (pending/leased/succeeded/retry_wait/failed) are persisted.

### 2.5 Retry / Lease Interaction

The runner interacts with M2 infrastructure:
- `DefaultLeaseManager` for task ownership
- `DefaultRetryPolicy` for backoff decisions
- `DefaultRecoverySweep` for stale lease cleanup (not modified, but tested with runner)

Retry categories (from diagnostician-v2-detailed-design.md Section 14.4):
- `runtime_unavailable` -> retry
- `timeout` -> retry
- `output_invalid` -> retry up to limit
- `context_assembly_failed` -> retry only if likely transient
- `capability_missing` -> do not retry on same runtime

### 2.6 Compatibility with Imported OpenClaw History Context

The runner must work correctly with tasks that have:
- Imported `openclaw-history` runs (M3 m3-08 fix)
- Time windows spanning imported history entries (M3 m3-09 fix)
- Mixed runtime_kind values in run records

This is a non-negotiable compatibility requirement, not a stretch goal.

### 2.7 Telemetry / Observability

From the first runner version:
- Emit `diagnostician_task_leased` event
- Emit `diagnostician_context_built` event
- Emit `diagnostician_run_started` event
- Emit `diagnostician_run_failed` event (on runtime failure)
- Emit `diagnostician_output_invalid` event (on validation failure)
- Emit `diagnostician_task_succeeded` event
- Emit `diagnostician_task_retried` event
- Emit `diagnostician_task_failed` event (on max attempts)

All events use M2 `StoreEventEmitter` and `TelemetryEvent` infrastructure.

### 2.8 Minimal CLI Surface

New commands:
- `pd diagnose run --task-id <id>` — execute diagnostician for a leased task
- `pd diagnose status --task-id <id>` — inspect diagnostician task state

These are thin CLI wrappers over the runner, not independent implementations.

## 3. Non-Goals (OUT of Scope)

The following are explicitly excluded from M4:

1. **Unified commit / principle candidate intake** — M5 scope. M4 does NOT implement DiagnosticianCommitter, principle candidate artifacts, or principle candidate consumer.
2. **Plugin demotion** — M6 scope. The evolution-worker and prompt.ts heartbeat injection continue to exist. M4 introduces the new runner path but does not remove the legacy path.
3. **Multi-runtime full rollout** — M8 scope. M4 uses TestDoubleRuntimeAdapter for testing. Production OpenClaw adapter is M6 work.
4. **Broader PD CLI redesign** — M7 scope. M4 adds only the minimal `pd diagnose` commands needed for runner execution.
5. **Nocturnal / rulehost execution migration** — Separate track. M4 only migrates diagnostician.
6. **Marker file removal** — Legacy compatibility outputs remain. M4 runner does not write marker files, but the legacy path continues to.
7. **LLM prompt template redesign** — The diagnostician's system prompt content is not in M4 scope. M4 changes HOW the prompt is delivered (runtime adapter vs heartbeat injection), not WHAT the prompt says.

## 4. Exit Criteria

M4 is minimally complete when:

1. A diagnostician task can complete through explicit run + validation flow WITHOUT heartbeat prompt injection as the primary path
2. The runner correctly uses M3 context assembly (SqliteContextAssembler) for context building
3. The runner correctly uses M2 lease/retry infrastructure (LeaseManager, RetryPolicy)
4. Output validation rejects malformed DiagnosticianOutputV1 before task state advances
5. Telemetry events are emitted for all runner state transitions
6. The runner handles imported openclaw-history context without errors
7. `pd diagnose run --task-id <id>` executes the full runner flow via CLI
8. Test coverage >= 80% for new runner code
9. No hidden dependence on heartbeat prompt path in the runner code path
10. Dual-track: legacy heartbeat path remains functional, new runner path is the primary execution

## 5. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Hidden dependence on old prompt path | CRITICAL | Runner code must not import from prompt.ts or evolution-worker.ts |
| Incomplete runtime invocation path | HIGH | TestDoubleRuntimeAdapter provides complete contract coverage |
| M5 commit logic leaking into M4 | HIGH | Strict phase boundary: runner validates output, does NOT commit artifacts |
| Context assembly assumptions breaking runner | MEDIUM | Runner uses M3 SqliteContextAssembler as-is, no modifications |
| Lease/retry interaction bugs | MEDIUM | Integration tests with M2 DefaultLeaseManager and DefaultRetryPolicy |
| Runtime adapter interface gaps | MEDIUM | PDRuntimeAdapter already defined in M1, runner is first real consumer |
| Heartbeat path accidentally broken | MEDIUM | M4 does NOT modify evolution-worker.ts or prompt.ts |
| Telemetry event schema drift | LOW | Reuse M2 TelemetryEvent infrastructure, extend with diagnostician events |

## 6. Execution Constraints

These constraints are mandatory for M4:

1. **Diagnostician primary execution path must NOT depend on heartbeat prompt injection**
2. **Heartbeat is only a trigger/health signal, not the authoritative execution path**
3. **LLM produces reasoning only — does NOT perform durable state mutation**
4. **Task/run truth continues to use runtime-v2 store (M2 baseline, frozen)**
5. **Context build MUST reuse M3 PD-owned retrieval path (SqliteContextAssembler)**
6. **Runner must work through explicit runtime invocation path (PDRuntimeAdapter)**
7. **Compatibility import is data source only, must NOT become primary execution mechanism**
8. **Telemetry/observability must exist from the first runner version**
9. **No new TaskStatus values — use M1 PDTaskStatus only**
10. **No modifications to M2 store implementations — runner consumes them, does not extend them**
11. **No DiagnosticianCommitter — that is M5 scope. M4 runner succeeds/fails the task but does not write artifacts**
12. **No principle candidate emission — that is M5 scope**
13. **M4 success does NOT require production OpenClaw adapter rollout — TestDoubleRuntimeAdapter is sufficient for verification**
14. **No modifications to evolution-worker.ts task shape or prompt.ts fields — if runner needs these changes, the runner design is not solid**
15. **OpenClaw native adapter integration is optional/deferred unless it can be added without changing runner semantics**

## 7. Dependencies

### Code Dependencies (M1-M3 Baseline)

| Location | Purpose | Milestone |
|----------|---------|-----------|
| `runtime-v2/runtime-protocol.ts` | PDRuntimeAdapter interface, RuntimeKind, RunHandle, StartRunInput | M1 |
| `runtime-v2/agent-spec.ts` | AgentSpec schema | M1 |
| `runtime-v2/task-status.ts` | TaskRecord, DiagnosticianTaskRecord, PDTaskStatus | M1 |
| `runtime-v2/context-payload.ts` | DiagnosticianContextPayload, DiagnosisTarget | M1 |
| `runtime-v2/diagnostician-output.ts` | DiagnosticianOutputV1 schema | M1 |
| `runtime-v2/error-categories.ts` | PDErrorCategory | M1 |
| `runtime-v2/event-emitter.ts` | StoreEventEmitter, TelemetryEvent | M2 |
| `runtime-v2/store/sqlite-task-store.ts` | Task CRUD with TypeBox validation | M2 |
| `runtime-v2/store/sqlite-run-store.ts` | Run CRUD with attempt tracking | M2 |
| `runtime-v2/store/sqlite-context-assembler.ts` | Context assembly from TaskStore + HistoryQuery + RunStore | M3 |
| `runtime-v2/store/sqlite-history-query.ts` | Bounded history retrieval | M3 |
| `runtime-v2/store/sqlite-trajectory-locator.ts` | Trajectory candidate discovery | M3 |
| `runtime-v2/lease-manager.ts` | Lease acquire/renew/release | M2 |
| `runtime-v2/retry-policy.ts` | Exponential backoff, max attempts | M2 |
| `runtime-v2/recovery-sweep.ts` | Stale lease cleanup | M2 |
| `runtime-v2/runtime-state-manager.ts` | Integration layer wiring all stores | M2 |
| `runtime-v2/runtime-selector.ts` | RuntimeKind selection interface | M1 |

### Canonical Documents

| Document | Path | Relevance |
|----------|------|-----------|
| Architecture v2 | `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` | Sections 8 (Runtime Protocol), 13 (Diagnostician v2), 22 (Refinements) |
| Protocol Spec v1 | `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` | Sections 6 (Adapter Contract), 9 (Run Lifecycle), 10 (StartRunInput), 18 (Diagnostician Execution) |
| Diagnostician v2 Design | `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` | Sections 14 (Runner), 10 (Runtime Invocation), 11 (Output Schema), 12 (Validator), 16 (Observability) |
| Agent Execution Modes | `docs/pd-runtime-v2/agent-execution-modes-appendix.md` | Section 4 (Execution Mode Taxonomy), Section 5.1 (Diagnostician priority) |
| History Retrieval SPEC | `docs/pd-runtime-v2/history-retrieval-and-context-assembly-spec.md` | Section 9 (context build), Section 15 (Relationship to Diagnostician v2) |
| Milestone Roadmap | `docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md` | Section M4 definition |
| GSD Governance | `docs/pd-runtime-v2/gsd-execution-governance.md` | Sections 3 (Constraints), 5 (Review Questions), 9 (GSD Usage) |
| Conflict Table | `docs/pd-runtime-v2/conflict-table.md` | Legacy type overlap reference for migration awareness |

### Legacy Code Anchors (NOT to be modified, but understood)

| Location | Role | M4 Relationship |
|----------|------|-----------------|
| `openclaw-plugin/src/service/evolution-worker.ts` | Legacy task creation, queue management, marker file detection | Runner REPLACES this execution path. Evolution-worker may still CREATE tasks, but runner EXECUTES them. |
| `openclaw-plugin/src/hooks/prompt.ts` | Heartbeat prompt injection for diagnostician | Runner REPLACES this as primary execution. Heartbeat continues as legacy fallback during dual-track. |
| `openclaw-plugin/src/core/nocturnal-trinity.ts` | TrinityRuntimeAdapter pattern (existing runtime adapter precedent) | Runner uses SIMILAR adapter pattern via PDRuntimeAdapter. Trinity is a reference, not a dependency. |
| `openclaw-plugin/src/core/pd-task-types.ts` | Legacy PDTaskSpec types | Not imported by runner. M1 TaskRecord is the canonical type. |
| `openclaw-plugin/src/core/pd-task-store.ts` | Legacy task store | Not imported by runner. M2 SqliteTaskStore is the canonical store. |

## 8. Suggested Phase Decomposition

### m4-01: DiagnosticianRunner Core
Runner lifecycle, state transitions, lease integration, context assembly invocation.
The runner itself without runtime adapter details.

### m4-02: TestDoubleRuntimeAdapter + Runtime Invocation
Implement PDRuntimeAdapter test double, wire runner to adapter via StartRunInput.
First real consumer of the M1 PDRuntimeAdapter interface.

### m4-03: DiagnosticianValidator
Schema validation, semantic checks, evidence back-check, failure categorization.
Independent of runner, consumed by runner.

### m4-04: Retry/Lease/Recovery Integration
Runner interaction with DefaultLeaseManager, DefaultRetryPolicy, DefaultRecoverySweep.
Integration tests for crash recovery, concurrent execution, expired lease scenarios.

### m4-05: Telemetry + CLI Surface
Diagnostician-specific events, `pd diagnose run/status` commands.
Thin wrappers that delegate to runner.

### m4-06: Dual-Track Verification + E2E Test
Verify legacy heartbeat path still works alongside new runner path.
End-to-end test: task creation -> context build -> runner execution -> validation -> success.
Compatibility with imported openclaw-history context.

## 9. What M4 Is NOT

To prevent scope drift, M4 is explicitly NOT:

- A rewrite of the evolution worker
- A removal of the heartbeat path
- A new artifact storage system
- A principle creation pipeline
- A plugin architecture change
- A multi-runtime adapter suite
- A CLI redesign
- A nocturnal execution migration
- A prompt template redesign

M4 is ONE thing: **a runner that makes diagnostician execution explicit, validated, and observable instead of prompt-driven and marker-inferred.**
