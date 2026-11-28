# PRI-1278 Service-Host-Only Consolidation — Final Report

> Deliverable for PR #2810. Owner directive: PD Service Host becomes the ONLY
> background runtime; Companion retires to UI/Control Plane only. Explicit
> breaking change, no legacy compatibility.

## 1. Companion legacy runtime — deletion inventory

### Deleted modules (packages/pd-companion)

- `src/main/workspace-workers.ts` — Companion's worker spawn/supervision wiring (deleted)
- Worker supervision, respawn, independent scheduling, task polling, consumer
  management, retry/recovery/lease ownership — all removed with it
- Companion worker tests deleted with the implementation; replaced by negative
  guards (`tests/lib/no-worker-supervision.test.ts`) that FAIL if Companion
  ever regains worker-spawn capability

What remains in Companion (intentional, UI/Control Plane only):

- Console server process supervision (`src/lib/supervisor.ts`) — supervises the
  Console UI server process lifecycle (spawn/crash-loop detection/degraded
  reasons), NOT workers. This is the UI shell's own process management.
- Console release hand-over on upgrade — respawns the NEW console release,
  not any background consumer.

### Deleted modules (packages/openclaw-plugin)

- `src/service/internalization-auto-consumer-service.ts` — the in-process
  OpenClaw auto-consumer (deleted entirely)
- `src/service/gateway-consumer-lease.ts` — lease machinery that existed only
  for the in-process consumer
- `src/service/gateway-quiesce-ack.ts` — quiesce-ack protocol that existed only
  to hand over from the in-process consumer
- Auto-consumer registration, gate, evidence and ownership tests deleted with
  the implementation

What remains in the plugin (intentional): hooks, tool declarations, the bounded
`openclaw worker` cycle invoked BY the Service Host, correction observer.

### Deleted modules (packages/pd-cli)

- Continuous worker mode in `pd codex worker` / `pd workbuddy worker`
  (`--once` bounded cycle or `--status` only; `mode_required` error otherwise)
- `worker-drain` machinery
- Workspace handover orchestration (`workspace-handover.ts` + handover claims)
- Shadow-run execution mode + dead shadow status schema
  (`shadow` status section, `ShadowRunStatusSection`, `ShadowExecutionRecord`,
  `LegacyShadowHostKind` — type-level residue also excised)
- `worker-consumption-gate.ts` (PR-2 driver matrix) — superseded: the
  driver×state matrix collapses to a single binary rule

### Deleted machinery (packages/install-layout)

- Transition kinds collapsed: only `provision_fresh_install` survives
  (`BACKGROUND_EXECUTION_TRANSITIONS = ['provision_fresh_install']`)
- `handover_preparing` / `rollback_pending` remain READABLE as retired
  residue states (fail-closed: they are never written and never consumed)
- `legacy_owned` no longer means "a legacy consumer owns this" — it means
  un-provisioned residue that NOTHING consumes until provisioned

### Deleted guards (packages/create-principles-disciple)

- `legacy_consumer_unproven` / `legacy_consumer_running` guard states — gone
  with the consumers they protected
- `pendingHost` / `guardHosts` Companion-consumer risk tracking — removed
- OpenClaw-Gateway-running-as-consumer-protection branch — removed: the
  Gateway is now only a host adapter environment, never a PD consumer
- What survives: formal host-binding verification
  (`resolveResumeProvisioningHost` reads Workspace/Adapter bindings, per
  directive §4.2) and the one-time legacy-worker process scan on upgrade
  (fail-closed: scan failure or a running legacy worker keeps the ownership
  transfer pending, visible reason `legacy_worker_still_running`)

## 2. Unified architecture (post-consolidation)

```
OS Scheduler (system-crontab/Task Scheduler/launchd — existing, unchanged)
    │  bounded trigger
    ▼
pd service run-once            ← the ONLY background execution entry
    │  trusted prefix: identity → install lock → active release → manifest
    │                   → validated claims → workspace discovery
    ▼
managed-run admission (per workspace, fail-closed):
    service_host_owned + effectiveOwner=service_host + authorized discovery
        → ONE bounded worker cycle per bound host adapter
    legacy_owned / retired transition residue / conflicting projection
        → skipped, structured reason, never consumed
    ▼
Worker Adapters (codex / workbuddy / openclaw)
    │  spawn bounded `--once` CLI cycles, per-workspace mutex, lease fencing
    ▼
pd <host> worker --once        ← binary gate: consumes ONLY when the
                                 workspace is service_host_owned; manual
                                 invocation of a non-Service-Host workspace
                                 refuses with operator guidance
```

Companion / Console: read status, submit operator requests. No execution.
`host=none` → workspace owned by Service Host in `waiting_for_host_binding`;
no worker starts until a host adapter binding exists; NO Companion fallback.
`host=all` → multiple host adapters fan-out inside the ONE Service Host run,
never multiple runtimes.

## 3. Actual execution entries (complete inventory)

| Service | Discovery | Scheduling | Dispatch | Execution | Lease/Lock | Retry/Recovery |
|---|---|---|---|---|---|---|
| internalization worker cycles | Service Host workspace-discovery | OS Scheduler → run-once | managed-run admission | bounded `--once` per adapter | install-level run lock + per-workspace mutex + durable lease | Service Host bounded re-trigger |

Single row — that is the point. There is no second consumer to tabulate.

## 4. Test inventory (new / deleted / modified)

- install-layout: transition-machine tests rewritten for the single-kind
  machine — 190/190 green
- pd-companion: worker supervision tests deleted; negative guards added —
  22 files green
- pd-cli: continuous-mode/drain/handover/shadow tests deleted or rewritten
  (shadow-real-cli → managed-real-cli); service-host suite 458 passed / 2
  environmental failures (see §6)
- openclaw-plugin: auto-consumer gate/service/evidence/ownership tests deleted
- create-principles-disciple: provisioning tests rewritten for the
  single-owner model

## 5. Code statistics

- Consolidation commit `a2a814282`: 100 files changed, 2728 insertions,
  11917 deletions (net −9189 lines)
- Guard-integration repair `736e5d0c9`: 10 files, 42 insertions, 260 deletions

## 6. Verification evidence

**CI matrix — ALL GREEN at HEAD `54e70e185`** (authoritative gate, run 46019457258):
- Verify Merge Gate: PASS (4m7s) — incl. canonical build, lint-by-package
  (13/13), all typechecks, guard contracts, release-intent check
- Test pd-cli (Linux): PASS (4m42s) / Test pd-cli (Windows): PASS (4m46s)
- Test shared runtime & adapters: PASS (12m21s) — incl. runtime-writers SSoT
  baseline and satellite-purity guard
- Test create-principles-disciple: PASS (2m55s) — incl. rewritten
  provisioning tests and child-process windowsHide scan
- Test OpenClaw Plugin (unit+integration+coverage): PASS (1m51s)
- Test packaged install smoke: PASS (3m37s)
- Test principles-core: PASS (2m56s) / Test pd-console: PASS / Test
  pd-mcp-server: PASS / Test workbuddy-adapter (Windows fixtures): PASS
- e2e: PASS (4m47s) / CodeQL: PASS / Codex plugin delivery contract: PASS
- Devin Review: PASS (completed analysis)

Build/compile:
- Full monorepo `npm run build`: zero TypeScript errors, all dist artifacts
- pd-cli `tsc --noEmit`: clean (after dead shadow-schema excision)
- create-principles-disciple `typecheck:tests`: clean
- principles-core / host-runtime tsc: clean

Test evidence (local, WSL /mnt/d — timeout-flaky environment; CI Linux is
the authoritative full gate):
- install-layout: **190/190 PASS** (transition-machine rewrite for the
  single-kind provision_fresh_install machine, incl. from-any-state CAS)
- pd-companion: **22 test files PASS** incl. the negative guard
  `no-worker-supervision.test.ts` (AST scan + forbidden-pattern proof +
  non-vacuousness control)
- pd-cli service-host suite: **458 passed / 2 failed** — both classified
  environmental with evidence: (a) `progress-evidence` EACCES chmod test —
  /mnt/d does not enforce POSIX permission bits and the file is UNMODIFIED
  by this change; (b) `managed-real-cli` concurrency timing — **passes in
  isolation**, fails only under multi-suite IO contention
- create-principles-disciple provisioning + CAS coexistence: **16/17 then
  14/14 PASS** after rewrite of the stale P0-guard resume tests into the
  one-time legacy-worker-scan contract (`legacy_worker_still_running`
  fail-closed, scan-unverifiable fail-closed, clean-scan proceeds,
  idempotent repetition, no ownership write while blocked — manifest bytes
  compared before/after)
- principles-core architecture-regression: **320/320 PASS** (incl. plugin
  core anti-growth baseline with the classified openclaw-tool-declaration)
- principles-core feature-flag-lifecycle: **18/18 PASS** (census consumers
  retargeted at live paths)
- host-runtime wiring guards: **18/18 PASS** (thin-shell assertions
  repointed at the openclaw worker; production wiring itself already correct:
  `hostKinds` labels present in all three host shells)
- openclaw-plugin: full-run failure clusters reproduce as TIMEOUTS under
  IO contention (e.g. `prompt-golden` **7/7 in isolation**); failing areas
  (prompt content/feature flags/path resolver) are outside the change
  surface; CI `Test OpenClaw Plugin` **PASSED** on the consolidation commit
- codex-adapter / workbuddy-adapter local runs: failure clusters are
  real-subprocess timing tests (15–30s per case on /mnt/d, 82 timeout
  markers) in areas outside the change surface (plugin bundle install,
  hook adaptive timing)

Error Context routing (diff mode, recorded per §0):
EP-03 HIGH 98 / EP-02 HIGH 90 / EP-04 HIGH 66 / EP-09 HIGH 66 / EP-12 HIGH 49
/ EP-14 HIGH 42 / EP-06 HIGH 32 + EP-01/05/07/08 HIGH minors, EP-10/11 MEDIUM.
Reconciliation: cross-package contract breakage was found by CI (not by
assumption) and repaired with executable green evidence — surface registry
entries removed with the deleted implementation, census consumer paths
retargeted to live files, plugin-core baseline reclassified, wiring guards
repointed, changeset release intent corrected (private package removed,
@principles/core declared). Real-entry evidence: managed-real-cli real-CLI
tests, real transition-CAS tests, Companion negative AST guard.

## 7. End-to-end acceptance

- `Test packaged install smoke` (CI): **PASS** at HEAD — performs a real
  packaged install of the consolidated layout, validating install-path
  provisioning end-to-end on a clean machine
- `e2e` (CI): **PASS** at HEAD
- Local real-run E2E (fresh install + scheduler fires + real task executed
  through the bounded run-once path) was not executable in the WSL dev
  environment within this session; this is a real residual risk, not a
  hidden one — see §9

## 8. Evidence that old consumers cannot restart

- Companion main process contains no worker command/supervision/drain/
  liveness machinery — proven by the AST-scanning negative guard which
  fails loudly on reintroduction (and proves non-vacuousness: the Console
  spawn path still exists exactly once)
- `workspace-workers.ts` physically deleted; no production module
  references `PD_COMPANION_WORKER_IPC` / `pd.worker.drain` /
  `workspace_worker_` (guard-enforced)
- No continuous mode exists in any worker CLI: `pd codex worker` /
  `pd workbuddy worker` without `--once`/`--status` exits `mode_required`
- Manual worker invocation of a non-service_host_owned workspace refuses
  with operator guidance (`codex_workspace_not_service_host_owned:<state>`)
- OpenClaw plugin contains no in-process consumer: the service, its lease
  and quiesce-ack files are physically deleted; registry entries removed;
  the plugin-core baseline guard pins the new file inventory
- Upgrade path: the installer runs a one-time legacy continuous-worker
  process scan (matches `<host> worker --workspace <dir>` WITHOUT `--once`
  — a shape only the retired Companion runtime produced); scan-positive or
  scan-unverifiable keeps ownership transfer pending fail-closed with
  operator next-action, verified by rewritten provisioning tests

## 9. Known limitations / follow-ups

- `shadow-progress-store` filename/schema (`pd.shadow-progress.v1`) retains
  the historical "shadow" name though it is now simply the cross-run
  progress projection; renaming the persisted file is cosmetic and deferred
- Local real-install E2E not executed in this session (WSL environment);
  CI packaged-install smoke + the bounded real-CLI tests are the current
  executable evidence. A follow-up real-environment validation pass on the
  Owner's machine is recommended before declaring the migration operationally
  closed
- PR #2811 (driver-matrix consumer gate) is superseded by this
  consolidation — its per-cycle mutex discipline survives inside the
  bounded `--once` design; recommend closing it when this PR merges
- WSL /mnt/d environmental test noise; CI Linux is the authoritative gate

## 10. Final answer

**PD is architecturally Service-Host-only as of this PR:**
every background execution entry is Service-Host-managed run-once dispatch;
Companion physically cannot spawn/supervise/schedule workers (guard-proven);
the OpenClaw in-process consumer is deleted, not disabled; continuous modes
no longer exist; provisioning converges to service_host_owned only, with no
Companion fallback anywhere. Residual honesty: the local real-install E2E
pass (§7/§9) remains the one piece of evidence this session could not
produce — the codebase-level migration is complete, the operational
acceptance on a real machine is pending.
