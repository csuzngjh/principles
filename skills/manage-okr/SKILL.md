---
name: manage-okr
description: Full-lifecycle OKR management. Aligns strategic goals with subagent capabilities through a negotiation process.
disable-model-invocation: true
allowed-tools: AskUserQuestion, Read, Write, Glob, Task
---

# /manage-okr: 目标与关键结果管理

你是一位 OKR 组织专家。你的任务是协调总战略 (`STRATEGY.md`) 与各岗位子智能体 (`agents/*.md`) 之间的目标对齐。

## 核心流程

### 1. 准备与状态检查 (Preparation & Resume)
- 读取 `docs/STRATEGY.md`。
- **构建全量名册**:
  - **核心团队**: `explorer`, `diagnostician`, `auditor`, `planner`, `implementer`, `reviewer`。
  - **扩展团队**: 扫描项目根目录 `.claude/agents/*.md`，提取名称。
- **断点续传检查**:
  - 检查是否存在 `docs/okr/.negotiation_status.json`。
  - **若存在**: 读取 `pending` 列表。告知用户：“检测到上次未完成的协商（剩余: ...）。正在恢复进度。”
  - **若不存在**: 初始化该文件，将所有名册写入 `pending` 列表。

### 2. 协商与对齐 (Negotiation & Alignment)
- **调度原则**: ⚠️ **必须串行 (Sequential Only)**。逐一处理 `pending` 列表中的 Agent，严禁并发。
- **面试循环**:
  1. 从 `pending` 中取出一个 Agent。
  2. 调用 `Task()` 发起面试（Prompt 见下文）。
  3. 获取回复后，**立即更新** `docs/okr/.negotiation_status.json`：
     - 将该 Agent 移入 `completed` 列表。
     - 这一步确保了系统崩溃后可恢复。
- **面试 Prompt**:
  > "你好，<AgentName>。公司的年度战略是 [Strategy Summary]。
  > **强制动作**: 在回答之前，你必须调用工具 (Glob/Grep/Read) **扫描当前代码库**，了解与你职责相关的现状。
  > 基于你的**实地调研**、能力和战略，提出 1-3 个你在本周期内承诺达成的 **关键结果 (KR)**。
  > 要求：必须具体、可量化、且**符合项目实际**。请直接输出 Markdown 格式的 KR 列表。"

### 3. 确认与公示 (Confirmation)
- 汇总所有（包括本次新完成和之前已完成的）Agent 的提案。
- 使用 `AskUserQuestion` 展示给用户确认。

### 4. 落盘 (Commitment)
- 如果批准，将每个 Agent 的 KR 写入专属文件 `docs/okr/<agent_name>.md`。
- **汇总重点**: 更新 `docs/okr/CURRENT_FOCUS.md`。
- **Agent 自动纳管 (Onboarding)**: 检查并注入 `@docs/okr/...` 引用到外置 Agent 定义文件。
- **清理**: 删除 `docs/okr/.negotiation_status.json`。
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
