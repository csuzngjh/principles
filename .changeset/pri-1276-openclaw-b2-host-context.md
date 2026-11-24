---
'@principles/core': minor
'principles-disciple': minor
---

PRI-1276 (B2) — OpenClaw 正常入口身份与回执兜底

- Core：`recoverTaskIdentityFromReceipt` 的 `hostKind` 联合类型纳入 `'openclaw'`（共享 CAS 恢复权威，OpenClaw 指定回执领地 `host_session_claim_empty` 已在既有白名单）。
- openclaw-plugin：新增 `after_tool_call` 结构化回执兜底（`hooks/pain-receipt-fallback.ts`）。真实探针确认的 OpenClaw 自有 envelope（单层编码 + `details.mcpServer` 交叉验证 + 精确工具名门 `pd-recall__pd_submit_pain`），身份取事件 ctx `sessionId` 与执行上下文 `toolCallId`；按事件重读 `host_identity_minimal_metadata` 授权；fail-open + 单行 ids-only 结构化诊断；经 Core CAS 恢复原 Task，不产生第二条 Pain/Task。
- `PluginHookAfterToolCallEvent` 本地镜像补齐宿主真实字段（`params`/`runId`/`toolCallId`）。
- 真实隔离安装 E2E（OpenClaw 2026.11.5）：场景 B（缺失 `_meta` → 合法 unbound → 事件回执 → CAS 恢复原 Task，SQLite 读回证据）与场景 D（授权关闭 → 零身份持久化 + blocked_by_consent 处置）PASS。安装版 runtime materializer 尚无 `_meta` 生产者（无插件可达扩展点），宿主级主路径标注不支持；上游补丁卡见 `docs/reports/PRI1276_OPENCLAW_HOST_IDENTITY_AUDIT_20261125.md` §10。
