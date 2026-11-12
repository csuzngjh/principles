---
'principles-core': patch
---

PRI-1189: the pi-ai repair loop consumes the shared run-request budget only when a request is actually sent, reports `stoppedBeforeSend` when the remaining time skips a repair, and counts `attemptsUsed` from real sent attempts instead of `maxRepairAttempts`.
