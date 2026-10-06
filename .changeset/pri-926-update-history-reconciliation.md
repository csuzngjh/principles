---
"create-principles-disciple": patch
---

PRI-926: update history reconciliation now tells the truth. The ReleaseManager journals `preUpdateProductVersion` on the planned transition (from the active record), reconciliation derives `fromVersion` from it (absence stays `unknown`), only journals in the ReleaseManager update domain synthesize Owner-facing rows (wrongly-projected install-domain rows are dropped), timestamps come from the journal's first line instead of the scan moment, and synthesized ids are deterministic (`reconciled-<transactionId>`) so cap-evicted rows cannot resurrect as duplicates. Ships the pd-console reconciliation fix inside the installer package (pd-console is private).
