---
name: evolve-task
description: Run the full evolution loop (triage → diagnosis → audit → plan → execute → review → log)
disable-model-invocation: true
---

你必须按顺序执行以下步骤（不得跳步）。ARGUMENTS: $ARGUMENTS

## Step 0: 恢复上下文（强制）
- 读取 memory/CHECKPOINT.md 的最后一条
- 读取 memory/ISSUE_LOG.md 的最近 3 条
- 读取 memory/DECISIONS.md 的最近决策
- 如果存在 .state/.pain_flag，先处理断点恢复

## Step 1: 读取运行参数与能力自检
- 读取 .principles/PROFILE.json，理解 risk_paths、gate、tests.commands。
- **能力自检**: 快速扫描插件目录下的 `skills/` 和 `agents/`。如果有针对当前任务的专门 Skill (如 `/deep-search`) 或 Agent (如 `security-expert`)，请在后续步骤中优先使用。

## Step 1.5: 全维环境感知 (Full-Spectrum Awareness)
- **本地**: 运行 `git status` 和 `git log -n 5` 了解代码现状。
- **远程**: 如果可用 `gh`，必须运行 `gh issue list --limit 5` 和 `gh pr list --limit 5`。
- **关联**: 如果发现相关 Issue，必须将其 ID 记录在本次任务的上下文中。

## Step 2: TRIAGE（补齐信息）
- **地图优先**: 必须先阅读 `codemaps/` 下的架构图或 `docs/SYSTEM_PANORAMA.md`，准确评估修改风险。
输出：
- Goal（一句话）
- Problem（可复现描述）
- Evidence（文件/命令/日志）
- Risk level（low/medium/high）

## Step 3: 委派 Explorer（证据收集）
- 让 Explorer 子智能体输出：Evidence list / Repro / Hypotheses(<=3)
- **绩效评估**: 任务完成后，评估 Explorer 表现并写入 `.state/.verdict.json`。格式必须严格遵守 `@.principles/schemas/agent_verdict_schema.json`。

## Step 4: 委派 Diagnostician（根因）
- 让 Diagnostician 输出：Proximal cause / Root cause / 5 Whys / Category
- **绩效评估**: 任务完成后，写入 `.state/.verdict.json`。格式遵循 `@.principles/schemas/agent_verdict_schema.json`。

## Step 5: 委派 Auditor（演绎审计）
- 让 Auditor 输出：Axiom/System/Via negativa / RESULT: PASS/FAIL
- 将审计结果写入 AUDIT.md（RESULT 行必须存在）。
- **绩效评估**: 任务完成后，写入 `.state/.verdict.json`。格式遵循 `@.principles/schemas/agent_verdict_schema.json`。

### 分支处理（必须遵守）
- 若 RESULT = FAIL：
  1. 将 Must-fix 列表写入 AUDIT.md
  2. 回到 Step 4 重新委派 Diagnostician，要求补充根因
  3. 最多重试 2 次，若仍 FAIL 则写入 memory/DECISIONS.md并请求用户介入
- 若 RESULT = PASS：继续 Step 6

## Step 6: 委派 Planner（电影剧本计划）
- Planner 输出 Plan（步骤/命令/指标/回滚）。
- 将计划写入 PLAN.md（STATUS 行必须存在）。
- **任务同步 (Task Sync)**: 
  - 如果 `CLAUDE_CODE_TASK_LIST_ID` 已设置，你必须将上述 Plan 的核心步骤直接转化为 Native Tasks（通过自然语言指令"Add task..."或相关工具）。
  - 如果未设置且为交互模式，提示用户："建议运行 `export CLAUDE_CODE_TASK_LIST_ID=task-$(date +%s)` 以启用持久化任务追踪。"
  - 如果是后台/无头模式，跳过提示。
- **绩效评估**: 任务完成后，写入 `.state/.verdict.json`。格式遵循 `@.principles/schemas/agent_verdict_schema.json`。

## Step 7: 委派 Implementer（执行）
- Implementer 只能按 PLAN 执行。任何偏离必须先更新 PLAN。
- **绩效评估**: 任务完成后，根据验证结果写入 `.state/.verdict.json`。格式遵循 `@.principles/schemas/agent_verdict_schema.json`。

## Step 8: 委派 Reviewer（审查）
- Reviewer 输出：Critical/Warning/Suggestion。
- **绩效评估**: 任务完成后，写入 `.state/.verdict.json`。格式遵循 `@.principles/schemas/agent_verdict_schema.json`。

### 分支处理
- 若有 Critical：回到 Step 6 修订计划，最多重试 2 次
- 若无 Critical：继续 Step 9

## Step 9: 反思与落盘
1. **系统进化**: 将 Pain/Root cause/新原则候选/门禁建议追加到 memory/ISSUE_LOG.md，并更新 memory/DECISIONS.md。
2. **用户画像更新 (强制)**:
   - 回顾用户在本任务中的表现（指令质量、领域知识、偏好）以及系统的高光时刻。
   - **必须**写入 `.state/.user_verdict.json` (增量更新)。格式必须严格遵守 `@.principles/schemas/user_verdict_schema.json`。
   - 注意：如果用户没有表现出明显特征或偏好，对应字段可为空。

## Step 10: 最终汇报 (Final Briefing)
- **动作**: 委派 ``sessions_spawn(reporter)`` 进行结项陈述。
- **要求**: 将 Implementer 和 Reviewer 的最终产出作为输入传给它。让它根据 `USER_CONTEXT.md` 决定汇报的深度和风格。
- **目标**: 确保老板（用户）在不产生认知负荷的前提下，清楚了解任务成果与潜在风险。