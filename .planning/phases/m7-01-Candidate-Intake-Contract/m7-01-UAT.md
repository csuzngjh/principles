---
status: testing
phase: m7-01-Candidate-Intake-Contract
source: [m7-01-01-SUMMARY.md, m7-01-02-SUMMARY.md]
started: 2026-04-27T07:30:00Z
updated: 2026-04-27T07:30:00Z
---

## Current Test

number: 1
name: Candidate Intake Contract — Schema Validation
expected: |
  TypeBox schemas (CandidateIntakeInputSchema, CandidateIntakeOutputSchema,
  LedgerPrincipleEntrySchema) validate correctly at runtime.
  Invalid input is rejected, valid input passes validation.
awaiting: user response

## Tests

### 1. Candidate Intake Contract — Schema Validation
expected: TypeBox schemas (CandidateIntakeInputSchema, CandidateIntakeOutputSchema, LedgerPrincipleEntrySchema) validate correctly at runtime. Invalid input is rejected, valid input passes validation.
result: [pending]

### 2. Candidate Intake Contract — LedgerAdapter Interface
expected: LedgerAdapter interface correctly defines writeProbationEntry() and existsForCandidate() with proper TypeScript types. Implementing classes must provide these methods.
result: [pending]

### 3. Candidate Intake Contract — Error Codes
expected: CandidateIntakeError class has all 5 error codes (INPUT_INVALID, CANDIDATE_NOT_FOUND, ARTIFACT_NOT_FOUND, CANDIDATE_ALREADY_CONSUMED, LEDGER_WRITE_FAILED) and is throwable with correct code.
result: [pending]

### 4. Candidate Intake Contract — Idempotency via sourceRef
expected: existsForCandidate() matches by sourceRef = 'candidate://<candidateId>'. This is the idempotency key — same candidate always maps to same ledger entry.
result: [pending]

### 5. M7 End-to-End Flow (via CLI)
expected: Run `pd candidate intake --candidate-id <id>` on a pending candidate. Candidate is consumed, ledger entry is created with correct fields (id, title, text, status:probation, sourceRef:candidate://<id>).
result: [pending]

### 6. M7 Idempotency (via CLI)
expected: Run `pd candidate intake` twice on the same candidate. Second run returns same result (idempotent no-op), candidate is not modified.
result: [pending]

### 7. M7 Dry-Run Mode (via CLI)
expected: Run `pd candidate intake --candidate-id <id> --dry-run`. Output shows the ledger entry that would be created, without writing to ledger or changing candidate status.
result: [pending]

### 8. M7 Candidate List (via CLI)
expected: Run `pd candidate list`. Pending candidates and consumed candidates are both shown with correct status.
result: [pending]

### 9. M7 Candidate Show (via CLI)
expected: Run `pd candidate show <id>`. Output shows candidate details including ledger entry link (ledgerEntryId field).
result: [pending]

## Summary

total: 9
passed: 0
issues: 0
pending: 9
skipped: 0
blocked: 0

## Gaps

[none yet]
