---
'@principles/core': patch
'@principles/host-runtime': patch
---

内置代理 pi-ai 调用层第一阶段稳定性修复。

- 取消真正中止在途请求：run 级 `AbortController`，超时与取消共用同一 signal，`cancelRun()` 不再只改状态。
- 统一时间预算：修复调用继承 run 剩余预算，剩余不足 1s 直接跳过并留痕，不再各自拿新的 60s。
- 传输重试交给 pi-ai 内建重试（`maxRetries` + `maxRetryDelayMs = 30s`），PD 仅保留输出预算下调阶梯，4xx 不再被重试。
- provider 错误按 HTTP 状态码分类（401/403、400/422、408、429、5xx），遥测保留 `httpStatus` 与分类来源。
- 上下文先估算后调用、溢出可识别；删除 Artificer 的 5 万字符静默截断，改为按模型窗口推导裁剪并发出 `context_budget_trimmed` 留痕。
- 原则选择补上 `adaptive-selection-output` schema，缺 `id`/`digest` 的 `selected` 答案由适配器拒绝，失败码映射为 `SELECTION_OUTPUT_INVALID`。
