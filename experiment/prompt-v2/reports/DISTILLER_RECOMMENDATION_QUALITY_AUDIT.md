# DISTILLER_RECOMMENDATION_QUALITY_AUDIT.md — Phase 3 Distiller 上游推荐质量审计（2026-11-15）

约束遵守：未修改任何提示词/Schema/Runner/Validator；未调用模型 API；全部结论基于源码 `161763546` 与冻结实验真实产物。

## 一、Distiller 完整生产提示词（提取与指纹）

- `​.tmp/prompt-v2-ab/next-task/upstream-prompts/distiller.base.txt` — 4,679 字符，SHA `058c14042de68d25…`（== round-1 冻结 V2 清单，逐字节）
- `​.tmp/prompt-v2-ab/next-task/upstream-prompts/distiller.prod-core-grounding.txt` — 6,009 字符，SHA `ce1b3e825d565265…`（== 冻结清单 `distiller/core-grounding`；生产/实验 flag `diagnostician_core_grounding=true`）
- `​.tmp/prompt-v2-ab/next-task/upstream-prompts/distiller.prod-core-grounding-zh-CN.txt` — 6,091 字符，SHA `9bd97006643b2e19…`（运行时实际形态=core+zh-CN 语言指令；语言默认 zh-CN 同 Router，profile 无附加层）
- 源文件：`packages/principles-core/src/runtime/diagnostician/distiller-prompt-builder.ts`
- 输出契约：`DiagDistillerOutputV1Schema`（单 abstractedPrinciple 字段 ≤200 字符、groundedOnCorePrincipleIds⊆T-01..T-10、scope、rationale、confidence、ambiguityNotes）
- Feature Flag：仅 `diagnostician_core_grounding`（生产/实验均 true → 含 CORE AXIOMS 段）

### 提示词关键约束（原文引用）

| 段落 | 行为 |
|---|---|
| 角色边界 | `You are NOT a second root-cause analyst… do not invent a different root cause… do not broaden the Owner's correction beyond its evidence.` |
| 单原则 | 输出 schema 只有**一个** abstractedPrinciple 字段——结构上不可能输出多条抽象原则 |
| SCOPE CALIBRATION | general 仅当跨域证据支持；`Do NOT broaden the scope merely to make the principle appear more valuable` |
| TWO-DIRECTION VALIDATION | UPWARD（可泛化）+DOWNWARD（遵循它确实能避免原失败）双检验 |
| QUALITY GUARD | 抽象而非规则式；拒绝"always be careful"类空话；禁止无证据的绝对限制 |

**结构事实：Distiller 的输出形状（单原则、≤200 字符）使"Distiller 拆分/复制 recommendations"在契约层面不可能**——多路条目全部由 Router 生成。

## 二、真实输出审计（14 Pain 全量）

数据：`upstream-diagnosis-dump.json`（diag_distiller 工件）+ `distiller-cross-pain-matrix.json`（生产评分器，14×14）。

### 六项评价

**1. Semantic Distinctness（语义独立性）**
- Pain 内：每 Pain 恰 1 条抽象原则——**链内零重复的结构保证**。
- Pain 间：**存在语义家族重叠**（不同 Pain 蒸馏出同族原则）：
  - 调查先行族：S02"先穷尽官方能力调查+失败重估" ↔ S08"先调查既有同类实现再动手"（词法 0 分——**语义同族但措辞无关**）；
  - 状态核实族：S03"等待前核查实际状态" ↔ S12"恢复前核实实际结果"（词法 0 分）；
  - 意图对齐族：S04"以 Owner 意图为边界" ↔ S06"关键偏好先确认"（词法 0 分）；
  - 唯一词法可见对：S08 ↔ S14 @ **0.213**（"先查既有"家族）。
- 91 对中仅 1 对过词法阈值（0.15）——**跨 Pain 近义在 Distiller 层已发生，但现有词法检测（Ledger 复用门的检索半场）对其几乎全盲**。这是生产 Ledger 重复家族（LEDGER 报告 §3.2）的直接上游来源。

**2. Abstraction Fidelity（抽象保真）**
- 14/14 Pain 的原则可直接追溯至根因的决策点（rationale 均引用根因；13 个 principle 条目中 9 条与蒸馏原则逐字同文、4 条微改写，0 条语义漂移）。
- 复合压缩：S02 将"调查先行"+"失败阈值重估"两机制压成一句 ≤200 字符原则；S13 将"先归因再升级"+"废弃过期状态"两行为压成一句——**机制粒度在抽象时被合并**（读起来仍是一个复合原则，不是两条）。
- scope 诚实度：S01=scenario/0.35、S11=scenario/0.2、S08=general/**0.3**。S08 的证据仅 Owner 单方陈述（根因自注"无独立trace佐证"）却给了 scope=general——**疑似 scope 放大**（违反自家 SCOPE CALIBRATION 精神），但 confidence 如实偏低、TWO-DIRECTION VALIDATION 未被违反，属 P3 级观察。

**3. Mechanism Preservation（机制保留）**
- 根因的**主决策点** 14/14 保留（抽象原则均给出可执行的行为不变式）。
- 根因中的**次要因素**处理不一：S12 根因含"关键中间状态未持久化"（Design 次要因素）——原则只保留"先核实再行动"，持久化机制被挤出原则文本（但保留在根因字段里，Dreamer 经 predecessorOutput 仍可见，S12 实验链确实探索了持久化候选）；S14 根因的"持久化约定缺乏自动召回机制的设计缺口"同样未进原则。
- 结论：**次要机制从"原则"降级为"根因注记"——未丢失，但不再被 Router 路由**（Router 只路由蒸馏原则）。

**4. Redundancy Introduction（冗余引入）**
- Pain 内：**0**（单原则契约）。
- Pain 间：如上——语义家族重叠是 Distiller 层的真实冗余形态（不同 Pain 独立产出同族原则）。按上轮六类判据，这些是 Near Duplicate/Duplicate 级的跨任务重复，**责任不在单个 Distiller 的"行为"，而在"每个 Pain 独立蒸馏、无跨 Pain 视野"的设计**——提示词从未要求 Distiller 对照既有原则库（其输入只有 Stage A 工件；Ledger 白名单只注入 Router，见 Router trustedContext）。

**5. Useful Mechanism Loss（有用机制损失）**
- 结构性上限：≤200 字符单原则 = 每 Pain 1-2 个机制的表达预算（S02/S13 各压缩 2 机制；其余 12 Pain 每 Pain 1 机制）。
- 证据中的纠正机会若超出根因主决策点，依赖 Dreamer 自行扩展（Dreamer 的 evidence 基线=Router 诊断工件，含根因+证据，可部分恢复，见 S12 持久化候选实例）。
- 本轮无定量"损失清单"——标注 **BLOCKED-数据不足**：逐机制"证据可见但未被任何层保留"的判定需要逐证据人工对照（上轮 DOWNSTREAM 审计已声明逐候选淘汰账本不存在，同类限制在此适用）。

**6. Evidence Support（证据支持）**
- 14/14 原则的 rationale 均绑定根因/证据；confidence 校准诚实（0.2-0.8 全谱；低置信均配低 scope）。
- 无"凭空前提"实例（对比上轮 Dreamer 层 2/73）——**Distiller 层证据纪律好于 Dreamer 层**。

### 七问逐答

1. 是否将一个纠正机制拆成多个抽象表达？**否**（单原则契约，结构上不可能）。
2. 是否存在不同粒度的重复原则？Pain 内**否**；Pain 间**是**（语义家族，词法不可见）。
3. 是否保留原始诊断的独立决策机会？主决策点保留；次要机制保留在根因字段但不再被路由（半保留）。
4. 是否把互补机制压缩成一个泛化 recommendation？**是**（S02/S13 两例复合压缩）——这是 ≤200 字符预算下的设计行为。
5. 是否因过度抽象损失具体纠正行为？抽象原则本身不含触发细节——**该损失由 Router 的 rule 载体在系统层补偿**（trigger/action 重新具体化同一决策点）；真正的损失点是"证据里的次要机制不被路由"（见 3/5）。
6. 是否存在无依据的抽象？**未发现凭空抽象**；S08 的 scope=general 属"弱证据上的放大"（P3 观察，confidence 诚实）。
7. Distiller 输出是否直接影响 Router 的 recommendation 数量和质量？**是且决定性**——Router 只路由蒸馏原则（"Route what the distiller produced"）；rec 数量=载体决策数，rec 语义=蒸馏原则语义。Distiller 每 Pain 单原则 ⇒ Router 不可能有第二种机制可路由。

## 三、与上轮审计结论的衔接

- 上轮"跨链重复主导、链内零重复"在 upstream 得到根因解释：**链内多样性（Dreamer V2.1 规则）与跨链重复（每候选一链 × Router 多载体）是两层独立机制**；Distiller 单原则是"链内零重复"的上游前提，Router 多载体×桥接是"跨链重复"的算术来源。
- 上轮机制空间 31 vs 42（V2.1 vs V2）的损失发生在 Dreamer 层（链内候选数收紧），**不是** Distiller 层变化（两臂 Distiller 提示词相同、输出同为单原则）。

（四、结论与建议见 UPSTREAM_NEXT_STEP_OWNER_REVIEW_CARD §C——本报告不改提示词。）
