---
"@principles/core": patch
---

修复预激活回放的安全边界：`compileHardenedRuleEvaluator` 的 evaluate 调用脚本改为在 vm realm 内 `JSON.stringify` 结果（与 evaluate 调用同一硬超时），只让字符串原始值跨越回 host，host 端 `JSON.parse` 后再走 `validateRuleHostResult`。候选规则返回带循环 getter 或 `toJSON` 的对象时不再能挂起回放进程，而是在 `REPLAY_EVALUATE_HARD_TIMEOUT_MS` 内被中断并归类为 `timeout`。
