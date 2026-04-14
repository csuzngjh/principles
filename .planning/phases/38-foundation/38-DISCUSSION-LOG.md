# Phase 38: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 38-foundation
**Areas discussed:** Keyword Data Structure, Atomic Write Boundary, 200-Term Limit Enforcement, Seed Keywords

---

## Keyword Data Structure

| Option | Description | Selected |
|--------|-------------|----------|
| Objects with metadata | {term, weight, source, addedAt} — ready for future LLM optimization and weight decay | ✓ |
| Flat string array | Simpler, matches current behavior directly, future optimizer reconstructs objects | |

**User's choice:** Objects with metadata (Recommended)
**Notes:** Ready for future features (weight decay CORR-10, FPR tracking CORR-06)

---

## Atomic Write Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Single keywords file | Only correction_keywords.json is atomic. In-memory cache invalidates after write. | ✓ |
| Bundle with metadata file | Atomic write includes keywords + stats in one state file | |

**User's choice:** Single keywords file (Recommended)
**Notes:** Simpler failure recovery — only keywords can be corrupted

---

## 200-Term Limit Enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Fail-fast (throw error) | Throws if store is at capacity. Caller handles the error. | ✓ |
| Silent skip | Returns false on reject, no error thrown. Caller checks return value. | |

**User's choice:** Fail-fast (throw error) (Recommended)
**Notes:** More visible failure, better for debugging

---

## Seed Keywords

| Option | Description | Selected |
|--------|-------------|----------|
| All 16 keywords | Use all 16 — more coverage, no arbitrary exclusion | ✓ |
| Pare down to 15 | Remove one — which one should be excluded? | |

**User's choice:** All 16 keywords
**Notes:** Success criteria says "15" but all 16 are valid correction cues

---

## Claude's Discretion

None — all decisions made by user

## Deferred Ideas

None — discussion stayed within Phase 38 scope
