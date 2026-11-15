---
"@principles/pd-cli": minor
"create-principles-disciple": minor
---

宿主内代理安装后验收闭环（agent post-install acceptance）：

- 新命令 `pd mcp probe`：MCP 活体探针——spawn 已安装的 MCP server（复用 `pd health` 的同一布局/binding 解析），走 initialize → tools/list 握手并验证契约工具 `pd_recall_principle_pains` 在列，输出 JSON/文本双形态与结构化 reason+nextAction。`pd health` 保持只读契约（PRI-1130）不变；本命令是其主动互补面。
- `pd health` 新增 console 段（只读安装完整性 + 在运行时探活；`installed_not_running` 为中性态，`broken` 计入 exit 1）与派生 `summary` 验收视图（cli/mcp/console/skills/hostLoaded/restart 各自独立 witness + overall，纯派生不新增事实源）。
- 安装器 `--json` 输出与文本摘要新增 `postInstall` 结构化清单：per-host {state, restartRequired, restartHint, verifyCommand}（openclaw=网关已自动重启；codex=新会话+marketplace 手动步骤；workbuddy=新会话或 /reload-plugins+启用）+ 全局 `pd mcp probe` 验收命令；CLI 仅本地验证可用时自动降级为绝对路径形式。
