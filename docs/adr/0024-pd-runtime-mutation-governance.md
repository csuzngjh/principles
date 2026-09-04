# ADR-0024: PD Runtime Mutation Governance

| Field | Value |
| --- | --- |
| Status | **Proposed**（待 Owner 裁决） |
| Date | 2026-09-04 |
| Supersedes | 无 |
| Superseded by | 无 |
| Related | ADR-0020（宿主适配器与多平台抽象）、ADR-0023（PD Installation Architecture Decisions，Accepted）、`packages/create-principles-disciple/src/update/*`（transactional update 子系统）、`packages/pd-cli/src/commands/runtime-artifact-repair.ts`（PRI-555 phase 1） |
| Decision evidence | 尚无 —— 本 ADR 为 Proposed，等待 Owner 对 §2.1–2.5 逐项裁决 |

---

## 1. Context

### 1.1 为什么需要这份 ADR

ADR-0023（Accepted）Decision 1 规定 `~/.pd/runtime` 是 canonical runtime，合法写入者为 **installer / updater / repair tool**，禁止 Agent、Adapter、Console 与用户脚本直接写入。

但 ADR-0023 只定义了**谁可以写**，没有定义**怎么写**。其审查报告 §3 的开放问题 Q-A 明确指出：repair tool 是本次决策唯一新增的风险敞口——2026-09-03 的 runtime artifact 污染事件（三个文件被写成占位文本）正是一次"修理式写入"。如果 repair tool 获得无约束的覆盖能力，它将成为与污染事件同构的新的污染来源。

本 ADR 定义 **Runtime Mutation Governance**：对 runtime 的每一次写入，必须满足什么授权、什么事务纪律、什么失败语义、什么审计义务。

### 1.2 现状调查结论（2026-09-04，全部来自源码）

对 `packages/` 全量只读扫描后，发现 runtime 变更入口的**治理成熟度极不均匀**。完整清单见配套审查报告 `docs/architecture/ADR-0024-review-summary.md` §1，此处列影响决策的四条主干事实：

- **F1（installer）**：`create-principles-disciple/src/installer.ts` 是目前唯一经过 digest 校验的写入者（消费 `trust-metadata.ts` 的 `resolveTrustedReleaseTarget` / `downloadTrustedReleasePayload` 与 `release-asset-manifest.ts` 的 `verifyReleaseAssetTarget`），采用 backup-rename-swap 且失败时恢复备份（`installer.ts:567-590`）。但**不写 transaction journal**。
- **F2（console updater）**：`pd-console/src/server/routes/update.ts`（Web UI 的 check/apply/rollback 后端）是一套**独立实现的更新器**：从 npm registry 下载 tarball、`tar` 解包、staged `.update` 文件、`rmSync` dist 目录、备份目录 rename。**零 digest / 完整性校验**（源码中 sha256/digest/verify 零命中），**不写 transaction journal**，有自己的 `appendUpdateHistory`。
- **F3（transactional update 子系统已建成但处于 shadow mode）**：`update/transaction-journal.ts` 定义了 11 态状态机（planned → downloaded → verified → staged → probed → activated → host_verified → confirmed，及 rolled_back / refused / failed）与 6 种事务类型，支持恢复感知读取；`update/release-manager.ts` 的 `apply()` / `rollback()` **显式抛出 `shadow_mode_read_only`**，等待 Phase 4 dual-slot transaction rollout；`update/rollback-policy.ts` 与 `update/bootstrap-protocol.ts` 目前**没有任何外部消费方**。`pd version` 报告（`version-report.ts`）是 ReleaseManager 目前唯一的只读消费方。
- **F4（repair tool 现状）**：`pd-cli/src/commands/runtime-artifact-repair.ts`（PRI-555 phase 1）是 **DRY-RUN ONLY 计划器**——只产出 `migration-plan.json`（默认写到 CWD，不进 runtime），歧义一律标 `needs_human_review`，`--confirm` 在本阶段被显式拒绝。**执行器尚不存在**，即 ADR-0023 名义上的合法写入者"repair tool"今天对 runtime 的实际写入能力为零。

### 1.3 核心张力

- 治理基建（journal、digest 校验、shadow-mode ReleaseManager、dry-run repair planner）**已经存在**，但互不联通：最强的校验能力在 installer，最弱的校验能力在 console updater，而最规范的模型（ReleaseManager + journal）还没有执行权。
- 如果任由现状演化，会出现"写入者各自为政"：同一台机器上，console 更新不验 digest、installer 验 digest 但不留 journal、repair 执行器一旦落地若不走同一套纪律，就是第二个污染源。
- 因此本 ADR 的目标不是发明新机制，而是**把既有能力收敛为所有 mutation 的强制契约**。

---

## 2. Decision（Proposed —— 以下各项为分析后的建议，待 Owner 裁决）

### 2.1 Mutation Authority（谁可以修改 runtime）

**建议规则：**

1. **Installer**（`create-principles-disciple`）：唯一拥有**整体安装/重装**权限的写入者。必须：写入前完成 digest 校验（现状已满足，F1）、写入 journal（现状缺失，见 2.2）、保留可回滚备份。
2. **Updater**：**不允许多于一个实现**。现状存在两套（installer 内的更新路径与 console Web updater，F1/F2），这是 ADR-0023 未预见的第三写入者。建议：console Web updater 收敛为 ReleaseManager 的**触发器与进度呈现层**，不得自行执行文件变更；在 ReleaseManager 退出 shadow mode 之前，console updater 属于**存量债务**而非合法长期形态（其零 digest 校验是不可接受项）。
3. **Repair tool**：见 2.3。
4. 其余一切组件（Agent、Adapter、Console 其余部分、Companion、用户脚本）：**零写入**，与 ADR-0023 Decision 1 一致。Companion 已证实只写自身状态文件（F12，见审查报告）。

**裁决点**：是否接受"console updater 必须收敛为触发器"作为约束性规则（影响 Web UI 更新功能的实现路线）。

### 2.2 Mutation Transaction Model（事务纪律）

**建议规则：任何对 `~/.pd/runtime` 的写入，必须是一次可审计的事务，至少记录：**

- `actor`（写入者身份：installer / updater / repair-executor）
- `reason`（触发原因：install / update / reinstall / rollback / repair / recovery）
- `timestamp`
- `before digest`（被替换内容的 digest，目录级用 asset manifest 表达）
- `after digest`（写入后内容的 digest）
- `rollback point`（备份路径或 dual-slot 槽位标识）

**实现基线已存在**：`transaction-journal.ts` 的 11 态状态机 + `JournalTransition` + 恢复感知读取完全覆盖上述字段语义，`TransactionKind` 枚举（update / reinstall / explicit_downgrade / rollback / legacy_migration / recovery）只需**追加 `repair`**。建议不新建第二套机制（AGENTS.md P4：One Source of Truth），而是把 journal 的消费范围从"仅 legacy-migration"扩大为"所有 mutation 强制"。

**裁决点**：journal 的存放位置与读取权限（建议：`~/.pd/` 下、随 runtime 备份一起轮换、对 Owner 只读可见）。

### 2.3 Repair Tool Boundary（修复工具边界）

三个选项的 trade-off：

| 选项 | 优点 | 缺点 | 风险 |
| --- | --- | --- | --- |
| **A. 自动修复**（检测到 drift 直接覆盖） | 恢复最快、无 Owner 注意力成本 | 修复逻辑本身成为最特权代码；一旦误判（例如把合法的本地变更当 drift），自动写入会**放大**损害；与 09-03 事件同构 | 最高 |
| **B. 生成 plan 后执行**（plan 与 execute 分离） | 计划阶段可审计、可 diff、可拒绝；PRI-555 phase 1 已实现 plan 侧且质量良好（歧义标 `needs_human_review`、只读连接、不猜） | 仍需定义执行器的授权与纪律 | 中 |
| **C. 需要 Owner approval** | 人是最便宜的最终裁决者；治理系统"Owner-governed"的产品定位要求关键变更可归因于 Owner | Owner 不在场时无法自愈 | 低，但牺牲自动化 |

**建议：B + C 组合，分两级。**

- **默认路径（plan → approval → execute）**：`runtime-artifact-repair` 继续只产出 plan（现状不变）；新增的执行器**必须**满足：只消费 plan 文件（不自行检测）、逐条与 journal 记录对应、写入用 installer 同款 backup-swap 与 digest 校验、执行前要求 Owner 显式批准（CLI 交互确认或批准文件）。
- **受限自动路径（远期，默认关闭）**：仅当修复动作满足"可证明幂等 + 单文件 + digest 精确匹配已知好值"时才允许自动执行，且仍写 journal。该开关的引入本身需要一份后续决策。

**裁决点**：执行器放在哪个包（建议 `create-principles-disciple`，与 installer 共享 swap/journal 基建，避免第三处实现）；`repair` 是否需要与 `update` 同级的兼容性 preflight（console updater 已有 legacy rule contract preflight 可参考，F 值见审查报告）。

### 2.4 Failure Model（失败语义）

**建议规则：**

1. **任何 mutation 失败时，runtime 必须保持在上一个已验证状态**——要么事务尚未开始（最常见），要么备份恢复完成（`installer.ts:587-590` 的恢复路径即此模式的雏形）。禁止"失败后留下部分写入"作为终态。
2. **部分状态只允许存在于 journal 可见的窗口内**：`transaction-journal.ts` 的 staged / probed / activated 中间态 + `readTransactionJournalForRecovery()` 的恢复感知读取，就是为"进程死于事务中途"设计的。任何新写入者接入 journal 即自动获得该语义。
3. **恢复动作本身也是 mutation**：recovery（journal 中已有此 kind）同样要记录 actor/reason/digest，防止"修复失败的修复"成为无限回归的污染源。
4. **拒绝优于静默降级**：preflight 失败（如 console updater 的 legacy rule contract 检查、ReleaseManager 的 `refused` 态）必须显式拒绝并留痕，不得降级为"带病写入"。

### 2.5 Audit Model（审计义务）

**建议规则：**

1. 每次事务的**终态迁移**（confirmed / rolled_back / refused / failed）必须追加到人类可读的 history 流。基线已存在：`update-history.ts` 的 `appendHistoryEvent`，且 workspace `.pd/update-history.json` 已在实际运行中产生（见审查报告 F13）。
2. **journal 与 history 职责分离**：journal 面向机器恢复（状态机、可重放），history 面向 Owner 审阅（何时、谁、为什么、结果）。不合并为一份（P4 允许派生读模型，但二者语义不同，非重复）。
3. **console updater 的私有 history（`routes/update-history.ts`）必须收敛到同一实现**，消除双份审计源。
4. 审计记录为 append-only；清理策略（保留多少天/多少条）不属于本 ADR。

---

## 3. Non-Goals

本 ADR **不执行、不授权**以下事项（均属后续 implementation tasks，须在本 ADR 转 Accepted 后另行立项）：

- 修复 2026-09-03 污染的 runtime 文件（`core/dist/index.js`、`plugin/dist/bundle.js` 两处占位哑弹仍未恢复）；
- 修改 repair tool 代码（包括为 `runtime-artifact-repair` 增加 confirm 执行路径）；
- 修改 installer、console updater 或 ReleaseManager 的任何行为；
- 增加权限控制代码（只读位 / lock manifest 化属 ADR-0023 P0/P3 范畴）；
- 删除任何重复副本；
- 让 ReleaseManager 退出 shadow mode（那是 update 子系统自己的 Phase 4 计划）。

---

## 4. 与 ADR-0023 的关系

不冲突，是收窄与细化：

- ADR-0023 Decision 1 定义工集（"谁有资格写"）；本 ADR 定义其中的方法学（"有资格者怎么写"）。
- ADR-0023 Decision 9 的 warn-only Phase 1 提供的是**检测面**（发现文件变化与 digest 不一致）；本 ADR 提供的是**修复面**的纪律。二者衔接点：warn-only 的基线（known-good digest）正是 repair plan 的输入。
- ADR-0023 审查报告的开放问题 Q-A（repair tool 边界）由本 ADR §2.3 回应；Q-C（workspace 无 schema 版本）不在本 ADR 范围内。

---

## 5. Owner 裁决清单

| # | 问题 | 建议方向 | 影响 |
| --- | --- | --- | --- |
| D-1 | console Web updater 是否收敛为 ReleaseManager 触发器（禁止自行写文件） | 是 | Web UI 更新功能实现路线 |
| D-2 | journal 是否成为所有 mutation 的强制契约（含 installer） | 是 | installer 需补 journal 写入（后续任务） |
| D-3 | repair executor 的批准模式 | plan → Owner approval → execute | PRI-555 phase 2 设计前提 |
| D-4 | repair executor 落点包 | create-principles-disciple | 与 installer 共享基建 |
| D-5 | 受限自动修复是否引入 | 远期、默认关闭 | 后续单独决策 |
| D-6 | journal 存放位置与轮换策略 | `~/.pd/` 下，随备份轮换 | 实施细节 |
| D-7 | history 收敛为单一实现 | 是 | console 需改造（后续任务） |
