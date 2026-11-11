---
'@principles/core': minor
'@principles/host-runtime': minor
'@principles/codex-adapter': patch
'@principles/workbuddy-adapter': patch
'principles-disciple': patch
'@principles/pd-cli': patch
'create-principles-disciple': patch
---

宿主工具语义声明升级到 v2，并补上写入载荷格式的单一真源（ADR-0030）。

- `@principles/core`（minor）：新增对外能力——`WritePayloadFormat` 类型、`WRITE_PAYLOAD_FORMAT_VALUES`、`isWritePayloadFormat()`，`ToolSemanticMappingV1` 增加可选 `writePayloadFormat`，`ToolSemanticRegistry` 增加 `resolveWritePayloadFormat()`。只新增公开成员，既有 `lookup` / `resolve` / `hasHostTool` 与 `canonicalKind` 判定不变，属向后兼容的能力扩展。
- `@principles/host-runtime`（minor）：声明契约版本 1 → 2，新增持久化字段 `writePayloadFormat`；工作区多宿主声明合并对该字段严格比对——相同则合并，一方缺省视为「声明为普通 content」并与 `file-header-patch` 冲突（fail loud，不静默择一）；v1 声明降级读取为缺省语义并返回 `warnings`，不再拒绝加载。`HostToolDeclaration.version` 扩为 `1 | 2`，解析/解析器结果类型新增 `warnings`；v1 读取路径保持可用。
- `@principles/codex-adapter` / `@principles/workbuddy-adapter`（patch）：适配既有 v2 契约——`apply_patch` 继续声明 `file-header-patch`，声明写入改用 `HOST_TOOL_DECLARATION_VERSION`，并把降级 warning 透出到 stderr；无新增宿主可见能力。
- `principles-disciple`（patch）：修复「Codex 与 OpenClaw 同工作区时声明合并失败」——OpenClaw 的 `apply_patch` 也声明 `file-header-patch`；写入风险家族按载荷编码拆分为普通 content 与 patch 两组，`LOW_RISK_WRITE_TOOL_NAMES` 集合内容不变，本包内暂无该字段的消费方，故按行为修复记 patch。
- `@principles/pd-cli`（patch）：调试种子脚本跟随 v2 声明接口（版本常量替换），无 CLI 输出契约变化。
- `create-principles-disciple`（patch）：安装器打包 OpenClaw 插件载荷（C4 装配边）；安装器侧无逻辑改动，仅随载荷刷新版本。

级别判定理由：`@principles/core` 与 `@principles/host-runtime` 增加了对外公开的类型、方法与持久化 schema 字段（向后兼容），属于 semver 的 minor 能力扩展；其余包只是跟随该契约或修复既有合并失败，无新增宿主可见能力，按 patch 记录。
