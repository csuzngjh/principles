# PRI-1278 Phase 5 — PR 2 Consumer-Safety Substrate Report

> Codex/WorkBuddy worker ownership gate + per-workspace run mutex.
> Baseline: origin/main `a7a3479c64a7aae0840ba639a74c6468ff8c1369`.
> Branch: `ai/PRI-1278-phase5-p2-consumer-substrate`.
> Design investigation: `PRI-1278-PHASE5-P2-DESIGN-NOTES.md` (this worktree).

## 1. Problem (preflight §4/§7 PR 2)

Before this change, the Codex and WorkBuddy workspace workers had **no ownership gate and no per-workspace mutex** (the OpenClaw worker already had both, PRI-1282). Consequences:

- a Companion-supervised or manual legacy worker kept consuming governance tasks even after a Service Host handover began or completed — the dual-consumer hazard the whole Phase 5 migration is meant to close;
- nothing stopped two overlapping consumers (manual `--once` racing a resident continuous worker, orphan worker after a Companion crash) on the same workspace;
- handover/rollback could not use the workspace run mutex's holder-PID liveness to prove quiescence for these hosts.

## 2. Key architecture facts the design rests on (verified in source)

1. **All three drivers flow through the same CLI command**: manual (`pd <host> worker`), Companion (spawns continuous `pd <host> worker` with `PD_INVOCATION_SOURCE=companion` + `PD_COMPANION_WORKER_IPC=1`, pd-companion main.ts:471), Service Host (managed-run/shadow adapters spawn `pd <host> worker --once` with `PD_INVOCATION_SOURCE=service_host` pinned by worker-env.ts:241). Wiring gate+mutex in the pd-cli command layer therefore covers every driver — no adapter-package or Companion changes needed.
2. **Driver detection already existed**: `codexWorkerCycleDriver()` / `workbuddyWorkerCycleDriver()` (env-based, used for liveness attribution since PRI-1264). Reused as-is; `codexWorkerCycleDriver` newly re-exported from the codex-adapter package index (it was already exported for workbuddy).
3. **Shadow convergence is designed behavior**: shadow-run.ts documents that service-host-driven cycles on legacy-owned workspaces deliberately converge with the still-owning legacy consumer through durable-lease fencing. The gate therefore lets the service_host driver consume `legacy_owned` — blocking it would destroy the pre-handover validation path.
4. **Caller inventory**: the only production callers of `runCodexWorkspaceWorkerCycle` / `runWorkbuddyWorkspaceWorkerCycle` are the two CLI commands — no bypass.
5. **Mutex must be per-cycle**: handover/rollback quiescence proofs use the lock's holder-PID liveness and the drain protocol stops continuous workers *between* cycles; a process-lifetime lock would deadlock rollback. OpenClaw already works exactly this way.

## 3. Driver × ownership-state matrix (implemented)

| driver \ ownership | legacy_owned / no record | handover_preparing | rollback_pending | service_host_owned | unreadable |
|---|---|---|---|---|---|
| manual | consume | paused refusal | paused refusal | paused refusal | degraded, exit 1 |
| companion | consume | paused refusal | paused refusal | paused refusal | degraded, exit 1 |
| service_host | consume (shadow) | paused refusal | paused refusal | consume | degraded, exit 1 |

Refusals are structured: `legacy_consumption_blocked:<state>` / `service_host_consumption_blocked:<state>` / `<host>_owner_marker_unreadable:<reason>` with nextAction; a held mutex yields `<host>_worker_run_in_progress` (paused, **not** a failure exit — same as OpenClaw). No-record workspaces project `legacy_owned` (install-layout built-in default), so **pre-service-host behavior is unchanged** for every existing workspace.

## 4. Changes

- **NEW** `packages/pd-cli/src/services/service-host/worker-consumption-gate.ts` — shared gate evaluation + per-cycle mutex wiring over the *existing* `service-run-lock.ts` and `readWorkspaceBackgroundOwnership` (`@principles/install-layout`). Not a second lease/lock/state machine.
- `packages/pd-cli/src/commands/codex-worker.ts` / `workbuddy-worker.ts` — both `--once` and continuous modes run each cycle through the guarded path; gate re-evaluated every cycle (a handover can land while a continuous worker is resident); retention never runs on a refused cycle.
- `packages/codex-adapter/src/index.ts` — re-export `codexWorkerCycleDriver` (parity with workbuddy-adapter, one-line additive).
- Test harness alignment (5 existing files) — consuming-path tests now seed a valid isolated install manifest (`tests/helpers/isolated-pd-home.ts`), because ownership-unreadable intentionally fails closed and production always has `~/.pd/install.json`. No assertion semantics changed.
- **NEW** `packages/pd-cli/tests/commands/worker-consumption-gate.test.ts` — 19 regression tests.

## 5. Red/green evidence

- **Red**: with the pre-fix command files restored (patch reversed), the 6 command-wiring blocked-path tests fail — the consuming cycle runs unconditionally where the matrix requires refusal (`expected "vi.fn()" to not be called at all, but actually been called 1 times`), 12 failed / 7 passed overall. Raw output preserved in this session log.
- **Green**: with the fix applied, `worker-consumption-gate.test.ts` **19/19 passed**, covering: full driver×state matrix through real manifest reads, mutex acquire/release/held behavior, both hosts' `--once` wiring, exactly-one-JSON on refusal paths, paused-vs-degraded exit codes.

## 6. Regression evidence

- Existing worker tests after harness alignment: **41/45 passed**; the only 4 failures are the real-built-CLI child-process tests (`worker-drain-child`, workbuddy registration `--help` spawns) that **fail identically on the unmodified baseline worktree in this environment** — verified by running the same tests on `PRI-1278-phase5-p0-guard-20261127` (baseline pd-cli): same 4 failures. Root cause is environmental (WSL + slow `/mnt/d` mount makes real-CLI startup exceed test deadlines); CI Linux runners are authoritative for them.
- `openclaw-worker-command.test.ts` 10/10 — OpenClaw path untouched.
- `npm run build --workspace=@principles/pd-cli` PASS; `npm run typecheck` (pd-cli) PASS; targeted eslint PASS (0 errors).
- Full pd-cli suite, this branch: **123 failed / 2863 passed** (37 failed files of 212). Full suite, unmodified baseline worktree (same environment, same machine, run in parallel): **133 failed / 2834 passed** (45 failed files of 211 — the 19 additional tests on this branch are the new gate tests, all passing). The branch has strictly fewer failures than baseline despite adding tests; the failure body is pre-existing environmental noise (WSL + slow `/mnt/d` mount: real-CLI spawn deadlines, timing-sensitive suites such as `delivery-surfaces`). No failure intersects the worker-consumption surface except the 4 real-built-CLI cases proven environmental on baseline. CI Linux runners remain authoritative.

## 7. Error Context routing

Initial router: **HIGH EP-04** (real-entry evidence), **HIGH EP-02 / EP-03** (CLI contract / cross-package consumers). Diff-mode router before PR: **HIGH EP-04 (score 28), EP-02 (17), EP-03 (17), EP-09 (10)**; MEDIUM EP-06. Reconciliation:

- EP-04 (real production entry evidence): tests drive the real exported command handlers (`handleCodexWorker` / `handleWorkbuddyWorker`) with real manifest files on disk, the real `service-run-lock` file implementation and the real install-layout ownership reader — no source-string scans, no prose evidence.
- EP-02/EP-03 (CLI contract / cross-package consumer): exactly-one-JSON assertion on every `--json` refusal path; exit-code contract asserted (paused = 0, degraded = 1); the ownership projection is consumed through the install-layout authority, not reimplemented; `codexWorkerCycleDriver` re-export is a one-line additive parity change.
- EP-09 (test evidence quality): negative control proven red against the pre-fix state (§5: pre-fix command files restored → the blocked-path wiring tests fail because the consuming cycle runs unconditionally); positive assertions identify the intended path (adapter cycle mock `not.toHaveBeenCalled` on refusals plus paused-mode result shape), not absence-of-error-only signals. ERR-178 honored: harness-aligned pre-existing tests received real ownership manifests so they still exercise the consume path positively rather than passing vacuously through the new gate.
- EP-06 (medium): codex-adapter rebuilt before verification; no generated artifacts edited.

## 8. Deliberate scope exclusions (do not review as missing)

- No Companion supervision changes (keep-don't-spawn logic) — PR 4/5 territory.
- No handover orchestration, readiness, evidence-schema or CLI host-selection changes — PR 3/5.
- No ownership-gate inside the adapter packages — the lock lives in pd-cli by design and no production path bypasses the CLI commands (verified inventory).
- `--status` paths unchanged (they never consume and never touch the mutex).
- No liveness heartbeat on gate-refused cycles: a refused cycle produces no consumption evidence at all; the status surface already distinguishes driver/stall semantics and the resident loop keeps printing paused reports. Recorded as a possible refinement, not a gap in the safety property.

## 9. Residual risks

1. Gate-check → cycle-start is not atomic with the handover CAS (cooperative check); the hard guarantees remain lease fencing + quiesce protocol. Worst case is one in-flight cycle overlapping, exactly the drain protocol's existing semantics.
2. A continuous legacy worker blocked by the gate prints a paused report per interval until Companion supervision stops it (companion-side lifecycle is out of scope here).
3. Test isolation required the `PD_SERVICE_PD_HOME` pin in harnesses; production resolution order unchanged.
4. Real-built-CLI child tests cannot be validated in this WSL environment (pre-existing); CI must confirm.

## 10. Next-phase recommendation

PR 3 (host-attributed handover/evidence contract) and PR 4 (Companion Quiesce Ack strict protocol) per preflight §7. With this substrate merged, the drain/quiesce evidence for Codex/WorkBuddy gains real meaning because legacy workers now actually stop consuming — but handover for these hosts must still not be attempted before PR 4 lands.
