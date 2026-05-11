# ADR-0004: L2 硬内化升级 —— 自动修正与轨迹回放测试 (Auto-Correction & Trajectory Replay)

> **状态**: 接受 (Accepted)
> **日期**: 2026-05-11
> **相关**: DOMAIN_MODEL.md, PD_System_Dynamics_Model.md (L2 内化层)

## 1. 背景与痛点 (Context)

在当前的 PD 架构中，L2 级硬内化（Code/Hook/Tool）由 `PrincipleCompiler` 编译并在 `RuleHost` 中执行。但在实际运行中暴露出两个核心缺陷：
1. **消极拦截 (Passive Blocking)**：`RuleHost` 的裁决只有 `allow`, `block`, `requireApproval`。当 Agent 犯了微小的语法错误（如漏传参数），`block` 会直接打断任务流，迫使大模型消耗大量上下文去反思和重试，效率极低。
2. **缺乏防退化保护 (No Regression Protection)**：`PrincipleCompiler` 依赖大模型一次性生成 JavaScript 沙盒代码，直接进入 `probation`（试用期）面对真实流量。如果生成的逻辑有 Bug（例如正则表达式过于宽泛），会导致严重的误拦截（False Positive），使得 Agent “变笨”。

受“Heuristic Learning”思想启发，L2 层必须具备**残差修正（Auto-Correction）**能力，且其生成过程必须是**可回归测试（Regression-testable）**的。

## 2. 决策详情 (Decisions)

### 决策一：扩展 RuleHost 协议，支持主动“残差修正”

我们决定将 `RuleHost` 从单纯的门禁，升级为能够直接篡改（mutate）底层 Tool 执行参数的中间件。

**技术契约变更**：
在 `RuleHostResult` 中新增 `auto_correct` 决策类型：

```typescript
// packages/openclaw-plugin/src/core/rule-host-types.ts
export type RuleDecision = 'allow' | 'block' | 'requireApproval' | 'auto_correct';

export interface RuleHostResult {
  decision: RuleDecision;
  reason?: string;
  ruleId?: string;
  principleId?: string;
  // 当 decision 为 'auto_correct' 时，提供修正后的参数
  modifiedParams?: Record<string, unknown>;
  // 是否向 LLM 发送一条系统通知，告知参数被底层系统修正（隐性学习）
  notifyAgent?: boolean;
}
```

**执行流调整**：
在感知与门控层（`hooks/gate.ts` `before_tool_call`）中：
* 如果 `RuleHost` 返回 `auto_correct`，Hook 将**悄悄替换** `event.params` 为 `modifiedParams`，然后返回 `allow` 继续执行。
* 如果 `notifyAgent` 为 `true`，Hook 会将这次“修正记录”注入到 `after_tool_call` 的结果中，提醒 Agent 底层进行了自动修复。

### 决策二：引入基于轨迹的“影子回放测试”

我们决定在 `PrincipleCompiler` 管道中强制加入局部验证环（Local Sandbox Testing）。未经测试证明能够“拦截过去错误”的代码，不准进入账本。

**技术契约变更**：
引入一个新的领域实体：**`GoldenTrace`（黄金测试集）**。
1. **测试用例提取**：`Diagnostician` 在输出 Rule 建议时，必须同步提取触发该痛点时的**原始 `tool_call` 快照**（Negative Case）和一个**期望的 `tool_call` 快照**（Positive Case）。
2. **编译器本地验证 (Compiler Validator)**：
   在 `PrincipleCompiler` 生成 JS 代码之后、写入 Ledger 之前，强制执行两项沙盒验证：
   * **Test 1 (拦截/修正测试)**：输入 Negative Case，断言输出必须为 `block` 或 `auto_correct`。
   * **Test 2 (防误伤测试)**：输入 Positive Case，断言输出必须为 `allow`。

**执行流调整**：
如果生成的代码未能通过验证，`PrincipleCompiler` 会将报错反馈给大模型进行有限次数的自循环修复（Self-Correction）。若重试耗尽仍未通过，则放弃编译该 Rule，降级保留为 L1 软提示词。

## 3. 架构收益 (Consequences)

### 积极影响 (Pros)
* **大幅降低 Token 消耗与幻觉**：Agent 不需要自己去纠正低级拼写或规范错误，底层系统（L2）自动修正。
* **物理隔离的安全性增强**：每一条硬规则在上线前都经过了其对应的历史痛点（Pain Trace）的严格断言测试，降低“误拦截”风险。真正做到了“防遗忘”。
* **对齐 SD 模型**：补齐了《PD_System_Dynamics_Model.md》中 L2 层的“残差修正”系统动力学特性。

### 潜在风险 (Cons / Mitigations)
* *风险*：自动修正可能会让 Agent 产生“我写得是对的”的错觉。
* *缓解*：必须配套实现 `notifyAgent` 机制，在工具调用返回时附加上下文告警。
