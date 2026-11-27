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

- Net diff: ~1894 insertions / ~12144 deletions across 85+ files
  (uncommitted-at-writing; final numbers in PR body)

## 6. Verification evidence

- Full monorepo build: zero TypeScript errors
- install-layout tests: 190/190 PASS
- pd-companion tests: 22 files PASS (+1 skipped)
- pd-cli service-host suite: 458 passed / 2 failed — both classified
  environmental: (a) `progress-evidence` EACCES chmod test — /mnt/d does not
  enforce POSIX permission bits, file UNMODIFIED by this change; (b)
  `managed-real-cli` concurrency timing — passes in isolation, fails only
  under multi-suite IO contention (WSL slow-mount class documented in PR-2)
- openclaw-plugin: full-run failures reproduce as TIMEOUTS under IO
  contention; `prompt-golden` verified 7/7 in isolation; failing areas
  (prompt content/feature flags/path resolver) are outside the change surface
- create-principles-disciple: (pending at writing)
- host-runtime / codex-adapter / workbuddy-adapter: (pending at writing)

## 7. End-to-end acceptance

(to be filled — real-run verification or honest CI-deferral statement)

## 8. Evidence that old consumers cannot restart

- Companion contains no worker-spawn code path (negative guard test)
- No continuous mode exists in any worker CLI (`mode_required` error)
- Manual worker invocation of non-service_host_owned workspaces refuses
- OpenClaw plugin contains no in-process consumer registration
- Autostart entries: (installer upgrade-path scan — evidence in provisioning tests)

## 9. Known limitations / follow-ups

- `shadow-progress-store` filename/schema (`pd.shadow-progress.v1`) retains
  the historical "shadow" name though it is now simply the cross-run progress
  projection; renaming the persisted file is cosmetic and deferred
- WSL /mnt/d environmental test noise; CI Linux is the authoritative full gate
- PR #2811 (driver-matrix consumer gate) is superseded by this consolidation —
  its per-cycle mutex discipline survives inside the bounded `--once` design

## 10. Final answer

(to be completed after E2E)
