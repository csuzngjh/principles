---
'@principles/pd-cli': patch
---

PRI-1193: `pd candidate review --decide create` now seeds the principle candidate's dreamer task after the ledger entry is written (and on idempotent re-runs), so `run-rulehost --pain-id` can no longer silently select the rule candidate's dreamer and skip approval enqueue. The JSON/ human output reports `dreamerStatus` / `dreamerTaskId` and an executable `nextAction` when seeding is not possible.
