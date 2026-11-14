---
"@principles/core": patch
---

修复诊断 Stage A 结构化输出在 `intentTension` 形状错误时既不可修复、也不可观测的问题（D-01，PD-NATIVE-STRICT-PRINCIPLE-CLOSURE-001）。

- **根因**：`intentTension` 是可选对象，schema 要求 6 个子字段且 `additionalProperties:false`，但两个 schema prompt 渲染器都只打印 `intentTension: object (optional)`，从未把子字段形状告诉模型。模型自造 `{ description }` 时，校验必然失败。
- **修复回喂不可达**：一次运行的三条输出路径（tool-call / json_mode / free-form）共享 `RUN_REQUEST_BUDGET = 3`，三条路径耗尽时修复循环拿到 `requestsLeft === 0`，字段级修复提示（含 `/path` + 期望值 + 实际值预览）永远发不出去。现在为修复循环单独预留 1 次请求（独立计数器，不放大共享预算），输出路径阶梯与 S6 上限不变，最坏 4 次而非 6 次。
- **讲清形状**：`schema-prompt-adapter` / `deriveSchemaSummary` 对 object 属性展开 required 子字段（enum/union/array/type 与 minLength/min/max/maxItems），深度限制 1 层防自引用。schema 未放宽。
- **rc-9 可观测**：`output_failure_details` 现在区分 `repair_skipped` 与 `repair_exhausted`，并持久化 `repairSkipReason` / `repairAttemptsConfigured` / `repairAttemptsSkippedByRequestBudget` / `repairStoppedBeforeSend`（此前只在 telemetry 里）。
- **Pain 不被静默丢弃**：诊断任务耗尽重试后，`diagnosticJson.terminal_failure` 写入 `painInternalized:false`、`retryable:true`、`sourcePainId` 与可执行的 `nextAction`（`pd pain retry --pain-id … --confirm` 或 `pd runtime recovery failed-tasks --confirm`），不再只有一条 `max_attempts_exceeded`。
- **回归**：用线上真实失败输出（`intentTension: { description }`）走真实 adapter → HTTP wire → 校验 → 修复边界；断言第 4 次请求就是修复请求，且请求体带 `- /intentTension/source: Expected required property` 与 `Unexpected property`。
