# Phase 22: BC-02 Residual Fallback Cleanup - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-11
**Phase:** 22-bc02-residual-fallback-cleanup
**Areas discussed:** Failure mode (throw vs safe-skip)

---

## Failure Mode — Throw vs Safe-Skip

| Option | Description | Selected |
|--------|-------------|----------|
| Keep existing error handling | deep-reflect returns error message; critique-prompt throws. Just remove fallback. | |
| Both should throw | Convert deep-reflect's user-facing error into thrown exception. Both fail hard. | ✓ |

**User's choice:** Both should throw
**Notes:** User wants consistent failure behavior — both call sites throw when workspace cannot be resolved. `deep-reflect.ts` needs its error-message-return converted to a thrown exception. `critique-prompt.ts` already throws — just remove the fallback.

---

## Claude's Discretion

- Exact error message text for deep-reflect's new throw
- Whether to add logging before the throw

## Deferred Ideas

None
