---
name: manage-okr
description: Full-lifecycle OKR management. Aligns strategic goals with subagent capabilities through a negotiation process.
disable-model-invocation: true
---

# /manage-okr: 目标与关键结果管理

你是一位 OKR 组织专家。你的任务是协调总战略 (`STRATEGY.md`) 与各岗位子智能体 (`agents/*.md`) 之间的目标对齐。

## 核心流程

## 执行原则 (The Principles)
1. **SMART 强制**: 所有的 KR 必须可量化、有边界、有时限。
2. **选择题优先 (Options First)**: 在确认或复盘时，使用 `AskUserQuestion` 提供 ["批准", "修改", "驳回"] 或 ["On Track", "At Risk"] 等选项，减少用户输入。
3. **职责对齐**: 自动识别 KR 应该归属于哪个维度（质量/架构/执行速度）。
4. **动态演进**: KR 是有生命周期的。通过此命令可以更新、完成或废弃 KR。
5. **治理协议强制**:
   - `Proposal` 是流程阶段，不是新增角色。
   - 提案者可以是主智能体或 OKR owner，但挑战者必须是不同智能体。
   - 最终执行计划必须通过 `AskUserQuestion` 获得 Owner 批准后才能锁定执行。

### 生命周期治理文件（必须维护）
- `docs/okr/WEEK_STATE.json`: 周状态机（DRAFT/CHALLENGE/PENDING_OWNER_APPROVAL/LOCKED/EXECUTING/REVIEW/CLOSED/INTERRUPTED）
- `docs/okr/WEEK_EVENTS.jsonl`: 执行事件流（task_started/heartbeat/blocker/task_completed）
- `docs/okr/WEEK_PLAN_LOCK.json`: Owner 批准后的锁文件

### 治理命令（推荐用脚本，减少手写错误）
```bash
python scripts/weekly_governance.py new-week --goal "<week goal>"
python scripts/weekly_governance.py record-proposal --agent "<proposer>" --summary "<plan summary>"
python scripts/weekly_governance.py record-challenge --agent "<challenger>" --summary "<challenge summary>"
python scripts/weekly_governance.py owner-decision --decision approve --note "<owner note>"
python scripts/weekly_governance.py status
```

### 1. 准备与状态检查 (Preparation & Resume)
- 读取 `docs/STRATEGY.md`。
- **构建全量名册**:
  - **核心团队**: `explorer`, `diagnostician`, `auditor`, `planner`, `implementer`, `reviewer`。
  - **扩展团队**: 扫描项目根目录 `.claude/agents/*.md`，提取名称。
- **断点续传检查**:
  - 检查是否存在 `docs/okr/.negotiation_status.json`。
  - **若存在**: 读取 `pending` 列表。告知用户：“检测到上次未完成的协商（剩余: ...）。正在恢复进度。”
  - **若不存在**: 初始化该文件，将所有名册写入 `pending` 列表。
- **周治理状态检查（新增）**:
  - 读取 `docs/okr/WEEK_STATE.json`（如果不存在，使用 `weekly_governance.py new-week` 初始化）。
  - 若 `stage=INTERRUPTED`，先组织恢复方案并与用户确认，再继续计划编排。

### 2. 用户承诺 (User Commitment) - *New*
- **转向用户**: 在面试子智能体之前，先与用户对齐。
- **提问**: 使用 `AskUserQuestion`。
  > "为了确保项目成功，除了 AI 团队的努力，也需要您的协同。
  > **您在本周期的个人 OKR 是什么？**
  > (建议方向：行为约束如'不改需求'、个人贡献如'完成设计稿'、或学习目标)"
- **落盘**: 将用户承诺写入 `docs/okr/user.md`。

### 3. 协商与对齐 (Negotiation & Alignment)
- **调度原则**: ⚠️ **受控并发 (Throttled Concurrency)**。每次最多并发委派 **2-3 个** Task，等待结果返回后再补充新的任务。严禁一次性发出所有请求以防终端卡死。
- **面试循环**:
  1. 从 `pending` 中取出一批 Agent (2-3个)。
 2. 调用 `Task()` 发起面试（Prompt 见下文）。
  3. 每获取一个回复后，**立即更新** `docs/okr/.negotiation_status.json`：
     - 将该 Agent 移入 `completed` 列表。
     - 这一步确保了系统崩溃后可恢复。
- **面试 Prompt**:
  > "你好，<AgentName>。公司的年度战略是 [Strategy Summary]。
  > **强制动作**: 在回答之前，你必须调用工具 (Glob/Grep/Read) **扫描当前代码库**，了解与你职责相关的现状。
  > 基于你的**实地调研**、能力和战略，提出 1-3 个你在本周期内承诺达成的 **关键结果 (KR)**。
  > 要求：必须具体、可量化、且**符合项目实际**。请直接输出 Markdown 格式的 KR 列表。"

### 3.5 反向挑战与比较（新增，必做）
- 从候选方案中选择一个提案者（主智能体或对应 OKR owner）输出 Proposal。
- 指派不同智能体输出 Challenge（至少 3 条批评 + 1 个替代方案）。
- 将 Proposal 与 Challenge 合并为 Final Plan 草案，并落盘到治理状态机：
  - `record-proposal`
  - `record-challenge`

### 3. 确认与公示 (Confirmation)
- 汇总所有（包括本次新完成和之前已完成的）Agent 的提案。
- 使用 `AskUserQuestion` 展示给用户确认（必须包含选项：`批准执行` / `继续修改` / `驳回重做`）。
- 根据用户选项更新治理状态：
  - `批准执行` -> `owner-decision approve`（生成 `WEEK_PLAN_LOCK.json`）
  - `继续修改` / `驳回重做` -> `owner-decision revise|reject`

### 4. 落盘 (Commitment)
- 仅在 `WEEK_PLAN_LOCK.json` 存在时进入本步骤。
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
- 同步读取 `docs/okr/WEEK_EVENTS.jsonl`，按事件流输出“本周完成 / 阻塞 / 进行中”摘要，避免遗忘。

## 结项
输出：“✅ OKR 协商已完成。全员目标已对齐。”
