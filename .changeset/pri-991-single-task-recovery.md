---
'@principles/core': minor
'@principles/pd-cli': minor
---

PRI-990: single-task failed recovery — pd runtime recovery failed-task --task-id <exact> (dry-run default, CAS-guarded confirm, explicit --reset-budget for exhausted budgets, recovery_actions.jsonl audit with previousAttemptCount). Core: recoverSingleFailedTask + inspectFailedTaskRecovery strict path; legacy batch recoverFailedTask upgraded to the same CAS precondition with unchanged observable behavior.
