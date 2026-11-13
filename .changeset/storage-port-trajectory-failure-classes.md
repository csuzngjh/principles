---
"@principles/core": patch
"create-principles-disciple": patch
"@principles/host-runtime": patch
"@principles/pd-cli": patch
---

存储访问收口第一批（PRI-1207）：trajectory.db 读失败可判定，console 不再把“读不到”渲染成 0

- core：`TrajectoryDbUnavailableError` 增加 `code`（file_missing / schema_missing / locked / corrupt / io_error），只读打开与查询失败统一分类，不再让调用方靠 message 猜原因；4 个只读 state.db read model 改走既有 `SqliteConnection`。
- pd-console（随 create-principles-disciple 发布）：4 处 trajectory.db 直连改为既有 `openTrajectoryDbReadonly`；缺库/读失败产 degraded 信号，证据数与 gate 拦截数保持“未知”，不再悄悄显示 0。
- **对外可观察契约变化（pd-console API）**：规则候选绑定的 `pain.source` 在 trajectory 库缺失或损坏时由 `"unknown"` 变为 `"unreadable"`。`"unknown"` 现在只表示“库可读、但该 pain 没有记录”；消费方若用 `source === 'unknown'` 判断“未记录”，必须区分这两种情况。这是本批次有意为之的语义修正（读不到 ≠ 未记录）。
- host-runtime / pd-cli：剩余 `.pd/state.db`、`.state/trajectory.db` 路径字面量改走 `resolveStateDbPath` / `resolveTrajectoryDbPath`，解析结果逐字不变。
