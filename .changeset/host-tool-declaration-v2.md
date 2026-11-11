---
'@principles/core': patch
'@principles/host-runtime': patch
'@principles/codex-adapter': patch
'@principles/workbuddy-adapter': patch
'principles-disciple': patch
'@principles/pd-cli': patch
'create-principles-disciple': patch
---

宿主工具语义声明升级到 v2，并补上写入载荷格式的单一真源（ADR-0030）。

- `@principles/core`（patch）：`ToolSemanticRegistry` 支持 `writePayloadFormat` 声明；v1 声明文件仍可读取（缺省即普通 content），仅新增字段与解析，不改变既有 `canonicalKind` 判定。
- `@principles/host-runtime`（patch）：工作区多宿主声明合并对 `writePayloadFormat` 做严格比对——相同则合并，一方缺省视为「声明为普通 content」并与 `file-header-patch` 冲突（fail loud，不静默择一）；v1 声明在降级读取时按普通 content 处理，不再拒绝加载。
- `@principles/codex-adapter` / `@principles/workbuddy-adapter`（patch）：声明版本随 v2 契约更新，继续为 `apply_patch` 声明 `file-header-patch`。
- `principles-disciple`（patch）：OpenClaw 的 `apply_patch` 也声明 `file-header-patch`，消除「同一工作区同时运行 Codex 与 OpenClaw 时合并失败」；写入风险家族按载荷编码拆分为普通 content 与 patch 两组，`LOW_RISK_WRITE_TOOL_NAMES` 的集合内容不变。
- `@principles/pd-cli`（patch）：调试用途的种子脚本跟随 v2 声明接口调整。
- `create-principles-disciple`（patch）：安装器打包 OpenClaw 插件载荷（C4 装配边）；无安装器侧逻辑改动，仅随载荷刷新版本。
