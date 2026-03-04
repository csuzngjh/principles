---
name: evolve-task
description: Run the full evolution loop (triage → diagnosis → audit → plan → execute → review → log)
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, agent_send
metadata: '{"openclaw": {"category": "evolution", "priority": 8}}'
---

你必须按顺序执行以下步骤（不得跳步）。ARGUMENTS: $ARGUMENTS

## Step 0: 恢复上下文（强制）
- 读取 docs/CHECKPOINT.md 的最后一条
- 读取 docs/ISSUE_LOG.md 的最近 3 条
- 读取 docs/DECISIONS.md 的最近决策
- 如果存在 docs/.pain_flag，先处理断点恢复

## Step 1: 读取运行参数与能力自检
- 读取 docs/PROFILE.json，理解 risk_paths、gate、tests.commands。
- **能力自检**: 快速扫描插件目录下的 `skills/` 和 `agents/`。

## Step 1.5: 全维环境感知 (Full-Spectrum Awareness)
- **本地**: 运行 `git status` 和 `git log -n 5` 了解代码现状。
- **远程**: 如果可用 `gh`，必须运行 `gh issue list --limit 5` 和 `gh pr list --limit 5`。

## Step 2: TRIAGE（补齐信息）
- **地图优先**: 必须先阅读 `codemaps/` 下架构图或 `docs/SYSTEM_PANORAMA.md`。
输出：Goal, Problem, Evidence, Risk level.

## Step 3: 委派 Explorer（证据收集）
- 使用 `agent_send --agent explorer` 进行证据收集。
- **绩效评估**: 写入 `docs/.verdict.json`。

## Step 4: 委派 Diagnostician（根因）
- 使用 `agent_send --agent diagnostician` 进行根因分析。

## Step 5: 委派 Auditor（演绎审计）
- 使用 `agent_send --agent auditor` 进行审计。
- 结果写入 `docs/AUDIT.md`。

## Step 6: 委派 Planner（计划）
- 使用 `agent_send --agent planner` 生成计划。
- 计划写入 `docs/PLAN.md`。

## Step 7: 委派 Implementer（执行）
- 使用 `agent_send --agent implementer` 按计划执行。

## Step 8: 委派 Reviewer（审查）
- 使用 `agent_send --agent reviewer` 审查结果。

## Step 9: 反思与落盘
1. **系统进化**: 将 Pain/Root cause 追加到 `docs/ISSUE_LOG.md`。
2. **用户画像更新**: 写入 `docs/.user_verdict.json`。

## Step 10: 最终汇报 (Final Briefing)
- 使用 `agent_send --agent reporter` 进行结项陈述。
