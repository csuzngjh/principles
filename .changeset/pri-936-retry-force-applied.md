---
"@principles/pd-cli": patch
---

PRI-936: `pd pain retry --pain-id` now makes the budget guard bypass observable. The family reset always passes `force=true` (an explicit retry IS the operator's recovery decision), but the `forceApplied` verdict returned by the single recovery authority (`recoverFailedTask`) was dropped — operators could not see which tasks had their attempt budget silently extended by +3. `recoveredTasks` now carries `{taskId, forceApplied}` in the strict JSON output (same shape on the failed and succeeded branches, cli-1) and the text path annotates extended budgets as `(budget +3)`, same-source as JSON.
