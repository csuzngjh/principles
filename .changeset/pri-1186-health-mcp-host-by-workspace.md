---
'@principles/pd-cli': patch
---

修复 `pd health` 省略 `--host` 时 MCP 段恒读 OpenClaw binding、对 Codex/WorkBuddy 工作区输出误导诊断的问题（PRI-1186）：改为按各宿主安装器写入的 `mcp-binding.json` 的 `workspaceDir` 选出真正服务该工作区的宿主；唯一匹配即选该宿主，无匹配或多匹配时保留 openclaw 默认并明确披露原因（rc-9，不静默猜测）。选择依据新增于 JSON 顶层 `mcpHostSelection` 字段与文本 `mcp.hostSelection:` 行；显式 `--host` 行为不变。