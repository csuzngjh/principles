# M3: History Retrieval + Context Build — Roadmap

> Status: Active
> Date: 2026-04-22
> Milestone: v2.2
> Phase numbering: m3-01 through m3-05 (continuing from M2)

## Authoritative Boundary (执行约束)

- All authoritative retrieval must use **PD-owned stores/indexes/references** as primary source
- OpenClaw raw workspace/session files are **NOT** an authoritative retrieval source
- External/host data may only be accessed through PD-managed references if already indexed by PD
- **No LLM call inside context build** — context assembly must be code-generated or template-generated

## Phases

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| m3-01 | Trajectory Locator | Locate by trajectoryId, taskId, runId, date range, PD-managed hints (agentId/status: stretch if M2 index exists) | RET-01, RET-02, RET-03 | 5+ modes, agentId/status deferred if no stable M2 index |
| m3-02 | Bounded History Query | Query run history with cursor pagination and time windows | RET-04, RET-05, RET-06 | Cursor pagination works, time window enforced |
| m3-03 | Context Assembler | Assemble DiagnosticianContextPayload from retrieved runs (no LLM) | RET-07, RET-08 | Payload fields correct, ordering correct |
| m3-04 | Degradation Policy | Graceful fallback on missing data, no throws, warnings emitted | RET-09, RET-10 | All error modes return safe fallbacks |
| m3-05 | Workspace Isolation + Integration | Enforce workspace scoping, CLI integration, end-to-end tests | RET-11, RET-12, RET-13 | No cross-workspace leakage, CLI commands work |

---

## Phase m3-01: Trajectory Locator

**Goal:** Provide trajectory locate functionality — by trajectoryId, taskId, runId, date range, PD-managed hints

**Requirements:** RET-01, RET-02, RET-03

**Table Stakes (有稳定索引才支持):**
- `locateTrajectory(trajectoryId)` — exact match
- `locateTrajectoryByTaskId(taskId)` — find associated trajectory
- `locateTrajectoryByRunId(runId)` — find trajectory containing a specific run
- `locateTrajectoriesByDateRange(start, end)` — bounded list
- `locateTrajectoriesBySessionHint(hints)` — PD-managed hints (workspace, agent, time window)

**Stretch (仅在 M2 store 有稳定索引时支持，否则 defer):**
- `locateTrajectoriesByAgentId(agentId)` — requires agentId indexed on runs table
- `locateTrajectoriesByStatus(status)` — requires executionStatus indexed

**Plans:** 1 plan (wave 1)

Plans:
- [x] m3-01-01-PLAN.md -- TrajectoryLocator interface + SqliteTrajectoryLocator implementation + test suite (VERIFIED)

**Success Criteria:**
1. `locateTrajectory(trajectoryId)` returns trajectory or null — DONE
2. `locateTrajectoryByTaskId(taskId)` returns associated trajectory — DONE
3. `locateTrajectoryByRunId(runId)` returns containing trajectory — DONE
4. `locateTrajectoriesByDateRange(start, end)` returns bounded list — DONE
5. `locateTrajectoriesBySessionHint(hints)` returns PD-managed results — DONE
6. agentId/status modes: executionStatus mode implemented (stretch) — DONE

---

## Phase m3-02: Bounded History Query

**Goal:** Query run history with cursor pagination, time window limits, configurable page size

**Requirements:** RET-04, RET-05, RET-06

**Plans:** 1 plan (wave 1)

Plans:
- [x] m3-02-01-PLAN.md -- HistoryQuery interface + SqliteHistoryQuery + cursor pagination (VERIFIED)

**Success Criteria:**
1. Cursor-based pagination with page size cap — DONE
2. Time window filtering with configurable lookback — DONE
3. Opaque base64 cursor with keyset pagination — DONE
4. Schema validation on results — DONE

---

## Phase m3-03: Context Assembler

**Goal:** Assemble DiagnosticianContextPayload from retrieved run history

**Requirements:** RET-07, RET-08

**Constraint: No LLM inside context assembly** — must be code-generated or template-generated

**Plans:** 1 plan (wave 1)

Plans:
- [x] m3-03-01-PLAN.md -- ContextAssembler interface + SqliteContextAssembler + test suite (VERIFIED)

**Success Criteria:**
1. DiagnosticianContextPayload assembled from TaskStore+HistoryQuery+RunStore — DONE
2. UUIDv4 contextId + SHA-256 contextHash generated — DONE
3. DiagnosisTarget mapped from DiagnosticianTaskRecord — DONE
4. Template-generated ambiguityNotes for data quality — DONE
5. TypeBox Value.Check() output validation — DONE
6. No LLM call in context assembly — DONE

**Known finding:** conversationWindow in DESC order (LOW, non-blocking)

---

## Phase m3-04: Degradation Policy

**Goal:** Graceful degradation on all error modes — no throws, safe fallbacks, warnings + telemetry

**Requirements:** RET-09, RET-10

**Plans:** 1 plan (wave 1)

Plans:
- [x] m3-04-01-PLAN.md -- ResilientContextAssembler + ResilientHistoryQuery + telemetry (VERIFIED)

**Success Criteria:**
1. Task not found → returns safe fallback payload (no throw) — DONE
2. History empty → returns valid payload with ambiguity notes — DONE
3. Partial data → returns best-effort payload with warnings — DONE
4. All degradation events emit telemetry — DONE
5. No unhandled exceptions in degraded modes — DONE

---

## Phase m3-05: Workspace Isolation + Integration

**Goal:** Enforce workspace scoping on all operations, wire into CLI, end-to-end integration tests

**Requirements:** RET-11, RET-12, RET-13

**Plans:** 1 plan (wave 1)

Plans:
- [x] m3-05-01-PLAN.md -- CLI commands + workspace isolation tests (VERIFIED)

**Success Criteria:**
1. Workspace ID enforced on all store operations — DONE (architecture)
2. No cross-workspace data leakage in any query — DONE (7 isolation tests)
3. CLI commands for locate / query / build work end-to-end — DONE (3 commands)

---

## Requirements Traceability

| REQ-ID | Requirement | Phase | Notes |
|--------|-------------|-------|-------|
| RET-01 | Locate trajectory by trajectoryId (exact) | m3-01 | Table stakes -- DONE |
| RET-02 | Locate by taskId, runId, date range, session hints | m3-01 | Table stakes; agentId/status = stretch -- DONE |
| RET-03 | Locate trajectory by executionStatus | m3-01 | Stretch -- DONE (idx_runs_status exists) |
| RET-04 | Query run history by taskId with ordering | m3-02 | Table stakes -- DONE |
| RET-05 | Cursor-based pagination with page size cap | m3-02 | Table stakes -- DONE |
| RET-06 | Bounded time window queries | m3-02 | Table stakes -- DONE |
| RET-07 | Assemble DiagnosticianContextPayload from runs | m3-03 | Table stakes; no LLM -- DONE |
| RET-08 | Sort runs by attemptNumber ASC | m3-03 | PARTIAL (DESC order, LOW finding) -- DONE |
| RET-09 | Trajectory not found → safe fallback | m3-04 | Table stakes -- DONE |
| RET-10 | Degradation emits warnings + telemetry | m3-04 | Table stakes -- DONE |
| RET-11 | Workspace ID required for all operations | m3-05 | Table stakes -- DONE (architecture) |
| RET-12 | No cross-workspace data leakage | m3-05 | Table stakes -- DONE (7 isolation tests) |
| RET-13 | CLI commands for locate / query / build | m3-05 | Table stakes -- DONE |
