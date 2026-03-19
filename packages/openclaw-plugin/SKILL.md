---
name: principles-disciple
description: Evolutionary programming agent framework. Provides strategic guardrails, pain-reflection loops, and Evolver synergy.
version: 1.6.0
author: Principles Disciple Team
tags: [core, safety, evolution, strategic]
---

# 🧬 Principles Disciple

An evolutionary agent framework inspired by Ray Dalio's *Principles*.

## Features
- **before_prompt_build**: Injects strategic context (USER_CONTEXT.md).
- **before_tool_call**: Implements safety gates for risky file writes.
- **after_tool_call**: Captures failure signals and updates the pain loop.
- **Commands**: `/pd-init`, `/pd-okr`, `/pd-evolve`, `/pd-daily`, `/pd-evolution-status`, `/pd-help`.

## Commands

| Command | Description |
|---------|-------------|
| `/pd-evolution-status` | 显示进化状态（Trust Score、GFI、Pain、进化队列） |
| `/pd-init` | 初始化项目 |
| `/pd-okr` | 查看/设置 OKR |
| `/pd-evolve` | 触发进化流程 |
| `/pd-daily` | 生成每日进化日报 |
| `/pd-help` | 显示帮助 |

### `/pd-evolution-status` 输出示例

```
📈 Evolution Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🛡️ Trust Score: 100/100 (Stage 4)
😴 GFI Peak: 0.0
⚡ Current Pain: 0 pts (none)
📈 Pain Signals Today: 0

📊 Evolution Rules
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- candidate principles: 0
- probation principles: 0
- active principles: 0
- deprecated principles: 0
- last promoted: none

📋 Evolution Queue
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Pending: 0
- In Progress: 0
- Completed: 0
```

## Usage
This skill is automatically activated. It monitors your tool calls and ensures alignment with `PLAN.md`.

---
*Powered by Principles Disciple*
