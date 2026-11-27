## Summary

**PRI-1278 Service-Host-only consolidation (BREAKING CHANGE, Owner-directed).** PD Service Host becomes the ONLY background runtime. Companion retires to UI/Control Plane; the OpenClaw in-process auto-consumer, continuous worker modes, handover/rollback orchestration, shadow-run, and worker-drain machinery are deleted — not deprecated. No legacy-compatibility path is retained (single-user breaking switch, per Owner directive).

This PR subsumes and supersedes the original P0 deferred-provisioning guard scope: the guard's protected legacy consumers no longer exist, making the guard machinery itself unnecessary.

### What was deleted

- **Companion background runtime** — `workspace-workers.ts`, worker spawn/supervision/scheduling/respawn/polling/consumer management. What remains is Console UI process supervision only (control plane). Negative AST-scanning guards (`no-worker-supervision.test.ts`) fail loudly if worker capability is ever reintroduced.
- **OpenClaw in-process auto-consumer** — service, gateway consumer lease, quiesce-ack protocol, registration: physically deleted. The Gateway is now only a host adapter environment. The host tool declaration (a host fact, not consumer behavior) was extracted into `core/openclaw-tool-declaration.ts` and classified in the plugin-core baseline.
- **Continuous worker modes** — `pd codex worker` / `pd workbuddy worker` accept only `--once` (bounded cycle) or `--status` (read-only); anything else exits `mode_required`.
- **Handover/rollback orchestration + worker-drain + shadow-run** — transition machine collapsed to the single kind `provision_fresh_install` (from-ANY-state → `service_host_owned`); `handover_preparing`/`rollback_pending` remain only as readable retired residue that nothing consumes; dead shadow status schema/types excised.
- **Legacy-consumer guard machinery** — `legacy_consumer_unproven`/`legacy_consumer_running`/`pendingHost`/`guardHosts` and the OpenClaw-Gateway-as-consumer protection branch are gone with the consumers they protected.

### The unified architecture

```
OS Scheduler (existing) → pd service run-once  ← THE only background entry
  → trusted prefix (identity/lock/release/manifest/discovery)
  → admission: service_host_owned + authorized → ONE bounded --once cycle per bound host adapter
  → everything else skipped fail-closed with structured reasons
```

- `host=none` → Service-Host-owned `waiting_for_host_binding`, never a Companion fallback
- `host=all` → multi-adapter fan-out inside ONE runtime, never multiple runtimes
- Manual worker invocation of non-Service-Host-owned workspaces refuses with operator guidance
- One-time upgrade switch: installer scans for legacy continuous-worker processes (the `<host> worker` without `--once` shape only the retired Companion runtime produced); scan-positive/unverifiable keeps ownership transfer pending fail-closed (`legacy_worker_still_running`), verified by rewritten provisioning tests

## Test plan

- [x] Full monorepo build — zero TS errors
- [x] install-layout 190/190 (single-kind transition machine)
- [x] pd-companion 22 files incl. negative AST guard
- [x] pd-cli service-host suite 458 passed (2 environmental-classified, evidence in report)
- [x] create-principles-disciple provisioning rewritten tests 14/14 (scan contract, no-write-while-blocked incl. manifest byte comparison)
- [x] principles-core architecture-regression 320/320, feature-flag-lifecycle 18/18
- [x] host-runtime wiring guards 18/18
- [x] CI Test OpenClaw Plugin PASSED on consolidation commit
- [ ] Full CI matrix (authoritative gate — WSL local env is timeout-flaky)
- [ ] Real-machine operational acceptance (honest residual, see report §7/§9)

Full evidence, deletion inventory, execution-entry table and the honest final answer: **`PRI-1278-SERVICE-HOST-ONLY-FINAL-REPORT.md`** in this branch. Design/audit lineage: `PRI-1278-SERVICE-HOST-ONLY-DESIGN.md`, `PRI-1278-SERVICE-HOST-ONLY-STATE.md`.

## Notes

- Net diff: −9189 lines in the consolidation commit alone (2728+/11917− across 100 files)
- PR #2811 (consumer-safety driver matrix) is superseded — its per-cycle mutex discipline survives inside the bounded `--once` design; recommend closing after this merges
- Error Context diff-mode routing recorded and reconciled in report §6

Generated with [Devin](https://devin.ai)
