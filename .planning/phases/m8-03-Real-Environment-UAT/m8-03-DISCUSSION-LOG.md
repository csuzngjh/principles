# Phase m8-03: Real Environment UAT - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-28
**Phase:** m8-03-Real-Environment-UAT
**Areas discussed:** Pain trigger strategy, Baseline strategy, Pass criteria

---

## Area 1: Gray Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Use /pd pain command | Use /pd pain command to generate pain — predictable, reproducible | |
| Trigger real tool failure | Cause a real tool failure (read nonexistent file, etc.) — tests the natural path | |
| Try tool failure first, then /pd pain | Both — start with real failure, fall back to /pd pain if it doesn't trigger | ✓ |

**User's choice:** Try tool failure first, then /pd pain
**Notes:** Primary = real tool failure via OpenClaw agent session. Fallback = /pd pain if hook doesn't naturally trigger. Must verify pain_detected event was emitted (pain flag file, gateway logs, or BRIDGE_ERROR).

---

## Area 2: Baseline Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Clear existing entries | Clear ledger entry count, no comparisons needed | |
| Record baseline and compare | Capture current state then compare — more accurate verification | ✓ |

**User's choice:** Record baseline and compare
**Notes:** Record current state (ledger count, legacy file counts, task counts) BEFORE triggering pain. Compare post-UAT counts against baseline to isolate UAT-specific changes.

---

## Area 3: Pass Criteria

| Option | Description | Selected |
|--------|-------------|----------|
| All 5 must pass (strict) | All 5 UAT items must pass — conservative, safer | ✓ |
| Critical path + majority (pragmatic) | At least 3/5 pass + critical path (UAT-01 full chain + UAT-02 legacy not revived) pass = M8 SHIPPED | |

**User's choice:** All 5 must pass (strict)
**Notes:** UAT-01 = full chain (task=succeeded + artifact + candidate + ledger probation entry) is critical path. UAT-02 = legacy NOT revived is regression gate. UAT-03 = idempotency. UAT-04 = runtime probe. UAT-05 = no errors.

---

## Done Check

| Question | Options | User's choice |
|----------|---------|---------------|
| Any other gray areas? | "Explore more gray areas" / "I'm ready for context" | I'm ready for context |

---

## Deferred Ideas

None — discussion stayed within phase scope.

---

*Phase: m8-03-Real-Environment-UAT*
*Discussion log: 2026-04-28*