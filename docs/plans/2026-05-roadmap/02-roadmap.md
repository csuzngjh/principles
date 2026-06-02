# 02 - 路线图：MVP-First Track（Runtime V2 收敛 + 种子客户验证）

> **更新日期**: 2026-06-02（v3.1 — MVP Track 进度同步）
> **基准**: `origin/main` = `b4444507`（PR #696 合并后）；2026-06-02 基于 Linear 完成工单同步
> **主决策**:
> - [ADR-0014](../../adr/0014-mvp-first-strategy-and-product-pivot.md) **★ MVP-First Strategy（当前主决策）**
> - [ADR-0012](../../adr/0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md)（Runtime V2-only，仍生效）
> - [ADR-0013](../../adr/0013-attribution-pipeline-and-decision-observability.md)（已 Superseded by ADR-0014, deferred）
> **执行文档**: [`07-mvp-first-pivot.md`](./07-mvp-first-pivot.md)
> **被推迟工作的重启条件**: [`post-mvp-conditional-roadmap.md`](../post-mvp-conditional-roadmap.md)

## 0. 一句话状态

> **PD 进入 MVP 阶段。所有架构演进暂停。4-6 周内邀请第一个真实种子客户。**

## 1. Phase 状态总表

| Phase | 状态 | 说明 |
|-------|------|------|
| Phase 0: low-risk E2E | Done | Pain → Activation 基础路径已验证 |
| Phase 1A: L2 / RuleHost safety | Done | RuleHostWriter / sandbox / approval 已落地 |
| Phase 1B P1: stability baseline | Done | PRI-200~225 完成 |
| Phase 1B P2: Nocturnal retirement | Done | PRI-227~231、PRI-119、PRI-242 已完成 |
| ~~Phase 1C: value loop closure (Attribution)~~ | **Cancelled / Deferred** | ADR-0014 取消；重启条件见 post-mvp §1 |
| ~~Phase 1D: lean foundations~~ | **Cancelled / Deferred** | 同上；重启条件见 post-mvp §2-§5 |
| **MVP Track** | **Active** | **Week 1-4 已完成，Week 5-6 部分完成，进入种子客户邀请阶段** |
| Phase 2+ (BALM/LRAS/GAP/MissionScheduler) | Hold | 准入门槛改为外部反馈驱动；见 post-mvp §7-§10 |

## 2. MVP Track 6 周路线图

详见 [07-mvp-first-pivot.md §5](./07-mvp-first-pivot.md)。摘要：

```
Week 1-2 减法 + proven-channel 闭环 ✅ 全部完成
  ✅ PRI-252  MVP-First 文档/Linear 控制面纠偏
  ✅ PRI-239  feature flags contract + MVP-Quiet 关闭
  ✅ PRI-240  prompt / RuleHost / defer_archive synthetic 冒烟
  ✅ PRI-242  Nocturnal 退役继续（PRI-227 + PRI-230）

Week 3-4 用户旅程 + proven-channel 演示 ✅ 全部完成
  ✅ PRI-244  pd-console proven-channel 审批 UI
  ✅ PRI-245  pd-console 三页化（Pain / Principle / Approval）
  ✅ PRI-246  Demo workspace + 故事 A' proven-channel 场景
  ⏸ PRI-243  SkillFileWriter 仅作为需求触发后的 stretch，不预排实现

Week 5-6 安装 + 邀请（部分完成）
  ✅ PRI-247  pd-cli 一键安装
  ⏳ PRI-248  GETTING-STARTED 用户视角重写
  ⏳ PRI-249  故事 A' 录屏
  ⏳ PRI-251  邀请第一个种子客户
  ✅ PRI-250  多环境冒烟（Windows + WSL，PR #794）

额外完成的 MVP 工作（原路线图未列出）
  ✅ PRI-253  MVP release gate: clean live workspace
  ✅ PRI-254  MVP installer: owner review console entrypoint
  ✅ PRI-255~257  MVP live pain 信号质量门控与证据保留
  ✅ PRI-259  PD-owned workspace config
  ✅ PRI-260~265  Console 审批后端 + activation 修复
  ✅ PRI-266/270/286/287  Confirm-first gate 持久化与清理
  ✅ PRI-271/272  Diagnostician 弱模型鲁棒性
  ✅ PRI-273  E2E trap-task Story A' 验证
  ✅ PRI-274/277  MVP 输入信号充分性
  ✅ PRI-283  SchemaPromptAdapter
  ✅ PRI-285  MVP seed 反馈通道
  ✅ PRI-288/289/290/291/292/293/294/296  Plugin surface 清理与瘦身
```

## 3. MVP-Core / MVP-Quiet / MVP-Gone 清单

详见 [ADR-0014 §2.4 / §2.5 / §2.6](../../adr/0014-mvp-first-strategy-and-product-pivot.md)。摘要：

**MVP-Core**: Pain capture / Diagnostician / CandidateIntake / Dreamer + Scribe + Artificer / 三个已实现激活通道（prompt / RuleHost / defer_archive）/ Approval Queue / pd-console 三页 / pd-cli 核心命令。

**MVP-Quiet（关闭，留代码）**: SkillFileWriter（未实施，不进入邀请门槛）/ Philosopher / Evaluator / RolloutReviewer / GFI / Focus History / Thinking OS / Empathy keyword / empathy_inferred / Shadow Observation / Local Worker Routing / Central Sync / message-sanitize / Trajectory Collector（评估）。

**MVP-Gone（删除/归档）**: Nocturnal 全套 / IdleTrigger / sleep cycle / EvolutionWorker / Trainer / model_training。

## 4. MVP Track 风险

详见 07-mvp-first-pivot.md §6。要点：

- 风险 1：未实现通道重新进入关键路径 → skill 不进入当前调度，真实需求出现后再立项
- 风险 2：RuleHost 概念门槛高 → PRI-249 录屏视频不能省，用客户真实规则演示
- 风险 5：MVP-Quiet 关闭可能 break 现有功能 → 关闭后立即跑完整测试套件

## 5. 旧路线图段落处置

以下段落已被本文件取代，保留作历史档案查阅：

- ~~§3 Phase 1C: 必须并行推进的价值闭环~~ → 全部 cancelled / deferred（PRI-148 进 Phase 2 待外部反馈）
- ~~§4 Phase 1D: 精简底座~~ → 全部 cancelled / deferred
- ~~§5 保留但必须重写范围的旧 issues~~ → 部分仍生效（PRI-118 / PRI-120 / PRI-121），见 §6
- ~~§6 明确取消/取代~~ → 仍生效，转入 ADR-0014 Anti-pattern 列表
- ~~§7 Phase 准入门槛~~ → 已被 ADR-0014 §3 / 07 §9 取代
- ~~§8 Issue 分配建议~~ → 已被 07 §5 取代

## 6. 仍生效的非 MVP issues

以下 issues 不属于 MVP Track 但**仍可作为减法 / 守护工作**继续：

| Issue | 状态 | 处置 |
|-------|------|------|
| PRI-227 | Done | ✅ 已完成 |
| PRI-228 | Done | ✅ 已完成 |
| PRI-229 | Done | ✅ 已完成 |
| PRI-230 | Done | ✅ 已完成 |
| PRI-231 | Done | ✅ 已完成（CI 收缩） |
| PRI-118 | Backlog | 降级为 backlog；不在 MVP 路径，但 trajectory facade 仍有 long-term 价值 |
| PRI-119 | Done | ✅ 已完成（EvolutionWorker cutover） |
| PRI-148 | Backlog | MVP 用 Approval reject 简单路径；RejectionFeedback 待外部需求 |
| PRI-150 | Canceled | MVP 后再评估 |
| PRI-154 | Canceled | MVP 后再评估 |
| PRI-162 | Done | ✅ 已完成（PD-owned scheduling） |
| PRI-183 | Done | ✅ 已完成（PRUNING_PIPELINE 文档） |
| PRI-248 | Todo | 执行中（GETTING-STARTED 重写） |
| PRI-249 | Backlog | 需完成（Story A' 录屏） |
| PRI-251 | Backlog | 需完成（邀请种子客户） |
| PRI-278~282 | Backlog | Codex CLI adapter 系列（新增方向） |
| PRI-297 | Todo | 执行中（Secret redaction） |

## 7. 不再分配 / 不再优先

| 不做的事 | 理由 |
|---------|------|
| 完整实施 ADR-0006 全 5 通道 | model_training 不在 MVP；skill 未被需求验证；MVP 只依赖三个已实现通道 |
| BALM / LRAS / GAP / MissionScheduler 任何实施 | 等外部反馈触发；见 post-mvp §7-§10 |
| Attribution / WorkspaceLearningSummary / Provenance / Probation Window | 同上；见 post-mvp §1-§5 |
| 完整 7-Runner 链路投资 | Philosopher / Evaluator / RolloutReviewer 在 MVP-Quiet；等外部反馈 |
| 跨 workspace 任何功能 | MVP 单 workspace |
| 任何"为下个 Phase 铺路"的抽象 | AGENTS.md "MVP 三问" 拦截 |

## 8. 立即执行（按顺序）

详见 [07-mvp-first-pivot.md §10](./07-mvp-first-pivot.md)。当前进度：

1. ✅ ADR-0014 已写
2. ✅ post-mvp-conditional-roadmap.md 已写
3. ✅ 07-mvp-first-pivot.md 已写
4. ✅ ADR-0013 顶部 Superseded 注记
5. ✅ 06-评审 顶部 Superseded 注记
6. ✅ PD_System_Dynamics_Model.md v2.0 deferred 注记
7. ✅ 02-roadmap.md 修订（本文件）
8. ✅ README.md 修订
9. ✅ AGENTS.md 修订（MVP 三问 + 三档分类）
10. ✅ Linear: PRI-232~236 已 canceled，等待 post-MVP 重启条件
11. ✅ PRI-252: 控制面纠偏完成
12. ✅ PRI-239: feature flag contract 已实现并测试
13. ✅ PRI-240: proven-channel synthetic baseline 已完成
14. ✅ PRI-242: Nocturnal / idle-trigger 退役已完成
15. ✅ PRI-244/245/246: Console 审批 UI + 三页化 + Demo 已完成
16. ✅ PRI-247: pd-cli 一键安装已完成
17. ✅ PRI-253~296（排除 Canceled/Backlog）: MVP live pain / confirm-first / diagnostician / plugin 瘦身等已完成
18. ⏳ PRI-248: GETTING-STARTED 用户视角重写（Todo）
19. ⏳ PRI-249: 故事 A' 录屏（Backlog）
20. ⏳ PRI-251: 邀请第一个种子客户（Backlog）
21. ⏳ PRI-297: Secret redaction from telemetry（Todo）
22. ⏳ PRI-278~282: Codex CLI adapter 系列（Backlog）
