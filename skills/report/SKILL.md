---
name: report
description: Manually request a formal status report from the Reporter agent.
disable-model-invocation: true
allowed-tools: Task
---

# /report: 获取工作汇报

用户（老板）要求立即汇报工作。

## 执行动作
1. 立即委派 `Task(reporter)`。
2. 任务描述：“老板想知道当前的情况。请分析当前的对话上下文、`docs/PLAN.md` 和最近的 `docs/ISSUE_LOG.md`，为老板写一份优雅的汇报。请记住先看他的画像！”
