---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"@principles/pd-cli": patch
"@principles/codex-adapter": patch
"@principles/workbuddy-adapter": patch
---

P0: enforce `automatic_pain_submission` authorization BEFORE the Pain
submission chain — `PainSignalBridge.onPainDetected` refuses
`automatic_hook` right after provenance resolution (ahead of
capabilityDisabled ensure and every existing-task path), and
`PainToPrincipleService.recordPain` / `admitGovernanceSignals` apply the
same lazy probe so unauthorized signals never create, reset, re-execute
or mutate a diagnosis task (observation-only stays the only record).
The `authorizedEvidence` evidence-emptiness mechanism is removed.

P1: fix the Companion restart-timer race — entering
`handover_preparing`/`rollback_pending`/`service_host_owned` now retires
entries without a live child (stopped + drain/restart handles cleared),
and `spawnFor` re-verifies stopped state, the ownershipBlocked set, and
registry entry identity at the final launch point so a stale crash
restart can never resurrect a legacy worker mid-transition.
