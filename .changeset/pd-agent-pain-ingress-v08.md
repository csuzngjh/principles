---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/codex-adapter": patch
"@principles/pd-cli": patch
"@principles/pd-mcp-server": minor
"principles-disciple": minor
"create-principles-disciple": patch
---

SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8：Agent 痛点入口四阶段落地。

- 阶段 1：Core Pain Submit Capability、anchor 校验、统一 Origin/Provenance；`evaluatePainIngress()` 增加 MCP 专用分支并排在通用 Unbound 分支之前。
- 阶段 2：MCP `pd_submit_pain` 契约面；超时返回 `submit_unconfirmed`，并以 `taskId = diagnosis_<painId>` 做限时只读回查（found/not_found/read_error），不取消写入、不自动重投。
- 阶段 3：四类写入点统一 `DEFAULT_PAIN_SCORE = 40`（`moderate`）；MCP 路径恢复 Observability，`pain_events` 可见。
- 阶段 4：Console L2/L2b；OpenClaw tick 增加 L3 自动诊断（每轮最多 1 个，失败保留 pending，flag `openclaw_diagnostician_consumer` 可关）；安装器废弃旧 `pd-record-pain` skill（仅重命名字节命中已发布载荷的副本，用户修改副本保留并告警）。

MCP 写能力仍受 OG-4 门禁约束：生产入口不开启，`tools/list` 不含 `pd_submit_pain`。