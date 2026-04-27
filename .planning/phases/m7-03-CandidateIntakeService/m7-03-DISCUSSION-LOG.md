---
phase: m7-03
discussion_date: 2026-04-26
discussion_type: auto-selected (all recommended options)
---

## Discussion Log — Phase m7-03: CandidateIntakeService

### Area 1: Error Handling Strategy

**Options presented:**
- Option A (Recommended): Candidate stays `pending`, return `CandidateIntakeError` (ledger fail / candidate not found / artifact missing)
- Option B: Different handling per error type, some scenarios mark `expired`
- Note: D-09 specifies ledger-first-then-DB-update order

**User selection:** "采用你推荐的方案吧" (Adopt recommended options for all areas)

**Decision (E-01):** Intake failure keeps candidate `pending`, returns `CandidateIntakeError`.

---

### Area 2: Idempotency Check Order

**Options presented:**
- Option A (Recommended): Check `adapter.existsForCandidate()` FIRST — O(1) memory lookup
- Option B: Check DB `status === 'consumed'` first, then adapter
- Note: D-11 specifies adapter.existsForCandidate as the idempotency check

**User selection:** Recommended option (auto-applied)

**Decision (E-02):** Check adapter.existsForCandidate() FIRST. DB check is secondary validation.

---

### Area 3: Return Value Design

**Options presented:**
- Option A (Recommended): Return `LedgerPrincipleEntry` (consistent with m7-01 LedgerAdapter interface)
- Option B: Return richer result object `{ candidateId, ledgerEntry, status }`
- Note: D-10 says "returns existing ledger entry" on re-intake

**User selection:** Recommended option (auto-applied)

**Decision (E-03):** `intake(candidateId)` returns `LedgerPrincipleEntry`.

---

### Area 4: Artifact Validation

**Options presented:**
- Option A (Recommended): Reject with `ARTIFACT_NOT_FOUND`, candidate stays `pending`
- Option B: Allow intake without artifact (would need m7-01 schema relaxation)
- Note: Success Criteria #4 says "Candidate without artifact: rejected"

**User selection:** Recommended option (auto-applied)

**Decision (E-04):** Candidate without valid artifact → reject with `ARTIFACT_NOT_FOUND`.

---

### Area 5: Service Constructor Dependencies

**Options presented:**
- Option A (Recommended): `{ stateManager: RuntimeStateManager, ledgerAdapter: LedgerAdapter }`
- Option B: Also pass `workspaceDir` or derive from stateManager
- Note: D-07 mentions `CandidateIntakeServiceOptions.ledgerAdapter`

**User selection:** Recommended option (auto-applied)

**Decision (E-05):** Constructor takes `{ stateManager, ledgerAdapter }`. Caller creates both and injects.

---

## Summary of Decisions

| Decision | Description |
|-----------|-------------|
| E-01 | Error → candidate stays `pending`, throw `CandidateIntakeError` |
| E-02 | Idempotency: check adapter FIRST (O(1) lookup) |
| E-03 | Return `LedgerPrincipleEntry` from `intake()` |
| E-04 | Artifact missing → `ARTIFACT_NOT_FOUND` rejection |
| E-05 | DI: `{ stateManager, ledgerAdapter }` |
| E-06 | Service builds 11-field entry, adapter expands to 18+ |

## Deferred Ideas

- Promotion to active principle — M8+ concern
- Batch intake for multiple candidates — future phase
- Pain signal bridge from intake — explicitly non-goal per M7 boundary

---

*Discussion completed: 2026-04-26*
