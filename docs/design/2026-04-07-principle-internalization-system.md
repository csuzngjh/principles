# 原则内化系统架构设计

> **日期**: 2026-04-07  
> **状态**: Proposed  
> **定位**: Principles Disciple 下一阶段的总框架设计  
> **GSD 对齐**: 对应 `.planning` 中的 `v1.9.0 Principle Internalization System` milestone  
> **替代性说明**: 本文档用于收敛并重构 `2026-04-06-dynamic-harness-evolution-engine.md` 的系统 framing。  
> **关联文档**:
> - `docs/architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md`
> - `docs/design/nocturnal-evolution-agent-sleep-reflection.md`
> - `packages/openclaw-plugin/src/types/principle-tree-schema.ts`

---

## 1. 执行摘要

PD 系统下一阶段不应继续围绕“动态规则代码引擎”单点扩展，而应升级为一个更高层的**原则内化系统**。

系统的目标不是单纯增加更多拦截逻辑，而是将抽象原则逐步内化为更稳定、更具体、更自动的行为载体，使智能体在长期运行中逐步形成稳定行动品格。

原则不是最终形态，而是高泛化、高价值的金标准标签。  
真正能稳定改变行为的是原则被蒸馏后的实现载体，包括：

- `skill / prompt SOP`
- `rule-code`
- `LoRA`
- `full fine-tune`

因此，未来系统的总调度中心不应是单独的 DHSE，而应是：

**Principle Internalization Strategy**

它负责判断：

1. 哪个原则当前失效了
2. 失效属于哪类问题
3. 最便宜、最合适的内化方式是什么
4. 当前内化到什么程度
5. 是否需要升级到更重的实现形式

在这个框架下：

- `Thinking OS` 是最高层认知品格框架
- `Principles` 是金标准标签
- `Rules` 是场景化可验证语义
- `Implementations` 是真实行为载体
- `Nocturnal` 是候选研究与验证上游
- `DHSE` 只是 “原则 -> rule-code implementation” 的一条支线

---

## 2. 设计背景

### 2.1 当前问题

PD 当前已经具备：

- Principle / pain / evolution 机制
- gate 链路
- nocturnal 休眠反思系统
- trajectory 数据基础设施

但这些能力仍分散存在，尚未形成统一的“原则蒸馏闭环”。

当前主要问题有：

1. **原则过于抽象**
   原则能表达价值，但和具体任务、路径、工具调用、失败模式之间的映射不稳定。

2. **LLM 会忽略原则**
   抽象原则即便被注入上下文，仍然会在复杂任务、长上下文和局部目标压力下被弱化。

3. **原则没有内化为多层实现**
   原则大多停留在 prompt、文档、经验层，未系统化转化为 skill、规则代码、LoRA 等多形态实现。

4. **当前设计过度聚焦 code implementation**
   旧 DHSE 文档将“复杂规则代码演化”视为中心，但这会错误地把所有原则失效都往代码实现上压，违背“最低成本内化优先”的哲学。

5. **宿主硬边界与可演化边界混淆**
   当前 gate 体系里有一些宿主级硬保险，例如 `Thinking Checkpoint`、`GFI Gate`、`Progressive Gate`、`Edit Verification`。这些不能在新系统未成熟时被一并替换。

### 2.2 新系统的根本目标

新系统的根本目标不是“写更多规则”，而是：

> 将高抽象原则持续蒸馏为多种实现载体，使智能体的行为逐渐脱离对原则文本的依赖，而转向对原则内化结果的自动遵守。

---

## 3. 设计哲学

### 3.1 行动品格优先于单次成功率

PD 的优化目标不是局部任务成功率最大化，而是优先塑造稳定、可靠、可审计的行动品格。

任务成功率是重要结果，但它是内化行动品格后的自然产物，不应成为唯一目标函数。

### 3.2 原则是金标准标签，不是最终执行形式

原则的角色类似高质量监督标签：

- 泛化性强
- 价值密度高
- 可跨任务迁移

但原则并不直接等于执行逻辑。  
原则必须被拆解成 Rule，并进一步落地为 Implementations，才会真正改变系统行为。

### 3.3 最便宜的内化方式优先

原则内化的默认顺序为：

`skill / prompt SOP > rule-code > LoRA > full fine-tune`

原因：

- skill / prompt 改动成本最低，适合流程性、习惯性修复
- rule-code 适合高风险、强确定性的即时边界
- LoRA 适合风格、习惯、长期偏好
- full fine-tune 成本最高，仅作为最后手段

系统应先判断“最便宜方案是否足够”，而不是默认追求更硬、更复杂的实现形式。

### 3.4 在线态激进，休眠态纠偏

系统运行分为两种状态：

- **在线态**：有用户交互、正在执行任务
- **休眠态**：智能体在空闲窗口进入反思与蒸馏过程

在线态的目标是快速止血，因此允许更激进的拦截。  
休眠态的目标是纠偏、泛化、消除误杀、生成更优实现候选。

### 3.5 最不能接受的失败

系统可接受一定程度的误杀，但最不能接受的是：

> 系统已经见过某类错误，却仍然反复犯同类错误。

因此，原则内化系统的第一职责是“吸收教训并形成新边界”，而不是只做温和提醒。

---

## 4. 总体架构

```text
Thinking OS
   ↓
Principles
   ↓
Principle Internalization Strategy
   ├─ Principle failure diagnosis
   ├─ Internalization type routing
   ├─ Candidate generation policy
   ├─ Promotion / rollback policy
   └─ Coverage / deprecation accounting
   ↓
Rules
   ↓
Implementations
   ├─ skill / prompt SOP
   ├─ rule-code
   ├─ LoRA
   └─ full fine-tune
```

### 4.1 各层角色

#### Thinking OS
最高层认知品格框架，定义智能体应如何思考。

#### Principles
价值和约束的抽象表达，是全系统的金标准标签层。

#### Principle Internalization Strategy
总调度者。决定“某个原则应该如何被内化”。

#### Rules
原则的可验证、场景化语义表达，是原则树的树干层。

#### Implementations
原则真正落地的载体，是树叶层。

---

## 5. Principle Internalization Strategy

这是本设计新增的核心概念。

### 5.1 职责

对每条原则，持续判断：

1. 当前是否仍频繁失效
2. 失效属于什么类型
3. 哪种实现形式最合适
4. 当前已有实现是否足够
5. 是否需要升级实现形式
6. 是否已达到可 deprecated 的状态

### 5.2 默认决策流程

#### Step 1: 识别原则失效

基于以下信号判断原则是否没有真正生效：

- pain signals
- gate block
- failure trajectory
- nocturnal snapshot
- adherence rate 降低
- same-class repeated error

#### Step 2: 判断失效类型

失效类型示例：

- 冲动执行，缺少调研
- 失败后盲目重试
- 高风险边界被越过
- 长程规划不足
- 原则已注入，但执行稳定性仍差

#### Step 3: 选择最便宜的内化方式

按默认优先顺序尝试：

1. `skill / prompt SOP`
2. `rule-code`
3. `LoRA`
4. `full fine-tune`

#### Step 4: 生成候选

由休眠态研究系统提出候选 implementation。

#### Step 5: 候选验证

通过离线样本回放、仲裁、可执行性校验、覆盖率与误杀评估进行验证。

#### Step 6: 晋升或退回

- 通过则 promotion
- 失败则回退
- 不够稳定则保持 candidate

---

## 6. Principle / Rule / Implementation 三层定义

### 6.1 Principle

回答的问题：

> 智能体应成为什么样的人？

特点：

- 抽象
- 跨场景
- 高泛化
- 高价值密度

### 6.2 Rule

回答的问题：

> 在什么场景下，必须怎么做或不能怎么做？

Rule 仍是原则树中的“树干”，不等于代码包本身。

Rule 负责：

- 绑定 Principle
- 定义场景触发条件
- 定义 enforcement 语义
- 统计 coverage / false positive
- 关联多个 implementation

### 6.3 Implementation

回答的问题：

> 系统通过什么机制真正改变行为？

允许以下形态：

- `skill`
- `prompt`
- `code`
- `lora`
- `test`

关键结论：

> 规则代码包不是 Rule，而是 `Implementation(type=code)`。

这能避免新系统与原则树架构发生概念冲突。

---

## 7. Implementation 形态与适用范围

### 7.1 skill / prompt SOP

适用：

- 习惯性问题
- 流程问题
- 前置调研不足
- 可通过工作流提示修正的问题

优点：

- 便宜
- 快速
- 易修改

缺点：

- 强约束力有限
- 长上下文下仍可能被忽略

### 7.2 rule-code

适用：

- 高风险边界
- 高确定性、可判定约束
- 需要即时阻断的问题

优点：

- 即时生效
- 可硬拦截
- 可结构化解释

缺点：

- 维护成本高于 skill
- 容易误杀
- 若执行边界失控，会引入宿主安全风险

### 7.3 LoRA

适用：

- 风格性行为
- 长程规划倾向
- “先调研、先诊断、少冲动”这类习惯性偏好

优点：

- 可提升习惯稳定性
- 对复杂行为风格更自然

缺点：

- 不适合承担即时边界控制
- 验证与回滚成本较高

### 7.4 full fine-tune

适用：

- 插件层和 LoRA 层都无法有效内化的问题

定位：

- 最后手段
- 默认不主动选择

---

## 8. 在线态架构

在线态的目标是：

1. 及时止血
2. 控制高风险行为
3. 提供结构化反馈
4. 为休眠态提供高质量诊断素材

### 8.1 Gate 链顺序

推荐顺序：

`Thinking Checkpoint -> GFI -> Rule Host -> Progressive Gate -> Edit Verification`

### 8.2 Thinking Checkpoint

定位：

- 宿主级硬边界
- 高层认知约束入口

保留原因：

- 它体现 Thinking OS 的最高优先级地位
- 适合作为“先思考再执行”的宪法级约束
- 不应在新系统未成熟前移除

### 8.3 GFI Gate

定位：

- 状态保护层

保留原因：

- 在高疲劳状态下，优先阻断危险操作
- 避免系统在低质量状态下仍执行复杂行为和规则代码

### 8.4 Rule Host

定位：

- `Implementation(type=code)` 的在线执行宿主

作用：

- 加载 active 规则代码实现
- 输入宿主构造的受限快照
- 输出 `allow / block / requireApproval`
- 返回结构化诊断信息和纠正建议

### 8.5 Progressive Gate

定位：

- 宿主级能力边界保险层

当前存在意义：

1. 依据 EP/Tier 做阶段权限限制
2. 在新内化系统尚未成熟前，防止能力真空
3. 作为比规则代码更稳定、更少变化的权限收口层

为什么暂不删除：

- Rule Host 尚未建立
- 规则覆盖率、promotion、误杀修正闭环尚未跑通
- 如果现在移除，会形成权限真空

长期方向：

- Progressive Gate 可被部分吸收进原则内化系统
- 但应保留少量宿主级硬边界作为不可演化保底层

### 8.6 Edit Verification

定位：

- 编辑真实性和参数校验层

保留原因：

- 它解决的是参数真实性问题，不是原则内化问题
- 不适合迁入可演化规则代码层

---

## 9. 休眠态架构

休眠态不是按人类昼夜定义，而是按系统空闲窗口定义。

### 9.1 休眠态角色

休眠态系统首先是：

- 研究员
- 候选蒸馏器
- 纠偏器

它不是：

- 默认自动上线器
- 最终裁判

### 9.2 可复用现有 nocturnal 管线

现有 nocturnal 已具备成熟骨架：

- target selection
- trajectory snapshot extraction
- principle-aware reflection
- arbiter validation
- executability validation
- persistence
- threshold adjustment

因此，不应从零再造新的后台管线，而应扩展现有 nocturnal 为多工件研究系统。

### 9.3 在线态与休眠态分工

#### 在线态

- 激进拦截
- 快速止血
- 容忍短期误杀
- 记录丰富诊断素材

#### 休眠态

- 分析误杀
- 分析重复犯错
- 提出更便宜或更稳定的内化候选
- 对现有实现做升级/降级建议

---

## 10. Nocturnal 的多工件扩展

### 10.1 当前工件

当前 nocturnal 的核心产物是：

- `behavioral-sample artifact`

主要用途：

- ORPO / LoRA 训练样本

### 10.2 新增工件

未来应新增：

- `rule-implementation artifact`

用途：

- 生成 `Implementation(type=code)` 候选
- 进入离线评估
- promotion 后写入 active implementation registry

### 10.3 原则

Nocturnal 不直接产出“最终规则真理”，而是产出：

- implementation 候选
- 及其 rationale、来源与验证报告

---

## 11. RuleImplementationArtifact

新增候选工件建议定义如下：

```text
RuleImplementationArtifact
  artifactId
  principleId
  ruleId
  sourceSnapshotRef
  sourcePainIds
  sourceGateBlockIds
  candidateCode
  helperUsage
  expectedDecision
  evaluationReport
  createdAt
```

### 11.1 语义

该工件不是在线直接运行的代码，而是：

- 一份待验证 implementation 候选
- 可追踪来源
- 可回放评估
- 可晋升或回滚

### 11.2 与原则树的关系

promotion 后，该工件将成为：

- 一个 `Implementation(type=code)`
- 关联到某个 `Rule`
- 并间接服务于某个 `Principle`

---

## 12. Rule Host 设计约束

虽然本文档不展开具体代码实现，但必须先钉死几个约束。

### 12.1 Rule Host 的职责

Rule Host 负责：

- 加载 active code implementations
- 构造受限输入快照
- 运行实现
- 收集结果
- 输出结构化诊断

### 12.2 Rule Host 不负责

Rule Host 不负责：

- 让候选代码直接访问工作区 IO
- 让候选代码自由 import
- 自动修改宿主主逻辑
- 自行决定 promotion

### 12.3 代码实现边界

规则代码是受限能力实现，不是自由脚本系统。

默认策略：

- 使用固定接口
- 只能访问 helper 白名单
- 输入为宿主构造快照
- 输出为纯决策与诊断结构

---

## 13. 样本与验证体系

### 13.1 三类样本

离线评估至少应包括三类样本：

#### 1. pain-negative

历史上真正导致 pain 或应被阻断的行为。

来源：

- pain_detected
- gate block
- nocturnal 复盘中定位到的坏 action

#### 2. success-positive

历史上成功且不应被误杀的行为。

来源：

- 正常成功工具调用
- 夜间系统保留的正向轨迹

#### 3. principle-anchor

不依赖历史 pain，而是直接由原则推导出的锚样本。

用途：

- 保证系统不会只做事后学习
- 让原则能前向约束未来行为

### 13.2 promotion 最低门槛

新 implementation 至少需要满足：

1. 命中新 pain 对应负样本
2. 不新增 success-positive 的误杀
3. 不破坏已有高优先级实现的通过率
4. 运行成本在阈值内
5. 结果可复现、可回滚

---

## 14. 覆盖率、内化度与 deprecated

### 14.1 Rule 覆盖率

Rule 的覆盖率不是简单“有没有实现”，而是：

- 对相关违反场景是否稳定命中
- 是否存在过高误杀
- 是否已有多个实现形态共同支撑

### 14.2 Principle 内化完成的定义

某原则可视为“真正内化”，需同时满足：

1. 不再频繁被违反
2. 即使不显式注入原则文本，系统也能自然表现
3. 已有稳定 implementation 覆盖
4. adherenceRate 达到阈值
5. rule coverage 达到阈值

### 14.3 deprecated 逻辑

原则被 deprecated 不是因为不重要，而是因为：

> 它已经被更低层实现吸收，不再需要持续以高优先级显式提醒。

---

## 15. 对现有模块的影响

### 15.1 保留

- `Thinking Checkpoint`
- `GFI Gate`
- `Progressive Gate`
- `Edit Verification`
- nocturnal service 骨架
- principle tree schema

### 15.2 删除

建议删除：

- `message-sanitize.ts`

原因：

- 不属于原则内化主轴
- 不属于核心行为约束路径
- 与 trajectory / before_message_write 采样有冲突
- 可作为系统瘦身的第一步

### 15.3 新增

后续需新增：

- Principle Internalization Strategy 相关结构
- Rule Host
- RuleImplementationArtifact 协议
- implementation promotion / rollback 基础设施
- principle coverage accounting

---

## 16. 实施路线图

### Phase 1: 总框架对齐

目标：

- 将系统 framing 从“动态代码 harness”提升为“原则内化系统”
- 明确 DHSE 是 code implementation 支线
- 对齐 nocturnal 与 principle tree

输出：

- 新设计文档
- 原有 DHSE 文档标记为需收敛

### Phase 2: Principle Tree 真正落地

目标：

- Rule / Implementation 存储与关系落地
- 原则树从文档层进入可运行主账本

输出：

- Rule CRUD
- Implementation CRUD
- Principle -> Rule -> Implementation 关系存储

### Phase 3: 在线 code implementation 支线

目标：

- 删除 `message-sanitize.ts`
- 建立 Rule Host
- 在 gate 链中接入 code implementation

输出：

- 在线 `Rule Host`
- fixed interface code implementation 支持

### Phase 4: 休眠态多工件扩展

目标：

- 在 nocturnal 中新增 `RuleImplementationArtifact`
- 复用现有 selector / extractor / arbiter / executability 骨架

输出：

- 规则代码候选工件
- 对应评估与持久化流程

### Phase 5: Principle Internalization Strategy

目标：

- 建立“失效类型 -> 内化方式”的路由策略
- 默认最便宜内化优先

输出：

- 内化路由规则
- promotion / escalation 逻辑

### Phase 6: 覆盖率与生命周期闭环

目标：

- coverageRate、adherenceRate、valueScore 真正驱动生命周期
- 支持 principle deprecated automation

---

## 17. 关键决策记录

| 决策点 | 选择 | 原因 |
|---|---|---|
| 系统总框架 | Principle Internalization System | DHSE 过窄，不足以容纳多实现形态 |
| 总调度中心 | Principle Internalization Strategy | 负责选择最优内化路径 |
| 默认内化顺序 | skill > code > LoRA > full fine-tune | 最低成本优先 |
| 规则代码地位 | `Implementation(type=code)` | 避免与 Rule 层混淆 |
| 在线态策略 | 激进拦截 | 优先快速止血 |
| 休眠态策略 | 纠偏与候选研究 | 不直接等于自动上线 |
| Progressive Gate | 继续保留 | 当前仍是宿主级能力保险层 |
| message-sanitize | 删除 | 与主轴无关，且存在冲突与冗余 |

---

## 18. 最终结论

PD 的下一阶段，不应继续围绕“更多规则代码”展开，而应围绕：

> **原则如何被经济地、稳定地、分层地内化为真实行为。**

这意味着：

- Thinking OS 提供最高层行动品格
- Principles 提供金标准标签
- Rules 提供可验证语义树干
- Implementations 提供行为改变载体
- Nocturnal 负责研究和验证候选
- 在线态负责即时约束
- Principle Internalization Strategy 负责总调度

最终目标不是让原则一直停留在 prompt 中，而是让原则逐渐“消失”到系统行为里。
