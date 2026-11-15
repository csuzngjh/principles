---
"@principles/core": minor
"principles-disciple": patch
"create-principles-disciple": patch
---

Intent 有效章节可信边界：模板/空章节不再作为战略证据，`confirm_drift` 只能解决普通战略取舍

- `intent-doc` / `intent-snapshot` 新增确定性章节分类（`authored` / `placeholder` / `missing`），历史快照按同一规则重新识别；`filterIntentSnapshotSections` 不再在“声明全部无效”时回退完整快照。
- Stage A 只保留 authored 章节支撑的 `intentTension`；无快照（flag 关闭或模板-only）时清除模型自报的 `intentSnapshot` 与 `intentTension`，模板-only 归类为 `not_configured` 且不持久化快照。
- `intent_engineering` 关闭时不再注入历史快照，已持久化记录保留，重新开启后同一任务复用原快照。
- 审批门禁按冲突类型判定：`why` / `desired_outcome` / `current_strategic_focus` 可由有效 `confirm_drift` 覆盖；`non_negotiables` / `stop_escalation` / Core Principle 冲突一律阻断，并给出对应的 `nextAction`。决策章节优先读取 `related_intent_fields_snapshot`。
- Prompt Hook 只注入 Owner 撰写章节；`strategicPerspective` 明确为 advisory；Evaluator 继续只消费 IntentContract V1。
