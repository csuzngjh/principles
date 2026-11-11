---
"@principles/core": patch
---

修复 effective 配置的 `ui` 回退分支与 `DEFAULT_UI` 共享嵌套对象的问题：`computeEffectivePdConfig` 在用户配置缺少 `ui` 时改为逐层重建，调用方修改返回值的 `ui.diagnostics.mode` 不再污染进程级默认配置与后续 `getDefaultPdConfig()` 结果（与 #2519 建立的默认值逐层拷贝约定保持一致）。
