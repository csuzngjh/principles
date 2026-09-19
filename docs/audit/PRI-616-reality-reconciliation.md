# PRI-616 Reality Reconciliation — Dogfood Observation vs Current Main

> 任务：核对 PRI-616 Dogfood Reality Report（2026-09-18）的 5 项发现在当前 main（99666f43，与 origin 一致）上是否已修复 / 仅因 dogfood 环境旧 / 仍需新任务。
> 方法：只读。git/gh 查 merge 记录；Linear 读 PRI-616/799/819/815/834；两个只读子代理对 main 源码逐点取证（文件:行号+commit）；dogfood 库与配置只读复核。未修改任何代码/数据库/环境。
> live 环境基线：plugin 1.245.2 升级于 2026-09-16T13:44Z（authority=legacy-console-updater）；**09-18 插件残缺事故后经 repo 构建重装**（插件包现为 principles-disciple 1.76.1），因此 live 处于"安装器版本线 + repo 构建修复"的混合态。

---

# Executive Summary

**PRI-616 发现的 5 个问题中：2 个已被 main 完全修复（升级即得）；2 个的核心属配置/设计差异而非缺陷（其附带的一个真实小缺陷已修）；1 个一半已修（升级即得），残余的"Console 外主动提醒"是唯一真实缺口。**

换算成动作：**不需要为 5 项中的任何一项立即立开发任务**；主要动作是「一次升级 + 两个 Owner 配置决策」；唯一值得讨论立项的是 Console 外提醒通道（且需先过 mvp-q-1 论证，很可能结论是"不建"）。

顺带修正 dogfood 报告本身的两处口径（详见 Issue 3 / Issue 1）：pain 原文**并非**不入库（一直在 host 侧 trajectory.db，观察时只查了 state.db 是我的观察盲区）；"管线停摆"实为 **Owner 配置显式关闭消费者**下的预期状态，且 09-18 仍有新任务入队。

---

# Finding Matrix

| Problem | Dogfood | Main | Conclusion |
|---|---|---|---|
| 1. Pipeline 停摆 | BLOCKED（12 dreamer/11 artificer pending、307/320 validation pending、13 候选未消费） | **非代码缺陷**：main 默认 auto-consumer ON（自 2026-06-13）；dogfood config.yaml:26-28 显式 `enabled:false`（Owner 覆盖）。"停摆不可见"这一真实缺口已由 PRI-715 修复（09-17，#1735） | **配置差异 + 部分升级即得**；无需新任务。恢复=Owner 翻开关 +（可选）run-once 清积压 |
| 2. Owner 待决无入口 | YES（9 候选滞留 ledger、1 项 high-risk 审批挂 3 天、无提醒） | **一半已修**：#1754 Owner Decision v1（09-18T22:26Z merge，HEAD）把 pending approvals 升格为 canonical 决策投影并进 Console Focus inbox（计数+列表+徽标+decided 历史，flag `principle_governance_projection_v2` 默认 ON）。ledger candidate 被刻意排除在"待决"外（INV-02 设计）。**Console 外推送/提醒：main 也没有** | **升级即得一半**；残余缺口=Console 外主动提醒（唯一新任务候选，需 Owner 立项） |
| 3. Pain 原文未持久化 | pain_diagnoses 恒空、state.db 无原文 | **观察口径需修正**：pain 原文自 2026-08-30 起持久化在 trajectory.db `pain_events.text`（消毒+截断 200 字，a257c69e7）；state.db 只存哈希是显式跨库设计（sqlite-connection.ts:669-676）。pain_diagnoses 恒空因 quiet flag 默认关——**main 默认同样关** | **设计如此 + Owner 决策项**（是否开 flag）。残余小缺口：读路径不跨库取原文（可选 follow-up） |
| 4. Daily stats 全零 | broken（仅 2 天文件且计数全 0） | **FIXED**：PRI-824（78c39b1f6，PR #1738 merge 09-17T10:36Z）修正遥测落点被钉到 host home 的缺陷；全零文件另因"读取即物化空 stats"（仍在，低危） | **Deploy Update**（dogfood 09-16 构建早于修复半天内） |
| 5. 版本口径分裂 | CLI 1.74.1 / 升级史 1.245.2 / 插件包 1.76.1 三套并存 | **已系统性处理**：PRI-727（发布元数据供给链，#1604）+ PRI-832（release 资产内嵌可验证产品身份，#1751）+ PRI-833（cli/console/plugin 跨布局读取已安装身份；`pd version --json` 输出 canonical report，Console UpdatePage 显示 identity divergence，#1749）+ PRI-738（legacy updater 物理退役，更新权威=1，#1750） | **Deploy Update**；升级走 ReleaseManager（PRI-808 配方），勿再经已退役的 legacy updater |

---

# Evidence

## Issue 1 — Pipeline 停摆

**Dogfood 事实复核（只读）**
- `D:/.openclaw/workspace/.pd/config.yaml:26-28`：`internalization_auto_consumer: enabled: false`（category: quiet）——显式 Owner 覆盖，非缺省。
- 积压时间分布（state.db）：dreamer pending 在 09-15(4)/09-17(8)/**09-18(2)** 仍持续入队——入队与消费解耦，有输入无消费者，与开关关闭完全自洽；13 个未消费候选全部创建于 09-01/03/05（早期残留），最近候选均已 consumed。
- 307/320 validation pending 自 09-01 建库即慢性存在——validation 翻转只发生在 evaluator/rollout_reviewer 节点（evaluator-runner.ts:1137-1139、rollout-reviewer-runner.ts:862），消费停则永远 pending，是下游症状而非独立缺陷。

**Main 代码事实**
- 消费者：`packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts:102-191`（120s 循环，需 gateway 常驻）；启动门 `packages/openclaw-plugin/src/index.ts:347-367`（"NOT started" 日志即此处 :365）。
- 默认值：`packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:196` — `enabled: true, since 2026-06-13`（PRI-381/#914）；flag 账目 feature-flag-lifecycle.ts:56-63 记 KEEP_QUIET/ON；fresh install 不写该 key（j12-fresh-install-defaults.test.ts:42）。
- PRI-797（6670d4fc8，#1709）改的是 signal_collector 默认，**与 auto-consumer 无关**——排除一个错误归因。
- 停摆可见性：PRI-715（c04c2f722/97d028912，#1735，09-17）——worker 永久降级时 Companion 系统通知+托盘常驻+恢复路径（pd-companion/src/lib/degraded.ts:54-95）。

**结论**：【配置差异，非缺陷】+【可见性已修，升级即得】。Linear 无对应修复单（核对过 PRI-799/819/815/834 均 Done 且与此无关；PRI-819 恰好把"未接线的 PendingTermStore"物理退役而非接线，佐证"连接问题走新投影而非复活死机制"的路线）。

## Issue 2 — Owner 待决可见性

**Main 代码事实（#1754，merge commit 99666f43，2026-09-18T22:26Z）**
- Phase B 读投影：`packages/principles-core/src/runtime-v2/owner-decision/owner-decision-view.ts`（deriveOwnerDecisionView 单一派生边界）+ owner-decision-view-contract.ts:370-431（decisionState/decisionSubjects/availableActions/blockers/nextAction/inbox）。
- 覆盖：**pending approvals 全覆盖**（:846 pending→needs_owner_decision，动作 approve/reject/edit :728/:744/:760）——挂 3 天的 high-risk 审批升级后即入组；activation 折叠为 enforcement summary（:205-216）。
- **ledger candidate 明确不算待决**（:12-13 F1 硬规则 + Console PrinciplesPage.tsx:64-66 INV-02「candidate 不是待你裁决」）——设计决策，不是遗漏。
- Phase C Console 消费：pd-console/src/server/routes/owner-decision.ts:33-111（3 条 API，flag `principle_governance_projection_v2` 默认 ON，contract:354）；UI FocusPage.tsx:1136-1175（计数+列表）、PrinciplesPage.tsx:207-269（徽标）、PrincipleDetailPage.tsx:663-679（decided 历史）。
- **Console 外提醒：全仓 rg 无 push/notification/webhook/reminder 机制**——#1754 前后均不存在，属真实缺口（本地单机、无推送通道，是否值得建需过 mvp-q-1）。

**既有入口（#1754 之前）**：PRI-629 Owner Inbox（2026-08-30，覆盖 needs_human_review 任务/activation_approval/shadow promotion）+ PRI-787 决策卡锁定原因（09-14）——都在 Console 内。

**结论**：Console 内可见性【已修，升级即得】；Console 外提醒【main 也没有，真实缺口，候选新任务】。

## Issue 3 — Pain 原文持久化

**Main 代码事实**
- **原文一直有存储**：trajectory.db `pain_events.text`（trajectory-schema.ts:91）——用户纠错经 sanitize(redact→path-replace)+截断 200 字入库（governance-signal-admission.ts:495-514，注释 P1-1 隐私设计，a257c69e7 2026-08-30，早于 live 构建）；manual pain 存原文（pain.ts:549-560）；canonical pain store 即此表，`pd pain list` 只 SELECT 元数据列不查 text（pain-list.ts:126-128）。
- state.db 只存哈希 pain_id 是**显式跨库设计**（sqlite-connection.ts:669-676 注释："logical association key, not a cross-database FK"）；无"禁止原文入库"的 ADR——dogfood 报告"原文不入库"的说法**不成立**，系观察只查了 state.db、未查 trajectory.db 所致（观察盲区，特此修正）。
- pain_diagnoses 表唯一写入方 sqlite-pain-diagnosis-store.ts:113（INSERT OR IGNORE），写入条件=pain_diagnosis_persistence flag ON 且诊断有产出（pain-signal-bridge.ts:727）；该 flag main 默认 **false**（contract:372，quiet，since 2026-08-23，毕业条件恰是"dogfood 诊断归因验证"）。dogfood config.yaml:121-123 的 false 与 main 默认**一致**，不是配置过期。

**结论**：【设计如此】+【Owner 决策项】（是否开启归因持久化=flag 毕业验证的一部分）。残余小缺口：现有读路径无跨库取原文视图（SQL 复核原文仍不可达，只能 CLI/直接读 trajectory.db）。

## Issue 4 — Daily Stats

**Main 代码事实**
- writer：openclaw-plugin/src/core/event-log.ts:67（statsFile=`<stateDir>/logs/daily-stats.json`）、计数在 updateStats:379-500、30s flush :502-505。
- 全零根因一：**PRI-824 缺陷**——WorkspaceContext.fromHookContext 沿用 host 传入 stateDir 并缓存，遥测被钉到 `~/.openclaw/logs` 而非 workspace `.pd/logs`；修法 workspace-context.ts:260-269（78c39b1f6，PR #1738 merge 2026-09-17T10:36Z）。live 1.245.2（09-16T13:44Z）早于修复 **约 21 小时**，命中的正是修复前版本。
- 全零根因二（仍在，低危）：getDailyStats :597-604 读取即物化空 stats 进 cache，纯读取也会落全零日期文件。

**结论**：【main 已修，升级即得】。

## Issue 5 — 版本口径分裂

**事实链**
- live 三套数字来源：`pd version`→@principles/pd-cli 包版本 1.74.1（bundled 布局标记）；update-history 终值 1.245.2→installer 引用 `bundledPluginVersion: "1.245.2"`（create-principles-disciple/package.json:79），authority=legacy-console-updater；插件包现值 1.76.1→09-18 插件残缺事故后经 repo 构建重装（混合态）。
- main 的系统性处理（按时间）：PRI-727 发布元数据供给链+版本门 fail-closed（#1604，09-11）→ PRI-738 legacy updater 物理退役、生产更新权威=1（#1750，09-18）→ PRI-832 release 资产内嵌可验证产品身份（ref manifest+严格 stamp 契约，#1751，09-18）→ PRI-833 cli/console/plugin 跨布局读取已安装身份、`pd version --json` 输出 canonical report（productVersion/releaseId/components/health）、Console UpdatePage 显式展示 identity divergence（#1749，09-18，含 update-identity-divergence.test.ts）。
- Linear：PRI-616 本体在 Backlog（剩余=installed real dogfood / rollout-default-on 的 Owner 验证，与本核对衔接）；PRI-799/819/815/834 全部 Done，均不含 pipeline/stats/version 修复（815/834=Trinity 收敛 spike 与设计 SPEC，已归档未实施）。

**结论**：【main 已修，升级即得】；升级必须走 ReleaseManager（PRI-808 配方），因 legacy updater 已退役。

---

# Decision

## No Action（不建任务、不改代码）
- Pipeline"停摆"核心（配置差异；validation 慢性 pending 为下游症状；candidate 滞留 ledger 为生命周期设计 INV-02）。
- Pain 原文"缺失"（观察口径修正：原文本就消毒存于 trajectory.db；state.db 只存哈希是显式设计）。
- pain_diagnoses 恒空（main 默认即关的 quiet flag；开启与否=Owner 决策，且其验证正是该 flag 的毕业条件）。
- 版本"数字不同"本身（monorepo 组件版本线；缺陷在无权威口径，已修）。

## Deploy Update（升级即得，一次升级全带上）
- PRI-824：daily-stats 落点修复（#1738）
- PRI-715：worker 永久停摆 Owner 可见（#1735）
- #1754：Owner Decision v1——挂起审批进 Console 决策收件箱
- PRI-832/833/738/727：可验证产品身份+单一更新权威
- 升级后建议的 **Owner 配置决策**（非开发任务）：① 是否翻回 `internalization_auto_consumer: enabled: true`（并可选 `pd runtime internalization run-once` 清积压）；② 是否开启 `pain_diagnosis_persistence`（顺带完成该 flag 的 dogfood 毕业验证）。

## New Task Needed（main 仍缺，候选待 Owner 立项）
1. **Console 外 Owner 待决提醒**（唯一实质缺口）：本地单机现状下无推送通道，按 mvp-q-1 先论证"不做会怎样"——很可能结论是不建或借用现有通道（如 PD Companion 通知/飞书），不应自动实施。
2. （小，可选）pain 原文跨库读视图：`pd pain list/trace` 展示 trajectory.db 中的消毒原文，消除"SQL 不可复核"残余。

---

# Final Rule 核对

- 已被 main 解决的（Stats/Version/Console 内可见性/停摆可见性）→ **不创建任务** ✔
- 仅环境旧/配置差异的（auto-consumer 关闭、pain flag 默认关、原文跨库设计）→ **不修改代码** ✔
- main 仍存在真实缺陷的 → 仅 1 项（Console 外提醒）+ 1 项小缺口（跨库读视图），**列为候选任务，等 Owner 立项** ✔

*生成：2026-09-19，PRI-616 Reality Auditor。核对完毕，停止行动，等待 Owner Review。*
