---
'@principles/core': patch
---

PRI-1187：RuleHost 运行时不按 `affectedTools` 过滤（安全门宁多拦不少拦），改为激活期校验 golden trace 工具族 ⊆ 声明族（`golden_trace_tool_outside_affected_scope`）。`host-liveness:` 仅豁免 dispatchability，其可解析工具族仍计入声明上界，且该保留前缀在 Artificer 输出中被拒绝；prompt 契约升至 v17（声明是审批/审计上界，文件变更类策略须声明 exec 族）。
