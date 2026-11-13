---
"@principles/core": patch
"@principles/pd-console": patch
"@principles/host-runtime": patch
"@principles/pd-cli": patch
---

存储访问收口第一批（PRI-1207）：trajectory.db 读失败可判定，console 不再把“读不到”渲染成 0

- core：`TrajectoryDbUnavailableError` 增加 `code`（file_missing / schema_missing / locked / corrupt / io_error），只读打开与查询失败统一分类，不再让调用方靠 message 猜原因。
- pd-console：4 处 trajectory.db 直连改为既有 `openTrajectoryDbReadonly`；缺库/读失败产 degraded 信号，证据数与 gate 拦截数保持“未知”，不再悄悄显示 0。
- host-runtime / pd-cli：剩余 `.pd/state.db`、`.state/trajectory.db` 路径字面量改走 `resolveStateDbPath` / `resolveTrajectoryDbPath`，解析结果逐字不变。
