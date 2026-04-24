# m5-02 Context: DiagnosticianCommitter Core

## Phase Overview

**Parent milestone:** m5 (Unified Commit + Principle Candidate Intake)
**Depends on:** m5-01 (Artifact Registry Schema DDL — commit f88e9de2)
**Requirements:** COMT-01 through COMT-06

## Input/Output Contracts

### CommitInput
```typescript
interface CommitInput {
  runId: string;
  taskId: string;
  output: DiagnosticianOutputV1;
  idempotencyKey: string;
}
```

### CommitResult
```typescript
interface CommitResult {
  commitId: string;
  artifactId: string;
  candidateCount: number;
}
```

### DiagnosticianOutputV1 Schema (existing, from diagnostician-output.ts)
```typescript
{
  valid: boolean;
  diagnosisId: string;
  taskId: string;
  summary: string;
  rootCause: string;
  violatedPrinciples: Array<{ principleId?: string; title?: string; rationale: string }>;
  evidence: Array<{ sourceRef: string; note: string }>;
  recommendations: Array<{ kind: 'principle' | 'rule' | 'implementation' | 'prompt' | 'defer'; description: string }>;
  confidence: number;
  ambiguityNotes?: string[];
}
```

**Key extraction rule:** `recommendations[kind='principle']` → one `PrincipleCandidateRecord` per entry. Entries missing `title` or `description` use `principleId` or fallback to `description` respectively.

## Design Decisions

### 1. DiagnosticianCommitter Interface Location
- **File:** `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts`
- The interface is the public contract; implementation can be in same file or co-located
- Follows pattern of `task-store.ts` (interface) + `sqlite-task-store.ts` (impl)

### 2. Single-File Implementation
- Since this is a focused atomic unit (one class, one method), co-locate interface + class in `diagnostician-committer.ts`
- If complexity grows, extract `SqliteDiagnosticianCommitter` to `sqlite-diagnostician-committer.ts` (YAGNI for now)

### 3. ID Generation
- Use `crypto.randomUUID()` for `commit_id` and `candidate_id` (available in Node 19+/bundlers)
- Matches existing patterns in codebase (no external UUID library needed)

### 4. Candidate Idempotency Key Derivation
- Each `PrincipleCandidateRecord.idempotency_key` = `{commitId}:{index}` where index is the 0-based position in the recommendations array
- Guarantees uniqueness per commit + per recommendation slot
- If recommendations array is empty, candidateCount = 0, no duplicate risk

### 5. Transaction Boundary
```sql
BEGIN IMMEDIATE;  -- IMMEDIATE not DEFERRED to acquire write lock now
-- 1. Insert artifact (no UNIQUE on artifact — always new per run)
-- 2. Insert commit (UNIQUE on run_id + idempotency_key — catches re-commit)
-- 3. Insert all principle_candidates (UNIQUE on idempotency_key — catches duplicates)
COMMIT;
-- On any error: ROLLBACK (automatic via better-sqlite3 transaction)
```

### 6. Error Handling
- **UNIQUE constraint violation on `commits.run_id`:** Means this run was already committed → return existing commit info
- **UNIQUE constraint violation on `commits.idempotency_key`:** Same input re-submitted → return existing commit info
- **UNIQUE constraint violation on `candidates.idempotency_key`:** Should not happen if using derived keys above, but catch and return existing
- All errors wrapped as `PDRuntimeError` with `artifact_commit_failed` category
- `details` field carries `{originalError, constraint}` for debugging

### 7. Re-commit Idempotency Handling
Per COMT-04: on re-commit, detect existing commit via UNIQUE constraint, return `{ commitId, artifactId, candidateCount }` from existing row — no error thrown.

Implementation:
```typescript
try {
  // Attempt insert
} catch (err) {
  if (isUniqueConstraintError(err)) {
    // Query existing rows and return found result
  } else {
    throw wrapError(err);
  }
}
```

### 8. Validation
- Validate `input.output` is a valid `DiagnosticianOutputV1` using `Value.Check()` from TypeBox
- If invalid, throw `PDRuntimeError{input_invalid}` with details
- No need to validate individual recommendations — schema already enforces structure

### 9. Exported Types
```typescript
export interface DiagnosticianCommitter {
  commit(input: CommitInput): Promise<CommitResult>;
}
export type { CommitInput, CommitResult };
```

## Threat Model Alignment

No new threat surface introduced:
- All SQL uses parameterized queries (no injection risk)
- No external network calls
- No auth/authorization changes
- Input validation via TypeBox schema
- Idempotency via DB UNIQUE constraints

## Verification

- Unit tests: `diagnostician-committer.test.ts`
- Run: `cd packages/principles-core && npx vitest run`
- Expected: all tests pass
