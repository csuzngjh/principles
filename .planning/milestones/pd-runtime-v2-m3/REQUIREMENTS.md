# M3: History Retrieval + Context Build — Requirements

> Status: Active
> Date: 2026-04-22
> Predecessor: M2 Task/Run State Core (shipped PR #393)
> Source: runtime-v2-milestone-roadmap.md Section M3

## 1. Goal

Deliver the PD-owned retrieval pipeline:
- `pd trajectory locate` — locate a specific trajectory by ID or criteria
- `pd history query` — bounded historical retrieval independent of host-specific SQL
- `pd context build` — assemble diagnostician-ready context from PD-owned retrieval

## 2. Scope (IN Scope)

### 2.1 Trajectory Locator

- Locate trajectory by `trajectoryId` (exact match on run_id PK)
- Locate trajectory by `taskId` (find associated runs via idx_runs_task_id)
- Locate trajectory by `runId` (find trajectory containing specific run)
- Locate trajectory by date range (startedAt filters via idx_runs_started_at)
- Locate trajectory by session hints (workspace-scoped, PD-managed references)
- Return single trajectory or list of candidates with pagination

**Stretch (仅在 M2 有稳定索引时支持):**
- Locate trajectory by agent ID (requires join to tasks.lease_owner — high cost)
- Locate trajectory by `executionStatus` (idx_runs_status exists — viable stretch)

### 2.2 Bounded History Query

- Query run history for a given taskId (across all attempts)
- Query run history for a given workspace (bounded by time window)
- Query run history by agent ID
- Configurable page size (default 20, max 100)
- Cursor-based pagination (not offset)
- Bounded time windows (prevent runaway queries)
- Ordering: newest first (startedAt DESC)

### 2.3 Context Assembler

- Assemble `DiagnosticianContextPayload` from retrieved runs
- Include all runs for a taskId (full attempt history)
- Include input payload and output payload references
- Include execution metadata (startedAt, endedAt, errorCategory, attemptNumber)
- Sort by attemptNumber ASC (chronological order for diagnostician)
- Respect workspace isolation (never include cross-workspace runs)

### 2.4 Degradation Policy

- When trajectory not found: return empty result with `found: false`, no throw
- When history query returns no results: return empty array, no throw
- When payload is missing: omit field, include `dataAvailable: false` marker
- When assembled context is partial: include `contextComplete: false` flag
- All degradation modes: log warning, emit telemetry, never crash the task

### 2.5 Workspace Isolation

- Every retrieval operation is scoped to a workspace
- Workspace ID must be provided at retrieval time (not implicit)
- No cross-workspace context leakage
- Trajectory IDs are workspace-unique (enforced by storage)

## 3. Non-Goals (OUT of Scope)

The following are explicitly excluded from M3:

- Context retrieval from external systems (only PD-owned SQLite storage)
- Diagnostician runner v2 (M4)
- Unified commit flow (M5)
- OpenClaw adapter demotion (M6)
- Multi-runtime adapters (M8)
- Context caching or prefetching
- Full-text search or fuzzy matching
- Context compression or summarization

## 4. Exit Criteria

1. `pd trajectory locate` returns correct trajectory or empty-not-found result
2. `pd history query` returns bounded, paginated run history
3. `pd context build` produces `DiagnosticianContextPayload` from retrieved data
4. Workspace isolation is enforced: no cross-workspace data leakage
5. Degradation policy: all error modes return safe fallbacks, no crashes
6. Degraded mode: status=degraded + warnings, task still proceeds
7. Unit test coverage >= 80% for new retrieval code

## 5. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Falling back to OpenClaw raw workspace files for retrieval | HIGH | Authoritative boundary: PD-owned stores/indexes only |
| Context size explosion (unbounded payload) | MEDIUM | Bounded page size, explicit field allowlist |
| Cross-workspace leakage | CRITICAL | Workspace ID required for all operations |
| Introducing M4/M5 scope creep | MEDIUM | Strict non-goal list enforced |
| Unbounded history query crashing the node | HIGH | Cursor pagination + time window limits |
| LLM sneaking into context build | HIGH | Explicit constraint: code-generated or template-generated only |

## 6. Execution Constraints

These constraints are mandatory for M3:

1. All authoritative retrieval must use PD-owned stores/indexes/references as primary source
2. OpenClaw raw workspace/session files are NOT an authoritative retrieval source
3. External/host data may only be accessed through PD-managed references if already indexed by PD
4. Workspace ID is required, never inferred from environment
5. Degradation is the default behavior — no throws on missing data
6. Telemetry emitted for all retrieval operations (hit/miss/partial)
7. No diagnostician runner changes in M3
8. No commit flow changes in M3
9. No LLM calls inside context build — must be code-generated or template-generated
10. M2 contracts (TaskRecord, RunRecord, PDTaskStatus) are frozen baseline

## 7. Dependencies

### Code Dependencies (M2 Baseline)

| Location | Purpose |
|----------|---------|
| `packages/principles-core/src/runtime-v2/store/` | M2 TaskStore, RunStore, RuntimeStateManager |
| `packages/principles-core/src/runtime-v2/task-status.ts` | TaskRecord, DiagnosticianTaskRecord |
| `packages/principles-core/src/runtime-v2/runtime-protocol.ts` | RunHandle, RunRecord |
| `packages/principles-core/src/runtime-v2/context-payload.ts` | DiagnosticianContextPayload, HistoryQueryEntry |
| `packages/principles-core/src/runtime-v2/event-emitter.ts` | StoreEventEmitter, TelemetryEvent |

### Canonical Documents

| Document | Path | Relevance |
|----------|------|-----------|
| Architecture v2 | `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` | Sections 7.5-7.6 (Run), 13 (Diagnostician), 22.2 (Lease) |
| Protocol Spec v1 | `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` | Sections 9 (Run lifecycle), 21 (Storage) |
| Diagnostician v2 Design | `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` | Sections 7-8 (Task queue, lease), 17 (Storage) |
| Milestone Roadmap | `docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md` | Section M3 definition |

## 8. Verification Plan

### Required Tests

1. **Trajectory locator tests** — exact match, by taskId, by date range, by agentId, not-found
2. **History query tests** — bounded results, cursor pagination, time window, empty result
3. **Context assembler tests** — correct field assembly, ordering, partial data handling
4. **Degradation tests** — every error mode returns safe fallback, no throws
5. **Workspace isolation tests** — cross-workspace queries return empty, never leak data

### Required Evidence

- Test output showing all tests pass
- No host-specific SQL imports in retrieval code
- Degradation path verified with missing-data fixtures
