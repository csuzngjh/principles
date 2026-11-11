---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

风险行数估算改为从 `ToolSemanticRegistry` 派生：`estimateLineChanges` 不再维护第二份 raw tool 名单，凡声明为 `write` 的工具都自动纳入估算，载荷形状按参数键判断；无载荷的写入按删除量级处理。共享 RuleHost 门与 OpenClaw 插件 hook 同步改用同一权威，`check-tool-semantics-authority` 对该文件的 7 条 allowlist 例外全部删除。
