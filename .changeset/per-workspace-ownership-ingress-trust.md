---
"@principles/install-layout": patch
"@principles/core": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Workspace 所有权记录升级为逐 Workspace 独立表达：`InstallManifest.backgroundExecutions` 为以 canonical workspaceDir 为 key 的 `BackgroundExecutionRecord` 映射（替换单数 `backgroundExecution`），含 per-state 语义校验（handover_preparing/rollback_pending 必须 operationId+正确的 previous/target、generation ≥ 1；legacy_owned/service_host_owned 禁止携带交接字段）；旧单记录仅在 `workspaces.length === 1` 时迁移，多 Workspace 歧义 fail-closed；新增 `setInstallManifestBackgroundExecution` 单键写入器。Pain Ingress 收紧 `automatic_hook` 信任边界：已绑定宿主报告的来源必须落在宿主来源词汇表（codex: `codex:*`；workbuddy: `workbuddy:*`；openclaw: `after_tool_call`），不可信来源降级 `observation_only`（`untrusted_automatic_source`），不再产生 LLM/Task。
