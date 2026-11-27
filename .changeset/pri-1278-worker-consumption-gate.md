---
"@principles/pd-cli": patch
"@principles/codex-adapter": patch
---

PRI-1278 Phase 5 consumer-safety substrate: the Codex and WorkBuddy workspace workers now evaluate the §8.4 ownership projection before every consuming cycle and hold the existing per-workspace run mutex for the duration of each cycle. Legacy drivers (manual/Companion) stop consuming once a workspace enters or completes the Service Host handover (`handover_preparing` / `rollback_pending` / `service_host_owned`); the Service-Host driver keeps the designed shadow convergence on legacy-owned workspaces and never consumes mid-transition states; an unreadable owner marker fails closed. The mutex is per-cycle (never process-lifetime) so a drained Companion worker holds no lock between cycles and handover/rollback can prove quiescence. No behavior change for workspaces without ownership records (legacy default) and none for the OpenClaw worker, which already had both mechanisms.
