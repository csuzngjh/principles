# Phase m3-03: Context Assembler - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-22
**Phase:** m3-03-ContextAssembler
**Areas discussed:** Output Type Scope, ID/Hash Generation, Field Population, Interface Design

---

## Output Type Scope

| Option | Description | Selected |
|--------|-------------|----------|
| DiagnosticianContextPayload only | M4 has known consumer, ContextPayload deferred | ✓ |
| Both | Two methods: assemble() + assembleForDiagnostician() | |
| Diagnostician + extension point | Implement one, design for future extension | |

**User's choice:** DiagnosticianContextPayload only (recommended)
**Notes:** M4 diagnostician is the only known consumer via DiagnosticianInvocationInput.context. ContextPayload left for future when a consumer exists.

---

## ID and Hash Generation

| Option | Description | Selected |
|--------|-------------|----------|
| UUIDv4 + SHA-256 | contextId = randomUUID(), contextHash = SHA-256(conversationWindow) | ✓ |
| Composite ID + SHA-256 | contextId = ${taskId}-${timestamp}, hash = SHA-256 | |
| UUID only | No content hash, both use randomUUID() | |

**User's choice:** UUIDv4 + SHA-256 (recommended)
**Notes:** Uses Node.js built-in node:crypto. Hash content is serialized conversationWindow entries array.

---

## Field Population (eventSummaries + ambiguityNotes)

| Option | Description | Selected |
|--------|-------------|----------|
| ambiguityNotes template + eventSummaries empty | Generate quality notes from assembly analysis, leave events undefined | ✓ |
| Both empty | Leave both undefined, M4 handles | |
| Both populated | Query TelemetryEvent for summaries + template ambiguityNotes | |

**User's choice:** ambiguityNotes template-generated, eventSummaries left empty (recommended)
**Notes:** ambiguityNotes captures data quality issues: empty payloads, time gaps, truncated history, missing metadata.

---

## Interface Design (sourceRefs + Dependencies)

| Option | Description | Selected |
|--------|-------------|----------|
| sourceRefs: [taskId, ...runIds] | Full traceability chain | ✓ |
| sourceRefs: existing refs only | trajectoryRef + sourceRef | |
| sourceRefs: [taskId] only | Minimal | |

| Option | Description | Selected |
|--------|-------------|----------|
| TaskStore + HistoryQuery injection | Compose existing components | ✓ |
| SqliteConnection direct | Internal SQL queries | |

**User's choice:** sourceRefs = [taskId, ...runIds], Dependencies = TaskStore + HistoryQuery (both recommended)
**Notes:** Composition pattern — ContextAssembler delegates to existing abstractions, no direct DB access.

---

## Claude's Discretion

- Exact interface method name
- ContextAssemblerOptions type design
- AmbiguityNotes template format
- runIds extraction strategy (from entries vs RunStore query)
- Empty conversationWindow hash behavior

## Deferred Ideas

None — discussion stayed within phase scope.
