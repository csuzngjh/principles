---
"@principles/core": patch
---

原则语义保真收口（PD-BEHAVIOR-FIDELITY-001 Gate 2，情况 A：严格原则能改变行为 → 优先修语义保真）。

- **Scribe statement 保真边界（prompt v9 → v10）**：新增 STATEMENT FIDELITY 段落——statement 是唯一注入 Agent prompt 的文本，因此其中任何"豁免/简化"条款必须有 Owner 原文依据；上游风险建议（如"取证有成本，低风险可逆的小变更可简化流程"）不是授权，不得写成行为豁免；Owner 明确要求的动作（如"等我确认后再动手"）不得丢弃或软化；已披露的 `ownerRequirementGaps` 不得在 statement 里重新变成可执行许可；只读操作的简化不得被表述成写操作豁免。
- **Rollout Reviewer 关键语义弱化审核（principle_semantic prompt v1 → v2）**：新增保真检查清单与硬规则——非空 `ownerRequirementGaps` 属于未解决的 Owner 覆盖缺口，禁止 `approve_rollout`；"可绕过门禁"的风险是 requiredChange，不是 safetyCheck；decision / summary / requiredChanges 必须自洽；`needs_revision` 必须携带具体 requiredChange。
- **Validator 结构性矛盾检测（仅 principle_semantic，code_chain 契约不变）**：`approve_rollout` + 非空 gaps → 拒绝；`approve_rollout` + 非空 requiredChanges → 拒绝；`needs_revision` + 空 requiredChanges → 拒绝。gaps 由 runner 从被评审的 Scribe 工件读取（runner-owned authority），不由模型复述。
- **回归**：以 E2E Round 3 真实工件（candidate `408fe3a1` 宽松谱系 / `ae5d9b57` 严格谱系，逐字取自 R3 state.db）建立回归：宽松谱系 approve 被拒且不进入审批/激活；严格谱系保持可批准（不搞"所有原则必须确认"）。定向测试 principles-core + pd-cli 全绿。
