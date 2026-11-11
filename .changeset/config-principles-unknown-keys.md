---
'@principles/core': patch
---

配置校验补两处静默丢弃：`principles` 段的未知键现在会作为配置错误上报（此前被静默忽略，看起来配置生效而实际没有消费者），并且 `getDefaultPdConfig()` 返回的 `features.<flag>` 条目与 `ui.diagnostics` 改为逐层拷贝——此前它们与模块级默认值共享同一对象，任何调用方改动自己拿到的默认配置都会污染同进程后续所有调用（ERR P-ERR-124 的根因）。合法配置的校验结果不变。
