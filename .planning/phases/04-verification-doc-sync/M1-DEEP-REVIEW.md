---
name: M1 Deep Review
description: Deep review of all M1 runtime-v2 source files (phases 01-04)
type: review
status: issues_found
depth: deep
files_reviewed: 11
phase: M1 (Foundation Contracts)
---

## Severity Summary

- CRITICAL: 0
- WARNING: 2
- INFO: 1
- Total: 3

## Summary

All 11 M1 Foundation Contract files were reviewed at deep depth, tracing cross-file import chains, checking type consistency, and verifying schema reuse. The contracts are well-designed with proper separation of concerns, correct TypeBox usage, and no circular dependencies. Two minor issues were found: unused type imports in runtime-selector.ts (lint warning) and a TypeBox template literal limitation that affects runtime validation strictness for schema version refs.

---

## Warnings

### WR-01: Unused type imports in runtime-selector.ts

**File:** `packages/principles-core/src/runtime-v2/runtime-selector.ts:17-18`
**Severity:** WARNING

**Issue:** Three type-only imports are declared but never used in the file:

```typescript
import type { PDRuntimeAdapter, RuntimeCapabilities, RuntimeHealth, RuntimeKind } from './runtime-protocol.js';
```

Only `PDRuntimeAdapter` is used in the `RuntimeSelectionResult.interface` (line 32). The three others (`RuntimeCapabilities`, `RuntimeHealth`, `RuntimeKind`) are referenced only in interface method signatures within the same file's `RuntimeSelector` interface (lines 63-66), but the actual TypeScript types are not applied to any local variable or parameter. This will fail TypeScript's `noUnusedLocals` check in strict mode.

**Evidence:**
- `RuntimeKind` — never referenced in the file body; the schema `RuntimeKindSchema` is used, not the type
- `RuntimeCapabilities` — not referenced after the import
- `RuntimeHealth` — not referenced after the import

**Fix:**
Remove the three unused type imports:

```typescript
import type { PDRuntimeAdapter } from './runtime-protocol.js';
```

---

### WR-02: SchemaVersionRefSchema uses Type.TemplateLiteral with limited runtime enforcement

**File:** `packages/principles-core/src/runtime-v2/schema-version.ts:20`
**Severity:** WARNING

**Issue:** The schema uses TypeBox's `TemplateLiteral` type, which TypeScript accepts as `${string}-v${number}`:

```typescript
export const SchemaVersionRefSchema = Type.TemplateLiteral('${string}-v${number}');
```

At compile time, TypeScript's template literal types are structural and will accept any string. At runtime, TypeBox's `Value.Check()` for template literals is known to be more permissive than a true format regex. This means values like `"foo-vabc"` or `"anything-vnotanumber"` may pass validation when they should not.

**Evidence:**
The `schemaRef` helper function generates properly formatted refs:

```typescript
export function schemaRef(kind: string, version: number): string {
  return `${kind}-v${version}`; // e.g., "diagnostician-output-v1"
}
```

But there is no runtime guard ensuring the input conforms to `kind-vN` pattern before the template literal is constructed.

**Fix:**
Consider adding a runtime format guard in `schemaRef`:

```typescript
export function schemaRef(kind: string, version: number): string {
  const ref = `${kind}-v${version}`;
  if (!Value.Check(SchemaVersionRefSchema, ref)) {
    throw new Error(`Invalid schema ref format: ${ref}`);
  }
  return ref;
}
```

Or use a `Type.Refinement` to add a runtime format check:

```typescript
const FormatPattern = /^[\w-]+-v\d+$/;
export const SchemaVersionRefSchema = Type.Refinement(
  Type.TemplateLiteral('${string}-v${number}'),
  (v) => FormatPattern.test(v as string)
);
```

---

## Info

### IN-01: TypeBox template literal limitation is documented design choice

**File:** `packages/principles-core/src/runtime-v2/schema-version.ts:20`
**Severity:** INFO

**Note:** The `SchemaVersionRefSchema` design is a known trade-off. The TypeBox `TemplateLiteral` type provides compile-time string shape checking (TypeScript narrows `schemaVersion: string` to the template literal type when `SchemaVersionRefSchema` is used), but runtime enforcement is weaker than a regex. This is a common limitation across TypeBox users and is acceptable for an internal foundation contract. The risk of malformed refs entering the system is low given the controlled `schemaRef()` factory function.

---

## Cross-file Analysis Summary

### Import graph verified — no circular dependencies

```
agent-spec.ts
  └── runtime-protocol.ts (RuntimeKindSchema)

runtime-selector.ts
  ├── runtime-protocol.ts (RuntimeKindSchema)
  └── agent-spec.ts (AgentSpecSchema)

diagnostician-output.ts
  └── context-payload.ts (DiagnosticianContextPayload type)

task-status.ts
  └── error-categories.ts (PDErrorCategorySchema + type)

context-payload.ts — standalone, no runtime-v2 imports

schema-version.ts — standalone, no runtime-v2 imports

error-categories.ts — standalone, no runtime-v2 imports

runtime-protocol.ts — standalone, no runtime-v2 imports
```

### Schema reuse verified — consistent shapes

- `RuntimeKindSchema` is defined once in `runtime-protocol.ts` and imported by `agent-spec.ts` and `runtime-selector.ts` — no duplicate definitions.
- `PDErrorCategorySchema` is defined once in `error-categories.ts` and imported by `task-status.ts` for `TaskRecord.lastError`.
- `HistoryQueryEntrySchema` is defined once in `context-payload.ts` and used in both `ContextPayloadSchema` and `DiagnosticianContextPayloadSchema`.
- `DiagnosticianViolatedPrincipleSchema`, `DiagnosticianEvidenceSchema`, `DiagnosticianRecommendationSchema`, `RecommendationKindSchema` are all defined in `diagnostician-output.ts` and composed into `DiagnosticianOutputV1Schema` — no external references needed.
- `TrajectoryCandidateSchema` is defined in `context-payload.ts` and used only within `TrajectoryLocateResultSchema` — consistent nesting.

### Index.ts re-exports verified

All exports from `index.ts` match actual module contents:
- `schema-version.js`: `RUNTIME_V2_SCHEMA_VERSION`, `schemaRef`, `SchemaVersionRefSchema`, `RuntimeV2SchemaVersionSchema` — all correct
- `error-categories.js`: `PDErrorCategorySchema`, `PD_ERROR_CATEGORIES`, `PDRuntimeError`, `isPDErrorCategory` — all correct
- `agent-spec.js`: `AgentCapabilityRequirementsSchema`, `AgentTimeoutPolicySchema`, `AgentRetryPolicySchema`, `AgentSpecSchema`, `AGENT_IDS` — all correct
- `runtime-protocol.js`: all schemas and types re-exported correctly
- `task-status.js`: `PDTaskStatusSchema`, `TaskRecordSchema`, `DiagnosticianTaskRecordSchema` — all correct
- `context-payload.js`: all 8 schemas exported
- `diagnostician-output.js`: all 7 schemas and the `DiagnosticianInvocationInput` interface exported

### Type safety assessment

No `any` types found. No `as` casts found. TypeBox schemas use `Static<>` to derive runnable types correctly. The `DiagnosticianInvocationInput` interface properly references `DiagnosticianContextPayload` (not `Type.Unknown()`) because it is an explicit interface declaration, not a TypeBox schema — this is intentional per the design comment.

### Security assessment

No hardcoded secrets, credentials, or API keys found. No user-input paths or injection vectors present. All schemas are pure data definitions with no side effects. No `eval`, `innerHTML`, or other dangerous patterns found.

---

## Verification Checklist

- [x] All 11 files read and analyzed
- [x] Import chains traced — no circular dependencies
- [x] Schema reuse verified — no drift
- [x] Type safety verified — no `any`, no unsound casts
- [x] Index.ts exports verified against actual module contents
- [x] Security scan — no hardcoded secrets or dangerous patterns
- [x] Error handling completeness — PDRuntimeError class with category, message, details
- [x] TypeBox usage — Literal types for enums, Optional for nullable fields, Integer/Number with constraints where appropriate

---

_Reviewed: 2026-04-21T22:46:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_