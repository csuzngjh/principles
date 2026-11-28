# PRI-1278 Service-Host-Only — Master Design & Disposition

> Integrates audit agents A (Companion), B (ServiceHost/ownership), C (adapters/workers), D (tests/installer — pending).
> This document is the implementation contract. Update as decisions are made.

## 0. Verified architecture facts (audit cross-checked)

1. **Service Host already covers all 3 hosts in managed mode**: dispatch serial per-workspace with shared budget (`workspace-dispatch.ts:69-115`), `MANAGED_WORKER_HOST_KINDS=[codex,workbuddy,openclaw]` (`worker-adapter.ts:55`), spawns `<active-release-cli> pd <host> worker --once --json` with pinned env (`worker-env.ts:241` PD_INVOCATION_SOURCE=service_host), bounded subprocess SIGTERM→5s→SIGKILL (`worker-process.ts`), evidence in service-run-status + shadow-progress-store (managed also merges, `managed-run.ts:538-558`).
2. **OS scheduler registration complete per-platform** (Windows TaskScheduler/macOS LaunchAgent/Linux systemd-user), single argv `service run-once --json --trigger scheduler` (`scheduler/contract.ts:118-133`). macOS/Linux not real-platform verified.
3. **OpenClaw legacy consumer is NOT Companion** — it's the Gateway in-process timer chain `internalization-auto-consumer-service.ts` (registered `openclaw-plugin/src/index.ts:973-974`, also per-workspace in before_prompt_build hook `:604-624`). It already reads ownership per-tick and parks on non-legacy states (`:223-235`). Gateway never spawns `pd openclaw worker`.
4. **`pd openclaw worker` already has the target end-state**: ownership gate — refuses to consume unless `service_host_owned` (`openclaw-worker.ts:443-452`) + per-workspace mutex for whole cycle (`commands/openclaw-worker.ts:191-217`) + no continuous mode at all.
5. **Codex/WorkBuddy workers have NO ownership gate and NO mutex in this tree** (PR #2811 adds them in parallel — coordination item). Their continuous mode exists ONLY for the Companion supervision model.
6. **Companion worker machinery**: `main.ts:457-485` spawn continuous worker w/ IPC; registries `main.ts:491-581`; `workspace-workers.ts` restart ladder/drain/release-handover; sync timer 60s; login-item autostart default ON (`main.ts:1311-1313`).
7. **worker-drain.ts IPC protocol is Companion-private** (`PD_COMPANION_WORKER_IPC=1` gated). Service Host never uses it. Dies with Companion.
8. **Lease/fencing/recovery is host-neutral and correct** (lease-manager CAS generation fencing, recovery-sweep embedded in every consumer cycle) — survives untouched. Recovery needs no migration: whichever runtime drives cycles drives recovery.
9. **Ownership transitions**: only `provision_fresh_install` survives. begin/complete/abort handover+rollback all die (workspace-handover.ts entire file, handover-claims.ts, `pd service handover/rollback` commands).
10. **host=none already works as template**: ownership CAS'd to service_host_owned, managed run reports waiting_for_host_binding truthfully, not a failure (`managed-run.ts:498-515`). Binding later needs no ownership change.
11. **host=all** = openclaw+codex at install (workbuddy deliberately excluded, `installers/index.ts`); runtime = ONE runtime with multi-adapter serial fan-out. Already correct shape.
12. **P0 guard pieces to delete** (§4.3 of directive): gateway-running→legacy_consumer_running branch (`service-host-provisioning.ts:595-608`), deferred-resume guardHosts/legacy_consumer_unproven (`:610-621`). resolveResumeProvisioningHost is already migration-independent — KEEP as host-resolution authority.
13. **Console detached `pd diagnose run`** (`diagnostician.ts:211-238`, detached+unref, PD_INVOCATION_SOURCE=console) — request-scoped bounded one-shot, lease-safe.
14. **pd-console never owns scheduler/workers** (explicit `routes/service-host.ts:7-10`) — already clean.
15. Companion coupling is process/protocol/copy, NOT package imports — no production package imports @principles/pd-companion.

## 1. Boundary decisions (made by main agent per directive; flagged for Owner review)

- **D1 Console supervision**: Companion KEEPS console-server launch/supervision (supervisor.ts, spawnCli, version-handover) — this is UI/control-plane process management, not background task execution. The directive's removal list is entirely about task/worker execution. Documented explicitly in final report.
- **D2 Console detached `pd diagnose run`**: KEEP as request-scoped Owner-triggered bounded one-shot (not a recurring consumer; lease-fencing makes it correctness-safe; it is the L2 manual ladder). Same logic keeps `pd diagnose run` / `pd runtime internalization run-once` manual CLI paths. Documented as explicit boundary decision.
- **D3 `pd codex/workbuddy worker` continuous mode**: DELETE outright — exists only for Companion supervision (Agent C recommendation, matches directive §1.3: workers only Service-Host-managed). `--once`/`--status` survive. `--once` consumes ONLY when service_host_owned (mirror openclaw gate) — wait, see D4.
- **D4 ownership gate simplification**: the new world has ONE ownership state that can consume: `service_host_owned`. Workers (--once) pause otherwise. This converges with PR #2811's gate but without the legacy/shadow matrix — the matrix collapses to: service_host_owned→consume; anything else→paused; unreadable→degraded. Manual invocation becomes safe-by-construction. Mutex per-cycle kept (mutual exclusion stays valuable).
- **D5 driver attribution**: `companion` driver value dies as a PRODUCER; readers keep interpreting historical `'companion'` records as "historical legacy driver" (not "restart Companion"). `PD_INVOCATION_SOURCE` remains attribution-only, never security boundary.
- **D6 Gateway auto-consumer**: DELETE the consuming timer chain entirely (not just gate-flip). Keep `persistOpenClawToolDeclaration` (host adapter capability). Rationale: directive §3.1 — no legacy execution code retained; lease-fencing means even a stale plugin version is correctness-safe though not convergence-clean. The ownership-gate logic in openclaw worker already prevents consumption unless service_host_owned.
- **D7 one-time switch**: the upgrade itself is the switch — installer writes new active release; Companion update/restart kills old worker children (they're its children); Gateway plugin reload drops old auto-consumer; new CLI has no continuous mode. Installer provisioning then flips ownership with verification step: no old-release worker processes alive. Sequence detail in §4.
- **D8 PR #2811 coordination**: leave open for Owner decision. If consolidation lands first, #2811's matrix is subsumed (D4 supersedes). Its mutex discipline survives conceptually and is re-implemented here in simplified form if needed. Note in both PRs.

## 2. Module disposition table (directive §2 format)

| Module | 当前职责 | 当前执行主体 | 目标执行主体 | 处理方式 |
|---|---|---|---|---|
| Scheduler trigger | OS-level run-once trigger | OS scheduler→Service Host | 同左(不变) | 保留 |
| Workspace discovery | manifest+claims discovery | Service Host | 同左 | 保留 |
| Task discovery/dispatch | per-workspace adapter fan-out | Service Host managed-run | 同左 | 保留 |
| Worker execution (3 hosts) | bounded `--once` spawn | Service Host adapters | 同左 | 保留 |
| Codex/WB continuous worker | resident consumption loop | Companion-spawned CLI | 不存在 | **删除** |
| Companion worker registry/supervision | spawn/restart/drain/IPC | Companion | 不存在 | **删除** |
| Companion worker release-handover | drain+respawn on release | Companion | 不存在 | **删除** |
| Gateway auto-consumer | in-process timer chain consumption | OpenClaw Gateway plugin | 不存在 | **删除**(保留 tool declaration persistence) |
| Handover/rollback machinery | migration state machine | pd CLI commands | 不存在 | **删除**(workspace-handover.ts/handover-claims.ts/commands) |
| Ownership CAS | generation-fenced transitions | install-layout | 同左,但只剩 provision_fresh_install | **简化** |
| Ownership states | 4-state migration enum | manifest | service_host_owned 唯一(+无记录=未 provision) | **简化** |
| Shadow mode | migration validation on legacy-owned | pd service run-once --shadow | 不存在 | **删除** |
| Pending provisioning | deferred install registry | installer | 保留,简化为 SH 初始化状态 | **简化** |
| Provisioning guards(legacy consumer) | P0 guard/gateway-running guard | installer | 不需要 | **删除**(directive §4.3) |
| worker-drain IPC | Companion-private drain | pd-cli+companion | 不存在 | **删除** |
| Lease/fencing/recovery sweep | task-level correctness | host-neutral core | 同左(不变) | 保留不动 |
| Per-workspace run mutex | physical mutual exclusion | openclaw worker only | all workers consuming cycles | **扩展**(对齐 #2811 简化版) |
| Console detached diagnose-run | Owner-triggered one-shot | Console | 同左(D2 boundary) | 保留+文档化 |
| Companion console supervision | console process lifecycle | Companion | 同左(D1 boundary) | 保留 |

## 3. Implementation phase plan

- **P0**: rebase branch onto e3ddf901d; resolve provisioning guard conflicts (much of it gets deleted anyway)
- **P1**: ownership model simplification in install-layout (state enum collapse; transition kinds reduction to provision_fresh_install only) + all readers/writers
- **P2**: worker command surgery — codex/workbuddy delete continuous+drain IPC, add service_host_owned gate + mutex to --once; delete worker-drain.ts; status copy rewrite
- **P3**: Companion surgery — delete worker spawn/registries/sync/worker-copy; keep console supervision; remove worker before-quit/restart copy
- **P4**: Gateway auto-consumer deletion (keep tool declaration); openclaw worker stays as-is
- **P5**: Service Host cleanup — delete workspace-handover/handover-claims/shadow mode/handover+rollback CLI; deny-list entries for PD_COMPANION_WORKER_IPC stay (cheap defense)
- **P6**: provisioning simplification — delete legacy-consumer guards, simplify pending registry, keep readiness+CAS+first-cycle+idempotency; installer one-time-switch verification
- **P7**: copy/status/docs updates across repo
- **P8**: test deletion/rebuild per agent D inventory; regression matrix
- **P9**: E2E real-run acceptance
- **P10**: report + PR update

## 4. One-time switch sequence (installer upgrade path)

TODO after agent D installer audit: exact integration points. Skeleton:
1. Installer writes new release (all packages incl. companion/plugin/cli)
2. Stop/restart Companion (new version never spawns workers) — verify no `pd * worker` continuous children of old companion alive (process scan)
3. Gateway plugin reload or ownership flip parks auto-consumer
4. Provision/flip all workspaces to service_host_owned (existing CAS path, idempotent)
5. Verify scheduler registered+enabled (fail-closed; no fallback)
6. First managed cycle proof-of-life
Constraint: no dual-consumer window — lease fencing is the backstop for any overlap seconds, but the sequence must verify old entries stopped BEFORE flipping ownership.

## 5. Test strategy (agent D integrated)

**Keep almost unchanged**: install-layout ownership/CAS/lock tests; managed-run admission tests (19); scheduler adapter tests; worker-env/process tests; shadow-real-cli integration (template for Phase 6); installer bridge tests; service-run-lock tests.

**Rewrite**: companion worker tests → sole-runtime negative guards (Companion NEVER spawns workers regardless of ownership state); worker driver attribution tests (remove `companion` as current driver; historical records still parse); provisioning resume tests (drop dual-runtime quiesce assumptions); companion BDD features → control-plane only.

**Delete after replacement**: positive companion spawn/restart/drain-IPC/restart-ladder tests; workspace-workers* tests; worker-release-* tests; ownership-transition companion tests.

**New regression matrix dimensions** (agent D §9.2): install state × consent × ownership state × runtime event × lifecycle. Key new tests: Companion never spawns; upgrade kills old runtime; no dual consumer possible; ownership admission only service_host_owned.

**E2E acceptance harness** (agent D §9.3): disposable HOME → install → scheduler artifact → status truthful → ownership provisioned → seed real task → trigger run-once → exactly-one execution → overlap convergence → disable → uninstall. shadow-real-cli.test.ts is the fixture template. Windows is the only real platform available here; macOS/Linux remain NOT_VERIFIED (pre-existing, documented honestly).

**Installer facts**: provisioning is post-commit (`installer.ts:7102-7233`), bridge-delegated, never fails committed install. Companion autostart is Electron-self-owned — installer never registered it. Uninstaller revokes scheduler before runtime deletion but does NOT touch Companion app/login-item (gap → the new Companion simply has no worker code, which closes the hole regardless of autostart).

## 5.5 Design decisions LOCKED (main agent, post-CAS-read)

- **OD-1 LOCKED — collapse the transition machine**: `provision_fresh_install` becomes the ONLY transition kind, redefined as `from: ANY state → service_host_owned`. Rationale: the no-history/quiesce enforcement existed to protect live legacy consumers; the consumer code itself is deleted repo-wide, so the protection is meaningless. Lease fencing covers the transient upgrade window. The installer (not the CAS) owns the stop-old-entries sequencing evidence. `freshInstall` proof flag deleted. begin/complete/abort handover+rollback kinds deleted with their record-shaping branches; their only caller (workspace-handover.ts) is deleted.
- **OD-2 LOCKED — enum stays parseable, binary consumption**: `BackgroundExecutionState` keeps all 4 values for old-manifest parsing robustness, but consumption admission is binary: `service_host_owned` or not. No new writes of non-service_host_owned states anywhere. `legacy_owned` no-record projection retained as "un-provisioned" semantics.
- **OD-3 LOCKED — drain protocol total removal**: worker-drain.ts deleted; continuous worker mode deleted; nothing needs drain — Service Host bounded children use the existing SIGTERM→SIGKILL ladder.
- **OD-4 LOCKED — worker admission gate**: codex/workbuddy `--once` gain the openclaw-style binary gate (consume only service_host_owned; unreadable → degraded) + per-cycle workspace mutex (simplified #2811 convergence). Manual invocation becomes safe-by-construction (paused).
- **OD-5 LOCKED — branch strategy**: implement on top of existing branch (no history rewrite). Merged origin/main e3ddf901d cleanly (PRI-1299 orthogonal). P0-guard commits stay in history; their code largely deleted in consolidation — net diff is what matters.

## 5.6 Implementation wave plan

- Wave 2 (parallel, disjoint packages): SA-1 install-layout transition collapse+tests; SA-2 pd-companion worker-machinery deletion; SA-3 openclaw-plugin auto-consumer deletion.
- Wave 3 (parallel): SA-4 pd-cli worker commands+service-host handover/shadow deletion+program.ts wiring; SA-5 create-principles-disciple provisioning simplification+installer switch verification; SA-6 codex/workbuddy-adapter+host-runtime attribution/copy cleanup.
- Wave 4: integration typecheck/build/lint loop (main agent), copy/docs sweep.
- Wave 5: test rebuild + regression matrix.
- Wave 6: E2E real-run acceptance + report + PR.

## 6. Open risks

- R1: stale OLD-version Companion/plugin on the Owner machine still running pre-upgrade — handled by upgrade switch (D7), not by code compat
- R2: macOS/Linux scheduler unverified on real platforms — pre-existing, documented
- R3: Windows detached worker descendants can outlive kill (worker-process.ts:132-139) — pre-existing, bounded-by-design acceptance
- R4: Console diagnose-run boundary (D2) is a judgment call — explicit Owner-review flag
