# Post-MVP Conditional Roadmap

> **Status**: Active
> **Date**: 2026-05-24
> **Owner**: ADR-0014 (MVP-First Strategy)
> **Purpose**: 给所有"概念正确但当前不实施"的工作一个明确的**重启条件**和**预期收益**。任何 AI 助手或维护者在想"启动 X"前，必须先核对本表的触发条件是否真实满足。

## 0. 使用规则

1. 本文档的工作**全部默认状态：Hold**
2. 启动前必须满足"重启条件"全部 bullets
3. 启动前必须更新本文档，把"启动状态"改为 In Progress 并附时间戳和触发证据
4. 任何 Linear issue 引用本表的工作时，issue 描述必须包含触发条件验证 checklist
5. 6 个月不重启的工作进入 **annual review**：判断是否仍然 relevant；如不 relevant 则关闭

---

## 1. Attribution Pipeline / PRRR 体系（原 PRI-232 大版本）

**Hold reason**: 没有真实使用数据时构建会变 mock；MVP 阶段用人工审批替代自动归因。

**重启条件**（**全部满足**才启动）:
- [ ] ≥3 个种子客户使用 PD ≥ 1 个月
- [ ] 至少 1 个客户明确反馈："PD 加了原则但没用" 或 "原则越来越多让 LLM 变慢"
- [ ] 客户工作区 active principle 数量稳定 ≥ 10
- [ ] 至少 50 个真实生产 painId 已被处理（非 synthetic）

**启动后预期收益**:
- 让"无效原则自动归档"成为产品差异化卖点
- 解决"长期使用后系统臃肿"问题
- L1 容量自动收敛到"实际有效原则集"
- Pruning 决策从启发式变为实证驱动

**关联文档**: ADR-0013（已 Superseded but Deferred）；PD_System_Dynamics_Model.md v2.0（deferred concepts）

**估时**: 2-3 周（启动时基于实际反馈重新拆 issue）

---

## 2. WorkspaceLearningSummary（原 PRI-233）

**Hold reason**: Diagnostician 当前已经够用；跨会话记忆是优化，不是必需。

**重启条件**:
- [ ] Attribution Pipeline 已重启并运行 ≥ 1 个月（即 §1 的依赖）
- [ ] Diagnostician 输出已被 ≥ 2 个种子客户在工单/反馈中明确说"重复了"或"没记忆"
- [ ] 至少 3 个 painId 在历史日志中显示反复触发同类 diagnosis

**启动后预期收益**:
- Diagnostician 跨会话不重复发明同类原则
- 减少 Diagnostician token 消耗
- 让 PD 表现出"持续学习"的可见特征

**估时**: 1-1.5 周

---

## 3. Bundled vs Evolved provenance（原 PRI-234）

**Hold reason**: 没卡到 cap 之前是装饰；当前 cap=12 远未触及。

**重启条件**（任一满足即可）:
- [ ] active principles 数量在某个工作区稳定 ≥ 10 持续 ≥ 2 周
- [ ] 至少 3 次发生 LRU 自动驱逐
- [ ] 种子客户报告"我添加的原则被自动删了"或"我搞不清哪个是 PD 自带的"

**启动后预期收益**:
- 用户演化的原则与 PD 出厂原则可区分
- LRU 驱逐策略可优先保留用户演化产物
- 后续 Attribution 能干净地只对 evolved 生效

**估时**: 1 周

---

## 4. Activation Probation Window（原 PRI-235）

**Hold reason**: 没有真实事故前是 over-engineering。

**重启条件**:
- [ ] 出现过 ≥ 1 次"approve 后立即发现是 false positive"的真实事故
- [ ] 维护者或种子客户反馈"批准后想反悔但找不到入口"

**启动后预期收益**:
- approve 操作有反悔窗口（默认 50-100 工具调用）
- 降低 RuleHost 通道的部署风险
- 与 Attribution（如果已重启）联动实现自动 promote/archive

**估时**: 1-1.5 周

---

## 5. Pruning Action MVP via Attribution（原 PRI-236）

**Hold reason**: 完全依赖 Attribution Pipeline。

**重启条件**:
- [ ] §1 Attribution Pipeline 已重启并通过 ≥ 30 天 shadow mode + ≥ 50 verdicts + 抽样 false positive < 5%
- [ ] §3 Bundled provenance 已重启并完成 backfill

**启动后预期收益**:
- 完整的 R3 Decoupling Loop 闭合
- 自动减少 prompt 容量压力
- 取代当前的人工 Pruning Action 待办

**估时**: 1 周

---

## 6. Internalization 完整 7-Runner 链路（Philosopher / Evaluator / RolloutReviewer 重启）

**Hold reason**: MVP 用 Dreamer + Scribe + Artificer + 人工审批就够；这 3 个 Runner 是质量打磨链。

**重启条件**:
- [ ] 种子客户反馈"原则太粗糙"或"想看到原则的多版本演化"
- [ ] 维护者发现 Dreamer 输出的 candidate 在审批阶段被拒绝率 > 30%
- [ ] 至少 1 次出现"两个候选原则相互矛盾，需要 RolloutReviewer 仲裁"的场景

**启动后预期收益**:
- 自动化原则质量打磨
- 降低人工审批工作量
- 支持原则多版本对比

**估时**: 已落地，仅需 flag 翻开 + 流程验证 1 周

---

## 7. BALM — Built-in Agent Lifecycle Manager（ADR-0008）

**Hold reason**: 当前所有 Runner 用单一 PDRuntimeAdapter；多 backend 不在 MVP 演示路径。

**重启条件**:
- [ ] 种子客户主动要求："我能不能换 Claude / Gemini 跑 Diagnostician"
- [ ] 支持的代理后端 ≥ 3 个有真实需求
- [ ] 至少 1 个客户因为 backend 限制选择不使用 PD

**启动后预期收益**:
- 多 backend 解耦
- 内置 Agent 可声明式版本化管理
- Prompt 集中治理

**估时**: 2-3 周（含至少 2 个 RuntimeAdapter 实施）

---

## 8. LRAS — Long-Running Agent Session（ADR-0009）

**Hold reason**: 没遇到 Diagnostician 超时事故前是空抽象。

**重启条件**:
- [ ] 种子客户报告"Diagnostician 跑到一半超时"≥ 2 次
- [ ] 真实生产 trajectory 显示某个 task 自然耗时 > 5 分钟
- [ ] 至少 1 次出现"长任务被中断后重启从零开始"的事故

**启动后预期收益**:
- 长程 Agent 会话（小时级）
- 检查点恢复
- Self-validation tools

**估时**: 2-3 周

---

## 9. GAP — Goal-Aligned Pain + Mission/Objective（ADR-0010）

**Hold reason**: 没有用户输入 OKR 时是 mock；Layer 3（empathy + tool failure）当前已够用。

**重启条件**:
- [ ] 种子客户主动要求"我希望 PD 能根据我的 OKR 判断哪些 pain 重要"
- [ ] 至少 1 个客户已在使用 PD 时手动维护过类似目标列表
- [ ] PainSignal 总量 > 100/天（噪声达到值得过滤的阈值）

**启动后预期收益**:
- 反思噪音大幅减少
- 集中算力解决战略级痛点
- 系统具备目标感

**估时**: 2-3 周（含数据模型 + GAPSignalGenerator）

---

## 10. MissionScheduler 三层任务模型（ADR-0011）

**Hold reason**: 当前 PRI-162 的 PD-owned explicit scheduling 已满足 Runtime V2 执行需求。

**重启条件**:
- [ ] 同时存在 ≥ 3 个并发 mission
- [ ] 出现过任务依赖死锁或饥饿事故
- [ ] §9 GAP 已重启且产出 Mission 实体

**启动后预期收益**:
- DAG 任务调度
- 优先级抢占
- Mission 状态自动收敛

**估时**: 2-3 周

---

## 11. TrainingExporter / LoRA model_training 通道

**Hold reason**: MVP 故事 A' 不涉及微调；当前是科研项目 vibe。

**重启条件**:
- [ ] 种子客户中 ≥ 1 个有真实微调需求
- [ ] 数据量积累 ≥ 1000 个高质量样本
- [ ] 维护者已就模型部署 / 评估 / 回滚有明确策略

**启动后预期收益**:
- 完整 L3 内化路径
- 行为品格固化到模型权重

**估时**: 3-4 周（含外部训练系统集成）

---

## 12. Skill 通道之外的高级 skill 管理（自动 skill 命名 / skill 合并 / skill 版本控制）

**Hold reason**: MVP 只演示"PD 把 Principle 写成 SKILL.md"；高级管理需要使用反馈。

**重启条件**:
- [ ] SkillFileWriter 已上线 ≥ 1 月
- [ ] 至少 1 个工作区累计 skill 数量 > 5
- [ ] 种子客户反馈"skills 多了之后管理混乱"

**启动后预期收益**:
- skill 自动版本化
- 跨 skill 合并 / 拆分

**估时**: 1-2 周

---

## 13. 监督学习与归因诊断的高级特性（CertifiedAgentOutput / Shadow contracts / 等）

**Hold reason**: 现有 PRI-204 在 Backlog；属于"为未来铺路"的抽象。

**重启条件**:
- [ ] 种子客户中有人在用 GoldenTrace 系统
- [ ] 至少 1 次发生 GoldenTrace 验证失败但 LLM 输出是"看起来对"的场景
- [ ] §1 Attribution Pipeline 已重启

**启动后预期收益**:
- LLM 输出可作为 shadow evidence 而非 authoritative
- 归因信号可结合代理自陈

**估时**: 2-3 周

---

## 14. 跨工作区 Attribution / 中央 Sync / 多用户协作

**Hold reason**: MVP 单工作区；多用户场景属于 Phase 3+。

**重启条件**:
- [ ] 种子客户中有团队级用户（≥ 2 人共享 PD 配置）
- [ ] §1 Attribution 已运行
- [ ] 至少 1 次出现"我这个 workspace 有的原则在另一个 workspace 没有"的事故

**启动后预期收益**:
- 团队级原则共享
- 跨工作区 PRRR 聚合

**估时**: 4-6 周（含数据同步协议设计）

---

## 15. Trajectory Loop / Stall Observer（轨迹循环与停滞观测器）

**Hold reason**: MVP-First 阶段聚焦于基础的痛苦信号（Empathy + Tool Failure）。由于检测轨迹死循环的 LLM 提示词和准确率尚未被验证，需要先通过 Spike 实验确认可行性，并且在有大量长轨迹运行导致 Token 消耗或卡死的真实痛点时启动，避免过度设计。

**重启条件**（**全部满足**或**有真实痛点触发**才启动）:
- [ ] 开展 Spike 实验：使用 `EmpathyObserver` 相同的模式，编写实验性 Prompt，在 ≥10 个真实的 Agent 死循环案例和 ≥10 个正常探索案例上进行离线测试，LLM 判定准确率达到 ≥85%。
- [ ] 出现过真实死循环浪费大量 Token 或超时的事故。
- [ ] 宿主或环境变量已配置了支持高频、廉价异步调用的模型后端（如 DeepSeek 或本地 Ollama）。

**启动后预期收益**:
- 在 Agent 陷入死循环（如重复执行相同命令、格式化错误重试、陷入局部最优）时，能够低延迟、低成本地捕获到 `trajectory_stall` 痛苦信号，触发反思与自愈，避免 Token 浪费。

**估时**: 3-5 天（复用 `EmpathyObserver` 和 `AgentScheduler` 机制，不构建新框架）

---

## 16. Annual Review 流程

每年 5 月（项目年度起点）执行：

1. 对每个 Hold 工作核对触发条件
2. 6 个月连续未触发的工作 → 评估是否永久关闭
3. 触发条件已变化的 → 修订条件
4. 新增 Hold 工作 → 加入本文档（必须有触发条件）

---

## 17. 反模式警告

以下情况 **不**算重启条件满足：

- ❌ "我觉得现在该做了"
- ❌ "AHE 论文又出了新进展"
- ❌ "我 review 代码时觉得这块缺失"
- ❌ "为了下个 Phase 铺路"
- ❌ "这个 ADR 当时是 Accepted 的，应该实施"

只有 **从外部用户来的真实信号** 才算触发。维护者自己的"洁癖驱动" / "完美主义驱动" 全部不满足触发条件。

---

## 18. Codex 价值最大化：7 条战略建议（GPT-5.6+ 时代）

> **Source**: `docs/architecture/CODEX_CLI_ADAPTER_SPEC.md` §11.2
> **Added**: 2026-08-11
> **Context**: Codex MVP 适配（PRI-278~282）落地后，如何让 PD 借力 Codex 原生能力（Guardian / Memory 流水线 / Ultra reasoning / Subagent roles / Skills / Goals）发挥 GPT-5.6+ 模型最大价值。**这些策略全部默认 Hold，不纳入 MVP 工单。**

### 18.1 Guardian 作为 PD principle 执行层

**Hold reason**: MVP 阶段 PD 用 `PreToolUse` + `permissionDecision: "deny"` 自己 block；Guardian 集成需要验证 Codex Guardian API 稳定性和 `codex-auto-review` 模型质量。

**重启条件**（**全部满足**才启动）:
- [ ] Codex MVP 适配（PRI-278~282）已合并并运行 ≥ 1 个月
- [ ] 至少 1 个种子客户反馈"PD block 的理由不够智能"或"想要更精细的审批策略"
- [ ] Codex Guardian API 稳定（无 breaking change ≥ 2 个 minor 版本）
- [ ] Spike 实验：用 `codex-auto-review` 模型对 ≥ 20 个真实 pain signal 审批，准确率 ≥ 85%

**启动后预期收益**:
- PD principle block 质量直接受益于 GPT-5.6 + `codex-auto-review` 模型升级
- 借力 Guardian 熔断器（CyberModel policy 1 次就熔断）做高风险行为变更防护
- 减少 PD 自有 LLM 调用开销

**估时**: 1.5-2 周

**关联**: SPEC §11.2 策略 1

---

### 18.2 借鉴 Memory 两阶段流水线重构 pain→principle pipeline

**Hold reason**: MVP 用单阶段 EvolutionWorker（且 Codex 上需先解决长跑服务替代，见隐藏工单 A）。

**重启条件**:
- [ ] Codex MVP 适配已合并
- [ ] 长跑服务替代方案（隐藏工单 A）已落地
- [ ] 至少 1 个种子客户反馈"principle 提炼太慢"或"跨会话不记得之前的提炼"
- [ ] Spike 实验：Codex Memory 两阶段流水线在 ≥ 50 个 rollout 上验证 pain→principle 转化质量

**启动后预期收益**:
- 解决 Codex 无长跑服务的根本缺口
- principle 提炼蹭到 GPT-5.6 code_mode_only 优化
- 架构与 Codex 原生对齐，减少维护成本

**估时**: 2-3 周

**关联**: SPEC §11.2 策略 2；隐藏工单 A

---

### 18.3 Ultra reasoning 4 智能体并行多维 pain 分析

**Hold reason**: 单模型串行分析在 MVP 阶段够用；4-agent 并行需要验证 token 成本和聚合质量。

**重启条件**:
- [ ] 至少 1 个种子客户反馈"principle 提炼维度单一"或"漏判了某个维度"
- [ ] `reasoning_effort: "ultra"` 在 ≥ 20 个真实 pain signal 上验证 token 成本可接受（< 3x 标准）
- [ ] 4 个并行智能体的聚合策略通过 Spike 验证（语义/行为/历史/风险四维）

**启动后预期收益**:
- principle 提炼从"单模型串行 7 阶段"升级为"4 智能体并行多维"
- 直接受益于 GPT-5.6 ultra reasoning 能力
- 提炼质量显著提升

**估时**: 1-1.5 周

**关联**: SPEC §11.2 策略 3

---

### 18.4 PD peer-runners 映射 Codex subagent roles

**Hold reason**: MVP 阶段 PD 的 7 个 peer-runner 通过 `PDRuntimeAdapter` 统一调用；role 映射需要验证 Codex role 配置灵活性。

**重启条件**:
- [ ] Codex MVP 适配已合并
- [ ] 至少 1 个种子客户反馈"Diagnostician 用 mini 模型就够了"或"Artificer 需要更强模型"
- [ ] Codex subagent role 系统支持自定义 role（验证 `core/src/agent/role.rs`）

**启动后预期收益**:
- 每个 peer-runner 用最合适的模型（Diagnostician=mini, Artificer=sol, Evaluator=terra）
- 借力 Codex role 级 reasoning_effort / service_tier 配置
- 降低 token 成本（mini 模型 30% 配额）

**估时**: 1-1.5 周

**关联**: SPEC §11.2 策略 4

---

### 18.5 PD 打包为 Codex Skill（第二分发渠道）

**Hold reason**: MVP 阶段通过 plugin bundle 分发；Skill 分发需要验证 SkillMcpDependencyInstall 稳定性。

**重启条件**:
- [ ] Codex MVP 适配已合并并运行 ≥ 1 个月
- [ ] 至少 1 个种子客户反馈"plugin bundle 安装太复杂"或"想要 @pd 直接调用"
- [ ] Codex Skills API 稳定（无 breaking change ≥ 2 个 minor 版本）
- [ ] PD 的 MCP 依赖（Linear/GitHub）通过 SkillMcpDependencyInstall 自动安装验证

**启动后预期收益**:
- 降低安装摩擦（skill 安装 vs plugin bundle 配置 + trust）
- 蹭到 Codex skill 分发生态
- 支持 `@pd` 隐式调用（MentionsV2 默认 ON）

**估时**: 1 周

**关联**: SPEC §11.2 策略 6

---

### 18.6 Goals 系统挂载 principle 长期演进

**Hold reason**: MVP 阶段 principle 生命周期由 Ledger 管理；Goals 集成需要验证 Codex Goals API 稳定性。

**重启条件**:
- [ ] Codex MVP 适配已合并
- [ ] 至少 1 个种子客户反馈"想看到 principle 的长期演进轨迹"或"principle 失败了但不知道卡在哪"
- [ ] Codex Goals API 稳定（`ext/goal/` 无 breaking change）
- [ ] Spike 实验：principle 激活时创建 Goal，验证 `blocked` 需要 3 次连续失败的语义是否符合 PD 需求

**启动后预期收益**:
- principle 生命周期挂载到 Codex 原生 Goals 系统
- 借力 automatic goal continuation
- `budget_limit_steering_item` 在预算耗尽时让 agent 主动总结沉淀

**估时**: 1-1.5 周

**关联**: SPEC §11.2 策略 7

---

### 18.7 Annual review 特别条款

上述 7 条战略建议的触发条件**必须来自外部用户信号**，不得由维护者自行触发。每年 5 月 annual review 时，需额外检查：
- Codex 是否有 breaking change 导致某条策略不再可行
- 是否有新的 Codex 原生能力（如新 feature flag）可以借力
- GPT-5.x 模型升级是否改变了某条策略的成本收益比
