---
"@principles/pd-cli": minor
"@principles/service-host": minor
---

PD Service Host Phase 1 (PRI-1279, SPEC-PD-SERVICE-HOST-001 §11 Phase 1 / ADR-0020 §11.6):
new `pd service run-once --dry-run` coordinator plus the new `@principles/service-host`
package (install identity with experiment-root stripping, two-source workspace
discovery over the canonical install manifest and validated per-host claims,
read-only `backgroundExecutions` owner projection, install-level single-instance
run lock with body-verified stale takeover, and the versioned operational status
file under `<pdHome>/service/run-once-status.json`). Phase 1 starts no Worker and
changes no consumer ownership; a run without `--dry-run` refuses
(`dry_run_required_phase1`).
