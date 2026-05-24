# 07 - MVP-First Pivot：从技术深化转向种子客户验证

> **状态**: Active / 取代 06 / 取代 Phase 1C/1D
> **日期**: 2026-05-24
> **决策来源**: ADR-0014（MVP-First Strategy and Product Pivot）
> **关联文档**: docs/plans/post-mvp-conditional-roadmap.md（被推迟工作的重启条件）

## 0. 一句话总结

> **PD 进入 MVP 阶段：4-6 周内具备邀请第一个真实种子客户的能力。所有架构演进暂停。所有"为未来铺路"工作 deferred。复杂度立即停止增长，开始减法。**

## 1. 战略重置（与 06 文档的对比）

| 维度 | 06 (AHE-informed review) | 07 (MVP-First Pivot) |
|------|------------------------|---------------------|
| 心智模型 | "成熟产品的精益化" | "未验证产品的 PMF 寻找" |
| 优先级 | Attribution Pipeline 是最高杠杆 | 种子客户是最高杠杆 |
| 新增组件 | 9 个（Attribution / LearningSummary / Probation / 等）| 0 个（除 SkillFileWriter）|
| 新增不变量 | 12 个（ATTRIBUTION-* / STATE-* / 等）| 0 个 |
| 新增 issue | PRI-232~236（5 个）| MVP-1 至 MVP-15（15 个，多为减法或 docs）|
| 新增 ADR | ADR-0013（Attribution）| ADR-0014（MVP-First）|
| 时间预期 | Phase 1C/1D ≈ 2-3 个月 | MVP Track 4-6 周 |

## 2. 产品定位重新校准

**PD 不治理工具级错误**。这是 OpenClaw / Claude Code 的职责。

```
错误层次              处理者                              PD 是否关心
─────────────────────────────────────────────────────────────────
工具级（参数错、命令失败）   OpenClaw / Claude Code 自身         否
任务级（同类任务反复失败）   per-session memory                  次要
行为模式级（跨会话品格偏差） PD ★                                主要
```

详见 ADR-0014 §2.1。

## 3. MVP 故事 A'：把零散教训沉淀成稳定品格

```
[多次相似情境的失败 / 人工纠正 / 风险接近]
                         ↓
              PainSignal 累积同类信号
                         ↓
              Diagnostician 识别"模式而非单次"
                         ↓
       Dreamer + Scribe (+ Artificer) 把模式抽象为 Principle 候选
                         ↓
       人工在 pd-console 审核 → 决定走哪个通道
                         ↓
        ┌─────────────┬─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
     Prompt      Skill         RuleHost      defer_archive
   (软提示)    (主动工作流)   (硬拦截)        (优雅退场)
        │             │             │
        └─────────────┴─────────────┘
                      ↓
          代理在下一轮真实任务中表现出新品格
```

**4 个通道全部进 MVP-Core**——这是 PD 与"prompt 模板管理器"的本质区别。

## 4. MVP-Core / MVP-Quiet / MVP-Gone 完整清单

详见 ADR-0014 §2.4 / §2.5 / §2.6。摘要：

**MVP-Core**:
- Pain capture / Diagnostician / CandidateIntake / Ledger
- Dreamer + Scribe + Artificer Runner
- 4 个激活通道（含待建 SkillFileWriter）
- Approval Queue + pd-console 三页

**MVP-Quiet（关闭，留代码）**:
- Philosopher / Evaluator / RolloutReviewer Runner
- GFI / Focus History / Thinking OS / Empathy keyword
- empathy_inferred 信号源
- Shadow Observation / Local Worker Routing
- Central Sync / message-sanitize
- Trajectory Collector（评估后决定）

**MVP-Gone（删除/归档）**:
- Nocturnal 全套（PRI-227~231 继续）
- IdleTrigger / sleep cycle / EvolutionWorker
- Trainer / model_training 通道 / TrainingExporter

## 5. MVP Track 路线图

### Week 1-2: 减法 + 4 通道闭环验证

| Issue | 内容 | 估时 | 形式 |
|-------|------|------|------|
| **PRI-MVP-1** | MVP scope 决议文档（三档清单 + 故事 A'）| 1 天 | docs only |
| **PRI-MVP-2** | Cancel/defer 旧 issues（PRI-232/233/235/236 cancel；PRI-234 hold；PRI-118 降级）| 0.5 天 | Linear API |
| **PRI-MVP-3** | Feature flags 系统 + MVP-Quiet 默认关闭 | 5-7 天 | 1 PR |
| **PRI-MVP-4** | 4 通道 synthetic 冒烟（每通道 1 fixture）| 5-7 天 | 1 PR |
| **PRI-MVP-5** | AGENTS.md "MVP 三问" + 三档分类 | 0.5 天 | docs only |
| **PRI-MVP-6** | Nocturnal 退役继续（PRI-227 + PRI-230）| 5-7 天 | 与上面并行 |

### Week 3-4: 用户旅程 + 4 通道演示

| Issue | 内容 | 估时 | 形式 |
|-------|------|------|------|
| **PRI-MVP-7** | SkillFileWriter 实施（channel=skill）| 5-7 天 | 1 PR |
| **PRI-MVP-8** | pd-console 4 通道审批 UI 完整化 | 5-7 天 | 1 PR |
| **PRI-MVP-9** | pd-console 三页化（Pain / Principle / Approval）| 3-5 天 | 1 PR |
| **PRI-MVP-10** | Demo workspace + 故事 A' 4 通道演示 | 7-10 天 | 1 PR |

### Week 5-6: 安装 + 邀请

| Issue | 内容 | 估时 | 形式 |
|-------|------|------|------|
| **PRI-MVP-11** | pd-cli 一键安装（`npx create-principles-disciple` 兼容 AI 助手安装路径）| 3-5 天 | 1 PR |
| **PRI-MVP-12** | GETTING-STARTED 用户视角重写 | 3-5 天 | docs |
| **PRI-MVP-13** | 故事 A' 录屏 + 文字解释（5-8 分钟）| 2-3 天 | 内容产出 |
| **PRI-MVP-14** | 多环境冒烟（Win/Mac/Linux）| 3-5 天 | 多个小 PR |
| **PRI-MVP-15** | 邀请第一个种子客户（A + C 画像各 1 个）| 0.5 天 | 沟通 |

## 6. 风险与缓解

### 风险 1：4 通道演示比单通道难 3-5 倍

每个通道有独立审批 UI、独立 demo 场景、独立回滚路径。skill 通道还需要新写 SkillFileWriter。如果 Week 3-4 进度落后：

**优先砍 skill 通道**（按"已完成度"和"演示直观度"）：
```
prompt > defer_archive > RuleHost > skill
（保留度从高到低）
```

如果只能演示 3 个通道，砍 skill；如果只能演示 2 个，砍 skill + RuleHost；prompt + defer_archive 是绝对底线。

### 风险 2：RuleHost / Skill 概念门槛高于 prompt 注入

种子客户特别是非研究者画像可能听不懂"硬拦截"是什么。**缓解：MVP-13 录屏视频不能省**，且必须用 **客户自己的真实团队规则** 做演示输入（不要用抽象哲学）。

### 风险 3：故事 A' "行为品格内化"是更深的概念

抽象说服力低。**缓解：演示时不讲哲学，先让客户给 PD 注入一个具体的 "我团队的工作风格规则"，然后展示 AI 在没注入和注入后的行为差别。**

### 风险 4：Week 3-4 SkillFileWriter 实施风险

skill 通道是唯一一个还需要新写代码的 MVP-Core 工作。如果实施超时，必须果断砍掉 skill 通道并接受"3 通道演示"，而不是延期发布。

### 风险 5：MVP-Quiet 关闭可能 break 现有功能

GFI / Focus History 等已被现有代码依赖。**缓解：feature flag 默认关闭后，立即跑完整测试套件 + synthetic baseline。任何 break 必须 fix 或恢复 default 为 on（视严重程度）。**

### 风险 6：种子客户邀请时间无法控制

你认识的开发者朋友可能没空。**缓解**：MVP-15 不是技术 issue，是社交动作；备用方案是把视频 + GETTING-STARTED 公开发布，等自然反馈。

## 7. AGENTS.md 强制约束（PRI-MVP-5 落地后生效）

每个新 issue 在 PR 启动前必须答 **MVP 三问**：

1. **不做会怎样？** 30 天后还有人提吗？
2. **怎么观察？** UI / CLI / 日志 哪个能看到它在工作？
3. **怎么关闭？** feature flag 还是 PR revert？

每个新功能在 commit 前必须**先在 feature-flags.yaml 注册**。无 flag 注册的 PR 拒收。

## 8. 与已有文档的关系

| 文档 | 处置 |
|------|------|
| 06-ahe-informed-architecture-review.md | 标 Superseded by ADR-0014 / 07-mvp-first-pivot.md，不删 |
| ADR-0013 (Attribution Pipeline) | 标 Superseded by ADR-0014, Deferred；重启条件见 post-mvp-conditional-roadmap.md §1 |
| ADR-0008/0009/0010/0011 | 已标 deferred；不变 |
| PD_System_Dynamics_Model.md v2.0 | v2.0 概念标 deferred；R1/B1/R3 v1.0 概念蓝图保留 |
| 02-roadmap.md | Phase 1C/1D 段落标 superseded；重写 |
| README.md | 改为 MVP Track 入口 |
| 04-risks-and-mitigations.md | R-16~R-23 标 deferred；新增 MVP Track 风险 |
| 05-integrated-stability-and-refactoring-blueprint.md | 保留作为稳定性基线参考 |

## 9. Phase 2/3 准入门槛（重新定义）

之前的"Phase 2 = BALM/LRAS/GAP/MissionScheduler" 模型不再适用。新的 Phase 准入门槛是**外部反馈驱动**：

```
MVP Track 完成 (Week 6 末)
        │
        ▼
[种子客户 1-3 个使用 ≥ 1 个月]
        │
        ▼
"种子反馈期" 的实际反馈分流
        │
        ├─→ "PD 没用" / "我看不到价值" → 产品定位重审，不进 Phase 2
        ├─→ "原则越来越多变慢" → 启动 §1 Attribution Pipeline (post-mvp 第 1 项)
        ├─→ "想换 backend" → 启动 §7 BALM
        ├─→ "Diagnostician 超时" → 启动 §8 LRAS
        ├─→ "想根据 OKR 过滤反思" → 启动 §9 GAP
        └─→ "原则太粗糙" → 启动 §6 完整 7-Runner
```

**没有反馈就没有 Phase 2**。维护者本人的"洁癖" / "完整性焦虑" / "完美主义" 不算反馈。

## 10. 立即执行清单（按顺序）

1. ✅ ADR-0014 已写
2. ✅ post-mvp-conditional-roadmap.md 已写
3. ✅ 07-mvp-first-pivot.md 已写（本文档）
4. 在 ADR-0013 顶部加 Superseded 注记
5. 在 06-ahe-informed-architecture-review.md 顶部加 Superseded 注记
6. 在 PD_System_Dynamics_Model.md 顶部加 v2.0 deferred 注记，恢复 v1.0 视图
7. 修订 02-roadmap.md（删除 Phase 1C/1D，改为 MVP Track）
8. 修订 README.md（改入口）
9. 修订 AGENTS.md（加 MVP 三问 + 三档分类）
10. Linear: cancel PRI-233 / PRI-235 / PRI-236
11. Linear: 改 PRI-232 描述为 staleness-only 极小版
12. Linear: 改 PRI-234 为 hold + 加注重启条件
13. Linear: 创建 PRI-MVP-1 至 MVP-15

文档完成后才动 Linear，避免重复修订。
