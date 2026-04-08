# 动态 Harness 演化引擎

> **日期**: 2026-04-06  
> **状态**: Proposed, Reframed on 2026-04-07  
> **定位**: Principle Internalization System 中的 `Implementation(type=code)` 支线  
> **GSD 对齐**: 对应 `.planning` 中 `v1.9.0 Principle Internalization System` milestone 的 Phase 12-14 核心能力  
> **主文档**:
> - `docs/design/2026-04-07-principle-internalization-system.md`
> - `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md`
> **关联文档**:
> - `docs/architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md`
> - `docs/design/nocturnal-evolution-agent-sleep-reflection.md`

---

## 1. 文档定位

本文档不再将 DHSE 描述为 PD 系统的总框架，而将其重新定义为：

> Principle Internalization System 中，负责把抽象原则内化为 `rule-code` 的那条代码实现支线。

也就是说：

- DHSE 不是总调度层
- DHSE 不是原则树的替代物
- DHSE 不负责所有内化形式
- DHSE 只负责 `Principle -> Rule -> Implementation(type=code)` 这条路径

总调度中心已经在上层文档中被定义为：

**Principle Internalization Strategy**

DHSE 在该体系中的角色，是当某个原则更适合通过高确定性、可执行、可即时拦截的代码实现进行内化时，提供：

- 候选生成
- 离线验证
- promotion
- 在线运行
- coverage 回写

---

## 2. 为什么需要 DHSE 支线

虽然原则内化的默认优先顺序是：

`skill / prompt SOP > rule-code > LoRA > full fine-tune`

但仍然有一类问题更适合 code implementation：

1. **高风险边界**
   比如危险路径、危险命令、危险修改类型，不能只靠提示词提醒。

2. **高确定性约束**
   比如明确可判定的前置条件、顺序要求、审批要求、路径限制。

3. **即时止血需求**
   某类错误已经反复出现，系统不能等到 LoRA 或更长周期优化才阻断。

4. **解释性要求**
   某些边界不仅要拦，还要给出结构化 reason、evidence、suggestedFix。

因此，DHSE 的存在意义不是“让 LLM 随便写 JS”，而是：

> 在 Principle Internalization Strategy 判定“代码是合适内化形式”时，为系统提供可控、可验证、可回滚的代码实现通道。

---

## 3. 在总架构中的位置

完整系统关系如下：

```text
Thinking OS
   ↓
Principles
   ↓
Principle Internalization Strategy
   ├─ skill / prompt implementation route
   ├─ code implementation route  ← DHSE
   ├─ LoRA route
   └─ full fine-tune route
   ↓
Rules
   ↓
Implementations
```

DHSE 的边界必须被严格限定：

- 输入：Principle、Rule、pain、trajectory、gate block、snapshot
- 输出：`Implementation(type=code)` 候选及其验证报告

DHSE 不负责：

- 取代 Principles
- 取代 Rules
- 取代 skill / LoRA 路线
- 直接修改宿主核心源码

---

## 4. 关键概念

### 4.1 Principle

抽象价值约束，定义“智能体应成为什么样的人”。

### 4.2 Rule

原则的场景化、可验证语义，定义：

> 在什么条件下，必须做什么或不能做什么。

Rule 是树干层，不是代码包本身。

### 4.3 Code Implementation

Rule 的一种具体实现形式，记录为：

> `Implementation(type=code)`

这是 DHSE 的目标产物。

### 4.4 Rule Host

在线宿主层，负责安全地运行 active code implementations。

### 4.5 RuleImplementationArtifact

休眠态系统生成的代码候选工件，在离线评估通过前，不可直接进入在线执行。

---

## 5. DHSE 的目标

DHSE 的目标可以概括为一句话：

> 将适合 code implementation 的 Principle / Rule，持续蒸馏为更稳定的在线边界，并通过离线回放防止把新错误直接部署到宿主。

### 5.1 成功标准

一条 DHSE 支线成功运行，不是指“写出了更多代码”，而是指：

1. 相关 pain-negative 被稳定命中
2. success-positive 不被新增误杀
3. principle-anchor 样本得到前向覆盖
4. Rule.coverageRate 稳定上升
5. Principle.adherenceRate 真实改善

### 5.2 非目标

DHSE 不追求：

- 取代 skill / prompt 作为默认首选
- 让所有原则最终都变成代码
- 允许候选代码直接碰宿主核心
- 让 nocturnal 产出代码后自动上线

---

## 6. DHSE 的输入与输出

### 6.1 输入

DHSE 消费的输入主要来自四类来源：

#### 1. Principle Tree

- Principle 元信息
- Rule 元信息
- Implementation 当前状态
- coverage / adherence / false positive 指标

#### 2. 在线态运行数据

- gate block
- tool call outcome
- repeated error
- GFI / EP 环境信号

#### 3. 休眠态结构化快照

来自 nocturnal 的：

- session snapshot
- pain events
- gate blocks
- tool outcome sequences

#### 4. Principle Internalization Strategy 路由决策

只有当上层策略判断“此原则当前更适合用 code implementation 内化”时，DHSE 才被触发。

### 6.2 输出

DHSE 的直接输出有两层：

#### 候选层

- `RuleImplementationArtifact`

#### 激活层

- `Implementation(type=code)` active entries

以及一层回写：

- Rule coverage
- Rule false positive
- Principle adherence
- Principle deprecation eligibility

---

## 7. DHSE 工作流

DHSE 工作流应分为两个大阶段：

- **休眠态候选生成与验证**
- **在线态执行**

### 7.1 休眠态阶段

#### Step 1: 候选触发

触发来源：

- 某 Rule coverage 过低
- 某 Principle 重复失效
- 同类 pain 反复出现
- 现有 code implementation 误杀率升高
- 上层策略认为 skill 实现已不足

#### Step 2: 候选研究

由 nocturnal 研究员基于：

- Principle
- Rule
- snapshot
- pain
- gate block
- 历史 implementations

生成 `RuleImplementationArtifact`。

#### Step 3: 离线评估

用三类样本回放：

- `pain-negative`
- `success-positive`
- `principle-anchor`

#### Step 4: promotion 决策

通过的候选写入 principle tree 对应 Rule 的 `Implementation(type=code)` 列表，并标记为 `active`。

### 7.2 在线态阶段

在线态运行顺序：

`Thinking Checkpoint -> GFI -> Rule Host -> Progressive Gate -> Edit Verification`

DHSE 在这里体现为 `Rule Host` 运行 active code implementations。

---

## 8. Rule Host 作为 DHSE 在线执行器

DHSE 在线态不直接运行任意脚本，而由 `Rule Host` 控制。

### 8.1 在线位置

放在 `GFI` 后、`Progressive Gate` 前。

### 8.2 原因

#### 放在 GFI 后

- 疲劳态不应继续执行复杂实现
- 降低低质量状态下的判断噪声

#### 放在 Progressive Gate 前

- 让 code implementation 先表达原则约束
- `Progressive Gate` 继续做能力边界保险

#### 保留 Progressive Gate

当前阶段必须保留，因为：

- 新 code implementation 支线尚未成熟
- 还不能承担全部能力边界
- 直接删除会造成权限真空

### 8.3 在线宿主职责

Rule Host 负责：

- 加载 active code implementations
- 构造受限输入
- 提供 helper 白名单
- 合并多个实现的决策
- 输出 `allow / block / requireApproval`
- 返回结构化诊断信息

---

## 9. 候选代码实现的安全原则

DHSE 的本质不是“自由代码搜索”，而是“受限能力的代码实现演化”。

### 9.1 允许的能力

第一版仅允许通过宿主 helper 获取：

- tool 判断
- path matching
- risk path 判断
- plan 状态
- file exists
- estimated line changes
- current GFI
- current EP tier
- bash risk

### 9.2 明确禁止

候选代码不得：

- 直接文件 IO
- 遍历工作区
- 执行命令
- 使用网络
- 动态 import
- 修改宿主配置
- 修改 principle tree 主账本

### 9.3 设计原则

代码实现的目标是表达复杂约束，而不是获取控制权。

---

## 10. RuleImplementationArtifact

这是 DHSE 的核心候选工件。

### 10.1 定义

`RuleImplementationArtifact` 表示：

> 基于 principle / rule / snapshot / pain 等上下文生成的待评估代码实现候选。

### 10.2 建议字段

- `artifactId`
- `principleId`
- `ruleId`
- `sourceSnapshotRef`
- `sourcePainIds`
- `sourceGateBlockIds`
- `sourceTrajectoryIds`
- `candidateCode`
- `helperUsage`
- `expectedDecision`
- `rationale`
- `evaluationReport`
- `createdAt`

### 10.3 为什么必须显式绑定 Principle 和 Rule

因为否则系统无法回答：

- 这段代码在服务哪个原则？
- 它在实现哪个 Rule？
- 它为什么存在？
- 它是否真的提升了 Principle 的 adherence？

DHSE 不能产出“孤立脚本”，只能产出 principle-tree 中的合法树叶。

---

## 11. 样本体系

DHSE 的评估必须使用三类样本。

### 11.1 pain-negative

表示：

- 历史上真正造成 pain 或应被阻断的行为

作用：

- 确保 DHSE 至少能吸收已知教训

### 11.2 success-positive

表示：

- 历史上成功且不应被误杀的行为

作用：

- 防止 DHSE 以“更保守”为借口无限制扩大拦截面

### 11.3 principle-anchor

表示：

- 由 Principle / Rule 前向推导出来的锚样本

作用：

- 防止 DHSE 只做 pain 记忆系统
- 让原则具有前向约束能力

---

## 12. 离线回放与 promotion

### 12.1 必须先离线评估，再进入在线态

这是用户明确要求的设计约束。

### 12.2 最低门槛

promotion 至少满足：

1. 相关 `pain-negative` 命中
2. 不得新增 `success-positive` 误杀
3. `principle-anchor` 通过率达到阈值
4. 执行耗时低于阈值
5. 结果可复现

### 12.3 状态流转

推荐：

- `candidate`
- `active`
- `disabled`
- `archived`

### 12.4 第一版不做

- 自动上线
- 自动替换旧实现
- 无人工观察窗口的自推进部署

---

## 13. DHSE 与 nocturnal 的关系

DHSE 不应重造后台管线，而应扩展 nocturnal 的能力边界。

### 13.1 可复用 nocturnal 的部分

- target selection
- structured snapshot extraction
- principle-aware上下文
- 验证骨架
- persistence 骨架

### 13.2 不直接复用的部分

- 当前 `NocturnalArtifact` 语义
- ORPO 训练样本格式

原因：

- `behavioral-sample artifact` 和 `rule-implementation artifact` 是不同工件

### 13.3 正确关系

nocturnal 是候选研究工厂，DHSE 是其中 code implementation 分支的产物消费方。

---

## 14. DHSE 与 Principle Tree 的关系

DHSE 必须服从 Principle Tree，而不是另建一套平行结构。

### 14.1 正确映射

- Principle：根
- Rule：树干
- Code Implementation：树叶

### 14.2 不允许的错误设计

#### 错误 1：把规则代码当 Rule 本身

后果：

- Rule 层语义消失
- Principle / Rule / Implementation 三层塌缩

#### 错误 2：把 DHSE 产物做成孤立文件夹，不回写原则树

后果：

- 无法计算覆盖率
- 无法解释这段代码为何存在
- 无法支撑 deprecated 生命周期

### 14.3 覆盖率回写

DHSE promotion 后，必须回写：

- `Rule.coverageRate`
- `Rule.falsePositiveRate`
- `Implementation.coveragePercentage`
- `Principle.adherenceRate`

---

## 15. coverage 在 DHSE 中的含义

DHSE 的 coverage 不是“有代码就算覆盖”。

### 15.1 Rule coverage

应综合：

- 相关 negative 命中率
- principle-anchor 通过率
- implementation 稳定性

### 15.2 false positive

基于 success-positive 统计。

### 15.3 Principle adherence

基于：

- Rule coverage
- repeated error 下降情况
- 线上实际遵守率

### 15.4 deprecated 候选

某 Principle 不应仅因“有 code implementation”就 deprecated。  
而应在：

- 覆盖率稳定
- adherence 稳定
- prompt 依赖下降
- 重复痛苦下降

后才进入 deprecated 候选。

---

## 16. Progressive Gate 的位置与长期演化

DHSE 的出现不意味着 `Progressive Gate` 立刻无用。

### 16.1 当前阶段

必须保留 `Progressive Gate` 作为：

- 宿主级能力边界
- 风险路径保险
- 在 DHSE 成熟前的权限收口层

### 16.2 长期阶段

可逐步迁移部分逻辑到：

- Principle Internalization Strategy
- Rule Host code implementations

但仍建议保留少量不可演化宿主硬边界。

### 16.3 结论

DHSE 的目标不是删除所有旧 gate，而是逐步接管“原则适合 code implementation 的那部分边界”。

---

## 17. 实施顺序

### Phase 1: 概念重构

- 将 DHSE 明确重定位为 code implementation 支线
- 以 Principle Internalization System 作为总框架

### Phase 2: Principle Tree 落地

- Rule / Implementation 关系进入真实 store

### Phase 3: 宿主收口

- 删除 `message-sanitize.ts`
- 保留 `Thinking / GFI / Progressive / Edit Verification`

### Phase 4: Rule Host MVP

- 固定接口
- helper 白名单
- 在线执行

### Phase 5: RuleImplementationArtifact 管线

- nocturnal 新工件
- 样本回放
- promotion 报告

### Phase 6: coverage / lifecycle 闭环

- coverageRate
- falsePositiveRate
- adherenceRate
- deprecated eligibility

---

## 18. 最终结论

DHSE 的正确理解不是：

> “让 LLM 自动生成越来越多的规则脚本”

而是：

> “在 Principle Internalization Strategy 判定代码是合适载体时，为系统提供一条受限、可验证、可回滚的 code implementation 内化路径。”

因此，DHSE 的价值不在脚本数量，而在于它是否真正实现了：

- 从 Principle 到 Rule 的语义对齐
- 从 Rule 到 code implementation 的可控落地
- 从 pain 到 coverage 的闭环提升
- 从在线止血到休眠态纠偏的稳定协作
