# Post-MVP Conditional Roadmap

> **Status**: Active
> **Date**: 2026-05-24
> **Owner**: ADR-0014 (MVP-First Strategy)
> **Purpose**: 给所有"概念正确但当前不实施"的工作一个明确的**重启条件**和**预期收益**。任何 AI 助手或维护者在想"启动 X"前，必须先核对本表的触发条件是否真实满足。

## 0. 使用规则

1. 本文档的工作**全部默认状态：Hold**。唯一例外是 Owner 以带 `mvp-exception` 的权威工单明确批准并在本文件记录的窄范围工作；例外不表示原重启条件已经满足。
2. 启动前必须满足"重启条件"全部 bullets；按第 1 条记录的 Owner `mvp-exception` 仅豁免其明确范围
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

---

## 19. 长跑服务替代（PRI-521）

> **Source**: Codex 适配过程中识别的衍生工作
> **Added**: 2026-08-12
> **Linear**: PRI-521 (Backlog)

**Hold reason**: MVP 阶段 OpenClaw 通过 EvolutionWorker 后台服务实现长跑 pain→principle 提炼。Codex CLI 无原生长跑服务，MVP 阶段通过 `pd-hook.js` + `PostToolUse async: true` 做最佳努力。真正的长跑服务替代需要验证 Codex 原生机制（Memory 流水线 / Goals / subagent）是否可复用。

**重启条件**（**全部满足**才启动）:
- [ ] Codex MVP 适配（PRI-278~282）已合并并运行 ≥ 1 个月
- [ ] 至少 1 个种子客户反馈"principle 提炼没跑完就中断了"或"跨会话不记得提炼进度"
- [ ] §18.2 Memory 两阶段流水线 Spike 已完成，确认 Codex Memory API 可用
- [ ] 至少 1 次出现"长任务被中断后重启从零开始"的真实事故

**启动后预期收益**:
- 解决 Codex 无长跑服务的根本缺口
- principle 提炼可跨会话续跑
- 架构与 Codex 原生对齐，减少维护成本

**估时**: 2-3 周（含 Memory 流水线集成或自建后台服务）

**关联**: §18.2；CODEX_CLI_ADAPTER_SPEC §11.2 策略 2

---

## 20. 16 个 Slash 命令迁移到 pd-cli（PRI-522）

> **Source**: Codex 适配过程中识别的衍生工作
> **Added**: 2026-08-12
> **Linear**: PRI-522 (Todo)

**Hold reason**: MVP 阶段 OpenClaw 通过 plugin commands 注册 slash 命令（/pd-status, /pd-pain 等 16 个）。Codex CLI 无原生 slash 命令注册机制，MVP 阶段通过 `pd` CLI + `pd-hook.js` 内联响应做最佳努力。完整迁移需要统一命令接口设计。

**重启条件**（**全部满足**才启动）:
- [ ] Codex MVP 适配（PRI-278~282）已合并并运行 ≥ 1 个月
- [ ] 至少 1 个种子客户反馈"在 Codex 里找不到 /pd-status 命令"或"命令体验不一致"
- [ ] Codex Skills API 稳定（无 breaking change ≥ 2 个 minor 版本）
- [ ] pd-cli 已支持 `--json` 严格输出（cli-1-strict-json 验证通过）

**启动后预期收益**:
- 统一 OpenClaw / Codex / ChatGPT Web 三平台的命令接口
- 用户通过 `pd <command>` 或 `@pd <command>` 获得一致体验
- 借力 Codex Skills 实现 `@pd` 隐式调用（§18.5）

**估时**: 2-3 周（含 16 个命令的接口统一 + Codex Skill 封装）

**关联**: §18.5；CODEX_CLI_ADAPTER_SPEC §11.2 策略 6

---

## 21. ChatGPT/Codex 插件市场发布

> **Source**: `docs/architecture/CHATGPT_PLUGIN_MARKETPLACE_SPEC.draft.md`
> **Added**: 2026-08-12
> **Amended**: 2026-08-13
> **Linear**: [PRI-523](https://linear.app/principles-disciple/issue/PRI-523) (`mvp-exception`)
> **Status**: **Split — repository Marketplace + Workspace plugin active by Owner exception; public directory and advanced parity remain Hold**
> **Context**: Codex 0.147 supports repository/personal Marketplace installation and plugin-bundled lifecycle hooks. Public submission documentation currently confirms Skills/MCP types only and does not confirm lifecycle-hook plugins.

### 21.1 Active exception: repository Marketplace + Workspace plugin

The Owner explicitly approved this slice on 2026-08-12/13 after selecting "revise ADR, then share runtime." The old external-signal conditions were **not** satisfied; PRI-523 is the authority for this narrow exception.

**Active scope**:

- package the Codex adapter for repository/personal Marketplace installation;
- use default `hooks/hooks.json` or a manifest-declared hook path;
- use `PLUGIN_ROOT` for packaged code and `PLUGIN_DATA` only for plugin-private auxiliary data;
- preserve both selected-Workspace authority paths defined by `DATA_ARCHITECTURE.md`: `.pd/config.yaml` + `.pd/state.db` for config/Runtime V2 SQLite, and `.state/principle_training_state.json` + existing `.state/` runtime/host artifacts for the principle ledger and host evidence;
- require Owner hook review/trust before the three MVP-Core paths operate;
- deliver only prompt injection, before-tool RuleHost enforcement, and after-tool pain/evidence capture through the shared host runtime;
- retain `host.codex` as the Codex kill switch.

**Supported distribution order**: first validate through a repository/personal Marketplace. After that passes, a Workspace admin may publish the local plugin to selected Workspace roles. Workspace publication is organization-internal and is not evidence that the universal public directory accepts lifecycle-hook plugins.

**Runtime prerequisite**: PRI-523 declares Node.js `>=20` as the support baseline, installed separately. This does not claim current CI compatibility evidence. Before compatibility is claimed, installed-bundle, `codex-adapter`, and `host-runtime` package tests must be added and pass on Node 20 and Node 22. Marketplace and Workspace publication do not install Node. Setup/health must refuse activation with a structured reason and next action when Node is missing or unsupported.

**Observable acceptance / rollback**: repository-Marketplace install + trust must demonstrate all three paths in one Workspace and parity with OpenClaw, including an installed `PLUGIN_ROOT` path containing spaces; the same bundle must then be publishable by a Workspace admin to selected roles without changing either authority path. Fresh and migrated `.pd/config.yaml` files must explicitly contain `features.host.codex` (core/on) and `features.abstraction_layer_v1` (quiet/off), and loader tests must exercise both operator rollbacks instead of relying only on implicit defaults. `host.codex.enabled: false` must neutralize Codex hooks with a structured skip reason and without changing OpenClaw, `.pd/`, or `.state/` data. See ADR-0020 §10.5 for the exact contract.

### 21.2 Still Hold: public directory and advanced parity

The following work remains subject to external evidence and is not authorized by PRI-523:

- universal public-directory submission/review for a lifecycle-hook plugin (distinct from supported organization-internal Workspace publication);
- ChatGPT Web/Mobile feature parity through Skills or MCP;
- an MCP server, public Web commands, or automatic Skill activation;
- public-marketplace auto-update promises;
- additional-host distribution beyond OpenClaw and Codex Workspace use.

**重启条件**（**全部满足**才启动）:

- [ ] OpenAI public submission documentation explicitly accepts lifecycle-hook plugins (not only Skills/MCP)
- [ ] 至少 1 个种子客户明确需要 public-directory discovery or Web/Mobile parity
- [ ] Workspace and plugin-private data lifecycle/retention semantics have been verified
- [ ] The proposed Skill/MCP surface stays inside PRODUCT_IDENTITY and does not become general task execution or memory

**启动后预期收益**:
- repository Marketplace: 降低 Codex CLI/Desktop Workspace 安装摩擦（PRI-523 active）
- public directory, if later verified: improve discovery without overstating unsupported hook submission
- advanced parity, if later demanded: provide a deliberately scoped non-hook experience

**估时**: PRI-523 covers only repository Marketplace + Workspace plugin. Public submission and advanced parity must be re-estimated after their gates are met.

**关联**: `docs/architecture/CHATGPT_PLUGIN_MARKETPLACE_SPEC.draft.md`；§18.5 Codex Skill 分发

---

## 22. Shared host runtime / OpenClaw HostAdapter cutover (PRI-523)

> **Added**: 2026-08-13
> **Linear**: [PRI-523](https://linear.app/principles-disciple/issue/PRI-523) (`mvp-exception`)
> **Status**: **Active by explicit Owner exception**

**Original Hold reason**: ADR-0020 deferred an OpenClaw HostAdapter migration until MVP stability plus external second-host value, to avoid regressions in the only proven host path.

**Exception record**: those external-signal restart conditions were not met. The Owner nevertheless approved a narrow cutover after review showed the Codex adapter's business invocation remained allow-only and duplicating OpenClaw orchestration would create false installation success and host drift.

**Active scope**:

- create the shared I/O orchestration package `@principles/host-runtime`;
- make OpenClaw and Codex thin protocol adapters over it;
- share only prompt injection, before-tool RuleHost enforcement, and after-tool pain/evidence capture;
- preserve existing owner approval, workspace persistence, lineage, feature flags, and host-specific codecs/trust.

**Still Hold**:

- PRI-521 long-running service replacement;
- outbound Codex/host runtime execution;
- schedulers, daemons, general memory, tool repair/retry, and autonomous task/value decisions;
- any new activation channel or host beyond the PRI-523 contract.

**Rollback**: `host.codex` is the existing core/default-on Codex kill switch; §2.4's old quiet/default-off instruction is superseded. For OpenClaw, PRI-523 must register `abstraction_layer_v1` as quiet/default-off/since 2026-08-13: off = legacy orchestration, on = controlled shared-runtime parity validation. Promotion to core/default-on requires both OpenClaw parity and Codex E2E acceptance. Fresh/migrated `.pd/config.yaml` must persist both entries explicitly, and loader tests must prove each operator rollback. The legacy route remains so flag-off restores it without migration. Neither rollback may modify `.pd/` SQLite/config state or `.state/` ledger/runtime artifacts.

**Emotional value**: one authoritative Workspace plus observable host parity reduces **失控感 / 不信任感** and creates **掌控感 / 安心感**; a shared correction path reduces repeated cross-host maintenance **疲惫感** without adding Owner-facing noise.

**关联**: ADR-0020 §10; `docs/architecture/DATA_ARCHITECTURE.md`; `docs/architecture/CHATGPT_PLUGIN_MARKETPLACE_SPEC.draft.md`

---

## 23. Principle Working Set / 注意力治理层（Working Set Selector）

> **Source**: `docs/superpowers/specs/2026-08-22-principle-working-set-selector-spec.md`（v0.2，2026-08-22 代码核对修订）
> **Added**: 2026-08-22
> **Linear**: PRI-562（Phase 0，Todo）/ PRI-563（Phase 1）/ PRI-564（Phase 2）/ PRI-565（Phase 3）——均基于 SPEC v0.1 创建；实施前须按 §0 规则 4 补触发条件 checklist，并对照 SPEC v0.2 修订（见各工单 2026-08-22 评论）
> **Status**: Hold（Phase 0 观测子集可按 AGENTS.md「evidence collection」例外先行，见 SPEC §6）

**Hold reason**: MVP-First 暂停期内（ADR-0014 §2.5：新子系统默认 quiet/default-off；§6：架构演进暂停）。注入已有字符预算兜底（legacy 4000/1000 + v2 2000 字符），「原则噪声」问题在当前工作区尚未实际发生（2026-08-17 审计：0 条 live rule）。Selector 属新增 LLM 内部 Agent + 注入行为变更，属架构扩张，不在「证据收集」例外内。

**重启条件**（**全部满足**才启动 Phase 1 Shadow）:
- [ ] Phase 0 观测报告产出并经 Owner 确认：连续 ≥ 2 周、覆盖真实使用的注入统计（平均注入数 / 字符数 / 截断率 / 重复率）
- [ ] 观测数据显示问题真实存在：截断率 > 0，或单次注入原则数稳定 ≥ 10，或存在跨块重复注入
- [ ] `principle_receipt_ledger` + `principle_receipt_self_report` 已在观测工作区启用 ≥ 2 周并产出 presence/effect 记录（SPEC §13 依赖链）
- [ ] ≥ 1 个种子客户使用 PD ≥ 1 个月，或有 Owner 本人 dogfood 的等效证据链
- [ ] Owner 以带 `mvp-exception` 的权威工单明确批准 Phase 1 范围（参照 Dreamer L2 / Artificer L2 先例，ADR-0014 修正案 2026-06-16/17）

**Phase 2（Working Set 生效）额外条件**:
- [ ] Phase 1 shadow 数据显示 recall 达标、churn 受控、延迟/成本可接受（SPEC §13）
- [ ] 双路径 parity 测试（`abstraction_layer_v1` off/on）通过（SPEC §11，openclaw-shared-host-runtime-parity.feature 守护）

**启动后预期收益**:
- 预算截断从「按优先级和新旧」变为「按当前任务相关性」
- 减少 prompt 内原则 token 占用与重复，保护 Agent 注意力
- 为后续 Attribution（§1）提供选择质量数据

**估时**: Phase 0 约 2-3 天（可立即做）；Phase 1 约 1 周；Phase 2 约 1 周（验证后另计）

**关联**: SPEC `2026-08-22-principle-working-set-selector-spec.md`；§1 Attribution Pipeline（共享外部信号条件）；ADR-0014 §2.5

---

## 24. Codex Governance Closure — 对话观察治理闭环（Slices A–D + R1）

> **Source**: `docs/superpowers/specs/2026-08-28-codex-governance-closure-spec.md` rev 2（PR #1437，merge `00eabfc7`）；G0+G2A decision package（PR #1440，merge `9af500d2`）；G1 probe report `docs/architecture/CODEX_G1_CONTRACT_PROBE_REPORT.md`
> **Added**: 2026-08-29（Owner 批准于 2026-08-28）
> **Linear**: [PRI-617](https://linear.app/principlesdisciple/issue/PRI-617) / [PRI-618](https://linear.app/principlesdisciple/issue/PRI-618) / [PRI-619](https://linear.app/principlesdisciple/issue/PRI-619) / [PRI-620](https://linear.app/principlesdisciple/issue/PRI-620)（`mvp-exception`）
> **Status**: **Active by explicit Owner exception — 仅限冻结 SPEC 定义的窄闭环**

### 24.1 Exception record

外部信号重启条件未满足。Owner 于 2026-08-28 以原话「允许，我认为这个是要获得高质量的原则必须付出的代价」显式批准 bounded Codex conversation ingestion MVP exception，批准绑定 SPEC rev 2 与 G0/G2A decision package（逐字记录：Linear PRI-617 评论 `26ebf355`、PRI-619 评论 `63e9f9c4`）。ADR 权威修订见 ADR-0020 §11。

### 24.2 Active scope（冻结 SPEC 的 Slice 划分）

- Slice A — Host Observation Interface & Bounded Storage
- Slice B — Signal Admission, Canonical Pain & Diagnostician Continuation
- Slice C — Companion Worker & Recovery
- Slice D — Owner Experience & Governance Closure
- R1 — Consent UX Verification / Installed Rollout Gate

边界与控制（不可在实施中扩张）：ingestion 只读 authenticated Workspace hook 明确提供的 transcript；unpromoted 保留 ≤ 32 visible turns/rollout 且 ≤ 7 天；promotion ≤ 12 preceding turns + trigger + next completed assistant turn；`codex_conversation_ingestion` quiet flag 默认 off；consent 按 G2A 冻结披露文本（Slice D 呈现、R1 验证）；canonical pain 唯一 authority 不变（`production-pain-evidence.ts` + `pain_events.canonical_pain_id`）；OpenClaw cooldown 语义不变（ADR-0020 §11.3 兼容决策）。

### 24.3 Still Hold / 明确未被本例外批准

- general Codex memory pipeline —— §18.2 保持 Hold：本例外只授权其依赖的窄 Companion worker，不解锁 Memory 两阶段流水线本身；
- §19 长跑服务替代（PRI-521）的其余范围 —— 不因此重启；
- generic long-running daemon platform / 第二个长期服务体系；
- arbitrary transcript scanning（含 `$CODEX_HOME/sessions` 全盘扫描/猜最新 session）；
- session replay / full-text search / bulk transcript export 产品形态；
- 任何自动 Owner approval。

### 24.4 Rollback

运行时三层：`codex_conversation_ingestion = false`（即时停止读取 transcript）→ `internalization_auto_consumer = false`（暂停自动执行）→ `host.codex = false`（Codex 全停）。文档层回滚 = revert 本条目与 ADR-0020 §11（均无 runtime 行为）。

### 24.5 关联

ADR-0020 §11；`docs/architecture/CODEX_G1_CONTRACT_PROBE_REPORT.md`；`docs/superpowers/specs/2026-08-28-codex-governance-closure-g0-g2a-decision.md`；SPEC §20（delivery slices）；SPEC §3（gates）
