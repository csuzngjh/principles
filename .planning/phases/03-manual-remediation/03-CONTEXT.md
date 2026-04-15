# Phase 03: Manual Remediation - Context

**Created:** 2026-04-09
**Phase:** 03 - Manual Remediation (Gap Closure)
**Status:** Decisions captured for execution

## Overview

Phase 03 is a **gap closure phase** continuing from v1.9.2. The goal is to achieve CI green by resolving all remaining ESLint errors through a combination of mechanical fixes and documented suppressions.

## Decisions Made

### 1. Suppression Strategy (DECIDED)

**Decision:** Use eslint-disable suppression for errors that are impractical to fix via refactoring.

**Rationale:**
- Gap closure requires achieving CI green without extensive architectural refactoring
- D-02 defines "truly unavoidable" threshold for suppressions
- Documented reasons keep technical debt explicit for future phases

**Implementation:**
- Line-level suppression only (no file-level disables)
- Every suppression must include `-- Reason:` explanation
- Block-level suppression allowed for interface bodies with multiple params

### 2. Mechanical Fixes Priority (DECIDED)

**Order of execution:**
1. prefer-destructuring (mechanical fix - no suppression)
2. consistent-type-imports (convert to `import type`)
3. no-explicit-any with D-02 proof chain (unknown → narrowing → suppress)
4. no-unused-vars (dead code removal → suppress remaining)
5. Remaining categories (max-params, no-use-before-define, etc.)

### 3. D-02 Proof Chain for no-explicit-any (DECIDED)

**Decision:** Follow mandatory proof chain before suppressing any no-explicit-any error.

**Steps:**
1. **FIRST:** Convert to `unknown` with type narrowing
2. **SECOND:** If unknown blocks usage, try generic constraints or type alias
3. **THIRD:** Only suppress if both 1 and 2 fail

**Example:**
```typescript
// Step 1: Try unknown
items.forEach((item: unknown) => {
  if (typeof item === 'string') { console.log(item); }
});

// Step 2: If still impractical, suppress
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Reason: third-party API returns dynamic JSON
const response: any = fetchResult;
```

### 4. no-unused-vars Handling (DECIDED)

**Decision:** Determine if unused symbol indicates dead code, broken callback, or intentional unused before suppressing.

**Check:**
1. **DEAD CODE:** Remove the variable/import
2. **BROKEN CALLBACK:** Fix the signature (add `_` prefix)
3. **INTENTIONALLY UNUSED:** Suppress with documented reason

**Important:** The bare `no-unused-vars` rule (not @typescript-eslint/no-unused-vars) does NOT respect the `_` prefix convention. Interface callbacks require block-level suppression.

### 5. Suppression Reasons Catalog (DECIDED)

**Approved suppression reasons:**

| Error Category | Approved Reason |
|----------------|-----------------|
| max-params | `breaking API change to options objects would affect public contracts` |
| no-use-before-define | `mutual recursion between helper functions - reordering would break logical grouping` |
| no-explicit-any | `third-party API returns dynamic JSON - type structure unknown at call site` |
| class-methods-use-this | `interface implementation - method required by interface but intentionally no-op` |
| no-non-null-assertion | `type narrowing impractical - parent component guarantees non-null value through business logic` |
| no-shadow | `breaking change - shadowed variable name is public API response structure` |
| no-require-imports | `CommonJS require for synchronous JSON loading - ESM import() would require async refactoring` |
| no-unused-vars | `bare no-unused-vars rule doesn't respect underscore prefix convention` |

### 6. LINT-09 Status (DECIDED)

**Decision:** LINT-09 (inline helper extraction, barrel export fixes) is **DEFERRED** to a future phase.

**Rationale:**
- Inline helper extraction requires architectural design beyond gap closure scope
- Barrel export structural refactoring would affect multiple modules
- Gap closure focuses on CI green, not comprehensive refactoring

### 7. CI Verification (DECIDED)

**Decision:** Final verification requires human approval checkpoint.

**Verification steps:**
1. Run `npm run lint` - must exit with code 0
2. Run `npm run build` or `npx tsc --noEmit` - must pass typecheck
3. Verify all suppressions have `-- Reason:` explanations
4. Check no file-level disables (line-level only)
5. Human approval before marking complete

## Gray Areas (All Resolved)

All gray areas for this phase have been decided:
- ✅ Suppression strategy approach
- ✅ Mechanical fixes priority order
- ✅ D-02 proof chain for no-explicit-any
- ✅ no-unused-vars handling (dead code vs callback)
- ✅ Suppression reasons catalog
- ✅ LINT-09 deferral
- ✅ CI verification process

## Out of Scope

Explicitly NOT in scope for Phase 03:
- LINT-09: Inline helper extraction and barrel export structural refactoring
- LINT-10: Complexity rules (deferred to v2)
- Architectural refactoring to reduce suppression count
- API signature changes to reduce max-params violations
- ESM migration to eliminate require() statements

## Artifacts

- **SUPPRESSION-LEDGER.md:** Complete inventory of all suppressions
- **03-05-SUMMARY.md:** Execution summary showing CI green achieved
- **03-05-PLAN.md:** Gap closure plan with detailed tasks

## Next Steps

After Phase 03 completion:
1. Merge fix/v1.9.3-lint-gaps-v2 branch to main
2. Verify CI lint step passes in CI pipeline
3. Close LINT-11, LINT-12, LINT-13 requirements
4. Plan future phase for LINT-09 (inline helper extraction)

## Context for Downstream Agents

**Research agents:** No research needed - all decisions are captured.

**Planning agents:** Use this context to understand:
- Why suppressions were used (D-02 "truly unavoidable" threshold)
- What suppression reasons are approved
- What mechanical fixes were applied
- What was explicitly deferred (LINT-09)

**Execution agents:** Follow suppression policy:
- Line-level suppression only
- Every suppression requires `-- Reason:`
- Use approved reasons from catalog
- No file-level disables
