---
plan: 02
phase: m7-03
status: complete
date: 2026-04-26
---

## Summary — Plan 02: Comprehensive Tests for CandidateIntakeService

### What was built

`packages/principles-core/tests/runtime-v2/candidate-intake-service.test.ts` with 18 test cases:

**Happy path (3 tests):**
- Writes ledger entry and returns LedgerPrincipleEntry
- Built entry has correct 11 fields (id, title, text, triggerPattern, action, status, evaluability, sourceRef, artifactRef, taskRef, createdAt)
- Does NOT update candidate status in service (deferred to m7-04)

**Idempotency (2 tests):**
- Returns existing entry if adapter already has it (E-02, D-10)
- Different candidates produce different entries

**Error handling (8 tests):**
- `CANDIDATE_NOT_FOUND` when candidate does not exist (E-01)
- `ARTIFACT_NOT_FOUND` when artifact is missing (E-04)
- `ARTIFACT_NOT_FOUND` when artifact content parse fails
- `LEDGER_WRITE_FAILED` when adapter throws CandidateIntakeError
- `LEDGER_WRITE_FAILED` when adapter throws generic Error
- `INPUT_INVALID` for empty string
- `INPUT_INVALID` for non-string input (null)
- Candidate stays pending on ALL error paths (E-01)

**Field validation (5 tests):**
- `sourceRef` format is `candidate://<id>` (D-11)
- `artifactRef` is `artifact://<artifactId>`
- Handles minimal artifact without triggerPattern/action
- Uses description as fallback for text when recommendation text is empty

### Self-Check: PASSED

- [x] All 18 tests pass (`npx vitest run`)
- [x] Tests cover all 4 error codes (INPUT_INVALID, CANDIDATE_NOT_FOUND, ARTIFACT_NOT_FOUND, LEDGER_WRITE_FAILED)
- [x] Tests verify decisions E-01 through E-06
- [x] Tests verify D-10 (idempotent success), D-11 (sourceRef format)
- [x] Tests verify E-01: candidate stays pending on all error paths
- [x] Mock objects use `vi.fn()` for all methods
- [x] No test leaks between cases (fresh mocks in beforeEach)

### Commits

- `96888bf3` test(m7-03): add comprehensive tests for CandidateIntakeService
