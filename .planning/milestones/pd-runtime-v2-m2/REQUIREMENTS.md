# M2: Task/Run State Core — Requirements

> Status: Active
> Date: 2026-04-22
> Predecessor: M1 Foundation Contracts (merged PR #392)
> Source: runtime-v2-milestone-roadmap.md Section M2

## 1. Goal

Introduce explicit PD-owned task and run truth with lease semantics.

This milestone replaces the current implicit task state model (marker files, queue JSON side effects, heartbeat-driven completion inference) with a deterministic, PD-owned task/run state layer.

## 2. Scope (IN Scope)

### 2.1 Task Store Abstraction

- Abstract interface for task persistence (create, read, update, query)
- Storage adapter pattern so backend is pluggable (SQLite recommended for v1)
- Task records conform to `TaskRecord` / `DiagnosticianTaskRecord` from M1 contracts
- Lease-aware task selection (lease next eligible task)

### 2.2 Run Store Abstraction

- Abstract interface for run persistence (create, read, update)
- Run records track execution attempts independently of task status
- Run records reference task, agent, runtime, input/output

### 2.3 Lease Lifecycle

- Atomic lease acquisition (lease, renew, release)
- Lease expiry tracking
- Lease owner identity enforcement (only owner can renew/release)
- Integration with `PDTaskStatus` state machine from M1

### 2.4 Retry Metadata

- `attemptCount` tracking on task records
- `maxAttempts` enforcement
- Backoff policy (exponential with upper bound)
- Error categorization per attempt using `PDErrorCategory`
- `retry_wait` state with wake eligibility

### 2.5 Expired Lease Recovery

- Detection of expired leases
- Recovery to `retry_wait` or `pending` based on attempt count
- Recovery event emission
- Idempotent recovery (safe to run multiple times)

## 3. Non-Goals (OUT of Scope)

The following are explicitly excluded from M2:

- Context retrieval / history query implementation (M3)
- Diagnostician runner v2 (M4)
- Unified commit flow (M5)
- OpenClaw adapter demotion (M6)
- Multi-runtime adapters (M8)
- CLI surface expansion beyond M2 minimum needs
- Principle ledger changes
- Rule synthesis changes
- Nocturnal workflow changes
- Web UI or console changes

## 4. Exit Criteria

1. Diagnostician-like tasks can be leased and recovered without marker-file truth
2. Run records exist independently of legacy heartbeat flow
3. Concurrent lease acquisition is safe (tested with concurrent access)
4. Crash recovery correctly re-enqueues expired lease tasks
5. State transitions are idempotent and atomic where storage permits
6. All new types align with M1 contracts (PDTaskStatus, TaskRecord, PDErrorCategory)
7. Telemetry events emitted for all state transitions
8. Unit test coverage >= 80% for new code

## 5. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Partial migration that still depends on legacy files | HIGH | Exit criteria #1 explicitly forbids this |
| SQLite concurrency surprises | MEDIUM | Use WAL mode, test concurrent lease scenarios |
| Scope creep into context retrieval | MEDIUM | Strict non-goal list above |
| Breaking existing evolution queue | HIGH | Dual-write period, migration tests |
| Over-abstracting storage layer | LOW | Start with one concrete impl (SQLite), keep interface thin |

## 6. Execution Constraints

These constraints are mandatory for M2:

1. PD owns task/run truth — not marker files, not heartbeat inference
2. All new task/run state must align with runtime-v2 contracts in `@principles/core`
3. OpenClaw state/lifecycle must not redefine PD task semantics
4. Any migration path must preserve rollback safety
5. Telemetry and observability are required, not optional
6. Legacy `QueueStatus` must not be the truth source for new code
7. Legacy `TaskResolution` must not be the truth source for new code
8. M1 contracts (AgentSpec, PDErrorCategory, PDTaskStatus, RuntimeSelector) are frozen

## 7. Dependencies

### Canonical Documents

| Document | Path | Relevance |
|----------|------|-----------|
| Architecture v2 | `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` | Sections 7.5-7.6 (Run), 13 (Diagnostician), 22.2 (Lease) |
| Protocol Spec v1 | `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` | Sections 9 (Run lifecycle), 12 (Task lease protocol), 21 (Storage) |
| Diagnostician v2 Design | `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` | Sections 7-8 (Task queue, lease), 17 (Storage) |
| Milestone Roadmap | `docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md` | Section M2 definition |
| GSD Governance | `docs/pd-runtime-v2/gsd-execution-governance.md` | All sections |
| Conflict Table | `docs/pd-runtime-v2/conflict-table.md` | Migration priority ordering |

### Code Dependencies

| Location | Purpose |
|----------|---------|
| `packages/principles-core/src/runtime-v2/` | M1 contracts (frozen baseline) |
| `packages/principles-core/src/runtime-v2/task-status.ts` | PDTaskStatus, TaskRecord, DiagnosticianTaskRecord schemas |
| `packages/principles-core/src/runtime-v2/error-categories.ts` | PDErrorCategory, PDRuntimeError |
| `packages/principles-core/src/runtime-v2/runtime-protocol.ts` | RunHandle, RunStatus types |
| `packages/principles-core/src/runtime-v2/agent-spec.ts` | AgentSpec, AGENT_IDS |
| `packages/principles-core/src/index.ts` | Public API surface |

### Legacy Code Anchors (to be migrated, NOT redefined)

| Location | Legacy Type | Canonical Replacement |
|----------|-------------|----------------------|
| `openclaw-plugin/src/service/evolution-worker.ts:110-112` | QueueStatus, TaskResolution | PDTaskStatus, PDErrorCategory |
| `openclaw-plugin/src/core/evolution-types.ts:472-473` | QueueStatus, TaskResolution | PDTaskStatus, PDErrorCategory |
| `openclaw-plugin/src/service/evolution-queue-migration.ts:15,20` | QueueStatus, TaskResolution | PDTaskStatus, PDErrorCategory |
| `openclaw-plugin/src/service/queue-migration.ts:11-12` | QueueStatus, TaskResolution | PDTaskStatus, PDErrorCategory |
| `openclaw-plugin/src/core/diagnostician-task-store.ts` | Task queue operations | New task store abstraction |

## 8. Verification Plan

### Required Tests

1. **Concurrent lease tests** — two workers competing for same task, only one wins
2. **Crash recovery tests** — simulate lease expiry, verify recovery
3. **Idempotent state transition tests** — same transition applied twice, no double-effect
4. **Schema conformance tests** — stored records conform to TaskRecord/DiagnosticianTaskRecord
5. **Migration compatibility tests** — legacy queue items readable through new store

### Required Evidence

- Test output showing all tests pass
- Schema validation against TypeBox schemas from M1
- Migration path verified with real legacy queue data format

## 9. Review Gate

Before M2 is considered complete, the following must be reviewed:

1. Did M2 reduce host-runtime coupling or accidentally increase it?
2. Is task/run truth explicit and test-covered?
3. Is there a rollback path?
4. Did any schema or error category drift appear?
5. Can operators observe failure in the new path clearly?
