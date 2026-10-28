---
'@principles/pd-cli': patch
---

Fix: `pd pain recall` no longer creates `-wal`/`-shm` sidecar files next to WAL-mode databases (the production resting state for both state.db and trajectory.db). Quiet WAL databases are now read through a verified-fresh staged temp copy; WAL databases with an active or crashed writer keep the direct read-only attach (fresh, creates nothing); rollback-journal databases are unchanged. A writer becoming active during staging fails the source as unreadable instead of returning stale data. (SPEC-PD-PAIN-RECALL-CLI-001 §6.1/§9.2; SPEC-PD-AGENT-CAPABILITY-API-001 v0.3 §10.3.1)
