# VERIFICATION-B — 管道审计报告 §3（诊断三阶段）+ §4（dreamer/philosopher）独立核实

> 核实对象：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`（2268 行，提交 3e5722b4）
> 管辖范围：§3 诊断代理三阶段（REPORT.md:483-1035）+ §4 dreamer 与 philosopher（REPORT.md:1036-1352）
> 核实员：PD Developer（CNB Issue #29）｜核实日期：2026-09-15｜只读核实，未修改任何已存在文件

---

## 0. 核实方法与基线

### 0.1 基线锚定

报告声明行号锚定 `main @ 70d824c4`。核实采用任务书指定的 `git show` 方式，**未 checkout 切换**：

```bash
git archive 70d824c4 packages/principles-core/src/runtime-v2 | tar -x -C /tmp/base
```

**关键前提（本次核实的最强简化条件）**：逐文件 md5 比对证明，管辖范围内全部 10 个源文件在 `70d824c4` 与当前检出 HEAD 之间**字节完全相同**：

| 文件 | 70d824c4 vs HEAD |
|---|---|
| `diagnostician/rootcause-prompt-builder.ts` | SAME |
| `diagnostician/distiller-prompt-builder.ts` | SAME |
| `diagnostician/router-prompt-builder.ts` | SAME |
| `internalization/dreamer-prompt-builder.ts` | SAME |
| `internalization/philosopher-prompt-builder.ts` | SAME |
| `diagnostician/diag-rootcause-output.ts` | SAME |
| `diagnostician/diag-distiller-output.ts` | SAME |
| `diagnostician-output.ts` | SAME |
| `internalization/dreamer-output.ts` | SAME |
| `internalization/philosopher-output.ts` | SAME |

`git diff --stat 70d824c4 HEAD -- <管辖文件>` 仅命中 `adapter/artificer-l2-*`（§5 范围，不在管辖内）。因此**本次核实不存在基线漂移噪声**：裁决行号即当前检出可复现行号。

### 0.2 逐字比对方法

1. 用脚本从源文件抽取模板字符串**原文**（保留 `${...}` 插值表达式；反引号转义按运行时语义还原）。
2. 从 REPORT.md 抽取对应代码块（去 ``` 围栏）。
3. 归一化：把源侧 `${ident}` 与报告侧 `⟨注入: ident⟩` / `⟨内联条件: …⟩` 统一替换为同一占位符，使「动态拼接点标注」与「模板插值」可机器对齐。
4. `difflib` 逐行 diff；判定标准 = 归一化后逐行完全一致。

### 0.3 行为级验证（超出静态阅读）

为核实 A4/B2/C1 三处「示例静态重建【推断】」，核实员**实际运行了生产代码**：在临时目录安装 `@sinclair/typebox@0.34.48`（与 `packages/principles-core/package.json:62` 声明一致）后用 `tsx` 加载工作区真实的 `DefaultSchemaPromptAdapter` 与三个真实 schema，打印 `generateExample` / `generateConstraints` 实际输出。这是把报告的【推断】升级为**实证**的关键一步。

---

## 1. 摘要统计

### 1.1 判定计数

| 判定 | 计数 | 说明 |
|---|---|---|
| CONFIRMED | 60 | 代码事实与报告一致（含行为级实证） |
| REFUTED | 0 | 未发现实质错误 |
| DRIFT | 3 | 结论成立但行号/文件指向不符（详见 §4） |
| UNVERIFIABLE | 0 | 环境完整，无需降级 |
| NEW（漏记） | 6 | 详见 §5 |

**总评**：报告在本次管辖范围内的**事实准确度极高**。5 段提示词全文与 5 张 Schema 表**全部 CONFIRMED**（含逐字符级）。未发现任何 REFUTED。3 处 DRIFT 均为「行号指向父文件而非真正定义处」的指向偏差，不影响任何结论成立。（另有 1 处原拟记为 DRIFT 的条目经复核**撤销**——见 §4.2，报告的行号引用实际正确，问题只在机制表述，已并入 NEW-6。）

### 1.2 最重要的 REFUTED — 无

**本次核实未产生任何 REFUTED。** 报告在本管辖范围内未出现事实错误陈述。

「原文→建议文」模式在本次不触发；§6「建议修正清单」因此仅包含 DRIFT 与表述精度改进，不含事实纠正。

### 1.3 最重要的 NEW（漏记）前 5 条

| # | NEW 项 | 严重度建议 | 一句话 |
|---|---|---|---|
| NEW-1 | `violatedPrinciples[].principleId` 无注册表校验（T-01..T-10 可伪造） | P3 | Stage B 用 `isCorePrincipleId` 硬拒伪造 ID（diag-distiller-output.ts:159-165），但 Stage C 的 `principleId`（prompt 明示「e.g. T-01 through T-10」）**无任何注册表校验**，且经 artifact-summary 流入 `diagnosis.summary.affectedComponents` 供 dreamer manifest 消费 |
| NEW-2 | Stage A/B/C 的 languageDirective subject 全为缺省 `'principle'`，字段清单与实际 schema 系统性错配 | P3 | 三阶段调用 `buildLanguageDirective(outputLanguage)` 未传 subject → 缺省 `'principle'`，指令列出的可翻译字段 `(title, statement, rationale, applicability, antiPatterns, description)` 中除 `rationale` 外**全部不存在于任何诊断 schema**；而实际需要翻译的 `summary`/`rootCause`（Stage A/C）、`abstractedPrinciple`（Stage B）**未被列出**。附带风险：`rootCause` 的英文类目前缀由 validator 硬校验，而 languageDirective 未把它列为不可翻译标识 |
| NEW-3 | philosopher 用户负载 `JSON.parse` 失败时回退**字符串**，仍作 JSON 值嵌入 → 双重编码 | P3 | `philosopher-runner.ts:205-210` parse 失败保留原始字符串；`philosopher-prompt-builder.ts:142` 裸 `JSON.stringify` 会把该字符串再包一层引号 |
| NEW-4 | Stage B prompt 的 INPUT 清单漏列 Stage A 实际会携带的 `intentTension` / `ambiguityNotes` | P3 | distiller 负载是 Stage A **全量输出**（`rootCauseOutput`），当 `intent_engineering` 开启时含 `intentTension`；INPUT 清单未提，LLM 对未声明字段缺乏使用指引 |
| NEW-5 | OCRA（openclaw-cli）路径**不做** `stripLineageFields`，与 pi-ai 路径保护姿态不一致 | P3 | 报告 §3.0 仅描述 pi-ai 的剥离（pi-ai-runtime-adapter.ts:878-882）。`openclaw-cli-runtime-adapter.ts` 全文无 `stripLineageFields` 调用（grep 零命中），故 LLM 提供的 lineage 字段在该路径不被剥离，仅靠 `injectRunnerLineageIfAbsent`（absent 才注入）兜底 |

（NEW-6 见 §5.6：对报告定级的**下行修正建议**。）

### 1.4 对报告定级的修正建议（有降有升）

| 报告条目 | 报告定级 | 核实员建议 | 依据 |
|---|---|---|---|
| §3 rootcause 卡 1（示例 `rootCause` 无前缀 vs validator 硬校验） | P2（“会稳定触发 output_invalid 重试”） | 建议**精确化机制**，定级 P2/P3 均可 | 实证：`generateExample` 末尾 `Value.Check ? example : Value.Cast(...)`（schema-prompt-adapter.ts:185）会对示例做 Cast，**但 Cast 只救回 literal union 字段**（`rootCauseCategory`→`'People'`）。`rootCause:"example"` 是普通 string（无 const），Cast 不回填前缀，故确实原样出货。报告的实质结论成立，但归因应为「示例语义违反 prompt 规则」而非「示例不合法」 |
| §3 distiller 卡 1 同上 | P2 | 同上 | `groundedOnCorePrincipleIds:["example"]` 是 array of plain string，Cast 不回填，示例确实带伪造 ID |
| §3 横切 1 | 「示例违反自身规则」 | 建议区分**技术层**（`Value.Cast` 兜底 → 示例永远通过 `Value.Check`）与**语义层**（LLM 模仿后被 validator 拒） | 当前措辞易让读者以为示例未通过自身 schema |

---

## 2. 提示词逐字比对结论表（B-1）

**结论：5 段提示词全文 + 6 个附属块，共 11 个代码块，全部逐字符一致（CONFIRMED）。**

### 2.1 五段主提示词

| # | 段落 | 报告位置 | 源位置 | 归一化后 diff | 判定 |
|---|---|---|---|---|---|
| 1 | §3 Stage A `buildRootCauseProtocolInstruction` | REPORT.md:546-592 | rootcause-prompt-builder.ts:213-257 | 仅 3 处占位符标注（`evidenceFirstBlock/phase35Block/phase36Block`、`example`、`constraints/languageDirective`）——已逐一对齐，文本零差异 | **CONFIRMED** |
| 2 | §3 Stage B `buildDistillerProtocolInstruction` | REPORT.md:767-810 | distiller-prompt-builder.ts:135-176 | 占位符对齐后 42 行完全一致（含 `coreGrounding ? ' above' : ''` ↔ `⟨内联条件: coreGrounding 为真时输出 " above"，否则空串⟩`） | **CONFIRMED** |
| 3 | §3 Stage C `buildRouterInstruction` | REPORT.md:897-947 | router-prompt-builder.ts:149-197 | 占位符对齐后 49 行完全一致 | **CONFIRMED** |
| 4 | §4 dreamer `buildDreamerProtocolInstruction` | REPORT.md:1089-1118 | dreamer-prompt-builder.ts:80-107 | 28 行完全一致；含源码转义反引号在报告中正确呈现为运行时语义 | **CONFIRMED** |
| 5 | §4 philosopher `buildPhilosopherProtocolInstruction` | REPORT.md:1238-1274 | philosopher-prompt-builder.ts:80-114 | 35 行完全一致 | **CONFIRMED** |

### 2.2 附属块与动态注入点

| # | 块 | 报告位置 | 源位置 | 判定 |
|---|---|---|---|---|
| A1 | Evidence First Attribution 块全文 | :596-609 | rootcause-prompt-builder.ts:111-123 | **CONFIRMED**（12 行） |
| A2 | PHASE 3.5 Core Axiom 块（含 T-01..T-10 全清单） | :613-632 | core-axiom-block.ts:125-154 + core-principle-registry.ts:64-145 | **CONFIRMED**（17 行）；10 条 axiom statement 逐字符等于注册表 `statement` 字段 |
| A3 | PHASE 3.6 Intent Tension 块全文 | :636-661 | rootcause-prompt-builder.ts:67-91 | **CONFIRMED**（24 行） |
| A4 | Stage A 示例重建 | :665-677 | 行为级实测 | **CONFIRMED**（值等价 + 键序一致） |
| A5 | LANGUAGE DIRECTIVE 全文 | :681-690 | language-directive.ts:184-193 | **CONFIRMED**（8 行；subject 缺省 `'principle'` 陈述正确） |
| B1 | CORE AXIOMS 默认指令 | :814-818 | core-axiom-block.ts:99-102 | **CONFIRMED**（3 行逐字符） |
| B2 | Stage B 示例重建 | :822-833 | 行为级实测 | **CONFIRMED**（值等价 + 键序一致） |
| C1 | Stage C 示例重建 | :951-968 | 行为级实测 | **CONFIRMED**（值等价）；键序呈现差异记为附带微差 |
| D1 | dreamer 语言指令全文 | :1125-1133 | language-directive.ts:184-193 + `dreamer` 字段清单 :148 | **CONFIRMED**（7 行） |
| E1 | dreamer 用户消息构造代码 | :1141-1150 | dreamer-prompt-builder.ts:128-135 | **CONFIRMED**（8 行逐字符） |
| E2 | philosopher 用户消息构造代码 | :1284-1293 | philosopher-prompt-builder.ts:135-142 | **CONFIRMED**（8 行逐字符） |

### 2.3 「⟨注入: 变量名⟩」标注所指动态拼接点核验

任务书要求验证每个注入标注**确有其码**。逐项结果：

| 标注 | 所指变量 | 源码存在 | 语义正确 |
|---|---|---|---|
| `⟨注入: evidenceFirstBlock⟩` | rootcause-prompt-builder.ts:204 | 是 | 是（`pain_diagnosis_persistence` flag；关闭返回 `''`，:106-109） |
| `⟨注入: phase35Block⟩` | rootcause-prompt-builder.ts:191 | 是 | 是（`diagnostician_core_grounding` flag；`fallback: '\n'`，:198） |
| `⟨注入: phase36Block⟩` | rootcause-prompt-builder.ts:211 | 是 | 是（`intent_engineering` flag；关闭返回 `''`，:55-57） |
| `⟨注入: example⟩` (Stage A) | rootcause-prompt-builder.ts:184 | 是 | 是（`adapter.generateExample(schema)`） |
| `⟨注入: constraints⟩` | rootcause-prompt-builder.ts:185 | 是 | 是（`adapter.generateConstraints(schema)`） |
| `⟨注入: languageDirective⟩` | rootcause-prompt-builder.ts:186 | 是 | 是（`buildLanguageDirective(outputLanguage)`） |
| `⟨注入: coreAxiomsBlock⟩` (Stage B) | distiller-prompt-builder.ts:130 | 是 | 是（`buildCoreAxiomBlock({coreGrounding, outputLanguage})`） |
| `⟨内联条件: coreGrounding …⟩` (Stage B) | distiller-prompt-builder.ts:174 | 是 | 是（行内三元，非独立块） |
| `⟨注入: coreAxiomsBlock⟩` (dreamer) | dreamer-prompt-builder.ts:76 | 是 | 是 |
| `⟨注入: languageDirective⟩` (dreamer) | dreamer-prompt-builder.ts:78 | 是 | 是（subject=`'dreamer'`） |
| `⟨注入: coreAxiomsBlock⟩` (philosopher) | philosopher-prompt-builder.ts:76 | 是 | 是 |
| `⟨注入: languageDirective⟩` (philosopher) | philosopher-prompt-builder.ts:78 | 是 | 是（subject=`'philosopher'`） |

**全部注入标注均有对应源码，无悬空引用、无位置错标。**

### 2.4 一处积极确认

报告 A2 声称 T-01..T-10 清单来自 `core-principle-registry.ts:64-145`，en/zh 双语按 `outputLanguage` 选择（87-93）。核实：`formatCorePrinciplesList`（core-axiom-block.ts:78-92）确按 `outputLanguage === 'zh-CN'` 选 `statementZh`，且 10 条 statement 逐字符等于注册表值（机器比对 10/10 OK）。

---

## 3. 逐项判定表（B-2 / B-3 / B-4）

### 3.1 B-1 提示词逐字对比

见 §2；**11/11 代码块 CONFIRMED**，无 REFUTED/DRIFT/UNVERIFIABLE。

### 3.2 B-2 输出 Schema 字段表

#### 3.2.1 `DiagRootCauseOutputV1Schema`（报告 :700-714）

| 报告字段行 | 声明 | 实测（diag-rootcause-output.ts） | 判定 |
|---|---|---|---|
| valid | boolean，必填，:209 | :209 `Type.Boolean()`，在 required | CONFIRMED |
| diagnosisId | string(min1)，:210 | :210 一致 | CONFIRMED |
| taskId | string(min1)，:211 | :211 一致 + description 提及 ERR-008 | CONFIRMED |
| summary | string(min1)，:212 | :212 一致 | CONFIRMED |
| causalChain | why 1..5 / statement min1 / evidenceRefs minItems1，42-46 | :42-46 逐项一致 | CONFIRMED |
| rootCause | string(min1) + description 前缀约束，214-217 | :214-217 一致 | CONFIRMED |
| rootCauseCategory | 四字面量 union，27-32 | :27-32 `Type.Union([Literal×4])` | CONFIRMED |
| evidence | {sourceRef min1, note min1}[]，54-57 | :54-57 一致 | CONFIRMED |
| confidence | number 0..1，:220 | :220 一致 | CONFIRMED |
| ambiguityNotes | string[]，可选，:221 | :221 `Type.Optional` | CONFIRMED |
| intentTension | IntentTension 可选，179-187，`additionalProperties:false` 禁 confidence | :179-187 一致；:187 `additionalProperties:false` | CONFIRMED |

**intentTension 子枚举核验**（报告称：source 四值、evidenceStrength 三值、relatedIntentFields 五值、evidence ≤3、suggestedOwnerAction 六值）：

- `IntentTensionSourceSchema` :72-76 → none/action_drift/intent_suspect/healthy_tension = **四值** ✅
- `EvidenceStrengthSchema` :88-91 → weak/moderate/strong = **三值** ✅
- `IntentRelatedFieldSchema` :104-109 → why/desired_outcome/non_negotiables/stop_escalation/current_strategic_focus = **五值** ✅
- `evidence: Type.Array(Type.String(), {maxItems:3})` :183 = **≤3** ✅
- `SuggestedOwnerActionSchema` :122-128 → confirm_drift/revise_intent/observe/dismiss/promote_to_principle/promote_to_rulehost = **六值** ✅

#### 3.2.2 `DiagDistillerOutputV1Schema`（报告 :840-852）

| 报告字段行 | 声明 | 实测（diag-distiller-output.ts） | 判定 |
|---|---|---|---|
| valid | boolean 必填 :41 | :41 | CONFIRMED |
| taskId | string(min1) :42 | :42 | CONFIRMED |
| sourceRootCauseArtifactId | string(min1) + lineage description :43-46 | :43-46 | CONFIRMED |
| abstractedPrinciple | string 1..200 :47-51 | :47-51（minLength1/maxLength200） | CONFIRMED |
| rationale | string(min1) :52-55 | :52-55 | CONFIRMED |
| groundedOnCorePrincipleIds | string[] 必须 ⊆ T-01..T-10 :56-59 | :56-59；注册表校验在 validator :159-165（TypeBox 无法表达）——报告已如此陈述 | CONFIRMED |
| scope | 三字面量 :17-21 / 字段 :60 | :17-21 | CONFIRMED |
| confidence | number 0..1 :61 | :61 | CONFIRMED |
| ambiguityNotes | string[] 可选 :62 | :62 | CONFIRMED |

校验器行为（报告 :854 段落）「对象守卫 114-116 → taskId 宽容回注（任意 `diag-` 前缀同后缀即纠正+warning，130-148）→ TypeBox 兜底 151-155 → 注册表校验 159-165，**无 `valid===true` 检查**」——逐行核对：:114-116 ✅、:130-148 ✅（`DIAG_PREFIXES` 在 :131）、:151-155 ✅、:159-165 ✅、**全文无 `record.valid !== true` 检查** ✅。**CONFIRMED**

#### 3.2.3 `DiagnosticianOutputV1Schema`（报告 :975-989）

| 报告字段行 | 声明 | 实测（diagnostician-output.ts） | 判定 |
|---|---|---|---|
| valid | boolean :52 | :52 | CONFIRMED |
| diagnosisId | string(min1) :53 | :53 | CONFIRMED |
| summary | string(min1) :54 | :54 | CONFIRMED |
| rootCause | string(min1)+description :55 | :55 | CONFIRMED |
| violatedPrinciples | {principleId?, title?, rationale(min1)}[]，:16-20 / :56 | :16-20 `principleId: Optional(String(min1))`、`title: Optional(String())`、`rationale: String(min1)` | CONFIRMED |
| evidence | {sourceRef min1, note min1}[] :57 | :24-27 + :57 | CONFIRMED |
| recommendations | ≥1，五 kind，:31-49 / :58-64 minItems1 | :31-37 五字面量；:64 `{minItems:1}` | CONFIRMED |
| confidence | number 0..1 :65 | :65 | CONFIRMED |
| ambiguityNotes | string[] 可选 :66 | :66 | CONFIRMED |
| intentTension | 可选 additive :81 | :81 | CONFIRMED |
| （taskId） | schema 无此字段；runner 回注 :448 | 全文无 taskId；`postFetchTransform` :448 注入 | CONFIRMED |

#### 3.2.4 `DreamerOutputV1Schema`（报告 :1156-1167）

| 报告字段行 | 声明 | 实测 | 判定 |
|---|---|---|---|
| valid | boolean，严格 ===true（:133-135） | dreamer-output.ts:133-135 一致 | CONFIRMED |
| taskId | 必须等于任务 taskId（:129-131）；reconcileLineageEcho 回填（runner :379-384） | 一致 | CONFIRMED |
| candidates | 1-5（:140-142）；元素逐字段（:143-157） | 一致；`VALID_RISK_LEVELS` :115 | CONFIRMED |
| sourcePrincipleId | 可选；validator 不校验；stripFabricatedCorePrincipleIds（runner :385） | 一致；`strip-fabricated-ids.ts:16-29` | CONFIRMED |
| sourcePainId | 可选字符串，无一致性校验 | 全文无 sourcePainId 校验 | CONFIRMED |
| contextRefs | 只校验 isArray（:160-162） | 不校验内容 | CONFIRMED |
| generatedAt | 非空（:164-166）；基类无条件覆盖（base-peer-runner.ts:306-311） | 一致 | CONFIRMED |
| reason | 死字段（valid 强制 true） | :86 Optional，成功路径恒不出现 | CONFIRMED |

补充：报告称「L2 工具循环用 typebox 等价重声明（dreamer-output-typebox.ts:47-56）」——核实为 `DreamerOutputV1Typebox`，:16-20 注释声明行为等价性有测试锁定。**CONFIRMED**

#### 3.2.5 `PhilosopherOutputV1Schema`（报告 :1297-1311）

| 报告字段行 | 声明 | 实测 | 判定 |
|---|---|---|---|
| taskId | :81-83 + reconcileLineageEcho（runner :388-396） | 一致 | CONFIRMED |
| sourceDreamerArtifactId | validator 非空 :85-87；succeedTask 再校验 === 权威值（runner :270-275）；echo 先被覆盖（:388-396） | 逐行一致 | CONFIRMED |
| thesis | 非空 :89-91 | 一致 | CONFIRMED |
| principleCandidate.title | 非空 :97；Schema 仅 minLength:1（:34），validator 与 TypeBox 均不查 ≤100 | :34 `Type.String({minLength:1})`，无 maxLength | CONFIRMED |
| principleCandidate.rationale | :98 | 一致 | CONFIRMED |
| principleCandidate.scope | :99 | 一致 | CONFIRMED |
| principleCandidate.confidence | :100-101 | 一致 | CONFIRMED |
| risks | string[] 元素全 string :104-108；可空 | 一致 | CONFIRMED |
| generatedAt | :110-112；基类覆盖 | 一致 | CONFIRMED |

不对称性陈述（philosopher **无** `valid`/`contextRefs`/`sourcePrincipleId`，upsert 不写 `source_principle_id`）：`PhilosopherOutputV1Schema` :40-47 确无这三字段；`philosopher-runner.ts:314-327` 的 `upsertArtifact` 确无 `sourcePrincipleId`（对比 `dreamer-runner.ts:309` 有）。**CONFIRMED**

### 3.3 B-3 断裂/不一致嫌疑逐条回源

#### 3.3.1 §3 rootcause 5 条

| # | 报告主张 | 回源核验 | 判定 |
|---|---|---|---|
| 1 | 示例 `rootCause` 无类目前缀、`rootCauseCategory` 为 People，与前缀规则互斥 | **行为级实证**：实测示例确为 `rootCause:"example"` + `rootCauseCategory:"People"`；validator :319-328 硬校验 `rootCause.startsWith("People: ")`。报告引用行 `:47,56-60` 均真实存在且属正确机制区域（:47 string→'example'、:56-57 anyOf 分支）。**但机制的准确表述应为**：`rootCauseCategory` 的 `"People"` 并非来自 `generateValueForSchema`（:47 先命中 type==='string'，返回 `'example'`），而是来自收尾的 `Value.Cast`（:185）。详见 NEW-6 | CONFIRMED（附机制修正） |
| 2 | prompt 要求 evidence 空则 confidence<0.3，validator 与 admission gate 均不检查 | prompt :252-253 ✅；validator :270-400 无此规则 ✅；admission-gate.ts :25 阈值 0.5 ✅、:61-77 检查 ✅；:102-103 是附带证据（gateInput 装配点） | CONFIRMED |
| 3 | conversationWindow 顶层 + `context` 嵌套双份；80k 预算需同时改两处 | 报告 :540 引 `diagnostician-prompt-builder.ts:361-373`，真实为 `rootcause-prompt-builder.ts:364-373`（父文件仅 144 行）；:738 同因。机制正确：:368 顶层、:370 `context: compactContext`、:392 收缩时两处同步赋值 | DRIFT-1/2（结论成立） |
| 4 | Stage A 只容忍 parent ID 回显，Stage B 容忍任意 diag- 前缀 | :292-306 ✅（仅 `DIAG_ROOTCAUSE_PREFIX`）；distiller :130-148 ✅（三前缀数组 :131） | CONFIRMED |
| 5 | 【推断】evidence sourceRef 无生产回查；2g 回查 verbose-only | :178-188 ✅；diag-router-runner.ts:279 ✅ 未传第三参 → `options` undefined → verbose 恒 false | CONFIRMED |

#### 3.3.2 §3 distiller 5 条

| # | 报告主张 | 回源核验 | 判定 |
|---|---|---|---|
| 1 | 示例含 `groundedOnCorePrincipleIds:["example"]`，落入 fabricated ID 打击范围 | **行为级实证**：实测示例确为 `["example"]`；:159-165 注册表硬拒。报告引用行 `:47,74-78` 真实存在（:47 string→'example'、:74-77 array 分支），属正确机制区域 | CONFIRMED |
| 2 | flag 关闭时「幽灵引用」：prompt 说 provided axiom list above 但无清单 | :153 ✅ 恒含 above；:174 ✅ `? ' above' : ''`；`coreGrounding` 关闭时 :130 块为空串 | CONFIRMED |
| 3 | Stage B 无 `valid===true` 强制，Stage A 有 | :104-172 全文无 valid 检查 ✅；Stage A :309-311 有 ✅ | CONFIRMED |
| 4 | lineage 双字段处置不对称；`peer-runner-contracts.ts:361-406` 已有 reconcileLineageEcho 但 diag runners 未用 | distiller :338-343 ✅ 注释明言不回注；checkLineageIntegrity :352-361 ✅ 抛错；`reconcileLineageEcho` 函数体起于 :397（:360-363 是接口）→ DRIFT-3；结论成立（grep 证实 diag runners 未 import） | DRIFT（结论成立） |
| 5 | Stage B 无尺寸预算 | :246 裸 stringify ✅；无 maxMessageChars 引用 ✅ | CONFIRMED |

#### 3.3.3 §3 router 8 条

| # | 报告主张 | 回源核验 | 判定 |
|---|---|---|---|
| 1 | 指令禁生成 rootCause/evidence/confidence，示例却全含 | prompt :179-182 ✅；**实证** C1 示例确含三者 | CONFIRMED |
| 2 | title 契约三处不一致 | prompt :173「REQUIRED, 3-8 words」✅；schema :18 `Optional(String())` ✅；validator（:60-208）全文无 title ✅；示例 :161-163 只有 rationale ✅ | CONFIRMED |
| 3 | 示例含全部 5 种 kind，prompt 则要求按需 | **实证**：示例 recommendations 恰 5 条；adapter :13 `RECOMMENDATION_KINDS` 五元；prompt :165-167 ✅ | CONFIRMED |
| 4 | abstractedPrinciple 未经 EP-07 保护，是 router 转述 | :446-519 覆盖 rootCause/evidence/confidence/intentTension，**无 abstractedPrinciple** ✅；committer :207 写 `rec.abstractedPrinciple` ✅ | CONFIRMED（对应 R-11） |
| 5 | 缓存复用路径仅 JSON.parse + `as` | :199-206 ✅；`as DiagnosticianOutputV1` 在 :205（报告写 206，属边界行号微差） | CONFIRMED（行号微差） |
| 6 | factory 漏传 effectiveConfig 给 router | :623 ✅ rootcause 传；:627 ✅ distiller 传；:631 router 无 ✅；router-runner :131 读 `options.effectiveConfig`；base-peer :1008-1013 ✅ `if (!effectiveConfig) return false` | CONFIRMED（对应 R-08） |
| 7 | implementation → skill 通道未启用 → 必然 not_internalizable | prompt :163 ✅；`CANDIDATE_KIND_TO_ROUTE.implementation='implementation-candidate'` ✅；`ROUTE_CHANNEL_MAP[...]='skill'` ✅；`MVP_ENABLED_CHANNELS = {prompt, code_tool_hook, defer_archive}`（:108-112）不含 skill ✅；:151 拒绝 ✅ | CONFIRMED |
| 8 | taskId 注入无此字段的 schema，泄漏进持久层 | schema 无 taskId ✅；:448 注入 ✅；:314 → :322 committer + :352 pi_artifacts ✅ | CONFIRMED |

#### 3.3.4 §3 横切观察 7 条

| # | 报告主张 | 回源核验 | 判定 |
|---|---|---|---|
| 1 | 示例均由 schema 适配器动态合成，合成器不懂语义约束 | :35-168 ✅；三阶段均调 `adapter.generateExample(schema)`（:184/:125/:145）✅ | CONFIRMED |
| 2 | `valid` 三阶段两种口径 | Stage A :309-311 强制；Stage B :104-172 无；Stage C 走 default-validator :60-208 无 ✅ | CONFIRMED |
| 3 | 尺寸预算只有 Stage A 有 | :387-407 ✅ vs distiller :246 / router :226 裸 stringify ✅ | CONFIRMED |
| 4 | perStageTimeoutMs 写进 diagnosticJson 但从不传 runner | split :81 ✅ 默认 600_000；:293 ✅ 写入；runner options 无该字段 ✅（全文仅 :81/:293 两处使用）；实际死线 base-peer :108-114 `timeoutMs: 300_000` ✅；factory :640 ✅ | CONFIRMED（对应 R-17） |
| 5 | 信息流漏斗；Stage A ambiguityNotes 不透传 | distiller 负载仅 `{rootCauseArtifactId, rootCauseOutput}` :241-248；router 负载 :218-227 无 ambiguityNotes；最终由 router LLM 自填 ✅ | CONFIRMED |
| 6 | 三 runner 覆写 postFetchTransform 均不调 super | rootcause :356-358 ✅；distiller :338-343 ✅；router :446-448 ✅ 确无 super 调用；基类 :306-311 ✅ | CONFIRMED |
| 7 | 契约测试位置与厚薄；无「示例不违反 validator」不变量测试 | diag-rootcause-output.test.ts 415 行 ✅ 精确；distiller-prompt-builder.test.ts 44 行 ✅；diag-distiller-output.test.ts 104 行 ✅；router-prompt-builder.test.ts 报告写 1-58，实际全文 64 行（轻微区间偏差） | CONFIRMED（一处微差） |

**另核**：报告称「未见任何测试覆盖『动态示例不违反 validator 规则』」——核实 `schema-prompt-adapter.test.ts` 的断言仅到「示例通过 `Value.Check(DiagnosticianOutputV1Schema, parsed)`」（:17-21），**确无**「示例的 rootCause 前缀合法」「示例不含伪造 axiom ID」这类语义断言。**CONFIRMED，且这是报告最有价值的元观察之一。**

#### 3.3.5 §4 dreamer 7 条

| # | 报告主张 | 回源核验 | 判定 |
|---|---|---|---|
| 1 | 候选数量三处口径不一 | prompt :84 ✅「For each identified root cause, generate 1-5」；:97 ✅ 总数 1-5；validator :140-142 ✅；注释 dreamer-output.ts:4 ✅「2-3 diverse candidate corrections」 | CONFIRMED（对应 R-16） |
| 2 | sourcePainId 无输入来源、无校验、无消费者 | prompt :91 示例含 `"pain-null-crash"` ✅、:106 ✅；`DreamerPromptInput`（:41-46）无 sourcePainId ✅；validator 无校验 ✅；下游无消费者 ✅ | CONFIRMED |
| 3 | contextRefs echo 契约空洞 | prompt :102 ✅；reconcileLineageEcho 只保护 taskId（:379-381）✅；validator :160-162 只查 isArray ✅ | CONFIRMED |
| 4 | manifest 聚焦死路径 | `DREAMER_MANIFEST` 7 条全为 `<ns>.summary.*` ✅（:50-57）；`readFromSummary` 在顶层 summary 为字符串时返回 undefined ✅（summary-field-reader.ts:34-36）；`hasSummaryCollision` ✅ :1108-1115；`empty_allocation` 回退 ✅ resolve-injection.ts:102-105；runner :222-227 ✅ | CONFIRMED（对应 R-06） |
| 5 | candidates[0] 位置偏置 | artifact-summary.ts:238 ✅；context-manifests.ts:135-137 ✅（tier2 三项均 `.0.`）；artificer resolveDreamerContext :323 ✅ | CONFIRMED |
| 6 | prompt 总长无上限、不用 prompt-serializer | :135 裸 stringify ✅；`serializePromptInput` 仅 artificer :396 / evaluator :241 ✅（grep 全库证实）；context-manifests.ts:27-34 自认「NOT a prompt-total-length hard cap」✅ | CONFIRMED |
| 7 | sourcePrincipleId 语义错位嫌疑 | prompt :105 引导填 axiom ID ✅；strip-fabricated-ids.ts:22-28 只放行注册表 ID ✅；dreamer-runner.ts:304-309 写入该列 ✅ | CONFIRMED（报告已标推断，措辞恰当） |

#### 3.3.6 §4 philosopher 5 条

| # | 报告主张 | 回源核验 | 判定 |
|---|---|---|---|
| 1 | dreamerArtifactId 命名断链 → artificer 五维静默失效 | （a）philosopher 字段名 `sourceDreamerArtifactId`（philosopher-output.ts:24,42）✅ vs scribe prompt :78「dreamerArtifactId」✅；（b）artificer-runner.ts:271、276、280 三处提前 return 无事件 ✅（:268/:284/:300/:304 等后续分支均有事件）✅ | CONFIRMED（对应 R-01） |
| 2 | title ≤100 是纯口头契约 | prompt :94 ✅、:106 ✅；schema :34 仅 minLength1 ✅；validator :97 只查非空 ✅；artifact-summary.ts:59 `SUMMARY_HEADLINE_MAX_CHARS=200` ✅ | CONFIRMED |
| 3 | axiom 冲突信号只进 risks，risks 无结构化消费者 | prompt :113 ✅；`SCRIBE_MANIFEST`（:80-91）无 risks ✅；`resolvePhilosopher`（:252-264）无 risks ✅ | CONFIRMED |
| 4 | philosopher 无预算/无聚焦 | `MANIFEST_RUNNER_KINDS` 仅 4 个 ✅（:332-334）；philosopher-runner 无 manifest import ✅；:142 裸 stringify ✅ | CONFIRMED |
| 5 | 上游多候选在哲学家一次性坍缩 | prompt :84 ✅；schema 单一 principleCandidate ✅ | CONFIRMED |

#### 3.3.7 §4 附「跨两代理一致性核对」

报告称：`generatedAt` 无条件覆盖 + `reconcileLineageEcho` 兜底 taskId/sourceDreamerArtifactId，**唯 contextRefs（dreamer）与 dreamerArtifactId（scribe 段）不在保护清单**。

核实：`base-peer-runner.ts:306-311` ✅；`dreamer-runner.ts:374-386` 只列 taskId ✅；`philosopher-runner.ts:382-397` 列 taskId + sourceDreamerArtifactId ✅；`scribe-runner.ts:416-425` 明确注释 dreamerArtifactId「没有权威值，不处理」✅。**CONFIRMED**

### 3.4 B-4 §3.0 命名纠偏 + §1 登记表 5 条

#### 3.4.1 §3.0 三阶段执行序

报告主张：真实串联为 **Stage A diag_rootcause → Stage B diag_distiller → Stage C diag_router**（非任务简报的 router→rootcause→distiller）。

| 证据点 | 报告 | 实测 | 判定 |
|---|---|---|---|
| 串联器类 | `SplitDiagnosticianRunner.run()` :96-262 | :96 `async run(parentTaskId: string)` ✅，类体止于 :262 ✅ | CONFIRMED |
| Stage A 子任务 ID | :124 | :124 `` `diag_rootcause-${parentTaskId}` `` ✅ | CONFIRMED |
| Stage B 依赖 A | :150 `dependencyTaskIds:[stageATaskId]` | :150 ✅ | CONFIRMED |
| Stage C 依赖 A+B | :170 | :170 `[stageATaskId, stageBTaskId]` ✅ | CONFIRMED |
| Stage C 是最后一级 | router 消费 A/B artifact、产出最终 output | :163-171 ✅ Stage C 段；diag-router-runner :198-214 读两 artifact ✅ | CONFIRMED |
| 生产唯一 wiring | pain-signal-runtime-factory.ts:621-642 | :621 rootcause / :625 distiller / :629 router / :634 Split runner / :640 perStageTimeoutMs ✅ | CONFIRMED |
| 单体 runner 已删除 | diagnostician-prompt-builder.ts:12 注释 | :12 注释确含 monolithic 已删除 ✅；factory :613-617 注释 ✅ | CONFIRMED |

#### 3.4.2 §1 登记表 5 条（R-11/R-16/R-17/R-18/R-06）

| # | 报告条目 | 回源 | 判定 |
|---|---|---|---|
| R-11 | EP-07 不变量不含 abstractedPrinciple | diag-router-runner.ts:446-519 字段枚举确为 rootCause(:455-465)/evidence(:468-477)/confidence(:480-489)/intentTension(:497-517)，**无 abstractedPrinciple** ✅；committer :207 取 router 侧值 ✅ | CONFIRMED |
| R-16 | dreamer 候选数量三处不一 | 见 3.3.5#1 | CONFIRMED |
| R-17 | perStageTimeoutMs 元数据脱节 | 见 3.3.4#4；factory:640 ✅；base-peer:108-114 ✅ | CONFIRMED |
| R-18 | confidence<0.3 承诺无执行 | 见 3.3.1#2；admission-gate.ts:25 ✅ / :61-77 ✅ | CONFIRMED |
| R-06 | manifest 死链（summary-field-reader 读侧链） | 见 3.3.5#4；`feature-flag-contract.ts:340/351/357` 三 flag 全 `enabled:false` ✅；`resolve-injection.ts:101-105` ✅；`summary-field-reader.ts:10-12,34-51` ✅；`base-peer-runner.ts:1108-1123` ✅ | CONFIRMED |

**R-06 补充确认**：报告 §0.2 称三层 flag「全部默认休眠」。实测：`artifact_summary_redundancy` :340 `enabled:false`；`context_manifest_budget` :351 `enabled:false`；`progressive_evaluator` :357 `enabled:false`。**三/三 一致。CONFIRMED**

---

## 4. 行号漂移修正表

仅 3 处，均为**指向偏差**（结论不受影响）。

| # | 报告引用 | 问题类型 | 正确指向 | 影响 |
|---|---|---|---|---|
| DRIFT-1 | `diagnostician-prompt-builder.ts:361-373`（:540） | 行号超界（该文件共 144 行） | `diagnostician/rootcause-prompt-builder.ts:364-373`；同句的类型定义 `diagnostician-prompt-builder.ts:61-96` 是正确的 | 无 |
| DRIFT-2 | `diagnostician-prompt-builder.ts:364-373`（:738） | 同 DRIFT-1 | 同上 | 无 |
| DRIFT-3 | `peer-runner-contracts.ts:361-406`（distiller 卡 4） | 区间起始指向接口而非函数 | 接口 `LineageEchoFieldRule` :360-363；函数 `reconcileLineageEcho` **:397 起** | 无 |

### 4.1 附带微差（不计入 DRIFT，供参考）

| 报告位置 | 报告 | 实测 |
|---|---|---|
| router 卡 5 | `split-diagnostician-runner.ts:199-206`，`as` 断言在 :206 | `as DiagnosticianOutputV1` 在 **:205**；:206 为字面量收尾 |
| 横切 7 | `router-prompt-builder.test.ts` 1-58 行 | 文件共 **64** 行（有效测试体止于 :57） |
| C1 键序 | 示例键序 `…evidence, confidence, recommendations` | 实测键序 `…evidence, recommendations, confidence`（**值完全等价**，仅键序呈现差异） |

### 4.2 经复核撤销的 DRIFT（透明记录）

核实过程中曾把「A4/B2 示例重建的归因行号」初步记为 DRIFT，**复核后撤销**。撤销理由：`schema-prompt-adapter.ts:47,56-60` 与 `:47,74-78` 引用的行号**全部真实存在，且覆盖了正确的机制区域**（:47 = `if (schema.type === 'string') return 'example'`；:56-57 = anyOf 取首支；:74-77 = array 生成单元素）。报告并未错标。

真正需要修正的**不是行号，而是机制表述**：报告称示例的 `rootCauseCategory` 来自 `union 取第一个字面量`（A4 段文字），但实测该值实际来自收尾的 `Value.Cast`（:185）——因为 union 成员对象同时带 `type:'string'`，`generateValueForSchema` 在 :47 即返回 `'example'`，`const` 分支（:50）**永远不会被触及**。详见 NEW-6。

**记录此撤销的意义**：核实员的第一版判断比报告更不准确；报告在此处的行号引用是正确的。保留此节以体现核实结论的收敛过程与自我纠错。

---

## 5. 完整性补记（NEW）

### 5.1 NEW-1【P3】`violatedPrinciples[].principleId` 无注册表校验（与 Stage B 同族规则不一致）

**事实**：

- router prompt 明示该字段值域：`principleId: if the principle corresponds to a core axiom (e.g. T-01 through T-10), include the axiom ID`（`router-prompt-builder.ts:174`）
- schema 仅 `Type.Optional(Type.String({minLength:1}))`（`diagnostician-output.ts:17`）
- `DefaultDiagnosticianValidator`（`default-validator.ts:60-208`）**全文不检查 principleId**
- 对照：Stage B 的同族字段 `groundedOnCorePrincipleIds` 有硬注册表校验（`diag-distiller-output.ts:159-165` 调 `isCorePrincipleId`）

**下游泄漏面（比单纯「无校验」更实质）**：`principleId` 会被 `artifact-summary.ts:218-220` 收集、:227 拼成 `affectedComponents`，再作为 `diagnosis.summary.affectedComponents` 进 `DREAMER_MANIFEST` tier1（`context-manifests.ts:56`）。即伪造的 `T-99` 可跨阶段流入 dreamer 的聚焦上下文。

**严重度建议**：P3（无状态破坏、无 Owner 面错误结论；但违反「单一权威」精神，且与 Stage B 同族规则两制）。

### 5.2 NEW-2【P3】三阶段 languageDirective subject 缺省 `'principle'`，字段清单与实际 schema 系统性错配

**事实**：

- Stage A/B/C 均调用 `buildLanguageDirective(outputLanguage)`（`rootcause-prompt-builder.ts:186`、`distiller-prompt-builder.ts:127`、`router-prompt-builder.ts:147`），**未传第二参** → 缺省 `'principle'`（`language-directive.ts:174`）
- 于是注入的可用字段清单恒为 `(title, statement, rationale, applicability, antiPatterns, description)`（`language-directive.ts:147`）
- 但三个诊断 schema **没有一个含 title/statement/applicability/antiPatterns/description**：

| schema | 实际人类可读字段 | 与清单交集 |
|---|---|---|
| `DiagRootCauseOutputV1` | summary, rootCause, causalChain[].statement, evidence[].note | 无（`statement` 在因果链内非顶层，`rationale` 不存在） |
| `DiagDistillerOutputV1` | abstractedPrinciple, rationale | 仅 `rationale` |
| `DiagnosticianOutputV1` | summary, rootCause, violatedPrinciples[].rationale, recommendations[].description | 仅 `rationale` |

即：清单中唯一命中的 `rationale` 只在 Stage B/C 存在；而真正需要翻译的 `summary`/`rootCause`（Stage A/C）与 `abstractedPrinciple`（Stage B）**从未被列入**。

**从属风险（更实质）**：Stage A/C 的 `rootCause` 类目前缀必须保持**英文**——`diag-rootcause-output.ts:319-328` 硬校验 `rootCause.startsWith("People: ")` 等。而 languageDirective 只声明「Lineage and evidence fields MUST NOT be translated」，**未把 `rootCause` 列为不可翻译标识**。在 `outputLanguage='zh-CN'` 且 `intent_engineering`/`pain_diagnosis_persistence` 等中文字段诉求并存时，LLM 有动机把 `rootCause` 译为「设计：…」，从而触发 validator 硬拒不匹配。

**与报告的关系**：报告 A5 正确陈述了「subject 缺省 `'principle'`」这一事实，但未指出其**后果**，也未将其列入任何断裂嫌疑条目。属漏记。

**严重度建议**：P3（`outputLanguage` 默认未配置时整块为空串，零影响；仅当 Owner 配置 zh-CN/en 时该指令会给出错误的字段清单）。

### 5.3 NEW-3【P3】philosopher 对 `JSON.parse` 失败回退字符串 → 双重编码 JSON

**事实**：`philosopher-runner.ts:205-210`

```ts
let parsedDreamerArtifact: unknown;
try { parsedDreamerArtifact = JSON.parse(context.dreamerArtifact); }
catch { parsedDreamerArtifact = context.dreamerArtifact; }   // ← 保留原始字符串
```

该 `unknown` 随后原样进 `PhilosopherPromptInput.dreamerArtifact`，由 `philosopher-prompt-builder.ts:142` 的裸 `JSON.stringify` 序列化。若它是字符串，最终 message 中该字段形如 `"dreamerArtifact":"{\"taskId\":...}"` —— **对 LLM 呈现的是转义字符串而非嵌套对象**，违反 `rc-8-safe-serialization` 的精神（序列化应让消费方得到可用结构）。

**与报告的关系**：报告 §4 philosopher 输入表已记录「失败则按字符串嵌入」，但该表述出现在**输入表**而非断裂嫌疑，且未指出「双重编码」这一具体后果。

**严重度建议**：P3（parse 失败本身罕见——`buildContext` :193 取的是 store 里的 `contentJson`）。

### 5.4 NEW-4【P3】Stage B prompt INPUT 清单漏列 Stage A 会携带的 `intentTension` / `ambiguityNotes`

**事实**：distiller 的用户负载是 Stage A **全量输出**（`distiller-prompt-builder.ts:243` `rootCauseOutput: context.rootCauseOutput`，类型 `DiagRootCauseOutputV1`）。当 `intent_engineering` 开启且 Stage A 产出了 `intentTension`（`diag-rootcause-output.ts:231`）时，该字段随负载进入 Stage B prompt。

但 Stage B 的 INPUT 说明只列举 6 个字段（`summary/causalChain/rootCause/rootCauseCategory/evidence/confidence`，:139-146），**未提 `intentTension` 与 `ambiguityNotes`**。LLM 对未声明字段缺乏使用指引——尤其 `ambiguityNotes` 可携带「Insufficient evidence」等 Stage A 自评，本可提升蒸馏质量。

**与报告的关系**：报告 §3 横切 5 正确指出「Stage A 的 ambiguityNotes 不透传到最终输出」，但未指出**它在 Stage B 是被物理携带却未被说明的**。两者是不同事实，互为补充。

**严重度建议**：P3（提示词完备性）。

### 5.5 NEW-5【P3】OCRA（openclaw-cli）路径不做 `stripLineageFields`

**事实**：

- pi-ai 适配器在三条路径（tool_call :1123、JSON mode :1204、free-form :879）均调 `stripLineageFields`，剥离 `LINEAGE_FIELDS = [taskId, sourcePainId, sourceTaskId, sourceRunIds, sourceArtifactId, sourceRefs]`（`output-repair-contract.ts:100-107`）
- `openclaw-cli-runtime-adapter.ts` **全文无 `stripLineageFields` 调用**（grep 零命中）
- 因此在该运行时，LLM 提供的 lineage 字段不会被剥离；`injectRunnerLineageIfAbsent` **仅在字段缺失时注入**，存在但不为空时**不改写**

**注意（避免高估）**：这不必然造成漏洞。`reconcileLineageEcho` 对已知权威值会覆盖错误回显；且 dreamer 的 `sourcePainId` 本就被报告判定为「无消费者」。故实际影响限于「理论上 LLM 可注入无消费者的 lineage 字段」。

**与报告的关系**：§3.0 只描述了 pi-ai 侧的剥离，未比较两运行时的保护面差异。

**严重度建议**：P3（且须标注为「需 Owner 裁决是否为有意设计」——两适配器可能刻意承担不同职责）。

### 5.6 NEW-6【观察/定级修正】`generateExample` 的 `Value.Cast` 静默兜底

**事实（行为级实证）**：`generateExample` 结尾（`schema-prompt-adapter.ts:185`）：

```ts
const checked = Value.Check(schema, example) ? example : Value.Cast(schema, example);
```

实测：`Value.Cast` 对 literal union 会**回填首个字面量**——`{rootCauseCategory:'example'}` → `{rootCauseCategory:'People'}`。

**含义**：报告 rootcause/distiller 卡 1 的结论成立，但归因需精确化：

- `rootCauseCategory`、`scope` 两条**不会**以非法值出货（Cast 救回）
- 但 `rootCause:"example"`（普通 string，无 const）与 `groundedOnCorePrincipleIds:["example"]`（array of plain string）**会**原样出货 —— 报告的实质结论（示例诱导 LLM 违反前缀规则 / 伪造 axiom ID）**依然成立**

**建议新增观察**：`generateExample` 用 `Value.Cast` 兜底，使「示例生成器产出非法示例」**永远不报错**，属静默降级面（rc-9 精神）：它同时掩盖了合成器不理解语义约束这一根因。这比单条「示例不合法」更值得记录。

### 5.7 已排查但未发现新问题的方向（供 Owner 判断核实充分性）

任务书点名 4 个重点怀疑方向，核实结论：

| 怀疑方向 | 核实结论 |
|---|---|
| 三阶段共用 schema-prompt-adapter 合成示例的语义问题是否还有报告未点到的违反项 | 已逐字段核对三张 schema 的实测示例与全部 validator 规则。**除已记录的 3 条（前缀、伪造 axiom ID、5 kind 诱导）外，未发现新的实质违反项**；新增的 NEW-6 是对归因机制的精度修正与「Cast 静默兜底」这一新观察 |
| budget/serializer 机制对各 runner 生效面是否一致 | 确认为「不一致」，且报告已完整记录：`serializePromptInput` 仅 artificer/evaluator（50k 硬上限）；裸 stringify 有 rootcause（带自有 80k 收缩）、distiller、router、dreamer、philosopher、scribe、rollout；manifest+budget 仅 dreamer/scribe/artificer/evaluator。**额外确认**：dreamer 的 manifest 路径因键碰撞失效（R-06），则该 runner 同时失去「聚焦」与「总长上限」两层保护——报告 §4 dreamer 卡 6 已覆盖。无新增 |
| philosopher 的 echo 校正（reconcileLineageEcho）覆盖面 | 覆盖面 = taskId + sourceDreamerArtifactId（:388-396），**正确且充分**：philosopher 输出 schema 仅这两条 lineage 字段。报告「跨两代理一致性核对」已正确指出「唯 contextRefs（dreamer）与 dreamerArtifactId（scribe 段）不在保护清单」。**无新增**；NEW-2/5 是相邻但不同的问题 |
| languageDirective 注入是否可能破坏输出 JSON | ① 指令块追加在 **systemPrompt**（非 message 内），不破坏 JSON 结构；② 但 NEW-2 的字段清单错配会**误导** LLM 翻译错误的字段集合；③ 更实质的风险见 NEW-2 从属风险：`rootCause` 的英文前缀受 validator 硬校验，而 languageDirective 未将其列为不可翻译标识 → zh-CN 配置下可能触发 `output_invalid` 重试。**严重度 P3**（受 flag 与配置双重限制，但机制真实） |

---

## 6. 建议修正清单（原文 → 建议文）

**本次无 REFUTED，故无事实纠正项。** 以下为精度/归属改进建议。

### 6.1 DRIFT 修正（3 处）

| # | 原文 | 建议文 |
|---|---|---|
| 1 | `diagnostician-prompt-builder.ts:361-373` | `diagnostician/rootcause-prompt-builder.ts:364-373` |
| 2 | `diagnostician-prompt-builder.ts:364-373` | `diagnostician/rootcause-prompt-builder.ts:364-373` |
| 3 | `peer-runner-contracts.ts:361-406` | `peer-runner-contracts.ts:397+`（接口定义在 :360-363） |

### 6.2 表述精度建议（不改结论）

| # | 位置 | 原文要点 | 建议 |
|---|---|---|---|
| 1 | §3 rootcause 卡 1 | 「动态示例的 `rootCause:"example"` 无类目前缀…忠实模仿示例结构的 LLM 会稳定触发 output_invalid 重试」 | 结论正确，行号引用正确。建议补充机制：示例的 `rootCauseCategory`（「People」）**不来自 `generateValueForSchema` 的 anyOf 取首支**，而来自收尾 `Value.Cast`（:185）——union 成员带 `type:'string'`，:47 即返回 `'example'`，`const` 分支（:50）永不触及。**出货的非法项只有 `rootCause` 无前缀**；并建议把 `Value.Cast` 静默兜底列为独立观察（NEW-6） |
| 2 | §3 横切 1 | 「合成器不理解语义约束…导致三个阶段各自出现『示例违反自身规则』」 | 建议区分**技术层**（`Value.Cast` 兜底 → 示例永远通过 `Value.Check`）与**语义层**（LLM 模仿后被 validator 拒）。当前措辞易让读者以为示例未通过自身 schema。另建议精确化 A4 段的机制描述（见上表第 1 行） |
| 3 | §3 router 卡 5 | 「…即 `as DiagnosticianOutputV1`（206 行）」 | 建议改为 **205 行**（`as` 断言在 :205，:206 为字面量收尾） |
| 4 | §3 横切 7 | 「router-prompt-builder.test.ts…1-58 行」 | 建议改为「1-57 行」或「全文 64 行」 |
| 5 | §4 philosopher 输入表 | 「失败则按字符串嵌入」 | 建议点明后果：造成 message 中该字段的**双重编码**，并建议记为独立 P3（NEW-3） |

### 6.3 建议新增条目（6 条，对应 §5）

| 建议编号 | 标题 | 建议位置 | 建议严重度 |
|---|---|---|---|
| NEW-1 | `violatedPrinciples[].principleId` 无注册表校验，且经 affectedComponents 流入 dreamer manifest | §3 router 卡（新增）或 §3 横切 | P3 |
| NEW-2 | 三阶段 languageDirective subject 缺省 `'principle'`，字段清单与诊断 schema 错配；并使 `rootCause` 面临被翻译的风险（validator 硬校验英文前缀） | §3 横切（新增） | P3 |
| NEW-3 | philosopher `JSON.parse` 失败回退字符串导致双重编码 JSON | §4 philosopher 卡（新增） | P3 |
| NEW-4 | Stage B INPUT 清单漏列 Stage A 实际携带的 `intentTension`/`ambiguityNotes` | §3 distiller 卡（新增） | P3 |
| NEW-5 | OCRA 路径不调 `stripLineageFields`，与 pi-ai 保护面不一致（需 Owner 裁决是否刻意） | §3.0 共享执行底座（补充） | P3 |
| NEW-6 | `generateExample` 的 `Value.Cast` 静默兜底掩蔽合成器语义错误 | §3 横切 1（补充） | P3 |

---

## 7. 核实声明与局限

1. **只读核实**：本次未修改任何已存在文件（含 REPORT.md），未动 `packages/**`、`.cnb.yml`、`.cnb/`。唯一新增文件为本 VERIFICATION-B.md。
2. **基线**：所有行号裁决基于 `70d824c4`；已证明管辖文件在该提交与 HEAD 间字节相同，故行号可直接在当前检出复现。
3. **超出静态阅读的证据**：A4/B2/C1 三处示例重建经**实际运行生产 `DefaultSchemaPromptAdapter`** 验证（`@sinclair/typebox@0.34.48`，与 package.json 声明一致），值等价与键序均已机器比对。
4. **未执行测试套件**：本环境无 `node_modules`（`npm ci` 未运行），故未运行 vitest，亦未执行 `npm run verify:merge`。核实依赖：源码逐行阅读 + 模板字符串机器比对 + 目标函数的行为级实跑。**未声称跑过任何测试。**
4a. **git hooks 实况**：本环境**未安装 lefthook 钩子**（无 `node_modules`；`.git/hooks/` 下无 `pre-commit`；`core.hooksPath` 未设置）。实际存在的钩子仅 git-lfs 的 `post-commit`/`pre-push`，与代码检查无关。因此 §23A 的 `worktree-guard` 与 `verify:merge` 本次**从未生效**（非被绕过）。提交未使用 `--no-verify`。
4b. **§23A worktree 张力（需 Owner 裁决）**：本检出是**主检出**（`git worktree list` 仅一项），而 `git-3-primary-worktree-readonly` 要求 AI 不得在主检出实现/提交。本次触发入口在同一检出内直接委派（未建独立 worktree），核实员按任务书指定分支名 `ai/cnb-dev/issue-29` 在当检出完成。核实员**未设置** `PD_DEV_WORKTREE_ALLOW_PRIMARY`（该 env 为人类专属）。属入口设计与 §23A 的张力，提交 Owner 裁决。
5. **推断边界**：报告中标【推断】的条目，核实员在不改变其推断性质的前提下提供实测支持（A4/B2/C1 已从推断升为实证）；§4 dreamer 卡 7、philosopher 卡 1 的「最隐蔽断链」仍有赖 activation 侧核实，本次未越界。
6. **管辖外**：§1 登记表中 R-01..R-05、R-07..R-10、R-12..R-15、R-19+ 与 §2/§5/§6 未在本次核实范围（除 B-4 点名的 5 条）。
