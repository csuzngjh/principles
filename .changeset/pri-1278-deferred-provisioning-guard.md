---
"create-principles-disciple": patch
---

Block deferred Codex/WorkBuddy Service Host provisioning when the legacy consumer cannot be proven quiesced. The installer now records a resumable `legacy_consumer_unproven` pending state instead of running readiness or `provision_fresh_install` without strict quiesce evidence.
