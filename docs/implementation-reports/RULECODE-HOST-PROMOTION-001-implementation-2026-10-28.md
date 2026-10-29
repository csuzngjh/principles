# SPEC-RULECODE-HOST-PROMOTION-001 v0.1 — Implementation Report (A→B→C)

- Date: 2026-10-28
- SPEC: `docs/specs/SPEC-RULECODE-HOST-PROMOTION-001-v0.1.md` (§11 R1 second-source review takes precedence and is honored throughout)
- Worktree: `D:\Code\_worktrees\principles\adhoc-20261028-rulecode-host-impl-f03f89` (branch `ai/adhoc-20261028-rulecode-host-impl-f03f89`, base `origin/main` `cca1d47a2`)
- Scope: engineering implementation + tests + regressions. **Not** a rule approval, not a live promotion, no production governance fact was created or edited.

## 1. What changed (smallest coherent change)

### A — Host resolution & capability authority (`packages/host-runtime/src/host-liveness-contract.ts`)

- `resolvePromotionHostLiveness` now routes **openclaw / codex / workbuddy / unknown / multi-host** explicitly. The pre-SPEC fork (`!effectiveKinds.includes('codex')` → OpenClaw contract) — the exact branch that mis-attributed a WorkBuddy-only workspace to OpenClaw — is gone.
- The OpenClaw historical default survives **only** for workspaces with no non-OpenClaw declaration or evidence (SPEC §4.2).
- `host_declaration_missing_for_configured_host` generalizes from Codex-only to **every known non-OpenClaw host**: durable `pain_events.host_kind` evidence without the matching declaration file fails closed (SPEC §4.3), never falls back to OpenClaw.
- Multi-host (effective union) stays `multi_host_promotion_ambiguous`; an unknown declared host (e.g. `trae`) fails closed `promotion_host_unsupported` (SPEC §4.4/4.5).
- New per-host contracts join the one existing authority (no registry, no second store): `CODEX_HOST_LIVENESS_CONTRACT` (`codex-v2@1`, tool aliases `Bash` — the real, evidence-locked Codex surface) and `WORKBUDDY_HOST_LIVENESS_CONTRACT` (`workbuddy-v1@1`, WorkBuddy's capitalized vocabulary). Per SPEC §11.2 these constants are only the mapping declaration — the readiness evidence chain is wired separately (below).

### B — Codex closed loop (evidence wiring)

- **Version binding** (`principles-core/.../openclaw-promotion-checks.ts`): `validateHostContract` now binds to the resolver's expected version (`expectedHostContractVersion`, default `openclaw-legacy@1` for existing callers). A shape-valid contract of the WRONG host fails `runtime_compatibility` — the false-capability guard PRI-813 Test F existed for, now expressed as version binding instead of "no Codex contract exists".
- **Shadow attribution** (SPEC B3/H05): `RuleHostEvaluatedEventData` carries optional `hostKind`; the shared gate stamps it on every live/shadow evaluation; the OpenClaw plugin stamps its own legacy and shared-path rows; `summarizeRuleCodeShadowEvents(entries, activationId, targetHostKind?)` counts **only the resolved promotion host's** samples — another host's rows and pre-attribution legacy rows count toward no host's threshold. Console (`getOwnerReview`) and CLI (`readShadowSummaryForActivation`) both pass the resolved host.
- Console/CLI pass `expectedHostContractVersion` from the same resolver call (one host interpretation everywhere, SPEC §4.7).

### C — WorkBuddy incremental closure

- `createWorkbuddyRuleContextProvider` (`host-runtime/src/workbuddy-rule-context-provider.ts`): a V2 provider over **WorkBuddy's own observable trajectory** (same-session `tool_calls` rows the shared afterToolCall path records), with the same cutoff/current-call exclusion discipline as Codex and honest `unavailable` reasons per fault class. **No designGate fact is supplied** — WorkBuddy has no design-gate attestation entry point, so `design_approval`-dependent rules suspend with the precise `rule_required_fact_unavailable` warning instead of borrowing Codex declarations (SPEC §6).
- The gate's V2 qualification branch generalizes from `hostKind === 'codex'` to `codex | workbuddy`, checking `ruleHostInputContract.hostKinds.includes(hostKind)` symmetrically (SPEC §11.3): a Codex-stamped artifact never auto-executes on WorkBuddy and vice versa; Owner approval + digest binding required on both.
- `workbuddy-adapter/src/pd-hook.ts` wires the provider (flag `rulecode_context_v2`), captures the post-decode hook epoch, and the stale "no provider" note becomes the precise `workbuddy_runtime_context_limited` boundary note.

## 2. Acceptance matrix H01–H18 (evidence tier per row)

Evidence tiers: **S** = automated unit/integration (repo), **I** = controlled-host integration (real built hook process, isolated workspace), **R** = read-only real-environment audit, **N** = NOT RUN (blocked on real client / governance authorization).

| ID | Verdict | Tier | Evidence |
| --- | --- | --- | --- |
| H01 five-way host resolution | PASS | S | `host-liveness-contract.test.ts` 15/15: empty/OpenClaw/Codex/WorkBuddy/unknown(`trae`)/multi-host each asserted, incl. exact contract + version |
| H02 WorkBuddy never inherits OpenClaw | PASS (red→green) | S | Red first: pre-change suite failed exactly on the WorkBuddy-misattribution assertions (2 failed). Green: workbuddy-evidence-without-declaration → `host_declaration_missing_for_configured_host`; openclaw.json+workbuddy evidence partial-declaration variant; declaration-unreadable case unchanged |
| H03 source vs installed packages/pins/loaded modules | PASS (audit) + installs pending release | R | `~/.pd/runtime`: core 1.297.4 / host-runtime 0.14.1 / workbuddy-adapter 0.2.14 / plugin(principles-disciple) 2.2.5. Codex plugin 0.2.10 hook entry exists (`~/.codex/plugins/cache/principles/principles-disciple/0.2.10/hooks/pd-hook.cjs`); `runtime-version.json` pins codexAdapter 0.6.0 / hostRuntime 0.14.1 / core 1.297.4 and the actually-loaded `${PLUGIN_DATA}/runtime/node_modules` matches all three. **This PR's changes are in none of the installs** (correct — delivery goes through the release/installer chain, SPEC §9) |
| H04 shadow "would block" → host still executes, correct attribution | PARTIAL: hook chain PASS (I), real-client honoring NOT RUN | I/N | WorkBuddy production-path suite: shadow qualification runs, host result stays permissive, `rulehost_evaluated` rows carry `hostKind`; Codex gate test asserts evaluations carry `"hostKind":"codex"`. A real Codex/WorkBuddy client session honoring `permissionDecision` was not driven this round |
| H05 old/other-host/duplicate/corrupt/stale samples never qualify | PASS | S | `host-promotion-attribution.test.ts`: OpenClaw + unattributed rows never satisfy a Codex threshold; digest tamper/size guards (existing gate tests) unchanged; 24h/20/3/1 thresholds untouched (`promotion-readiness-evaluator.ts`) |
| H06 tool classification on real inputs | PASS | S+I | Codex `Bash`/`apply_patch` mapping (existing alias-replay tests); provider test classifies Read/Write/Bash rows; WorkBuddy production suite exercises real frozen payloads |
| H07 not_approved blocks; approved/not_required allows | PASS | S | Existing gate design-approval dependency cases (shadow/approved/unapproved matrix); PRI-1019 precise exception preserved verbatim at gate L467-472 (§11.1) — not widened, not removed |
| H08 unknown / missing fact / revoked / binding mismatch / provider fault distinguishable | PASS | S | New provider suite: 8 fault classes (`workbuddy_rule_context_disabled`, `session_id_invalid`, `workspace_scope_mismatch`, `workbuddy_project_scope_unavailable`, `no_prior_session_history`, cutoff exclusion, partial-semantic unknowns, throw-free catch path); gate `contextFault` taxonomy unchanged |
| H09 refused write actually did not happen | PARTIAL: deny encoding PASS (I); real-client file-level proof NOT RUN | I/N | Controlled-host suites assert the deny output contract (WorkBuddy exit-2/permissionDecision paths; Codex encoder). Filesystem/Git-level non-occurrence under a real client session: not driven |
| H10 single rule + live composition + neutral probes | PASS | S | `host_liveness_composition` runs neutral probes over candidate + existing live artifacts for the resolved host's contract (now incl. `codex-v2@1`); version-binding tests prove wrong-host contract fails `runtime_compatibility` |
| H11 malicious all-deny rule cannot lock out-of-band controls | PASS | S+I | Global-pause gate branch (allow + warning), CLI/console deactivate/pause suites green (pd-cli 2108/2108 incl. runtime-activation); isolated rules do not auto-revive (safety store tests). Out-of-band path = host-neutral `pd` CLI / Web Console (contract-declared) |
| H12 digest/controlVersion change between confirm and commit → refusal | PASS | S | Existing `promotion_snapshot_stale` + `expectedControlVersion` tests (unchanged); new wiring does not bypass them |
| H13 unapproved → no live; cross-host old artifacts; approval digest binding | PASS (new symmetric cases) | S+I | Gate: Codex-stamped artifact on WorkBuddy host → `workbuddy_rule_context_v2_unqualified` (new symmetric test); WorkBuddy adapter integration: unstamped artifact refused; stamped+approved+digest-bound artifact reaches the provider path. Approval digest binding asserted on both hosts |
| H14 OpenClaw production regression | PASS (suite) — on-machine native not re-run this round | S | openclaw-plugin 2296 passed / 13 skipped. 5 environment failures reproduced as diff-independent: 2× EPERM rmSync cleanup race, 2× real `~/.codex/pd-workspace` leaking into workspace-resolver tests, 1× GNU-tar Windows path mangling — none are assertion failures on changed code (see §4) |
| H15 Codex native vs WorkBuddy native concluded separately | DONE (this matrix) | — | Both real-client native tiers: **NOT RUN** — no live Codex/WorkBuddy client session was driven this round; engineering paths for both are complete and tested at S+I tier |
| H16 the 52d98a96 artifact gets same-digest evidence on the real host | NOT RUN (this round) | N | Threshold accumulation (≥20 observed / ≥3 matched / ≥1 neutral / ≥24h) was not re-executed; the attribution pipeline now counts only same-host same-artifact samples, so accumulation can begin after install. No rule-specific special-casing exists (generic pipeline) |
| H17 one non-design-approval principle validates the shared mechanism | PASS (structural) | S | Provider available-context test (no designGate fact) + gate "runs qualified shadow V2" (no `requiredFactKinds`) + evaluator-side `required_fact_contract_unsupported` guard (non-design facts rejected at generation) — the shared path does not special-case design_approval |
| H18 post-promotion controlled read/write + emergency stop | NOT RUN (governance-gated) | N | Live promotion requires an Owner decision on the current artifact snapshot; code paths (promote/pause/deactivate/recover) are green in S tier. Delivered at the reviewable entry only |

## 3. Segment conclusions

- **A (host resolution)**: complete — H01/H02 at S tier, Console/CLI consumers run the same resolver interpretation (EP-02 exercised: pd-console 2983/2984*, pd-cli 2108/2108, both adapters, openclaw-plugin suites).
- **B (Codex)**: engineering loop complete (contract + version binding + shadow attribution + readiness wiring + symmetric qualification). Native (real client) verification NOT RUN — blocked on a real Codex session; nothing was claimed beyond that.
- **C (WorkBuddy)**: provider + symmetric qualification complete at S+I tier; design-gate attestation intentionally absent → `design_approval` rules suspend precisely (SPEC §6 "C may stay incomplete"). Native NOT RUN.

*1 "expected fail" is the suite's own declared expectation.

## 4. Pre-existing / environmental failures (evidence per AGENTS §25)

- `workbuddy-adapter/tests/workbuddy-bdd.test.ts` "Real tool failure becomes background governance work": fails with `400 {"message":"Requested model DeepSeek-V4-Flash-Vision-Exp not supported"}` from the AMD gateway. **Reproduced on the clean HEAD baseline** (changes reverted → rebuild → same failure; evidence preserved in worktree `.tmp/baseline-verify/`). Machine has `AMD_RADEON_API_KEY` set so the scenario runs instead of skipping; the gateway dropped the model.
- openclaw-plugin: 2× EPERM on `fs.rmSync` cleanup (Windows race, assertions already passed), 2× workspace-resolver tests reading this machine's real `~/.codex/pd-workspace` (dev-machine artifact leak, ERR-083 class), 1× tarball test GNU-tar Windows path mangling (`D\:\\…` escaping). None touch changed code paths.

## 5. Test totals (this worktree, this diff)

| Suite | Result |
| --- | --- |
| host-runtime (incl. new liveness matrix, provider suite, gate v2 +14) | 581+8+1 = 590 passed |
| principles-core activation/__tests__ + runtime-v2 | 3718 + 6 new = 3724 passed |
| codex-adapter | 355 passed / 1 skipped |
| workbuddy-adapter (excl. env-failing BDD file) | 165 passed incl. 2 new SPEC scenarios (full file: 1 env failure, §4) |
| openclaw-plugin | 2296 passed / 13 skipped / 5 env (§4) |
| pd-console | 2983 passed / 1 expected-fail |
| pd-cli | 2108 passed |

## 6. Complexity Delta

New source of truth: **NO** (per-host contracts extend the one existing authority; no capability DB). New persisted state: **NO** (event `hostKind` is an optional additive field on an existing JSONL event). New subsystem/background process: **NO**. New public abstraction: minimal — `createWorkbuddyRuleContextProvider` + two contract constants + optional `expectedHostContractVersion`/`targetHostKind` parameters (all defaulted, backward compatible). New feature flag: **NO** (reuses `rulecode_context_v2`). New cross-package dependency: **NO**. New host-specific behavior: the two contracts + provider (the real variation axis SPEC §10 expects). New external/network capability: **NO**.

Rollback: revert the PR (single revert); behavior returns to the pre-SPEC resolver fork. Rules are untouched; shadow history and approvals are preserved; no governance data written.

## 7. Owner decision objects (no action fabricated)

1. **Merge this PR** — engineering only; nothing goes live by merging.
2. **Release + install chain** (changeset included; runtime pins refresh via the existing pins-maintenance flow) — required before any native verification of THIS code.
3. **Native verification** needs a real Codex and a real WorkBuddy client session against an isolated project (H04/H09/H16/H18 native halves).
4. **Live promotion** of artifact `pi-rule-evaluator-52d98a96…code_tool_hook_3` remains an explicit Owner decision in the Web Console on a current readiness snapshot — intentionally not exercised here.

---

# Round 2 — 三项代码评审发现修复（2026-10-29）

评审对象 HEAD `29ee5d69d`。三项根因、修复与红绿证据如下；被推翻的旧结论在本节末尾更正。

## 发现一（P1）：能力声明不能替代真实恢复检查

**根因**：`emergency_controls = 合同形状有效 && safetyControlsEnabled`；中性探针只做规则回放，从不验证控制入口真实存在。三份合同（含被本轮复制的 OpenClaw 旧合同）声明了**不存在**的命令——盘点证实：`pd status`（裸）不存在（真实状态面是 `pd activation list`）；`pd activation emergency-pause` **不存在任何 CLI 命令**（全局暂停唯一真实入口是 Console 路由 `POST /api/v1/activations/emergency-pause` → `pauseAllRuleCode` → `pauseAllLive`）；`pd activation deactivate --activation-id` 存在。另发现 OpenClaw 探针用小写 `bash`，而 OpenClaw hook 面真实 shell 工具是 `exec`（PRI-741：bash/exec_command 是 config 别名，永不达 hook）。

**修复**（复用既有机制，无新能力数据库）：
1. core 新增 `RECOVERY_CONTROL_SURFACES` 注册表（`recovery-control-surfaces.ts`）——每能力的**真实**入口面 SSoT：pd_status→CLI `pd activation list --json`；rulecode_deactivate→CLI `pd activation deactivate --activation-id recovery-probe`；rulecode_global_pause→Console `/api/v1/activations/emergency-pause`（虚拟工具探针，不伪造 shell 命令）；owner_review_access→Console owner-review 路由。
2. `validateRecoveryControlSurfaces` 校验合同探针与注册表逐项一致（命令串精确相等；console 通道必须用其虚拟工具+空参数）。
3. `emergency_controls = 合同 && safetyControls && 注册表校验通过 && 探针组合回放通过`，reasonCode 区分 `recovery_control_probe_mismatch` / `recovery_control_surface_unregistered` / `control_probe_composition_failed` / `safety_controls_disabled`。合同只声明映射，不再单独签发"能力健康"。
4. 跨包注册证明（生产接线证据）：pd-cli 新测试以**构建产物**验证注册表两条 CLI 命令真实注册、且 `activation emergency-pause` 未注册（负例）；pd-console 新测试驱动**真实路由处理器**：`/emergency-pause` 写入 gate 实读的 `global_rulecode_pauses` 行，owner-review 路由非 404。无破坏性探针执行（要求 7：readiness 从不执行暂停/停用，只做注册证明+回放组合）。
5. 健康证据绑定：注册表校验每次 readiness 现算（无缓存）；digest/controlVersion 绑定沿用既有 promotion 链（H12 未动）。

**红→绿证据**（`host-promotion-attribution.test.ts`）：红=旧实现下 `FABRICATED_COMMANDS_CONTRACT`（形状正确+开关开+伪造命令）emergency 通过（修复后 FAIL `recovery_control_probe_mismatch`）；组合阻断（候选中性+live 拦截全部 shell 调用）→ FAIL `control_probe_composition_failed`；开关关 → `safety_controls_disabled`；注册表验证+组合通过 → PASS。Console Test G 修复后三检查 PASS（fixture 对齐真实 exec 词汇后探针真实回放，`canActivate` 实证 ok）。

## 发现二（P1）：WorkBuddy 历史缺少宿主归属证明

**根因**：`tool_calls` 无宿主列；provider 按 sessionId+projectDir+cutoff 读取，无法证明行来自 WorkBuddy。同治理工作区跨宿主 session id 碰撞时，Codex 的 Read 会被当作 WorkBuddy 已读目标（priorReadOfTarget=yes）错误放行"读前写"规则。

**修复**（最小生产者—存储—读取链，不在 reader 贴标签）：
1. **存储**：`tool_calls` 增 `host_kind TEXT`（core `trajectory-schema.ts` 基础 schema + 加法迁移，同 tool_use_id/project_dir 先例；旧行保持 NULL，**不回填**）。
2. **生产者**（三个写入点全盖章）：共享 afterToolCall 写入器（`production-pain-evidence.ts`，`options.hostKind`，Codex/WorkBuddy hook 均传入）；`recordVerifiedToolOutcomes`（新增 hostKind 参数，Codex ingestion 传 `'codex'`）；`governance-signal-admission` 准入写入（`candidate.hostKind`）。
3. **读取**：`readWorkspaceRuleContextRowsBefore` 增可选 `hostKind`——按行分区（匹配/他宿主/无归属），列缺失的旧库整体视为无归属；从不猜测。
4. **Provider 严格失败关闭**：窗口含他宿主行 → `workbuddy_history_attribution_conflict`；含无归属行（纯旧或混合）→ `workbuddy_history_attribution_unprovable`（消费子集会**低估** prior reads，方向性不安全，故精确暂停）；仅全为 workbuddy 行才计算。gate 警告现带出 provider 精确原因（`history_unavailable:<reason>`）。
5. **通道契约补全**：WorkBuddy PostToolUse 通道（失败走独立 PostToolUseFailure 注册）的字符串响应按宿主契约分类为完成 success（信封 `{toolResponse}` 原文无损）——否则真实 WorkBuddy 成功行永远 `unknown`，provider 永不可用。他通道字符串语义不变。
6. PRI-1019 例外（gate L467-472）原样保留，未扩大未删除。

**红→绿证据**：provider 单测红 3（codex 行/无归属行/无列旧行 均曾被当作 WorkBuddy 历史得到 priorReadOfTarget=yes）→ 修复后全部精确 unavailable。**生产接线测试**（workbuddy-adapter，真实构建 hook 进程）：真实 PostToolUse 经共享生产者写入 → DB 行实证 `host_kind='workbuddy'` → 合格 v2 工件在下一次 PreToolUse **真实执行**（deny 输出，非暂停）；同 session 插入 codex 行 → 暂停+精确冲突原因浮出 stderr。

## 发现三（P2）：异常事件绕过宿主过滤

**根因**：`rulehost_unhealthy` 分支位于 hostKind 过滤之前，外宿主异常计入目标宿主 errors（errors>0 直接 fail runtime_shadow_evidence——反向也可被利用：他宿主异常阻塞本宿主上线；本宿主异常被他宿主摘要忽略）。

**修复**：`summarizeRuleCodeShadowEvents` 将归属过滤提到所有事件类之前（含 unhealthy）；本宿主真实异常仍计数（未整体忽略）；无 target 参数的历史语义不变。Console 与 CLI 均经同一函数消费（`getOwnerReview`/`readShadowSummaryForActivation` 已传 resolved hostKind——同一口径）。

**红→绿证据**：任务书复现器（workbuddy unhealthy + codex target）红（errors=1）→ 绿（errors=0）；无归属 unhealthy 指定宿主=0；本宿主 unhealthy=1；无目标参数旧语义=1；外宿主样本+异常混合不影响目标阈值输入（5 用例全绿）。

## 被推翻/修正的旧结论

1. 旧报告 §2 H11 行"Out-of-band path = host-neutral pd CLI / Web Console (contract-declared)"——**部分不实**：全局暂停无任何 CLI 入口，仅 Console 路由（本轮已实证并写入注册表；CLI 侧 emergency-pause 为 follow-up 候选，未实现即未声明）。
2. 旧 §1 B 段"neutral probes replay"描述曾暗示控制面可用——探针命令彼时含两个不存在命令与一个不可派发工具名，回放在真实语义下必然失败（Test G 旧绿是被旧 emergency 逻辑掩盖）。现合同面=真实面。
3. 旧 §2 H04/H05"WorkBuddy 影子事件正确归因"结论保留，但新增：WorkBuddy 影子样本现需生产者盖章行才可积累历史（旧行不可证明）。
4. H03 安装面结论不变（本轮亦未触碰任何安装目录）。

## Round 2 测试总量（本 diff）

core runtime-v2 7838 绿（+barrel 快照更新）；host-runtime 593 绿（+R2 provider 3 红→绿 +R1 wiring）；codex-adapter 355 绿；workbuddy-adapter 79 绿（host-contract 45/45 + production 16/16 含 2 新接线）；pd-console 2987+1 绿（含新注册表路由 4/4 与 Test G 修复）；pd-cli 2112 绿（含新注册表 CLI 4/4）；openclaw-plugin 环境失败集不变（4 例，与改前同名单）；owner e2e 6/6。BDD AMD 网关 400 仍为既有环境失败（前轮已基线复现）。
