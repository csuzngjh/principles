---
phase: m7-03-CandidateIntakeService
tags: [intake-service, idempotency, runtime-state-manager, ledger-adapter]
---

# Phase m7-03: CandidateIntakeService — Context

**Gathered:** 2026-04-26

<domain>
## Phase Boundary

**Domain:** Implement `CandidateIntakeService` that consumes pending candidates from `principle_candidates` table, writes ledger entries via `LedgerAdapter`, and handles idempotency with deduplication.

**Scope:**
- `CandidateIntakeService` class in `packages/principles-core/src/runtime-v2/`
- Constructor DI: `{ stateManager: RuntimeStateManager, ledgerAdapter: LedgerAdapter }`
- `intake(candidateId: string): CandidateIntakeOutput | CandidateIntakeError`
- Workflow: load candidate → load artifact → build LedgerPrincipleEntry → write via adapter → update DB status
- Idempotency: check adapter.existsForCandidate() before writing
- Error handling: specific CandidateIntakeError codes per D-12

**Non-goals:**
- No CLI (that is m7-04)
- No promotion to active principle
- No pain signal bridge
- No heartbeat/cron triggering

</domain>

<decisions>
## Implementation Decisions

### E-01 — Error Handling Strategy

**Decision: Intake failure keeps candidate `pending`, returns `CandidateIntakeError`.**

- Ledger write fails → candidate stays `pending`, throw `LEDGER_WRITE_FAILED`
- Candidate not found → throw `CANDIDATE_NOT_FOUND`, candidate stays `pending`
- Artifact not found → throw `ARTIFACT_NOT_FOUND`, candidate stays `pending`
- Invalid input → throw `INPUT_INVALID`

Rationale: D-09 specifies ledger write FIRST, then DB update. If ledger fails, DB stays `pending` so the operation can be retried.

### E-02 — Idempotency Check Order

**Decision: Check adapter.existsForCandidate() FIRST (O(1) memory lookup), then verify DB status.**

1. `adapter.existsForCandidate(candidateId)` → if entry exists, return existing (no-op, idempotent per D-10)
2. If not in adapter, check DB: `stateManager.getCandidate(candidateId)`
3. If DB status is already `consumed`, this means a data integrity issue (ledger entry missing) → this is where `CANDIDATE_ALREADY_CONSUMED` error fires (D-12: reserved for corruption detection, NOT normal re-intake)

Rationale: D-11 specifies adapter.existsForCandidate() as the idempotency check. Adapter Map is O(1). DB check is secondary validation.

### E-03 — Return Value Design

**Decision: `intake(candidateId)` returns `LedgerPrincipleEntry` (consistent with m7-01 LedgerAdapter interface).**

- On success: returns the `LedgerPrincipleEntry` that was written (passthrough from `adapter.writeProbationEntry()`)
- On idempotent hit: returns the existing entry from adapter Map
- On error: throws `CandidateIntakeError`

Rationale: D-10 says "returns existing ledger entry" on re-intake. Consistent with `LedgerAdapter.writeProbationEntry()` which returns `LedgerPrincipleEntry`.

### E-04 — Artifact Validation

**Decision: Candidate without valid artifact → reject with `ARTIFACT_NOT_FOUND`.**

- `stateManager.getArtifact(artifactRef)` must return a valid artifact
- If artifact missing → throw `ARTIFACT_NOT_FOUND`, candidate stays `pending`
- Artifact content contains `DiagnosticianOutputV1` JSON (sourceRecommendationJson field in CandidateRecord)

Rationale: Success Criteria #4 explicitly says "Candidate without artifact: rejected with descriptive error."

### E-05 — Service Constructor Dependencies

**Decision: Constructor takes `{ stateManager: RuntimeStateManager, ledgerAdapter: LedgerAdapter }`.**

```typescript
interface CandidateIntakeServiceOptions {
  stateManager: RuntimeStateManager;
  ledgerAdapter: LedgerAdapter;
}
```

- `stateManager` provides `getCandidate()`, `getArtifact()`, and `updateCandidateStatus()`
- `ledgerAdapter` provides `writeProbationEntry()` and `existsForCandidate()`
- Caller (CLI handler in m7-04) creates both and injects them

Rationale: D-07 specifies DI pattern. `CandidateIntakeServiceOptions.ledgerAdapter` documented in m7-01 CONTEXT.

### E-06 — Build LedgerPrincipleEntry from CandidateRecord

**Decision: Service builds the 11-field entry from DB + artifact data.**

1. Load `CandidateRecord` via `stateManager.getCandidate(candidateId)`
2. Load `ArtifactRecord` via `stateManager.getArtifact(candidate.artifactRef)`
3. Parse `artifact.contentJson` as `DiagnosticianOutputV1` to get `recommendation`
4. Build entry:
   - `id`: generated UUID v4 (Decision A from m7-01: service generates)
   - `title`: from `candidate.title`
   - `text`: from recommendation or candidate description
   - `triggerPattern`: from recommendation.triggerPattern (or undefined)
   - `action`: from recommendation.action (or undefined)
   - `status`: `'probation'`
   - `evaluability`: `'weak_heuristic'`
   - `sourceRef`: `'candidate://${candidateId}'` (D-11)
   - `artifactRef`: `artifact://${candidate.artifactRef}'` (if present)
   - `taskRef`: from candidate.taskId (if present, D-07)
   - `createdAt`: new ISO timestamp

### Field Expansion — Handoff to Adapter

The service builds the 11-field `LedgerPrincipleEntry` and passes it to `adapter.writeProbationEntry()`. The adapter (m7-02) handles the 11→18+ field expansion. Service does NOT do field expansion.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & Interface (m7-01 — SHIPPED)
- `packages/principles-core/src/runtime-v2/candidate-intake.ts` — LedgerAdapter interface, LedgerPrincipleEntry, CandidateIntakeError, INTAKE_ERROR_CODES
- `packages/principles-core/src/runtime-v2/index.ts` — barrel exports for LedgerAdapter types

### Ledger Adapter (m7-02 — SHIPPED)
- `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts` — PrincipleTreeLedgerAdapter class
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — `addPrincipleToLedger()`, `LedgerPrinciple`

### State Management
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — `RuntimeStateManager`, `getCandidate()`, `getArtifact()`, `CandidateRecord`, `ArtifactRecord`
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — `CandidateRecord` schema (title, sourceRecommendationJson)

### Prior Phase Context
- `.planning/phases/m7-01-Candidate-Intake-Contract/m7-01-CONTEXT.md` — D-01 through D-12 decisions
- `.planning/phases/m7-01-Candidate-Intake-Contract/m7-01-01-SUMMARY.md` — m7-01 Plan 01 completion
- `.planning/phases/m7-02-PrincipleTreeLedger-Adapter/m7-02-CONTEXT.md` — m7-02 D-A through D-D decisions
- `.planning/phases/m7-02-PrincipleTreeLedger-Adapter/m7-02-01-SUMMARY.md` — m7-02 Plan 01 completion
- `.planning/phases/m7-02-PrincipleTreeLedger-Adapter/m7-02-02-SUMMARY.md` — m7-02 Plan 02 completion

### Test Patterns
- `.planning/phases/m6-06-E2E-Verification/m6-06-CONTEXT.md` — FakeCliProcessRunner, vi.mock patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RuntimeStateManager.getCandidate(candidateId)` — returns `CandidateRecord | null` from SQLite
- `RuntimeStateManager.getArtifact(artifactId)` — returns `ArtifactRecord | null`
- `CandidateRecord.sourceRecommendationJson` — contains `DiagnosticianOutputV1` JSON string
- `LedgerAdapter.writeProbationEntry(entry)` — writes to ledger, returns entry (passthrough)
- `LedgerAdapter.existsForCandidate(candidateId)` — O(1) Map lookup

### Service Location
- New file: `packages/principles-core/src/runtime-v2/candidate-intake-service.ts`
- New test: `packages/principles-core/tests/runtime-v2/candidate-intake-service.test.ts`
- Service lives in `principles-core` (shared contract), not `openclaw-plugin`

### Integration Points
- CLI handler (m7-04) instantiates `CandidateIntakeService` with `stateManager` and `ledgerAdapter`
- `stateManager` is created by CLI handler from `workspaceDir`
- `ledgerAdapter` is created by CLI handler with `stateDir` derived from `workspaceDir`

### DI Pattern
Following D-07 from m7-01: `CandidateIntakeServiceOptions.stateManager` + `ledgerAdapter`. Caller creates both and injects.

</code_context>

<deferred>
## Deferred Ideas

- **Promotion to active principle** — M8+ concern, not in M7 scope
- **Batch intake** — processing multiple candidates in one call, future phase
- **Pain signal bridge from intake** — explicitly non-goal per M7 boundary

</deferred>

---

*Phase: m7-03-CandidateIntakeService*
*Context gathered: 2026-04-26*
