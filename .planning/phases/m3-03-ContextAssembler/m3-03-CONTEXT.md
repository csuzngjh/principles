# Phase m3-03: Context Assembler - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the context assembler: `ContextAssembler` interface + `SqliteContextAssembler` implementation that assembles `DiagnosticianContextPayload` from PD-owned retrieval results.

Purpose: Given a trajectory reference (located via TrajectoryLocator), combine task metadata and bounded history entries into a diagnostician-ready context payload. This is the third and final assembly stage of the M3 retrieval pipeline — TrajectoryLocator finds trajectories, HistoryQuery retrieves bounded history, ContextAssembler combines them into the output contract.

Output: ContextAssembler interface, SqliteContextAssembler class with dependency injection (TaskStore + HistoryQuery), comprehensive test suite, updated index exports.

</domain>

<decisions>
## Implementation Decisions

### Output Type Scope
- **D-01:** Implement only `DiagnosticianContextPayload` — M4 diagnostician is the known consumer via `DiagnosticianInvocationInput.context`
- **D-02:** `ContextPayload` (general-purpose) is NOT in scope — leave for future when a consumer exists
- **D-03:** Interface design should NOT preclude future addition of `assemble()` for `ContextPayload`, but no extension points needed now

### ID and Hash Generation
- **D-04:** `contextId` generated via `crypto.randomUUID()` (UUIDv4)
- **D-05:** `contextHash` computed as SHA-256 of serialized `conversationWindow` entries (JSON.stringify of the entries array)
- **D-06:** Use Node.js built-in `node:crypto` module — no external dependencies

### Field Population Strategy
- **D-07:** `conversationWindow` — direct passthrough from `HistoryQueryResult.entries` (no transformation)
- **D-08:** `sourceRefs` — populated as `[taskId, ...runIds]` for complete traceability chain
- **D-09:** `diagnosisTarget` — mapped from `DiagnosticianTaskRecord` fields:
  - `reasonSummary` → `reasonSummary`
  - `source` → `source`
  - `severity` → `severity`
  - `sourcePainId` → `painId`
  - `sessionIdHint` → `sessionIdHint`
- **D-10:** `workspaceDir` — direct from `DiagnosticianTaskRecord.workspaceDir`
- **D-11:** `taskId` — direct from input taskId
- **D-12:** `eventSummaries` — left as `undefined` (not populated in this phase)
- **D-13:** `ambiguityNotes` — template-generated array of strings describing data quality issues found during assembly:
  - Empty/null payload in run records
  - Time gaps between consecutive entries
  - Truncated history (HistoryQueryResult.truncated === true)
  - Missing required metadata fields
  - Empty if no quality issues detected (still `undefined`, not empty array)

### Dependency Injection
- **D-14:** `ContextAssembler` depends on `TaskStore` + `HistoryQuery` (compose existing components)
- **D-15:** Does NOT depend directly on `SqliteConnection` — uses abstraction layer
- **D-16:** `SqliteContextAssembler` constructor receives concrete implementations: `(taskStore: TaskStore, historyQuery: HistoryQuery)`

### Assembly Flow
- **D-17:** Input: `taskId` string (from TrajectoryLocator result)
- **D-18:** Step 1: `TaskStore.getTask(taskId)` → get DiagnosticianTaskRecord for workspaceDir + diagnosisTarget fields
- **D-19:** Step 2: `HistoryQuery.query(taskId)` → get HistoryQueryResult for conversationWindow + sourceRef
- **D-20:** Step 3: Extract runIds from HistoryQueryResult entries for sourceRefs
- **D-21:** Step 4: Generate contextId (UUIDv4) and contextHash (SHA-256)
- **D-22:** Step 5: Generate ambiguityNotes from data quality analysis
- **D-23:** Step 6: Assemble and return DiagnosticianContextPayload

### Error Handling
- **D-24:** Task not found → throw `PDRuntimeError(storage_unavailable)` with context message
- **D-25:** Empty history → return valid payload with empty `conversationWindow` and ambiguityNotes noting "no history entries found"
- **D-26:** Task exists but is not DiagnosticianTaskRecord → throw `PDRuntimeError(input_invalid)` with "task is not a diagnostician task"

### Boundary Constraints (M3 全局)
- **D-27:** No LLM calls in context assembly — all content is code/template-generated
- **D-28:** PD-owned stores only — no OpenClaw workspace file access
- **D-29:** Workspace isolation handled at TaskStore level (m3-05 will add explicit enforcement)

### Claude's Discretion
- Exact interface method name (assemble, assembleForDiagnostician, build, etc.)
- Whether to include a `ContextAssemblerOptions` type for future customization
- Exact format of template-generated ambiguityNotes strings
- Whether to extract runIds from HistoryQueryResult entries or query RunStore separately
- How to handle SHA-256 hash when conversationWindow is empty

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Output Type Contract
- `packages/principles-core/src/runtime-v2/context-payload.ts` — Defines DiagnosticianContextPayload, DiagnosisTarget, HistoryQueryEntry (locked output types)
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianInvocationInput referencing DiagnosticianContextPayload as M4 consumer

### Dependencies (m3-02 output)
- `packages/principles-core/src/runtime-v2/store/history-query.ts` — HistoryQuery interface, HistoryQueryCursorData, HistoryQueryOptions
- `packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts` — SqliteHistoryQuery implementation pattern to follow

### Dependencies (M2)
- `packages/principles-core/src/runtime-v2/store/task-store.ts` — TaskStore interface, getTask() method
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts` — SqliteTaskStore implementation
- `packages/principles-core/src/runtime-v2/task-status.ts` — TaskRecord, DiagnosticianTaskRecord (source for diagnosisTarget mapping)

### Project Constraints
- `.planning/phases/m3-01-TrajectoryLocator/CONTEXT.md` — M3 boundary constraints (no LLM, no OpenClaw, PD-owned stores only)
- `.planning/phases/m3-02-BoundedHistoryQuery/m3-02-CONTEXT.md` — HistoryQuery decisions (cursor pagination, entry mapping)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `HistoryQuery.query(trajectoryRef)` — returns HistoryQueryResult with entries, truncated, nextCursor
- `TaskStore.getTask(taskId)` — returns TaskRecord (cast to DiagnosticianTaskRecord for extra fields)
- `DiagnosticianTaskRecord` — has workspaceDir, sourcePainId, severity, source, sessionIdHint, reasonSummary
- `DiagnosticianContextPayloadSchema` — TypeBox schema for output validation
- `node:crypto` — built-in UUIDv4 and SHA-256 support

### Established Patterns
- Interface + SqliteImplementation pattern: `history-query.ts` → `sqlite-history-query.ts`
- Constructor injection of dependencies — follows SqliteHistoryQuery(SqliteConnection) pattern
- TypeBox `Value.Check()` validation on return values — consistent with all store implementations
- `--no-verify` on commits in worktree mode, normal commits in sequential mode

### Integration Points
- `TrajectoryLocator.locate()` returns `TrajectoryCandidate.trajectoryRef` (= taskId) → feeds into ContextAssembler
- `HistoryQuery.query(taskId)` returns entries → feeds into conversationWindow
- `TaskStore.getTask(taskId)` returns TaskRecord → provides workspaceDir + diagnosisTarget fields
- `DiagnosticianInvocationInput.context` — M4 diagnostician consumes the assembled payload
- `packages/principles-core/src/runtime-v2/index.ts` — needs updated exports for new types

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard assembly pattern composing existing retrieval components.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: m3-03-ContextAssembler*
*Context gathered: 2026-04-22*
