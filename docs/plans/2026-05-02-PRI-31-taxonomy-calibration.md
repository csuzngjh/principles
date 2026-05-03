# PRI-31: Diagnostician 分类精度校准 (Taxonomy Calibration) 设计规范

**创建日期**: 2026-05-02
**角色**: 首席架构师 (Lead Architect)
**状态**: Ready for Development
**目标位置**: `packages/principles-core/src/runtime-v2/`

---

## 1. 架构意图与系统动力学背景 (Context)

在 PD 的系统动力学模型中，`Diagnostician`（诊断者）是整个系统的**知识进水阀**。
目前系统患有“知识肥胖症（上下文超载）”，根本原因在于目前的提示词（Prompt）存在格式偏置，诱导大模型将所有教训都输出为 `kind: 'principle'`（软原则），导致后端的 `PrincipleCompiler`（硬编译器）和 `RuleHost` 接收不到可编译的 `rule`（硬规则）图纸。

**本任务的目标**：不是强制大模型只输出 `rule`，而是**恢复其客观分类能力**。通过 TDD 驱动，校准 Prompt，使得大模型能够精准区分抽象哲学、确定性规则、具体代码和无效噪音。

---

## 2. 五象限分类学定义 (The Recommendation Taxonomy)

开发人员在修改 Prompt 和编写测试用例时，必须严格贯彻以下 5 种分类：

1.  **`principle` (抽象经验)**
    *   **适用场景**：高维度的架构思维、价值观、跨组件的通用指导。
    *   **特征**：无法用单一正则表达式拦截，需要 LLM 思考才能应用。

2.  **`rule` (可检测约束)**
    *   **适用场景**：明确的、确定性的、基于路径或工具的拦截策略。
    *   **特征**：**必须**伴随明确的 `triggerPattern` 和 `action`，不依赖 LLM 即可做物理拦截。

3.  **`implementation` (代码实现候选)**
    *   **适用场景**：极其具体的、明确的代码级修复建议（针对单一文件）。

4.  **`prompt` (提示词注入)**
    *   **适用场景**：特定工作流、SOP 或 Skill 的提示词内化对象。
    *   **特征**：用于影响大模型的思考方式，而非代码物理拦截。

5.  **`defer` (证据不足/挂起)**
    *   **适用场景**：信息不足以得出结论。仅记录，不产生防范建议。

---

## 3. TDD 测试驱动规范 (Test-Driven Fixtures)

开发人员**必须先写测试**，确保大模型输出校验器（Validator）能正确处理平权结构，再修改 Prompt。

在 `packages/principles-core/src/runtime-v2/runner/default-validator.ts` 及其相关测试文件中，需做以下修改：
1. 允许做最小 validator 语义增强：`rule` 必须有 `triggerPattern` 和 `action`；`principle` 继续要求 `abstractedPrinciple`。
2. 更新现有 `rule` fixture，避免没有 `triggerPattern` 的弱语义样例存在。

### Fixture 示例场景
... (保留原 A, B, C, D 逻辑)

---

## 4. Prompt 修改指南 (Implementation Guidelines)

修改 `packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.ts`。

**最终版 Prompt 图纸 (Copy-Paste Ready)**：
开发人员请直接将原 `PHASE 4` 的内容替换为以下模板（注意要求返回完整 DiagnosticianOutputV1 对象）：

```typescript
`PHASE 4 — Recommendation Taxonomy & Distillation
Analyze the root cause and propose actionable recommendations. You MUST classify each recommendation into one of FIVE specific categories (kind) based on the taxonomy below.

TAXONOMY DEFINITIONS:
1. "rule": Deterministic constraints. Use for specific tool blocks or path protections. A "rule" MUST have a precise 'triggerPattern' (e.g., regex "^src/core/") and 'action' for physical interception.
2. "principle": Abstract, reusable wisdom. Use for high-level architectural guidelines. MUST have 'abstractedPrinciple'.
3. "implementation": Code-level candidate. Use for extremely specific code patches.
4. "prompt": Context/Skill injection. Use to influence the agent's workflow habits.
5. "defer": Insufficient evidence. Use for network timeouts or noise.

OUTPUT FORMAT (JSON):
Return a FULL DiagnosticianOutputV1 JSON object. The 'recommendations' array MUST use this flattened structure:
"recommendations": [
  {
    "kind": "rule",
    "description": "<Detailed explanation>",
    "triggerPattern": "<Regex/keywords. REQUIRED if kind is 'rule'>",
    "action": "<Required behavior change. REQUIRED if kind is 'rule'>",
    "abstractedPrinciple": "<One sentence summary. REQUIRED if kind is 'principle'>"
  }
]`
```

---

## 5. 验收标准 (Acceptance Criteria)

1.  `prompt-builder tests` 验证 prompt 包含完整的 5 类分类定义和完整的 JSON 输出格式。
2.  `diagnostician output validator` 测试覆盖这 5 类推荐。
3.  现有所有的 Runtime V2 E2E 测试不得遭到破坏。
4.  保留 prompt kind，绝不强迫分类，依靠模型语义判断。