---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"@principles/pd-cli": patch
"@principles/pd-companion": patch
"create-principles-disciple": patch
---

B-class automatic Pain submission authorization + Service Host handover safety (Pain Ingress SPEC §9.6 / Service Host SPEC §8.4).

- New quiet flag `automatic_pain_submission` (default off, per-Workspace `.pd/config.yaml` `features:`) is the independent Owner authorization for automatic_hook Pain submissions — deliberately distinct from `signal_collector` and `internalization_auto_consumer`.
- Gates: SignalCollectorHost suppresses STRONG routing, Stage-2 LLM enqueue/invocation and batch confirmation while unauthorized; `emitPainDetectedEvent` degrades unauthorized automatic submissions to observation-only; `runPendingDiagnosticianOnce` skips persisted `automatic_hook` candidates; `pd pain retry` refuses `automatic_hook` dead-letter replays.
- Companion Supervisor reads manifest `backgroundExecutions`: `handover_preparing`/`rollback_pending`/`service_host_owned` forbid legacy worker start/restart (running workers drain+stop; restarts cannot resurrect); stable `legacy_owned` re-allows.
