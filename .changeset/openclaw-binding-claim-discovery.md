---
"@principles/install-layout": patch
"principles-disciple": patch
"@principles/workbuddy-adapter": patch
"create-principles-disciple": patch
---

Workspace 归属发现补齐 OpenClaw 自身持久化绑定：`collectHostWorkspaceClaims` 现在同样读取 `<openclawHome>/extensions/principles-disciple/mcp-binding.json`，且只有经 `validateMcpBinding` 全量校验（host/schemaVersion/workspaceDir/runtimeDir/canonical serverEntry）的 binding 才能形成 workspace claim；launcher.cjs 同步同一严格规则与新增 OpenClaw 绑定源。install manifest 新增可选 `backgroundExecution` 所有权记录（state/effectiveOwner/generation/operationId/previousOwner/targetOwner/updatedAt），解析 fail-closed，为 SPEC-PD-SERVICE-HOST-001 §8.4 CAS 所有权契约的 schema 支撑。
