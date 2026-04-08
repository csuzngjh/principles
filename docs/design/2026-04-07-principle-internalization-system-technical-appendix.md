# 原则内化系统技术设计附录

> **日期**: 2026-04-07  
> **状态**: Proposed  
> **主文档**: `docs/design/2026-04-07-principle-internalization-system.md`  
> **GSD 对齐**: 对应 `.planning` 中的 `v1.9.0 Principle Internalization System` milestone，主要支撑 Phase 12-15  
> **目的**: 补充在线代码实现支线的技术协议，重点定义 `Rule Host`、`RuleImplementationArtifact`、coverage 计算与 promotion 约束。  

---

## 1. 附录范围

本附录只讨论原则内化系统中的一条实现支线：

> `Principle -> Rule -> Implementation(type=code)`

也就是主文档中被称为 `DHSE` 的那条 code implementation 支线。

本附录不覆盖：

- skill / prompt SOP 具体编辑策略
- LoRA 训练流程
- full fine-tune 管线
- 完整的 nocturnal UX / review UI

本附录重点回答三个问题：

1. `Rule Host` 如何安全、稳定地运行规则代码实现
2. `RuleImplementationArtifact` 应该长什么样
3. Rule / Principle 的覆盖率如何定义与计算

---

## 2. Rule Host 设计目标

`Rule Host` 是在线态执行 `Implementation(type=code)` 的宿主层。

它的职责不是“运行任意脚本”，而是：

1. 加载已晋升为 active 的规则代码实现
2. 为实现构造受限输入快照
3. 调用固定接口
4. 收集决策与诊断信息
5. 与现有 gate 链协同

### 2.1 设计原则

#### 1. 宿主控制一切

规则代码不得自行读取工作区、导入模块、执行命令、访问网络。  
它只能消费宿主提供的受限输入和 helper。

#### 2. 规则代码是“受限能力实现”，不是插件补丁

它们不允许修改：

- `gate.ts`
- principle tree store
- promotion 状态
- 运行时配置

#### 3. 固定接口优于自由形式

每个 code implementation 都必须导出统一协议，便于：

- 离线回放
- trace 记录
- promotion 验证
- 结果对比

#### 4. fail closed, but bounded

当实现执行出错时，宿主应倾向保守，但不能把整个系统拖死。

推荐策略：

- 对高风险动作，默认 `block`
- 对低风险动作，可降级为 `requireApproval`
- 记录 host / implementation 异常 telemetry

---

## 3. Rule Host 在 gate 链中的位置

在线态建议执行顺序：

`Thinking Checkpoint -> GFI -> Rule Host -> Progressive Gate -> Edit Verification`

### 3.1 为什么放在 GFI 之后

- 高疲劳状态下不应再运行复杂规则实现
- 能节省无意义的 code implementation 计算
- 降低低质量状态下的噪声判断

### 3.2 为什么放在 Progressive Gate 之前

- 让原则代码实现先对“是否符合原则”发声
- `Progressive Gate` 继续作为宿主级能力保险层保底
- 未来逐步吸收部分 Progressive 逻辑时，迁移路径更自然

### 3.3 为什么不放在 Edit Verification 之后

- `Edit Verification` 解决的是参数真实性问题
- Rule Host 处理的是行为边界与原则约束
- 它们职责不同，且 Edit Verification 必须靠后做最终真实性收口

---

## 4. Rule Host 组件结构

建议最小结构：

```text
src/
  core/
    principle-internalization/
      rule-host.ts
      rule-registry.ts
      rule-loader.ts
      rule-evaluator.ts
      rule-host-types.ts
      rule-host-helpers.ts
      rule-host-telemetry.ts
```

### 4.1 `rule-host.ts`

职责：

- 在线入口
- 组织加载、执行、决策合并
- 返回给 `gate.ts` 的最终结果

### 4.2 `rule-registry.ts`

职责：

- 解析当前 active code implementations
- 根据 principle / rule / implementation 状态决定哪些实现可被在线加载

### 4.3 `rule-loader.ts`

职责：

- 加载实现代码
- 校验 manifest 与 entry 的完整性
- 管理缓存

### 4.4 `rule-evaluator.ts`

职责：

- 构造 `RuleHostInput`
- 调用实现的固定接口
- 合并多个结果

### 4.5 `rule-host-helpers.ts`

职责：

- 向规则实现暴露白名单 helper

### 4.6 `rule-host-telemetry.ts`

职责：

- 记录：
  - 命中情况
  - 执行耗时
  - 决策结果
  - host 异常
  - implementation 异常

---

## 5. Code Implementation 固定接口

### 5.1 目标

规则代码必须是“可评估、可回放、可解释”的受限实现。

### 5.2 推荐接口

每个 `Implementation(type=code)` 入口文件导出：

```ts
export const meta = {
  implementationId: string,
  ruleId: string,
  principleId: string,
  version: string,
  priority: 'P0' | 'P1' | 'P2',
}

export function evaluate(input: RuleHostInput): RuleHostDecision
```

### 5.3 `RuleHostInput`

输入由宿主构造，不允许实现自己扩展环境。

建议结构：

```ts
interface RuleHostInput {
  action: {
    toolName: string
    normalizedPath: string | null
    paramsSummary: Record<string, unknown>
  }
  workspace: {
    workspaceDir: string
    isRiskPath: boolean
    planStatus: 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN'
    hasPlanFile: boolean
    existingFiles: string[]
  }
  session: {
    sessionId?: string
    currentGfi: number
    recentThinking: boolean
  }
  evolution: {
    epTier: number
  }
  derived: {
    estimatedLineChanges: number
    bashRisk: 'safe' | 'normal' | 'dangerous' | 'unknown'
  }
  helpers: RuleHostHelpers
}
```

### 5.4 `RuleHostDecision`

```ts
interface RuleHostDecision {
  matched: boolean
  decision?: 'allow' | 'block' | 'requireApproval'
  reason?: string
  evidence?: string[]
  suggestedFix?: string
}
```

要求：

- 只允许返回纯数据
- 不允许附带副作用
- 不允许直接修改输入

---

## 6. Helper 白名单

用户已经明确接受“最小 helper 白名单收敛”。

### 6.1 第一版允许的 helper

```ts
interface RuleHostHelpers {
  toolIs(name: string): boolean
  pathMatches(pattern: string): boolean
  isRiskPath(): boolean
  planStatus(): 'NONE' | 'DRAFT' | 'READY' | 'UNKNOWN'
  fileExists(path: string): boolean
  hasFile(name: string): boolean
  estimatedLineChanges(): number
  currentGfi(): number
  currentEpTier(): number
  bashCommandRisk(): 'safe' | 'normal' | 'dangerous' | 'unknown'
}
```

### 6.2 第一版明确禁止的能力

- 任意文件 IO
- 目录遍历
- `import()` / `require()`
- `eval`
- `Function`
- 子进程执行
- 网络访问
- 动态路径解析

### 6.3 设计意图

规则代码的目标是表达复杂判断，不是获取系统控制权。

---

## 7. 决策合并模型

一个 action 可能命中多个 active code implementations。

### 7.1 合并顺序

建议：

1. 按 `priority` 从高到低执行
2. 在同 priority 内按 implementationId 稳定排序

### 7.2 合并规则

- 第一个 `block` 立即终止
- 所有 `requireApproval` 合并为一个审批对象
- 所有 `allow` 不单独形成最终决策
- 若没有命中，则返回 `undefined`

### 7.3 为什么不做“最后一条覆盖前一条”

因为这会让规则间冲突不可解释，并使回放评估难以稳定。

---

## 8. RuleImplementationArtifact 数据契约

该 artifact 是休眠态产出的代码实现候选，不是在线直接运行的资产。

### 8.1 建议结构

```ts
interface RuleImplementationArtifact {
  artifactId: string
  principleId: string
  ruleId: string
  sourceSnapshotRef: string
  sourcePainIds: string[]
  sourceGateBlockIds: string[]
  sourceTrajectoryIds?: string[]
  candidateCode: string
  helperUsage: string[]
  expectedDecision: 'allow' | 'block' | 'requireApproval'
  rationale: string
  evaluationReport?: RuleImplementationEvaluationReport
  createdAt: string
}
```

### 8.2 各字段语义

#### `principleId`

绑定上层语义来源，确保候选不是无源之水。

#### `ruleId`

绑定到原则树的 trunk 层，而不是直接跨层挂到 Principle。

#### `sourceSnapshotRef`

指向 nocturnal 结构化快照来源，便于人工审查与回放。

#### `sourcePainIds`

明确该候选试图修复哪些痛苦事件。

#### `sourceGateBlockIds`

记录它是从哪些阻断、冲突或误杀上下文中抽象出来的。

#### `candidateCode`

候选实现代码正文。

#### `helperUsage`

显式列出使用的 helper，有助于审计和未来做复杂度控制。

#### `expectedDecision`

该候选预期在主触发场景中返回的主决策。

#### `rationale`

解释该候选为何被生成，与 Principle / Rule 的关系是什么。

#### `evaluationReport`

运行离线回放后的结果。未通过评估前可为空。

---

## 9. RuleImplementationEvaluationReport

建议结构：

```ts
interface RuleImplementationEvaluationReport {
  evaluatedAt: string
  status: 'passed' | 'failed'
  metrics: {
    negativeHitRate: number
    positivePassRate: number
    anchorPassRate: number
    executionLatencyMsP95: number
  }
  failures: Array<{
    sampleId: string
    category: 'pain-negative' | 'success-positive' | 'principle-anchor'
    reason: string
  }>
  summary: string
}
```

### 9.1 作用

这份报告的目标不是好看，而是为 promotion 提供单一依据。

---

## 10. 样本体系

主文档中已定义三类样本，本附录进一步约束其技术使用方式。

### 10.1 `pain-negative`

含义：

- 历史上真正导致 pain 或应被拦截的行为

来源：

- `pain_detected`
- gate block
- nocturnal 反思定位出的坏 action

期望：

- 候选实现应命中并返回合理决策

### 10.2 `success-positive`

含义：

- 历史上成功且不应被误杀的行为

来源：

- 成功工具调用
- nocturnal 保留下来的正向轨迹节点

期望：

- 候选实现不应新增误杀

### 10.3 `principle-anchor`

含义：

- 不是从痛苦事件反推，而是从 Principle / Rule 前向推导出的锚样本

作用：

- 防止系统只做事后学习
- 保证 Principle 的前向约束能力

---

## 11. 离线回放协议

### 11.1 为什么必须有离线回放

用户已明确要求：

> 部署前必须经过离线样本回放

这是 code implementation 支线最重要的安全门槛。

### 11.2 最小执行流程

```text
candidate artifact
  ↓
compile / load check
  ↓
sample replay
  ├─ pain-negative
  ├─ success-positive
  └─ principle-anchor
  ↓
evaluation report
  ↓
promotion decision
```

### 11.3 最低通过门槛

建议：

1. 新关联 `pain-negative` 必须命中
2. 不得新增 `success-positive` 误杀
3. `principle-anchor` 通过率达到阈值
4. 执行延迟低于阈值
5. 结果稳定可复现

---

## 12. Promotion 模型

### 12.1 生命周期状态

建议：

- `candidate`
- `active`
- `disabled`
- `archived`

### 12.2 迁移规则

#### `candidate -> active`

需要：

- 通过离线回放
- 有完整 evaluationReport
- 无重大 host policy 冲突

#### `active -> disabled`

触发条件：

- 线上误杀率异常
- 实现执行异常连续触发
- 与更高优先级实现冲突

#### `disabled -> archived`

触发条件：

- 被新实现替代
- 已不再服务任何 Rule

### 12.3 不做什么

第一版不做：

- 候选自动上线
- 无人工观察窗口的自推进 promotion
- 候选自动覆盖旧实现

---

## 13. Rule / Principle coverage 计算

这是整个 Principle Tree 能否真正驱动 lifecycle 的关键。

### 13.1 Rule coverage 的目标

`Rule.coverageRate` 不应只是“是否存在实现”，而应表达：

> 这个 Rule 在相关场景中，被多少稳定 implementation 真正覆盖住了。

### 13.2 Rule coverage 的第一版近似定义

建议：

```text
Rule.coverageRate =
  0.5 * related_negative_hit_rate
  + 0.3 * principle_anchor_pass_rate
  + 0.2 * implementation_stability_score
```

其中：

- `related_negative_hit_rate`
  与该 Rule 相关的负样本命中率
- `principle_anchor_pass_rate`
  由 Principle/Rule 前向定义的锚样本通过率
- `implementation_stability_score`
  active implementations 的稳定性得分

### 13.3 false positive rate

`Rule.falsePositiveRate` 建议定义为：

```text
误杀的 success-positive 数 / 相关 success-positive 总数
```

### 13.4 为什么 coverage 不等于 100% 命中负样本

因为只命中历史负样本，不代表真正覆盖了 Principle 的语义边界。

需要 anchor 样本，才能让 coverage 不只是“记住旧伤口”。

---

## 14. Principle adherence 与 deprecated

### 14.1 Principle adherenceRate

建议基于：

- 相关 Rule 的 coverageRate
- 线上重复犯错率
- nocturnal 复盘中的原则遵守率

### 14.2 Principle 内化完成判断

某个 Principle 被视为“已内化”，建议同时满足：

1. 其关键 Rule 的 coverageRate 稳定达阈值
2. repeated pain 明显下降
3. 线上 adherenceRate 稳定
4. 已有 active implementation 持续支撑
5. 不依赖频繁 prompt 注入仍能维持行为

### 14.3 deprecated 不是删除

`deprecated` 的语义应理解为：

- 该 Principle 已经被更低层稳定吸收
- 不再需要持续作为高优先级显式提醒
- 仍保留历史与审计记录

---

## 15. Implementation 目录与存储建议

### 15.1 原则树语义主账本

建议继续由 principle tree store 维护关系：

- Principle
- Rule
- Implementation

### 15.2 code implementation 实体文件

建议结构：

```text
.principles/
  implementations/
    code/
      <implementation-id>/
        manifest.json
        entry.ts
        tests.jsonl
        last-eval.json
```

### 15.3 manifest 建议字段

```ts
interface CodeImplementationManifest {
  implementationId: string
  principleId: string
  ruleId: string
  status: 'candidate' | 'active' | 'disabled' | 'archived'
  version: string
  entry: string
  helperUsage: string[]
  sourceArtifactId?: string
  createdAt: string
  lastEvaluatedAt?: string
}
```

说明：

- Principle / Rule / Implementation 的主关系仍以 principle tree store 为准
- 文件目录用于实体代码与评估工件持久化

---

## 16. 与 Nocturnal 的复用边界

### 16.1 可直接复用

- target selection
- structured snapshot extraction
- principle-aware context threading
- arbiter / executability 风格的候选门禁骨架
- persistence 过程

### 16.2 不应强行复用

- 当前 `NocturnalArtifact` 的语义本身
- ORPO 样本格式
- “betterDecision / badDecision” 工件协议

原因：

- rule-code candidate 与 behavior sample 是不同工件
- 共享骨架，不共享产物协议

### 16.3 正确关系

应理解为：

> nocturnal 是候选研究与验证工厂，能够生产多类 implementation 候选工件。

---

## 17. Progressive Gate 的技术定位

用户已明确决定当前继续保留 `Progressive Gate`。

### 17.1 当前意义

它不是“多余的一层 gate”，而是：

- EP/Tier 能力边界
- 风险路径权限保险
- 在新 code implementation 支线成熟前的宿主保底层

### 17.2 为什么当前不替代

如果现在删除，会出现：

1. 能力边界真空
2. rule host 尚未成熟时失去宿主级保险
3. 无法把新系统与旧能力边界做对比评估

### 17.3 长期方向

长期可考虑：

- 将部分 Progressive 逻辑吸收进 Principle Internalization System
- 但仍保留少量不可演化的宿主硬边界

---

## 18. 第一阶段技术落地顺序

### Phase A: 宿主收口

- 删除 `message-sanitize.ts`
- 保留 `Thinking Checkpoint`
- 保留 `GFI`
- 保留 `Progressive Gate`
- 保留 `Edit Verification`

### Phase B: 原则树实体化

- Rule / Implementation store 真正落地
- Principle -> Rule -> Implementation 关系可写入、可读取、可统计

### Phase C: Rule Host MVP

- 建立固定接口
- 建立 helper 白名单
- 接入 gate 链
- 支持手工 candidate 运行

### Phase D: RuleImplementationArtifact 管线

- 新增 nocturnal 工件协议
- 建立离线回放
- 输出 evaluation report

### Phase E: coverage 与 lifecycle

- Rule coverageRate 计算
- falsePositiveRate 计算
- Principle adherence / deprecated 条件接入

---

## 19. 结论

这条 code implementation 支线的关键不在“让 LLM 写 JS”，而在：

1. 让代码实现成为 Principle Tree 中合法的 `Implementation(type=code)`
2. 让宿主掌握执行边界
3. 让 nocturnal 产出可验证候选而不是直接上线脚本
4. 让 coverage、误杀、promotion、deprecated 成为闭环

如果这四点成立，DHSE 才不是一堆会漂移的脚本，而是原则内化系统中的一条稳定支线。
