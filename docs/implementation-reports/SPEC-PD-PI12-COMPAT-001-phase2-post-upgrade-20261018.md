# SPEC-PD-PI12-COMPAT-001 — Phase 2 升级后验收报告（PD 2.3.7 / Pi 1.2.0）

- 日期：2026-10-18
- 执行者：ZCode（一次性自主验收，无运行中交互）
- SPEC：`docs/specs/SPEC-PD-PI12-COMPAT-001-v0.2.md`（origin/main `aee538012`）
- 验收对象：本机已安装 PD 2.3.7（Pi 1.2 迁移已随 PR #2070/#2071 进入生产安装）
- 本轮边界：**零安装/零升级/零发布/零付费模型调用/零生产写入**；仅只读核查 + 独立 worktree 隔离测试
- 第二轮独立复验：同日 08:40–08:47 本地（00:40–00:47Z）完成，全部关键事实重取证、308 例隔离回归重跑全绿；**新发现升级后插件/证据面已出现真实生产流量（无异常）**，详见 §11
- **Phase 3 勘误（2026-10-18，随 SPEC-PD-PI12-COMPAT-001 Phase 3 PR 入库）**：§11.2 两处细节已修正——①五会话实际记录数为 40、63、64、72、81（原稿"40–72 条/会话"低估最大会话；合计 320 与当时总数精确吻合）；②该 320 条全部为 `submitted`/`attempted` 的**投递尝试留痕**，不构成 Agent 遵循原则或行为改善的证据。两处修正均经 Phase 3 独立只读快照复核。其余裁决与 308/308 历史验证记录维持不变，未做第三轮全量复跑。

---

## 0. 七项裁决（总览）

```text
INSTALLATION        : VERIFIED
RUNTIME HEALTH      : PASS（范围=服务面+状态面+插件/证据面[第二轮起有升级后真实流量、无异常]；Pi 模型面仍零样本）
PI 1.2 REGRESSION   : PASS（隔离证据：生产同源 commit aee538012 上 308 用例 0 失败，两轮复现）
AC-6 REAL LLM       : NOT_RUN（授权开关缺席，见 §4 与 §11.5；≠ OWNER_WAIVED）
IAER ISOLATED       : PASS（两轮复现）
IAER REAL PILOT     : NOT_RUN（升级后 Pi 模型路径零生产活动；插件/证据面已有流量但不经 Pi；存量积压为升级前已知态）
DEPLOYMENT VERDICT  : KEEP（证据范围见 §8；KEEP 不代表 AC-6 已过或已有生产 Pi 1.2 模型流量）
PRODUCTION ACCEPTANCE: CONDITIONAL GO（=KEEP；条件见 §11.7：AC-6 授权/豁免 + Pi 模型面首流量复核）
```

Owner Review Card（摘要）

1. **Problem**：Pi 1.2（2.3.7）已装生产，需确认无明显回归、补齐真实 Agent 验收并给出保留/回滚裁决。
2. **Before**：2.3.6（`c46eed2e`，core 1.293.1，Pi 0.85.1），最后生产 Pi 运行停留在 2026-10-17T08:38Z。
3. **After**：无产品行为变更（本轮纯验收）。确认 2.3.7 安装一致、服务面健康、隔离回归全绿、回滚链完整。
4. **Existing mechanism reused**：pi12-spike 套件、适配器契约测试、consumer-cycle/恢复套件、升级事务日志、release backups、rollback-policy/data-compatibility 合同。未新增任何机制。
5. **Complexity Delta**：全部 NO（零生产写入、零新抽象、零 flag、零依赖变化；新增物仅为本报告与 `.tmp/pi12-phase2/` 快照）。
6. **Design reason**：验收任务，最小动作=只读取证+复用既有测试面。
7. **Verification**：见 §2/§3/§5/§6 证据表。
8. **Risk**：生产 Pi 1.2 尚无真实流量样本（机器静默）；AC-6 未执行；两例升级前 stale run 待 Owner 处置。
9. **Rollback**：见 §7 完整预案（备份在盘+保留发行+资产 200+零数据面变更）。
10. **Follow-ups**：见 §9。

---

## 1. PD 2.3.7 真实安装与依赖证据（INSTALLATION: VERIFIED）

`~/.pd/active.json`（读取于 2026-10-18 00:5x 本地）：

| 字段 | 值 | 与任务基线 |
|---|---|---|
| generation | 46 | ✓ |
| releaseId | `995e4e48b54fd76de94f6820f96e7ae4b5a510869c3d48ae602ed36697a76d55` | ✓ |
| previousReleaseId | `c46eed2e6847e61db835f259467cd8c3ccb3a465d16a60bc1bac3da85e191077`（2.3.6） | ✓ |
| productVersion | 2.3.7 | ✓ |
| sourceCommit | `aee5380128196cf164136f8d6d5d5f01b68acb7c` | ✓（= 本轮 `git fetch` 后 origin/main HEAD，#2071 head） |
| transactionId | `update-1792253128873-2b81a796` | ✓ |

升级事务日志 `~/.pd/transactions/update-1792253128873-2b81a796.jsonl`：完整七态链
`planned(16:05:30Z) → downloaded(16:10) → verified(16:12, 整载荷摘要) → staged(16:16) → probed(console@3105) → activated(16:16:42) → confirmed(16:17:19, "previous release retained; older sets pruned")`，签名通道来源 `releaseMetadataDigestSource=signed_channel`。**升级窗口（本地）= 2026-10-18 00:05–00:17，本文一律以 confirmed 时刻 00:17 划分前后。**

已安装模块（`~/.pd/runtime/`，实测 package.json）：

| 模块 | 版本 | 任务基线 |
|---|---|---|
| @principles/core | 1.293.4 | ✓ Core 1.293.4 |
| principles-disciple（plugin） | 2.1.8 | ✓ Plugin 2.1.8 |
| @earendil-works/pi-ai | **1.2.0**（core/console/codex-adapter 三处 node_modules 实际解析一致；另有 typebox 1.3.27、pi-telemetry 1.3.0 传递） | ✓ Pi AI 1.2.0 |
| @earendil-works/pi-agent-core | **1.2.0**（同上） | ✓ Pi Agent Core 1.2.0 |
| @principles/pd-cli | 1.158.0 | —（CLI 自报 `Principles Disciple 2.3.7 (995e4e48b54f)` ✓） |
| @principles/pd-console | 0.1.0 | — |
| @principles/host-runtime | 0.10.2 | — |
| create-principles-disciple（release-manager） | 1.145.8 | — |
| codex-adapter / workbuddy-adapter | 0.5.7 / 0.2.3 | — |

稳定通道 `~/.pd/channels/stable.json`：version 22 / sequence 22 / 同 releaseId / 2.3.7，未过期（2027-01-15）。

## 2. 更新后运行状态与遥测（RUNTIME HEALTH: PASS，范围限定）

**服务面（升级后已随新 runtime 重启且存活）**：

- Console：`127.0.0.1:3101` LISTENING，PID 17564，命令行 `~/.pd/runtime/console/dist/server.js --workspace D:\.openclaw\workspace --port 3101 --host 127.0.0.1`，**启动于 00:21:26（升级完成后 4 分钟）**；`/` 返回 200；`/health` 为 404（该版本无此路由，非异常）。
- 认证边界：未带凭据 `GET /api/update/history` → **401 unauthorized**（Bearer 校验生效；生产 API 受保护边界完好。本轮未使用任何受保护 API，治理状态改由 state.db 快照只读取证）。
- Gateway：`127.0.0.1:18789` LISTENING，PID 71624，**启动于 00:22:22**，`GET /` 200。任务快照所述"18789 未监听"为观测时点差异，当前为存活状态，无故障判据；本轮未对 gateway 做任何操作。
- 插件壳：`~/.openclaw/extensions/principles-disciple/` 于 00:14 重建（dist/node_modules/templates），`core -> ~/.pd/runtime/core/` 符号链接正确，包版本 2.1.8；工作区 `.pd/host-tool-semantics/openclaw.json` 于 00:38 刷新（插件重新注册工具语义）。
- 环境注记：`198.18.0.1:3101` 另有本机代理进程（fake-IP 网段）监听，与 PD 无关；解读端口时以 `127.0.0.1:3101` 为准。

**状态/遥测面（生产工作区 `D:\.openclaw\workspace\.pd\state.db` 的 `.tmp` 快照，只读）**：

- schema_version 仍为 000/001/002（2026-09-01 应用）——**Pi 1.2 升级未伴随任何数据库迁移**。
- 升级后窗口（≥2026-10-17T16:17:19Z）：runs=0、tasks 更新=0、pi_artifacts=0、pain_diagnoses=0、approvals=0、activations=0、干预证据=0。即**升级后生产管线完全静默（无真实流量样本）**——服务健康证据来自服务面重启存活 + 隔离测试，不来自生产流量。
- 无升级后异常重试/无限循环/系统提示词丢失/工具调用异常事件；`dead_letter_pains=0`；`global_rulecode_pauses=0`。
- `~/.pd/enforcement-health/` 最新 degraded 记录 2026-10-17 15:33（本地），**全部来自 vitest 测试沙箱**（`reason: activation_db_not_found`，workspaceDir 指向 `.pd-test-temp`），非生产工作区，且无升级后新增。
- 产品遥测 `~/.pd/product-telemetry.json`：最近一次 workspace 导出 2026-10-17T01:11Z 成功（升级前，正常节奏）。
- Codex / WorkBuddy 工作区 state.db 最后写入分别为 10-17 15:28 / 19:45（本地，均升级前）——同样静默，无异常。
- 治理存量（升级前已知的稳态，无升级后变动）：approvals pending 32（已批 23/拒 2）；principle_candidates pending 29；rollout_reviewer `needs_human_review` 21；artificer 任务 pending 37 / failed 83（IAER 存量积压，见 §5）。

## 3. Dreamer / Artificer / One-shot 隔离回归（PI 1.2 REGRESSION: PASS）

**环境**：独立 worktree `D:\Code\_worktrees\principles\adhoc-20261017-pi12-phase2-postupgrade-405469`（branch `ai/adhoc-20261017-pi12-phase2-postupgrade-405469`，**base = 生产 sourceCommit `aee538012`**，`dev:worktree` 自举 READY L1–L3，锁解析 Pi 1.2.0）。零网络/零付费调用（spike 走 `registerFauxProvider`）。

| 包 | 套件 | 用例 | 结果 |
|---|---|---|---|
| principles-core | `pi12-spike-dreamer.test.ts`（SystemMessage 前置、单 user 消息、submit 终止、轮上限、预算 Abort、L1 fallback 恰一次） | 5 | PASS |
| principles-core | `pi12-spike-artificer.test.ts`（四工具白名单外 isError、validator 拒绝回路、无 L1 回退、失败即停、timeout 分类） | 5 | PASS |
| principles-core | `pi12-spike-oneshot.test.ts`（completeSimple、JSON Schema、callCount 精确钉） | 4 | PASS |
| principles-core | `l2-agent-loop-adapter.test.ts`（Dreamer L2 契约：空 messages、finishTurn error/aborted 守卫先于计数、system 直通） | 25 | PASS |
| principles-core | `artificer-l2-adapter.test.ts`（Artificer L2 契约） | 34 | PASS |
| principles-core | `pi-ai-runtime-adapter.test.ts`（One-shot：schema 分发、超时、自管重试、修复回路、Usage） | 139 | PASS |
| principles-core | `pd-stream-simple.test.ts` | 2 | PASS |
| host-runtime | `internalization-consumer-cycle-{artificer-evidence,artificer-intent,evaluator-telemetry,fairness,language,per-agent-profile}.test.ts` + `single-task-recovery-evidence-gate.test.ts` | 31 | PASS |
| pd-cli | `runtime-recovery{,-failed-task,-failed-tasks}.test.ts` + `artificer-evidence-audit.test.ts` | 63 | PASS（见注） |

- core 小计 214/214（9.4s）；host-runtime 31/31（10.7s）；pd-cli 63/63。
- 注（非回归，已闭环）：pd-cli 首轮 62/63，唯一失败 `guidance matches real command registrations (help wiring contract)` 因**新 worktree 自举未产出 `pd-cli/dist/index.js`**（该 cli-7 用例 shell 出真实 CLI；属已知自举缺口，与 Pi 1.2 无关）。在 worktree 内 `npm run build -w @principles/pd-cli` 后复跑该文件 **13/13 全绿**。已列入 §9 follow-up。
- 未扩大到全量（core 8530 全量在 Phase 1 @ f4ad1c836 已两连绿，且本轮目标面零回归，按任务书"只有发现回归时才扩大"执行）。

任务书 Phase B 对照：Dreamer 全项 ✓（spike+契约）；Artificer 全项 ✓（spike+契约+consumer-cycle）；One-shot 全项 ✓（139 用例含 Timeout/Retry/Usage/ToolCall）；IAER 四项 ✓（见 §5）。

## 4. AC-6 真实 LLM E2E：NOT_RUN（未执行，非豁免）

- 机制（已核实就绪）：`packages/principles-core/src/runtime-v2/__tests__/fixtures/llm-e2e-config.ts` — 需 **`LLM_E2E_ENABLED==='true'`** 显式 opt-in，且提供 `LLM_E2E_API_KEY`（或 `SENSENOVA_API_KEY`，默认 provider sensenova / deepseek-v4-flash / 120s / maxRetries 2）。
- 环境事实：本会话 `LLM_E2E*` 变量数 = **0**（开关未设）；`SENSENOVA_API_KEY` 存在（仅记存在性，未读取值）。即**钥匙在、开关没开**。
- 裁定依据：任务书明令"不得把本地 AI 自行决定当成 Owner 已授权"；自行设置 `LLM_E2E_ENABLED` 即等于自我授权，禁止。SPEC AC-6 状态机仅允许 NOT_RUN/PASS/OWNER_WAIVED，本轮维持 **NOT_RUN**（≠ OWNER_WAIVED，生产切换前仍需二选一）。
- 解锁条件（供 Owner 决策）：授权执行 = 以 `LLM_E2E_ENABLED=true`（+既有 key）运行三例（Dreamer submit_output 全链 / Artificer validate→replay→submit / One-shot json_schema），固定模型、调用上限与费用上限，记录请求次数/Token/费用/轨迹；或 Owner 明示豁免记 OWNER_WAIVED。

## 5. IAER：隔离 PASS / 真实 Pilot NOT_RUN

**隔离闭环（Owner Evidence → Artificer L2 → Validator → Replay → Evaluator）— PASS**：

- `internalization-consumer-cycle-artificer-evidence.test.ts`（10）：**缺 Owner Evidence 时零模型调用**（构造前 preflight）、三态证据门；
- `single-task-recovery-evidence-gate.test.ts`（3）：单任务恢复证据门；
- `internalization-consumer-cycle-artificer-intent.test.ts`（5）：PRI-995 意图门；
- `internalization-consumer-cycle-evaluator-telemetry.test.ts`（3）：Evaluator 证据关联/遥测；
- pd-cli `runtime-recovery*`（48）：恢复幂等（dry-run/confirm 互斥、exhausted 不误恢复、并发修改 null 优雅）、per-kind nextAction、审批边界不动；
- pd-cli `artificer-evidence-audit.test.ts`（15）：run/artifact/task 关联审计（`succeeded_artifact_then_failed` 等口径）。
- 全部使用隔离临时 SQLite 工作区（`.pd-test-temp`），未触碰生产库/生产 Owner Evidence/RuleCode。

**真实 Pilot — NOT_RUN**：

- 升级后窗口生产库 IAER 相关活动为 **0**（无 run、无任务状态变更）；机器自升级起无 host 管线流量。
- 存量状态（升级前已知，未变化）：artificer pending 37 / failed 83；最后一次真实 artificer 链（`605ba208…`，2026-10-15）以 `execution_failed`/`max_attempts_exceeded` 失败——该失败链属 PRI-991/IAER 既有事项，**非本次升级引入**（时间与版本均不吻合）。
- 按任务书"隔离测试 PASS ≠ 真实生产 Pilot PASS"且样本为零，裁定 NOT_RUN（不足证据，非失败）。

## 6. Windows 安装、Console 端口与认证边界说明

- 本机为 win32（Windows 10.0.26200 x64）+ Git Bash 执行环境；安装布局 canonical（`install.json` mode=canonical，hosts=openclaw/codex/workbuddy）。
- Console 生产端口 **3101**（3100 为 Windows 保留排除范围，未再尝试绑定）；服务由 Companion 以 `--workspace D:\.openclaw\workspace --port 3101 --host 127.0.0.1` 拉起。
- 认证：`AuthConfig`（`packages/pd-console/src/server/config/AuthConfig.ts`）仅在提供 token（CLI/env）时启用 Bearer；实测生产 401 边界生效。**本轮未持有/未使用/未打印任何 token**；受保护数据一律经 state.db 只读快照取证。
- 198.18.0.1:3101 的额外监听为本机代理（fake-IP 段）所有，非 PD 进程；核验 PD Console 一律走 `127.0.0.1:3101`。

## 7. 回滚预案（Phase E，只读核查 + 可操作步骤）

**可行性证据（全部已核验）**：

1. **上一发行在位**：`~/.pd/releases/c46eed2e…/metadata.json`（2.3.6 / sourceCommit `702d92233` / sequence 21 / 未过期 2027-01-14）；其 `win32-x64-abi147` 资产 URL 匿名 HEAD **200**（`release-asset-win32-x64-abi147-5c5a6f56fc5f.tar.gz`）——重装载荷仍在发。
2. **升级前 runtime 全量备份在盘**：`~/.pd/backups/runtime.backup.1792253584510/`（时间戳=本次 staging 时刻 00:13），实测内含 `core@1.293.1 + pi-ai@0.85.1 + pi-agent-core@0.85.1` 及全部模块——**回滚即恢复 Pi 0.85.1 的直接物证**。
3. **零数据面不可逆变化**：state.db schema 000–002 未变；`config.yaml` 在升级中未被改动（mtime 10-17 10:42）；无新 flag；`data-compatibility.ts` 的 expand-migrate-contract 门本次无迁移可拦。
4. **回滚合同在代码中**：`create-principles-disciple/src/update/rollback-policy.ts`（确定性失败自动回滚/每事务至多一次/断路器/防脑裂）与 console `/api/update/recovery`、`/api/update/transaction/*` 操作面；release-manager `status` / `repair-update-chain` 可用。
5. **源码侧回滚集**（SPEC §10）：`git revert` 迁移 commit 集（两 manifest + 三适配器 + 测试 + 7 锁 + `.changeset/pi12-compat-upgrade.md`）即回 0.85.1。

**操作序列（建议，均需 Owner 执行；本轮未演练、未切指针）**：

1. 首选：经 Console 更新面 / release-manager 发起指向 `c46eed2e`（2.3.6）的更新事务（与本次 2.3.7 事务同一受控链，自动含 host 协调与失败自动回滚保护）；
2. 激活后重启 Console（Companion 拉起）与 Gateway（OpenClaw 宿主）——与本次升级后观察到的 00:21/00:22 重启行为同构；
3. 应急路径：从 `runtime.backup.1792253584510` 恢复 `~/.pd/runtime`，`create-principles-disciple status`/`repair-update-chain` 校验，再重建插件壳；
4. 数据/配置无需任何回迁（零数据面变更）。

演练状态：**未在隔离目录实际演练**（证据充分性判断：在位备份+资产 200+零迁移+事务链合同已构成可行性证明；演练收益不抵额外操作风险），如实记录。

## 8. 残余缺陷与观察（含源码位置）

| # | 级别 | 事项 | 位置/证据 | 归因 |
|---|---|---|---|---|
| R-1 | P3（存量） | 两例 stale `running` run + 一次 `lease_conflict` 失败：`run_diagnosis_manual_1792225898443_gum9ohig_1`（running）、`run_diag_distiller-…_1`（running）、`…_2`（failed/lease_conflict），自 2026-10-17T08:31–08:38Z 起 | 生产 state.db `runs`（快照 `.tmp/pi12-phase2/state-snapshot.db`）；对应 manual 诊断实验 | **升级前已存在**（早于升级 7.5h），非 2.3.7 回归；建议 Owner 经 Console failed-tasks/单任务恢复面处置，本轮未触碰 |
| R-2 | P3（工程） | 新 worktree 自举不产出 `pd-cli/dist`，导致依赖真实 CLI 的 cli-7 接线测试首跑必红（补 build 后绿） | `scripts/dev/bootstrap-worktree.mjs`（L2 构建覆盖缺口）；复现于本轮 adhoc worktree | 既有已知坑重现，建议自举补 pd-cli 构建（§9） |
| R-3 | 观察 | 事件 jsonl 日志通道自 10-07 起无新文件（事件面静默，非缺陷判定） | `D:\.openclaw\workspace\.pd\logs/` | 与管线静默一致 |
| R-4 | 观察 | IAER 存量积压（artificer 37 pending/83 failed、NHR 21、approvals 32 pending） | 生产 state.db | 升级前已知态，本轮零变化，非验收范围 |
| R-5 | 观察 | `198.18.0.1:3101` 代理进程同端口监听 | netstat | 非 PD 所有，运维解读注意 |

未发现任何 P0/P1；未发现任何升级引入的回归证据。**本轮零缺陷修复 PR**（无修复必要）。

## 9. 下一阶段最小工作建议

1. **AC-6 处置（生产切换前的既有硬门）**：Owner 二选一——授权执行三例真实 LLM E2E（机制/钥匙已就绪，仅缺 `LLM_E2E_ENABLED=true` 授权动作）或明示 OWNER_WAIVED 并记录。
2. **首个生产 Pi 1.2 流量样本**：让任一 host 产生一次自然管线活动（或 Owner 触发一次 manual 诊断），随后复核 runs/遥测无异常分类，把 RUNTIME HEALTH 从"服务面 PASS"升级为"流量面 PASS"。
3. **R-1 stale run 处置**：Owner 经 Console 恢复面审一遍 `diagnosis_manual_1792225898443_gum9ohig` 家族（是否恢复/作废）。
4. **R-2 自举补齐**：`bootstrap-worktree.mjs` L2 构建清单加入 pd-cli（独立小 PR）。
5. IAER 真实 Pilot 维持既有前置（授权+可消费任务），不因本验收变化。

## 10. 验收环境与产物

- 只读快照与证据：`.tmp/pi12-phase2/state-snapshot.db`（+wal/shm 副本）；控制台/进程/端口取证均内联于上文。
- 隔离 worktree：`D:\Code\_worktrees\principles\adhoc-20261017-pi12-phase2-postupgrade-405469`（验收后已用 `dev:worktree:cleanup --delete-branch` 合规移除，completion 经 ancestry 证明）。
- 费用：本轮付费模型调用 **0 次**；全部测试 faux/本地。

---

## 11. 第二轮独立复验（2026-10-18 08:40–08:47 本地 / 00:40–00:47Z）

同日第二轮自主验收：不信任第一轮结论，全部关键事实重新取证，隔离回归在全新 worktree 重跑。**七项裁决全部维持；RUNTIME HEALTH 证据范围升级**（插件/证据面出现升级后真实生产流量）。

### 11.1 安装与来源链（复取，PASS）

- `~/.pd/active.json` 与第一轮逐字段一致：generation 46 / releaseId `995e4e48…` / previous `c46eed2e…`（2.3.6）/ productVersion 2.3.7 / sourceCommit `aee538012` / transactionId `update-1792253128873-2b81a796`。
- **七个运行时模块**（core/console/codex-adapter/host-runtime/plugin/pd-cli/workbuddy-adapter）各自 node_modules 实际解析 `@earendil-works/pi-ai` 与 `pi-agent-core` **均为 1.2.0**，无旧版混装、无跨模块漂移。
- `git merge-base --is-ancestor` 实证：**`1eb5293a`（PR #2070 合并提交）是 `aee538012`（安装 sourceCommit）的祖先**；`git fetch` 后 origin/main 仍停在 `aee538012`——安装后无更新发行，稳定通道未移动。
- 服务面：Console 127.0.0.1:3101（PID 17564）与 Gateway 127.0.0.1:18789（PID 71624）**与第一轮同 PID 存活**（升级后未再重启，连续运行约 8 小时 20 分），两者 HTTP 200。

### 11.2 升级后健康（复取 + 新发现）

**维持项（与第一轮一致）**：

- enforcement-health 最新 degraded 记录仍为 2026-10-17 15:33（本地），全部来自 vitest 沙箱（`.pd-test-temp`），**升级后零新增**；
- 网关日志 `gateway-restart.log` 停留在 00:22:22（升级后重启时刻），principles 相关错误行 **0**；
- 治理存量零漂移：approvals pending 32（approved 23 / rejected 2）、candidates pending 29（consumed 200）、artificer pending 37 / failed 83、rollout_reviewer needs_human_review 21；
- `dead_letter_pains=0`、`global_rulecode_pauses=0`；R-1 三条 stale run（gum9ohig 家族）状态与时间戳逐条未变；
- 升级后（≥16:17:19Z）runs=0、tasks 更新=0、pi_artifacts=0、pain_diagnoses=0、approvals=0、activations=0、artifacts=0；最后任务/运行活动仍停在 2026-10-17T08:38:25Z（升级前）。

**新发现（更新第一轮"完全静默"结论）**：

- `intervention_evidence_records` 自 **2026-10-17T17:43:56Z**（本地 01:43，第一轮报告完成后约 45 分钟）恢复写入，且**持续增长至今**：快照时点 311 条 → 6 分钟后复取 320 条（最新 `2026-10-18T00:46:11Z`，取证时刻 00:46:59Z）。
- 全部为 `openclaw|delivery|agent_context` 观测，分属 5 个会话 UUID（**40、63、64、72、81 条/会话**；本行系 Phase 3 勘误——原稿"40–72 条/会话"低估了最大会话，实证合计 40+63+64+72+81=320 与本节总数精确吻合，Phase 3 以独立只读快照复核）；**100% 关联 activation、无一条 unlinked/损坏、无异常标记**。
- 判读：这是**升级后插件（2.1.8，Pi 1.2.0 依赖树）在真实宿主中的活体流量证据**——注入/证据摄取路径工作正常且零错误信号。**勘误（Phase 3）：该 320 条记录的 `confirmation`/`outcome` 全部为 `submitted`/`attempted`，语义是"投递尝试已留痕"——它只证明注入动作发生且被观测，不构成 Agent 已遵循原则、更不构成行为已改善的证据（遵循/改善须由 `application`/`behavior_episode`/`effect`/`outcome` 级记录支撑，该窗口为零）。**注意该路径**不经过 Pi 模型调用**，故 Pi 1.2 模型面（Dreamer/Artificer/One-shot 真实推理）仍零生产样本，AC-6 与 RUNTIME HEALTH 的模型面判定不受此影响。

### 11.3 隔离回归重跑（308/308 两轮复现）

全新 worktree `adhoc-20261018-pi12-reverify-7c31f9-phase2-reverify`（`dev:worktree --base aee538012`，READY L1–L3，HEAD=生产 sourceCommit）：

| 套件 | 结果 | 耗时 |
|---|---|---|
| principles-core 7 文件（spike×3 + l2-agent-loop + artificer-l2 + pi-ai-runtime-adapter + pd-stream-simple） | **214/214 PASS** | 8.35s |
| host-runtime 7 文件（consumer-cycle×6 + single-task-recovery-evidence-gate） | **31/31 PASS** | 11.08s |
| pd-cli 4 文件（runtime-recovery×3 + artificer-evidence-audit） | **63/63 PASS（首跑即绿）** | 5.35s |

- 合计 **308/308**，与第一轮逐套件一致。
- R-2 反向确证：本轮先 `npm run build -w @principles/pd-cli` 再跑 pd-cli，**首跑即 63/63**——证明该失败纯属 worktree 自举 L2 构建覆盖缺口（bootstrap-worktree.mjs 不产 pd-cli/dist），与 Pi 1.2 无关。
- worktree 用毕经 `dev:worktree:cleanup --delete-branch` 合规移除（completion 经 ancestry 证明，工作区零改动）。

### 11.4 IAER（复验）

- 隔离集成：§11.3 host-runtime + pd-cli 套件即第一轮 §5 的同一证据面（证据门/意图门/恢复幂等/evaluator 遥测/审计），两轮全绿 → **PASS（复现）**。
- 真实 Pilot：升级后 Pi 模型路径生产活动仍为 0（§11.2），存量积压零变化 → **NOT_RUN（维持）**。

### 11.5 AC-6（复验）

本会话 `LLM_E2E*` 环境变量数 = **0**（`SENSENOVA_API_KEY` 仍存在，未读取值）。授权开关缺席 → **NOT_RUN（维持，≠ OWNER_WAIVED）**。

### 11.6 零费用与边界遵守

第二轮付费模型调用 **0 次**；未修改安装目录/生产库/生产任务；未重启任何服务；未合并/发版；未创建后台常驻评审。快照证据：`.tmp/pi12-phase2-r2/state-snapshot.db` 与 `state-fresh.db`（+wal/shm）。

### 11.7 最终裁决（任务书要求口径）

```text
INSTALLATION VERIFIED        : PASS
RUNTIME REGRESSION           : PASS（308 例两轮复现；生产模型面零样本不构成反证）
AC-6                         : NOT_RUN（授权缺席；非 FAIL、非 OWNER_WAIVED）
IAER ISOLATED INTEGRATION    : PASS（两轮复现）
IAER PRODUCTION PILOT        : NOT_RUN（生产 Pi 模型路径零活动）
PRODUCTION ACCEPTANCE        : CONDITIONAL GO（= 保留当前部署 KEEP）
```

CONDITIONAL GO 的条件（解除后可升级为 GO）：

1. **AC-6 处置**：Owner 授权执行三例真实 LLM E2E（设 `LLM_E2E_ENABLED=true` + 既有 key，固定模型/调用上限/费用上限），或明示 OWNER_WAIVED；
2. **Pi 模型面首流量复核**：产生首次真实 Pi 1.2 模型调用后（自然管线活动或 Owner 手动诊断），复核 runs/遥测无异常分类；
3. R-1 stale run 处置与 R-2 自举补齐（P3，不阻塞）。

回滚链（§7）在本轮复验中未使用、仍然完整在位。
