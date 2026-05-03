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

## 2. 四象限分类学定义 (The Recommendation Taxonomy)

开发人员在修改 Prompt 和编写测试用例时，必须严格贯彻以下 4 种分类：

1.  **`principle` (抽象经验)**
    *   **适用场景**：高维度的架构思维、价值观、跨组件的通用指导。
    *   **特征**：无法用单一正则表达式拦截，需要 LLM 思考才能应用。
    *   **示例**：“不要绕过 Runtime v2 的公共 API 直接调用底层服务。”

2.  **`rule` (可检测约束)**
    *   **适用场景**：明确的、确定性的、基于路径或工具的拦截策略。
    *   **特征**：**必须**伴随明确的 `triggerPattern`（如正则、路径、特定的工具名），不依赖 LLM 即可做字符串匹配。
    *   **示例**：“禁止在 `packages/core` 外调用 `createPainSignalBridge`。”

3.  **`implementation` (代码实现候选)**
    *   **适用场景**：极其具体的、明确的代码级修复建议（通常针对单一文件）。
    *   **特征**：可以直接转换为补丁（Patch）或沙盒脚本。
    *   **示例**：“在 `prompt-builder.ts` 第 150 行添加缺失的 JSON 闭合括号。”

4.  **`defer` (证据不足/挂起)**
    *   **适用场景**：网络波动超时、偶发的未知报错、信息不足以得出结论。
    *   **特征**：仅记录，不产生任何防范建议。
    *   **示例**：“API 偶尔返回 502 Bad Gateway。”

---

## 3. TDD 测试驱动规范 (Test-Driven Fixtures)

开发人员**必须先写测试**，确保大模型输出校验器（Validator）能正确处理平权结构，再修改 Prompt。

在 `packages/principles-core/src/runtime-v2/runner/default-validator.ts` 及其相关测试文件中，需新增以下 4 个 Fixture/Eval 测试：

### Fixture A: 架构边界问题 (Architecture Boundary Issue)
*   **模拟输入 (Pain)**：Agent 试图使用 `write` 工具直接修改了 `packages/openclaw-plugin/src/core/pain.ts`，引入了直接调用 `createPainSignalBridge` 的反模式代码。
*   **期望输出类型**：`[principle, rule]`
*   **期望逻辑**：
    *   `principle`: "应保持架构边界隔离，通过防腐层调用核心能力。"
    *   `rule` (带 triggerPattern): "当工具为 `write` 且路径匹配 `packages/openclaw-plugin/.*` 时，检查是否包含 `createPainSignalBridge`。"

### Fixture B: 明确的可检测重复错误 (Repeated Detectable Error)
*   **模拟输入 (Pain)**：Agent 尝试运行一个 Node.js 脚本，但由于缺少 `.env` 文件导致抛出 `Missing environment variables`。
*   **期望输出类型**：`[rule]`
*   **期望逻辑**：
    *   `rule` (带 triggerPattern): "当工具为 `bash` 且执行 `node` 命令前，必须验证存在 `.env` 文件或相关环境变量。" (不再强行塞一个 principle 凑数)。

### Fixture C: 明确的代码修复机会 (Clear Code-level Fix)
*   **模拟输入 (Pain)**：TSC 编译报错 `Property 'xyz' does not exist on type 'ABC'`，且日志明确指出了是第 42 行少了一个属性定义。
*   **期望输出类型**：`[implementation]`
*   **期望逻辑**：直接建议修改 `ABC` 的接口定义代码。

### Fixture D: 证据不足 (Insufficient Evidence)
*   **模拟输入 (Pain)**：一次 `bash` 执行了 `npm install`，卡住了 300 秒然后 Timeout。没有其他异常日志。
*   **期望输出类型**：`[defer]`
*   **期望逻辑**：不做过度推断，直接挂起。

---

## 4. Prompt 修改指南 (Implementation Guidelines)

修改 `packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.ts`。

**修改要求**：
1.  **打破排序特权**：移除 `recommendations` 数组中第一个必须是 `principle` 且带有详尽字段的模板。
2.  **属性平权**：将模板修改为一个泛型的对象说明。明确指出 `triggerPattern` 并非只有 `principle` 独享，而是当选择 `rule` 时**极其重要**的字段。
3.  **不修改 Schema**：绝对不要修改 `DiagnosticianOutputV1Schema` 的 Zod 定义（不改表结构），只改发给大模型的字符串（改填写指南）。

例如（仅供开发参考，非最终代码）：
```json
"recommendations": [
  {
    "kind": "principle|rule|implementation|defer",
    "description": "<具体建议>",
    "triggerPattern": "<正则/关键词。注：若 kind 为 rule，强烈建议提供物理拦截的 triggerPattern>",
    "action": "<期望的行为>",
    "abstractedPrinciple": "<如果是 principle 才填>"
  }
]
```

---

## 5. 验收标准 (Acceptance Criteria)

1.  `prompt-builder tests` 必须包含对四象限 Taxonomy 的断言。
2.  `diagnostician output validator` 测试保持 100% 绿灯。
3.  现有所有的 Runtime V2 E2E 测试不得遭到破坏。
4.  在控制台或注释中，明确声明 Diagnostician 仅负责**推荐分类 (recommendation taxonomy)**，绝不直接执行突变 (No Execution)。
5.  **绝对红线**：不碰 `RuleHost`、不改 `Ledger` 数据结构、不引入自动剪枝。本任务仅聚焦于“大脑”的输出调优。