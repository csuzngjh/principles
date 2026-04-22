---
name: M1 Review Fix
description: Fix attempt for M1 deep review findings — WR-01 false positive, WR-02 design trade-off
type: review-fix
status: no_action_required
depth: deep
files_reviewed: 11
phase: M1 (Foundation Contracts)
findings_in_scope: 2
fixed: 0
skipped: 2
iteration: 1
---

## Fix Summary

**WR-01 (runtime-selector.ts:17-18) — NOT FIXED — False Positive**

The three type-only imports (`RuntimeCapabilities`, `RuntimeHealth`, `RuntimeKind`) ARE used in the file body, specifically as type arguments in the `RuntimeSelector` interface method signatures:

```typescript
getHealthSnapshot(): Promise<Map<RuntimeKind, RuntimeHealth>>;      // line 63
getCapabilitiesSnapshot(): Promise<Map<RuntimeKind, RuntimeCapabilities>>; // line 66
```

Both `tsc --noEmit` and `eslint` pass cleanly with these imports present. The reviewer's finding that they are "never referenced in the file body" is incorrect — they are used as TypeScript type arguments in generic types. No fix was applied because no problem exists.

**WR-02 (schema-version.ts:20) — SKIPPED — Design Trade-off**

The TypeBox `TemplateLiteral` limitation is a documented design trade-off (IN-01). The `schemaRef()` factory function generates correctly formatted refs, and the risk of malformed refs entering the system is low given controlled internal usage. No runtime enforcement gate was added.

---

## Verification

- `tsc --noEmit` on principles-core: clean
- `eslint` on runtime-selector.ts: no errors
- No source files modified

---

Reviewed: 2026-04-21
