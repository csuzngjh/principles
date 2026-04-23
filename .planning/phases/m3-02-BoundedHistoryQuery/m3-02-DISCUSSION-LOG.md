# Phase m3-02: Bounded History Query - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** m3-02-BoundedHistoryQuery
**Areas discussed:** Data Source Mapping, Pagination Strategy, TrajectoryLocator Dependency, Boundary Constraints

---

## Data Source Mapping

| Option | Description | Selected |
|--------|-------------|----------|
| Map RunRecord fields | Each RunRecord maps to HistoryQueryEntry. No new table. Simple but limited granularity. | ✓ |
| New history_events table | Dedicated table for conversation turns. Finer granularity but needs schema migration. | |
| Pure interface layer | Interface only, data mapping deferred. Entries return empty arrays. | |

**User's choice:** Map RunRecord fields (1 Run → 2 Entries: system + assistant)
**Notes:** ts=started_at, input_payload→text(role=system), output_payload→text(role=assistant)

---

## Pagination Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Opaque JSON cursor | base64 {taskId, lastRunId, direction}. Client-opaque, server-parseable. | ✓ |
| Timestamp-based cursor | started_at + run_id combo. Client-readable but time-ordering assumption. | |
| Offset-based cursor | Numeric offset. Simple but unstable with inserts. | |

**User's choice:** Opaque JSON cursor
**Notes:** User initially asked "cursor是什么东西？" — clarified cursor-based pagination concept before selection.

---

## TrajectoryLocator Dependency

| Option | Description | Selected |
|--------|-------------|----------|
| Depends on TrajectoryLocator | locate() first, then query runs. Reuses m3-01's 6 locate modes. | ✓ |
| Independent runs query | Direct runs table query with taskId parameter. No locator dependency. | |

**User's choice:** Depends on TrajectoryLocator (recommended)

---

## Boundary Constraints

| Option | Description | Selected |
|--------|-------------|----------|
| Default 50 entries + 24h | Configurable constants. Cursor does not expire. | ✓ |
| Default 100 entries, no time window | Only limit bound. More permissive. | |
| Claude decides | Let downstream agent pick values. | |

**User's choice:** Default 50 entries + 24h time window

---

## Claude's Discretion

- Exact cursor encoding format details
- Error handling for malformed cursors
- HistoryQueryOptions type design
- How to handle runs with no payload data
