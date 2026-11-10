---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

B1：非法的 RuleHostResult 统一 fail-closed 归一化。新增可选 `degraded` 标记与 `normalizeRuleHostResult()`：无法读取的规则输出不再被静默丢弃（此前 production gate 记 warning 后 continue，可能被其它规则的 allow 覆盖），而是归一化为带 `degraded.reasonCode='invalid_result'` 的 `requireApproval`，继续保持脱敏可见（warning / unhealthy 证据）。`matched=false` 仍表示“无意见”，由归一化函数单点应用既有 PRI-439 语义。合法结果原样透传，默认行为与阈值不变。注意：本次只到共享门 / legacy 评估器的裁决契约层；宿主是否会因此拦截调用仍取决于宿主能力（OpenClaw 目前只记录 `requireApproval` 事件，Codex 只读取 `metadata.ruleDecision`），本变更不新增宿主拦截。
