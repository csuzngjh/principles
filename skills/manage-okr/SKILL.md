---
name: manage-okr
description: Full-lifecycle OKR management. Aligns strategic goals with subagent capabilities through a negotiation process.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Write, Glob, Task
---

# /manage-okr: 目标与关键结果管理

你是一位 OKR 组织专家。你的任务是协调总战略 (`STRATEGY.md`) 与各岗位子智能体 (`agents/*.md`) 之间的目标对齐。

## 核心流程

### 1. 准备 (Preparation)
- 读取 `docs/STRATEGY.md` (如果不存在，提示用户运行 `/init-strategy`)。
- 扫描插件目录下的 `agents/*.md` 获取所有在职员工。

### 2. 协商与对齐 (Negotiation & Alignment)
- **逐个面试**: 对每个 Agent，调用 `Task()` 工具发起一次询问。
- **面试 Prompt**:
  > "你好，<AgentName>。公司的年度战略是 [Strategy Summary]。
  > **强制动作**: 在回答之前，你必须调用工具 (Glob/Grep/Read) **扫描当前代码库**，了解与你职责相关的现状。
  > 基于你的**实地调研**、能力和战略，提出 1-3 个你在本周期内承诺达成的 **关键结果 (KR)**。
  > 要求：必须具体、可量化、且**符合项目实际**。请直接输出 Markdown 格式的 KR 列表。"
- **收集提案**: 获取每个 Agent 的回复。

### 3. 确认与公示 (Confirmation)
- 汇总所有 Agent 的提案，使用 `AskUserQuestion` 展示给用户。
- 询问：“这些 OKR 承诺是否合理？是否批准？”

### 4. 落盘 (Commitment)
- 如果批准，将每个 Agent 的 KR 写入专属文件 `docs/okr/<agent_name>.md`。
- **汇总重点**: 同时更新 `docs/okr/CURRENT_FOCUS.md`，列出当前最核心的 3 个 KR 指标，供主智能体常驻阅读。
- **Agent 自动纳管 (Onboarding)**: 
  - **检查并注入**: 你必须检查每个 Agent 的定义文件 (`.claude/agents/<agent_name>.md`)。
  - 如果文件中没有引用 `@docs/okr/<agent_name>.md`，你必须**主动修改**该 Agent 文件，在末尾追加引用。这确保了外置智能体（如新加入的 code-reviewer）也能感知其目标。
- **模板**:
  ```markdown
  # OKR: <agent_name>
  > Status: Active | Last Updated: [Date]
  
  ## Strategic Context
  - [Relevant Vision from STRATEGY.md]
  
  ## Committed Key Results
  - [KR 1 from Agent Proposal]
  - [KR 2 from Agent Proposal]
  ```

### 5. 进度复盘 (Check-in) - *Optional*
- 如果用户目的是复盘，则读取上述文件，询问用户当前进度，并更新文件中的完成度标记。

## 结项
输出：“✅ OKR 协商已完成。全员目标已对齐。”
