---
name: evolve-task
description: Run the full evolution loop (triage → diagnosis → audit → plan → execute → review → log)
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

你必须按顺序执行以下步骤（不得跳步）。ARGUMENTS: $ARGUMENTS

## Step 0: 恢复上下文（强制）
- 读取 docs/CHECKPOINT.md 的最后一条
- 读取 docs/ISSUE_LOG.md 的最近 3 条
- 读取 docs/DECISIONS.md 的最近决策
- 如果存在 docs/.pain_flag，先处理断点恢复

## Step 1: 读取运行参数
- 读取 docs/PROFILE.json，理解 risk_paths、gate、tests.commands。

## Step 2: TRIAGE（补齐信息）
输出：
- Goal（一句话）
- Problem（可复现描述）
- Evidence（文件/命令/日志）
- Risk level（low/medium/high）

## Step 3: 委派 Explorer（证据收集）
- 让 Explorer 子智能体输出：Evidence list / Repro / Hypotheses(<=3)
- **绩效评估**: 任务完成后，评估 Explorer 表现并写入 `docs/.verdict.json`:
  ```json
  {"target_agent": "explorer", "win": true, "score_delta": 1, "reason": "Found critical evidence"}
  ```

## Step 4: 委派 Diagnostician（根因）
- 让 Diagnostician 输出：Proximal cause / Root cause / 5 Whys / Category
- **绩效评估**: 任务完成后，写入 `docs/.verdict.json`:
  ```json
  {"target_agent": "diagnostician", "win": true, "score_delta": 1, "reason": "Accurate root cause"}
  ```

## Step 5: 委派 Auditor（演绎审计）
- 让 Auditor 输出：Axiom/System/Via negativa / RESULT: PASS/FAIL
- 将审计结果写入 docs/AUDIT.md（RESULT 行必须存在）。
- **绩效评估**: 任务完成后，写入 `docs/.verdict.json`:
  ```json
  {"target_agent": "auditor", "win": true, "score_delta": 1, "reason": "Passed safety audit"}
  ```

### 分支处理（必须遵守）
- 若 RESULT = FAIL：
  1. 将 Must-fix 列表写入 docs/AUDIT.md
  2. 回到 Step 4 重新委派 Diagnostician，要求补充根因
  3. 最多重试 2 次，若仍 FAIL 则写入 docs/DECISIONS.md并请求用户介入
- 若 RESULT = PASS：继续 Step 6

## Step 6: 委派 Planner（电影剧本计划）
- Planner 输出 Plan（步骤/命令/指标/回滚）。
- 将计划写入 docs/PLAN.md（STATUS 行必须存在）。
- **绩效评估**: 任务完成后，写入 `docs/.verdict.json`:
  ```json
  {"target_agent": "planner", "win": true, "score_delta": 1, "reason": "Plan is executable"}
  ```

## Step 7: 委派 Implementer（执行）
- Implementer 只能按 PLAN 执行。任何偏离必须先更新 PLAN。
- **绩效评估**: 任务完成后，根据验证结果写入 `docs/.verdict.json`:
  ```json
  {"target_agent": "implementer", "win": true, "score_delta": 1, "reason": "Implemented as planned"}
  ```

## Step 8: 委派 Reviewer（审查）
- Reviewer 输出：Critical/Warning/Suggestion。
- **绩效评估**: 任务完成后，写入 `docs/.verdict.json`:
  ```json
  {"target_agent": "reviewer", "win": true, "score_delta": 1, "reason": "Detailed review"}
  ```

### 分支处理
- 若有 Critical：回到 Step 6 修订计划，最多重试 2 次
- 若无 Critical：继续 Step 9

## Step 9: 反思与落盘
1. **系统进化**: 将 Pain/Root cause/新原则候选/门禁建议追加到 docs/ISSUE_LOG.md，并更新 docs/DECISIONS.md。
2. **用户画像更新 (强制)**:
   - 回顾用户在本任务中的表现（指令质量、领域知识、偏好）。
   - **必须**写入 `docs/.user_verdict.json` (增量更新):
   ```json
   {
     "updates": [
       {"domain": "frontend", "delta": 1, "reason": "Provided correct React code"},
       {"domain": "security", "delta": -1, "reason": "Ignored safety warning"}
     ],
     "preferences": {
       "language": "zh-CN",
       "verbosity": "detailed"
     }
   }
   ```
   - 注意：如果用户没有表现出明显特征或偏好，对应字段可为空。
