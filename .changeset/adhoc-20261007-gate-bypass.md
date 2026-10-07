---
"@principles/pd-cli": patch
---

R7 gate-bypass fix — `pd candidate intake`, `pd candidate repair` and
`pd candidate internalization backfill` now construct their
CandidateIntakeService through the same Reuse Review Gate assembly as
`pd diagnose` / `pd pain retry` / the automatic bridge. Previously the three
manual commands ran with `reuseCheck='not_configured'`, so a semantic
duplicate the gate had parked (`reuse_review_required`) could be written into
the Principle Ledger as a duplicate Principle with exit 0 (P0 bypass proven on
shipped 2.2.0/2.2.1). A parked candidate now surfaces
`status: review_required` (intake/repair) or a deferred result with a
`pd candidate review --decide` next action (backfill), mutates nothing, and
emits the `reuse_gate_triggered` telemetry event like every other path.
`reuseEvaluation.enabled=false` still restores the exact pre-fix behavior.
