---
'@principles/core': patch
---

S6: cap a single logical run at 3 PD-issued provider requests. The three output paths, the PRI-1011 downshift retries and the schema repair loop now draw from one run-local budget, so a run that fails every output path no longer spends three extra repair requests. This is not a cap on raw HTTP attempts: pi-ai's own transport retries still happen inside each PD request (S2 owns them) and are not counted. When the budget is spent before repair, `output_repair_attempted` reports `repairSkipped: true` / `repairSkipReason: 'request_budget_exhausted'`. When it runs out mid-repair, both repair events report `repairSkipReason: 'request_budget_exhausted'` plus `repairAttemptsConfigured` and `repairAttemptsSkippedByRequestBudget`, so a partially truncated repair is auditable instead of looking like a loop that used everything it was given.
