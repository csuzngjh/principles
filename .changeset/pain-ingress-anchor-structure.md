---
"@principles/core": patch
"create-principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

Pain Ingress v0.8 收尾（T22 / T03 / T17）：

- 锚点结构化补齐：`diagnostic_json.anchor = {type, ref}` 现在对 `owner_expectation` / `established_principle` / `agent_instruction` 三类锚点都会写入；写侧与读侧共用同一份 `PainAnchorSchema` / `parsePainAnchor`，避免两份手写结构漂移。`deviationAnchor` 语义未变。
- 诊断器消费：`DiagnosisTargetSchema` 与 `DiagnosticianTaskRecord` 均带 `anchor`；`SqliteContextAssembler` 把 `diagnostic_json.anchor` 当不可信输入解析（非法则丢弃并在 `ambiguityNotes` 说明，不猜测）；根因提示词在锚点存在时输出 ANCHOR 块，指明"行为是相对哪个要求被衡量"，并修复了包装层转发遗漏（与 PRI-844 同型）。
- 两份 `pd-pain-signal` Skill（Codex/OpenClaw 共用插件与 WorkBuddy 插件）按实际实现改写：MCP `pd_submit_pain` 参数与三种锚点格式、`painType` 可省略但 `principle_deviation` 只适用于原则锚点、严重度不可自提、仅本次授权、后台禁止、失败回执（`refused` / `failed` / `submit_unconfirmed`）的阅读方式；原生入口（`PD记录痛苦：` 前缀、`/pd-pain`、Codex 实时回合的 `pd pain explicit`）与锚点式提交明确区分。
- SPEC / TD 中"只落文档、代码未改"的过期状态描述已更正为已实现，并保留真实环境验收项为待执行。
