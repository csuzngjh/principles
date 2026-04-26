# Phase m7-01: Candidate Intake Contract - Context

**Gathered:** 2026-04-26
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** Define the intake boundary — what a candidate is, what the committer wrote, what the ledger needs. This is the contract layer for the intake workflow: input schema, output schema, ledger entry contract, and adapter interface. Implementation logic (ConsumeService, CLI) belongs in m7-03 and m7-04.

**Scope anchor:** Schemas and interfaces only:
- `CandidateIntakeInput` / `CandidateIntakeOutput` schemas (TypeBox)
- `CandidateIntakeError` class with error codes
- `LedgerAdapter` interface (abstraction for writing to principle ledger)
- `LedgerPrincipleEntry` schema (probation-level principle record)
- Committer output → intake input mapping contract

</domain>

<decisions>
## Implementation Decisions

### Intake Input Schema (INTAKE-01, INTAKE-02)

- **D-01:** Intake input contains only `{ candidateId: string, workspaceDir: string }`. The DB is the single source of truth — all candidate data (DiagnosticianOutputV1 from artifact, candidate fields from principle_candidates) is loaded by `RuntimeStateManager.getCandidate()` and `getArtifact()`. No explicit field passthrough.
- **D-02:** `workspaceDir` is required because the ledger file path (`principle_training_state.json`) is derived from the workspace state directory — principles-core cannot hardcode the plugin's path convention.

### Ledger Entry Contract (LEDGER-01)

- **D-03:** Probation-level ledger entry uses a minimal field set:
  - `id` — generated unique ID
  - `title` — from candidate title (first 200 chars of description)
  - `text` — synthesized principle statement
  - `triggerPattern` — extracted from source recommendation (optional)
  - `action` — extracted from source recommendation (optional)
  - `status` — always `'probation'`
  - `evaluability` — always `'weak_heuristic'`
  - `sourceRef` — `artifact://<artifactId>` provenance link
  - `createdAt` — ISO timestamp
- **D-04:** Probation entry is written to the existing `principle_training_state.json` ledger file via `addPrincipleToLedger()` (openclaw-plugin). It uses the full `LedgerPrinciple` shape but most fields default to 0/empty — only the minimal set above is populated.
- **D-05:** No direct promotion to active principle in M7. The status remains `probation`.

### Ledger Adapter Architecture

- **D-06:** `LedgerAdapter` interface is defined in `principles-core` (packages/principles-core/src/runtime-v2/). Implementation lives in `openclaw-plugin` (packages/openclaw-plugin/src/core/).
- **D-07:** Adapter is injected into `CandidateIntakeService` via constructor dependency injection (`CandidateIntakeServiceOptions.ledgerAdapter`). Caller (CLI handler or test) creates the concrete implementation and passes it in.
- **D-08:** `LedgerAdapter` has two methods:
  - `writeProbationEntry(entry) → LedgerPrincipleEntry` — writes to `addPrincipleToLedger()`
  - `existsForCandidate(candidateId) → LedgerPrincipleEntry | null` — idempotency check

### Status Transition & Idempotency (INTAKE-05, INTAKE-06)

- **D-09:** Status transition order: write to ledger FIRST, then UPDATE `principle_candidates.status = 'consumed'`. If ledger write fails, candidate stays `pending` and the operation can be retried.
- **D-10:** Idempotent: re-intaking an already-consumed candidate returns the same `{ candidateId, artifactId, ledgerRef, status: 'consumed' }` result without error. No duplicate ledger write.
- **D-11:** Idempotency check uses `LedgerAdapter.existsForCandidate()` — if a ledger entry already exists for this candidateId (via sourceRef match), skip the write and return existing result.

### Error Handling

- **D-12:** `CandidateIntakeError` class with error codes:
  - `candidate_not_found` — candidateId does not exist in DB
  - `candidate_already_consumed` — status is already `consumed` (non-idempotent fallback)
  - `artifact_not_found` — candidate exists but associated artifact is missing (data integrity issue)
  - `ledger_write_failed` — ledger write operation failed
  - `input_invalid` — input schema validation failure

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & Protocol
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1 schema, DiagnosticianRecommendation (source of truth for recommendation fields: kind, description, triggerPattern?, action?, abstractedPrinciple?)
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — SqliteDiagnosticianCommitter, CommitResult (what the committer writes, principle_candidates table schema, field mapping)
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager, getCandidate(), getArtifact() methods
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` — SqliteConnection interface

### Ledger (Existing)
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — addPrincipleToLedger(), LedgerPrinciple type, HybridLedgerStore, getLedgerFilePath()
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` — Principle interface (LedgerPrinciple extends this, 20+ field schema)

### Existing Premature Draft (Review Before Finalizing)
- `packages/principles-core/src/runtime-v2/candidate-intake.ts` — Draft implementation written before GSD workflow. Contains CandidateIntakeInputSchema, CandidateIntakeOutputSchema, LedgerPrincipleEntrySchema, CandidateIntakeError, LedgerAdapter interface, CandidateIntakeService. Must be reviewed against CONTEXT.md decisions.

### Prior Phases
- `.planning/phases/m6-06-E2E-Verification/m6-06-CONTEXT.md` — M6 E2E test patterns, FakeCliProcessRunner
- `.planning/phases/m6-04-PD-CLI-Extension-Error-Mapping/m6-04-CONTEXT.md` — CLI patterns, error mapping, --json flag

### Roadmap
- `.planning/ROADMAP.md` §Phase m7-01 — Success criteria 1-5, requirements INTAKE-01~04, LEDGER-01

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RuntimeStateManager.getCandidate(candidateId)` — returns candidate row from SQLite (principle_candidates table)
- `RuntimeStateManager.getArtifact(artifactId)` — returns artifact row with content_json (DiagnosticianOutputV1)
- `addPrincipleToLedger(stateDir, LedgerPrinciple)` — existing ledger write function in openclaw-plugin
- `PDRuntimeError` — existing error class with categories, reusable for error mapping

### Established Patterns
- Interface-based abstraction with dependency injection (DiagnosticianCommitter pattern)
- TypeBox for schema definitions with Value.Check() for runtime validation
- Error classes with code constants (similar to INTAKE_ERROR_CODES pattern in draft)
- Immutable data patterns (spread objects, no mutation)

### Integration Points
- `LedgerAdapter` implementation in openclaw-plugin calls `addPrincipleToLedger(stateDir, ledgerPrinciple)` where stateDir is derived from workspaceDir
- `CandidateIntakeService` in principles-core receives `stateManager` and `ledgerAdapter` via constructor
- CLI handler (m7-04) creates concrete LedgerAdapter and passes it to CandidateIntakeService
- The `candidate-intake.ts` file exists but was written prematurely — must be reconciled with these decisions

</code_context>

<specifics>
## Specific Ideas

- The premature `candidate-intake.ts` draft is close to the discussed design but needs review:
  - CandidateIntakeInput currently has optional `artifactId` — remove per D-01 (lean input)
  - CandidateIntakeOutput matches discussed schema
  - LedgerPrincipleEntrySchema matches discussed minimal set
  - LedgerAdapter interface matches discussed design
  - CandidateIntakeService.intake() logic matches D-09/D-10 (ledger-first, idempotent)
  - Need to verify `existsForCandidate()` implementation uses sourceRef matching

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within m7-01 scope.

</deferred>

---

*Phase: m7-01-Candidate-Intake-Contract*
*Context gathered: 2026-04-26*
