---
"create-principles-disciple": patch
---

安装器在升级前兼容性检查中显式呈现"无法扫描的 ACTIVE 规则"（5B-B）。

此前 preflight 只消费 `(ok, status)`：新增的 `incomplete` 会被严格协议判成
`scan_failed`（硬拒绝），而 `skipped` 完全被丢弃——即"有规则没验到"既可能
误拦，也可能无声。

- `parseCompatibilityScanStdout` 接受 `ok=true + incomplete`，并校验、保留
  `skipped: [{ reason, count, sampleActivationIds }]` 与 `scannedActivations`
  （rc-1/rc-4）。**不允许 `clean` 携带非空 `skipped`**：该组合视为协议矛盾并
  fail closed，保证任何消费方都无法把 `incomplete` 降级成 `clean`。
- 安装流程逐条打印 `reason=count (sample: …)` 与下一步命令，**不阻断**。
- `scannedActivations === 0` 且存在 skipped 时，输出一级警告块
  （"THIS UPGRADE DID NOT VERIFY ANY RULE COMPATIBILITY"），并在安装结束摘要
  中重复一次；`success` 不变。
- `InstallResult` 新增可选 `compatibilityWarnings?: string[]`（仅在非空时出现），
  使 `--json` 模式也能看到同样的告警。

Patch：仅新增可选结果字段与告警输出；拒绝口径只放宽了原本会误拦的
`incomplete`，`clean` 携带 skipped 反而从"被接受"收紧为"协议矛盾"。
