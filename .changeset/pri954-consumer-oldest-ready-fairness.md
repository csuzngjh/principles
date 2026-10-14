---
"@principles/core": patch
"@principles/host-runtime": patch
---

PRI-954 (R1 F10): bounded stage fairness for the internalization consumer — oldest-ready-stage-first.

- core: `InternalizationQueueReadModel` ReadyTask entries now carry the task row's `createdAt` (queue age; additive field, falls back to the hydrated pi-metadata timestamp for legacy rows) so consumers can implement age-based fairness without a second query.
- host-runtime: `runInternalizationConsumerCycle` starts each cycle's stage scan at the stage owning the globally OLDEST ready task instead of always dreamer-first. Under a continuous stream of new dreamer tasks (each real Pain creates one) downstream stages (philosopher → … → rollout_reviewer) were previously starved for an unbounded number of cycles — measured at 35+ minutes philosopher starvation with a 13-deep backlog in the 2026-10-13 dogfood run. The new order removes the priority-order starvation (the oldest ready task is served before newer arrivals) with no concurrency, no persisted scheduler state (works across one-shot `pd codex worker --once` processes), and with leases, idempotency, dependency order, and single-task-per-cycle semantics unchanged. Ties keep the original priority order; tasks without a readable createdAt never jump the queue.
