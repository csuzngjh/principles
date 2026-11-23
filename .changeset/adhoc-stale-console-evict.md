---
"@principles/pd-cli": patch
"create-principles-disciple": patch
---

pd console open: detect and evict stale console processes that still answer
/api/health but can no longer serve the UI (deleted entry file or missing
web bundle). The console health endpoint now reports an instance block
(pid, serverEntry, webIndexExists); the launcher verifies the reported pid's
live command line AND its ownership of the listen socket before terminating
it (fail closed when unverifiable), then binds a healthy console on the
preferred port. pd health reports the state as stale_running.
