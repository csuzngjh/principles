# Principles Disciple (PD) 系统诊断与修复架构指南

**核心议题：修复“脑首分离”与闭环进化引擎**

## 一、 系统现状与致命病症（The Diagnosis）

### 1. 表面症状（开发者视角）
*   **现象**：智能体（Agent）在过去一个月里“感觉没有长进”。它会在同一个坑里反复摔倒。
*   **错觉**：系统日志看似繁荣（`evolution.jsonl` 持续膨胀，原则数量从 `P_001` 增长到 `P_074`，甚至引入了复杂的痛觉传感器和旁路共情引擎）。
*   **结论**：系统拥有完美的“反思能力（Reflection）”，但彻底丧失了“执行约束能力（Enforcement）”。

### 2. 物理证据（铁证如山）
通过深度穿透 `~/.openclaw/workspace-main/` 的运行时状态与核心代码，我们发现了致命的断裂点：

*   **证据 A：空转的“执法账本”**
    在核心状态文件 `memory/.state/principle_training_state.json` 中，根节点堆满了 74 条原则元数据，但在系统真正用于运行时拦截的 `_tree` 对象里：
    ```json
    "_tree": {
      "rules": {},             // 空的！没有任何逻辑规则
      "implementations": {}    // 空的！没有任何物理拦截代码
    }
    ```
*   **证据 B：裸奔的拦截网关 (`hooks/gate.ts`)**
    在工具执行前的拦截点，系统实例化了 `RuleHost`：
    ```typescript
    const ruleHost = new RuleHost(wctx.stateDir, logger);
    const hostResult = ruleHost.evaluate(hostInput);
    ```
    但 `RuleHost._loadActiveCodeImplementations()` 在读取 `_tree.implementations` 时永远得到空数组，导致 `evaluate` 永远返回 `undefined`（即无意见，放行）。
*   **证据 C：未完成的脚手架 (`scripts/bootstrap-rules.ts`)**
    系统现存的 `bootstrap-rules` 脚本仅仅是一个“第17阶段”的占位符（Stub）。它只会向账本中写入状态为 `proposed` 的提议规则，**从未生成过任何 `.js` 物理代码文件**，拦截状态也仅仅是无用的 `warn`。

### 3. 第一性原理剖析（病因总结）
PD 的第一性原理是 **Pain + Reflection = Progress**。
目前的系统完成了前半段：`Pain -> Diagnostician -> Markdown Principles (Reflection)`。
但彻底缺失了后半段：`Markdown Principles -> Executable JS Code -> Gatekeeper Intercept (Progress)`。

**病症总结：脑首分离（Mind-Body Separation）。**
智能体就像一个背熟了《交通法规》却神经截瘫的司机。它脑子里有 74 条规则，但控制刹车（Gatekeeper）的神经是断开的。如果不打通这最后一步的“编译”，就算原则写到 P_1000，系统依然是零进化。

---

## 二、 解决方案：构建“神经中枢” (The Principle Compiler)

**核心设计理念：极简、自动、单调递增。**
我们不需要复杂的 AST 解析或庞大的模型推理。我们需要的是一个**“原则编译器（Principle Compiler）”**，它的唯一职责是将静态的 JSON/Markdown 文本转化为可执行的沙盒 JS 代码。

### 修复蓝图：3步自动编译闭环

开发 AI 需要在 `packages/openclaw-plugin/src/core/` 下创建一个全新的核心模块：`principle-compiler.ts`（并整合到后端的 Nocturnal 或同步脚本中）。

#### 步骤 1：读取与解析（Parse）
*   **输入**：读取 `principle_training_state.json` 中的根节点原则列表（`P_001` 到 `P_074`）。
*   **过滤**：筛选出 `status === 'active'` 或 `probation`，且具有明确 `triggerPattern`（正则表达式）的原则。

#### 步骤 2：生成物理代码（Codegen）
*   **动作**：对于每一条符合条件的原则（如 `P_066`），自动在 `.principles/implementations/` 目录下生成一个独立的 `.js` 拦截脚本（例如 `IMPL_066_hook.js`）。
*   **代码模板**：生成的 JS 代码必须符合 `RuleHost` 的沙盒执行标准。
    ```javascript
    // 自动生成的模板示例
    export const meta = {
      name: 'Auto_Generated_Rule_P_066',
      version: '1.0.0',
      ruleId: 'R_066_auto',
      coversCondition: 'Regex Match on Command/Path'
    };

    export function evaluate(input) {
      const targetStr = input.action.normalizedPath || input.action.paramsSummary.command || input.action.paramsSummary.path || '';
      // 动态注入原则的 triggerPattern
      const regex = /heartbeat.*loop|HEARTBEAT_OK.*task/i; 
      
      if (regex.test(targetStr)) {
        return {
          decision: 'block', // 物理阻断！
          matched: true,
          reason: '[进化拦截] 命中原则 P_066：健康检查与任务处理必须分离...'
        };
      }
      return { matched: false };
    }
    ```

#### 步骤 3：账本注册（Register & Enforce）
*   **动作**：生成的 JS 代码落地后，编译器需要通过原子操作修改 `principle_training_state.json`：
    1.  在 `_tree.rules` 中注册 `R_066_auto`，设置 `enforcement: "block"`，`type: "gate"`。
    2.  在 `_tree.implementations` 中注册 `IMPL_066_auto`，指向刚才生成的 JS 文件路径，设置 `lifecycleState: "active"`，`type: "code"`。

---

## 三、 给开发 AI 的执行指令（Directives for AI）

请接收此文档的 AI 严格按照以下顺序执行修复：

1.  **废弃旧物**：彻底重写或废弃 `packages/openclaw-plugin/src/core/bootstrap-rules.ts` 中的 Stub（占位符）逻辑。我们需要的是真正的代码生成，而不是写入 `proposed` 状态的空壳。
2.  **开发编译器 (`principle-compiler.ts`)**：
    *   实现上述的三步走逻辑（Parse -> Codegen -> Register）。
    *   确保生成的 `.js` 代码严格只使用纯 JavaScript 标准库语法，因为它将在 `node-vm-polyfill.js` 的严格沙盒中运行（无 `fs`, `require`）。
3.  **生命周期挂载**：
    *   将 `compile-principles` 动作挂载到系统的自动化流程中。最佳挂载点有两个：
        *   **同步时**：修改 `scripts/bootstrap-rules.mjs`，让它调用新的编译器逻辑，在每次部署时自动全量编译原则。
        *   **运行时**：修改 `EvolutionWorker` 或 `Nocturnal Arbiter`。当 Diagnostician 成功生成一条新原则并入库后，自动触发编译函数，实现热重载。
4.  **沙盒兼容性测试**：
    *   编写一个针对生成的 `.js` 文件的单元测试，验证 `loadRuleImplementationModule`（使用 `vm` 沙盒）能够正确提取 `evaluate` 函数并返回 `decision: 'block'`。

### 预期结果（Success Criteria）

当该方案实施完毕后，系统的状态将发生根本性改变：
1.  用户查看 `~/.openclaw/workspace-main/.principles/implementations/` 目录时，会看到数十个自动生成的 `.js` 文件。
2.  `principle_training_state.json` 中的 `_tree.rules` 和 `implementations` 将被真实数据填满。
3.  当智能体试图违背 `P_066` 时，**`gate.ts` 将物理性中断工具调用**，智能体会看到一条红色的报错信息，迫使它重新思考。
4.  **最终闭环**：Pain -> Diagnostician -> Principle -> Compiler -> RuleHost -> Gatekeeper Block。

这才是真正的“进化闭环”。请立即着手开发原则编译器。
