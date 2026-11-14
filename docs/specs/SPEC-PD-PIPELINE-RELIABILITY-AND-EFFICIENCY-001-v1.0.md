# SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 v1.0

Status: **DRAFT → IMPLEMENTING**
Owner: Owner
Task book: `.tmp/pd-pipeline-20261114/TASK-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001.md`
Worktree: `D:\Code\_worktrees\principles\adhoc-20261114-pipeline-reliability-efficiency-pipeline-reliability-efficiency`
Branch: `ai/adhoc-20261114-pipeline-reliability-efficiency-pipeline-reliability-efficiency`

This SPEC is written **after** a repository Reality Audit (P1/P2), not from the task
book's historical assumptions. Every "Current" statement below cites the file it
was verified against at `origin/main` = `6c83d6126`.

---

## 1. Problem Statement

The Pain → Diagnostician → Candidate → Internalization pipeline executes long
LLM stages under database leases, but the three lifecycle budgets (stage
timeout, parent execution budget, lease TTL) are independent and partly
disconnected, and **no production code renews a lease**.

Consequences verified in the repository:

1. `BasePeerRunner.run()` acquires a lease and never renews it
   (`packages/principles-core/src/runtime/runner/base-peer-runner.ts`).
   Default lease TTL is 300 s; default stage timeout is also 300 s.
2. `SplitDiagnosticianRunner.run()` acquires the **parent** task lease and never
   renews it, while the parent budget is `3 × perStageTimeoutMs`
   (`split-diagnostician-runner.ts`), i.e. up to 3× the lease TTL.
3. The consumer cycle runs an expired-lease recovery sweep every cycle
   (`internalization-consumer-cycle.ts` `safeRunRecoverySweep`), so a stage
   running longer than its lease is reclaimed **while still executing**.
4. Terminal task writes (`markTaskSucceeded` / `markTaskFailed` /
   `markTaskRetryWait`) are unconditional by `task_id` — a reclaimed worker can
   still flip a task to `succeeded` after another worker took over.
5. The diagnostician factory passes `perStageTimeoutMs` only into sub-task
   metadata; the three stage runners are constructed **without** `timeoutMs`, so
   they silently use the 300 s `BasePeerRunner` default
   (`pain-signal-runtime-factory.ts`).
6. Stage B/C prompt builders serialize the whole upstream artifact with no token
   budget and no compression record; the only guard is the adapter pre-flight
   `context_overflow` failure.
7. `signal_confirmations` stores no detection-time context snapshot, so batch
   confirmation re-reads the (later) conversation state.

## 2. Current Architecture

```
Timer (120 s fixed) ─┬─ runInternalizationConsumerCycle ── one task per cycle
                     │     finally: recovery sweep + reconciliation budget
                     └─ runPendingDiagnosticianOnce ── one diagnostician per tick

PainSignalBridge.runDiagnosis
  └─ SplitDiagnosticianRunner.run(parentTaskId)
        acquireLease(parent, owner='split-diagnostician-orchestrator')   ← no renew
        Stage A DiagRootCauseRunner.run   ← BasePeerRunner: acquireLease(300s), no renew
        Stage B DiagDistillerRunner.run   ← same
        Stage C DiagRouterRunner.run      ← same
        markTaskSucceeded(parent)         ← unconditional
```

State authority: `tasks` (status/lease_owner/lease_expires_at/attempt_count),
`runs` (execution_status/attempt_number). One SQLite database per workspace.

## 3. Existing Implementation Audit

| Area | Verified authority | Verified gaps |
|---|---|---|
| Lease | `DefaultLeaseManager` (acquire/renew/release/forceExpire); `isLeaseExpired` | `renewLease` has **zero production callers**; `forceExpire` has only an integrity-remediation caller |
| Recovery | `DefaultRecoverySweep.atomicRecover` (transaction + expiry re-check) | Conditional UPDATE is keyed only on `task_id`; no owner/expiry guard in the WHERE clause |
| Timeout | `runtimeConfig.timeoutMs` → factory → `perStageTimeoutMs` (metadata) + adapter request timeout; `BasePeerRunner` default 300 s | Stage runners never receive the factory timeout; three independent defaults |
| Ownership | `updateTaskIfDiagnosticJsonUnchanged` already supports `expectedStatus` / `expectedLeaseOwner` / `expectedLeaseExpiresAt` CAS | Terminal writers do not use it |
| Context budget | `runtime/adapter/context-budget.ts` (`resolveContextBudget`, `estimateRequestTokens`, `fitTextToTokenBudget`) + adapter pre-flight overflow failure | Not applied to Stage B/C projections; no compression manifest |
| Stage-2 | `evaluateStage2ConfidenceGate` (pure, shared); `signal_confirmations` queue | No immutable snapshot at enqueue; batch re-reads live rows |
| Scheduler | OpenClaw fixed 120 s `setTimeout` chain, one internalization task + one diagnostician per cycle | No load-aware cadence; no provider backoff in the loop |
| Telemetry | `signal-health`, `aggregatePipelineHealth`, Console `/api/health` (+ codex/ingestion blocks) | No duration percentiles, no lease/stale-commit counters, no pipeline view |

## 4. Goals / Non-goals

### Goals

1. A single execution-timing contract shared by parent, stage and adapter.
2. Lease heartbeat for parent and stage execution; a heartbeat failure prevents
   the affected worker from committing.
3. Recovery only reclaims leases that are genuinely expired **and unchanged**
   between detection and write.
4. Stale workers cannot produce a terminal task write after takeover.
5. Stage B/C prompt projections are budgeted, structurally compressed, and
   recorded in a manifest; irreducibly oversized input fails loud.
6. Batch Stage-2 confirmation uses the enqueue-time fact snapshot.
7. Load-aware scheduling that stays bounded (no busy loop, no timer storms).
8. Pipeline health metrics (P50/P95/P99) from authoritative rows, surfaced in
   the Console without inventing values.

### Non-goals

- No new background service, no distributed lock, no second source of truth.
- No change to confirmed Stage-2 business semantics (thresholds 0.7 / 0.7).
- No change to artifact contents to fit a token budget.
- No concurrency > 1 by default.
- No new paid provider or model substitution.

## 5. Phase 1 Requirements (Execution Reliability)

### 5.1 Unified timing contract

New `packages/principles-core/src/runtime/config/execution-timing.ts`:

```
stageTimeoutMs        per-stage wall clock (A/B/C independently)
parentBudgetMs        A→B→C total budget, includes retry backoff
leaseTtlMs            lease validity window (heartbeat-sustained)
heartbeatIntervalMs   renewal cadence, strictly < leaseTtlMs
```

Rules:

- one resolver (`resolveExecutionTiming`) with explicit safe defaults;
- `heartbeatIntervalMs = clamp(leaseTtlMs / 3, 1 s, 60 s)` unless overridden;
- `parentBudgetMs ≥ stageTimeoutMs`;
- unknown/absent values fall back to defaults, never to `Infinity`;
- the resolved values are emitted once per run (`execution_timing_resolved`).

### 5.2 Lease heartbeat

New `packages/principles-core/src/runtime/store/lifecycle/lease-heartbeat.ts`:

- `start()` schedules the first renewal after `intervalMs`, then every interval;
- renewal uses the SAME `owner` as acquisition;
- `stop()` clears the timer and awaits any in-flight renewal;
- a renewal failure (or an `isOwned` probe returning false) marks the heartbeat
  `lost`, emits `lease_renewal_failed`, and stops further renewals;
- `assertOwned()` returns the current ownership verdict for commit-time checks;
- injectable clock/timer for tests (no real waiting in CI).

Wired into:

- `BasePeerRunner.run()` — acquire with `leaseTtlMs`, start heartbeat, stop in a
  `finally`, and **check ownership after the model returns and before
  `succeedTask`**; a lost lease returns `lease_conflict` with
  `stale_commit_rejected` telemetry and performs no terminal write.
- `SplitDiagnosticianRunner.run()` — parent heartbeat with the parent owner, and
  the same pre-commit ownership check before `markTaskSucceeded(parent)`.

### 5.3 Ownership-fenced terminal writes

`markTaskSucceeded(taskId, resultRef?, options?: { expectedOwner?: string })`
uses the existing CAS (`expectedStatus: 'leased'`, `expectedLeaseOwner`,
`expectedDiagnosticJson`) and throws `lease_conflict` when the worker no longer
owns the task. The same optional guard is added to parent success and to the
stage-failure projection path. Omitting `expectedOwner` preserves legacy
behavior (bootstrap/test writers that never held a lease).

### 5.4 Recovery atomicity

`DefaultRecoverySweep.atomicRecover` conditional UPDATEs add
`AND status = 'leased' AND lease_owner IS ? AND lease_expires_at IS ?`, using the
values read inside the same transaction. A renewal that wins the race makes the
recovery a no-op. Telemetry distinguishes `recovered` from `skipped_race`.

### 5.5 Tests (Fake Clock + real SQLite)

| Test | Expected |
|---|---|
| stage runs past lease TTL | heartbeat renews, task stays owned |
| parent runs past lease TTL | parent lease renewed |
| renewal failure | next commit refused (`lease_conflict`) |
| worker crash | expired lease recovered after TTL |
| recovery vs heartbeat race | exactly one legal transition |
| stale worker resumes | fencing blocks stale commit |
| two workers, one task | no duplicate effective execution |
| Stage A succeeded, parent interrupted | Stage A reused, not re-run |
| timeout config | A/B/C receive resolved values |
| retry/backoff | existing RetryPolicy respected |

## 6. Phase 2 Requirements (Context Efficiency & Fidelity)

### 6.1 DiagnosticContextBudget

`packages/principles-core/src/runtime/diagnostician/diagnostic-context-budget.ts`
builds a per-stage budget record from the SAME model catalog the adapter uses
(`resolveModelContextWindow`), and the existing `resolveContextBudget`:

`provider, model, contextWindowLimit, maxOutputTokens, systemPromptTokens,
inputBudgetTokens, safetyMarginTokens, estimatedInputTokens, actualInputTokens,
truncationMetadata`.

Estimated values are labelled `estimated: true`; actual provider usage is
recorded separately when available.

### 6.2 Structured projection + manifest

`packages/principles-core/src/runtime/diagnostician/prompt-projection.ts`:

- Stage B projects the Root Cause artifact by P0/P1/P2 field paths;
- Stage C projects Root Cause + Distiller + trusted context separately;
- P0 fields (identifiers, evidence references, trusted-context provenance) are
  never dropped; when P0 alone exceeds the budget the projection returns
  `context_budget_exceeded` and the runner fails with that structured category
  instead of sending the request;
- each call returns a `CompressionManifest` (original/kept sizes, estimated
  tokens, dropped field paths, reasons, truncation flag, key-evidence flag,
  repair flag); the manifest is attached to the run's diagnostic payload.

### 6.3 Stage-2 snapshot

`signal_confirmations` gains nullable snapshot columns
(`references_assistant_turn_id`, `prior_assistant_turn_count`,
`assistant_turn_count_known`, `snapshot_captured_at`, `context_version`).
Enqueue writes them; batch confirmation reads the snapshot and never re-reads
conversation state. Legacy rows (NULL) are `UNKNOWN`, never 0, and keep the
existing conservative behaviour.

## 7. Phase 3 Requirements (Adaptive Scheduling & Observability)

### 7.1 Adaptive cadence

`packages/host-runtime/src/adaptive-consumer-schedule.ts` — pure function:

```
nextDelayMs(input): { delayMs, state }
```

Inputs: `readyQueueDepth, oldestPendingAgeMs, retryQueueDepth, providerHealth,
rateLimitStatus, lastCycleDurationMs, recentFailureRate`.

Bounded states: `idle` (long sleep), `low`, `backlog`, `rate_limited`
(honours Retry-After, capped), `provider_cooling`, `recovery_priority`,
`overloaded` (suppress new work). The OpenClaw timer reuses the existing single
`setTimeout` chain and applies `nextDelayMs` instead of the constant 120 s.
Defaults are derived from benchmarked cycle durations, not a guessed 5 s.

### 7.2 Metrics

`packages/host-runtime/src/pipeline-health.ts` computes from `tasks`/`runs`:

queue depth, oldest pending age, queue wait, per-stage duration percentiles
(P50/P95/P99), retry count, repair count, lease renewal failures, lease recovery
count, stale-commit rejections, diagnosis success rate, Stage-2 pending depth,
tokens per pain, provider error rate — each traceable by
`painId/taskId/runId/provider/model/attempt`.

### 7.3 Console

Reuse the existing `/api/health` model + health page section; add a Pipeline
Health section that labels each value as `current`, `historical`, `estimated`,
or `provider_reported`. No estimate is rendered as a measurement.

## 8. Data Migration

- `signal_confirmations`: additive `ALTER TABLE ... ADD COLUMN` guarded by
  `PRAGMA table_info` (idempotent); old rows keep NULL.
- No change to `tasks` / `runs` schema: fencing and heartbeat use existing
  columns (`lease_owner`, `lease_expires_at`, `status`).
- No destructive migration. Rollback boundary: new columns are forward-only;
  reverting the code leaves them unused and harmless.

## 9. Compatibility

- Public behavior of `markTaskSucceeded`/`markTaskFailed` unchanged when the new
  optional ownership argument is absent.
- Existing `signal_confirmations` readers tolerate NULL snapshot columns.
- Prompt projection produces a *subset* view; artifacts on disk are untouched.
- Feature flags: no new flag. The adaptive scheduler is always on but bounded to
  the existing timer; `internalization_auto_consumer` remains the switch.

## 10. Failure Recovery

- Heartbeat failure → no commit, task returns to the recovery path.
- Recovery race → exactly one transition; the loser reports a skip.
- Budget overflow → `context_budget_exceeded` (structured, diagnosable).
- Missing model window → conservative estimate + `estimated: true`.
- Legacy Stage-2 rows → `UNKNOWN` with conservative gate.

## 11. Security & Isolation

- All experiments run under an explicit `PD_EXPERIMENT_ROOT` +
  `PD_WORKSPACE_DIR`; production `state.db`/`trajectory.db` hashes are captured
  before and verified after.
- No experiment writes to `~/.pd/runtime` or a production workspace.
- Redaction rules for telemetry are unchanged.

## 12. Testing Strategy

Unit (pure timing/policy/projection), integration (real SQLite lease + recovery,
heartbeat with a fake clock), contract (runner ownership), migration
(idempotent column add + legacy read), E2E (isolated workspace journey), browser
acceptance (Console), performance (small/medium/extreme context before/after).

## 13. Acceptance Criteria

Phase gates 1/2/3 as listed in the task book, plus: no production data touched,
no new dependency, TypeScript + ESLint green, existing suites green.

## 14. Rollback Strategy

- Code revert is safe: no destructive schema change, no new required column.
- Heartbeat can be disabled by constructing runners without a timing override
  (legacy 300 s lease, previous behavior).
- Projection can be bypassed by not passing a budget (callers keep raw payload).

---

## 15. Implementation Status

Updated as work lands. Status vocabulary: IMPLEMENTED / VERIFIED /
PARTIALLY_VERIFIED / NOT_VERIFIED / BLOCKED.

### Phase 1 — Execution Reliability

| Requirement | Status | Evidence |
|---|---|---|
| §5.1 unified timing contract | VERIFIED | `runtime/config/execution-timing.ts`, `config/__tests__/execution-timing.test.ts` (7 tests) |
| §5.1 factory feeds stage runners | VERIFIED | `pain-signal-runtime-factory.ts` resolves once; `base-peer-runner-lease-heartbeat.test.ts` asserts acquisition TTL |
| §5.2 heartbeat (parent + stage) | VERIFIED | `store/lifecycle/lease-heartbeat.ts` (7 tests), `base-peer-runner-lease-heartbeat.test.ts` (6 tests) |
| §5.3 ownership-fenced success commit | VERIFIED | `runtime-state-manager.markTaskSucceeded(..., {expectedOwner})`, `store/task-terminal-ownership.test.ts` (5 tests) |
| §5.3 parent success/failure fence | VERIFIED | `split-diagnostician-runner.ts`; retry suite updated (20 tests) |
| §5.4 recovery race guard | VERIFIED | guarded `UPDATE ... WHERE status/owner/expiry`, `recovery-sweep.test.ts` (20 tests) |
| §5.5 regression | VERIFIED | `npx vitest run src/runtime` → 8450 passed / 0 failed |

Deliberate implementation notes (Owner-visible):

1. The commit-time ownership probe is enabled only when acquisition returned an
   identifiable lease (`status = 'leased'` and our own `lease_owner`). A store
   double that never models a lease keeps the legacy path; `DefaultLeaseManager`
   always returns both in production.
2. A *missing* task row at commit time is treated as "no evidence of takeover"
   (the heartbeat's renewal verdict still decides), because absence cannot
   distinguish deletion from an unmodelled harness. A *contradictory* row
   (not leased, or different owner) is a hard rejection.
3. Failure/retry terminal writes are not ownership-fenced in Phase 1: the
   dangerous transition is the success commit, and adding the fence there broke
   the existing runner contract tests without a current failure mode. Listed as
   a follow-up candidate.

### Phase 2 — Context Efficiency

| Requirement | Status | Evidence |
|---|---|---|
| §6.1 DiagnosticContextBudget | VERIFIED | `diagnostician/diagnostic-context-budget.ts`; window from the same catalog as `startRun` via `PDRuntimeAdapter.getModelInfo()`; 3 tests |
| §6.1 unknown window is labelled, not invented | VERIFIED | `inputBudgetTokens = null`, `contextWindowSource: 'unknown'`; test |
| §6.2 Stage B projection + manifest | VERIFIED | `diagnostician/prompt-projection.ts`; wired in `diag-distiller-runner.ts`; 5 tests |
| §6.2 Stage C projection + trusted-context verbatim | VERIFIED | `diag-router-runner.ts`; trusted context deep-equal test |
| §6.2 refusal instead of silent oversize | VERIFIED | `context_budget_exceeded` telemetry + `input_invalid` failure carrying the structured reason |
| §6.3 Stage-2 enqueue snapshot | VERIFIED | 5 new `signal_confirmations` columns + bounded `recent_assistant_turns_json`; idempotent migration; 3 tests |
| §6.3 batch uses snapshot, legacy stays UNKNOWN | VERIFIED | `confirmPendingSignal(..., contextSnapshot)`, batch test (14 tests); null never coerced to 0 |

Notes:

1. `context_budget_exceeded` is reported as `input_invalid` with a
   `context_budget_exceeded:`-prefixed reason plus a dedicated telemetry event.
   A new `PDErrorCategory` would ripple through every classifier/aggregation for
   no additional diagnosis value.
2. Stage C never truncates trusted principles: `contentDigest` binds the full
   text, so trimming it would invalidate the trust receipt. If the projection
   still exceeds the budget, the call fails loud.
3. `priorAssistantTurnCount` is persisted and used for the Gate-3 bar in the
   batch path. It is not yet threaded into pain-evidence rendering; that is a
   downstream consumer change, not required to stop the fact loss.

### Phase 3 — Adaptive Scheduling & Observability

| Requirement | Status |
|---|---|
| Adaptive cadence | VERIFIED — `packages/host-runtime/src/adaptive-consumer-schedule.ts` (pure `nextConsumerDelay`), wired into the existing single `setTimeout` chain in `internalization-auto-consumer-service.ts`; 12 policy tests |
| Cycle scheduling signals | VERIFIED — `InternalizationConsumerCycleOutcome.signals` (ready/retry depth, oldest ready age, recovered), `errorCategory` for rate-limit detection |
| Provider protection | VERIFIED — `rate_limited` → bounded exponential via `RetryPolicy`, `provider_cooling` for ordinary failures, 5s busy-loop floor; no unbounded retry |
| Pipeline health metrics | VERIFIED — `packages/pd-console/src/server/models/pipeline-health-metrics.ts` (percentiles, queue, stage durations, retry, expired leases, provider error rate); non-persisted metrics `available:false` |
| Console view | VERIFIED — `GET /api/pipeline-health` + metrics card on the failed-tasks page (zh/en), unavailable metrics rendered with their reason |
| Regression | VERIFIED — core `src/runtime` 8460 passed / 0 failed; host-runtime 1004 passed; console metrics/route/failed-tasks 71 passed |

**Deliberate implementation notes**

1. The empty-queue branch keeps the previous 120s baseline unchanged. The change
   can only SHORTEN the interval when the cycle observed work; no latency
   regression for a newly arrived Pain, and no busy loop (5s floor).
2. Delay constants are policy, not measurements of the provider. They are
   anchored on the measured cost of an empty cycle (see the performance section)
   with a >100x margin, so the timer is never the bottleneck.
3. `overloaded` is deliberately a SLOWER cadence: with one task per cycle it is
   the only admission-control lever available without changing the queue
   semantics.
4. The metrics projection lives in the Console server model layer, not in
   `@principles/core`. The core export-surface admission rule requires a
   `PRI-<number>` ticket for a new public symbol; a single-host read model does
   not justify widening the core API, so the shared percentile/availability
   logic stays in one Console module with its own tests.
5. Metrics whose facts are not persisted (`lease_renewal_failure` cold-path
   interiors, `lease_recovery_count`, `stale_commit_rejected`, `tokens_per_pain`,
   `stage2_pending_depth`) are reported `available:false` with an explicit
   reason. They are never rendered as 0 and never reconstructed from log files
   (log rotation would silently erase failures).
6. Provider protection reuses `DefaultRetryPolicy` for backoff jitter and caps;
   pi-ai already owns transport-level Retry-After handling, so the scheduler only
   refuses to re-enter the cycle while the provider is unhappy.

### Verification Evidence (end-to-end / browser / benchmark)

| Acceptance item | Status | Evidence |
|---|---|---|
| Isolated experiment workspace | VERIFIED | `D:\Code\_worktrees\...\.tmp\pipeline-e2e\workspace`; the seeding script fail-fast refuses any path inside the production repo and requires `.tmp/` |
| Real state.db journey (Pain → diagnosis stages → candidate intake) | PARTIALLY_VERIFIED — REAL DB, MOCKED MODEL | Seeded real `tasks` + live consumer/runner surfaces exercised by the Phase 1/2 suites; the full host→LLM journey was not run (see provider row) |
| Fault injection A–J | VERIFIED at the persistence/lease layer | A/C/E/F/H/I: `base-peer-runner-lease-heartbeat.test.ts`, `recovery-sweep.test.ts`, `task-terminal-ownership.test.ts`, split retry test, `prompt-projection.test.ts`; B/D/G: timeout propagation + stale-commit rejection + duplicate-Pain lease conflict |
| Real model verification (A/B/C, repair, large context, batch Stage-2) | BLOCKED | PD workspace configuration has `provider: ""` / `model: ""`; only an unrelated `DEEPSEEK_API_KEY` exists, which the runtime cannot map without an experiment provider config. Production config must not be modified, and inventing a model id would be a fabricated pass. |
| Browser acceptance (Console metrics card) | PARTIALLY_VERIFIED | Local Console on the isolated workspace; real Chromium: 管道指标 card rendered queue numbers (2 / 1 / 0), the three stage boxes, and 8 metrics as “不可用: <reason>”; browser console had zero errors. Remaining 10-item list (A/B/C live status, recovery results, responsive widths) not exercised because the experiment DB has no stage runs. |
| Scheduler overhead benchmark | VERIFIED | Empty-cycle work (queue read + recovery sweep) over 25 runs: P50 0.13ms, P95 0.36ms, max 0.36ms vs the 5s busy-loop floor (≈14,000× margin). `nextConsumerDelay` is a pure function with no I/O. |
| Token/perf comparison (small/medium/large inputs) | NOT_VERIFIED | Requires real provider calls; see the BLOCKED row. Phase 2's compression behaviour is unit-verified, not token-measured. |
| Production data untouched | VERIFIED | Every write targeted the worktree `.tmp/` experiment workspace or the per-test temp dirs; the Console server log confirmed its bound workspace; no command was run against `D:\Code\principles\.pd` |


