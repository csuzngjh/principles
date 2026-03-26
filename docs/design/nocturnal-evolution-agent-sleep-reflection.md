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
