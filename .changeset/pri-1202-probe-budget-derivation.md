---
"@principles/host-runtime": patch
"create-principles-disciple": patch
---

CLI 恢复探针预算改为从控制台请求预算派生，探针不再可能晚于请求超时（PRI-1202）。

- 根因：控制台 `asyncHandler` 的请求预算是 10s（超时返回 504），而 `probeCliActivationStatus` / `probeCliDeactivateDryRun` 各自携带 15s 字面量预算。两个常量互不知情，慢环境下即使只有一个探针也可能在请求被判超时后仍在运行。
- 修复：新增 `CONSOLE_REQUEST_BUDGET_MS`（10s）作为唯一权威，探针预算 `CLI_RECOVERY_PROBE_TIMEOUT_MS = CONSOLE_REQUEST_BUDGET_MS - CLI_RECOVERY_PROBE_HEADROOM_MS`（2s 余量 → 8s），控制台 `REQUEST_TIMEOUT_MS` 直接复用该常量。
- 回归：探针默认预算的假时钟测试在请求预算到期前 1ms 断言探针已失败关闭；把探针预算改回 15s 时该测试与派生关系断言同时变红。另加真实 HTTP listener 的 owner-review 正常路径 200 用例。
- 发布：本变更同时修改了 `@principles/pd-console`（private 包，由 `create-principles-disciple` 打包分发），故 installer 必须与 host-runtime 一同发版，否则已安装用户拿不到修复后的控制台。
