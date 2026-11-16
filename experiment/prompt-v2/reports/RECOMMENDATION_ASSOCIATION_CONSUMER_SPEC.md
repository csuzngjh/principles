# RECOMMENDATION_ASSOCIATION_CONSUMER_SPEC.md — Phase 7 P1：Recommendation 关联消费整改 SPEC（2026-11-15）

状态：**设计稿，未实施**。基线源码 `161763546`。目标：让 Router 已产出的载体关联数据真正被消费，使**一个独立纠正机制 = 一个学习对象**，而不是每条 recommendation 各自成链。

## 一、Router → Dreamer 真实调用链（逐环节源码定位）

```
Router（Stage C）产出 DiagnosticianOutputV2.recommendations[]
  └ 每条 rec：kind + description + recommendationRef（artifact 内唯一）
     └ 仅 kind=rule 额外携带 principleAssociation（implements→同输出的 principle 条目）
1. association 结构校验（诊断时）
   diagnostician-association-validation.ts:39-74
   —— 只验结构：ref 唯一性、evidenceRefs 存在性、target 指向同输出 principle 条目或
      trustedContext 白名单 ID；返回值显式声明 semanticCorrectness: 'not_evaluated'（:74）
   结果写入 artifact 信封 associationValidation 键（诊断运行时附加）
2. committer：每条 rec → 1 行 principle_candidates
   store/commit/diagnostician-committer.ts:211-214（"Extract and insert all recommendations
   (principle + rule + implementation + prompt + defer)"）
   —— sourceRecommendationJson 原样保留 recommendationRef + principleAssociation
      （committer 头注释 :11-12 自证"recommendationRef → candidateId mapping is deterministically recoverable"）
   —— 关联数据由此进入候选行，随后**无人读取**
3. intake：每 principle-kind 候选 → 1 Ledger 条目（kind 门拒 rule/prompt/implementation/defer）
   candidate-intake-service.ts:538-551（3b fail-closed）
4. bridge 种子：每候选 → 恰 1 条 Dreamer 任务
   intake-to-internalization-bridge.ts:129-188（PRI-720 C6 候选级防双种）
   —— buildDreamerTaskSeed 只读 kind/channel/lineage；**不读 sourceRecommendationJson 内的关联**
   —— 生产实证：dreamer-2fd0e91b-prompt 的 dependencyTaskIds=[diag_router-…]（只依赖诊断任务，
      与兄弟链互不可见）
5. Dreamer 输入 = predecessorOutput（Router 诊断工件全文）
   dreamer-runner.ts:138-200 —— 兄弟载体链看到完全相同的输入
6. Philosopher 只读本链 Dreamer 工件
   philosopher-runner.ts:141-196 —— 链间结构性不可见
```

## 二、association 消费现状（§4 问答）

**Q1 为什么每条 recommendation 都可能独立产生 Candidate？**
committer 按"每 rec 一候选"设计（diagnostician-committer.ts:211-214）——这是 PRI-1146 V2 契约的刻意选择（每条 rec 都是 Owner 可评审的独立提案对象）。候选本身不是缺陷；缺陷是桥接把"每候选"直接升级为"每学习链"。

**Q2 `principleAssociation` 当前在哪些代码中被读取？**
仅两处：(a) 诊断时的结构校验（`diagnostician-association-validation.ts`，结果进信封）；(b) **阴影模块** `diagnostician-association-shadow.ts`（`proposeShadowAssociations`/`resolveSourceDeclaredRelations`）——它能把 rule 的声明关系解析到 canonical principleId，但：`mode:'shadow'`、`authorizesGeneration:false`（治理边界 OD-01/02/03 未决，头注释 :16-22），且 **barrel 未导出、零生产调用方**（本轮 rg 全库核实）。

**Q3 是否存在完全没有消费者的字段？**
是。对"链协调"而言：`recommendationRef` 与 `principleAssociation` 在 committer 之后**零消费**（仅 Console UI 的 agent-metadata.ts:150 文案提及字段名）。桥接、intake、orchestrator、Dreamer/Philosopher/Scribe 全部不读。

**Q4 为什么 12/12 的 rule implements 关联没有阻止重复候选链？**
因为没有任何下游代码读它。关联数据在产物层完整存在（Phase 5/6 实测 12/12 linked），但桥接种子决策的唯一输入是 `recommendation_kind`——关联字段对它是透明的。

**Q5 principle/rule/prompt/implementation 是否具有统一的载体关联模型？**
**没有**。Schema 现状（`diagnostician-output.ts:122-159` + 快照）：只有 kind=**rule** 必填 `principleAssociation`；principle/prompt/implementation/defer 仅有 `recommendationRef`。即"rule 实现 principle"是唯一被建模的载体关系；prompt/implementation 与 principle 的关系**无结构化表达**（Router 也未被要求声明）。统一化需要 Schema 扩展（见 §四.5），且不能假设 prompt/implementation 已有同等关联能力（指令特别提示，已核实属实）。

**Q6 当前关联校验是否只验证结构而不验证语义？**
是，且代码自证：`validateDiagnosticianAssociations` 返回 `semanticCorrectness: 'not_evaluated'`（:74）。模型可以声明一个结构合法但语义错误的 implements——阴影模块也只是解析声明关系（"source_declared_relation"，非 Owner Identity Receipt），不做语义核实。

## 三、Candidate 膨胀根因（链路算术）

```
1 个机制（Distiller 单原则）
→ Router 多载体拆分：1×principle + 1×rule [+ 1×prompt]（12/14 Pain 双载体；S02 三载体）
→ committer：每 rec 1 候选（2-3 条/Pain）
→ bridge：每候选 1 链（2-3 条链/Pain，互不可见）
→ Dreamer：每链 2-4 候选（V2.1 链内规则）
→ 每 Pain 4-8 个候选、2-3 份近义原则稿（上轮实测跨链 Duplicate 率 42.5%-50%）
```

生产 11-11 事件族的实证：4 次上报 × 每次诊断产出 principle+rule+implementation(+prompt) 候选（见 LEDGER_SPEC §一表格与候选清单）——载体拆分在重复上报场景下进一步放大。

## 四、多载体关联设计（最小改造）

### 4.1 目标模型

**一个独立纠正机制 = 一个学习对象（一条 Dreamer 探索链）**；同一机制的多个执行载体是该学习对象的**通道产物**，不是独立学习任务。

### 4.2 可直接复用的现有机制（逐项核实）

| 问题 | 答案 |
|---|---|
| 能否直接消费已有 recommendationRef/principleAssociation？ | **能**——数据已随 `sourceRecommendationJson` 持久化在候选行内（committer :11-12 保证映射可恢复）；读取点在桥接种子前解析候选行的 sourceRecommendationJson 即可，零 Schema 变更 |
| 能否复用现有 CandidateIntakeService？ | **能，且必须**——分组发生在 intake 之后的种子阶段，intake 的幂等/kind 门/复用门全部不动 |
| 是否需要修改 Recommendation Schema？ | **最小方案不需要**（rule 的 association 已够分组用；prompt/implementation 无关联时默认独立成组——保守降级）。统一载体关联模型（所有 kind 可声明 implements/relates-to）列为可选 Phase 2 Schema 扩展 |
| 是否需要增加关联的语义验证？ | **分组动作本身低风险，不强制前置语义验证**——分组只决定"哪些载体共享一次探索"，不产生任何授权/注册效应（区别于 ruleCandidateBinding 的 Owner 绑定门）。但必须在组元数据中保留 `associationBasis: 'source_declared'` 与校验状态（linked/unresolved），**未确认状态不得自动升级为任何合并/绑定**（见 4.5） |
| 是否需要修改 Candidate 创建策略？ | **不修改**——候选仍每 rec 一个（Owner 评审面不变）；变的是种子拓扑 |
| 是否影响 Dreamer/Philosopher/Scribe 数据链路？ | 锚链（principle 候选）链路不变；非锚载体**不再各自种 Dreamer**，其通道下游改从锚链派生（见 4.3——这是本 SPEC 唯一的结构改动面） |

### 4.3 种子分组设计（Phase A 最小实现）

1. **分组时机**：bridge 种子循环前，对同批候选（同一诊断产物的兄弟候选）解析 `sourceRecommendationJson`：
   - rule 候选且 `principleAssociation.status==='linked'` 且 target.type==='recommendation_ref' 且 ref 指向同批 principle 候选 → 归入该 principle 候选的组；
   - 其余（无关联/unresolved/prompt/implementation/defer）→ 各自独立组（现状行为，保守降级）。
2. **锚链种子**：每组只种 **1 条 Dreamer 任务**（锚 = principle 候选），PI metadata 增补组信息：`carrierCandidateIds: [<rule/prompt 候选>]`、`associationBasis: 'source_declared'`（经 `inputArtifactRefs` 已有的 `candidate://` 引用机制携带载体内容——该字段现成，dreamer-2fd0e91b 的 metadata 已示范）。
3. **载体下游（通道价值保留——不删 Rule/Prompt）**：
   - rule 载体：其 `triggerPattern/action` 原文已随候选持久化；锚链的 Scribe（code_tool_hook 通道 successor）从锚链 Philosopher 输出 + 载体候选材料生成规则稿，走**既有人审门**（40/40 needs_human_review 语义不变）。
   - prompt 载体：prompt 指令文本同样作为锚链上下文交付，产出归入原则稿的执行指引部分。
   - **结构前提（实现前必须核实）**：orchestrator 的后继提案按 `(parentTaskId, kind, channel)` 幂等（`internalization-orchestrator.ts:412-424`）——一个 Philosopher 挂双通道 Scribe（prompt + code_tool_hook）在现有幂等键下**结构上可行**，但从未在生产拓扑出现过；Phase A 实现前需补一条拓扑级验证（单链双通道 successor 的编排测试）。
4. **回退开关**：分组行为置于 feature flag（现有 feature-flag SSoT 新增 quiet flag，如 `carrier_grouping`，默认 **off**）——off 时行为与现状逐字节一致（T11 式回滚，符合 mvp-q-3）。

### 4.4 明确不做的事（指令红线）

- 不删除 Rule/Prompt 载体；不合并它们的原始内容/证据；它们的候选行、sourceRecommendationJson、审计能力全部保留。
- 不自动合并：分组 ≠ 绑定。Ledger 层的 rule→principle 绑定仍走既有 Owner 门（`mutateRuleCandidateBinding`，`principle-tree-ledger.ts:1033`，owner source 必须是 authenticated_console）；关联语义未验证前，一切产物携带未确认标记。
- 不动 Router/Distiller 提示词；不改 Recommendation Schema（Phase A）。

### 4.5 对现有数据的兼容策略

- 存量候选（已消费/已种子）不回溯重组——分组只对新诊断生效。
- 关联缺失/unresolved 的存量形态（defer、无 rule 的 Pain）天然落入独立组 = 现状。
- `authorizesGeneration:false` 的阴影解析器（`diagnostician-association-shadow.ts`）与 Phase A 的分组读取互补：阴影解析是"声明关系→canonical id"的只读解析器，Phase A 只需其"同批 recommendation_ref → 候选映射"这一半，不需要 ledger 端解析；barrel 导出与否随实现决定。

## 五、语义验证要求（分组之上、绑定之下）

分层职责（从弱到强）：

1. **结构验证**（已有）：association-validation，`semanticCorrectness:'not_evaluated'`。
2. **分组采用**（本 SPEC Phase A）：仅采用 `linked` 的声明关系用于探索分组；组元数据携带 basis 与未确认标记； Owner 面可见。
3. **语义核验**（Phase 2 可选）：锚链 Philosopher 在合成时显式判定"载体与原则是否同一机制"（其输出已有 Complementary/Duplicate 判定先例），判定结果写入组元数据——仍不产生授权效应。
4. **授权绑定**（既有）：rule→principle 的 Ledger 绑定/激活走 Owner 门，语义要求在既有 SPEC-PD-RULE-ASSOCIATION-005 治理下（OD-01/02/03 未决项与阴影解析器对接，不在本 SPEC 范围）。

## 六、回归测试方案

1. **分组纯函数**：候选行 → 组映射的枚举（linked/unresolved/缺关联/跨批 ref 幻觉 ID/多 principle 候选同 ref 冲突→各独立组）。
2. **种子拓扑**：单组双通道 successor 编排验证（flag on）；flag off 逐字节现状对照。
3. **幂等**：PRI-720 C6 防双种在分组模式下仍成立（组内重扫不多种）；`successor_exists` 语义不变。
4. **链路完整性**：锚链 Dreamer/Philosopher/Scribe 血缘（ERR-004 校验）+ rule 载体的人审门 40/40 语义不回退。
5. **治理红线**：分组零授权效应（无 ledger 写、无 binding 写、无 status 变迁）的负断言。
6. **生产重放**：11-11 事件族的 5 候选材料在隔离副本重放——期望：2 组（或 1 组+1 独立），2 条 Dreamer 链而非 5 条，rule 载体材料完整保留在锚链上下文。

## 七、风险与回滚

- 风险 1：双通道 successor 是从未走过的生产拓扑——以 §六.2 拓扑验证为 Phase A 前置门，未验证不发布。
- 风险 2：声明关联语义错误导致错误分组（把独立机制捆进一次探索）——分组只影响探索效率不影响正确性（Dreamer 仍可产出多机制候选），且 flag off 即回现状。
- 风险 3：载体信息丢失——组元数据携带完整候选引用，任何载体材料可独立追溯（候选行不删不改）。
- 回滚：flag off（默认 off 发布）；分组逻辑独立 commit，revert 不触碰存量数据。
