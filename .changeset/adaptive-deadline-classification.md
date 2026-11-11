---
'@principles/host-runtime': patch
---

修复 Adaptive 选择在“宿主截止窗口同时也是生成窗口”时的诊断归类竞态：两个计时器落在同一时刻，`Date.now()` 可能仍比截止时间早 1ms，于是“哪个 controller 先中止”决定了失败码，间歇性把 `TURN_DEADLINE_EXCEEDED` 误报为 `SELECTION_EXPIRED`（`tests/pd-hook-adaptive.test.ts` 在三条互不相关的 PR 上出现过同一签名）。现在以“实际到期的窗口”为唯一依据（P4）：被宿主截止时间封顶的窗口一律归因为 `TURN_DEADLINE_EXCEEDED`，与真实计时器先后无关。
