---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

B1：非法的 RuleHostResult 统一 fail-closed 归一化。新增可选 `degraded` 标记与 `normalizeRuleHostResult()`：无法读取的规则输出不再被静默丢弃（此前 production gate 记 warning 后 continue，可能被其它规则的 allow 覆盖），而是归一化为带 `degraded.reasonCode='invalid_result'` 的 `requireApproval`，继续保持脱敏可见（warning / unhealthy 证据）。`matched=false` 仍表示“无意见”，由归一化函数单点应用既有 PRI-439 语义。合法结果原样透传，默认行为与阈值不变。
