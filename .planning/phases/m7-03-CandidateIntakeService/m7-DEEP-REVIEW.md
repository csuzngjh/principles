# M7 Phase Deep Code Review (m7-01, m7-02, m7-03)

**Review Date:** 2026-04-26
**Reviewer:** Deep Code Review (Deep Mode)
**Phases Reviewed:** m7-01 (Contract), m7-02 (Adapter), m7-03 (Service)
**Files Reviewed:**
- `packages/principles-core/src/runtime-v2/candidate-intake.ts`
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts`
- `packages/openclaw-plugin/src/core/principle-tree-ledger-adapter.ts`
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts`
- `packages/principles-core/tests/runtime-v2/candidate-intake-service.test.ts`
- `packages/openclaw-plugin/tests/core/principle-tree-ledger-adapter.test.ts`

---

## Executive Summary

The M7 implementation (Candidate Intake pipeline) is well-structured with clear separation of concerns across three phases: contract (m7-01), adapter (m7-02), and service (m7-03). The code quality is high with comprehensive JSDoc, strong TypeBox schema discipline, and thorough test coverage for the happy path.

**3 issues found: 1 HIGH severity, 2 MEDIUM severity.**

---

## Severity Definitions

| Level | Meaning |
|-------|---------|
| **HIGH** | Produces duplicate ledger entries across CLI invocations, breaking idempotency (M7 hard requirement) |
| **MEDIUM** | Information loss, missing validation, or consistency gap that could cause production issues |
| **LOW** | Code quality, observability, or minor design concerns |

---

## Findings

### [HIGH] Cross-Process Idempotency Failure

**Location:** `principle-tree-ledger-adapter.ts` — `existsForCandidate()` + `#entryMap`

**Problem:**
`PrincipleTreeLedgerAdapter` uses an **in-memory Map** (`#entryMap`) for idempotency checks. This Map is only populated after `writeProbationEntry()` succeeds within the **same process instance**. When the CLI process exits and a new invocation occurs for the same candidate:

1. New process starts → `#entryMap` is **empty**
2. `existsForCandidate(candidateId)` returns `null` (Map is empty, not pre-loaded from ledger)
3. `intake()` proceeds to write a **new entry with a new UUID**
4. Ledger ends up with **duplicate entries** for the same candidate

The root cause is a **two-layer idempotency mismatch**:
- Layer 1: `existsForCandidate()` checks only in-memory Map
- Layer 2: `addPrincipleToLedger()` uses overwrite-by-`principle.id` (UUID, not candidateId)

```typescript
// principle-tree-ledger-adapter.ts:15
#entryMap = new Map<string, LedgerPrincipleEntry>(); // ← empty on process start

// principle-tree-ledger-adapter.ts:30-32
const existing = this.#entryMap.get(candidateId);
if (existing) return existing; // ← returns null for entries written by PREVIOUS processes

// candidate-intake-service.ts:111
id: randomUUID(), // ← NEW UUID every time, even for the same candidate
```

**Impact:**
- Violates **M7 Success Criteria #5**: "Running intake twice is idempotent and does not duplicate the principle"
- One candidate can produce **multiple ledger entries** across CLI restarts
- Breaks traceability: multiple `candidate://<id>` entries for the same candidate

**Recommendation:**
`existsForCandidate()` must query the **ledger file itself** (via `loadLedger()`) using `sourceRef` as the matching key, not rely solely on the in-memory Map:

```typescript
existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
  // Check in-memory first (fast path for same-process repeat calls)
  const cached = this.#entryMap.get(candidateId);
  if (cached) return cached;

  // Check ledger file (covers cross-process idempotency)
  const ledger = loadLedger(this.#stateDir);
  const found = Object.values(ledger.tree.principles)
    .find(p => p.sourceRef === `candidate://${candidateId}`);
  return found ?? null;
}
```

**Test Gap:**
No test covers the scenario of `existsForCandidate` being called for a candidate that exists in the ledger file but not in the adapter's in-memory Map.

---

### [MEDIUM] `evaluability` Field Not Validated on Expansion

**Location:** `principle-tree-ledger-adapter.ts` — `#expandToLedgerPrinciple()`

**Problem:**
The adapter passes `entry.evaluability` through to the `LedgerPrinciple` without validating it against `LedgerPrinciple.evaluability` which accepts only `'deterministic' | 'weak_heuristic' | 'manual_only'`.

```typescript
// principle-tree-ledger-adapter.ts:90
evaluability: entry.evaluability, // ← no validation

// principle-tree-schema.ts:36-39
export type PrincipleEvaluability =
  | 'manual_only'
  | 'deterministic'
  | 'weak_heuristic'; // ← only 3 valid values
```

If an artifact's parsed `recommendation` contains an invalid `evaluability` value, it would silently enter the ledger. While `CandidateIntakeService` sets `evaluability: 'weak_heuristic'` (a valid constant), the adapter's design allows any value through, creating an implicit coupling to the service's correctness.

**Recommendation:**
Add validation in `#expandToLedgerPrinciple()`:

```typescript
const VALID_EVALUABILITIES = ['deterministic', 'weak_heuristic', 'manual_only'] as const;
if (!VALID_EVALUABILITIES.includes(entry.evaluability)) {
  throw new CandidateIntakeError(
    INTAKE_ERROR_CODES.INTAKE_INVALID,
    `Invalid evaluability: ${entry.evaluability}`,
  );
}
```

---

### [MEDIUM] `title` Field Silently Dropped During Field Expansion

**Location:** `principle-tree-ledger-adapter.ts` — `#expandToLedgerPrinciple()`

**Problem:**
`CandidateIntakeService.intake()` sets `entry.title = candidate.title` (required field in `LedgerPrincipleEntry`), but `#expandToLedgerPrinciple()` does **not** include `title` in the output `LedgerPrinciple` object. `LedgerPrinciple` (from `principle-tree-schema.ts`) has **no `title` field**.

```typescript
// candidate-intake-service.ts:112
entry: LedgerPrincipleEntry = {
  title: candidate.title, // ← set here
  ...
};

// principle-tree-ledger-adapter.ts:83-101 — title is absent from result
const result: LedgerPrinciple = {
  id: entry.id,
  version: 1,
  text: entry.text,
  // ... no title field
};
```

**Field provenance** in `candidate-intake.ts:22-24` documents `title` as "Extracted from artifact" with "Always" reliability. The field provenance table (lines 19-34) does not include `title` in the expansion map, but the fact that it's a required field in `LedgerPrincipleEntry` while being absent from `LedgerPrinciple` creates an inconsistency.

**Impact:**
- Title information is captured at intake but **never persisted** to the ledger
- Future ledger consumers cannot access principle titles
- May complicate M8+ features that need to display principle titles

**Recommendation:**
Either:
1. Add `title: entry.title` to `LedgerPrinciple` in `principle-tree-schema.ts` (if title belongs in the ledger), or
2. Document the intentional exclusion in `#expandToLedgerPrinciple()` JSDoc

**Severity Note:** Marked MEDIUM because the current contract doesn't promise title persistence, and `text` carries the semantic content. However, since `title` is a required field in `LedgerPrincipleEntry` (a contract), its silent dropping could mislead future developers.

---

## Additional Observations (Not Bugs)

### ✅ Well-Designed Aspects

1. **Clear phase separation**: Contract (m7-01), Adapter (m7-02), Service (m7-03) boundaries are well-defined with single responsibilities.

2. **Comprehensive TypeBox schemas**: `CandidateIntakeInputSchema`, `LedgerPrincipleEntrySchema` provide runtime validation without额外的代码.

3. **Detailed field provenance documentation**: The provenance table in `candidate-intake.ts` lines 19-63 is exemplary—clearly documents every field's origin, reliability, and nullability.

4. **Idempotency in `addPrincipleToLedger`**: Uses **overwrite semantics** by principle ID (`store.tree.principles[principle.id] = principle`), which provides a safety net at the storage layer.

5. **Error code design**: `CandidateIntakeError` with structured `code` + `context` + `cause` enables precise error handling upstream.

6. **Test coverage is thorough** for single-process scenarios:
   - Happy path (entry writing, field values)
   - Double-intake (same-process idempotency)
   - Error paths (CANDIDATE_NOT_FOUND, ARTIFACT_NOT_FOUND, LEDGER_WRITE_FAILED)
   - Field expansion defaults

7. **`CandidateIntakeService` defers status update**: Correctly leaves `updateCandidateStatus` to m7-04 CLI handler per design.

### ⚠️ Minor Observations

**1. `workspaceDir` is passed but not validated in the service**
`CandidateIntakeInput` requires `workspaceDir: string`, but `CandidateIntakeService.intake()` never references it. The field is used by the caller (m7-04 CLI) to construct `RuntimeStateManager`. This is intentional (DI pattern), but worth documenting in the service JSDoc.

**2. JSON parse error uses `ARTIFACT_NOT_FOUND` code**
When `JSON.parse(artifact.contentJson)` fails, the thrown error uses `INTAKE_ERROR_CODES.ARTIFACT_NOT_FOUND`. This is semantically questionable (artifact exists but is malformed, not missing), but is consistent with other artifact error handling and doesn't break functionality.

**3. `Recommendation` interface is a private type**
`CandidateIntakeService` defines its own `Recommendation` interface (lines 26-31) rather than importing a shared type. This is fine within the service but represents a slight coupling to the `contentJson` shape.

**4. No stress test for large ledger files**
`existsForCandidate` with ledger-file lookup would need to scan all principles. For m7 scale this is fine (candidate volume is low), but if M8 scales up pain signal ingestion, this could become a performance concern.

---

## Test Coverage Assessment

| Scenario | Covered? |
|----------|----------|
| Happy path | ✅ |
| Same-process double intake | ✅ |
| CANDIDATE_NOT_FOUND | ✅ |
| ARTIFACT_NOT_FOUND (null artifact) | ✅ |
| ARTIFACT_NOT_FOUND (malformed JSON) | ✅ |
| LEDGER_WRITE_FAILED (CandidateIntakeError) | ✅ |
| LEDGER_WRITE_FAILED (generic error) | ✅ |
| INPUT_INVALID (empty/non-string) | ✅ |
| Candidate stays pending on errors | ✅ |
| `sourceRef` format | ✅ |
| `artifactRef` format | ✅ |
| Minimal artifact (no triggerPattern/action) | ✅ |
| Text fallback from candidate.description | ✅ |
| Adapter field expansion defaults | ✅ |
| Adapter `status` mapping (`probation` → `candidate`) | ✅ |
| Adapter pass-through of triggerPattern/action | ✅ |
| Adapter exclusion of sourceRef/artifactRef/taskRef | ✅ |
| Adapter `derivedFromPainIds` population | ✅ |
| Adapter instance isolation | ✅ |
| **Cross-process idempotency** | ❌ Missing |
| **Invalid `evaluability` value** | ❌ Missing |
| **`title` field persistence** | ❌ Missing |
| **Malformed `sourceRef` format** | ❌ Missing |

**Coverage: ~80% of scenarios. Missing cross-process and adversarial cases.**

---

## Recommendations Summary

| Priority | Issue | Fix Approach |
|----------|-------|-------------|
| **HIGH** | Cross-process idempotency failure | `existsForCandidate()` must query ledger file by `sourceRef` |
| **MEDIUM** | `evaluability` not validated on expansion | Add enum validation in `#expandToLedgerPrinciple()` |
| **MEDIUM** | `title` silently dropped | Add to `LedgerPrinciple` or document intentional exclusion |

**All three issues are addressable without breaking changes to the m7-04 CLI interface.**

---

## Verification Commands

```bash
# Run m7-02 adapter tests
cd packages/openclaw-plugin && pnpm test principle-tree-ledger-adapter.test.ts

# Run m7-03 service tests
cd packages/principles-core && pnpm test candidate-intake-service.test.ts

# Type check
cd packages/principles-core && pnpm typecheck
cd packages/openclaw-plugin && pnpm typecheck

# Build
cd packages/principles-core && pnpm build
cd packages/openclaw-plugin && pnpm build
```
