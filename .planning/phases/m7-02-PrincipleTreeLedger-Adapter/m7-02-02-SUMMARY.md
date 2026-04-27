---
phase: m7-02
plan: 02
status: complete
completed: 2026-04-26
---

## Summary

**Comprehensive tests** created in `packages/openclaw-plugin/tests/core/principle-tree-ledger-adapter.test.ts`.

### What was built

12 test cases covering all LEDGER-02 and LEDGER-03 requirements:

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | writeProbationEntry happy path | LedgerPrinciple written with correct field expansion |
| 2 | Idempotency | Second call same candidateId returns existing, no duplicate write |
| 3 | Different candidates | Different entries produce different ledger entries |
| 4 | existsForCandidate known | Returns entry for previously written candidate |
| 5 | existsForCandidate unknown | Returns null for unknown candidate |
| 6 | Status mapping | `'probation'` → `'candidate'` in ledger |
| 7 | Default values | version:1, priority:'P1', scope:'general', valueScore:0, etc. |
| 8 | triggerPattern/action passthrough | Values pass through; empty string when absent (Decision B) |
| 9 | sourceRef/artifactRef/taskRef excluded | NOT in ledger file (Decision C) |
| 10 | derivedFromPainIds | Populated with candidateId (Q1 resolved) |
| 11 | LEDGER_WRITE_FAILED | Thrown when addPrincipleToLedger fails |
| 12 | Instance isolation | Separate adapter instances have separate Maps |

### Verification

- `npx vitest run tests/core/principle-tree-ledger-adapter.test.ts` — 12/12 passed
- Temp directory isolation: each test creates its own temp dir, cleaned up in afterEach
- Test file follows existing project conventions (vitest, fs.mkdtempSync, safeRmDir)
- ESM `.js` import extensions for local files

### Commits

- `973856f0` test(m7-02): add comprehensive tests for PrincipleTreeLedgerAdapter

### Next

Phase m7-02 complete. Ready for verification.
