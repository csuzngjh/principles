# Phase 43: Type Safety - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 43-Type Safety
**Areas discussed:** Branded types design, Event payload typing, as any replacement strategy

---

## TYPE-01: Branded types design

| Option | Description | Selected |
|--------|-------------|----------|
| Intersection type brand | Use type intersection with _brand property (standard pattern). Works well, widely understood. | ✓ |
| Interface-based nominal type | Use a nominal type helper that preserves the base type. Similar behavior, different syntax. | |
| Plain string with doc comment | Just use string with inline comments. Minimal change, no compile-time safety. | |

**User's choice:** Intersection type brand (Recommended)
**Notes:** Standard brand pattern using intersection type with `_brand` property.

---

## TYPE-02: Event payload typing

| Option | Description | Selected |
|--------|-------------|----------|
| Discriminated union | Replace EventLogEntry with a discriminated union: EventLogEntry = ToolCallEntry \| PainSignalEntry \| etc. Full type safety on data field. | ✓ |
| Type predicates + narrow function | Keep EventLogEntry.data as unknown, add type guard functions. Existing code migrates incrementally. | |
| Generic EventLogEntry<T> | Use a generic wrapper: EventLogEntry<T> with data: T. Requires type annotation at every usage site. | |

**User's choice:** Discriminated union (Recommended)
**Notes:** Replace EventLogEntry with discriminated union keyed on `type` field for automatic type narrowing.

---

## TYPE-03-05: as any replacement strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Fix in place per file | Fix each as any in place — find the right type or use type predicates. Most precise fix but more changes across files. | ✓ |
| Audit first, fix second | Audit all 6 files together to understand patterns, then apply consistent fix strategy. | |
| Central safe-cast utility | Replace with a shared safe cast utility that suppresses type errors. | |

**User's choice:** Fix in place per file (Recommended)
**Notes:** Fix in place — find the correct type or use type predicates. No central suppression utility.

---

## Claude's Discretion

No areas deferred to Claude — all decisions made by user.

## Deferred Ideas

None
