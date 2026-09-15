# PRI-807 Phase 0 · Worker B — Prompt / Schema / Validator Contract 矩阵

- 任务：PRI-807 Phase 0 / Worker B（Prompt / Schema / Validator Contract，只读审计）
- 审计对象：PD 仓库内置 Agent 管道「模型被教的格式 vs 机器实际校验的格式」五层契约面
- 唯一写入：本文件。未修改任何源码、配置、测试、`packages/**`、`.cnb/**`
- 判定词：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE
- 证据优先级：生产代码 > runtime contract / schema / DDL > 生产测试 > 文档 > 注释 > 推断

---

## 1. Scope

回答一个问题：

> **模型被教的格式（prompt output instructions + example）、工具暴露的 schema（submit_* tool 参数）、canonical schema（OUTPUT_SCHEMA_REGISTRY / TypeBox）、semantic validator、runner normalization/repair——这五层是否真正一致？**

覆盖 11 个 stage：`diag_rootcause`、`diag_distiller`、`diag_router`、`dreamer`、`philosopher`、`scribe`、`artificer`、`evaluator`、`rollout_reviewer`、`signal-classification`、`correction-observer`。

机械核对六类断缝（§4.3）：REQUIRED↔optional 不一致 / 示例过不了自己的 validator / tool schema 缺 canonical 必填字段 / 两份「等价」schema 实际有差异 / validator 要求 prompt 从未教过的字段 / normalizer 静默改变语义。

本文件**不提修复方案**，只登记事实与不变量（§8 只写 invariant）。

### 1.1 本轮的证据强度边界（必读）

| 手段 | 是否执行 | 说明 |
|---|---|---|
| 打开 prompt builder / tool schema / canonical schema / validator / normalizer / consumer 两端以上 | 是 | 全部 11 个 stage 双端以上 |
| 逐字抄 prompt 全文 | 否（本文件为**矩阵**，非 §3/§4/§5 式全文复刻） | 关键约束逐条摘录 + `file:line`，历史全文见 `docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` |
| **行为级实证**（实际运行生产代码） | 是 | 在 `/tmp` 独立目录安装 `@sinclair/typebox@0.34.48`（与 `packages/principles-core/package.json` 声明一致）与 `typebox@1.3.16`，用 `tsx` 直接加载工作区真实模块：`DefaultSchemaPromptAdapter`、`DefaultDiagRootCauseValidator`、`DefaultDiagDistillerValidator`、`DefaultArtificerValidator`、`DefaultEvaluatorValidator`、`DefaultScribeValidator`、`DefaultDreamerValidator`、`DefaultPhilosopherValidator`、`DefaultRolloutReviewerValidator`、`DefaultDiagnosticianValidator`、`checkForbiddenPatterns`、`typeboxToOpenAIJsonSchema`、`pitask-metadata.parsePITaskMetadata` |
| 运行 vitest / `npm run verify:merge` | **否**（本环境无 `node_modules`，`npm ci` 未执行） | 未声称跑过任何测试套件 |

行为级实证让多处「静态阅读只能推断」的结论升级为实测（示例逐字段对 validator、两份 schema 的键集与行为、静态禁门对 22 个声明模式的检出率、`Value.Cast` 兜底行为、空 `requiredChanges` 的 metadata 可读性）。

---

## 2. Baseline

```
$ git rev-parse HEAD
cdec05d4bc4252151c7f9f118bdad90f25067594
```

**BASELINE: SYNCED**（等于任务书指定 `cdec05d4bc4252151c7f9f118bdad90f25067594`，无 Drift Warning）。

补充核对：

- 当前检出分支即 `audit/pri-807-phase0-base`（`git worktree list` 仅一项）。
- 历史审计 #1707 的基线 `70d824c4` 是 HEAD 的祖先（`git merge-base --is-ancestor` 通过），`70d824c4..HEAD` 共 79 个提交；其中 `#1698`（`285d1c81`）、`#1693-r3`（`afa95651`）均已并入 HEAD。
- 本文件所有 §4 行号锚定 **cdec05d4**。以下 8 个关键文件在 `70d824c4..cdec05d4` 之间**字节未变**（`git diff --stat` 空输出），因此 #1707/#1710 中针对它们的结论与行号在本基线直接可复现：

  `diagnostician/rootcause-prompt-builder.ts`、`diagnostician/distiller-prompt-builder.ts`、`diagnostician/router-prompt-builder.ts`、`internalization/artificer-prompt-builder.ts`、`internalization/artificer-output.ts`、`internalization/dreamer-output.ts`、`internalization/dreamer-prompt-builder.ts`、`internalization/philosopher-output.ts`

  另有 `adapter/schema-prompt-adapter.ts`、`internalization/scribe-output.ts`、`internalization/evaluator-output.ts` 等在本窗口同样未变（未逐一举全）。

- **在本窗口内发生变化的契约文件**（决定 §5 的 FIXED/DRIFTED 判定）：

  | 文件 | 变化 |
  |---|---|
  | `tools/artificer-output-typebox.ts` | +`evidenceRefs`（`afa95651`，PRI-795 r3） |
  | `tools/artificer-l2-tool-contract.ts` | spec 文本重写 golden-trace 段 + submit 描述补 `evidenceRefs`/`requiresContextVersion`（`afa95651`） |
  | `internalization/rollout-reviewer-output.ts` | +113/-23（PRI-720：mode-aware validator） |
  | `internalization/rollout-reviewer-prompt-builder.ts` | +102/-23（PRI-720：principle_semantic 模式） |
  | `internalization/rollout-reviewer-runner.ts`、`pitask-metadata.ts`、`intake-to-internalization-bridge.ts`、`evaluator-runner.ts` | PRI-720 通道化改造 |

- 历史种子可用：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`（§3/§4/§5 诊断三阶段 + 内化链四代理）与 `VERIFICATION-B/C.md` 均存在，已作为事实种子读取；**但本文件每一条判定均回源 current main 重新核对**。

---

## 3. Current Authorities

### 3.1 OUTPUT_SCHEMA_REGISTRY 当前覆盖面

`adapter/output-schema-registry.ts:37-50` 共 **12** 条（= 全量）：

| # | schemaRef | 绑定的 TypeBox 常量 | 生产 runner 是否真的传该 ref |
|---|---|---|---|
| 1 | `diagnostician-output-v1` | `DiagnosticianOutputV1Schema` | 是（`diag-router-runner.ts:259`） |
| 2 | `diag-rootcause-output-v1` | `DiagRootCauseOutputV1Schema` | 是（`diag-rootcause-runner.ts:227`） |
| 3 | `diag-distiller-output-v1` | `DiagDistillerOutputV1Schema` | 是（`diag-distiller-runner.ts:209`） |
| 4 | `dreamer-output-v1` | `DreamerOutputV1Schema` | 是（`dreamer-runner.ts:242`） |
| 5 | `philosopher-output-v1` | `PhilosopherOutputV1Schema` | 是（`philosopher-runner.ts:227`） |
| 6 | `scribe-output-v1` | `ScribeOutputV1Schema` | 是（`scribe-runner.ts:242`） |
| 7 | `artificer-rule-output-v2` | `ArtificerRuleOutputSchema` | 是（`artificer-runner.ts:947`） |
| 8 | `evaluator-output-v1` | `EvaluatorOutputV1Schema` | 是（`evaluator-runner.ts:882`） |
| 9 | `rollout-reviewer-output-v1` | `RolloutReviewerOutputV1Schema` | 是（`rollout-reviewer-runner.ts:543`） |
| 10 | `empathy-observer-output-v1` | `EmpathyObserverOutputV1Schema` | **否**（无生产 startRun；仅测试 `observer/__tests__/empathy-observer*.test.ts`） |
| 11 | `correction-observer-output-v1` | `CorrectionObserverOutputV1Schema` | 是（`observer/correction-observer.ts:142`） |
| 12 | `signal-classification-output-v1` | `SignalClassificationOutputV1Schema` | 是（`openclaw-plugin/src/core/signal-collector-host.ts:639`） |

解析语义（`output-schema-registry.ts:62-65`）：缺 ref = 用默认；**未知非空 ref = fail loud**（`pi-ai-runtime-adapter.ts:624-631`、`openclaw-cli-runtime-adapter.ts:876-880`）。

### 3.2 五层的实际承载者（不是每个 stage 都有五层）

四类 stage 形态，**不能假设同一套**：

| 形态 | stage | 说明 |
|---|---|---|
| A. 提示词合成示例 | diag_rootcause / diag_distiller / diag_router | 示例由 `DefaultSchemaPromptAdapter.generateExample(schema)` **机械合成**（`:176-190`），再由 `Value.Cast` 兜底 |
| B. 硬编码示例 + registry 校验 | dreamer / philosopher / scribe / evaluator / rollout_reviewer / correction-observer / signal-classification | 示例写在 prompt 常量里；校验走 `resolveOutputSchema` → `Value.Check`（adapter）→ 各自 validator |
| C. 双 schema（tool + canonical） | dreamer / artificer | L2 工具循环另有一份 `typebox` 声明（`tools/*.ts`），与 canonical 是**两个包、两份对象** |
| D. 无 tool schema | 其余 | PiAi 路径的 tool_call 模式由 `buildSchemaToolDefinition(schemaRef, schema, adapter)` 从 canonical schema **动态派生**工具参数（`pi-ai-runtime-adapter.ts:1076`），不是第二份声明 |

### 3.3 canonical schema 的「另一种表达」：provider 侧 JSON Schema

`adapter/schema-json-converter.ts:81-90` 把 TypeBox schema 转成 OpenAI `json_schema`：递归 `additionalProperties:false`、剔元字段、**核心对象不深拷贝**（无 `type` 的顶层节点原样 `convertNode`，直接改写入参）。该产物只进 `response_format.json_schema.schema`（`pi-ai-runtime-adapter.ts:1172-1179`）与 repair prompt 的 `schemaJson`（`:646`），**不参与运行时 `Value.Check`**。故它是一份**第三型 canonical schema 表达**（§6 NEW-7）。

---

## 4. Contract Map

字段口径：① Prompt output instructions ② Prompt example ③ Tool schema ④ OUTPUT_SCHEMA_REGISTRY ref ⑤ Canonical TypeBox / validator ⑥ Normalization-repair ⑦ Semantic validator ⑧ Consumer。

### 4.1 diag_rootcause（Stage A）

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `PHASE 1/2/3` + `CRITICAL` 只输出 JSON；`CONSTRAINTS` 含「rootCause MUST include 类目前缀」「rootCauseCategory MUST match 前缀」「evidence 空则 confidence<0.3」 | `rootcause-prompt-builder.ts:213-257`；约束 :248-256 |
| ② 示例 | **机械合成**（`generateExample`），非硬编码。实测 12 键 | `rootcause-prompt-builder.ts:184`；实测输出见 §5/R-02 证据 |
| ③ Tool schema | PiAi tool_call 路径动态派生 `record_diag_rootcause_output_v1`（参数 = canonical schema 本身）；json_mode 路径 = 转换后 JSON Schema | `pi-ai-runtime-adapter.ts:1076`、`:1172` |
| ④ registry ref | `diagnostician-output-v1` 之外的 `diag-rootcause-output-v1` | `output-schema-registry.ts:39`；runner `diag-rootcause-runner.ts:227` |
| ⑤ Canonical | `DiagRootCauseOutputV1Schema`（`diag-rootcause-output.ts:208-232`）：`valid/diagnosisId/taskId/summary/causalChain[why1-5,statement,evidenceRefs≥1]/rootCause/rootCauseCategory∈4/evidence/confidence[0,1]`，`ambiguityNotes?`、`intentTension?`（`additionalProperties:false`） | `diag-rootcause-output.ts:37-46,54-57,179-187,208-232` |
| ⑦ Semantic validator | `DefaultDiagRootCauseValidator`：对象守卫 → **taskId 回注（仅父 ID 容忍）** → **`valid!==true` 硬拒** → 类目枚举 → **前缀匹配硬拒** → causalChain 逐项（why∈[1,5]、statement 非空、evidenceRefs≥1）→ evidence 逐项 → `intentTension.confidence` 禁字段 → TypeBox `Value.Check` 兜底 | `diag-rootcause-output.ts:266-401`（回注 :293-307；valid :309-311；前缀 :319-328） |
| ⑥ Normalization | `postFetchTransform` **只** `injectRunnerLineageIfAbsent(taskId)`（absent 才填）；不调 `super.postFetchTransform`（**不覆盖 generatedAt**） | `diag-rootcause-runner.ts:356-358` |
| ⑧ Consumer | Stage B 负载 + Stage C 输入；artifact 落 `pi_artifacts` | `diag-distiller-runner.ts:241-248`；`diag-router-runner.ts:180-200` |

**断缝**：②示例 `rootCause="example"` 无类目前缀（validator 硬拒）、`groundedOnCorePrincipleIds` 见 4.2；示例 `taskId="example"` 与 runner 回注冲突（回注只在 absent 时填，示例已 present → 必然 mismatch）。①承诺 evidence 空则 confidence<0.3 无执行面。①全文未出现 `valid`，但 validator 硬拒 `valid!==true`。

### 4.2 diag_distiller（Stage B）

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `INPUT` 列 6 字段；`OUTPUT REQUIREMENTS`；`QUALITY GUARD`（abstract vs rule-like）；`CONSTRAINTS` 含「groundedOnCorePrincipleIds 只能取给定清单${coreGrounding?' above':''}，伪造即校验失败」「abstractedPrinciple ≤200」 | `distiller-prompt-builder.ts:135-176` |
| ② 示例 | 机械合成 | `distiller-prompt-builder.ts:125`；实例 :148 |
| ③ Tool schema | 动态派生（PiAi） | `pi-ai-runtime-adapter.ts:1076` |
| ④ registry ref | `diag-distiller-output-v1` | `:40`；runner `diag-distiller-runner.ts:209` |
| ⑤ Canonical | `DiagDistillerOutputV1Schema`（`diag-distiller-output.ts:40-63`）：`valid/taskId/sourceRootCauseArtifactId/abstractedPrinciple(1..200)/rationale/groundedOnCorePrincipleIds[]/scope∈3/confidence`，`ambiguityNotes?` | 同左 |
| ⑦ Semantic validator | `DefaultDiagDistillerValidator`：对象守卫 → **taskId 宽容回注（任意 `diag_rootcause-/diag_distiller-/diag_router-` 同后缀即纠正）** → TypeBox → **注册表校验 `isCorePrincipleId`**；**无 `valid!==true` 检查** | `diag-distiller-output.ts:104-172`（前缀数组 :131；注册表 :159-165） |
| ⑥ Normalization | 只 `injectRunnerLineageIfAbsent(taskId)`；`sourceRootCauseArtifactId` 刻意不回注（由前置 artifact 提供）；validate 通过后 `checkLineageIntegrity` 不一致则抛 `output_invalid` | `diag-distiller-runner.ts:338-343`、`:352-361` |
| ⑧ Consumer | Stage C 输入 | `diag-router-runner.ts:200-214` |

**断缝**：②示例 `groundedOnCorePrincipleIds:["example"]` 落入注册表硬拒（实测）；①在 `coreGrounding=false` 时仍输出 "the provided axiom list" 且约束句保留 `above`（`:174` 三元）→ 幽灵引用；Stage B 无 `valid===true` 强制而 Stage A 有。

### 4.3 diag_router（Stage C）

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `ROUTING RULES`（5 kind）+ `OUTPUT REQUIREMENTS`：**「You only need to generate these fields」= violatedPrinciples / recommendations / summary**；「The following fields are auto-filled by the system … do NOT generate them: rootCause / evidence / confidence」 | `router-prompt-builder.ts:149-190`（auto-filled 段 :179-182） |
| ② 示例 | 机械合成（`isRecommendationArraySchema` 特判 → `generateDiagnosticianExample` 手写 5 kind 示例），**含** `valid/diagnosisId/rootCause/evidence/confidence` | `schema-prompt-adapter.ts:97-118,137-166`；注入点 `router-prompt-builder.ts:145` |
| ③ Tool schema | 动态派生 | `pi-ai-runtime-adapter.ts:1076` |
| ④ registry ref | `diagnostician-output-v1` | `:38`；runner `diag-router-runner.ts:259` |
| ⑤ Canonical | `DiagnosticianOutputV1Schema`（`diagnostician-output.ts:51-82`）：`valid/diagnosisId/summary/rootCause/violatedPrinciples[{principleId?,title?,rationale}] ∧ title REQUIRED-in-prompt / evidence/recommendations(≥1)/confidence`，`ambiguityNotes?`、`intentTension?`；**无 taskId** | 同左 |
| ⑦ Semantic validator | **双层**：`diag-router-runner.validateOutput` 先 `Value.Check(DiagnosticianOutputV1Schema)`（`:267-277`），再 `DefaultDiagnosticianValidator`（`runner/default-validator.ts:60-208`）：confidence 区间、summary/rootCause 非空、evidence 逐项、recommendations≥1、kind、description、kind=principle⇒`abstractedPrinciple` 非空且 ≤200、kind=rule⇒`triggerPattern`+`action`、TypeBox 兜底；**`principleId` 无注册表校验**；**无 `valid===true` 检查**；`sourceRefs` 回查仅 verbose | 同左 |
| ⑥ Normalization | `postFetchTransform` 覆盖 `rootCause`←Stage A、`evidence`←Stage A、`confidence`←Stage B、`intentTension`←Stage A（absent 则删）；`injectRunnerLineageIfAbsent(taskId)`；**不注入 `valid`/`diagnosisId`** | `diag-router-runner.ts:446-517`（:464/:476/:488/:507） |
| ⑧ Consumer | committer 落 `principle_candidates`（`abstractedPrinciple` 取 router 侧值）、admission gate、artifact summary → dreamer manifest | `store/commit/diagnostician-committer.ts:207`；`admission-gate.ts:25,61-75`；`artifact-summary.ts:199-227` |

**断缝**：①手写 `OUTPUT REQUIREMENTS` 说"只需生成 3 个字段"、并把另外 3 个列为系统已填，但 `valid`/`diagnosisId` **不在任一份手写清单里**（既非"你要生成"、也非"系统已填"），而同一 prompt 末尾 `${constraints}`（机器生成）又把两者标为 required → 严格按手写清单产出必被拒（实测 `/valid`,`/diagnosisId` Expected required property）；②机械合成示例反而含这两个字段，构成第三份冲突说法；① 的 `title` REQUIRED(3-8 words) 与 schema `Optional(String())`、validator 不查三处不一；详见 §6 NEW-8。

### 4.4 dreamer

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `PROTOCOL` 5 步（含「For each identified root cause, generate 1-5」）；`CONSTRAINTS`「candidates MUST have 1-5 items」「valid MUST be true」「sourcePrincipleId is OPTIONAL … Do NOT invent placeholder values」 | `dreamer-prompt-builder.ts:80-107` |
| ② 示例 | **硬编码**在 prompt 常量内（2 条 candidate 的完整 JSON 串） | `dreamer-prompt-builder.ts:90-91` |
| ③ Tool schema | L2 路径**第二份声明** `DreamerOutputV1Typebox`（`submit_output` 参数） | `tools/dreamer-output-typebox.ts:47-56`；`tools/agent-tool-contract.ts:196` |
| ④ registry ref | `dreamer-output-v1` | `:41`；runner `dreamer-runner.ts:242` |
| ⑤ Canonical | `DreamerOutputV1Schema`（`dreamer-output.ts:78-87`）：`valid/taskId/candidates[1..5]{candidateIndex,badDecision,betterDecision,rationale,confidence,riskLevel∈3,strategicPerspective}`、`sourcePrincipleId?`、`sourcePainId?`、`contextRefs[]`、`generatedAt`、`reason?`。注释声称「2-3 diverse candidates」 | `dreamer-output.ts:4,78-87` |
| ⑦ Semantic validator | `DefaultDreamerValidator`（`:117-178`）：`taskId` 相等、**`valid!==true` 硬拒**、candidates 1-5 + 逐字段、`contextRefs` isArray、`generatedAt` 非空；**不校验 `sourcePrincipleId`/`sourcePainId`/`contextRefs` 内容** | `dreamer-output.ts:126-170` |
| ⑥ Normalization | `super.postFetchTransform`（覆盖 `generatedAt`）+ `reconcileLineageEcho(taskId)` + `stripFabricatedCorePrincipleIds`（删除非注册表 `sourcePrincipleId`，**无遥测**） | `dreamer-runner.ts:374-385`；`core-principles/strip-fabricated-ids.ts:16-29` |
| ⑧ Consumer | philosopher 输入；artifact summary 只取 `candidates[0]` | `philosopher-prompt-builder.ts:142`；`artifact-summary.ts:236-245`；`context-manifests.ts:135-137` |

**断缝**：候选数量口径三处不一（①「每根因 1-5」/「candidates MUST have 1-5」（总数）/schema+validator 1-5/源码注释 2-3）；两份 schema（③ vs ⑤）顶层键集**实测相同**（含 `sourcePrincipleId/sourcePainId/reason`）；`stripFabricatedCorePrincipleIds` 删除字段属**静默**语义改写（`sourcePrincipleId → undefined`，无事件）。

### 4.5 philosopher

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `PROTOCOL` 5 步 + **硬编码 `OUTPUT FORMAT` 示例块** + `CONSTRAINTS`（含 `title <=100 chars`） | `philosopher-prompt-builder.ts:72-114` |
| ② 示例 | 硬编码 JSON（示意值 `<from input>` 占位） | `:88-100` |
| ③ Tool schema | 无独立声明（PiAi 动态派生 `record_philosopher_output_v1`） | `pi-ai-runtime-adapter.ts:1076` |
| ④ registry ref | `philosopher-output-v1` | `:42`；runner `philosopher-runner.ts:227` |
| ⑤ Canonical | `PhilosopherOutputV1Schema`（`:40-47`）：`taskId/sourceDreamerArtifactId/thesis/principleCandidate{title(仅 minLength1),rationale,scope,confidence}/risks[]/generatedAt`；**无 `valid`/`contextRefs`/`sourcePrincipleId`** | 同左 |
| ⑦ Semantic validator | `DefaultPhilosopherValidator`（`:69-110`）：taskId 相等、`sourceDreamerArtifactId` 非空、thesis 非空、principleCandidate 逐字段、risks 全 string、generatedAt 非空；**不查 title ≤100**；**无 `valid` 检查**（schema 无此字段） | 同左 |
| ⑥ Normalization | `super.postFetchTransform` + `reconcileLineageEcho(taskId + sourceDreamerArtifactId + sourceTrace.philosopherArtifactId)` | `philosopher-runner.ts:380-397` |
| ⑧ Consumer | scribe 输入；`succeedTask` 再校验 `sourceDreamerArtifactId === 权威值` | `scribe-prompt-builder.ts:78`；`philosopher-runner.ts:270-275` |

**断缝**：①承诺 `title ≤100` 无机器执行面；risks（含 axiom 冲突信号）无结构化消费者；②示例与 ① 的 probe 一致（实测通过 validator）。

### 4.6 scribe

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `OUTPUT FORMAT`（含 `intentContract` 五字段块）+ `INTENT CONTRACT (required — the alignment anchor…)` 详解 + `CONSTRAINTS`：「**intentContract is REQUIRED** and every one of its five fields MUST be a non-empty string」「intentContract itself MUST be a nested JSON OBJECT — never a JSON-encoded string」 | `scribe-prompt-builder.ts:43-118`（:101-102） |
| ② 示例 | 硬编码 `OUTPUT FORMAT` JSON 块（`:58-92`） | 同左 |
| ③ Tool schema | 无独立声明 | — |
| ④ registry ref | `scribe-output-v1` | `:43`；runner `scribe-runner.ts:242` |
| ⑤ Canonical | `ScribeOutputV1Schema`（`scribe-output.ts:62-76`）：`taskId/sourcePhilosopherArtifactId/principleDraft{title,statement,rationale,applicability[],antiPatterns[],confidence}/sourceTrace{dreamerArtifactId?,philosopherArtifactId}/risks[]/generatedAt` + **`intentContract: Type.Optional(Type.Unknown())`** | `scribe-output.ts:72` |
| ⑦ Semantic validator | `DefaultScribeValidator`（`:98-189`）：全字段 `Object.hasOwn` + 类型 + lineage 比对；`intentContract` 存在则 `isValidIntentContractV1`（五字段非空字符串），**缺失合法** | `scribe-output.ts:161-168`；`intent-contract.ts:59-70` |
| ⑥ Normalization | `super.postFetchTransform` + `reconcileLineageEcho(taskId + sourcePhilosopherArtifactId + sourceTrace.philosopherArtifactId)` + **`normalizeStringEncodedIntentContract`**（字符串键 → `JSON.parse` 回填对象；解析失败/非对象则原样留给 validator 拒） | `scribe-runner.ts:409-431`；`scribe-output.ts:192-206` |
| ⑧ Consumer | artificer（`extractIntentContract`）、evaluator（同上）、rollout principle-semantic | `artificer-runner.ts:890,922`；`evaluator-runner.ts:869,3258` |

**断缝**：①「REQUIRED」vs ⑤ `Optional(Type.Unknown())`（TypeBox 层不可见任何校验）vs ⑦ 只在 present 时校验 → **prompt 声明 REQUIRED 但 schema 完全不强制**（R-20 家族）。②示例（带五字段）实测通过 validator；缺 intentContract 的实测也通过。

### 4.7 artificer

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `ARTIFICER_PROTOCOL_INSTRUCTION`（含 `OUTPUT FORMAT` 硬编码示例、`CONSTRAINTS`、owner-intent 段、repair/adversarial/prior-rejection 段，其中 `:245` 自指 "the CONTEXT MODE block **above**"）+ `V2_CONTEXT_INSTRUCTION`（拼接在**其后**，`:357-358`） | `artificer-prompt-builder.ts:153-271`（:168-186 示例；:245-246；:261-271） |
| ② 示例 | 硬编码 `OUTPUT FORMAT`（无 `requiresContextVersion` / case 级 `ruleContext` / `evidenceRefs`） | `:168-186` |
| ③ Tool schema | **第二份声明** `ArtificerRuleOutputTypebox` = `submit_rulecode` 参数；另 `read_rulecode_spec` 返回的 `RULECODE_SPEC_TEXT` 是模型可见的第三方规范文本 | `tools/artificer-output-typebox.ts:63-81`；`tools/artificer-l2-tool-contract.ts:356`、`:91-200` |
| ④ registry ref | `artificer-rule-output-v2` | `:44`；runner `artificer-runner.ts:947` |
| ⑤ Canonical | `ArtificerRuleOutputSchema`（`artificer-output.ts:77-106`）：`taskId/sourceScribeArtifactId/implementationCode/goldenTraceCases[2..10]{caseId,kind,toolName,params,expectedDecision∈3,expectedProposedParams?,expectedApplicationMode?}/affectedTools[≥1]/implementationSummary/risks[]/sourceTrace{scribeArtifactId,philosopherArtifactId?,dreamerArtifactId?}/generatedAt/requiresContextVersion?=2/evidenceRefs?` | 同左 |
| ⑦ Semantic validator | **双门**：`DefaultArtificerValidator`（`:225-471`，含 v2 内容约束：`requiresContextVersion===2` ⇒ `ruleContext` 每 case 必填、`propose_correction` 禁、`evidenceRefs` 非空）+ runner 层 `validateV2OutputContract`（`:531-572`，`requiresContextVersion!==2` ⇒ error、BehaviorExamplePack 逐 case 保护字段 deep-equal、`evidenceRefs` 与 pack 逐位相等） | `artificer-runner.ts:953-980`（:955） |
| ⑥ Normalization | `super.postFetchTransform` + `reconcileLineageEcho(taskId + sourceScribeArtifactId + sourceTrace.scribeArtifactId)`（sourceScribe 为 null 时只校 taskId） | `artificer-runner.ts:1108-1130` |
| ⑧ Consumer | evaluator（codeReview/对抗重放）、evaluator rule assembly、rollout | `evaluator-runner.ts:1045-1070,2595-2665` |

**断缝（本轮实测）**：
- ② 示例（逐字还原）**能过 `DefaultArtificerValidator`**（前提是 `sourceScribeArtifactId` 合法且 `sourceTrace.scribeArtifactId` 与其相等，`:181-182` 的占位值在真实调用中会被 reconcile 覆盖），因为 v2 三项义务**不在** validator 强制集里 —— 强制来自 runner 层 `validateV2OutputContract`（`requiresContextVersion!==2` ⇒ 拒）。所以 R-02 的准确表述是「示例过不了 **runner 层 v2 契约**」，而非「过不了 validator」。
- ③ 与 ⑤ **顶层键集实测一致**（含 `evidenceRefs`，`afa95651` 已修）；**case 级仍不一致**：③ 有 `ruleContext: Optional(Unknown)`，⑤ 的 case 定义无 `ruleContext` 字段（`artificer-output.ts:81-95`）。实测：`@sinclair Value.Check` 对带 case 级 `ruleContext` 的 v2 输出返回 `true`（未声明 ⇒ 忽略），③ 也 `true` → 行为等价，但**声明不等价**；而 `typeboxToOpenAIJsonSchema(⑤)` 产物里 **case 无 `ruleContext`**（实测），意味着 provider 侧 schema 与 v2 契约不一致（§6 NEW-1）。
- ① 与 ③ 的禁模式集合双向不重合（§6 NEW-3 / R-19 B 面）。

### 4.8 evaluator

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `EVALUATOR_PROTOCOL_INSTRUCTION`：压缩保真判据、收敛契约（PRI-630）、工具目录权威、`CODE REVIEW` 三维、intentContract、对抗案例（3-5、Part A 通过才生成）、**硬编码 `COMPLETE EXAMPLE OUTPUT FOR A V2 ARTIFICER INPUT`**、`CONSTRAINTS`（含「needs_revision ⇒ requiredChanges ≥1」） | `evaluator-prompt-builder.ts:147-217`（示例 :196） |
| ② 示例 | 硬编码，含 `codeReview` + 3 条 `adversarialCases`，**无** `painCoverage`/`compressionFidelity`/`priorRequirementStatuses`/`requirementLedger` | `:196` |
| ③ Tool schema | 动态派生 | `pi-ai-runtime-adapter.ts:1076` |
| ④ registry ref | `evaluator-output-v1` | `:45`；runner `evaluator-runner.ts:882`（progressive 分支同 ref，`base-peer-runner.ts:1174`） |
| ⑤ Canonical | `EvaluatorOutputV1Schema`（`evaluator-output.ts:217-224`）**只含 V1 字段**：`taskId/sourceArtificerArtifactId/evaluation{decision,summary,score,strengths,concerns,requiredChanges,priorRequirementStatuses?,requirementLedger?}/sourceTrace/risks/generatedAt`。V2 字段（`codeReview`/`adversarialCases`/`adversarialResult`）与 Layer2 字段（`painCoverage`/`compressionFidelity`）**只在 TS 接口 `EvaluatorOutputV2` 与 `isEvaluatorOutputV2` 白名单里，不在任何 TypeBox schema 中** | `evaluator-output.ts:164-172,217-224,396-410` |
| ⑦ Semantic validator | `DefaultEvaluatorValidator`（`:433-638`）：evaluation 逐字段 + **`needs_revision`⇒requiredChanges≥1**（`:470-474`）+ priorRequirementStatuses/requirementLedger 结构 + 收敛覆盖（`convergence.expectedRequirements` 精确 echo，`:570-635`）+ `codeReview`/`adversarialCases`/`adversarialResult` 存在才校验；**不查 `adversarialCases` 数量**（实测 length=1 与 12 均通过，而 ① 说 3-5）；**不查 `aligned=false ⇒ decision≠approved`**（实测通过） | 同左 |
| ⑥ Normalization | `postFetchTransform`（`reconcileLineageEcho`）+ `succeedTask` 前**剥离 LLM 自报 `adversarialResult`**（runtime-owned），仅重放写回 | `evaluator-runner.ts:2434-2460`、`:943-949` |
| ⑧ Consumer | transition-decision 仲裁 / repair seed / rule assembly / rollout | `evaluator-runner.ts:1256-1290` |

**断缝**：⑤ 无 V2/Layer2 字段的 schema 权威 → provider 侧 `json_schema` 只约束 V1（实测转换后顶层仅 6 键、`additionalProperties:false`）→ **V2/Layer2 字段在 provider 侧被结构性禁止**（§6 NEW-1）；①「3-5 条」无校验；`painCoverage`/`compressionFidelity` 出现在 `language-directive.ts:150` 的语言清单里但**不在 prompt 任何位置**（prompt 内 0 命中，实测 grep）→ progressive 判据字段三层缺失（R-09）。

### 4.9 rollout_reviewer

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | **两套**：`code_chain`（`ROLLOUT_REVIEWER_PROTOCOL_INSTRUCTION`）与 `principle_semantic`（`ROLLOUT_REVIEWER_PRINCIPLE_SEMANTIC_INSTRUCTION`）。后者含 `REVIEW SCOPE`（5 项）、`DO NOT REVIEW`、`HARD RULES`（只判不写第二版原则文本）、`needs_revision: requiredChanges MUST name concrete semantic fixes` | `rollout-reviewer-prompt-builder.ts:47-84`、`:98-146` |
| ② 示例 | 两套各一（code_chain 含 `sourceEvaluatorArtifactId`；principle_semantic 含 `sourceScribeArtifactId` 并明示 `sourceTrace.evaluatorArtifactId/artificerArtifactId MUST be OMITTED`） | `:62`、`:126` |
| ③ Tool schema | 无独立声明 | — |
| ④ registry ref | `rollout-reviewer-output-v1` | `:46`；runner `rollout-reviewer-runner.ts:543` |
| ⑤ Canonical | `RolloutReviewerOutputV1Schema`（`:83-95`）：`taskId`、`sourceEvaluatorArtifactId?`、`sourceScribeArtifactId?`（**两者皆 Optional**，per-mode 必填由 validator 承担）、`review{decision∈3,summary,confidence,requiredChanges[],rolloutRisks[],safetyChecks[]}`、`sourceTrace{全 Optional}`、`risks[]`、`generatedAt` | 同左 |
| ⑦ Semantic validator | `DefaultRolloutReviewerValidator`（`:120-224`，mode-aware）：taskId；按 mode 校验 `sourceScribeArtifactId`/`sourceEvaluatorArtifactId` 非空 + 与 `expectedSourceArtifactId` 相等；`review` 逐字段（**requiredChanges 仅 isArray + 元素 string**）；`sourceTrace` 按 mode；跨字段一致；**无 `needs_revision ⇒ requiredChanges≥1`** | 同左（:165-166） |
| ⑥ Normalization | `reconcileLineageEcho`（mode-aware：principle_semantic 校 `sourceScribeArtifactId`+`sourceTrace.scribeArtifactId`；code_chain 校 evaluator 对） | `rollout-reviewer-runner.ts:322-325,384-400` |
| ⑧ Consumer | `applyDecisionEffects` → `approve_rollout` dispatch / `needs_revision` revision routing / `reject` terminal | `rollout-reviewer-runner.ts:1242-1288`；`:952-1030` |

**断缝（R-13 复审重点）**：
- ① 两套 prompt 都写「requiredChanges … (can be empty)」（`:70`、`:134`），且 `needs_revision: requiredChanges MUST name concrete semantic fixes`（`:121`）只出现在 **principle_semantic** 一套；code_chain 无此句。validator **两 mode 均不校验**（实测 `needs_revision` + `requiredChanges: []` 返回 `valid:true`）。
- 下游后果（实测链）：`handleRevisionRouting` → `recordRolloutRevisionRouting`（status='pending'）→ 写 `pi_metadata.rolloutRevisionPayload.requiredChanges=[]` → **`parsePITaskMetadata` 对该形状返回 `null`**（`pitask-metadata.ts:832` 要求非空）→ `hydratePITaskRecord` 返回 null → 整块 metadata 不可读（`revisionCount`/`channel`/`completionIntent` 等一起变 undefined）。
- Prompt ① 与 ⑥ 的关系：②③④⑤⑥⑦ 一致（实测两示例各按自己 mode 通过），**唯一实质失衡在 ⑦ 比 ① 弱**（缺 needs_revision 非空不变量）。
- `review.confidence` 在 code_chain 模式下参与 `decideAutoPromotion`（§6 NEW-5）。

### 4.10 signal-classification

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `buildLlmPrompt`：中文说明 + **硬编码格式行** `{"is_feedback": bool, "type": "correction"\|"empathy"\|"none", "confidence": 0-1, "reason": "一句话理由"}` + 三值定义 | `signal-collector/llm-stage.ts:14-24` |
| ② 示例 | 即 ① 的格式行 | 同左 |
| ③ Tool schema | 动态派生（`record_signal_classification_output_v1`） | `pi-ai-runtime-adapter.ts:1076` |
| ④ registry ref | `signal-classification-output-v1` | `:49`；调用 `openclaw-plugin/src/core/signal-collector-host.ts:639` |
| ⑤ Canonical | `SignalClassificationOutputV1Schema`（`signal-collector/types.ts:115-120`）：`is_feedback/type∈3/confidence[0,1]/reason`（字符串无 minLength） | 同左 |
| ⑦ Semantic validator | `validateLlmClassification`（`:98-107`）与 schema 逐字段等价；消费侧 `resolveLlmClassificationPayload` 三路径（structured / legacy_string / legacy_envelope / invalid） | `llm-stage.ts:73-96` |
| ⑥ Normalization | 无对象级 normalizer；**compatibility fallback**：`string` / `{output:string}` 会再 `JSON.parse` 一次（实测非异常路径） | `llm-stage.ts:79-94` |
| ⑧ Consumer | `mapLlmResultToOutput` → `isSignal/strength/detectionSource` | `signal-collector.ts:66-96` |

**结论**：五层**一致**（①字段名与 ⑤ snake_case 逐字对应；实测格式行通过 schema）。唯一漂移风险是 ⑥ 的 legacy 分支（非本轮断缝，属兼容面）。

### 4.11 correction-observer

| 层 | 事实 | 锚点 |
|---|---|---|
| ① Prompt 指令 | `SYSTEM_PROMPT='You are a correction keyword optimizer.'`；消息内含 `Rules:` 段（ADD/UPDATE/REMOVE/FP、`reasoning` max 100 chars、`Weight range: 0.1-0.9`）+ **硬编码返回形状行** | `observer/correction-observer.ts:61,95-127` |
| ② 示例 | 即 ① 的返回形状行（无完整 JSON 示例） | `:125` |
| ③ Tool schema | 无 | — |
| ④ registry ref | `correction-observer-output-v1` | `:48`；调用 `correction-observer.ts:142` |
| ⑤ Canonical | `CorrectionObserverOutputV1Schema`（`:30-41`）：`updated`、`updates?{action∈3,weight?,falsePositiveRate?,reasoning}`、`fpTerms?`、`fpAnalysisStatus?`、`summary` | 同左 |
| ⑦ Semantic validator | **不是**独立 validator 类，而是 `run()` 内手写逐字段检查（`:180-227`）：`updated`/`summary` 类型、`updates` 每项 action/reasoning 类型、`fpTerms` 元素、`fpAnalysisStatus` 枚举。**`weight` 数值/区间不校验**（① 声明 0.1-0.9，应用侧 clamp）；**`reasoning` 长度不校验**（① 声明 max 100） | 同左 |
| ⑥ Normalization | 无；`return payload as CorrectionObserverOutputV1`（`as` 双跳，`:228`） | 同左 |
| ⑧ Consumer | `KeywordOptimizationService.applyResult` → `correction_keywords.json`；`fpTerms` → `recordFalsePositive` | `keyword-optimization-service.ts:31-99` |

**断缝**：①的 `weight` 区间、`reasoning` 长度两条约束无执行面；⑤注册在 registry 里但生产校验用的是手写分支（**schema 与 validator 不是同一份实现**）；`as` 收尾与 `validate(unknown)` 家族不一致。

---

## 5. Confirmed / Fixed / Drifted（对任务书 §5 carry-forward 的裁决）

判据：**每条均回源 cdec05d4 重新核对**；带「实测」的证据来自 §1.1 的行为级实证。

| # | #1707/#1710 原判 | 本轮判定 | 证据（current main @ cdec05d4） |
|---|---|---|---|
| **R-02** | P2：artificer `OUTPUT FORMAT` 示例违反 v2 硬契约；"CONTEXT MODE block above" 方位自指错误 | **CONFIRMED** | ① 示例 `artificer-prompt-builder.ts:168-186` 逐字无 `requiresContextVersion`/case 级 `ruleContext`/`evidenceRefs`；强制点 `artificer-runner.ts:537`（`requiresContextVersion!==2` ⇒ error）与 `artificer-output.ts:305-311,386-394`。② 方位：`:245` 写 "the CONTEXT MODE block **above**"，而 `${V2_CONTEXT_INSTRUCTION}` 拼接在 `:357-358`（位于该句之后）。**归因精度修正**：实测逐字还原的示例在"id 合法 + 两处 scribeArtifactId 相等"时**通过 `DefaultArtificerValidator`**（v2 义务不在该 validator 强制集），真正拦它的是 runner 层 `validateV2OutputContract` —— 即「示例过不了**自己 stage 的 v2 输出契约**」成立，而「过不了 validator」不精确。第二条（方位）与历史一致 |
| **R-03** | P2：#1710 判 FIXED（`afa95651` 修 typebox 缺 `evidenceRefs`） | **FIXED**（复核通过）**+ 新遗留项** | 顶层键集实测**完全一致**（`ArtificerRuleOutputSchema.properties` 与 `ArtificerRuleOutputTypebox.properties` 均为 11 键含 `evidenceRefs`/`requiresContextVersion`）；`artificer-output-typebox.test.ts:50-58` 有键集相等 + `evidenceRefs` 哨兵断言。**但 case 级仍漂移**：typebox 有 `ruleContext: Optional(Unknown)`（`artificer-output-typebox.ts:43`），@sinclair case 定义**无**该字段（`artificer-output.ts:81-95`）；行为等价（两侧实测均接受带 case `ruleContext` 的 v2 输出），**声明不等价**，且转换到 provider JSON Schema 后 `ruleContext` 消失（见 NEW-1）。故 R-03 的**原表述**（"field-for-field 一致为假"）现已**不成立**，但「field-for-field」注释仍未 100% 兑现 |
| **R-09** | P2：`progressive_evaluator` 判据字段不在 evaluator 输出 schema/prompt → 恒双倍 LLM 调用 | **CONFIRMED** | 判据读取点 `progressive-evaluator.ts:166-178` 读 `implementationFidelity.score`；而 `implementationFidelity` 在 `evaluator-output.ts` **0 命中**、在 `evaluator-prompt-builder.ts` **0 命中**（实测 grep 计数 0）。故 `undetermined` 恒含 `implementationFidelity`（实测：`stage1Output` 非对象时 undetermined 含 `output_not_object`；对象但无该字段时含 `implementationFidelity`）→ `d1.undetermined.length !== 0` 恒为真 → 短路不可达 → 每次评估 Stage 2 必跑。`pipeline.evaluator-runner.ts:603-613` 为该逻辑的生产接线。flag 默认 `enabled:false`（`feature-flag-contract.ts:357`） |
| **R-11** | P2：EP-07 不变量清单不含 `abstractedPrinciple` | **CONFIRMED** | `diag-router-runner.ts:446-517` 的 `postFetchTransform` 覆盖字段枚举实测仅 `rootCause`(:464)/`evidence`(:476)/`confidence`(:488)/`intentTension`(:507) + `taskId`(:448)，**无 `abstractedPrinciple`**；写入侧 `diagnostician-committer.ts:207` 取 `rec.abstractedPrinciple`（router LLM 侧值）。即 EP-07 主张的"上游权威值覆盖"在 `abstractedPrinciple` 一列缺席，入库的是 router 的转述版 |
| **R-13** | P2 待复审：#1698（`285d1c81`）已重写 rolloutReviewer——原「needs_revision 无 requiredChanges 硬约束 + 自报 confidence 参与免审晋级」现为何状态 | **PARTIAL** | **requiredChanges 面**：两 mode 的 validator 仍只 `isArray + 元素 string`（`rollout-reviewer-output.ts:165-166`），实测 `needs_revision` + `[]` 返回 `valid:true`；与 evaluator 端 `evaluator-output.ts:470-474` 的不变量**不对称**。**但 #1698 显著改变了后果结构**：① 新增 principle_semantic 模式（`resolveRolloutReviewMode` `rollout-reviewer-runner.ts:168-179`），② prompt 该 mode 写「requiredChanges MUST name concrete semantic fixes」(`:121`)，③ needs_revision 出边改为 revision routing 而非 approval（`applyDecisionEffects:1276-1284`），④ budget/iteration 由 completion intent 锁定。**新发现的下游硬后果**：空 `requiredChanges` 的 pending 载荷会让 `parsePITaskMetadata` 返回 `null`（`pitask-metadata.ts:832` 实测），进而 `hydratePITaskRecord` 返 null → 该任务 metadata 整体不可读（`revisionCount`/`channel`/`completionIntent` 一并丢失）——这是 #1707 未记录的**结构性后果**，见 NEW-2。**confidence 面**：`decideAutoPromotion` 仍在（见 NEW-5） |
| **R-16** | P3：dreamer 候选数量口径三处不一 | **CONFIRMED** | ①`dreamer-prompt-builder.ts:84`「For each identified root cause, generate **1-5**」+ `:97`「candidates MUST have **1-5**」（总数）；⑤ schema `dreamer-output.ts:81` `minItems:1,maxItems:5`；⑦ `:141` 同；源码注释 `:4`「**2-3** diverse candidate corrections」。① 的「每根因 1-5」在多根因输入下与 ⑤ 的总数上限冲突 |
| **R-18** | P3：rootcause prompt 承诺「evidence 空则 confidence<0.3」无执行面 | **CONFIRMED** | 承诺 `rootcause-prompt-builder.ts:252-253`；`DefaultDiagRootCauseValidator` 全文无该规则（`:266-401`）；admission gate 阈值 `admission-gate.ts:25` = 0.5 且只查 `evidenceCount`/`inputEvidenceCount`（`:52-77`），不查该承诺 |
| **R-19（B 面）** | P1 的 B 面：只记事实（RuleCode 相关 prompt 教了模型什么 / 是否教过沙箱逃逸 / 声明了什么安全边界 / 模型可见约束 vs validator 实际约束） | **CONFIRMED（事实登记）** | 见 §6 NEW-3：三份 vocabulary（protocol instruction / spec text / validator）**互不相等**，且**没有任何一处**声明"沙箱逃逸"是禁止意图或声明安全边界为契约；validator 的 28 个模式里有 5 个（`WeakRef`/`Atomics`/`SharedArrayBuffer`/`FinalizationRegistry`/`import.meta`）**从未出现在任何模型可见文本中**；反之 `Date.now` 只在 protocol instruction 出现、validator **无对应模式**（实测 `checkForbiddenPatterns` 对 `Date.now()` 返回 `[]`） |

### 5.1 本轮新增的「已无断裂」确认（防止误读）

- 三个诊断 stage 的 `outputSchemaRef` → registry 键 → canonical schema 三者**逐一对应且无错配**（实测常量身份一致）。
- dreamer 两份 schema（tool vs canonical）**顶层与 candidate 子结构键集均相同**（实测 `toEqual`）。
- artificer 两份 schema **顶层键集相同**（R-03 复核）。
- 所有 11 个 stage 的 runner 都在 `validateOutput`/`validator.validate` 处做 **`unknown` 入参 + 运行时守卫**（除 rollout 的 `fetchAndParseOutput` 收尾 `as`，见 §7）。
- signal-classification 五层**完全一致**。

---

## 6. NEW Findings

每条格式：ID / Severity / Claim / Evidence / Why it matters / Affected stage / Current protection。

### NEW-1 【P2】provider 侧 JSON Schema 缺 V2 / Layer2 / case-级字段（「第三型 canonical 表达」的覆盖缺口）

- **Claim**：`typeboxToOpenAIJsonSchema()`（`schema-json-converter.ts:81-90`）生成的 schema 是该 stage 的**第三型 canonical 表达**，但它只能反映 registry 里那一份 TypeBox schema 的字段。对 evaluator 而言那份 schema **只有 V1 字段**，故转换产物在**字段层面**就缺 `codeReview` / `adversarialCases` / `painCoverage` / `compressionFidelity` —— 而这四个字段正是 prompt（`CODE REVIEW` 段、`ADVERSARIAL CASES` 段）明文要求模型生成的。
- **Evidence（实测，字段层面）**：`EvaluatorOutputV1Schema` = `evaluator-output.ts:217-224`；V2/Layer2 字段仅存在于 TS 接口 `EvaluatorOutputV2`（`:164-172`）与 `isEvaluatorOutputV2` 白名单（`:396-410`），**全仓无 `EvaluatorOutputV2Schema`**（rg 零命中）。实测 `typeboxToOpenAIJsonSchema(EvaluatorOutputV1Schema)` 顶层键 = `taskId,sourceArtificerArtifactId,evaluation,sourceTrace,risks,generatedAt`（6 键），而反面对照：**canonical schema 本身接受** 带 `codeReview`+`adversarialCases` 的输出（`Value.Check(EvaluatorOutputV1Schema, v2out) === true`）。同一缺口在 artificer 上表现为 **case 级**：转换产物的 `goldenTraceCases.items.properties` **无 `ruleContext`**（实测），而 v2 契约要求每个 case 必带（`artificer-output.ts:305-311`）。
- **Evidence（静态，拒绝面）**：转换器给每个 `type === 'object'` 节点写 `additionalProperties:false`（`schema-json-converter.ts:68-69`），注入点 `pi-ai-runtime-adapter.ts:1172-1179`。**但该拒绝是否真的发生未实测**：转换器头部明确「不强制 `strict: true`」（`schema-json-converter.ts:16-17`），故是否由 provider 侧强制取决于端点。本文件只登记"字段缺失 + 声明禁止额外属性"这两个事实，不断言必失败。
- **Why it matters**：走 `json_mode` 分支时，模型被 prompt 要求写、却被同一份约束"未声明为允许"，两端对同一输出的字段集合预期不一致。用于 harness 校验的 `Value.Check` 走的是 **canonical** schema（tool_call 分支的工具参数也直接引用 canonical schema，实测接受 V2 输出），所以本地测试**结构上无法**暴露这条缺口。
- **附注（与 NEW-7 同根）**：转换产物中 `params: Record(String, Unknown())` 被表达为 `{type:'object',patternProperties:{'^(.*)$':{}},additionalProperties:false}`，其空子 schema 使 `Value.Check(转换产物, …)` **抛 `ValueCheckUnknownTypeError`**（实测）——即该产物**不可被 PD 自身运行时校验**，只能交给 provider。
- **Affected stage**：evaluator（顶层 4 字段）、artificer（case 级 `ruleContext`）。
- **Current protection**：无。`schema-json-converter.test.ts` 只用 philosopher/scribe 断言递归 `additionalProperties:false` 与 `required` 一致，**不覆盖**「转换产物是否涵盖 prompt 要求的全部字段」。

### NEW-2 【P2】空 `requiredChanges` 的 revision 载荷使整个 PI metadata 不可读（fail-closed 副作用）

- **Claim**：rollout 侧允许 `needs_revision` + `requiredChanges: []`（NEW-4/§5 R-13），而该形状一旦以 `status:'pending'` 写入 `pi_metadata.rolloutRevisionPayload`，`parsePITaskMetadata` 会因 `requiredChanges.length === 0` 返回 `null`；`hydratePITaskRecord` 随即返回 `null`，导致**该任务的全部 PI metadata** 视为不可读，而不是仅丢弃这一个字段。
- **Evidence**：`pitask-metadata.ts:832` `if (!Array.isArray(r.requiredChanges) || r.requiredChanges.length === 0) return null;`（位于 `parsePITaskMetadata` 内，非子解析函数）；`:955-967` `hydratePITaskRecord` 中 `const meta = parsePITaskMetadata(...); if (!meta) return null;`。写入侧 `rollout-reviewer-runner.ts:970-977`（status:'pending'）；零校验前置为 `rollout-reviewer-output.ts:165-166`。实测：构造 `{"pi_metadata":{...,"rolloutRevisionPayload":{"requiredChanges":[],...}}}` → `parsePITaskMetadata` 返回 `null`；非空则 `ok`。
- **Why it matters**：fail-closed 的**粒度错误**——一个可选字段的空数组判定，惩罚面是整块 authority 记录。受影响读取点包括 `buildContext`（rollout 自己的 `dependencyTaskIds`/`channel`）、`recordCompletionOrThrow`（`revisionEpoch`）、`maybeResumePendingIntent`（`completionIntent` → crash-resume 语义）、`resolveReviewModeForTask`（`pipelineMode`）——即**同一条 metadata 上的 governance 恢复能力被一并掐断**，而失败的只有"修订清单为空"这一条内容缺陷。
- **Affected stage**：rollout_reviewer（写入侧）→ 所有读取 `pi_metadata` 的下游。
- **Current protection**：无覆盖该组合的测试。`crash-liveness-regressions.test.ts` 与 `rollout-reviewer-verdict-paths.test.ts` 的 revision payload 均带非空 `requiredChanges`。

### NEW-3 【P2】RuleCode 三份 vocabulary 互不相等（R-19 B 面的事实登记）

- **Claim**：模型可见的 RuleCode 约束分散在三处，三处集合**两两不等**，且**没有任何一处**把"沙箱/运行时不变量"作为契约声明给模型。
- **Evidence**（本轮实测，`checkForbiddenPatterns` 对每个模式各造一个最小探针）：
  - `rule-code-validator.ts:27-65` 静态门共 **28** 个模式（含 `export`/`async`/`await`/`process`/`globalThis`/`global`/`Reflect`/`Proxy`/`constructor`/`Buffer`/`setImmediate`/`queueMicrotask`/`XMLHttpRequest`/`WeakRef`/`FinalizationRegistry`/`SharedArrayBuffer`/`Atomics`/`import.meta`/bracket-access）。
  - `artificer-l2-tool-contract.ts:114-119` 的 `RULECODE_SPEC_TEXT` 名字清单只有 **22** 项；28 − 22 = 6 的差额 = **未列** `WeakRef` / `FinalizationRegistry` / `SharedArrayBuffer` / `Atomics` / `import.meta`（5 项）+ `bracket access to forbidden global`（1 项，仅以散文 `:119` 提及、无枚举）。
  - `artificer-prompt-builder.ts:213` 的 `CONSTRAINTS` 只列 `imports, require, eval, Function, I/O, network, timers, Date.now, or randomness`（≈9 项，且未出现 `export`/`async`/`await`/`process`/`globalThis`/`constructor`/`crypto`）。
  - **反向**：`Date.now` 在 protocol instruction 明令禁止，而静态门**无该模式**（实测 `checkForbiddenPatterns("...Date.now()...") === []`）；`RULECODE_SPEC_TEXT` 全文也无 `Date.now`（实测正则 false）。
  - **逃逸面**：静态门做的是**文本正则匹配**（PRI-668 对注释/字符串字面量做 masking），不做归一化。实测：`'con'+'structor'`、`` `con${''}structor` ``、`obj['constructor']` **均 0 命中**；而 spec 自己举例的 `globalThis["require"]` **命中**（bracket-access 备选集含 `require`，但**不含 `constructor`**）。历史 R-19/C 轮已登记同一机制；本轮确认 current main 未变。
  - **安全边界文本**：`RULECODE_SPEC_TEXT` 与 protocol instruction 均只描述"能做什么/不能调用什么"，**全文无** sandbox-escape、trust boundary、或"禁止尝试逃逸"一类声明（grep sandbox/security/escape 仅命中工具描述里的 "Sandbox replay" 功能性措辞）。
- **Why it matters**：模型被要求遵守的集合 ≠ 机器执行的集合，且**双方都不知道缺哪一部分**。`matched:false ⇒ decision:'allow'` 这条硬不变量只在 spec 文本与 validator 里，protocol instruction 的 GOOD/BAD 示例未提（`:200-203`）。
- **Affected stage**：artificer（生成侧）。
- **Current protection**：`artificer-l2-tool-contract.test.ts:137-150` 断言 spec 文本含若干关键词，**不断言** spec 文本的禁止清单与 `checkForbiddenPatterns` 的标签集合相等（无 parity 测试）。

### NEW-4 【P2】rollout_reviewer 的 `needs_revision ⇒ requiredChanges≥1` 在 prompt 与 validator 两层都缺席（evaluator 侧已有）

- **Claim**：evaluator 端该不变量是**机器强制**的（`output_invalid`），rollout 端**prompt 明示可为空 + validator 不查**——同一 pipeline 的两个评审代理在同一语义上采用相反口径。
- **Evidence**：evaluator 强制 `evaluator-output.ts:470-474`（实测 `needs_revision` + `[]` → `valid:false`）；rollout 的 prompt `rollout-reviewer-prompt-builder.ts:70,134`「requiredChanges MUST be an array of strings (**can be empty**)」、validator `rollout-reviewer-output.ts:165-166` 仅 isArray/元素类型（实测 `valid:true`）；principle_semantic prompt 的 `:121`「needs_revision: requiredChanges MUST name concrete semantic fixes」**无机器对应**。
- **Why it matters**：`needs_revision` 的出边是 revision routing（`rollout-reviewer-runner.ts:1276-1284`），一个没有"必须改什么"的修订轮会带着空清单 reopen 上游；叠加 NEW-2 后连 metadata 都读不回来。
- **Affected stage**：rollout_reviewer → scribe/artificer（修订目标）。
- **Current protection**：无（`rollout-reviewer-verdict-paths.test.ts` 未覆盖空清单 needs_revision）。

### NEW-5 【P2】`decideAutoPromotion` 只在 `skill` 通道为真，而 `skill` 无 writer —— 免审晋级决策可达、效果不可达

- **Claim**：`decideAutoPromotion(channel, confidence)` 的通道白名单只有 `['skill']`，而调用点只在**需要审批**（`require_approval` 或非低风险通道）时才查询它。因此：
  - 对 rollout 链实际使用的 `prompt` / `defer_archive`（= `LOW_RISK_CHANNELS`），`needsApproval === false` → **直接激活，`confidence` 完全不被查询**；
  - 对 `skill`，`needsApproval === true` 且 `decideAutoPromotion === true` → 进入 `activateArtifact`，但**无任何 writer 注册 `skill`** → 返回 `refused: no_writer_for_channel_skill`；
  - 对 `code_tool_hook`，非低风险 → `needsApproval === true`，但 `decideAutoPromotion === false`（不在白名单）→ 入审批。
- **Evidence（实测）**：`activation-types.ts:11,15,17`；调用链 `activation-dispatcher.ts:265-270`；writer 注册表 `activation-dispatcher.ts:351-354`（无 writer ⇒ `no_writer_for_channel_<ch>`）；生产 writer 集合 `internalization-consumer-governance.ts:108-118` 与 `pd-cli/src/commands/runtime-activation.ts:320-341,1376-1395` 均只注册 `PromptWriter`(`prompt`) / `RuleHostWriter`(`code_tool_hook`) / `DeferArchiveWriter`(`defer_archive`)（`:34`、`:62`、`:189`）。实测矩阵（`confidence=0.99`）：

  | channel | lowRisk | needsApproval | decideAutoPromotion(0.99) | 实测 dispatch 结果 |
  |---|---|---|---|---|
  | prompt | true | false | false | `activated`（与 confidence 无关） |
  | defer_archive | true | false | false | `activated`（与 confidence 无关） |
  | skill | false | true | **true** | `refused: no_writer_for_channel_skill` |
  | code_tool_hook | false | true | false | 入审批 / 无 approvalQueueStore 时 `requires_approval` |

- **Why it matters**：R-13 原文「自报 confidence 无锚却参与免审晋级」在 current main 上**代码成立但治理后果不可达**——唯一能返回 `true` 的通道同时是不可写入的通道。真实风险面因此从"免审晋级绕过 Owner"转移到三处事实：（a）`skill` 通道既被标为"自动可晋级"又**无 writer**（`implementation-candidate → skill` 固定映射见 `internalization-route`/`ROUTE_CHANNEL_MAP`，而 `MVP_ENABLED_CHANNELS` 不含 `skill`，`intake-to-internalization-bridge.ts:108-112,122-128`）；（b）`prompt`/`defer_archive` 的低风险自动激活**不经任何 confidence 门槛**；（c）`confidence` 仍被写入审批上下文文案（`activation-dispatcher.ts:107-134`），在 `code_tool_hook` 的 Owner 审批视图里以"置信度 xx%"呈现，而它不参与该通道的放行判定。
- **Affected stage**：activation 治理（rollout 出口）。
- **Current protection**：`activation-types`/`approval-queue` 有单测；**无**把「writer 集合 × 可自动晋级通道集合 × 低风险通道集合」三者交叉断言的一致性测试。

### NEW-6 【P3】`DefaultSchemaPromptAdapter.generateExample` 的 `Value.Cast` 静默兜底（#1710 NEW-6 的复核 + 补强）

- **Claim**：示例生成器结尾 `Value.Check(schema, example) ? example : Value.Cast(schema, example)` 使"合成器产出非法示例"永不报错；`Value.Cast` 只对**结构型**约束回填（literal union/`minItems` 等），对普通 `string` 的语义约束（类目前缀、注册表 ID）不回填。
- **Evidence**：`schema-prompt-adapter.ts:185`；实测：rootcause 示例 = `{"rootCause":"example","rootCauseCategory":"People","taskId":"example",...}` 且 `Value.Check(DiagRootCauseOutputV1Schema, 示例) === true`；把该示例交给 `DefaultDiagRootCauseValidator`（taskId 用生产前缀）→ `valid:false`，错误含 `rootCause must start with "People: "`。distiller 同理：示例 `groundedOnCorePrincipleIds:["example"]` → `valid:false`，错误 `Fabricated axiom ID example not in core principle registry`。#1710 的 `Value.Cast` 归因**确认**。
- **Why it matters**：这是"示例违反自身规则"这一家族的**根因机制**，且是**静默**的（rc-9 精神）。合成器与 validator 之间没有语义对齐面，任何新增的语义约束都会自动生产出违反它的示例。
- **Affected stage**：diag_rootcause、diag_distiller、diag_router（三个 stage 共用该合成器）。
- **Current protection**：`schema-prompt-adapter.test.ts` 只断言示例通过 `Value.Check`（技术层），**无任何**"示例通过该 stage 的语义 validator"的断言（历史 VERIFICATION-B 已指出，本轮确认现状未变）。

### NEW-7 【P3】`typeboxToOpenAIJsonSchema` 对无 `type` 顶层节点**原样改写调用方对象**

- **Claim**：转换器对顶层节点做 `Object.hasOwn(schema,'type') ? deepClone : 原样`（`schema-json-converter.ts:81-84`），无 `type` 的顶层（如 `anyOf`/`oneOf` 根）走 `convertNode(入参)` → 递归写入 `additionalProperties:false`，**污染调用方持有的 schema 对象**。同时 `Type.Record(String, Unknown())` 会被转成 `{type:'object', patternProperties:{'^(.*)$':{}}, additionalProperties:false}`，而该产物若交给 `@sinclair Value.Check` 会**抛 `ValueCheckUnknownTypeError`**（空子 schema `{}` 无 type）。
- **Evidence**：实测 ① 传 `{anyOf:[...Type.Object(...)]}` 后**入参对象被改写**（原 inner 获得 `additionalProperties:false`），传带 `type` 的顶层则不改（字节相同）。② 实测 `typeboxToOpenAIJsonSchema(ArtificerRuleOutputSchema)` 的 `params` 节点 = `{"type":"object","patternProperties":{"^(.*)$":{}},"additionalProperties":false}`；`Value.Check(该产物, ...)` 抛 `ValueCheckUnknownTypeError: Unknown type`。
- **Why it matters**：**当前无活跃消费者触发**（转换产物只进 provider payload 与 repair prompt；运行时校验用的是 canonical schema），故定 P3。但两点是潜在陷阱：（a）转换器会改写入参，任何将来"转换后再用原 schema"的代码都会读到被改过的对象（P1 类 invariant：canonical schema 不应被 prompt 侧副作用修改）；（b）`params` 在 provider schema 里被表达为"额外属性禁止 + 一个空的 pattern 兜底"，与 `Type.Record(String, Unknown())` 的语义（任意键、任意值）不一致，对支持 `patternProperties` 的 provider 不等于"任意键"，对不支持 strict 子集的 provider 则可能是非法 schema。
- **Affected stage**：artificer、evaluator（两者 schema 都含 `params: Record(String, Unknown())`），以及任何用该转换器的 stage。
- **Current protection**：`schema-json-converter.test.ts` 覆盖 philosopher/scribe 的递归与 required，**无**"入参不被修改"断言、**无** record/unknown 字段的覆盖。

### NEW-8 【P2】diag_router 的 prompt 内部同时存在三份互相冲突的字段清单

- **Claim**：同一份 router prompt（一个字符串）内有三处关于"模型该输出哪些字段"的陈述，三者互不一致；其中手写的那一份排除了两个 canonical 必填字段，而**机器生成**的 constraints 块又把它们标为 required。
- **Evidence（实测：`new RouterPromptBuilder().buildRouterInstruction({})` 的实参文本）**：
  ```
  OUTPUT REQUIREMENTS (hand-written, :169-182)
    "Your output MUST match DiagnosticianOutputV1Schema. You only need to generate these fields:"
      violatedPrinciples / recommendations / summary
    "The following fields are auto-filled by the system … — do NOT generate them:"
      rootCause / evidence / confidence
  …COMPLETE EXAMPLE OUTPUT (机械合成, :189-190)…
  CONSTRAINTS: (:194-197)
    ${constraints}   ← generateConstraints(schema) 的输出（实测，位置在 example 之后）
      "valid: boolean (required)"
      "diagnosisId: string {minLength: 1} (required)"
  ```
  实测：`valid: boolean (required)` 与 `diagnosisId: string {minLength: 1} (required)` 都**出现在同一 prompt 内**（索引 3792，位于 `CONSTRAINTS:` 之后），而手写清单在索引 1138 明确把生成字段限定为 3 项、并把 3 个字段列为系统已填。
- **对 §4.3 六类断缝的归类修正**：这**不是**第 5 类（"validator 要求 prompt 从未教过的字段"）——字段确实被教了，只是教在另一处；它命中的是**第 1 类**（Prompt 声明 REQUIRED 与 schema 口径不一致）与**第 3 类**（同一 prompt 内两份字段清单不等）。实测构造：严格按手写清单产出 + runner 注入 rootCause/evidence/confidence → `Value.Check=false`，errors 为 `/valid`、`/diagnosisId` Expected required property。
- **Why it matters**：与 R-02 同族（artificer 示例 vs CONTEXT MODE）但在 Stage C 更隐蔽——冲突发生在**同一字符串内部**且相距 2600+ 字符，弱模型很可能只遵循更显眼的 `OUTPUT REQUIREMENTS` 手写清单。示例（机械合成）反而含这两个字段，构成第三份说法。
- **Affected stage**：diag_router。
- **Current protection**：`router-prompt-builder.test.ts`（全文 64 行）只断言指令含若干关键词；**无**"手写字段清单与 schema 必填集/生成 constraints 集三向一致"的断言。

### NEW-9 【P3】correction-observer 的「schema 在 registry、校验在手写分支」双实现

- **Claim**：`CorrectionObserverOutputV1Schema` 注册在 registry（`correction-observer.ts:48` 关联的 `:30-41`），但 `run()` 生产校验用的是手写逐字段分支（`:180-227`），且 `as CorrectionObserverOutputV1` 收尾。prompt 声明的两条数值/长度约束（`weight` 0.1-0.9、`reasoning` ≤100）**两处都不校验**。
- **Evidence**：`:180-227`（无 weight 数值检查、无 reasoning 长度检查）、`:228`（`as`）、prompt `:122`（`Weight range: 0.1-0.9`）与 `:121`（`max 100 chars`）；应用侧才 clamp（`keyword-optimization-service.ts:53-55` + `correction-cue-learner.ts:200`）。
- **Why it matters**：registry 存在 ≠ schema 被执行。"注册了 schema 所以就受约束"是错读；此类 stage 的 schema 只对 adapter 的结构化路径生效。
- **Affected stage**：correction-observer。
- **Current protection**：无。

---

## 7. Protection Gaps（现有 test/guard 对 prompt-schema parity 的保护面）

| # | 需要保护的不变量 | 现状 | 证据 |
|---|---|---|---|
| 1 | 机械合成示例必须能通过**该 stage 的语义 validator**（不只是 `Value.Check`） | **无保护**。最接近的断言是 `schema-prompt-adapter.test.ts:17-21`「示例通过 `Value.Check(DiagnosticianOutputV1Schema)`」 | 三个诊断 stage 的示例实测均过不了各自 validator（NEW-6） |
| 2 | 同一 prompt 内的多份字段清单必须互相一致，且与 schema 必填集一致 | **无保护**。存在的是方向性关键词断言（`rootcause-prompt-builder.test.ts`、`router-prompt-builder.test.ts`、`artificer-prompt-builder-v2.test.ts:57-77`） | NEW-8（router 三份清单）、R-20 家族（scribe REQUIRED vs Optional）、R-02（artificer 示例 vs v2 契约） |
| 3 | 两份「等价」schema 必须键集/行为都等价 | **部分保护**。`artificer-output-typebox.test.ts:50-58` 已用**键集相等 + 字段哨兵**（`afa95651` 后新增）；`dreamer-output-typebox.test.ts` 有键集相等断言。**但 case 级子结构无等价断言** | R-03 复核：顶层已保护；case 级 `ruleContext` 仍单向（§5） |
| 4 | registry 里每个 `outputSchemaRef` 都有生产 runner 消费，且 registry 集合与 runner 传参集合相等 | **无保护**。无任何测试断言 registry 键集（rg 零命中） | `empathy-observer-output-v1` 即"注册但无生产调用方"的现存实例（§3.1） |
| 5 | 模型可见的禁止/约束文本集合与 validator 实际执行集合相等 | **无保护**（仅关键词存在性断言） | NEW-3 |
| 6 | `needs_revision` 类裁决必须有非空行动清单 | **仅 evaluator 单侧有**（`evaluator-output.ts:470-474`）；rollout 侧无 | NEW-4 |
| 7 | 任何写入 `pi_metadata` 的载荷形状都必须可被 `parsePITaskMetadata` 读回（写读往返） | **无保护** | NEW-2（实测写侧允许的形状读侧判 null） |
| 8 | provider 侧 JSON Schema 必须覆盖 prompt 要求模型产出的全部字段 | **无保护** | NEW-1 |
| 9 | 转换器不得修改调用方持有的 canonical schema | **无保护** | NEW-7 |
| 10 | writer 集合 × 可自动晋级通道 × 低风险通道三者互相自洽 | **无保护**（三者是独立常量） | NEW-5 |

**观察**：第 1/2/5 条共享同一根因——**prompt 文本与机器契约之间没有"同一权威"的对齐面**。当前所有相关测试都是"关键词存在性"或"结构合法性"断言，没有任何一条断言"prompt 教的集合 == 机器校验的集合"。这正是任务书所说 `check:pipeline-contract` 的 Prompt Example Validity / Output Schema Ref Integrity guard 要覆盖的面；**当前仓库无 `check:pipeline-contract`，也无 Prompt Example Validity 类 guard**（`package.json` scripts 与 `scripts/` 目录 rg 无命中）。

---

## 8. Suggested Contract Invariants（只写不变量，不写方案）

I-01 **示例-校验一致性**：任一 stage 的 prompt example（无论机械合成还是硬编码）必须通过该 stage 的**语义 validator**，而非仅通过结构 schema。

I-02 **声明闭合性**：prompt 中被声明为必填/必须生成的每个字段，必须同时（a）存在于该 stage 的 canonical schema 或由 runner 注入，且（b）被某个 validator 或注入点覆盖；反之，validator 强制的每个必填字段必须在 prompt 中被教到或由 runner 注入。

I-03 **单句权威**：任一 stage 的「模型可见的必填字段清单」至多存在一处权威表述；示例、约束段、tool 描述不得给出与该权威冲突的清单。

I-04 **双 schema 等价性**：同一 output 契约的两份声明（tool 参数 schema 与 canonical schema）必须在**顶层与嵌套层级**都键集相等；等价性证明须包含"缺失字段"探测能力（仅行为样本不足以发现缺失的可选字段）。

I-05 **registry 完整性**：`OUTPUT_SCHEMA_REGISTRY` 的键集 == 生产 runner 实际请求的 `outputSchemaRef` 集合；每个键至少有一个生产消费者；未知 ref 必须 fail loud（现状已满足后者）。

I-06 **provider schema 覆盖性**：派生的 provider JSON Schema 必须允许输出中出现的全部合法字段（含可选/扩展字段）；`additionalProperties:false` 不得用于排除 prompt 明文要求的字段。

I-07 **禁集一致性**：模型可见的禁止/约束清单与 validator 实际执行的检查集合必须双向包含（无"只教不查"、无"只查不教"）；任何未教的检查必须在模型可见文本中被枚举。

I-08 **裁决闭合性**：任何 `needs_revision`/`require_revision` 类裁决必须携带非空且可执行的行动清单；该不变量在所有发布该裁决的代理上一致。

I-09 **写入-读回往返**：任何被持久化到 authority 记录（如 `pi_metadata`）的载荷，其"写侧允许的形状"必须是"读侧接受形状"的子集。

I-10 **确定性来源不被覆写**：由 runner 拥有的字段（lineage、时间戳、运行时派生结果）不得由模型输出或 prompt example 提供值，且回注/覆盖必须可观测（有遥测或结构化 reason）。

I-11 **无静默语义改写**：normalizer/repair 不得在无遥测的情况下删除或改写字段（含"默认值填充"与"删除伪造 ID"两类）。

I-12 **契约版本可追溯**：每个 stage 的 prompt contract version 与其 schema ref 的对应关系必须可从代码单点查询（现状：部分 stage 有 `*_PROMPT_CONTRACT_VERSION` 常量，部分无，未形成统一面）。

---

## 9. Out of Scope

本文件**不做**：

1. **不提修复方案**（含不写 patch、不改 prompt、不改 schema、不新增 guard 实现）——修复由 `check:pipeline-contract` guard 设计轮与 Owner 决策承担。
2. **不重做 #1707/#1710 的全量审计**：仅做 §5 指定的 carry-forward 裁决与 §4.4 六类断缝的矩阵化。
3. **不改任何代码/配置/测试**：本文件是全仓唯一写入（`docs/audit/pri-807-phase0/PROMPT_SCHEMA_VALIDATOR_MATRIX.md`）。
4. **不做 Provider 实测**：NEW-1 中"provider 是否因 `additionalProperties:false` 拒收 V2 字段"只登记代码事实与 schema 产物，**未对任何真实 provider 发起调用**（属 §5「后续取证缺口：live 运行时核对」）。
5. **不覆盖 PowerShell / Windows 特定路径**、安装器（`install-layout`）、Console UI、Codex adapter 的契约面（除被 §4 矩阵直接引用者）。
6. **不扩到非内置代理**：仅 §4 所列 11 个 stage；`empathyObserver`（死角色）只在 §3.1 的"注册但无消费者"处提及一行。
7. **不评估治理下游**（approval/activation/shadow/promote 的完整不变量）——除 NEW-5 因直接由 rollout 输出驱动而必须记录。
8. **不做环境结论**：本环境无 `node_modules`，未运行 vitest / `verify:merge` / `check:*`（除 `check:docs-structure` 与本文件的 `error:context` plan-mode 探针），任何"测试通过"字样均不在此文件出现。
9. **不做 Linear 关联**（零密钥姿态）。
10. **不判定未核对的历史条目**：R-01/R-04/R-05/R-06/R-07/R-08/R-12/R-14/R-15/R-17/R-20..R-26 不在本 Worker 的 §5 carry-forward 清单内，除在 §6 中作为上下文引用外不作裁决。

---

## 附录 A：本轮行为级实证清单（可复现）

环境：临时目录安装 `@sinclair/typebox@0.34.48`（与 `packages/principles-core/package.json` 声明一致）与 `typebox@1.3.16`，用 `tsx` 直接 `import` 工作区 `packages/principles-core/src/runtime-v2/**` 真实模块。**未运行 vitest。**

| # | 实测命题 | 结果 |
|---|---|---|
| A1 | 三个诊断 stage 的机械示例是否通过各自 `Value.Check` | 均 `true` |
| A2 | rootcause 示例 × `DefaultDiagRootCauseValidator` | `valid:false`（`rootCause must start with "People: "`） |
| A3 | distiller 示例 × `DefaultDiagDistillerValidator` | `valid:false`（`Fabricated axiom ID example not in core principle registry`） |
| A4 | artificer prompt OUTPUT FORMAT 示例（逐字）× `DefaultArtificerValidator` | `valid:true`（v2 义务不在该 validator） |
| A5 | 同上 + 模型严格按 router 的 3 字段清单（+ runner 注入）× schema/validator | `valid:false`（`/valid`,`/diagnosisId` Expected required property） |
| A6 | dreamer / philosopher 硬编码示例 × 各自 validator | 均 `valid:true` |
| A7 | evaluator V2 示例 × `DefaultEvaluatorValidator` | `valid:true` |
| A8 | evaluator `adversarialCases` 长度 1 与 12（prompt 说 3-5） | 均 `valid:true`（不校验数量） |
| A9 | evaluator `codeReview.aligned=false` + `decision=approved` | `valid:true`（无交叉校验） |
| A10 | evaluator `needs_revision` + `requiredChanges:[]` | `valid:false`（有强制） |
| A11 | rollout `needs_revision` + `requiredChanges:[]`（两 mode 各一） | 均 `valid:true`（无强制） |
| A12 | rollout 两 mode 的 prompt 示例 × 各自 mode validator | 均 `valid:true` |
| A13 | scribe 示例（带/不带 `intentContract`）× validator | 均 `valid:true`；字符串编码 `intentContract` → `valid:false` |
| A14 | `parsePITaskMetadata` 对空 `requiredChanges` 的 rolloutRevisionPayload | `null`（metadata 整体不可读） |
| A15 | 静态门对 22 个 spec 声明模式的检出率 | 全检出；对 `Date.now` **0 命中** |
| A16 | 静态门对 `'con'+'structor'` / `` `con${''}structor` `` / `obj['constructor']` | 均 0 命中 |
| A17 | `checkForbiddenPatterns` 对 `WeakRef`/`Atomics`/`SharedArrayBuffer`/`FinalizationRegistry`/`import.meta` | 均命中（但这些名字**不在**模型可见的 spec 文本里） |
| A18 | artificer 两份 schema 顶层键集 | 相同（11 键，含 `evidenceRefs`） |
| A19 | artificer 两份 schema case 级键集 | **不同**（typebox 多 `ruleContext`） |
| A20 | `typeboxToOpenAIJsonSchema(ArtificerRuleOutputSchema)` 的 case 键 | 无 `ruleContext` |
| A21 | `typeboxToOpenAIJsonSchema(EvaluatorOutputV1Schema)` 顶层键 | 仅 6 键（无 V2/Layer2 字段），`additionalProperties:false` |
| A22 | 转换器对无 `type` 顶层入参 | **改写调用方对象** |
| A23 | `Value.Check(转换产物, ...)`（含空 pattern 子 schema） | 抛 `ValueCheckUnknownTypeError` |
| A24 | dreamer 两份 schema 顶层与 candidate 子键集 | 相同 |
| A25 | spec 声明的 22 个模式各自"裸用"探针 | **全部 22 个均被检出**（此前"漏检"的说法不成立） |
| A26 | `globalThis['require']`（spec 自己举例的逃逸形态） | 命中（`globalThis` + `bracket access to forbidden global`） |
| A27 | `obj['constructor']` / `obj['WeakRef']` | `constructor` **不在** bracket-access 备选集内 → `obj['constructor']` 0 命中；`obj['WeakRef']` 命中 bracket-access |
| A28 | `activation-types` 三常量交叉 + `dispatch` 四通道 × 两 decision（confidence=0.99） | 见 NEW-5 矩阵（`skill` 决策可达、结果 `no_writer_for_channel_skill`） |
| A29 | router prompt 实参文本内 `valid: boolean (required)` / `diagnosisId: … (required)` 的位置 | 均在 `CONSTRAINTS:`（索引 3617）之后（索引 3792），且晚于手写 `OUTPUT REQUIREMENTS`（索引 1138） |

## 附录 B：本文件的元信息

- 写入路径：`docs/audit/pri-807-phase0/PROMPT_SCHEMA_VALIDATOR_MATRIX.md`
- 基线：`cdec05d4bc4252151c7f9f118bdad90f25067594`（BASELINE: SYNCED）
- 证据口径：全部结论带 `file:line` 或稳定 grep anchor，行号锚定 cdec05d4
- 路由探针：`npm run error:context -- --paths docs/audit/pri-807-phase0/PROMPT_SCHEMA_VALIDATOR_MATRIX.md --signals ...`（plan mode）命中 **EP-01 Trust Boundary Validation (HIGH)**，Required Evidence 三条（rc-1/rc-2 守卫、rc-3 fail loud、所有输出路径只发 validated 对象）与本文件 §5/§6 的判定口径一致；`ERROR_PATTERN_INDEX.md` 已人工过一遍（EP-01/EP-03/EP-06/EP-07/EP-09 与本审计面相关，其中 EP-06「Source of Truth and Generated Artifacts」直接对应 §8 I-03/I-05/I-06）。
- 未运行：vitest、`verify:merge`、全部 `check:*`（`check-docs-structure` 除外，用于保证本文件落位合规）。
