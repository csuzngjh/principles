# Phase 46: God Class Split - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-15
**Phase:** 46-god-class-split
**Areas discussed:** Sleep-cycle inclusion, BUG-01/02/03 handling, queue-io scope, extraction order

---

## Area 1: Sleep-cycle inclusion (SPLIT-05)

| Option | Description | Selected |
|--------|-------------|----------|
| Include SPLIT-05 (recommended) | Handle sleep-cycle.ts extraction within Phase 46, even though nocturnal-trinity.ts is deferred. They are different concerns. | ✓ |
| Defer SPLIT-05 | Leave sleep-cycle for the future nocturnal-trinity.ts split milestone. Focus Phase 46 purely on evolution-worker.ts extraction. | |

**User's choice:** Include SPLIT-05 (recommended)

---

## Area 2: BUG-01/02/03 handling

| Option | Description | Selected |
|--------|-------------|----------|
| Fix all three (recommended) | Fix all three bugs within Phase 46 as part of the split work (BUG-01 watchdog, BUG-02 session cleanup, BUG-03 timeout recovery). | ✓ |
| Fix trivial only | Fix bugs only if they're trivial one-liners. Verify the rest work after split. | |
| Fix BUG-01 only | Fix BUG-01 (watchdog marks stale workflows) since it directly relates to SPLIT-02 (workflow-watchdog extraction). Defer others. | |
| Verify only | Verify all three bugs still work after the split. Don't change behavior — just ensure nothing breaks. | |

**User's choice:** Fix all three (recommended)

---

## Area 3: queue-io.ts scope

| Option | Description | Selected |
|--------|-------------|----------|
| Thin I/O wrapper only | Thin wrapper around atomicWriteFileSync and fs operations — minimal, focused on file I/O only. | |
| Full persistence layer (recommended) | Full queue persistence abstraction: encapsulates locking (acquireQueueLock), atomic writes, and queue file format. | ✓ |
| withQueueLock RAII guard only | Use RAII-style withQueueLock() guard that ensures locks are always released, even on exceptions. | |

**User's choice:** Full persistence layer (recommended)

---

## Area 4: Extraction order

| Option | Description | Selected |
|--------|-------------|----------|
| queue-migration first (recommended) | Extract queue-migration.ts first — most isolated concern, smallest boundary, enables independent testing. | ✓ |
| workflow-watchdog first | Extract workflow-watchdog.ts first — SPLIT-02 is prerequisite for BUG-01 fix and surfaces extraction boundaries early. | |
| sleep-cycle first | Extract sleep-cycle.ts first — SPLIT-05 was already approved, and sleep-cycle is the most self-contained concern. | |

**User's choice:** queue-migration first (recommended)

---

## Claude's Discretion

No areas deferred to Claude discretion — all decisions made by user.

## Deferred Ideas

None — all SPLIT requirements addressed within this phase.
