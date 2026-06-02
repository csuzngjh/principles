# ADR-0014: MVP-First Strategy and Product Pivot to Behavior Character Internalization

> **Status**: Accepted
> **Date**: 2026-05-24
> **Supersedes**: ADR-0013 (Attribution Pipeline) — deferred, not abandoned. See §6.
> **Reframes**: ADR-0006 (5-channel activation) priorities. See §4.
> **Defers**: ADR-0008 (BALM), ADR-0009 (LRAS), ADR-0010 (GAP), ADR-0011 (MissionScheduler) — see post-mvp-conditional-roadmap.md
> **Drives**: docs/plans/2026-05-roadmap/07-mvp-first-pivot.md (execution)

## 1. Context

PD 项目已经积累了大量子系统：5 个激活通道（其中 2 个 writer 待建）、7 个 Peer Runner、Pain pipeline、Internalization pipeline、Activation pipeline、5 个 ReadModel、3+ 个 Adapter、BALM/LRAS/GAP/MissionScheduler 4 个未实施 ADR、Attribution Pipeline 提案……

项目的复杂度已经超过单人理解能力的阈值。维护者（一人 + AI 助手）每日产出 3-4 个 PRI 的速度让这种膨胀加速。同时：

- **零真实外部用户**。所有 pain signal 来自合成 baseline 或维护者本人。
- **后端为主，缺乏 UI 验证路径**。维护者形容为"蒙眼开车"。
- **功能间耦合深**，难以孤立验证某个子系统的真实价值。
- **下线机制缺失**。每个新功能都被加进来，没有功能曾经被关闭过。

进一步审视，发现一个根本性的产品误读：之前推荐的"AI 不再犯同类错误"故事（PainSignal → Diagnostician → prompt 注入 → 拦截）实际上是**工具级错误的处理**——这个层次属于 OpenClaw / Claude Code 自身的职责，不是 PD 的差异化价值。

## 2. Decision

PD 进入 **MVP-First 阶段**。所有架构演进暂停，目标是在 **4-6 周内邀请第一个真实种子客户**。

### 2.1 产品定位重新校准

PD 的真正治理对象是 AI agent 的 **行为品格**——跨会话、跨任务、稳定的性格性偏差，而不是单次工具调用失败。

```
错误层次              处理者                            PD 是否关心
─────────────────────────────────────────────────────────────────
工具级（参数错、命令失败）   OpenClaw / Claude Code 自身       否
任务级（同类任务反复失败）   per-session memory                次要
行为模式级（跨会话品格偏差） PD ★                              主要
```

具体例子：
- "AI 在不可逆操作前缺乏确认习惯" — PD 关心
- "AI 在重构时偏激进而非保守" — PD 关心
- "git push 失败" — PD 不关心（OpenClaw 处理）
- "命令缺少 --confirm 参数" — PD 不关心

### 2.2 MVP 故事 A'：把零散教训沉淀成稳定品格

**演示路径**（4-6 周内必须可被外部用户走完）：

```
[多次相似情境的失败 / 人工纠正 / 风险接近]
                         ↓
              PainSignal 累积同类信号
                         ↓
              Diagnostician 识别"这不是单次失败，是模式"
                         ↓
       Dreamer + Scribe 把模式抽象为 Principle 候选
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

**首次种子客户验证只依赖三个已经实现、可以观测和回滚的通道**：`prompt`、`code_tool_hook` / RuleHost、`defer_archive`。`skill` / `SkillFileWriter` 是受控 stretch goal，不是邀请客户的前置条件；只有客户需求或维护者明确决策才能把它移入当前路线。

### 2.3 三档分类法（取代之前的"留/砍"二元）

| 档位 | 含义 | 处理 |
|------|------|------|
| **MVP-Core** | 故事 A' 演示链路必需 | 保留并打磨；feature flag 默认开 |
| **MVP-Quiet** | 留代码但**关闭默认 + 不进入 UI / 文档** | feature flag 默认关；6 个月无激活则 MVP-Gone |
| **MVP-Gone** | 删除或归档 | 直接减少代码量 |

**关键原则**：MVP-Quiet 是**可逆的隔离**，不是删除。代码保留，flag 关闭。这让"减法"不那么痛苦——我们只是减少**用户和维护者大脑里的概念数量**，不破坏系统完整性。

### 2.4 MVP-Core 清单（保留并打磨）

| 子系统 | 备注 |
|-------|------|
| Pain capture (hook) + PainSignal | 已落地 |
| Diagnostician + DiagnosticianRunner | 已落地 |
| CandidateIntake + LedgerPrincipleEntry | 已落地 |
| **Dreamer + Scribe + Artificer** Runner | 已落地。Artificer 是 skill / RuleHost 的产出源 |
| **prompt 通道** + LedgerPromptWriter | 已落地 |
| **defer_archive 通道** + LedgerArchiveWriter | 已落地 |
| **code_tool_hook 通道** + RuleHostWriter | 已落地 (PRI-146) |
| Approval Queue + pd-console approvals 页 | 部分落地 |
| pd-console 三页（Pain / Principle / Approval）| 待精简 |
| pd-cli 核心命令 (`pd diagnose run` / `pd status` / `pd trace show` / `pd activation list`) | 已落地 |
| PainChainReadModel | 已落地 |

### 2.5 MVP-Quiet 清单（关闭，留代码）

| 子系统 | 关闭理由 |
|-------|---------|
| Philosopher / Evaluator / RolloutReviewer Runner | Dreamer + Scribe 产出粗糙但人工审批可纠正；这 3 个 Runner 是"质量打磨链" |
| GFI (Global Friction Index) | 内部决策有用，但用户不可见，不在故事 A' 内 |
| Focus History 详细注入 | 让 prompt 更"聪明"但更不可解释。MVP 的 prompt 注入应该可读、单一原则 |
| Thinking OS injection | 同上 |
| Empathy keyword matcher | 同上 |
| Layer 3 信号源 `empathy_inferred` | 推断本身可能错；保留 explicit user_correction |
| Shadow Observation / Local Worker Routing | OpenClaw 内部优化，外部用户不可见 |
| Central Sync Service | 跨工作区，MVP 单 workspace |
| message-sanitize hook | COMPONENTS.md 自标"建议删除" |
| Trajectory Collector（默认开关）| 评估后决定；如果 PainChain 不依赖则关闭 |
| **skill 通道** + SkillFileWriter | 尚未实施且没有客户验证；仅在需求被观察后重新评估 |

### 2.6 MVP-Gone 清单（删除/归档）

| 子系统 | 处理 |
|-------|------|
| Nocturnal Trinity / Arbiter / Service / Artificer | ADR-0012 已决定退役（PRI-227~231）|
| OpenClaw IdleTrigger / sleep cycle / night mode | 同上 |
| Evolution Worker | 同上 |
| Trainer Runner / model_training 通道 / TrainingExporter (待建) | LoRA 不在 MVP 故事内 |

## 3. Implementation MVP Track（取代 Phase 1C/1D）

按 docs/plans/2026-05-roadmap/07-mvp-first-pivot.md §5 执行：15 个 issue / docs，4-6 周。

```
Week 1-2: 减法 + 三个已实现通道闭环验证
  PRI-252  control-plane convergence（修正文档与 Linear 路由）
  PRI-239  可加载 feature flags + MVP-Quiet 关闭
  PRI-240  proven-channel synthetic 冒烟
  PRI-242  Nocturnal / idle-trigger 退役协调

Week 3-4: 用户旅程 + proven-channel 演示
  PRI-243  stretch checkpoint：仅在真实需求存在时提出 SkillFileWriter
  PRI-244  pd-console proven-channel 审批 UI
  PRI-245  pd-console 三页化
  PRI-246  Demo workspace + 故事 A' proven-channel 场景

Week 5-6: 安装 + 邀请
  PRI-247 pd-cli 一键安装
  PRI-248 GETTING-STARTED 用户视角重写
  PRI-249 故事 A' 录屏 + 文字
  PRI-250 多环境冒烟
  PRI-251 邀请第一个种子客户
```

## 4. ADR-0006 (5-channel activation) 关系澄清

ADR-0006 的 5 通道设计**不变**。本 ADR 仅调整 MVP 优先级：

| 通道 | ADR-0006 状态 | MVP 状态 |
|------|--------------|---------|
| prompt | Active | MVP-Core |
| defer_archive | Active | MVP-Core |
| skill | 待建 | **MVP-Quiet / Stretch**（不阻塞首次客户邀请）|
| code_tool_hook (RuleHost) | Active (基础)| MVP-Core |
| model_training | 待建 | **MVP-Gone**（不在 MVP）|

ADR-0006 的不变量（所有人工审批、二次确认、shadow mode）全部保留。

## 5. AGENTS.md 强制约束（落地后）

每个新 issue 在 PR 启动前必须答 **MVP 三问**：

1. **不做会怎样？** 30 天后还有人提吗？如果答不出，issue 拒收。
2. **怎么观察？** 实施后用户怎么验证它在工作？UI 看？CLI 命令？日志？无可观察方式拒收。
3. **怎么关闭？** 实施后如果发现不好用，关闭路径？feature flag 还是 PR revert？只能 revert 的必须带 flag 一起来。

`PRI-239` 落地生产可读取、可测试的 feature flag registry 之前，不新增功能面；bugfix、验证、文档和 legacy retirement 不要求虚构 flag 文件。`PRI-239` 合并后，每个新功能在 commit 前必须在 `feature-flags.yaml` 注册，且 loader/test 必须证明 flag 实际生效。

## 6. ADR-0013 (Attribution Pipeline) 处置

ADR-0013 标记为 **Superseded by ADR-0014 — Deferred**：

- 状态从 Proposed → Deferred
- 概念保留作为未来回顾输入
- 实施重启条件：见 docs/plans/post-mvp-conditional-roadmap.md（满足 ≥3 个种子客户使用 ≥1 月 + 客户反馈"原则越来越多变慢"+ active count 稳定 ≥10）
- 在重启条件满足前，禁止任何 issue 引用 ADR-0013 要求即时实施

## 7. PD_System_Dynamics_Model v2.0 处置

v2.0 引入的 R4 Attribution Loop / R5 Conflict Detection / PRRR 北极星指标 / 8 杠杆排序，**全部标记为 deferred concepts**。v1.0 概念蓝图（R1/B1/R3）保留作为产品哲学叙事使用。重启条件同 ADR-0013。

## 8. Consequences

### Positive

- 复杂度立即停止增长
- MVP-Quiet 关闭后用户/维护者认知负担降低
- 4-6 周内具备真实外部反馈能力，不以新通道开发阻塞邀请
- "下线机制"从隐性变显性
- 故事 A'（行为品格内化）保留 PD 的差异化定位

### Negative / Cost

- 已落地的 Philosopher / Evaluator / RolloutReviewer 维护成本短期不消失（只是 flag 关闭）
- 暂不实现 SkillFileWriter 可能让首次演示少一个主动工作流出口；客户需求出现后再投资
- pd-console 三页化需要回退 / 隐藏现有页面，可能临时影响维护者本人体验
- 需要严格执行"MVP 三问"，否则会被新提案绕过

### Neutral

- ADR-0008/9/10/11/13 全部 deferred 而非取消，未来路径保留
- v2.0 系统动力学概念保留为思考资产

## 9. Anti-patterns Prevented

本 ADR 同时预防几种已观察到的反模式：

1. **"完整性焦虑"驱动的功能扩张** — MVP-Quiet 用 flag 而非删除化解
2. **"为未来铺路"的抽象超前** — MVP 三问中的"不做会怎样"压制
3. **AI 助手快速产出导致的复杂度膨胀** — 三档分类强制 PR scope
4. **后端无 UI 验证盲飞** — Demo workspace + pd-console 三页化解决
5. **下线机制缺失** — PRI-239 落地后由 feature-flags.yaml loader/test + AGENTS.md 三问约束

## 10. References

- docs/plans/2026-05-roadmap/07-mvp-first-pivot.md (本 ADR 的执行文档)
- docs/plans/post-mvp-conditional-roadmap.md (deferred 工作的重启条件表)
- ADR-0006 (5-channel activation, 优先级被本 ADR 调整)
- ADR-0013 (Attribution Pipeline, 被本 ADR superseded)
- ADR-0012 (Runtime V2-only, 仍生效；Nocturnal 退役继续)

---

## Amendment (2026-05-30): Promotion of Empathy Observer & Correction Observer to MVP-Core

### Context & Justification
During real-world execution testing of MVP Story A', it was observed that **deterministic programmatic pain signals (such as simple command failures or hard exceptions) are extremely hard to trigger in regular user-assistant conversational scenarios**. This sparse trigger rate makes behavior internalization slow to manifest, creating an observation gap for the initial MVP evaluation.

To resolve this bottleneck, we have promoted the **Empathy Observer** (previously classified as MVP-Quiet) and **Correction Observer** (previously part of the retired nocturnal pipeline, now re-designed as an active SDK-level periodic optimizer) to **MVP-Core**.

- **Empathy Observer**: Uses LLM semantic analysis in the background of conversational prompts to extract high-quality emotional friction and frustration keywords from user messages. This reactively captures frustration patterns that traditional programmatic error-catchers miss completely.
- **Correction Observer**: Periodically reviews SQLite trajectory history to automatically adjust keyword weights and decay false positives, ensuring trigger accuracy continuously remains self-correcting. Now runs as an **independent service** (not on evolution heartbeat) per PRI-293.

### Reclassified Items
1. **Empathy Observer**: Reclassified from **MVP-Quiet** to **MVP-Core** (wired asynchronously in the prompt build hook).
2. **Correction Observer**: Reclassified from **MVP-Gone** (as nocturnal workflow) to **MVP-Core**. Originally triggered on evolution heartbeat; extracted to an independent service with its own feature flag (`correction_observer`, core, default on) per PRI-293, so it no longer depends on the default-off EvolutionWorker.
