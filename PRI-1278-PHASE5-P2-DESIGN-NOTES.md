# PRI-1278 Phase 5 — PR 2 Consumer-Safety Substrate: Investigation & Design Notes

> Scratch design capture for the multi-session implementation of preflight-report §7 PR 2
> (Codex/WorkBuddy ownership gate + per-workspace run mutex). Fold into the final PR report
> or delete before merge. Baseline: origin/main `a7a3479c64a7aae0840ba639a74c6468ff8c1369`.
> Branch: `ai/PRI-1278-phase5-p2-consumer-substrate`. Lease owner: `devin:pri-1278-phase5-p2-consumer-substrate` (renew after 2026-11-27T08:40Z).

## 1. Established facts (verified in source this session)

### Driver topology — ALL three drivers flow through the same CLI worker command

1. **manual**: operator runs `pd codex worker [--once|--interval]` directly.
2. **companion**: pd-companion `workspace-workers.ts` spawns ONE continuous `pd codex worker` child per manifest workspace; drain protocol = private IPC message `pd.worker.drain.v1`, detected in the worker via env `PD_COMPANION_WORKER_IPC=1` + `process.send` (`worker-drain.ts`). Drain stops BETWEEN cycles, never interrupts an active cycle.
3. **service_host**: `managed-run.ts` instantiates adapters (`worker-adapter-codex.ts` / `-workbuddy.ts` / `-openclaw.ts`); `createOnceCliWorkerAdapter` (worker-adapter.ts ~line 480) spawns the ACTIVE-RELEASE CLI entry as a child: `pd <host> worker --once --json --workspace <dir>` with env from `buildWorkerEnvironment` (worker-env.ts), which sets `PD_INVOCATION_ID` when the coordinator passes an invocationId (worker-env.ts lines 263-265) and strips `PD_COMPANION_WORKER_IPC` / `PD_INVOCATION_SOURCE` from inheritance (worker-env.ts lines 15/40).

**Consequence**: adding gate + mutex inside the pd-cli worker commands covers all three drivers — exactly the OpenClaw topology. No adapter-package changes needed for the mutex (and the lock can't live there anyway — see §3).

### Existing driver attribution

- `codexWorkerCycleDriver()` in `packages/codex-adapter/src/worker/workspace-worker.ts` (writes `lastCycleDriver` into `.state/codex-worker-liveness.json`, line ~711; values observed in status output: `'companion' | 'service_host' | 'manual'`).
- `invocationIdLivenessPatch()` same file line 176: reads `process.env.PD_INVOCATION_ID`.
- TODO next session: read exact logic of `codexWorkerCycleDriver()` + the workbuddy equivalent (`packages/workbuddy-adapter/src/worker/workspace-worker.ts` also references lastCycleDriver) and reuse THE SAME detection for the gate — do not invent a second driver-detection mechanism.

### OpenClaw reference pattern (the design to mirror)

- **Mutex**: acquired in the pd-cli command handler (`openclaw-worker.ts` in pd-cli/src/commands): `acquireWorkspaceServiceRunLock(pdHome, workspace)` from `packages/pd-cli/src/services/service-host/locking/service-run-lock.ts` (908 lines, exports `acquireWorkspaceServiceRunLock`, `releaseServiceRunLock`, `workspaceServiceRunLockPath`, `SERVICE_RUN_LOCK_STALE_MS` = 30min). Held for ONE cycle only. `held` verdict → mode `paused` (NOT degraded, no exit code 1) with reason `openclaw_worker_run_in_progress`; corrupt/unwritable → degraded + exit 1. Skipped entirely when pdHome doesn't exist (fresh install; ownership gate then reports not-managed).
- **Ownership gate**: inside the adapter cycle (`packages/openclaw-plugin/src/openclaw-worker.ts` lines ~430-455): `readOpenClawWorkspaceOwnership(workspaceDir)`; `manifest_unreadable` → degraded fail-closed; anything != `service_host_owned` → mode `paused`, reason `openclaw_workspace_not_service_host_owned:<status>`, writes liveness via finalizeLiveness, returns WITHOUT consuming. Uniform because OpenClaw worker has exactly one legitimate driver (service host).

### Codex/WorkBuddy worker commands today (the gap)

- `packages/pd-cli/src/commands/codex-worker.ts` (275 lines) and `workbuddy-worker.ts` (236 lines): NO ownership gate, NO mutex. `--once` runs `runCodexWorkspaceWorkerCycle`/`runWorkbuddyWorkspaceWorkerCycle` directly; continuous mode loops with `createWorkerDrain()` + per-cycle try/catch (PRI-655 discipline: cycle exception must not kill the daemon).

## 2. Design decisions (proposed — validate before implementing)

### Mutex semantics: PER-CYCLE, never process-lifetime

Acquire before EACH individual cycle in both `--once` and continuous mode; release immediately after. Rationale: the drain protocol stops continuous workers BETWEEN cycles, and handover/rollback completion waits for the workspace run mutex to become free — a resident drained worker holding the lock for its process lifetime would deadlock rollback (preflight §8.1, handover evidence `worker quiesced` checks use holder-PID liveness). Per-cycle 'held' verdict → skip that cycle as `paused` (`<host>_worker_run_in_progress`), continuous loop keeps running (it is not a crash).

### Ownership gate placement: pd-cli CLI command layer (not adapter cycle)

The lock lives in pd-cli and adapters cannot import it (dependency direction). Putting the gate in the CLI command next to the mutex keeps both in one place (OpenClaw-CLI precedent). TODO next session: inventory ALL callers of `runCodexWorkspaceWorkerCycle`/`runWorkbuddyWorkspaceWorkerCycle` (`rg` across packages); if any production path bypasses the CLI command, reconsider. Companion spawns the CLI; managed-run spawns the CLI; manual is the CLI — expected answer: no bypass.

### Driver-aware state matrix — superseded by the RESOLVED matrix below (kept for history)

### Shadow-mode question — RESOLVED this session

`shadow-run.ts` header is explicit: shadow is an operator-invoked bounded REAL cycle on legacy-owned workspaces, and "Concurrency with the still-owning legacy consumer is converged by the EXISTING Durable Lease / fencing". So shadow coexistence with the legacy consumer is DESIGNED production behavior, converged by lease fencing — the gate must NOT block service_host on `legacy_owned`/`no_record`. Driver env detection is also resolved: `buildWorkerEnvironment` pins `PD_INVOCATION_SOURCE=service_host` (worker-env.ts line 241) plus `PD_INVOCATION_ID` into the spawned child; Companion marks itself via `PD_COMPANION_WORKER_IPC=1`; manual has neither. `codexWorkerCycleDriver()` (exported, codex-adapter workspace-worker.ts line 161) already implements exactly this detection — REUSE it (and the workbuddy equivalent) instead of new detection logic.

### Resolved three-layer convergence model (the design coherence argument)

1. **Ownership gate** = handover state-machine safety: legacy drivers (manual/companion) stop consuming once handover begins or completes (`handover_preparing`/`rollback_pending`/`service_host_owned`); service_host driver refuses the mid-transition states too (first managed cycle must postdate the CAS).
2. **Per-workspace mutex** = physical exclusion: no two overlapping cycles on one workspace+install regardless of driver or state.
3. **Durable lease fencing** (existing) = task-level convergence for the designed shadow window.

### Final driver × state matrix

| driver \ ownership | legacy_owned / no_record | handover_preparing | rollback_pending | service_host_owned | unreadable |
|---|---|---|---|---|---|
| manual | consume | REFUSE paused | REFUSE paused | REFUSE paused | degraded fail-closed |
| companion | consume | REFUSE paused | REFUSE paused | REFUSE paused | degraded fail-closed |
| service_host | consume (shadow-designed) | REFUSE paused | REFUSE paused | consume | degraded fail-closed |

TODO verify exact ownership state names: `rg "handover_preparing|rollback_pending" packages/pd-cli/src` — the preflight used these names informally; use the real enum from the ownership module.

### Refusal behavior in continuous mode

A gate-refused cycle in continuous mode should write the paused heartbeat/liveness (mirror OpenClaw `finalizeLiveness` mode paused), print the paused report, and CONTINUE looping (drain still works) — the resident worker must stay alive so that, e.g., a rollback that flips ownership back to legacy_owned resumes consumption without a Companion respawn. Verify this against handover expectations: during handover_preparing the legacy worker is supposed to be DRAINED+stopped by Companion anyway (quiesce), so resident-refused is mostly the manual/no-companion case.

### What this PR must NOT do (preflight constraints)

- No second lease/state machine/scheduler; reuse service-run-lock.ts as-is.
- No changes to the OpenClaw path behavior.
- No companion/handover orchestration changes (that's PR 4/5).
- No `--status` semantics changes (read-only paths stay no-consume).
- Non-consuming paths (`--status`) must NOT acquire the mutex or gate — they never consume.

## 3. Key file touch list (expected)

- `packages/pd-cli/src/commands/codex-worker.ts` — gate + per-cycle mutex wiring.
- `packages/pd-cli/src/commands/workbuddy-worker.ts` — same.
- Possibly a small shared helper inside pd-cli (e.g. `services/service-host/worker-consumption-gate.ts`) ONLY if both commands share the logic verbatim — follow P3/P7, no speculative abstraction; duplication of ~30 lines may be acceptable if semantics diverge per host.
- Ownership reader: find the shared workspace background-ownership reader (`rg readOpenClawWorkspaceOwnership` → likely wraps a host-neutral `readWorkspaceBackgroundOwnership` in pd-cli service-host or install-layout). Reuse it.
- Tests: `packages/pd-cli/tests/` — find existing worker command tests (`rg --files tests | grep worker`) and mirror their harness (fake spawn/env/temp PD homes). Red-first: prove a continuous/--once codex worker consumes while ownership is handover_preparing / service_host_owned today.

## 4. Test matrix (from preflight §7 PR 2)

1. manual/companion/service_host driver × ownership-state matrix (table above) for BOTH hosts.
2. handover_preparing / rollback_pending / service_host_owned → legacy driver never consumes (no cycle side effects — catch-up/reconcile must not run).
3. service_host driver consumes only per the resolved matrix.
4. mutex: concurrent `--once` while a cycle is in progress → second is paused, no dual consumption.
5. mutex: continuous worker per-cycle acquire/release — a drained worker holds NO lock between cycles (rollback can proceed).
6. ownership unreadable → degraded fail-closed, exit 1, no consumption.
7. `--status` untouched: no lock acquisition, no gate side effects.
8. OpenClaw worker tests stay green (no regression).
9. cli-1 exactly-one-JSON contract preserved on all new refusal paths.

## 5. Error Context routing (run at implementation start in the worktree)

`npm run error:context -- --paths packages/pd-cli/src/commands/codex-worker.ts,packages/pd-cli/src/commands/workbuddy-worker.ts,packages/pd-cli/src/services/service-host/locking/service-run-lock.ts --signals worker ownership mutex handover dual-consumer` — expected EP-09/EP-12 HIGH from prior rounds; re-run diff-mode before PR.

## 5.5 Verified facts — round 2 (implementation-ready)

1. **State enum CONFIRMED**: `BackgroundExecutionState` = `legacy_owned | handover_preparing | service_host_owned | rollback_pending` (packages/install-layout/src/background-execution-transition.ts). Read failures → `manifest_unreadable` with reason+nextAction.
2. **Reader CONFIRMED**: `readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir, platform?, realpath?, fsOps? })` exported from `@principles/install-layout` (background-execution-transition.ts line 734). No record → `{status:'legacy_owned', source:'no_record', generation:0}` — legacy default semantics built in. Handles owner-alias conflicts as fail-closed unreadable. pd-cli already depends on install-layout (codex-worker.ts imports from it).
3. **Caller inventory CONFIRMED — no CLI bypass**: production callers of `runCodexWorkspaceWorkerCycle` = only `pd-cli/src/commands/codex-worker.ts` (adapter package defines/exports it); same for workbuddy. The CLI-command-layer gate covers every driver.
4. **Test harness FOUND**: `packages/pd-cli/tests/commands/` — read `openclaw-worker-command.test.ts` (existing mutex/gate test reference) + `codex-worker-daemon.test.ts` + `workbuddy-worker-registration.test.ts` for harness patterns before writing red tests.
5. Driver detection: `codexWorkerCycleDriver()` exported from `@principles/codex-adapter` workspace-worker.ts line 161 — env-based (`PD_INVOCATION_SOURCE=service_host` / `PD_COMPANION_WORKER_IPC=1` / neither=manual); workbuddy equivalent in `@principles/workbuddy-adapter`. REUSE these.

## 6. Session state

- Worktree bootstrapped? NO — `npm install` / build NOT yet run in this worktree (run `npm run dev:bootstrap` or the documented bootstrap first next session; the p0-guard worktree has a working node_modules if a quick compile check is needed before bootstrap).
- No source files modified yet. Zero commits on the branch.
- PR #2810 (P0 guard) still OPEN, unrelated files — no rebase needed (different packages).
- LFS note: worktree was created with manual `git worktree add` because the dev:worktree script hard-fails on missing git-lfs in WSL; LFS files are pointers (same as all existing pool worktrees). Branch upstream was unset deliberately.
