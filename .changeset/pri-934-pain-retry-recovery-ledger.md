---
"@principles/core": patch
"@principles/pd-cli": patch
---

`pd pain retry` no longer dead-ends on a failed diagnosis task: it now
recovers the failed diagnostician family (parent + rootcause/distiller/router
stages) through the shared recovery authority before re-running, and a
surviving `lease_conflict` says so with a nextAction pointing at
`pd runtime recovery failed-tasks`. Both CLI diagnosis paths
(`pd diagnose run` and `pd pain retry`, including dead-letter replay) now
write the `pain_diagnoses` attribution ledger when the
`pain_diagnosis_persistence` flag is on — the result reports
`attempted` / `disabled` / `skipped_no_pain_lineage` honestly instead of
silently dropping the attribution row (PRI-934, PRI-935).
