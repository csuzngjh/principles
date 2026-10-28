---
'@principles/pd-cli': patch
---

Fix: `pd pain recall` no longer creates or rewrites `-wal`/`-shm` sidecar files next to WAL-mode databases (the production resting state for both state.db and trajectory.db). Every WAL-mode database is now read through a fingerprint-verified staged snapshot in a private temp directory: the (main, `-wal`) pair is hashed before the copy, the staged copies must match, and the source pair is re-hashed after — any writer race rejects the source as unreadable instead of returning stale data. A non-empty `-wal` (live writer or crash residue) is recovered through the staged pair, so un-checkpointed commits stay visible. Rollback-journal databases keep the direct read-only open. CLI arguments, JSON schema, and exit codes are unchanged. (SPEC-PD-PAIN-RECALL-CLI-001 §6.1/§9.2; SPEC-PD-AGENT-CAPABILITY-API-001 v0.3 §10.3.1)
