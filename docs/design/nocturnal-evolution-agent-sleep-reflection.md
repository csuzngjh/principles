# 智能体“睡眠反思”演化机制 (Nocturnal Evolution)

> **状态**: Proposal | **版本**: v1.0 | **日期**: 2026-03-26
> **核心目标**: 通过离线的多智能体思辨（Multi-Agent Debate），将抽象的思维模型（Principles）转化为具体的、可微调的行为轨迹（Behavioral Trajectories），抑制 LLM “上来就干”的冲动，固化专家级的长程规划习惯。

---

## 1. 背景与核心困惑

### 1.1 痛点
*   **原则失效**: 高度抽象的思维模型注入上下文后，对模型输出的影响随 Token 长度增加而稀释。
*   **行为惯性**: LLM 受 RLHF 影响，倾向于快速给出答案，而非进行深度调研和长程规划。
*   **量化难题**: 在 Open-ended 任务中，缺乏“金标准”来衡量一条行为轨迹的好坏。

### 1.2 核心假设
**人类思维模型 + 多角色思辨 = 具备“更高认知熵减”的理想轨迹。**
通过模拟人类“睡眠反思”的机制，在空闲时间对当天的操作进行复盘和重写，可以产生高质量的行为对齐数据，用于 LoRA 微调。

---

## 2. 架构设计：Nocturnal Evolution 工作流

该机制挂载于现有的 `EvolutionWorker` 和 `Heartbeat` 拦截器之上。

### 2.1 触发器：空闲检测 (Idle Detection)
*   **监控点**: `trajectory.db` 的全局最后活动时间 (`MAX(created_at)`)。
*   **触发条件**: `currentTime - lastActivityTime > 4h` 且当前无高优先级任务。
*   **动作**: 向 `EVOLUTION_QUEUE` 插入一个 `sleep_reflection` 类型的任务。

### 2.2 思辨链：三位一体角色定义 (The Trinity)

当任务被 `Heartbeat` 唤醒后，将派生以下子智能体：

| 角色 | 名称 | 职责 | 输入 |
|------|------|------|------|
| **Role A** | **Dreamer (回放者)** | 行为回溯与场景还原。将原始日志转化为连贯的决策叙事，标注决策点。 | `trajectory.db` 原始轨迹 |
| **Role B** | **Philosopher (原则官)** | 原则审计与合规检查。依据 `.principles/` 对每个决策点进行严苛审计，识别“冲动行为”。 | `THINKING_OS.md`, `PRINCIPLES.md` |
| **Role C** | **Scribe (记录员)** | 行为重塑与样本生成。重写轨迹，将审计意见转化为“理想的执行序列”，导出 LoRA 格式。 | A 和 B 的思辨记录 |

### 2.3 验证层：自动仲裁 (The Arbiter)
引入 **Arbiter (仲裁者)** 模型执行双盲评分：
*   **输入**: 原始轨迹 A vs 重塑轨迹 B。
*   **准则**: 哪个轨迹在面对任务时更体现了“调研先行、风险预判、严谨规划”？
*   **入库条件**: `Score(B) > Score(A) + 15%`。

---

## 3. 量化指标体系 (Metrics)

为了保障优化过程的透明度，设计以下三维度量化指标：

### 3.1 结构化合规指标 (Structural Alignment)
*   **思维深度比 (Thinking Ratio)**: `Σ(思考Token) / Σ(工具调用数)`。衡量模型是否“谋定而后动”。
*   **前置调研密度 (Pre-computation Density)**: 第一个修改类工具调用前的调研次数。
*   **规划确认点 (Plan Consistency)**: 轨迹中是否包含显式的 `PLAN.md` 更新与确认步骤。

### 3.2 原则依从度 (Principle Adherence) - 由 Arbiter 评分
*   **长程规划得分**: 轨迹是否体现了对后续步骤的预判。
*   **风险厌恶得分**: 在执行高危操作（如删除、覆盖）前是否进行了备份或验证。
*   **诊断诚实度**: 工具失败后是“盲目重试”还是“停下诊断”。

### 3.3 执行效率 (Execution Efficiency)
*   **错误纠正路径长度**: 从报错到修复所需的总步数。
*   **冗余操作率**: 剔除无意义的重复读取或 `ls` 操作。

---

## 4. 实施计划 (Implementation Plan)

1.  **Phase 1 (MVP)**:
    *   在 `packages/openclaw-plugin/src/service/` 下创建 `nocturnal-service.ts`。
    *   编写 `reflector.md` 和 `critic.md` 角色定义。
2.  **Phase 2 (Tooling)**:
    *   在 `TrajectoryService` 中增加 `exportToLoRA()` 方法。
    *   实现 `Arbiter` 自动打分逻辑。
3.  **Phase 3 (Training)**:
    *   定期将生成的 `.state/exports/lora_reflections/*.jsonl` 聚合。
    *   使用现有 LoRA 框架进行模型内化。

---

## 5. 预期影响

*   **习惯固化**: 智能体将形成“先调研、写计划、再执行”的肌肉记忆。
*   **自主演化**: 即使没有人类干预，系统也能通过自我思辨不断提升行为质量。
*   **透明可信**: 每一条微调轨迹都有对应的原则审计理由，解决了黑盒优化问题。

---

# 附录 A: 与现有 PD 代码集成矩阵

> **评审日期**: 2026-03-27 | **评审人**: main agent

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Nocturnal Evolution 集成矩阵                         │
├─────────────────────┬─────────────┬──────────────────────────────────────┤
│ 组件                │ 复用程度    │ 具体方案                              │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ trajectory.ts       │ ████████░░  │ 直接复用 listAssistantTurns()        │
│                     │ 80%         │ 复用 getDataStats().lastIngestAt     │
│                     │             │ 扩展 exportOrpoJsonl()               │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ thinking-models.ts  │ ██████████  │ 直接复用 detectThinkingModelMatches()│
│                     │ 100%        │ 无需修改                              │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ evolution-worker.ts │ █████░░░░░  │ 复用调度框架                          │
│                     │ 50%         │ 新增 taskType: 'sleep_reflection'    │
│                     │             │ 新增 checkIdleAndEnqueueReflection() │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ pain.ts             │ ███████░░░  │ 复用 pain 事件链                      │
│                     │ 70%         │ 扩展触发条件（空闲 → pain 信号）       │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ session-tracker.ts  │ ███░░░░░░░  │ 复用 getDailySummary()                │
│                     │ 30%         │ 新增 exportSessionTimeline()          │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ Arbiter 评分        │ ░░░░░░░░░░  │ 🆕 新建                               │
│                     │ 0%          │ nocturnal-arbiter.ts                  │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ Trinity 角色        │ ░░░░░░░░░░  │ 🆕 新建                               │
│ (Dreamer/Philosopher│ 0%          │ agents/dreamer.md                     │
│ /Scribe)            │             │ agents/philosopher.md                 │
│                     │             │ agents/scribe.md                      │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ 空闲检测            │ ░░░░░░░░░░  │ 🆕 新建                               │
│                     │ 0%          │ nocturnal-idle-detector.ts            │
├─────────────────────┼─────────────┼──────────────────────────────────────┤
│ ORPO 导出           │ ████░░░░░░  │ 扩展 exportCorrections()              │
│                     │ 40%         │ 新增 exportOrpoJsonl() 方法           │
└─────────────────────┴─────────────┴──────────────────────────────────────┘
```

## SDK 验证结果

| 检查项 | 结果 | 位置 |
|--------|------|------|
| `api.runtime.subagent.run()` 支持 `extraSystemPrompt` | ✅ | `openclaw-sdk.d.ts:68-76` |
| `trajectory.getDataStats().lastIngestAt` | ✅ | `trajectory.ts:37,891` |
| `llm_output` hook 存在 | ✅ | `PluginHookLlmOutputEvent` |
| `detectThinkingModelMatches()` | ✅ | `thinking-models.ts` |

---

# 附录 B: 评审发现的问题

## 高风险问题

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| **1** | Trinity 角色调用方式需验证 SDK | 设计文档使用 `extraSystemPrompt` 参数 | ✅ 已验证 SDK 支持 |
| **2** | 空闲检测数据源 | 需要确认 `lastIngestAt` 可用 | ✅ 已验证 trajectory.ts 有此字段 |
| **3** | Arbiter 15% 阈值无实证依据 | 设计承认"缺乏实证基础" | Phase 0 先收集 50+ 条数据确定阈值 |
| **4** | Token 截断策略 | 线性截断可能丢失高价值 turns | 需实现智能压缩（Phase 2） |

## 中风险问题

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| **5** | Phase 1 vs v3.0 范围不清晰 | 7 个增强措施未明确分配 | 见附录 C Phase 规划 |
| **6** | 可执行性验证层 Phase 分配不明 | 对防止"空中楼阁"至关重要 | 建议放入 Phase 1.5 |

---

# 附录 C: 建议的实施路线

```
Phase 0: 设计验证 (≤1 周)
─────────────────────────────
□ 跑数据统计脚本验证 session 长度分布
□ 手动模拟一次 Trinity 反思（用现有 session 数据）
□ 确定 Arbiter 初始阈值（通过 compositeImprovement 分布分析）

            ↓

Phase 1: MVP (2 周)
───────────────────
新增文件:
  src/service/nocturnal-service.ts         # 核心反思流程
  src/core/nocturnal-arbiter.ts            # 质量门禁
  agents/reflector.md                      # 单角色反思 Agent

修改文件:
  evolution-worker.ts                      # 新增 sleep_reflection 任务类型
  trajectory.ts                            # 扩展 exportOrpoJsonl()

功能:
  ✓ 空闲检测 → 入队 sleep_reflection
  ✓ 单 subagent 反思（非 Trinity 三角色）
  ✓ 基础指标计算 + Arbiter 门禁
  ✓ ORPO JSONL 输出
  ✓ 人工审核 10 条对比对

            ↓

Phase 1.5: 可执行性验证 (1 周)
─────────────────────────────────
新增文件:
  src/core/nocturnal-executability.ts      # 可执行性验证层

功能:
  ✓ 文件引用检查（路径是否存在）
  ✓ 工具合法性检查
  ✓ 步骤顺序验证（read 在 write 前）
  ✓ 失败时模糊化处理而非直接丢弃

            ↓

Phase 2: Trinity 增强 (3 周)
──────────────────────────────
新增文件:
  agents/dreamer.md                        # 回放者角色
  agents/philosopher.md                    # 原则官角色
  agents/scribe.md                         # 记录员角色
  src/core/nocturnal-metrics.ts            # 七维指标体系
  src/core/adaptive-threshold.ts           # 自适应阈值

功能:
  ✓ Trinity 三角色链式调用
  ✓ 七维代理指标计算
  ✓ 动态阈值自适应（通过率 40-60%）
  ✓ 智能压缩
  ✓ 跨 Session 模式注入

            ↓

Phase 3: 训练闭环 (持续)
─────────────────────────
新增文件:
  scripts/train_nocturnal.py               # Unsloth + ORPO 训练脚本
  scripts/export-gguf.py                   # 导出 GGUF 格式

功能:
  ✓ 积累 1K+ 高质量对比对
  ✓ RTX 4090 ORPO 训练 (VRAM < 20GB)
  ✓ A/B 测试验证微调效果
  ✓ 导出 GGUF + Ollama 部署
```

---

# 附录 D: Phase 1 MVP 任务清单

```yaml
Phase 1 MVP 任务拆解:

  1. 空闲检测模块 (2d)
     - [ ] 新增 nocturnal-idle-detector.ts
     - [ ] 复用 trajectory.getDataStats().lastIngestAt 判断空闲
     - [ ] 实现 shouldEnterSleepMode() 三重门卫逻辑
     - [ ] 配置默认值 idle_threshold_ms: 1800000 (30min)

  2. 队列集成 (1d)
     - [ ] EvolutionQueueItem 新增 taskType: 'sleep_reflection' | 'pain'
     - [ ] evolution-worker.ts 新增 checkIdleAndEnqueueReflection()
     - [ ] processEvolutionQueue() 增加 taskType 分发逻辑

  3. 反思服务 (3d)
     - [ ] 新增 nocturnal-service.ts
     - [ ] 实现 extractStructuredTrajectory() (复用 trajectory.ts)
     - [ ] 实现 singleAgentReflection() (单 subagent 版本)

  4. 质量门禁 (2d)
     - [ ] 新增 nocturnal-arbiter.ts
     - [ ] 实现 arbiterGate() 综合评分
     - [ ] 复用 detectThinkingModelMatches() 计算激活率
     - [ ] 初始阈值 15%，后续由 Phase 2 自适应

  5. ORPO 导出 (1d)
     - [ ] 扩展 trajectory.ts 新增 exportOrpoJsonl()
     - [ ] 输出 {prompt, chosen, rejected, metadata} 格式
     - [ ] 实现 token 截断 (max_trajectory_tokens: 2048)

  6. 测试与验证 (1d)
     - [ ] 单元测试: nocturnal-idle-detector.test.ts
     - [ ] 单元测试: nocturnal-arbiter.test.ts
     - [ ] 集成测试: 空闲 → 入队 → 反思 → 导出完整流程
     - [ ] 人工审核 10 条对比对
```

---

# 附录 E: 验收标准

## Phase 1 完成的定义

- [ ] Agent 空闲 30 分钟后，自动触发第一次反思
- [ ] 反思产出的 ORPO/DPO JSONL 文件格式正确、可被训练框架解析
- [ ] 反思后的思维模型激活率比原始轨迹高（用 detectThinkingModelMatches() 客观度量）
- [ ] 人工审核 10 条对比对，>7 条的 chosen 确实比 rejected 更好
- [ ] 不影响正常工作（不修改现有文件逻辑，只新增文件 + 修改 evolution-worker）
- [ ] 所有现有测试 npm test 通过

## Phase 2 完成的定义 (增强措施)

- [ ] AdaptiveThresholdManager 正常运行，Arbiter 通过率稳定在 40-60%
- [ ] 可执行性验证层拦截了 >30% 的不可执行改进轨迹
- [ ] 智能压缩保留了 >80% 的用户修正后 turns
- [ ] 跨 Session 模式注入正确运行，Philosopher 能引用历史弱点

## Phase 3 完成的定义

- [ ] 积累 1K+ 通过 Arbiter 门禁的高质量对比对
- [ ] 在 RTX 4090 上成功完成 ORPO 训练（VRAM < 20GB）
- [ ] 微调后模型的思维模型激活率 > 原始模型 30%
- [ ] A/B 测试中微调模型的 Thinking Ratio 显著高于原始模型
- [ ] 导出为 GGUF 并可通过 Ollama 部署

---

**Last updated**: 2026-03-27 | **新增附录**: A-E（集成矩阵、评审问题、实施路线、任务清单、验收标准）
