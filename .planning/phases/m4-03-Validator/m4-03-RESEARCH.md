# Phase m4-03: Validator - Research

**Researched:** 2026-04-23
**Domain:** DiagnosticianOutputV1 schema + semantic validation (TypeBox + custom checks)
**Confidence:** HIGH

## Summary

Phase m4-03 implements `DiagnosticianValidator` -- the component that validates `DiagnosticianOutputV1` before `DiagnosticianRunner` advances task state. The interface (`DiagnosticianValidator`) and result type (`DiagnosticianValidationResult`) are already defined in `diagnostician-validator.ts` from M1, with a `PassThroughValidator` placeholder. This phase replaces the placeholder with a real validator performing 7 categories of checks: TypeBox schema conformance, non-empty summary/rootCause, task identity match, bounded evidence array, recommendations shape, confidence range, and evidence sourceRef back-check.

The validator is independent of the runner -- it receives `(output, taskId, options?)` and returns `DiagnosticianValidationResult`. The runner calls it at line 138 of `diagnostician-runner.ts`. The CONTEXT.md decisions lock a two-mode design: **standard** (fail-fast, first error only) and **verbose** (collect-all errors). Evidence back-check is also layered: standard checks format only, verbose checks sourceRef existence against context sourceRefs.

**Primary recommendation:** Implement `DefaultDiagnosticianValidator` in a new file `default-validator.ts` under `runner/`. Keep the existing interface but extend the signature with an optional third parameter. Use `Value.Check()` for schema validation and `Value.Errors()` for detailed field-level error messages in verbose mode.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Layered validation -- standard mode (fail-fast, first error) + verbose mode (collect-all errors). `validate(output, taskId, options?: { verbose?: boolean })`.
- **D-02:** Layered evidence check -- standard=best-effort format check, verbose=strict sourceRef existence.
- **D-03:** Aggregate summary + per-field detailed errors coexist in errors array. errors[0] is aggregate summary, subsequent entries are per-field details.
- **D-04:** All failures use errorCategory = `output_invalid` (PDErrorCategory).
- **D-05:** Task identity strict equality `output.taskId === taskId`.
- **D-06:** Confidence must be in [0, 1] closed interval. TypeBox enforces but explicit check for specific error messages.
- **D-07:** DiagnosticianValidationResult structure unchanged (valid + errors + errorCategory).

### Claude's Discretion
- DiagnosticianValidator directory organization (independent file vs in runner/)
- Whether to export a factory function (e.g., `createStrictValidator()`)
- Evidence sourceRef check implementation details (how to query context to verify references)

### Deferred Ideas (OUT OF SCOPE)
- Validator semantic validation extensions (recommendations content quality) -- M5 scope
- Validator + store integration tests -- m4-04 scope
- Evidence sourceRef context back-check fallback logic (if context data insufficient)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-2.3a | Schema correctness (TypeBox validation) | `Value.Check(DiagnosticianOutputV1Schema, output)` + `Value.Errors()` for detail |
| REQ-2.3b | Non-empty summary / rootCause | Explicit check after schema pass; TypeBox `minLength: 1` already enforces |
| REQ-2.3c | Task identity match (output.taskId === taskId) | Strict equality check, D-05 locked |
| REQ-2.3d | Bounded evidence array | Check `evidence.length` is finite and elements have valid shape |
| REQ-2.3e | Recommendations array shape | Each entry has `kind` (literal union) + `description` (minLength: 1) |
| REQ-2.3f | Confidence range [0, 1] | Explicit boundary check after schema pass for clear error messages |
| REQ-2.3g | Best-effort evidence back-check (sourceRef existence) | Standard=format only, verbose=check against context sourceRefs (D-02) |
| REQ-2.1 | Runner calls validate position | `diagnostician-runner.ts:138` -- `this.validator.validate(output, taskId)` |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Schema validation | Library (TypeBox) | -- | TypeBox provides Value.Check/Value.Errors; no custom schema engine needed |
| Semantic field checks | Validator module | -- | Custom logic for taskId match, confidence range, non-empty strings |
| Evidence back-check | Validator module | Context payload (via sourceRefs) | Verbose mode needs context sourceRefs to verify evidence.sourceRef existence |
| Error aggregation | Validator module | -- | Collects errors into DiagnosticianValidationResult |
| Interface contract | M1 frozen interface | -- | DiagnosticianValidator interface cannot change signatures unexpectedly |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @sinclair/typebox | 0.34.49 | Schema definition + runtime validation | Project-wide standard for all runtime-v2 validation [VERIFIED: npm ls] |
| vitest | 4.1.0+ | Test framework | Project test standard [VERIFIED: package.json] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Value.Check() | (typebox built-in) | Schema conformance check | First validation gate -- fast binary pass/fail |
| Value.Errors() | (typebox built-in) | Detailed per-field error enumeration | Verbose mode -- produces specific field paths and messages |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Value.Errors() for all checks | Custom per-field checks only | Value.Errors() handles nested schema errors; custom checks needed for semantic rules not expressible in schema (taskId match, context sourceRef lookup) |

**Installation:**
No new dependencies needed. All libraries already in project.

**Version verification:**
```
@sinclair/typebox: 0.34.49 (installed, ^0.34.48 in package.json)
vitest: ^4.1.0 (dev dependency)
```

## Architecture Patterns

### System Architecture Diagram

```
                    DiagnosticianRunner
                          |
                    [line 138: validate()]
                          |
                          v
              +---------------------------+
              | DiagnosticianValidator    |
              | (interface, M1 frozen)    |
              +---------------------------+
                          |
                          v
              +---------------------------+
              | DefaultDiagnostician-     |
              | Validator (m4-03 new)     |
              +---------------------------+
                          |
           +--------------+---------------+
           |              |               |
     [1] Value.Check   [2] Semantic    [3] Evidence
     (TypeBox schema   Checks          Back-check
      conformance)     - taskId match   (verbose only)
           |           - confidence     - sourceRef vs
           |             range           context.sourceRefs
           |           - non-empty
           |             summary/rootCause
           v              |               |
     +----------+         |               |
     | Schema   |         |               |
     | Errors?  |         |               |
     | (verbose)|         v               v
     +----------+    errors[]         errors[]
           |              |               |
           +--------------+---------------+
                          |
                    [Aggregate + Detail]
                    errors[0] = summary
                    errors[1..N] = per-field
                          |
                          v
              DiagnosticianValidationResult
              { valid, errors, errorCategory }
```

### Recommended Project Structure
```
packages/principles-core/src/runtime-v2/runner/
  diagnostician-validator.ts    # Interface (M1, EXISTS -- modify signature)
  default-validator.ts          # New: DefaultDiagnosticianValidator implementation
  __tests__/
    default-validator.test.ts   # New: comprehensive validator tests
```

### Pattern 1: Two-Mode Validation (Fail-Fast / Collect-All)
**What:** Standard mode returns on first error; verbose mode collects all errors before returning.
**When to use:** D-01 locks this pattern. Standard for production runner path, verbose for debugging/diagnostics.
**Example:**
```typescript
// Source: [VERIFIED: CONTEXT.md D-01]
async validate(
  output: DiagnosticianOutputV1,
  taskId: string,
  options?: { verbose?: boolean },
): Promise<DiagnosticianValidationResult> {
  const errors: string[] = [];
  const verbose = options?.verbose ?? false;

  // 1. Schema check
  if (!Value.Check(DiagnosticianOutputV1Schema, output)) {
    if (verbose) {
      const schemaErrors = [...Value.Errors(DiagnosticianOutputV1Schema, output)];
      errors.push(...schemaErrors.map(e => `${e.path}: ${e.message}`));
    } else {
      return this.fail(['Schema validation failed']);
    }
  }

  // 2. Task identity
  if (output.taskId !== taskId) {
    const msg = `taskId mismatch: output.taskId="${output.taskId}" expected="${taskId}"`;
    if (!verbose) return this.fail([msg]);
    errors.push(msg);
  }

  // 3-6: more checks...

  // Aggregate summary per D-03
  if (errors.length > 0) {
    const aggregate = this.buildAggregate(errors);
    return this.fail([aggregate, ...errors]);
  }

  return { valid: true, errors: [] };
}
```

### Pattern 2: Evidence SourceRef Back-Check (Layered)
**What:** Standard mode checks format (non-empty sourceRef string); verbose mode checks sourceRef exists in context.
**When to use:** D-02 locks this. Standard mode is fast; verbose mode verifies reference integrity.
**Example:**
```typescript
// Standard: format only
for (const ev of output.evidence) {
  if (!ev.sourceRef || ev.sourceRef.trim() === '') {
    errors.push('evidence.sourceRef must be non-empty string');
  }
}

// Verbose: check existence against context sourceRefs
if (verbose && contextSourceRefs) {
  const refSet = new Set(contextSourceRefs);
  for (const ev of output.evidence) {
    if (!refSet.has(ev.sourceRef)) {
      errors.push(`evidence.sourceRef "${ev.sourceRef}" not found in context`);
    }
  }
}
```

### Anti-Patterns to Avoid
- **Do NOT modify DiagnosticianRunner**: m4-01 is complete. The runner calls `validator.validate(output, taskId)` at line 138. The new optional `options` parameter is backward-compatible (defaults to undefined = standard mode).
- **Do NOT add severity levels to DiagnosticianValidationResult**: D-07 locks the structure as `{ valid, errors, errorCategory }`.
- **Do NOT hand-roll schema validation**: Use TypeBox `Value.Check()` and `Value.Errors()` exclusively for schema conformance.
- **Do NOT validate evidence sourceRef against context in standard mode**: D-02 explicitly defers this to verbose mode only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON schema validation | Custom type guards for each field | `Value.Check(DiagnosticianOutputV1Schema, output)` | TypeBox handles nested schema traversal, type coercion, and edge cases |
| Detailed validation errors | Custom error message builder per field | `Value.Errors(DiagnosticianOutputV1Schema, output)` | Provides path, message, schema, and value for each violation |
| Error category mapping | Custom category resolver | Hard-coded `'output_invalid'` | D-04 locks all failures to this single category |

**Key insight:** TypeBox 0.34.49 provides `Value.Errors()` which returns an iterator of detailed error objects with `{ type, schema, path, value, message }` fields. This is sufficient for verbose mode error reporting without building custom per-field validators for schema-conformance checks.

## Runtime State Inventory

> This is a greenfield implementation phase (no rename/refactor/migration). No runtime state inventory needed.

## Common Pitfalls

### Pitfall 1: Interface Signature Change Breaking Runner
**What goes wrong:** Changing `validate(output, taskId)` to `validate(output, taskId, options?)` could break the runner if the interface type is not updated.
**Why it happens:** The `DiagnosticianValidator` interface in `diagnostician-validator.ts` is imported by runner and tests.
**How to avoid:** Add the optional third parameter to the interface definition. Since `options` is optional (`options?: { verbose?: boolean }`), the runner's existing call `this.validator.validate(output, taskId)` remains valid without changes.
**Warning signs:** TypeScript compilation errors in `diagnostician-runner.ts` after modifying the interface.

### Pitfall 2: Value.Errors() on Non-Schema-Conformant Input
**What goes wrong:** `Value.Errors()` may produce unexpected results if the input is deeply malformed (e.g., `output` is `null` or missing top-level keys).
**Why it happens:** `Value.Errors()` assumes a traversable object structure.
**How to avoid:** Guard with a preliminary type check. If `typeof output !== 'object' || output === null`, skip `Value.Errors()` and return a direct "output must be a non-null object" error.
**Warning signs:** Runtime crash when validator receives `null`, `undefined`, or primitive values.

### Pitfall 3: Evidence SourceRef Back-Check Without Context
**What goes wrong:** Verbose mode evidence back-check needs access to `context.sourceRefs` to verify references, but the validator interface only receives `output` and `taskId`.
**Why it happens:** The `DiagnosticianContextPayload.sourceRefs` contains the valid reference set (taskId + runIds), but the validator does not receive the context.
**How to avoid:** Two approaches (per Claude's Discretion):
  1. Pass `sourceRefs` through the options: `options.sourceRefs?: string[]`
  2. Inject a context lookup dependency into the validator constructor
  Recommendation: Approach 1 is simpler and avoids adding dependencies to the validator. The runner can extract `sourceRefs` from the assembled context and pass them via options.
**Warning signs:** Verbose mode evidence check silently passes when it should flag invalid references.

### Pitfall 4: Fail-Fast Mode Returns Before All Checks
**What goes wrong:** Standard mode returns on the first error, but the order of checks matters. If schema validation passes but semantic checks fail, the error message is less useful.
**Why it happens:** Fail-fast mode skips remaining checks after first failure.
**How to avoid:** Order checks by information value: (1) schema validation first (catches structural issues), (2) taskId identity (prevents cross-task contamination), (3) confidence range, (4) non-empty summary/rootCause, (5) evidence/recommendations shape, (6) evidence sourceRef back-check last (most expensive).
**Warning signs:** Error messages in standard mode feel incomplete or unhelpful for common failures.

### Pitfall 5: PassThroughValidator Left in Exports
**What goes wrong:** After implementing `DefaultDiagnosticianValidator`, the `PassThroughValidator` is still exported from `index.ts` and could be accidentally used.
**Why it happens:** `PassThroughValidator` is exported from `runtime-v2/index.ts` line 152.
**How to avoid:** Keep `PassThroughValidator` exported (it may be useful for tests that want to skip validation), but add `DefaultDiagnosticianValidator` as the primary export. The runner tests already use mock validators.
**Warning signs:** New code accidentally imports PassThroughValidator for production use.

## Code Examples

### TypeBox Value.Check + Value.Errors Pattern
```typescript
// Source: [VERIFIED: runtime-v2 codebase -- tested against TypeBox 0.34.49]
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';

// Fast binary check
const passes = Value.Check(DiagnosticianOutputV1Schema, output);

// Detailed errors (for verbose mode)
const errors = [...Value.Errors(DiagnosticianOutputV1Schema, output)];
// Each error: { type: number, schema: object, path: string, value: unknown, message: string }
// Example: { path: '/summary', message: 'Expected string length greater or equal to 1' }
//          { path: '/confidence', message: 'Expected number to be less or equal to 1' }
```

### Minimal Valid DiagnosticianOutputV1
```typescript
// Source: [VERIFIED: diagnostician-output.ts -- DiagnosticianOutputV1Schema]
const minimalOutput: DiagnosticianOutputV1 = {
  valid: true,
  diagnosisId: 'diag-001',
  taskId: 'task-001',
  summary: 'Root cause identified',
  rootCause: 'Missing error handling in X module',
  violatedPrinciples: [],
  evidence: [{ sourceRef: 'task-001', note: 'Stack trace shows unhandled promise' }],
  recommendations: [{ kind: 'implementation', description: 'Add try-catch around async call' }],
  confidence: 0.85,
};
```

### Confidence Boundary Check
```typescript
// Per D-06: explicit check for clear error messages
// TypeBox schema already enforces minimum: 0, maximum: 1
// But explicit check provides field-specific error
if (output.confidence < 0 || output.confidence > 1) {
  errors.push(`confidence: must be in [0, 1], got ${output.confidence}`);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| PassThroughValidator (accepts all) | DefaultDiagnosticianValidator (full validation) | m4-03 | Runner now validates output before state advancement |
| 2-param validate() | 3-param validate() with options | m4-03 | Backward-compatible, adds verbose mode support |

**Deprecated/outdated:**
- `PassThroughValidator`: Still exported for test use, but should NOT be used in production runner wiring after m4-03.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `Value.Errors()` produces useful error paths/messages for all DiagnosticianOutputV1Schema violations | Code Examples | Need to build custom error messages instead |
| A2 | Verbose mode evidence back-check can receive sourceRefs via options parameter without changing DiagnosticianValidator interface semantics | Pitfall 3, Architecture | May need a separate context-aware interface |
| A3 | The runner does NOT need modification -- optional third parameter is backward-compatible | Pitfall 1 | Runner would need changes, violating m4-03 scope |

**Note:** A1 has been verified by running `Value.Errors()` against TypeBox 0.34.49 with sample data. A2 and A3 are design decisions within Claude's Discretion and validated by TypeScript optional parameter semantics.

## Open Questions

1. **How should verbose mode evidence sourceRef check access context sourceRefs?**
   - What we know: The validator interface receives `(output, taskId, options?)`. The context sourceRefs are in `DiagnosticianContextPayload.sourceRefs`.
   - What's unclear: Whether to pass sourceRefs through options or inject a context lookup dependency.
   - Recommendation: Pass via `options.sourceRefs?: string[]`. The runner has the context at call time and can extract the field. This avoids adding constructor dependencies.

2. **Should PassThroughValidator remain exported?**
   - What we know: It's currently exported from `runtime-v2/index.ts`.
   - What's unclear: Whether any test or consumer depends on it.
   - Recommendation: Keep it exported. Runner tests use mock validators, but PassThroughValidator may be useful for integration tests that want to skip validation intentionally.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified)

This phase uses only TypeBox (already installed at 0.34.49) and vitest (already installed at ^4.1.0). No new tools, services, or runtimes required.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.1.0 |
| Config file | `packages/principles-core/vitest.config.ts` |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/runner/__tests__/default-validator.test.ts` |
| Full suite command | `cd packages/principles-core && npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-2.3a | Schema conformance (valid/invalid objects) | unit | `vitest run .../default-validator.test.ts -t "schema"` | Wave 0 |
| REQ-2.3b | Non-empty summary/rootCause | unit | `vitest run .../default-validator.test.ts -t "summary"` | Wave 0 |
| REQ-2.3c | Task identity match | unit | `vitest run .../default-validator.test.ts -t "identity"` | Wave 0 |
| REQ-2.3d | Bounded evidence array | unit | `vitest run .../default-validator.test.ts -t "evidence"` | Wave 0 |
| REQ-2.3e | Recommendations array shape | unit | `vitest run .../default-validator.test.ts -t "recommendation"` | Wave 0 |
| REQ-2.3f | Confidence range [0, 1] | unit | `vitest run .../default-validator.test.ts -t "confidence"` | Wave 0 |
| REQ-2.3g | Evidence sourceRef back-check (standard + verbose) | unit | `vitest run .../default-validator.test.ts -t "sourceRef"` | Wave 0 |
| D-01 | Standard mode (fail-fast) vs verbose mode (collect-all) | unit | `vitest run .../default-validator.test.ts -t "mode"` | Wave 0 |
| D-03 | Aggregate summary + per-field detail coexist | unit | `vitest run .../default-validator.test.ts -t "aggregate"` | Wave 0 |
| D-04 | All failures return errorCategory='output_invalid' | unit | `vitest run .../default-validator.test.ts -t "category"` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cd packages/principles-core && npx vitest run src/runtime-v2/runner/__tests__/default-validator.test.ts`
- **Per wave merge:** `cd packages/principles-core && npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/principles-core/src/runtime-v2/runner/__tests__/default-validator.test.ts` -- covers all REQ-2.3a through REQ-2.3g
- [ ] `packages/principles-core/src/runtime-v2/runner/default-validator.ts` -- DefaultDiagnosticianValidator implementation
- [ ] Interface update: `diagnostician-validator.ts` -- add optional third parameter to `DiagnosticianValidator.validate()`

## Security Domain

> This phase involves input validation of external data (LLM output). Security considerations are limited but present.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | TypeBox Value.Check() + custom semantic checks |
| V4 Access Control | no | -- (taskId match is identity verification, not access control) |
| V6 Cryptography | no | -- |

### Known Threat Patterns for TypeBox Validation

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed output injection | Tampering | Value.Check() rejects non-conformant structures |
| Prototype pollution via output | Tampering | TypeBox schemas validate own-properties only |
| Excessive evidence array size | Denial of Service | Bounded array check (REQ-2.3d) |

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` -- DiagnosticianOutputV1Schema, all sub-schemas [VERIFIED: read in this session]
- `packages/principles-core/src/runtime-v2/runner/diagnostician-validator.ts` -- Interface, PassThroughValidator, DiagnosticianValidationResult [VERIFIED: read in this session]
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` -- Runner validate() call at line 138 [VERIFIED: read in this session]
- `packages/principles-core/src/runtime-v2/error-categories.ts` -- PDErrorCategory including 'output_invalid' [VERIFIED: read in this session]
- `packages/principles-core/src/runtime-v2/context-payload.ts` -- DiagnosticianContextPayload with sourceRefs [VERIFIED: read in this session]
- TypeBox 0.34.49 Value.Check/Value.Errors API [VERIFIED: tested against installed version in this session]

### Secondary (MEDIUM confidence)
- `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts` -- Existing test patterns and mock factory [VERIFIED: read in this session]
- `packages/principles-core/src/runtime-v2/runner/__tests__/start-run-input.test.ts` -- Value.Check() usage pattern [VERIFIED: read in this session]
- `packages/principles-core/vitest.config.ts` -- Test configuration [VERIFIED: read in this session]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- TypeBox 0.34.49 verified installed, Value.Check/Value.Errors API tested
- Architecture: HIGH -- Interface frozen from M1, all canonical files read and understood
- Pitfalls: HIGH -- Derived from actual code analysis and interface constraints
- Validation patterns: HIGH -- Value.Errors() tested against DiagnosticianOutputV1Schema-like structures

**Research date:** 2026-04-23
**Valid until:** 2026-05-23 (stable -- no fast-moving dependencies)
