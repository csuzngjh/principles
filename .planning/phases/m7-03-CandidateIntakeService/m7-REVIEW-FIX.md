# M7 Code Review Fixes (m7-01, m7-02, m7-03)

**Fixed:** 2026-04-26
**Phase:** m7 (Candidate Intake pipeline — m7-01 Contract, m7-02 Adapter, m7-03 Service)

---

## Fixes Applied

### 1. [HIGH] Cross-Process Idempotency Failure — `existsForCandidate()`

**File:** `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts`

**Root Cause:** `existsForCandidate()` only checked an in-memory `Map`. After CLI exit, a new process started with an empty Map, causing `existsForCandidate()` to return `null` for candidates who already had ledger entries. This produced duplicate ledger entries across separate CLI invocations.

**Fix:** `existsForCandidate()` now checks both:
1. **In-memory Map** (fast path for same-process repeat calls)
2. **Ledger file via `loadLedger()`** — scans `tree.principles` by `derivedFromPainIds.includes(candidateId)` (cross-process path)

When a match is found in the ledger file, a minimal `LedgerPrincipleEntry` is reconstructed (with empty `artifactRef`/`taskRef` since those aren't stored in `LedgerPrinciple`).

**Test Gap:** A dedicated cross-process idempotency test should be added in a follow-up.

---

### 2. [MEDIUM] `evaluability` Field Not Validated on Expansion

**File:** `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts`

**Root Cause:** `#expandToLedgerPrinciple()` passed `entry.evaluability` directly to `LedgerPrinciple` without validating it against the 3 valid enum values.

**Fix:** Added validation guard at the top of `#expandToLedgerPrinciple()`:

```typescript
if (!VALID_EVALUABILITIES.includes(entry.evaluability as (typeof VALID_EVALUABILITIES)[number])) {
  throw new CandidateIntakeError(
    INTAKE_ERROR_CODES.INPUT_INVALID,
    `Invalid evaluability value: ${entry.evaluability}. Must be one of: ${VALID_EVALUABILITIES.join(', ')}`,
  );
}
```

Note: `INPUT_INVALID` (not `INTAKE_INVALID`) is the correct code per `INTAKE_ERROR_CODES`.

---

### 3. [MEDIUM] `title` Field Silently Dropped During Field Expansion

**File:** `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts`

**Root Cause:** `CandidateIntakeService` sets `entry.title` (required in `LedgerPrincipleEntry`), but `#expandToLedgerPrinciple()` didn't include it in the output `LedgerPrinciple`, and `LedgerPrinciple` has no `title` field.

**Fix:** Documented the intentional exclusion in the JSDoc for `#expandToLedgerPrinciple()`:

```
- title is NOT written to LedgerPrinciple — intentionally excluded; title
  is available in LedgerPrincipleEntry but LedgerPrinciple has no title field
```

**Recommendation for follow-up:** If title persistence in the ledger is needed, add `title?: string` to `Principle` in `principle-tree-schema.ts` and include it in the expansion.

---

## Verification

```bash
# All 30 tests pass (12 adapter + 18 service)
npx vitest run \
  packages/openclaw-plugin/tests/core/principle-tree-ledger-adapter.test.ts \
  packages/principles-core/tests/runtime-v2/candidate-intake-service.test.ts

# No TypeScript errors in modified file
lsp_diagnostics on principle-tree-ledger-adapter.ts → Clean

# principles-core builds cleanly
cd packages/principles-core && pnpm build → Clean

# openclaw-plugin build has pre-existing errors (missing openclaw-sdk.js dependency,
# unrelated to these fixes)
```

---

## Files Changed

| File | Change |
|------|--------|
| `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts` | All 3 fixes applied |
