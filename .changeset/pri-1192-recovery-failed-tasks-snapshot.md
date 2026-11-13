---
'@principles/pd-cli': patch
'@principles/core': patch
---

PRI-1192: `pd runtime recovery failed-tasks --confirm --json` now emits a versioned (`runtime_recovery_failed_tasks.v1`), fixed-key-order pre-reset snapshot (`recoveredTaskIds` plus per-task `previousStatus` / `previousAttemptCount` / `previousLastError` / `reason`) so the batch recovery is traceable without a durable ledger. A mid-sweep failure no longer discards the tasks already reset: they stay in the output, the run reports `ok:false`, exits non-zero and gives a per-task retry `nextAction`. `detectFailedTasks()` now exposes the persisted `lastError` category to feed the snapshot.
