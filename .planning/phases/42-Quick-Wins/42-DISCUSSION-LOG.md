# Phase 42: Quick Wins - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 42-Quick Wins
**Areas discussed:** Busy-wait replacement, JSON validation approach, Token compare security

---

## QW-01: Busy-wait loop replacement

| Option | Description | Selected |
|--------|-------------|----------|
| Keep sync, minimal spin | Keep sync API, use a spin loop that's very short (< 1ms). Simple, no API change. | |
| Keep sync, setTimeout retry | Keep sync signature but use a hybrid: try once, if EPERM/EBUSY then setTimeout-based retry with max retries. Best of both worlds. | ✓ |
| Make it async | Change atomicWriteFileSync to async atomicWriteFile, update all callers. More invasive but properly non-blocking. | |

**User's choice:** Keep sync, setTimeout retry (Recommended)
**Notes:** Hybrid approach — try once fast path, then setTimeout retry on EPERM/EBUSY. No API change.

---

## QW-02: JSON validation before parse

| Option | Description | Selected |
|--------|-------------|----------|
| Structured validation helper | Add a parse-with-validation helper that checks 'type' and 'workspaceId' fields before returning the parsed object. Reusable across queue event handlers. | ✓ |
| Schema library (zod/ajv) | Use a schema library to validate the shape of queue event payloads before parse. More robust but adds a dependency. | |
| Type guard only | Just check typeof === 'string' && not empty before parse. Minimal but catches the common cases. | |

**User's choice:** Structured validation helper (Recommended)
**Notes:** Reusable helper that validates required fields before returning parsed object. No new dependency.

---

## QW-03: Constant-time token comparison

| Option | Description | Selected |
|--------|-------------|----------|
| Inline timingSafeEqual | Replace with crypto.timingSafeEqual Buffer comparison inline. Simplest fix, no new abstraction. | ✓ |
| Utility helper | Create a constantTimeCompare utility in utils/security.ts. More testable and reusable. | |

**User's choice:** Inline timingSafeEqual (Recommended)
**Notes:** Single call site, inline is sufficient. No need for separate utility file.

---

## Claude's Discretion

No areas deferred to Claude — all decisions made by user.

## Deferred Ideas

None
