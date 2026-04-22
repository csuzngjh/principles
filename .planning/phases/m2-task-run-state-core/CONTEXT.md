# Phase M2: Task/Run State Core - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning
**Milestone:** pd-runtime-v2-m2

<domain>
## Phase Boundary

Introduce explicit PD-owned task and run truth with lease semantics. Build store abstractions (TaskStore, RunStore), lease lifecycle, retry metadata, and expired lease recovery — replacing marker-file and heartbeat-based completion inference with deterministic state layer.

**In scope:**
- TaskStore abstract interface + SQLite implementation
- RunStore abstract interface + SQLite implementation
- Lease lifecycle (atomic lease, renew, release)
- Retry metadata (attemptCount, maxAttempts, backoff, error categorization)
- Expired lease recovery (detection, recovery, event emission, idempotency)
- Direct replacement of legacy evolution queue (no dual-write)

**Out of scope:**
- Context retrieval / history query (M3)
- Diagnostician runner v2 (M4)
- Unified commit flow (M5)
- OpenClaw adapter demotion (M6)
- Multi-runtime adapters (M8)
- TaskKind unification (design decision deferred)
- TaskResolution canonicalization (uses PDErrorCategory)
- CLI surface expansion beyond M2 minimum

</domain>

<decisions>
## Implementation Decisions

### Storage Layer Location & Structure
- **D-01:** All store code (interfaces + SQLite implementation) lives in `@principles/core` — not a separate package, not openclaw-plugin. This aligns with M1 contracts already in core.
- **D-02:** Directory: `packages/principles-core/src/runtime-v2/store/` — subdirectory of runtime-v2, keeping schema files (agent-spec.ts, task-status.ts) at the runtime-v2 root and implementation in store/.
- **D-03:** Files: `task-store.ts` (interface), `run-store.ts` (interface), `sqlite-task-store.ts` (impl), `sqlite-run-store.ts` (impl), `sqlite-connection.ts` (shared DB helpers).

### Migration Strategy & Legacy Compatibility
- **D-04:** Direct replacement of legacy evolution queue — new store replaces `evolution-queue.json` and `diagnostician-task-store.ts` as truth source. No dual-write period.
- **D-05:** New store starts blank — no migration of existing queue data. Legacy JSON files remain on disk for reference but are not imported.
- **D-06:** Legacy types (QueueStatus, TaskResolution) are marked @deprecated but not removed during M2. Removal is M6 scope.
- **D-07:** Rollback safety: if new store fails to initialize, system can fall back to legacy queue. This is a safety valve, not a dual-write path.

### Run-Task Relationship Model
- **D-08:** 1 Task : N Runs — each execution attempt creates a new Run record. Task tracks aggregate state (status, attemptCount); Run tracks individual attempt details.
- **D-09:** Run stores complete payload (input + output), not just refs. This means Run records contain the full ContextPayload as input and full DiagnosticianOutputV1 (or equivalent) as output.
- **D-10:** Run schema extends M1 RunHandle/RunStatus with: taskId, attempt (which attempt this run represents), inputPayload, outputPayload, errorCategory (PDErrorCategory).

### SQLite Storage Details
- **D-11:** Workspace-level DB — each workspace has its own `<workspace-dir>/.pd/state.db`. Consistent with existing workspace isolation (principles, ledger per workspace).
- **D-12:** WAL mode + busy_timeout 5000ms — standard SQLite concurrent configuration. Supports read-during-write, write serialization.
- **D-13:** DB path: `<workspaceDir>/.pd/state.db`. Directory `.pd/` created on first access if missing.
- **D-14:** Two tables: `tasks` (TaskRecord fields) and `runs` (RunRecord fields). Indexes on status, leaseOwner, leaseExpiresAt for lease queries.

### Claude's Discretion
- Exact SQL schema DDL (column types, constraints, indexes)
- Lease duration default value
- Backoff policy parameters (initial delay, multiplier, max delay)
- Recovery sweep interval
- Event emission format (reuse TelemetryEvent or new structured events)
- TaskKind handling (use existing strings as-is for M2)
- Whether RunRecord gets its own TypeBox schema or extends RunStatus

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M1 Contracts (frozen — DO NOT modify)
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatus, TaskRecord, DiagnosticianTaskRecord schemas
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory, PDRuntimeError
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RunHandle, RunStatus, RunExecutionStatus, RuntimeKind
- `packages/principles-core/src/runtime-v2/agent-spec.ts` — AgentSpec, AGENT_IDS
- `packages/principles-core/src/runtime-v2/index.ts` — Barrel exports for all runtime-v2 types

### Architecture & Protocol Specs
- `docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md` §7.5-7.6 (Run), §13 (Diagnostician), §22.2 (Lease), §15 (State/Storage Model)
- `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` §9 (Run lifecycle), §12 (Task lease protocol), §21 (Storage guidance)
- `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` §7-8 (Task queue, lease), §17 (Storage recommendations)

### Milestone & Governance
- `docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md` §M2
- `docs/pd-runtime-v2/gsd-execution-governance.md` — All sections (drift prevention, review gates)
- `docs/pd-runtime-v2/conflict-table.md` — Legacy type overlap mapping, migration priority

### Legacy Code (to be replaced — NOT extended)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — QueueStatus L110, TaskResolution L112, EvolutionQueueItem L114+
- `packages/openclaw-plugin/src/core/evolution-types.ts` — QueueStatus L472, TaskResolution L473
- `packages/openclaw-plugin/src/service/evolution-queue-migration.ts` — QueueStatus L15, TaskResolution L20
- `packages/openclaw-plugin/src/service/queue-migration.ts` — QueueStatus L11, TaskResolution L12
- `packages/openclaw-plugin/src/core/diagnostician-task-store.ts` — Current task queue operations

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TaskRecordSchema` / `DiagnosticianTaskRecordSchema` (TypeBox) — M1 schemas that define task shape. Store implementation must conform to these.
- `PDTaskStatusSchema` (TypeBox) — State machine enum. Store state transitions must validate against this.
- `PDErrorCategorySchema` (TypeBox) — Error categorization for retry/recovery logic.
- `Value.Check()` from `@sinclair/typebox/value` — Runtime validation already in use.
- `atomicWriteFileSync` from `@principles/core/io.js` — Crash-safe write pattern exists.
- `StorageAdapter` interface in `@principles/core` — Existing storage abstraction. TaskStore/RunStore should follow similar pattern.

### Established Patterns
- TypeBox for schema definition + validation — all runtime-v2 types use this
- `schemaRef()` helper for versioned schema references
- Barrel export via `runtime-v2/index.ts` — new exports must follow this pattern
- Workspace-scoped data (principles, ledger) — precedent for workspace-level DB

### Integration Points
- `runtime-v2/index.ts` — New store exports must be added here
- `principles-core/src/index.ts` — Public API re-exports
- `runtime-v2/task-status.ts` — TaskRecord/DiagnosticianTaskRecord consumed by store
- `runtime-v2/runtime-protocol.ts` — RunHandle/RunStatus consumed by RunStore
- OpenClaw plugin will consume store via `@principles/core` imports (M4/M6 wiring)

</code_context>

<specifics>
## Specific Ideas

- Store must feel like a proper queue: `leaseNext()` returns at most one task, atomically
- Lease duration should be configurable but have a sensible default (e.g., 30 minutes for diagnostician)
- Recovery sweep should be callable from PD CLI: `pd task recover`
- All state transitions must be logged with structured events (for funnel/observability)
- SQLite should use prepared statements for hot paths (lease, status update)

</specifics>

<deferred>
## Deferred Ideas

- Context retrieval pipeline (M3) — don't build context assembly in task store
- Diagnostician runner using store (M4) — store provides primitives, runner uses them
- Unified commit flow (M5) — store doesn't validate artifacts
- OpenClaw adapter demotion (M6) — legacy QueueStatus/TaskResolution removal
- TaskKind canonical enum — use existing strings as-is for M2
- CLI surface expansion (M7) — only `pd task recover` if needed for M2

</deferred>

---

*Phase: m2-task-run-state-core*
*Context gathered: 2026-04-22*
