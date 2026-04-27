---
plan: 01
phase: m7-03
status: complete
date: 2026-04-26
---

## Summary — Plan 01: Implement CandidateIntakeService

### What was built

`CandidateIntakeService` class in `packages/principles-core/src/runtime-v2/candidate-intake-service.ts`:

- Constructor accepts `{ stateManager: RuntimeStateManager, ledgerAdapter: LedgerAdapter }` (E-05)
- `intake(candidateId)` returns `Promise<LedgerPrincipleEntry>` (E-03)
- Idempotency: `adapter.existsForCandidate()` checked FIRST (E-02, D-10)
- On idempotent hit: returns existing entry from adapter Map (no-op)
- Loads candidate from DB via `stateManager.getCandidate()`
- Loads artifact via `stateManager.getArtifact(candidate.artifactId)`
- Parses artifact JSON to extract `recommendation` (title, text, triggerPattern, action)
- Builds 11-field `LedgerPrincipleEntry` (E-06):
  - `id`: generated UUID v4 (Decision A)
  - `title`: from `candidate.title`
  - `text`: from `recommendation.text` or `candidate.description`
  - `triggerPattern`: from `recommendation.triggerPattern` (optional)
  - `action`: from `recommendation.action` (optional)
  - `status`: `'probation'`
  - `evaluability`: `'weak_heuristic'`
  - `sourceRef`: `'candidate://${candidateId}'` (D-11)
  - `artifactRef`: `'artifact://${candidate.artifactId}'`
  - `taskRef`: `'task://${candidate.taskId}'` (if present)
  - `createdAt`: ISO 8601 timestamp
- Writes to ledger via `adapter.writeProbationEntry(entry)`
- Error handling: throws `CandidateIntakeError` with codes:
  - `INPUT_INVALID`: empty/invalid candidateId
  - `CANDIDATE_NOT_FOUND`: candidate not found in DB
  - `ARTIFACT_NOT_FOUND`: artifact missing or unparseable
  - `LEDGER_WRITE_FAILED`: adapter write failure
- Candidate stays `pending` on all error paths (E-01)
- DB status update to `'consumed'` is deferred to m7-04 CLI handler (D-09)

### Deviations

None. All decisions E-01 through E-06 from CONTEXT.md were honored exactly.

### Self-Check: PASSED

- [x] TypeScript compilation passes (`npx tsc --noEmit`)
- [x] Lint passes (`npx eslint`)
- [x] Class implements all required behavior from CONTEXT.md
- [x] All 6 decisions (E-01 through E-06) honored
- [x] Export added to `runtime-v2/index.ts`

### Commits

- `f1c815e6` feat(m7-03): implement CandidateIntakeService class
