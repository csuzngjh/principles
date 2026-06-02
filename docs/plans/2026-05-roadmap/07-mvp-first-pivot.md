# 07 - MVP-First Pivot：从技术深化转向种子客户验证

> **状态**: Active / 取代 06 / 取代 Phase 1C/1D
> **日期**: 2026-05-24（创建）；2026-06-02 进度同步
> **决策来源**: ADR-0014（MVP-First Strategy and Product Pivot）
> **关联文档**: docs/plans/post-mvp-conditional-roadmap.md（被推迟工作的重启条件）

## 0. 一句话总结

> **PD 进入 MVP 阶段：4-6 周内具备邀请第一个真实种子客户的能力。所有架构演进暂停。所有"为未来铺路"工作 deferred。复杂度立即停止增长，开始减法。**

## 1. 战略重置（与 06 文档的对比）

| 维度 | 06 (AHE-informed review) | 07 (MVP-First Pivot) |
|------|------------------------|---------------------|
| 心智模型 | "成熟产品的精益化" | "未验证产品的 PMF 寻找" |
| 优先级 | Attribution Pipeline 是最高杠杆 | 种子客户是最高杠杆 |
| 新增组件 | 9 个（Attribution / LearningSummary / Probation / 等）| 0 个（SkillFileWriter 为非阻塞 stretch，不预先实施）|
| 新增不变量 | 12 个（ATTRIBUTION-* / STATE-* / 等）| 0 个 |
| 新增 issue | PRI-232~236（5 个，已 canceled）| PRI-239~252 的 MVP 收敛/验证/邀请路径 |
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
        ┌─────────────┬─────────────┐
        ▼             ▼             ▼
     Prompt       RuleHost      defer_archive
   (软提示)      (硬拦截)        (优雅退场)
        │             │             │
        └─────────────┴─────────────┘
                      ↓
          代理在下一轮真实任务中表现出新品格
```

**首次 MVP 只交付三个已有、可观测通道**。`skill` 是 stretch goal，不得因为一个未验证的新 writer 推迟真实用户验证。

## 4. MVP-Core / MVP-Quiet / MVP-Gone 完整清单

详见 ADR-0014 §2.4 / §2.5 / §2.6。摘要：

**MVP-Core**:
- Pain capture / Diagnostician / CandidateIntake / Ledger
- Dreamer + Scribe + Artificer Runner
- 3 个已实现激活通道（prompt / RuleHost / defer_archive）
- Approval Queue + pd-console 三页

**MVP-Quiet（关闭，留代码）**:
- Philosopher / Evaluator / RolloutReviewer Runner
- GFI / Focus History / Thinking OS / Empathy keyword
- empathy_inferred 信号源
- Shadow Observation / Local Worker Routing
- Central Sync / message-sanitize
- Trajectory Collector（评估后决定）
- SkillFileWriter（尚未实现；没有观察到客户需求前保持关闭）

**MVP-Gone（删除/归档）**:
- Nocturnal 全套（PRI-227~231 继续）
- IdleTrigger / sleep cycle / EvolutionWorker
- Trainer / model_training 通道 / TrainingExporter

## 5. MVP Track 路线图

### Week 1-2: 减法 + proven-channel 闭环验证 ✅ 全部完成

| Issue | 内容 | 状态 |
|-------|------|------|
| **PRI-252** | 控制面纠偏：文档 / Linear / agent gate 一致 | ✅ Done |
| **PRI-239** | 可加载 feature flags contract + MVP-Quiet 默认关闭 | ✅ Done |
| **PRI-240** | proven-channel synthetic 冒烟（prompt / RuleHost / defer_archive）| ✅ Done |
| **PRI-242** | Nocturnal / idle-trigger 退役协调（含 PRI-227 / PRI-230）| ✅ Done |

### Week 3-4: 用户旅程 + proven-channel 演示 ✅ 全部完成

| Issue | 内容 | 状态 |
|-------|------|------|
| **PRI-243** | SkillFileWriter stretch checkpoint：仅在需求已记录时立项，否则关闭 | ⏸ Backlog (stretch) |
| **PRI-244** | pd-console proven-channel 审批 UI 完整化 | ✅ Done |
| **PRI-245** | pd-console 三页化（Pain / Principle / Approval）| ✅ Done |
| **PRI-246** | Demo workspace + 故事 A' proven-channel 演示 | ✅ Done |

### Week 5-6: 安装 + 邀请（部分完成）

| Issue | 内容 | 状态 |
|-------|------|------|
| **PRI-247** | pd-cli 一键安装（`npx create-principles-disciple` 兼容 AI 助手安装路径）| ✅ Done |
| **PRI-248** | GETTING-STARTED 用户视角重写 | ⏳ Todo |
| **PRI-249** | 故事 A' 录屏 + 文字解释（5-8 分钟）| ⏳ Backlog |
| **PRI-250** | 多环境冒烟（Win/Mac/Linux）| ✅ Done（Windows + WSL，PR #794） |
| **PRI-251** | 邀请第一个种子客户（A + C 画像各 1 个）| ⏳ Backlog |

### 额外完成的 MVP 工作（原路线图未列出）

| Issue | 内容 | 状态 |
|-------|------|------|
| PRI-253 | MVP release gate: clean live workspace | ✅ Done |
| PRI-254 | MVP installer: owner review console entrypoint | ✅ Done |
| PRI-255~257 | MVP live pain 信号质量门控与证据保留 | ✅ Done |
| PRI-259 | PD-owned workspace config + OpenClaw hook 绑定 | ✅ Done |
| PRI-260~265 | Console 审批后端 API + activation record 修复 | ✅ Done |
| PRI-266/270/286/287 | Confirm-first gate 持久化与指令状态清理 | ✅ Done |
| PRI-261/295 | Runtime V2 prompt activation 绑定 + activation reader contract | ✅ Done |
| PRI-271/272 | Diagnostician 弱模型鲁棒性 + taskId lineage 修正 | ✅ Done |
| PRI-273 | E2E trap-task Story A' 验证 | ✅ Done |
| PRI-274/277 | MVP 输入信号充分性（empathy + owner message） | ✅ Done |
| PRI-283 | SchemaPromptAdapter（schema 驱动 prompt 生成） | ✅ Done |
| PRI-285 | MVP seed 反馈通道（隐私保护） | ✅ Done |
| PRI-288/289/290/291/292/293/294/296 | Plugin surface 清理与瘦身（EvolutionWorker 隔离、prompt 注入瘦身等） | ✅ Done |
| PRI-297 | Secret redaction from telemetry | ⏳ Todo |

## 6. 风险与缓解

### 风险 1：把未验证的新通道放进 MVP 会再次拖慢验证

当前演示基线固定为三个已经实现的通道。`skill` 仅在真实客户需求被记录或维护者明确批准后进入范围。若已实现通道仍需缩减，按可观测性和回滚能力排序：
```
prompt > defer_archive > RuleHost > skill
（保留度从高到低）
```

如果只能演示 2 个，砍 RuleHost；prompt + defer_archive 是绝对底线。

### 风险 2：RuleHost / Skill 概念门槛高于 prompt 注入

种子客户特别是非研究者画像可能听不懂"硬拦截"是什么。**缓解：MVP-13 录屏视频不能省**，且必须用 **客户自己的真实团队规则** 做演示输入（不要用抽象哲学）。

### 风险 3：故事 A' "行为品格内化"是更深的概念

抽象说服力低。**缓解：演示时不讲哲学，先让客户给 PD 注入一个具体的 "我团队的工作风格规则"，然后展示 AI 在没注入和注入后的行为差别。**

### 风险 4：历史文档把 SkillFileWriter 重新带回关键路径

`skill` 已被明确移出首次客户邀请门槛。任何重新引入它的 issue 必须回答 MVP 三问并引用真实需求证据，否则直接拒绝。

### 风险 5：MVP-Quiet 关闭可能 break 现有功能

GFI / Focus History 等已被现有代码依赖。**缓解：feature flag 默认关闭后，立即跑完整测试套件 + synthetic baseline。任何 break 必须 fix 或恢复 default 为 on（视严重程度）。**

### 风险 6：种子客户邀请时间无法控制

你认识的开发者朋友可能没空。**缓解**：MVP-15 不是技术 issue，是社交动作；备用方案是把视频 + GETTING-STARTED 公开发布，等自然反馈。

## 7. AGENTS.md 强制约束（PRI-MVP-5 落地后生效）

每个新 issue 在 PR 启动前必须答 **MVP 三问**：

1. **不做会怎样？** 30 天后还有人提吗？
2. **怎么观察？** UI / CLI / 日志 哪个能看到它在工作？
3. **怎么关闭？** feature flag 还是 PR revert？

`PRI-239` 合并前，禁止未经批准的新功能扩张，但 bugfix、验证、文档和删除工作可继续。`PRI-239` 合并并证明 loader/test 生效后，新增或重新暴露的功能必须注册 `feature-flags.yaml`，否则 PR 拒收。

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
4. ✅ 在 ADR-0013 顶部加 Superseded 注记
5. ✅ 在 06-ahe-informed-architecture-review.md 顶部加 Superseded 注记
6. ✅ 在 PD_System_Dynamics_Model.md 顶部加 v2.0 deferred 注记，恢复 v1.0 视图
7. ✅ 修订 02-roadmap.md（删除 Phase 1C/1D，改为 MVP Track）
8. ✅ 修订 README.md（改入口）
9. ✅ 修订 AGENTS.md（加 MVP 三问 + 三档分类）
10. ✅ Linear: PRI-232~236 已 canceled；保持 post-MVP deferred
11. ✅ Linear: PRI-252 控制面纠偏完成
12. ✅ Linear: PRI-239 feature flag contract 已实现并测试
13. ✅ Linear: PRI-240/242/244/245/246/247 proven-channel 验证 + legacy retirement + console + installer 完成
14. ✅ Linear: PRI-253~296（排除 Canceled/Backlog）MVP live pain / confirm-first / diagnostician / plugin 瘦身等完成
15. ⏳ Linear: PRI-248 GETTING-STARTED 重写（Todo）
16. ⏳ Linear: PRI-249 故事 A' 录屏（Backlog）
17. ⏳ Linear: PRI-251 邀请种子客户（Backlog）
18. ⏳ Linear: PRI-297 Secret redaction（Todo）
19. ⏳ Linear: PRI-278~282 Codex CLI adapter 系列（Backlog）

文档完成后才动 Linear，避免重复修订。
