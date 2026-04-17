# Step 1B: Architecture & Design Review

## Overview
Excellent architectural decisions for a v0.1.0 SDK. The interface-first design with generic adapters is well-suited for framework-agnosticism. The PainSignal 12-field schema is appropriately minimal. No circular dependencies or layering violations. One notable concern around duplicated types and the PainSignal schema completeness.

---

## Findings

### Low: Duplicated Type Definitions Create Maintenance Contract Risk

**File:** `packages/principles-core/src/types.ts`, lines 10-48

```ts
/**
 * Minimal InjectablePrinciple shape for principle injection.
 * Duplicated from openclaw-plugin/src/core/principle-injection.ts.
 *
 * DO NOT import from openclaw-plugin here.
 */
export interface InjectablePrinciple { ... }
```

**Issue:** The types `InjectablePrinciple` and `HybridLedgerStore` are hand-copied from openclaw-plugin with `// DO NOT import from openclaw-plugin` as the only coordination mechanism. Over time, drift between the two shapes will cause subtle bugs. The comment prevents imports but not divergence.

**Fix (post-v0.1.0):** Either:
1. Extract shared types to a third `@principles/types` package that both packages depend on
2. Use a TypeScript project reference with a shared `src/shared/` layer

For v0.1.0, document the maintenance contract explicitly in a `TYPES_CONTRACT.md`.

---

### Low: PainSignal Schema Uses `Record<string, unknown>` for Context

**File:** `packages/principles-core/src/pain-signal.ts`, line 56

```ts
context: Type.Record(Type.String(), Type.Unknown()),
```

**Issue:** The `context` field uses `unknown`, meaning each adapter can stuff arbitrary data. This is flexible but:
- No schema evolution strategy (adding fields is fine, but removing breaks older events)
- Consumers cannot reliably parse context without knowing the adapter type
- `validatePainSignal` cannot enforce any context schema constraints

This is an architectural trade-off (flexibility vs. schema enforcement). Acknowledge it in documentation.

---

### Low: PainSignal capture() Returns Null for "No Pain" — Ambiguous API Contract

**File:** `packages/principles-core/src/pain-signal-adapter.ts`, line 27

```ts
capture(rawEvent: TRawEvent): PainSignal | null;
```

**Issue:** `null` means "this event produced no pain signal." But it could also mean:
- "This event is malformed and I couldn't decide" (error-like behavior)
- "This event is intentionally ignored" (suppression)

The semantic ambiguity is resolved in practice by each adapter's docstring, but the interface contract doesn't distinguish between "not a pain event" vs. "error parsing event."

**Fix:** Use a discriminated union:
```ts
type CaptureResult<T extends PainSignal> =
  | { status: 'captured'; signal: T }
  | { status: 'not_applicable'; reason?: string }
  | { status: 'error'; message: string };
```

For v0.1.0, this is acceptable — the docstring clarifies the meaning.

---

### Medium: No Version Field in PainSignal Schema

**File:** `packages/principles-core/src/pain-signal.ts`, line 41-56

The schema has no `version` field. When the schema evolves (e.g., adding a new optional field), old events stored in ledger will not have it. Without version, consumers cannot distinguish v0.1.0 events from future versions.

**Fix:** Add `version?: string` (semver of the schema used to produce this signal):
```ts
version: Type.Optional(Type.String({ default: '0.1.0' })),
```

This is a medium issue for long-term storage compatibility.

---

### Low: StorageAdapter.mutateLedger Is Async But May Block

**File:** `packages/principles-core/src/storage-adapter.ts`, lines 51-53

```ts
mutateLedger<T>(mutate: (store: HybridLedgerStore) => T | Promise<T>): Promise<T>;
```

The interface documents that implementations choose between pessimistic or optimistic locking, but the async API means all mutations are serialized at the interface level. For high-throughput scenarios, this could be a bottleneck.

**Assessment:** Acceptable for v0.1.0. Document throughput expectations in interface JSDoc.

---

### Low: EvolutionHook Has No Error Handling Contract

**File:** `packages/principles-core/src/evolution-hook.ts`, lines 59-63

```ts
export interface EvolutionHook {
  onPainDetected(signal: PainSignal): void;
  onPrincipleCreated(event: PrincipleCreatedEvent): void;
  onPrinciplePromoted(event: PrinciplePromotedEvent): void;
}
```

All methods return `void`. If a consumer's `onPrincipleCreated` throws, the exception propagates to the caller of `EvolutionHook`. There's no error boundary in the interface — callers must wrap hook calls in try/catch.

**Fix:** Either document that hooks must not throw, or change return type to `Promise<void>` and allow async hooks.

---

## Positive Architectural Decisions

1. **Interface Segregation**: `PainSignalAdapter`, `StorageAdapter`, `PrincipleInjector`, `EvolutionHook` are all single-responsibility interfaces. Each does one thing.

2. **Generic Type Parameters**: `PainSignalAdapter<TRawEvent>` is the correct way to handle framework-specific events without code duplication.

3. **NoOp Hook Pattern**: `noOpEvolutionHook` is a pragmatic pattern for optional callbacks.

4. **TypeBox Over Zod**: Correct choice for TypeScript-first SDK. Native TypeScript types without runtime overhead beyond what's needed.

5. **Adapter Directory Structure**: `src/adapters/{domain}/` grouping is clean and scalable.

6. **Schema Freeze Commitment**: CHANGELOG documents API freeze at v0.1.0 — good governance.

---

## Summary

| Severity | Count | Files |
|----------|-------|-------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | pain-signal.ts (no version field) |
| Low | 5 | types.ts, pain-signal.ts, storage-adapter.ts, evolution-hook.ts, pain-signal-adapter.ts |
