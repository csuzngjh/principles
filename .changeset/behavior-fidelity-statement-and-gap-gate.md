---
"@principles/core": patch
---

原则语义保真收口（PD-BEHAVIOR-FIDELITY-001 Gate 2，情况 A：严格原则能改变行为 → 优先修语义保真）。

- **Scribe statement 保真边界（prompt v9 → v10）**：新增 STATEMENT FIDELITY 段落——statement 是唯一注入 Agent prompt 的文本，因此其中任何"豁免/简化"条款必须有 Owner 原文依据；上游风险建议（如"取证有成本，低风险可逆的小变更可简化流程"）不是授权，不得写成行为豁免；Owner 明确要求的动作（如"等我确认后再动手"）不得丢弃或软化；已披露的 `ownerRequirementGaps` 不得在 statement 里重新变成可执行许可；只读操作的简化不得被表述成写操作豁免。
- **Rollout Reviewer 关键语义弱化审核（principle_semantic prompt v2 → v3）**：新增保真检查清单，并要求模型逐条处置 `ownerRequirementGaps`——若缺口对应 statement 里已授予的豁免，必须 `needs_revision` 并给出具体 requiredChange；若只是"未采纳的上游建议/管道限制"这类披露，不阻断批准，但 summary 必须说明已核对且为何不削弱 Owner 要求。另加硬规则："可绕过门禁"是 requiredChange 而非 safetyCheck；decision / summary / requiredChanges 必须自洽；`needs_revision` 必须携带具体 requiredChange。CONSTRAINTS 里 `requiredChanges` 的取值改为按 decision 区分，避免模型产出 `needs_revision` + `[]` 被 `output_invalid`（永久错误类别，不重试）直接判死候选。
- **Validator 结构性矛盾检测（仅 principle_semantic，code_chain 契约不变）**：只拦两条自相矛盾——`approve_rollout` + 非空 `requiredChanges` → 拒绝；`needs_revision` + 空 `requiredChanges` → 拒绝。Validator **不读取** `ownerRequirementGaps`，缺口是否构成阻断仍由 Reviewer 的语义判断负责（不把语义问题伪装成确定性校验）。
- **回归**：以 E2E Round 3 真实工件（candidate `408fe3a1` 宽松谱系 / `ae5d9b57` 严格谱系，逐字取自 R3 state.db）建立回归：runner 级用例证明"带 gaps 的 Scribe 工件 + Reviewer approve"不会被结构性误杀，而 `needs_revision` + `[]`、`approve` + 非空 requiredChanges 会被 validator 拒绝且不进入审批/激活；严格谱系保持可批准（不搞"所有原则必须确认"）。定向测试 principles-core + pd-cli 全绿。
