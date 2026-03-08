---
name: report
description: Manually request a formal status report from the Reporter agent.
disable-model-invocation: true
---

# /report: Get Work Report

User (the boss) requests an immediate work report.

## Execution Action
1. Immediately delegate `Task(reporter)`.
2. Task description: "The boss wants to know the current situation. Please analyze current conversation context, `docs/PLAN.md`, and recent `docs/ISSUE_LOG.md` to write an elegant report for the boss. Remember to check their profile first!"
