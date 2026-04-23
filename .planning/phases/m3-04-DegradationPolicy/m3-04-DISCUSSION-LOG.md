---
phase: m3-04
status: decisions_locked
locked: "2026-04-22"
---

# Discussion Log: Degradation Policy (m3-04)

## Decisions Locked

### D1: ResilientContextAssembler 包装器模式
- **Choice**: Composition wrapper (ResilientContextAssembler) wraps ContextAssembler
- **Why**: Keeps existing SqliteContextAssembler focused and testable; adds resilience layer without modifying working code
- **How**: `ResilientContextAssembler implements ContextAssembler`, try/catch in `assemble()`, returns degraded payload on any error

### D2: Cursor 静默回退首页
- **Choice**: Invalid/deleted cursor → return first page of results, no throw
- **Why**: Cursor is an optimization detail; users shouldn't crash because of stale pagination state
- **How**: Catch cursor errors in ResilientContextAssembler (or create ResilientHistoryQuery wrapper), log warning, fall back to first page query

### D3: 新增 degradation_triggered telemetry 事件
- **Choice**: New unified telemetry event type for all degradation scenarios
- **Why**: Single event type with component/trigger/fallback fields is simpler than per-component events
- **How**: Add `degradation_triggered` to TelemetryEvent union, emit via StoreEventEmitter

### D4: 降级 payload 满足 DiagnosticianContextPayloadSchema
- **Choice**: Degraded payloads are valid DiagnosticianContextPayload with empty conversationWindow and descriptive ambiguityNotes
- **Why**: Downstream consumers (diagnostician) expect valid schema; breaking schema breaks the pipeline
- **How**: Synthetic contextId/contextHash, empty conversationWindow, minimal diagnosisTarget, populated ambiguityNotes

### D5: Schema 验证失败 → catch + degrade + ERROR telemetry
- **Choice**: Schema validation failures (potential DB corruption) are caught, not thrown
- **Why**: Pipeline must never crash; corruption is serious but should be signaled via telemetry, not exception
- **How**: Catch Value.Check() failures, return degraded payload, emit degradation_triggered with severity=error

## Scope Boundaries

- **In scope**: ContextAssembler and HistoryQuery error wrapping, degraded payload generation, degradation telemetry
- **Out of scope**: Workspace isolation (m3-05), diagnostician runner (M4), CLI integration (m3-05)
- **No LLM**: Degradation logic is pure code, no LLM calls
