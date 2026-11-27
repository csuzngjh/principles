---
"@principles/pd-cli": minor
"@principles/install-layout": minor
"@principles/pd-companion": minor
"principles-disciple": minor
"@principles/codex-adapter": minor
"@principles/workbuddy-adapter": minor
"@principles/host-runtime": minor
"create-principles-disciple": minor
---

BREAKING (PRI-1278): PD Service Host becomes the only background runtime. Companion loses all background execution capability (worker start/supervision/scheduling/respawn) and keeps UI/Control Plane only. The OpenClaw in-process auto-consumer, continuous worker modes, handover/rollback orchestration, shadow-run, and worker-drain machinery are deleted. New workspaces provision to `service_host_owned` only; bounded `--once` worker cycles run exclusively under Service Host management; `host=none` workspaces wait for host binding instead of falling back to any legacy consumer. No legacy-compatibility path is retained.
