# Phase m7-01: Candidate Intake Contract - Research

**Researched:** 2026-04-26
**Domain:** TypeBox schema definition, interface contracts, TypeScript type design
**Confidence:** HIGH

## Summary

This phase defines the intake boundary between M6's `principle_candidates` table (SQLite) and the principle ledger (`principle_training_state.json` in openclaw-plugin). It is purely a SCHEMA/CONTRACT phase -- no runtime logic, no DB writes, no CLI. The premature `candidate-intake.ts` draft provides a starting point but has three discrepancies against the 12 locked CONTEXT.md decisions: (1) `CandidateIntakeInputSchema` includes optional `artifactId` that D-01 explicitly excludes, (2) `LedgerAdapter.writeProbationEntry` type signature claims to omit `id | createdAt` but the call site passes both, and (3) the draft bundles `CandidateIntakeService` implementation logic that belongs in m7-03.

**Primary recommendation:** Strip `artifactId` from input schema, fix the `writeProbationEntry` type to accept full `LedgerPrincipleEntry`, extract `CandidateIntakeService` class into a separate file for m7-03, and keep m7-01 strictly to schemas + interfaces + error class + adapter interface.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Input/output schema definitions | principles-core (shared lib) | -- | Schemas are shared between core lib and plugin; no runtime dependency |
| LedgerAdapter interface | principles-core (shared lib) | -- | Interface defined in core, implemented in openclaw-plugin per D-06 |
| Probation entry schema | principles-core (shared lib) | -- | `LedgerPrincipleEntry` schema lives in core, consumed by m7-02 adapter |
| Error class definitions | principles-core (shared lib) | -- | `CandidateIntakeError` is a core contract error, not plugin-specific |
| LedgerPrinciple shape (full) | openclaw-plugin (types) | -- | `LedgerPrinciple` extends `Principle` in plugin's `principle-tree-schema.ts` |
| Ledger write (addPrincipleToLedger) | openclaw-plugin (core) | -- | File-locked JSON mutation in `principle-tree-ledger.ts` |

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

These are verbatim from `m7-01-CONTEXT.md` -- RESEARCHED DEEPLY, NO ALTERNATIVES.

#### Intake Input Schema (INTAKE-01, INTAKE-02)

- **D-01:** Intake input contains only `{ candidateId: string, workspaceDir: string }`. The DB is the single source of truth -- all candidate data (DiagnosticianOutputV1 from artifact, candidate fields from principle_candidates) is loaded by `RuntimeStateManager.getCandidate()` and `getArtifact()`. No explicit field passthrough.
- **D-02:** `workspaceDir` is required because the ledger file path (`principle_training_state.json`) is derived from the workspace state directory -- principles-core cannot hardcode the plugin's path convention.

#### Ledger Entry Contract (LEDGER-01)

- **D-03:** Probation-level ledger entry uses a minimal field set: `id`, `title`, `text`, `triggerPattern` (optional), `action` (optional), `status` ('probation'), `evaluability` ('weak_heuristic'), `sourceRef`, `createdAt`.
- **D-04:** Probation entry is written to the existing `principle_training_state.json` ledger file via `addPrincipleToLedger()` (openclaw-plugin). It uses the full `LedgerPrinciple` shape but most fields default to 0/empty -- only the minimal set above is populated.
- **D-05:** No direct promotion to active principle in M7. The status remains `probation`.

#### Ledger Adapter Architecture

- **D-06:** `LedgerAdapter` interface is defined in `principles-core` (packages/principles-core/src/runtime-v2/). Implementation lives in `openclaw-plugin` (packages/openclaw-plugin/src/core/).
- **D-07:** Adapter is injected into `CandidateIntakeService` via constructor dependency injection (`CandidateIntakeServiceOptions.ledgerAdapter`). Caller (CLI handler or test) creates the concrete implementation and passes it in.
- **D-08:** `LedgerAdapter` has two methods: `writeProbationEntry(entry) -> LedgerPrincipleEntry` and `existsForCandidate(candidateId) -> LedgerPrincipleEntry | null`.

#### Status Transition & Idempotency (INTAKE-05, INTAKE-06)

- **D-09:** Status transition order: write to ledger FIRST, then UPDATE `principle_candidates.status = 'consumed'`. If ledger write fails, candidate stays `pending` and the operation can be retried.
- **D-10:** Idempotent: re-intaking an already-consumed candidate returns the same `{ candidateId, artifactId, ledgerRef, status: 'consumed' }` result without error. No duplicate ledger write.
- **D-11:** Idempotency check uses `LedgerAdapter.existsForCandidate()` -- if a ledger entry already exists for this candidateId (via sourceRef match), skip the write and return existing result.

#### Error Handling

- **D-12:** `CandidateIntakeError` class with error codes: `candidate_not_found`, `candidate_already_consumed`, `artifact_not_found`, `ledger_write_failed`, `input_invalid`.

### Claude's Discretion

*No discretion areas specified in CONTEXT.md -- all 12 decisions are locked.*

### Deferred Ideas (OUT OF SCOPE)

None -- discussion stayed within m7-01 scope.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INTAKE-01 | `CandidateIntakeInput` schema: `{ candidateId, workspaceDir }` only [D-01] | Section: Standard Stack, D-01 Gap Analysis |
| INTAKE-02 | `CandidateIntakeOutput` schema: `{ candidateId, artifactId, ledgerRef, status: 'consumed' }` | Section: Code Examples, Draft Review |
| INTAKE-03 | `CandidateIntakeError` class with 5 error codes [D-12] | Section: Error Patterns |
| INTAKE-04 | `LedgerAdapter` interface: `writeProbationEntry()`, `existsForCandidate()` [D-08] | Section: Ledger Adapter Contract, Draft Review |
| LEDGER-01 | `LedgerPrincipleEntry` schema for probation-level principle records [D-03] | Section: Ledger Contract Depth, Draft Review |
</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @sinclair/typebox | 0.34.48 [VERIFIED: npm registry] | Runtime schema validation | Already used across all runtime-v2 schemas (22+ schema exports in index.ts); `Value.Check()` + `Value.Errors()` pattern is established |
| TypeScript | 5.x (project strict mode) | Type system | Project standard; strict mode enforces explicit types |
| vitest | 4.1.0 [VERIFIED: package.json] | Test framework | Both packages use vitest with `describe/it/expect` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| crypto (Node built-in) | -- | `randomUUID()` for ID generation | Generating unique IDs for principle entries |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @sinclair/typebox Static<T> | zod (z.infer) | TypeBox already entrenched; switching would break 22+ existing schema exports |
| Manual JSON validation | TypeBox Value.Check() | TypeBox provides typed errors via Value.Errors() iterator; manual validation is error-prone |

**Installation:**
```bash
# No new packages needed -- @sinclair/typebox already at 0.34.48 in principles-core
```

**Version verification:**
- @sinclair/typebox: project locked at 0.34.48, latest npm is 0.34.49 [VERIFIED: npm registry 2026-04-26]. Within minor -- no breaking API changes.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    m7-01 CONTRACT LAYER                      │
│                    (principles-core)                         │
│                                                              │
│  ┌──────────────────┐    ┌───────────────────────────┐      │
│  │ CandidateIntake   │    │ LedgerPrincipleEntry      │      │
│  │ Input / Output    │    │ Schema (TypeBox)          │      │
│  │ Schemas (TypeBox) │    │ - id, title, text         │      │
│  └────────┬─────────┘    │ - triggerPattern?, action? │      │
│           │              │ - status: 'probation'      │      │
│           │              │ - evaluability: 'weak_...' │      │
│           │              │ - sourceRef, createdAt      │      │
│           │              └─────────────┬───────────────┘      │
│           │                            │                      │
│  ┌────────┴────────────────────────────┴───────────────┐     │
│  │              LedgerAdapter Interface                  │     │
│  │  + writeProbationEntry(entry) -> LedgerPrincipleEntry │     │
│  │  + existsForCandidate(candidateId) -> Entry | null    │     │
│  └────────────────────────┬─────────────────────────────┘     │
│                           │                                    │
│  ┌────────────────────────┴─────────────────────────────┐     │
│  │           CandidateIntakeError Class                   │     │
│  │  Codes: candidate_not_found | already_consumed         │     │
│  │         artifact_not_found | ledger_write_failed       │     │
│  │         input_invalid                                  │     │
│  └───────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
                              │
                              │ IMPLEMENTS (m7-02)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               openclaw-plugin (m7-02)                        │
│                                                              │
│  LedgerAdapterImpl                                           │
│  ┌──────────────────────────────────────────────────┐       │
│  │ writeProbationEntry():                            │       │
│  │   1. LedgerPrincipleEntry -> LedgerPrinciple      │       │
│  │   2. Fill defaults (version=1, priority=P1, ...)  │       │
│  │   3. addPrincipleToLedger(stateDir, principle)    │       │
│  │                                                   │       │
│  │ existsForCandidate():                             │       │
│  │   1. Scan ledger tree.principles                  │       │
│  │   2. Match sourceRef containing candidateId       │       │
│  │   3. Return LedgerPrincipleEntry | null           │       │
│  └──────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘

CONSUMERS (m7-03, m7-04):

  m7-03 CandidateIntakeService
    ┌──────────────────────────────────────────────┐
    │  constructor({ stateManager, ledgerAdapter }) │  ◄── D-07 DI
    │  intake(input: CandidateIntakeInput)          │
    │    -> CandidateIntakeOutput                   │
    └──────────────────────────────────────────────┘

  m7-04 CLI
    pd candidate intake --candidate-id <id> --workspace <path> --json
```

### Recommended Project Structure

```
packages/principles-core/src/runtime-v2/
├── candidate-intake.ts          # Schemas + interfaces + error class (REFACTORED from draft)
│   ├── CandidateIntakeInputSchema / CandidateIntakeInput
│   ├── CandidateIntakeOutputSchema / CandidateIntakeOutput
│   ├── LedgerPrincipleEntrySchema / LedgerPrincipleEntry
│   ├── CandidateIntakeError / INTAKE_ERROR_CODES
│   └── LedgerAdapter interface
├── store/
│   └── candidate-intake-service.ts  # CandidateIntakeService (MOVED from draft, m7-03)
└── __tests__/
    └── candidate-intake.test.ts   # Schema validation tests (m7-01)

packages/openclaw-plugin/src/core/
└── ledger-adapter-impl.ts          # LedgerAdapter implementation (m7-02)
```

### Pattern 1: TypeBox Schema + Static Type Export

**What:** Dual export of const schema (runtime validation) and inferred type (compile-time checking).
**When to use:** Every schema definition in runtime-v2.
**Example:**
```typescript
// Source: existing pattern in diagnostician-output.ts, error-categories.ts
import { Type, type Static } from '@sinclair/typebox';

export const CandidateIntakeInputSchema = Type.Object({
  candidateId: Type.String({ minLength: 1 }),
  workspaceDir: Type.String({ minLength: 1 }),
});
export type CandidateIntakeInput = Static<typeof CandidateIntakeInputSchema>;
```

### Pattern 2: Interface-Based Abstraction with DI

**What:** Interface in principles-core, implementation in openclaw-plugin, injected via constructor.
**When to use:** Cross-package boundaries (per D-06, D-07).
**Example:**
```typescript
// Source: DiagnosticianCommitter pattern in diagnostician-committer.ts
export interface LedgerAdapter {
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry;
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null;
}

export interface CandidateIntakeServiceOptions {
  stateManager: RuntimeStateManager;
  ledgerAdapter: LedgerAdapter;  // injected
}
```

### Pattern 3: Error Class with Code Constants

**What:** Error class with `code` property drawn from a `const` object of string literals.
**When to use:** Domain-specific errors with machine-readable codes.
**Example:**
```typescript
// Source: existing PDRuntimeError (error-categories.ts) + draft INTAKE_ERROR_CODES
export const INTAKE_ERROR_CODES = {
  CANDIDATE_NOT_FOUND: 'candidate_not_found',
  CANDIDATE_ALREADY_CONSUMED: 'candidate_already_consumed',
  ARTIFACT_NOT_FOUND: 'artifact_not_found',
  LEDGER_WRITE_FAILED: 'ledger_write_failed',
  INPUT_INVALID: 'input_invalid',
} as const;

export class CandidateIntakeError extends Error {
  constructor(
    public readonly code: (typeof INTAKE_ERROR_CODES)[keyof typeof INTAKE_ERROR_CODES],
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CandidateIntakeError';
  }
}
```

### Pattern 4: TypeBox Literal Union for Status

**What:** Using `Type.Literal()` for enum-like string status fields.
**When to use:** Status fields with fixed valid values.
**Example:**
```typescript
// Source: Type.Literal pattern used across runtime-v2 schemas
status: Type.Literal('probation'),
evaluability: Type.Literal('weak_heuristic'),
```

### Anti-Patterns to Avoid

- **Putting implementation logic in the contract layer:** The draft's `CandidateIntakeService.intake()` with DB queries belongs in m7-03. m7-01 should only contain schemas, types, interfaces, and the error class.
- **Optional fields that should be omitted entirely:** The draft's `artifactId` field on input must be removed (not just marked optional), per D-01.
- **Type signatures that diverge from runtime behavior:** The draft's `writeProbationEntry(entry: Omit<LedgerPrincipleEntry, 'id' | 'createdAt'>)` is false -- the call passes both `id` and `createdAt`. Either fix the type to accept full `LedgerPrincipleEntry` or actually omit them and generate inside the adapter.
- **Direct SQL in contract layer:** The draft's raw `db.prepare().run()` call for status update is implementation logic for m7-03.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Schema validation | Manual `typeof` checks | @sinclair/typebox `Value.Check()` + `Value.Errors()` | TypeBox provides typed error iterators, integrates with existing schema patterns, and is already used across 22+ schemas |
| UUID generation | `Math.random().toString(36)` | `crypto.randomUUID()` | Standard Node.js crypto module produces RFC 9562 UUIDs; already used in `SqliteDiagnosticianCommitter` |
| JSON parsing of sourceRecommendationJson | Manual try/catch with ad-hoc field extraction | Delegate to m7-03 service; contract layer only defines types | Parsing and field extraction is business logic, not contract definition |

**Key insight:** The contract layer's job is to define WHAT data shapes look like, not HOW they're constructed. Field extraction from `DiagnosticianOutputV1` and `CandidateRecord` belongs in the service (m7-03), not in schema definitions (m7-01).

## Common Pitfalls

### Pitfall 1: Premature Draft Type Mismatch

**What goes wrong:** The existing `candidate-intake.ts` draft has `writeProbationEntry` typed as `Omit<LedgerPrincipleEntry, 'id' | 'createdAt'>` but the call site at line 183-193 passes both `id` and `createdAt`. TypeScript strict mode may catch this, but if not, it creates a misleading contract for m7-02 implementers who won't know whether they should generate IDs or receive them.

**Why it happens:** The draft was written before D-03 clarified who generates what. The type signature evolved but the call site wasn't reconciled.

**How to avoid:** Decide explicitly: either (a) `writeProbationEntry` accepts full `LedgerPrincipleEntry` and the service generates `id`/`createdAt`, or (b) the adapter generates them and the type omits them. OPTION (a) is recommended because the service owns the ID generation decision and the adapter is a passthrough.

**Warning signs:** TypeScript compilation error on `id` not assignable; m7-02 implementer confusion about ID ownership.

### Pitfall 2: ROADMAP/Decisions Schema Shape Conflict

**What goes wrong:** ROADMAP.md success criterion 1 specifies `CandidateIntakeInput` captures `candidateId, taskId, artifactId, diagnostic output` but CONTEXT.md D-01 overrides to ONLY `{ candidateId, workspaceDir }`. Following the ROADMAP would create a violation of D-01.

**Why it happens:** ROADMAP was written before the CONTEXT.md discussion narrowed scope.

**How to avoid:** CONTEXT.md decisions are the authoritative source. The planner should reference D-01 explicitly and note the ROADMAP discrepancy as resolved-by-decision.

**Warning signs:** Plan includes `taskId` or `artifactId` in `CandidateIntakeInputSchema`.

### Pitfall 3: LedgerPrinciple Required Fields Not Documented

**What goes wrong:** The `LedgerPrincipleEntry` schema only captures 9 probation fields, but `addPrincipleToLedger()` in m7-02 requires a full `LedgerPrinciple` with ~27 fields (version, priority, scope, valueScore, adherenceRate, painPreventedCount, derivedFromPainIds, ruleIds, conflictsWithPrincipleIds, updatedAt, etc.). If the contract doesn't document this gap, m7-02 implementers will encounter runtime errors.

**Why it happens:** The contract layer defines the minimal probation entry, but the actual ledger API demands a full principle shape.

**How to avoid:** Document the default values for all non-probation fields somewhere (either in m7-01 contract docs or m7-02 plan). Default values: `version: 1`, `priority: 'P1'`, `scope: 'general'`, `valueScore: 0`, `adherenceRate: 0`, `painPreventedCount: 0`, `derivedFromPainIds: []`, `ruleIds: []`, `conflictsWithPrincipleIds: []`, `updatedAt: createdAt` (same as createdAt for new entries), plus any other required fields from `Principle` interface.

**Warning signs:** m7-02 implementation hits TypeScript errors on missing LedgerPrinciple fields; runtime JSON parse failures.

### Pitfall 4: existsForCandidate Implementation Ambiguity

**What goes wrong:** D-11 says idempotency check uses "sourceRef match" -- i.e., the adapter scans ledger entries to find one whose `sourceRef` field contains the candidateId. But the interface method signature is `existsForCandidate(candidateId: string)`, which is ambiguous about HOW matching works. The m7-02 implementer might naively look up by principle ID rather than sourceRef.

**Why it happens:** D-11 is explicit about the mechanism (sourceRef match) but the interface signature doesn't encode it.

**How to avoid:** Document in the JSDoc for `existsForCandidate()` that matching is by `sourceRef` containing the candidateId (e.g., `artifact://<artifactId>` where candidate.artifactId matches). This is critical for correctness.

**Warning signs:** Idempotency test fails because second intake creates duplicate; `existsForCandidate` returns null when a ledger entry already exists.

## Code Examples

Verified patterns from official sources and existing codebase:

### CandidateIntakeInput Schema (Corrected from Draft)
```typescript
// Source: D-01, D-02 from CONTEXT.md
// Corrected from draft -- removed artifactId per D-01
export const CandidateIntakeInputSchema = Type.Object({
  candidateId: Type.String({ minLength: 1 }),
  workspaceDir: Type.String({ minLength: 1 }),
});
export type CandidateIntakeInput = Static<typeof CandidateIntakeInputSchema>;
```

### CandidateIntakeOutput Schema (Draft is Correct)
```typescript
// Source: draft candidate-intake.ts lines 28-33 -- matches CONTEXT.md
export const CandidateIntakeOutputSchema = Type.Object({
  candidateId: Type.String(),
  artifactId: Type.String(),
  ledgerRef: Type.String(),
  status: Type.Literal('consumed'),
});
export type CandidateIntakeOutput = Static<typeof CandidateIntakeOutputSchema>;
```

### LedgerPrincipleEntry Schema (Draft is Correct)
```typescript
// Source: draft candidate-intake.ts lines 37-47 -- matches D-03
// Verified against DiagnosticianOutputV1 for triggerPattern/action source
export const LedgerPrincipleEntrySchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  text: Type.String(),
  triggerPattern: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  status: Type.Literal('probation'),
  evaluability: Type.Literal('weak_heuristic'),
  sourceRef: Type.String(),
  createdAt: Type.String(),
});
export type LedgerPrincipleEntry = Static<typeof LedgerPrincipleEntrySchema>;
```

### LedgerAdapter Interface (Corrected from Draft)
```typescript
// Source: D-08, D-11
// FIXED: writeProbationEntry now accepts full LedgerPrincipleEntry (id/createdAt included)
export interface LedgerAdapter {
  /**
   * Write a probation principle entry to the ledger.
   * The implementation (m7-02) transforms LedgerPrincipleEntry into
   * a full LedgerPrinciple and calls addPrincipleToLedger().
   */
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry;

  /**
   * Check if a ledger entry already exists for a given candidate.
   * Matching is by sourceRef field containing the candidateId
   * (e.g., if candidate.artifactId === 'abc', look for sourceRef === 'artifact://abc').
   */
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null;
}
```

### Runtime Validation Pattern
```typescript
// Source: SqliteDiagnosticianCommitter lines 62-67
// Pattern for validating TypeBox schemas at runtime
if (!Value.Check(SchemaName, input)) {
  throw new CandidateIntakeError(
    INTAKE_ERROR_CODES.INPUT_INVALID,
    'Schema validation failed',
    { errors: [...Value.Errors(SchemaName, input)].map((e) => e.message) },
  );
}
```

### LedgerPrinciple Full Shape (for m7-02 reference)
```typescript
// Source: principle-tree-schema.ts (openclaw-plugin)
// LedgerPrinciple extends Principle and adds suggestedRules
// When m7-02 constructs a probation entry, non-probation fields default to:
const DEFAULTS = {
  version: 1,
  coreAxiomId: undefined,
  priority: 'P1' as const,
  scope: 'general' as const,
  domain: undefined,
  valueScore: 0,
  adherenceRate: 0,
  painPreventedCount: 0,
  lastPainPreventedAt: undefined,
  derivedFromPainIds: [] as string[],
  ruleIds: [] as string[],
  conflictsWithPrincipleIds: [] as string[],
  supersedesPrincipleId: undefined,
  updatedAt: now,  // same as createdAt for new entries
  deprecatedAt: undefined,
  deprecatedReason: undefined,
  detectorMetadata: undefined,
  compilationRetryCount: undefined,
  suggestedRules: undefined,
};
// [CITED: packages/openclaw-plugin/src/types/principle-tree-schema.ts Principle interface]
// [VERIFIED: codebase grep of LedgerPrinciple usage]
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Legacy `candidate_created` EvolutionLoopEvent with manual ledger writes | Runtime-v2 pipeline: artifact -> principle_candidates -> intake -> LedgerPrinciple | M5 (2026-04-24) | Structured flow with idempotency; principle_candidates table is single source for intake |
| @sinclair/typebox < 0.34 | @sinclair/typebox 0.34.48 | Project bootstrap | No breaking API changes in this version range |

**Deprecated/outdated:**
- `Principle` interface in `evolution-types.ts` (openclaw-plugin): Has `source`, `trigger`, `feedbackScore` fields -- the `Principle` in `principle-tree-schema.ts` is the authoritative shape for the ledger tree. m7-01/m7-02 should use `LedgerPrinciple` from `principle-tree-schema.ts`.
- Legacy `LegacyPrincipleTrainingState`: The training store structure in `principle-tree-ledger.ts` -- probation entries go into `tree.principles`, not `trainingStore`.

## Gap Analysis: Premature Draft vs CONTEXT.md Decisions

### Critical Discrepancies

| # | CONTEXT.md Decision | Draft Behavior | Severity | Fix |
|---|---------------------|----------------|----------|-----|
| G1 | D-01: Input has ONLY `{ candidateId, workspaceDir }` | `CandidateIntakeInputSchema` includes `artifactId: Type.Optional(Type.String())` | CRITICAL | Remove `artifactId` field from schema |
| G2 | D-08: `writeProbationEntry` returns `LedgerPrincipleEntry` | Type signature says `Omit<LedgerPrincipleEntry, 'id' \| 'createdAt'>` but code passes both | HIGH | Change to `(entry: LedgerPrincipleEntry) => LedgerPrincipleEntry` |
| G3 | Scope anchor: "Schemas and interfaces only" | `CandidateIntakeService.intake()` has full implementation (DB queries, JSON parsing, status update) | HIGH | Extract service class to separate file; m7-01 only exports schema/interface/error |

### Compliant Elements

| # | CONTEXT.md Decision | Draft Behavior | Status |
|---|---------------------|----------------|--------|
| C1 | D-02: workspaceDir required | `Type.String({ minLength: 1 })` | MATCH |
| C2 | D-03: Minimal field set for LedgerPrincipleEntry | All 9 fields present, optional correctly marked | MATCH |
| C3 | D-05: No promotion, status='probation' | `Type.Literal('probation')` | MATCH |
| C4 | D-08: Two methods on LedgerAdapter | `writeProbationEntry()` + `existsForCandidate()` | MATCH |
| C5 | D-09: Ledger-first write order | Service logic writes ledger then updates DB | MATCH |
| C6 | D-10: Idempotent re-intake | Service returns existing result without error | MATCH |
| C7 | D-11: existsForCandidate for idempotency | Called before ledger write in service | MATCH |
| C8 | D-12: 5 error codes | INTAKE_ERROR_CODES has all 5 | MATCH |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Principle ID format `P_<number>` is acceptable for probation entries [ASSUMED] | Ledger Entry Contract | The ledger keys principles by `id`; if ID format conflicts with existing principle IDs, it could cause collisions. The draft uses `P_${Date.now().slice(-6)}` which risks collisions under high throughput. Consider using `randomUUID()` prefix instead. |
| A2 | `existsForCandidate` can be implemented by scanning `tree.principles` for `sourceRef` containing the candidateId [ASSUMED] | Ledger Adapter Interface | If the ledger has thousands of principles, O(n) scan could be slow. An index on sourceRef might be needed. However, for M7 scope (probation entries only), the scan is acceptable. |
| A3 | `LedgerAdapter` is synchronous (not async) because `addPrincipleToLedger()` uses synchronous file locks (`withLock`) [ASSUMED] | Ledger Adapter Interface | If the ledger write path is ever made async, the interface would need to change. The draft has synchronous methods; this matches `addPrincipleToLedger()` which is also synchronous. |
| A4 | `text` field construction from DiagnosticianRecommendation is the service's responsibility (m7-03), not defined in the contract [ASSUMED] | Ledger Entry Contract | The contract only defines field types, not construction logic. If downstream consumers expect a specific `text` format, that format should be specified. |
| A5 | `CandidateIntakeService` class lives in `store/` directory per established pattern (DiagnosticianCommitter, etc.) [ASSUMED] | Architecture Patterns | The current draft places the service alongside schemas in the root `runtime-v2/` directory. Moving to `store/` follows the committer pattern. |

## Open Questions

1. **Who owns ID generation for probation entries?**
   - What we know: D-03 says `id` is a "generated unique ID". The draft generates it in `CandidateIntakeService` as `P_${Date.now().slice(-6)}`. But other runtime-v2 components use `randomUUID()`.
   - What's unclear: Should the service generate the ID (as draft does) or the adapter? If the service generates it, the `writeProbationEntry` type must accept full `LedgerPrincipleEntry` (including `id`). If the adapter generates it, the type should omit `id` and `createdAt`.
   - Recommendation: Service generates `id` using `randomUUID()` (consistent with committer). Update `writeProbationEntry` type to accept full `LedgerPrincipleEntry`. This gives the service control over identity and keeps the adapter as a simple passthrough.

2. **Where should `CandidateIntakeService` live in the file tree?**
   - What we know: The draft places it in `candidate-intake.ts` (root of `runtime-v2/`). But `DiagnosticianCommitter` implementation is in `store/diagnostician-committer.ts`.
   - What's unclear: Should service follow the `store/` pattern (alongside committer) or stay at `runtime-v2/` level (alongside runner)?
   - Recommendation: Place `CandidateIntakeService` in `store/candidate-intake-service.ts` (follows committer pattern). Keep schemas/interfaces/errors in `runtime-v2/candidate-intake.ts`. This separates contract from implementation cleanly.

3. **Should `text` field format be specified in the contract or left to the service?**
   - What we know: The draft constructs `text` as `When ${triggerPattern}, then ${action}.` from `DiagnosticianRecommendation` fields. D-03 says `text` is a "synthesized principle statement."
   - What's unclear: Is the format `"When X, then Y."` a contract requirement or an implementation choice?
   - Recommendation: The contract should specify the field type and provenance (derived from recommendation), not the exact construction logic. Let m7-03 decide the format. The contract test should verify the schema shape, not the content.

4. **ROADMAP success criteria vs CONTEXT.md decisions -- which is authoritative?**
   - What we know: ROADMAP says input captures `candidateId, taskId, artifactId, diagnostic output`. CONTEXT.md D-01 says `candidateId, workspaceDir` only. These conflict directly.
   - What's unclear: Does the ROADMAP need updating, or does CONTEXT.md need revision?
   - Recommendation: CONTEXT.md is more recent and was gathered through direct discussion. The decisions are explicitly "LOCKED." Planner should follow D-01 and note that ROADMAP.md success criteria 1 needs updating.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 [VERIFIED: packages/principles-core/package.json] |
| Config file | `packages/principles-core/vitest.config.ts` |
| Quick run command | `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts` |
| Full suite command | `npx vitest run` (from packages/principles-core) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTAKE-01 | CandidateIntakeInputSchema validates correct shape, rejects missing fields, rejects extra fields | unit | `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts -t "INTAKE-01"` | No - Wave 0 |
| INTAKE-02 | CandidateIntakeOutputSchema validates correct shape with status='consumed' | unit | `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts -t "INTAKE-02"` | No - Wave 0 |
| INTAKE-03 | CandidateIntakeError has correct name, code property, and all 5 error codes defined | unit | `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts -t "INTAKE-03"` | No - Wave 0 |
| INTAKE-04 | LedgerAdapter interface shape (structural type check -- no runtime test possible for interface) | unit | `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts -t "INTAKE-04"` | No - Wave 0 |
| LEDGER-01 | LedgerPrincipleEntrySchema validates all 9 fields, optional fields optional, literal fields restricted | unit | `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts -t "LEDGER-01"` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/runtime-v2/__tests__/candidate-intake.test.ts`
- **Per wave merge:** `npx vitest run` (full suite in principles-core)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/runtime-v2/__tests__/candidate-intake.test.ts` -- covers all 5 requirements (INTAKE-01 through LEDGER-01)
- [ ] Framework already installed: vitest 4.1.0 present in devDependencies
- [ ] Vitest config already includes `src/runtime-v2/**/*.test.ts` in `include` array [VERIFIED: vitest.config.ts line 6]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | -- (contract layer only, no auth) |
| V3 Session Management | No | -- |
| V4 Access Control | No | -- |
| V5 Input Validation | Yes | TypeBox `Value.Check()` + `Value.Errors()` for all schema boundaries; `minLength: 1` on all string fields |
| V6 Cryptography | No | -- (no crypto operations in contract layer) |

### Known Threat Patterns for TypeBox Schema Contracts

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Missing `minLength` on required strings allowing empty strings | Tampering | Always use `Type.String({ minLength: 1 })` for required identity fields (candidateId, workspaceDir) |
| Schema accepts extra fields (no strip/ strict mode) | Information Disclosure | TypeBox `Type.Object()` defaults to ignoring extra properties -- this is acceptable for forward compatibility; add `additionalProperties: false` if strict mode needed |
| JSON injection in `sourceRef` field (e.g., `artifact://../../`) | Tampering | If `sourceRef` is used in file path construction (m7-02), validate format; for now, schema only defines it as string |
| Non-ISO timestamp strings in `createdAt` | Tampering | Validate format with `Type.RegExp()` or `Type.String({ format: 'date-time' })` if needed; current draft uses plain `Type.String()` |

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/candidate-intake.ts` -- premature draft, analyzed for gaps against CONTEXT.md
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` -- DiagnosticianOutputV1 schema, DiagnosticianRecommendation fields [VERIFIED: codebase]
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` -- CommitResult, principle_candidates table schema [VERIFIED: codebase]
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` -- RuntimeStateManager.getCandidate(), getArtifact() signatures [VERIFIED: codebase]
- `packages/principles-core/src/runtime-v2/error-categories.ts` -- PDRuntimeError class pattern [VERIFIED: codebase]
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` -- addPrincipleToLedger(), LedgerPrinciple type [VERIFIED: codebase]
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts` -- Principle interface (27 fields), LedgerPrinciple extension [VERIFIED: codebase]
- `.planning/phases/m7-01-Candidate-Intake-Contract/m7-01-CONTEXT.md` -- 12 locked decisions [VERIFIED: authoritative]
- `packages/principles-core/package.json` -- @sinclair/typebox 0.34.48, vitest 4.1.0 [VERIFIED: package.json]
- `packages/principles-core/vitest.config.ts` -- test configuration, include patterns [VERIFIED: config file]
- npm registry -- @sinclair/typebox latest 0.34.49 [VERIFIED: npm view 2026-04-26]

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/src/core/evolution-types.ts` -- Principle interface (alternate, legacy shape) [CITED: codebase]
- `packages/principles-core/src/runtime-v2/index.ts` -- barrel export patterns [CITED: codebase]
- `.planning/ROADMAP.md` -- Phase success criteria (some conflict with CONTEXT.md decisions) [CITED: noted discrepancy]

### Tertiary (LOW confidence)
- None -- all claims verified against codebase or CONTEXT.md

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- TypeBox version verified against npm registry; vitest version verified in package.json; all patterns confirmed via codebase grep
- Architecture: HIGH -- interface/adapter pattern verified in DiagnosticianCommitter precedent; DI pattern verified in CONTEXT.md D-07
- Pitfalls: MEDIUM -- identified 4 concrete pitfalls from draft analysis and codebase reading; some (existsForCandidate matching, LedgerPrinciple field defaults) require m7-02 implementation to fully validate

**Research date:** 2026-04-26
**Valid until:** 2026-05-10 (30 days -- stable contract phase, no moving dependencies)
