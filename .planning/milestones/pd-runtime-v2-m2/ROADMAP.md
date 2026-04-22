# M2: Task/Run State Core — Roadmap

> Status: Active
> Date: 2026-04-22
> Milestone: pd-runtime-v2-m2
> Predecessor: M1 Foundation Contracts (shipped)

## 1. Milestone Summary

M2 builds the PD-owned task and run truth layer. It introduces store abstractions, lease semantics, retry metadata, and expired lease recovery — replacing marker-file and heartbeat-based completion inference.

## 2. Phase Breakdown

### Phase 1: Task Store Interface + SQLite Implementation

**Goal:** Define and implement the task store abstraction.

**Deliverables:**
- `TaskStore` interface in `@principles/core`
- SQLite-backed implementation
- Create, read, update, query operations
- Schema conformance (TaskRecord / DiagnosticianTaskRecord)

**Dependencies:** M1 contracts (frozen)

### Phase 2: Run Store Interface + SQLite Implementation

**Goal:** Define and implement the run store abstraction.

**Deliverables:**
- `RunStore` interface in `@principles/core`
- SQLite-backed implementation
- Run lifecycle states: queued → running → succeeded/failed/timed_out/cancelled

**Dependencies:** Phase 1

### Phase 3: Lease Lifecycle

**Goal:** Implement atomic lease acquisition, renewal, and release.

**Deliverables:**
- Lease acquisition (atomic select + update)
- Lease renewal (owner-only)
- Lease release (owner-only, back to pending/retry_wait)
- Integration with PDTaskStatus state machine

**Dependencies:** Phase 1

### Phase 4: Retry Metadata + Backoff

**Goal:** Implement retry tracking and backoff policy.

**Deliverables:**
- Attempt count tracking per task
- maxAttempts enforcement
- retry_wait state with configurable backoff
- Error categorization per attempt

**Dependencies:** Phase 1, Phase 3

### Phase 5: Expired Lease Recovery + Telemetry

**Goal:** Implement crash recovery and event emission.

**Deliverables:**
- Expired lease detection
- Recovery to retry_wait or pending
- Recovery event emission
- Telemetry events for all state transitions
- Idempotent recovery

**Dependencies:** Phase 3, Phase 4

### Phase 6: Migration Bridge + Tests

**Goal:** Bridge from legacy queue to new store, comprehensive tests.

**Deliverables:**
- Migration path from EvolutionQueueItem to TaskRecord
- Dual-write compatibility (legacy and new)
- Concurrent lease tests
- Crash recovery tests
- Idempotent state transition tests
- Schema conformance tests

**Dependencies:** All previous phases

## 3. Execution Order

```
Phase 1 ─┬─→ Phase 2
          │
          └─→ Phase 3 ─→ Phase 4 ─→ Phase 5
                                        │
All previous ─────────────────────→ Phase 6
```

Phases 2 and 3 can proceed in parallel after Phase 1.

## 4. Success Metrics

- All exit criteria from REQUIREMENTS.md satisfied
- Test coverage >= 80% for new code
- No regressions in existing tests
- Legacy queue still readable (migration compatibility)

## 5. Anti-Drift Guardrails

The following are explicit scope guards:

| What Might Creep In | Why It Belongs Later | How to Guard |
|---------------------|---------------------|--------------|
| Context retrieval / history query | M3 scope | Task store does NOT assemble context |
| Diagnostician runner | M4 scope | Task store does NOT invoke agents |
| Commit flow | M5 scope | Task store does NOT validate artifacts |
| OpenClaw adapter changes | M6 scope | Task store is runtime-agnostic |
| CLI expansion | M7 scope | Only minimal lease/status commands if needed |
| TaskKind unification | Design decision needed | M2 uses existing taskKind strings as-is |
| TaskResolution canonicalization | Needs separate schema | M2 uses PDErrorCategory for error categorization |
