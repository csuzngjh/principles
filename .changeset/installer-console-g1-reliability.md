---
'create-principles-disciple': patch
'@principles/pd-cli': patch
---
PRI-1069/1070 G1 reliability (installer + pd-console, shipped inside create-principles-disciple): installer console verification now binds each probe attempt to the launched child via a one-shot nonce (old-console/foreign/proxy healthy responses are rejected fail-closed) and records attempt-level diagnostics; the probe child is terminated with a real bounded exit join, and an unconfirmed child defers destructive restore (restore_deferred). Rollback no longer deletes the live tree before restoring the backup — same-volume rename-aside with per-tree outcomes, partial-backup compensation, and machine-readable restore_incomplete markers that the Console recovery surface reports as needsRecovery instead of skipping terminal failures.
