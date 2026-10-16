---
'create-principles-disciple': patch
---

Retire the local manifest-host union twin: install-layout 0.4.0 is published,
so the installer imports the shared `installManifestHostsForPersist()` again
and the temporary local copy (added when the registry only served 0.3.x) is
deleted. The registry-parity dual-mode test now runs its POSITIVE mode
against the published dependency: an unknown future host survives codex
install, workbuddy install and known-host uninstall end-to-end.
