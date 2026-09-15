# PRI-807 Phase 0 — Worker B: Prompt / Schema / Validator Contract 矩阵

**审计范围**：模型被教的格式（prompt output instructions + example）、工具暴露的 schema（`submit_*` tool 参数）、canonical schema（`OUTPUT_SCHEMA_REGISTRY` / TypeBox）、semantic validator、runner normalization/repair —— 这五层是否真正一致。

**只读审计**：本报告不改任何 `packages/**` 代码。所有判定均回源 current main 生产代码，并通过 vitest 实测复现（测试文件为临时文件，已删除，不入库）。

---

## 1. Scope

| 项 | 内容 |
|---|---|
| 覆盖 Agent | `diag_rootcause`、`diag_distiller`、`diag_router`、`dreamer`、`philosopher`、`scribe`、`artificer`、`evaluator`、`rollout_reviewer`、`signal-classification`、`correction-observer` |
| 契约五层 | L1 Prompt instructions / L2 Prompt example / L3 Tool schema / L4 Canonical TypeBox / L5 Semantic validator + normalization |
| 六类断缝 | ①required vs optional ②示例过不了自身 validator ③tool schema 缺 canonical 必填 ④两份"等价"schema 有差异 ⑤validator 要求 prompt 未教的字段 ⑥normalizer/repair 静默改语义 |
| Carry-forward | R-02 / R-03 / R-09 / R-11 / R-13 / R-16 / R-18 + §4.4 特别复核（schema-generated examples、`Value.Cast`、Artificer 三份 vocabulary、Scribe intentContract、evaluator progressive、R-19 B 面） |
| 证据纪律 | 禁止仅凭 grep 下结论；每条事实打开 prompt builder / tool schema / canonical schema / validator 真实文本，关键判定用 vitest 实测复现 |

---

## 2. Baseline

**实际 checkout SHA**：`191ae1af588a68950af1de5a3b9265771a7b3e8d`（`origin/main`，`git rev-parse HEAD`）

### ⚠️ Drift Warning

任务书指定的基线 `cdec05d4bc4252151c7f9f118bdad90f25067594` **在本 checkout 中不存在**：

```
$ git cat-file -t cdec05d4bc4252151c7f9f118bdad90f25067594
fatal: git cat-file: could not get object info
$ git merge-base --is-ancestor cdec05d4b HEAD
fatal: Not a valid commit name cdec05d4bc4252151c7f9f118bdad90f25067594
```

- `git log --oneline <HEAD>..cdec05d4b` → 无法计算（对象不存在）
- `git log --oneline cdec05d4b..<HEAD>` → 无法计算（对象不存在）
- **影响面**：无法给出精确的 commit 级差集。cdec05d4b 既不是 HEAD 的祖先也不是后代，属于本 checkout 完全未 fetch 的对象（浅克隆/镜像未同步该 SHA）。
- 任务书附带的两个历史证据文件亦不存在：`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`、`VERIFICATION-B/C.md`（`find docs -ipath "*pipeline-audit*"` 无结果）；`docs/` 下无任何 `1707`/`1710` 引用。
- **结论效力**：**本报告仅对 `191ae1af` 负责**。所有 R 项判定均为「在 191ae1af 上的现状」，而非「相对 cdec05d4b 的变化」。任务书内嵌的历史发现（R-02…R-18）作为线索使用，判定本身一律回源本 SHA 的代码。

**基线可复现性**：`origin/main == HEAD == 191ae1af`，工作区干净（仅新增本报告）。

---

## 3. Current Authorities（代码 SSOT 当前覆盖面）

### 3.1 `OUTPUT_SCHEMA_REGISTRY`

`packages/principles-core/src/runtime-v2/adapter/output-schema-registry.ts:37` — `ReadonlyMap<string, TSchema>`，**12 项**：

| # | ref | canonical schema 源 | 生产 consumer 传 ref 处 |
|---|---|---|---|
| 1 | `diagnostician-output-v1` | `diagnostician-output.ts` `DiagnosticianOutputV1Schema` | `diag-router-runner.ts` |
| 2 | `diag-rootcause-output-v1` | `diagnostician/diag-rootcause-output.ts` | `diag-rootcause-runner.ts` |
| 3 | `diag-distiller-output-v1` | `diagnostician/diag-distiller-output.ts` | `diag-distiller-runner.ts` |
| 4 | `dreamer-output-v1` | `internalization/dreamer-output.ts` | `dreamer-runner.ts` |
| 5 | `philosopher-output-v1` | `internalization/philosopher-output.ts` | `philosopher-runner.ts:227` |
| 6 | `scribe-output-v1` | `internalization/scribe-output.ts` | `scribe-runner.ts` |
| 7 | `artificer-rule-output-v2` | `internalization/artificer-output.ts` | `artificer-runner.ts:947` |
| 8 | `evaluator-output-v1` | `internalization/evaluator-output.ts` | `evaluator-runner.ts:882` |
| 9 | `rollout-reviewer-output-v1` | `internalization/rollout-reviewer-output.ts` | `rollout-reviewer-runner.ts` |
| 10 | `empathy-observer-output-v1` | `observer/empathy-observer.ts` | plugin 层 |
| 11 | `correction-observer-output-v1` | `observer/correction-observer.ts` | plugin 层 |
| 12 | `signal-classification-output-v1` | `signal-collector/types.ts` | `openclaw-plugin/src/core/signal-collector-host.ts:639`（**非 core runner**） |

`resolveOutputSchema()`（同文件:64）区分「ref 缺省 → 用默认」与「ref 未知 → fail loud（rc-3）」，两个 adapter 的 nextAction 文案均提示注册到 registry。

### 3.2 四条并存的「格式契约」权威，彼此不互相校验

| 层 | 位置 | 举例 |
|---|---|---|
| L1 Prompt instructions | 各 `*-prompt-builder.ts` 手写长文本常量 | `ARTIFICER_PROTOCOL_INSTRUCTION`、`RULECODE_SPEC_TEXT` |
| L2 Prompt example | ①手写字面量 ②`DefaultSchemaPromptAdapter.generateExample()` 反射生成 | artificer 手写；rootcause/distiller 生成 |
| L3 Tool schema | `tools/*-output-typebox.ts`（`typebox` fork，供 `AgentTool<TParameters>`） | `ArtificerRuleOutputTypebox` |
| L4 Canonical TypeBox | `@sinclair/typebox` schema（registry 来源） | `ArtificerRuleOutputSchema` |
| L5 Semantic validator | 手写 `Default*Validator.validate(unknown, …)` | `DefaultArtificerValidator` |

**关键结构性事实**：L4 只做结构校验（`Value.Check`），**业务语义约束（前缀、互斥、条件必填、跨字段一致）只在 L5 手写 validator 里**。因此「示例通过 `Value.Check`」远不等于「示例是合法契约」——这正是 R-02 / NEW-01 的生存空间（见 §6）。

### 3.3 Schema 生成路径的两个 adapter

- `schema-prompt-adapter.ts:185` — `generateExample()`：`Value.Check` 失败时 **`Value.Cast` 兜底**（§4.4 复核项）
- 同文件 `generateConstraints()`：**从不输出 `maxLength` / `maxItems` / `minItems` / `pattern`**（`grep -c maxLength` = 0）
- 该 adapter 同时供 prompt 文本（rootcause/distiller）与 tool 参数描述（`pi-ai-runtime-adapter.ts:1076` `buildSchemaToolDefinition`）使用

---

## 4. Contract Map

列为 §4.2 要求的字段。`—` 表示该层不存在。「断缝」列标注 §4.3 六类中的编号。

### 4.1 `diag_rootcause`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `diagnostician/rootcause-prompt-builder.ts:214`（PHASE 1/2/3 + 可选 3.5/3.6）。关键约束：`:250` `rootCause MUST include category prefix`；`:251` `rootCauseCategory MUST match the category prefix in rootCause`；`evidenceRefs MUST NOT be an empty array`（`:226`）；`If diagnosisTarget.evidence 为空 → output confidence < 0.3 且 ambiguityNotes 含 "Insufficient evidence"` |
| Prompt example | **生成**，`rootcause-prompt-builder.ts:184` `adapter.generateExample(DiagRootCauseOutputV1Schema)` → `:242` 注入 `COMPLETE EXAMPLE OUTPUT` |
| Tool schema | 无独立 tool schema；tool-call 模式经 `buildSchemaToolDefinition(schemaRef, schema, adapter)`（`pi-ai-runtime-adapter.ts:1076`）由同一 adapter 生成参数描述 |
| Registry ref | `diag-rootcause-output-v1` |
| Canonical TypeBox | `DiagRootCauseOutputV1Schema`（`diag-rootcause-output.ts`）。`causalChain` 每项 `why: 1..5`、`evidenceRefs minItems:1`；`rootCause` 仅 `minLength:1`（**无前缀 regex**） |
| Normalization/repair | `diag-rootcause-runner.ts` 经 adapter `structured-output-repair` 通道；lineage `taskId` 由 `injectRunnerLineageIfAbsent` 重注 |
| Semantic validator | `DefaultDiagRootCauseValidator`：`diag-rootcause-output.ts:318-326` **强制** `rootCause.startsWith(\`${rootCauseCategory}: \`)` |
| Consumer | `diag-router-runner.ts`（Stage A 注入 `rootCause`/`evidence`/`intentTension`） |
| **断缝** | **②**（示例 `rootCause:"example"` + `rootCauseCategory:"People"` → 前缀校验必败）；**⑤**（validator 的前缀要求 schema 无表达）；**⑥**（`generateConstraints` 不暴露 `maxLength`/`minItems`）；**R-18**（confidence<0.3 无执行面） |

### 4.2 `diag_distiller`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `diagnostician/distiller-prompt-builder.ts:143`。关键约束：`abstractedPrinciple ≤200 chars`；`groundedOnCorePrincipleIds MUST only contain IDs from the provided axiom list`；`sourceRootCauseArtifactId MUST match` |
| Prompt example | **生成**，`distiller-prompt-builder.ts:149` |
| Tool schema | 同上（共享 `buildSchemaToolDefinition`） |
| Registry ref | `diag-distiller-output-v1` |
| Canonical TypeBox | `DiagDistillerOutputV1Schema`：`abstractedPrinciple: Type.String({minLength:1, maxLength:200})`；`scope` union |
| Normalization/repair | 同 rootcause 通道 |
| Semantic validator | `DefaultDiagDistillerValidator` |
| Consumer | `diag-router-runner.ts`（`abstractedPrinciple` 经 router 转述，见 R-11） |
| **断缝** | **④**（distiller `abstractedPrinciple` 有 `maxLength:200`，router/canonical 版无）；**⑥**（`maxLength` 未进 `generateConstraints`，靠 prompt 手写 prose 兜底） |

### 4.3 `diag_router`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `diagnostician/router-prompt-builder.ts:157`。关键约束：`kind:"principle"` → **MUST include abstractedPrinciple**；`kind:"rule"` → MUST include triggerPattern + action |
| Prompt example | 无独立 example（prompt 声明 "You only need to generate these fields"） |
| Tool schema | 无独立 tool schema |
| Registry ref | `diagnostician-output-v1`（**注意**：Stage C 用 canonical 名，非 `diag-router-*`） |
| Canonical TypeBox | `DiagnosticianOutputV1Schema`：`recommendations minItems:1`；`abstractedPrinciple: Type.Optional(Type.String())`（**无 maxLength、无条件必填**） |
| Normalization/repair | `diag-router-runner.ts:450` `postFetchTransform` **强制覆写** `rootCause`、`evidence`、`confidence`、`intentTension` ← upstream；LLM 不同的值触发 `invariant_override` 遥测；`abstractedPrinciple` **不在覆写清单** |
| Semantic validator | `DefaultDiagnosticianValidator` + `internalization-route.ts:79` 消费侧门禁 |
| Consumer | `internalization-route.ts`（`recommendation.abstractedPrinciple` 作 route ready 判据） |
| **断缝** | **①**（router prompt 写 MUST，schema 是 Optional）；**R-11**（route 判定读 router 转述件而非 distiller 原件） |

### 4.4 `dreamer`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `internalization/dreamer-prompt-builder.ts:84`：`For each identified root cause, generate 1-5 alternative decision candidates`；`:97` `candidates MUST have 1-5 items` |
| Prompt example | 手写字面量（`:91`），2 条 candidate |
| Tool schema | `tools/dreamer-output-typebox.ts`（typebox 镜像） |
| Registry ref | `dreamer-output-v1` |
| Canonical TypeBox | `dreamer-output.ts:81` `candidates: Type.Array(DreamerCandidateSchema, { minItems: 1, maxItems: 5 })` |
| Normalization/repair | 标准通道 |
| Semantic validator | `DefaultDreamerValidator` |
| Consumer | philosopher-runner |
| **断缝** | **R-16**（口径三处不一：prompt「每根因 1-5」/ schema「总数 1-5」/ 文档注释「2-3」） |

### 4.5 `philosopher`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `internalization/philosopher-prompt-builder.ts:88`。约束：`title <=100 chars`、`confidence 0-1`、`sourceDreamerArtifactId MUST be copied exactly` |
| Prompt example | 手写字面量（`:89`） |
| Tool schema | 无独立 tool schema（`buildSchemaToolDefinition` 通用路径） |
| Registry ref | `philosopher-output-v1` |
| Canonical TypeBox | `PhilosopherOutputV1Schema` — `taskId`/`sourceDreamerArtifactId`/`thesis`/`principleCandidate{title,rationale,scope,confidence}`/`risks`/`generatedAt` |
| Normalization/repair | 标准通道 |
| Semantic validator | `DefaultPhilosopherValidator` |
| Consumer | scribe-runner |
| **断缝** | 无发现。prompt example 与 schema field-for-field 一致。注：schema 无 `sourceTrace`，prompt 也未教 —— 两侧一致，非断缝 |

### 4.6 `scribe`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `internalization/scribe-prompt-builder.ts:58`。关键约束：`:101` **`intentContract is REQUIRED and every one of its five fields MUST be a non-empty string`**；`:102` 必须嵌套 JSON OBJECT 不可 double-encode |
| Prompt example | 手写字面量（`:70`）含完整 `intentContract` 五字段 |
| Tool schema | 无独立 tool schema |
| Registry ref | `scribe-output-v1` |
| Canonical TypeBox | `ScribeOutputV1Schema`：`intentContract: Type.Optional(Type.Unknown())`（`scribe-output.ts:72`） |
| Normalization/repair | `scribe-output.ts:182-204` **额外 repair**：`intentContract` 被 LLM double-encode 为字符串时，`normalizeIntentContract` 解析回对象（`Reflect.set` 原地改写） |
| Semantic validator | `DefaultScribeValidator`：`:160-166` — `intentContract` **present-but-malformed 才报错；缺失则放行** |
| Consumer | `intent-contract.ts:74` `readIntentContract`（下游 best-effort 降级） |
| **断缝** | **NEW-02**（prompt 声明 REQUIRED，schema + validator 均为 optional） |

### 4.7 `artificer`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `internalization/artificer-prompt-builder.ts:168` `OUTPUT FORMAT` + `:188` `CONSTRAINTS` + `:261` `V2_CONTEXT_INSTRUCTION`。关键约束：`:215` `expectedDecision MUST be only "allow" or "block"`；`:246` `The ONLY legal field set is the one in OUTPUT FORMAT above plus the v2 CONTEXT MODE obligations (requiresContextVersion: 2, case-level ruleContext, evidenceRefs)`；`:269` `You MUST copy evidenceRefs exactly` |
| Prompt example | **手写**，`artificer-prompt-builder.ts:169-186`（11 字段，**缺 `requiresContextVersion` / `evidenceRefs` / case 级 `ruleContext`**）；另 `artificer-l2-tool-contract.ts` `RULECODE_SPEC_TEXT` 在 tool 返回值里给第二份指导 |
| Tool schema | `tools/artificer-output-typebox.ts` `ArtificerRuleOutputTypebox` — `submit_rulecode.parameters`（`artificer-l2-tool-contract.ts:356`） |
| Registry ref | `artificer-rule-output-v2` |
| Canonical TypeBox | `internalization/artificer-output.ts:77` `ArtificerRuleOutputSchema` — `goldenTraceCases minItems:2 maxItems:10`、`requiresContextVersion: Type.Optional(Type.Literal(2))`、`evidenceRefs: Type.Optional(...)` |
| Normalization/repair | `artificer-runner.ts:955` `validateV2OutputContract()` —— **独立于 TypeBox 的第二道硬门**：`:537` `requiresContextVersion !== 2` 报错；`:569` `evidenceRefs` 必须与 pack 逐字相等 |
| Semantic validator | `DefaultArtificerValidator`（`artificer-output.ts:194`）：v2 声明时要求每 case 有 `ruleContext`、禁 `propose_correction`、要求 `evidenceRefs` 非空；v1 规则反禁 `ruleContext` |
| Consumer | evaluator-runner（`artificerArtifact`） |
| **断缝** | **R-02 / NEW-03 / NEW-04** — 见 §5、§6 |

### 4.8 `evaluator`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `internalization/evaluator-prompt-builder.ts:193-217`。约束：`needs_revision` 时 `requiredChanges` 至少 1 项；`codeReview` 三维度；`adversarialCases` 3-5 条；`priorRequirementStatuses`/`requirementLedger` 条件必填 |
| Prompt example | 手写字面量（`:196`）——**无 `painCoverage` / `compressionFidelity` / `implementationFidelity`** |
| Tool schema | 无独立 tool schema |
| Registry ref | `evaluator-output-v1` |
| Canonical TypeBox | `EvaluatorOutputV1Schema`（`evaluator-output.ts:217`）—— 6 个必需字段，**无 progressive 字段的 TypeBox 表达**；progressive 字段只存在于 TS interface `EvaluatorOutputV2`（`:169-171`） |
| Normalization/repair | 标准通道；`isEvaluatorOutputV2()` 的 white-list（`:405-406`）承认 `painCoverage`/`compressionFidelity` 的存在 |
| Semantic validator | `DefaultEvaluatorValidator`（`:472` `needs_revision` ⇒ `requiredChanges` 非空；`:474` 上轮需求核销） |
| Consumer | `progressive-evaluator.ts:118` `evaluateFlaggedCriteria` + `evaluator-runner.ts:605` |
| **断缝** | **R-09（扩大）** — 见 §5 |

### 4.9 `rollout_reviewer`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `internalization/rollout-reviewer-prompt-builder.ts:67`（code_chain）/ `:119`（principle_semantic） |
| Prompt example | 手写字面量（`:127`） |
| Tool schema | 无独立 tool schema |
| Registry ref | `rollout-reviewer-output-v1` |
| Canonical TypeBox | `RolloutReviewerOutputV1Schema`：`requiredChanges: Type.Array(Type.String())`（**无 `minItems`**）；`sourceEvaluatorArtifactId`/`sourceScribeArtifactId` 均 `Optional`（按 mode 由 validator 判定） |
| Normalization/repair | 标准通道 |
| Semantic validator | `DefaultRolloutReviewerValidator`（mode-aware：`code_chain` ⇔ `evaluatorArtifactId`，`principle_semantic` ⇔ `scribeArtifactId`） |
| Consumer | `internalization-transition-decision.ts:116`（`approve_rollout` → 晋级）；`host-runtime/internalization-consumer-governance.ts:128` |
| **断缝** | **R-13（PARTIAL）** — 见 §5 |

### 4.10 `signal-classification`

| 字段 | 内容 |
|---|---|
| Prompt instructions | `signal-collector/llm-stage.ts:17`：`只输出 JSON，格式：{"is_feedback": bool, "type": "correction"|"empathy"|"none", "confidence": 0-1, "reason": "一句话理由"}` |
| Prompt example | 同上一行（inline 单行 JSON） |
| Tool schema | 无（plugin 层 adapter 直接 JSON extraction） |
| Registry ref | `signal-classification-output-v1` |
| Canonical TypeBox | `signal-collector/types.ts:115` `{is_feedback: Boolean, type: Union[correction,empathy,none], confidence: Number(min 0,max 1), reason: String}` |
| Normalization/repair | plugin adapter JSON extraction |
| Semantic validator | `types.ts:101` `isSignalClassificationOutput` 类型守卫 |
| Consumer | `signal-collector.ts:75` |
| **断缝** | 无发现。prompt / guard / schema / 消费端四处一致 |

### 4.11 `correction-observer`

| 字段 | 内容 |
|---|---|
| Prompt instructions | plugin 侧注入（`openclaw-plugin/src/service/correction-observer*`） |
| Prompt example | 未见独立 example |
| Tool schema | 无独立 tool schema |
| Registry ref | `correction-observer-output-v1` |
| Canonical TypeBox | observer/correction-observer.ts`:30` `{updated: Boolean, updates?: Record<String, {action, weight?, falsePositiveRate?, reasoning}>, fpTerms?: String[], fpAnalysisStatus?: 'completed'|'skipped', summary: String}` |
| Normalization/repair | plugin 层 |
| Semantic validator | 无独立 `Default*Validator`（仅 schema Check） |
| Consumer | plugin correction observer 服务 |
| **断缝** | 无 P1/P2 发现。注：本 agent 缺独立 semantic validator 层，属 guard 覆盖空白（见 §7） |

---

## 5. Confirmed / Fixed / Drifted

判定词：CONFIRMED（仍存在）/ FIXED（已修复且有防护）/ DRIFTED（形态与历史描述不同）/ PARTIAL（部分成立）。

### R-02 — artificer OUTPUT FORMAT 示例违反 v2 硬契约 → **CONFIRMED（两处均成立）**

**(a) 示例缺 v2 必填字段** — `artificer-prompt-builder.ts:169-186`

示例的 11 个顶层字段：`taskId, sourceScribeArtifactId, implementationSummary, sourceTrace, risks, implementationCode, goldenTraceCases, affectedTools, generatedAt` —— 实为 9 个。**缺 `requiresContextVersion`、`evidenceRefs`**；candidate case 亦**无 `ruleContext`**。

实测（复现 prompt 原文对象，喂两个校验器）：

```
$ npx vitest run  # 临时测试，已删除
DefaultArtificerValidator:            {"valid":true,"errors":[]}
   -> requiresContextVersion present? false
   -> evidenceRefs present?          false
```

**精确机制**（这正是历史结论不够精确之处）：`DefaultArtificerValidator` 的 v2 分支由 `isV2Declared`（`artificer-output.ts:250`）驱动 —— `requiresContextVersion` **缺失即视为 v1**，于是 v2 的门控全部不触发，validator 报 `valid:true`。**该示例之所以能"自证合法"，是因为它同时缺了触发校验的那个字段本身。**

真正的阻断发生在第二道门：`artificer-runner.ts:955` `validateV2OutputContract()`：
- `:537` `if (output.requiresContextVersion !== 2) errors.push('v2 Artificer output must declare requiresContextVersion: 2')`
- `:569` `output.evidenceRefs` 必须与 `behaviorExamplePack.evidenceRefs` 逐项 `===` 相等

而 PRI-780 之后该门**无 v1 旁路**（`:895` 无 pack 直接 throw `behavior_example_pack_missing`）。因此：**照抄 prompt 示例 → 经 schema validator 放行 → 被 `validateV2OutputContract` 拒绝**。严重度 **P2**（契约断裂但失败可见、有 `priorValidatorErrors` 反馈回路，非静默）。

**(b) "CONTEXT MODE block above" 方位自指错误** — CONFIRMED

- 引用点：`artificer-prompt-builder.ts:245`、`:246`（位于 `ARTIFICER_PROTOCOL_INSTRUCTION` 内，该常量起始于 `:153`）
- 被引用块：`V2_CONTEXT_INSTRUCTION` **定义于 `:261`**，在 `:358` 以 `ARTIFICER_PROTOCOL_INSTRUCTION + V2_CONTEXT_INSTRUCTION` **追加在后**

即被引用块实际位于引用点的**下方**。`:250`、`:252` 同样引用 "OUTPUT FORMAT and CONTEXT MODE rules"，其中 OUTPUT FORMAT（`:168`）在上、CONTEXT MODE 在下。

### R-03 — artificer 双 schema 漂移 → **FIXED（顶层）/ PARTIAL（嵌套层残余）**

**FIXED 部分**：顶层 11 个属性集**完全相同**，`evidenceRefs` 两侧均声明。

实测：
```
sinclair keys: affectedTools,evidenceRefs,generatedAt,goldenTraceCases,implementationCode,
               implementationSummary,requiresContextVersion,risks,sourceScribeArtifactId,
               sourceTrace,taskId
typebox  keys: 同上（完全一致）
```

**防护确实存在且强于历史描述**：`tools/__tests__/artificer-output-typebox.test.ts:52-63` —— 历史 R-03 只需"行为等价"，现测试已升级为**属性集相等 + `evidenceRefs` 哨兵断言**，注释明确记录 EP002-R3 的 13 次连续拒绝教训。任何单边增删字段都会变红。

**PARTIAL 部分（新发现，见 NEW-04）**：嵌套 `goldenTraceCases[].` 层仍有单边字段 —— typebox 侧有 `ruleContext`，@sinclair 侧没有：

```
sinclair case keys: caseId,expectedApplicationMode,expectedDecision,expectedProposedParams,kind,params,toolName        (7)
typebox  case keys: caseId,expectedApplicationMode,expectedDecision,expectedProposedParams,kind,params,ruleContext,toolName  (8)
```

顶层属性集守卫**覆盖不到嵌套层**，所以该残余不会被现有测试捕获。两者对含 `ruleContext` 的输入都返回 accept（@sinclair 因无 `additionalProperties:false`），故当前无功能故障 —— 属 latent drift（**P3**）。

### R-09 — progressive_evaluator 判据字段不在 evaluator 输出 schema/prompt → **CONFIRMED（范围比历史描述更大）**

`progressive-evaluator.ts:118` `evaluateFlaggedCriteria` 读三个判据：

| 判据（consumer 读法） | prompt 教了吗 | schema 有吗 | 结论 |
|---|---|---|---|
| `compressionFidelity.missingDimensions` | ❌（`evaluator-prompt-builder.ts:196` 示例无此字段） | ❌（`EvaluatorOutputV1Schema` 无） | 断缝 |
| `painCoverage.fullyCovered` | ❌ | ❌（仅 TS interface `:169`） | 断缝 |
| `implementationFidelity.score` | ❌ | ❌ —— **连 TS interface 都没有**（`EvaluatorOutputV2` 只有 `painCoverage`/`compressionFidelity`） | 断缝 |

**恒定降级链条**（`evaluator-runner.ts:605-620`）：

```ts
const d1 = stage1ContractViolated !== null
  ? { flagged: false, reasons: [], undetermined: ['stage1_output_contract_violation'] }
  : evaluateFlaggedCriteria(stage1Output);
if (!d1.flagged && !forced && d1.undetermined.length === 0) { /* Stage1 够用 */ }
```

因 Stage 1 输出必然缺这三个字段，`evaluateFlaggedCriteria` 会为每一项 `undetermined.push(...)`（`progressive-evaluator.ts:143/160/175`）。**`undetermined.length` 恒 > 0 ⇒ 恒走 Stage 2**。即 `progressive_evaluator` 开启时，单阶段快路径**不可达**，每次评估固定 2 次 LLM 调用。

比历史描述更严重的一点：不只是"判据字段缺失"，而是**判据名在系统里存在两个互不相同的写法** —— 消费端读 `implementationFidelity`，而 schema/interface/prompt 侧（若有）是 `compressionFidelity`。`implementationFidelity` 全仓库**只出现在测试文件**里（`progressive-evaluator-stage-isolation.property.test.ts`、`progressive-disclosure-spike.test.ts:759`），生产代码与 prompt 均无。严重度 **P2**（恒定降级 + 双倍成本，非正确性损坏）。

### R-11 — EP-07 不变量清单不含 abstractedPrinciple → **CONFIRMED**

`diag-router-runner.ts:450-515` `postFetchTransform` 的覆写清单：

| 字段 | 是否由 upstream 强制覆写 | 代码位置 |
|---|---|---|
| `rootCause` | ✅ ← Stage A | `:462-471` |
| `evidence` | ✅ ← Stage A | `:474-483` |
| `confidence` | ✅ ← Stage B | `:486-495` |
| `intentTension` | ✅ ← Stage A（且 Stage A 无则 strip） | `:497-522` |
| **`abstractedPrinciple`** | ❌ **不在清单** | — |

而消费侧门禁 `internalization-route.ts:79-83` 判定的是：

```ts
if (recommendation.kind === 'principle') {
  if (!recommendation.abstractedPrinciple?.trim()) missingFields.push('abstractedPrinciple');
```

`recommendation` 来自 **router（Stage C）输出**。同时 `DiagnosticianOutputV1.abstractedPrinciple` 是 `Type.Optional` 且无长度约束，而 distiller 原件 `DiagDistillerOutputV1.abstractedPrinciple` 是必填 + `maxLength:200`。**入库/判据用的是 router 转述版而非 distiller 蒸馏原件**。严重度 **P2**（治理结论建立在转述件上；`kind:"principle"` 时若 router 漏写该字段，route 判 not-ready 并建议"Re-run diagnostician"，而 Stage B 其实已产出合法原件）。

### R-13 — rolloutReviewer principle-semantic 模式 → **PARTIAL**

**(a) `needs_revision` 缺 requiredChanges 硬约束 → CONFIRMED（未修复）**

对照两个 agent 的同一类契约：

| | schema | semantic validator |
|---|---|---|
| evaluator | `Type.Array(Type.String())` | `evaluator-output.ts:472` **`needs_revision` ⇒ `requiredChanges.length === 0` 报错**（PRI-630 convergence invariant） |
| rollout_reviewer | `Type.Array(Type.String())`（无 `minItems`） | **无此校验** —— `rollout-reviewer-output.ts` 全文无 `needs_revision` 语义分支（唯一的 `needs_revision` 出现是 `:4` 类型声明与 `:54` 枚举常量） |

即 evaluator 侧已建立的不变量未镜像到 rollout_reviewer 侧。P2。

**(b) 自报 confidence 参与免审晋级 → CONFIRMED（未修复）**

链路（生产接线完整）：

1. `rollout-reviewer-output.ts:61` — `confidence: Type.Number({minimum:0, maximum:1})`，**来源是模型自己的输出**
2. `rollout-reviewer-runner.ts:343` — `reviewConfidence: output.review.confidence`
3. `host-runtime/internalization-consumer-governance.ts:128` — `rolloutDecision: 'auto_activate'`，`:133` `confirm: true`，`:134` `confidence: input.confidence`
4. `activation-dispatcher.ts:265-270`：
   ```ts
   const needsApproval = input.rolloutDecision === 'require_approval' || !isLowRiskChannel(input.channel);
   if (needsApproval) {
     if (decideAutoPromotion(input.channel, input.confidence)) { return this.activateArtifact(...); }
     return this.enqueueForApproval(...);
   }
   ```
5. `approval-queue.ts:17-22`：
   ```ts
   export function decideAutoPromotion(channel, confidence): boolean {
     if (confidence === undefined || confidence === null) return false;
     if (confidence < 0 || confidence > 1) return false;
     if (!AUTO_PROMOTABLE_CHANNELS.includes(channel)) return false;
     return confidence >= AUTO_PROMOTION_CONFIDENCE_THRESHOLD;
   }
   ```
6. `activation-types.ts:15-17` — `AUTO_PROMOTION_CONFIDENCE_THRESHOLD = 0.95`；`AUTO_PROMOTABLE_CHANNELS = ['skill']`

**(c) 但历史问题描述需要收窄**（判定 PARTIAL 的原因）：

- **范围**：仅 `channel === 'skill'` 满足 `AUTO_PROMOTABLE_CHANNELS`；`code_tool_hook` 等高风险渠道 `isLowRiskChannel` 为 false，走 `enqueueForApproval`，`confidence` 不参与免审。
- **阈值**：0.95，非"任意自报高分"。
- **降级行为**：`confidence` 为 `undefined`/越界 → `return false`（fail-closed），走人工队列。

因此不是「模型自报 confidence 即可绕过 Owner gate」，而是「在 `skill` 渠道上，模型自报 ≥0.95 可跳过人工审批」。`activation-dispatcher.ts:263-264` 的注释把这一点写成了显式设计意图（"high-confidence skill artifacts are safe enough to activate without human review"）——**这已是一个被记录的设计选择，而非遗漏**。故定性为 PARTIAL：机制存在且 live，但适用范围与触发阈值比历史描述更窄；是否接受该设计属 Owner 决策（本报告只记事实，不给方案）。

**(d) principle_semantic 模式的既有问题 → FIXED**

`rollout-reviewer-output.ts:69-78` 与 `DefaultRolloutReviewerValidator` 已实现 mode-aware 契约：`principle_semantic` 时 `sourceScribeArtifactId` + `sourceTrace.scribeArtifactId` 双重要求且互相 `must match`（`:232-243`）；schema 侧刻意保持 Optional 以免注册 schema 挡掉合法输出（`:71-75` 注释）。这是 #1698（`285d1c81`）重写的既有成果，在 `191ae1af` 上成立。

### R-16 — dreamer 候选数量口径三处不一 → **CONFIRMED**

| 处 | 文本 | 口径 |
|---|---|---|
| prompt | `dreamer-prompt-builder.ts:84` `For each identified root cause, generate 1-5 alternative decision candidates` | **每根因** 1-5（总数可 >5） |
| prompt 约束 | `:97` `candidates MUST have 1-5 items` | **总数** 1-5 |
| canonical schema | `dreamer-output.ts:81` `{ minItems: 1, maxItems: 5 }` | **总数** 1-5 |
| 文档注释 | `dreamer-output.ts:4` `Dreamer generates 2-3 diverse candidate corrections` | 2-3 |

同一份 prompt 内部 `:84` 与 `:97` 即自相矛盾。若模型有 3 个根因各出 2 条（共 6 条），遵循 `:84` 就必然违反 `:97` + schema。严重度 **P3**（矛盾可见、失败可归因，但制造无谓 repair 轮）。

### R-18 — rootcause prompt 承诺「evidence 空则 confidence<0.3」无执行面 → **CONFIRMED**

- prompt 承诺：`rootcause-prompt-builder.ts:252-254`
  ```
  - If diagnosisTarget.evidence is an empty array (length === 0), you MUST NOT fabricate evidence entries.
    Output confidence < 0.3 and set ambiguityNotes to include "Insufficient evidence".
  ```
- schema 表达：`DiagRootCauseOutputV1Schema` 的 `confidence: Type.Number({minimum: 0, maximum: 1})` —— **无条件约束**
- validator：`DefaultDiagRootCauseValidator` 无「input evidence 空 ⇒ confidence 上限」交叉校验（validator 只收 `unknown` output，本就看不到 input）

故该承诺**零执行面**：模型可照常输出 `confidence: 0.9` 且通过全部校验。上游 `confidence` 又被 `diag-router-runner.ts:486` 从 Stage B 覆写，形成第二个不一致点。严重度 **P3**（latent debt，非正确性损坏；但属"prompt 教了机器不查的规则"这一可复用模式）。

---

## 6. NEW Findings

### NEW-01 — schema-generated example 通不过自身 semantic validator（rootcause）

- **ID**：NEW-01
- **Severity**：**P2**（不是 P1：失败可见、repair 回路存在；但它在**每次** Stage A 调用上注入一个自相矛盾的示范，且没有任何测试能发现）
- **Claim**：`diag_rootcause` 的 prompt 用 `DefaultSchemaPromptAdapter.generateExample()` 生成 `COMPLETE EXAMPLE OUTPUT`，该示例**必然**被本 stage 的 semantic validator 拒绝。
- **Evidence**：
  - 生成点：`rootcause-prompt-builder.ts:184` `const example = adapter.generateExample(schema)`；`:242` 注入 prompt `COMPLETE EXAMPLE OUTPUT (follow this exact structure):`
  - 生成逻辑：`schema-prompt-adapter.ts:35` `generateValueForSchema` —— `rootCause` 是 `Type.String`，一律返回字面量 `'example'`；`rootCauseCategory` 是 union（`:52-53` `if (Array.isArray(schema.enum)) return schema.enum[0]` / anyOf 首项），取到 `'People'`
  - 校验点：`diag-rootcause-output.ts:318-326`
    ```ts
    const expectedPrefix = `${record.rootCauseCategory}: `;
    if (!record.rootCause.startsWith(expectedPrefix)) {
      errors.push(`rootCause must start with "${expectedPrefix}" (matching rootCauseCategory "${record.rootCauseCategory}"), got: ...`);
    }
    ```
  - **实测**（vitest，喂生成示例 + taskId）：
    ```
    生成示例: { "rootCause": "example", "rootCauseCategory": "People", "causalChain": [{"why": 3, ...}], "confidence": 0.5, ... }
    Value.Check(schema, example) = true          ← 结构层放行
    DefaultDiagRootCauseValidator →
      { "valid": false,
        "errors": ["rootCause must start with \"People: \" (matching rootCauseCategory \"People\"), got: \"example\""],
        "errorCategory": "output_invalid" }      ← 语义层拒绝
    ```
- **Why it matters**：模型被明确要求 "follow this exact structure"，而该结构**不可能**通过校验。若模型照抄 → 必败一轮；若模型学会忽略示例 → 示例的教育价值归零，且当 repair 反馈只说 `rootCause must start with "People: "` 时，模型看到的 prompt 示例仍在演示相反的形状。同类问题存在于 `why: 3`（PHASE 2 要求 Why-1…Why-5 链，示例给单条且 `why` 取区间中值 3）与 `diagnosisId: "example"`。
- **Affected stage**：`diag_rootcause`（Stage A）—— 每个 pain 信号的必经路径
- **Current protection**：**无**。`adapter/__tests__/schema-prompt-adapter.test.ts:17` 只断言 `Value.Check(...) === true`（结构），全仓库**没有任何测试**把生成示例喂给对应的 semantic validator（`grep -rn "generateExample" | grep -i valid` 空结果）。

### NEW-02 — Scribe `intentContract`：prompt 说 REQUIRED，schema + validator 说 optional

- **ID**：NEW-02
- **Severity**：**P2**（契约断裂 + 静默放行；`intentContract` 被既有注释定义为 "the single alignment anchor for rule generation / evaluation / repair"）
- **Claim**：三处口径不一致 —— prompt 要求必填，TypeBox 声明 optional，validator 仅在 present-but-malformed 时报错；**模型完全省略该字段会被静默接受**。
- **Evidence**：
  - prompt：`scribe-prompt-builder.ts:101` `- intentContract is REQUIRED and every one of its five fields MUST be a non-empty string (no placeholders, no "TBD")`；`:86` `INTENT CONTRACT (required — the alignment anchor for every downstream stage)`
  - schema：`scribe-output.ts:72` `intentContract: Type.Optional(Type.Unknown())`
  - validator：`scribe-output.ts:160-166`
    ```ts
    if (Object.hasOwn(output, 'intentContract') && output.intentContract !== undefined) {
      if (!isValidIntentContractV1(output.intentContract)) { errors.push(...); }
    }
    ```
    —— `Object.hasOwn` 为 false 时整段跳过，无 `else` 分支
  - 交叉证据：`ScribeOutputV1` 的 TS interface（`:45`）标注 `intentContract?: IntentContractV1` 并在 `:41-42` 把 optional 解释为**wire 层向后兼容**（"scribe outputs that predate this field lack it and downstream stages degrade best-effort"）
- **Why it matters**：这是 §4.3 断缝类型①的教科书案例，且方向对安全不利 —— 宣称 REQUIRED 的字段实际可省。一个省略 `intentContract` 的 scribe 输出会通过校验、被持久化，随后 `intent-contract.ts:74` `readIntentContract` 返回 null，下游（rule generation / evaluation / repair）进入 best-effort 降级。注释把降级称为 "rc-9 observable"，但**降级是否可观测取决于消费者是否记事件**，本报告未在 scribe 成功路径上找到"missing intentContract"的结构化事件（仅 `readIntentContract` 返回 null）。若该路径无遥测，则构成 rc-9 意义上的静默降级。
- **Affected stage**：`scribe`
- **Current protection**：仅"present-but-malformed"分支有校验；"absent"分支无校验、无测试（`grep intentContract` 未见针对省略场景的断言）。

### NEW-03 — `generateConstraints()` 不暴露 maxLength / minItems / maxItems / pattern

- **ID**：NEW-03
- **Severity**：**P3**（latent debt；当前被手写 prose 部分兜底）
- **Claim**：schema 反射生成的 `CONSTRAINTS` 段落只输出 `type` / `enum` / `min` / `max` / `minLength` / `description` / `required` 标记，**结构性数量与长度上限全部丢失**。
- **Evidence**：`schema-prompt-adapter.ts` 中 `grep -c maxLength` = **0**；`grep -c maxItems` = 0；`minItems` 亦未出现。仅 `:240` 与 `:260` 两处输出 `minLength`。
- **实测**（distiller schema）：
  ```
  abstractedPrinciple: string {description: Highly abstracted, cross-scenario principle (≤200 chars), minLength: 1} (required)
  ```
  —— `maxLength: 200` **未出现**（仅靠 `description` 里的中文/文案文字"≤200 chars"传递）
- **Why it matters**：
  1. distiller 场景**侥幸无害**：prompt 手写了 `:152` `abstractedPrinciple: ≤200 chars` 与 `:173` `MUST be ≤200 characters` 作兜底。
  2. rootcause `causalChain[].evidenceRefs` 的 `minItems: 1` 同样未输出，但 prompt `:226` 手写了 `evidenceRefs MUST NOT be an empty array` 兜底。
  3. `diagnostician-output-v1`（Stage C）的 `recommendations minItems: 1` 在生成型 Prompt 路径上无对等手写约束 —— 该 schema 的 `generateConstraints` 由 tool 描述（`pi-ai-runtime-adapter.ts:1076`）使用。
  结论：当前**每处都恰好有手写 prose 兜底，但兜底是巧合而非机制**。任何人后续新增一个 `maxItems` 约束而不补手写文案，模型就无从知晓。这正是 `check:pipeline-contract` 的 Prompt Example Validity guard 应当覆盖的形状。
- **Affected stage**：所有走 schema-adapter 的 stage（rootcause、distiller、Stage C tool 模式）
- **Current protection**：`schema-prompt-adapter.test.ts:114` 用 **snapshot** 锁定 `generateConstraints` 输出 —— snapshot 会捕获**变化**，但不会捕获**缺失能力**（缺 `maxLength` 是稳定行为，快照永远绿）。

### NEW-04 — artificer 嵌套层 schema 单边字段残余漂移（`ruleContext`）

- **ID**：NEW-04
- **Severity**：**P3**（latent；当前无功能故障，因两侧均 accept）
- **Claim**：R-03 的修复把守卫加在**顶层属性集**，嵌套 `goldenTraceCases[]` 层仍存在单边字段：typebox 侧声明 `ruleContext`，@sinclair 侧无。
- **Evidence**（实测属性集对比）：
  ```
  sinclair(registry) case keys: caseId,expectedApplicationMode,expectedDecision,expectedProposedParams,kind,params,toolName          (7)
  typebox(submit tool) case keys: caseId,expectedApplicationMode,expectedDecision,expectedProposedParams,kind,params,ruleContext,toolName  (8)
  ```
  两侧对 "case 携带 ruleContext" 的输入均返回 accept=true（@sinclair 未设 `additionalProperties: false`）。
  守卫缺口：`artificer-output-typebox.test.ts:52-63` 的 `Object.keys(ArtificerRuleOutputSchema.properties)` 只比较**第一层**；`GoldenTraceCaseInputTypebox` 另有独立测试（`:174-183`）但只做行为 Check，不比较与 `ArtificerRuleOutputSchema.properties.goldenTraceCases.items.properties` 的键集。
- **Why it matters**：`ruleContext` 恰是 v2 契约的关键字段（`DefaultArtificerValidator` 在 v2 时**要求每个 case 携带**它并跑 `validateRuleContextV2`）。typebox 侧把它声明为 `Type.Optional(Type.Unknown())`，@sinclair 侧则完全依赖 validator 手写检查。两份"等价"schema 对同一字段的存在性表达不同 —— 正是 §4.3 类型④，也正是 R-03 的同类根因（当年漏的是顶层 `evidenceRefs`，如今顶层已锁、嵌套未锁）。
- **Affected stage**：`artificer`（`submit_rulecode` tool 契约 vs registry schema）
- **Current protection**：顶层键集断言（有效但**作用域不足**）；嵌套层无对等断言。

### NEW-05 — 「prompt 教了机器不查的规则」在多个 stage 重复出现（模式登记）

- **ID**：NEW-05
- **Severity**：**P3**（模式级记账；单点已由 R-18 记录）
- **Claim**：R-18 不是孤例，而是一个跨 stage 的稳定模式：prompt 用强动词（MUST）声明一条**跨字段 / 依赖输入的**语义规则，而该规则既不在 TypeBox（无法表达跨字段）、也不在 semantic validator（validator 只收 `output`，看不到 input）。
- **Evidence**：
  | stage | prompt 承诺 | 执行面 |
  |---|---|---|
  | rootcause | `evidence 空 ⇒ confidence < 0.3`（`:245-247`） | 无（R-18） |
  | rootcause | `rootCauseCategory MUST match the category prefix in rootCause` | **有** —— `diag-rootcause-output.ts:318`（反例证明该模式**可以**被机器执行） |
  | scribe | `intentContract REQUIRED`（`:101`） | 无（NEW-02） |
  | artificer | `expectedDecision MUST be only "allow" or "block"`（`:215`） | **有** —— `artificer-output.ts:294-300`（v2 禁 `propose_correction`）+ `RULECODE_SPEC_TEXT` 重申 |
  | evaluator | `needs_revision ⇒ requiredChanges ≥1`（`:205`） | **有** —— `evaluator-output.ts:472` |
  | rollout_reviewer | `needs_revision (issues found but salvageable)`（`:52`） | **无**（R-13a） |
- **Why it matters**：同一条纪律在三处有执行面、在三处没有 —— 说明这不是能力限制，而是**逐 stage 手工补齐的遗漏**。有执行面的三处（rootcause 前缀、artificer 决策枚举、evaluator requiredChanges）可直接作为 `check:pipeline-contract` 的 invariant 模板。
- **Affected stage**：跨 stage
- **Current protection**：无统一机制；每处独立手写。

---

## 7. Protection Gaps（现有 test / guard 是否保护 prompt-schema parity）

| 待保护的 invariant | 现状 | 缺口 |
|---|---|---|
| Tool schema ≡ canonical schema（顶层） | ✅ `artificer-output-typebox.test.ts:52` 属性集断言 + `evidenceRefs` 哨兵 | 仅 artificer；仅顶层 |
| Tool schema ≡ canonical schema（嵌套） | ❌ | NEW-04 |
| **Prompt example 通过自身 semantic validator** | ❌ **完全无覆盖** | NEW-01 —— 现有测试只断言 `Value.Check`（结构），而语义约束全在 validator 里 |
| Prompt 声明的必填字段 ⊇ schema 必填字段 | ❌ | NEW-02（方向为 prompt 严于 schema） |
| Prompt 示例覆盖所有 v2 必填字段 | ❌ | R-02a —— `artificer-output-typebox.test.ts` 锁 schema 但不锁 **prompt 文本里的示例** |
| `generateConstraints` 覆盖所有约束关键字 | ⚠️ 仅 snapshot（捕获变化，不捕获缺失能力） | NEW-03 |
| 每个 stage 都有 semantic validator 层 | ⚠️ `correction-observer` 无独立 validator | §4.11 |
| 跨字段/依赖输入的规则有执行面 | ❌ | NEW-05（R-18 / R-13a / NEW-02） |
| registry ref 与 runner 实传 ref 一致 | ⚠️ 无守卫；本次人工核对一致（`signal-classification-output-v1` 由 plugin 层而非 core runner 使用，registry 覆盖无冗余） | latent |
| `taskId`/lineage 一致性 | ✅ 各 validator 均校验（rc-6） | — |
| `needs_revision ⇒ requiredChanges ≥1` | ⚠️ evaluator ✅ / rollout_reviewer ❌ | R-13a |

**总判断**：现有防护集中在**结构层**（TypeBox Check、属性集断言、snapshot），对**语义层**与**prompt 文本层**基本空白。R-03 的修复是唯一一处主动建立的 schema-parity 守卫，且其作用域（顶层属性集）已被 NEW-04 证明不足。

---

## 8. Suggested Contract Invariants

（只列 invariant，不含实现方案。）

**I-1 示例合法性**：每个 prompt builder 中作为 `COMPLETE EXAMPLE OUTPUT` / `OUTPUT FORMAT` 出现的示例对象，必须通过该 stage 对应的 semantic validator（不只是 `Value.Check`）。示例是契约的一部分，示例不合法即契约自相矛盾。

**I-2 示例完整性**：示例必须覆盖该 stage 契约中所有非 optional 字段，以及所有"条件必填"字段在其触发条件下的形态。

**I-3 required 单调性**：同一字段在 prompt 中声明为 REQUIRED 时，canonical schema 或 semantic validator 必须至少有一处机器可执行地要求它。prompt 的 required 不得严于机器的 required。（NEW-02）

**I-4 等价 schema 定义**：标注"field-for-field equivalent"的两份 schema 实现，必须在**所有嵌套层级**上具有相同属性集，而非仅顶层。（R-03 已满足顶层，NEW-04 未满足嵌套）

**I-5 约束可见性**：canonical schema 中存在的结构性约束（`minItems`/`maxItems`/`maxLength`/`pattern`）必须在模型可见文本（prompt constraints 或 tool 参数描述）中有对应表达，或显式记录为"故意不告知"。（NEW-03）

**I-6 判据字段可达性**：validator/consumer 读取的每个字段名，必须在 canonical schema 或 prompt 中出现至少一次。反之为悬空读取 —— 其后果是恒定降级而非显式失败。（R-09）

**I-7 不变量清单完整性**：Stage C 从 upstream 强制覆写的字段清单（`rootCause`/`evidence`/`confidence`/`intentTension` 所在清单）必须与被消费的语义载体字段集一致。（R-11）

**I-8 语义分支对称性**：同一语义不变量（如 `needs_revision ⇒ requiredChanges ≥1`）若在一个 agent 的 validator 中建立，必须在具有相同 decision 枚举的 peer agent 中同样建立，或显式记录不对称理由。（R-13a）

**I-9 prompt-validator 可执行性**：prompt 中以 MUST/MUST NOT 声明的**跨字段或依赖输入**的规则，必须有机器执行面，或被显式登记为"advisory only"。（NEW-05）

**I-10 registry 覆盖**：每个 registry ref 必须有生产 consumer；每个 runner 的 `outputSchemaRef` 必须能在 registry 中解析。（当前成立，无守卫）

---

## 9. Out of Scope

- **修复方案**：本报告只描述现状与 invariant，不提修复实现（含 guard 的具体检查逻辑、prompt 文案改法、schema 调整方式）。
- **R-19 A 面（沙箱逃逸的可达性/可利用性）**：属 Worker 侧其他分工。本报告 §4.7 只记录「RuleCode 相关 prompt 教了什么」这一 B 面事实（见下）。
- **R-19 B 面（仅记事实）**：`artificer-prompt-builder.ts:213` 明令 `implementationCode MUST be deterministic and self-contained: no imports, require, eval, Function, I/O, network, timers, Date.now, or randomness`；静态执行面 `rule-code-validator.ts:27-60` 的 `FORBIDDEN_PATTERNS` 覆盖 `require/import/export/async/await/fetch/eval/Function/process/globalThis/global/Reflect/Proxy/constructor/Buffer/setTimeout/setInterval/setImmediate/queueMicrotask/XMLHttpRequest/Math.random/crypto` 及 bracket access；`RULECODE_SPEC_TEXT`（`artificer-l2-tool-contract.ts`）向模型重申同一清单。**未发现 prompt 教过沙箱逃逸模式**；prompt 声明的约束与 validator 执行的约束方向一致（prompt 声明"什么不能做"，validator 检测同一批模式）。`rule-code-validator.ts:11-16` 记录了 PRI-668 的注释/字面量 masking 决策及其理由。**本报告不对该边界的充分性作判定。**
- **`Value.Cast` 兜底路径的修复**：§4.4 要求复核，事实如下 —— `schema-prompt-adapter.ts:185` `Value.Check(schema, example) ? example : Value.Cast(schema, example)`。实测证明该兜底**会静默产出违反 schema 约束的值**：对 `{tags: ['example']}`（schema 要求 `minItems:2`）执行 Cast 得 `{"tags":["example",""]}` —— 用空字符串**填充**以满足 `minItems`。该值随后通过 `Value.Check`，于是 `generateExample` 返回一个"看起来合法"的示例。这是 §4.3 类型⑥（normalizer 静默改语义）在 prompt 生成路径上的实例，与 NEW-01 同源（根因是 `generateValueForSchema` 只按 required 浅层生成 + Cast 兜底补齐）。**修复不在本任务范围。**
- **测试覆盖修改**：§7 指出的 guard 空白不在本任务范围。
- **Linear / GitHub 工单状态**：本环境零密钥，不做任何工单操作。
- **相对 `cdec05d4b` 的变化分析**：该 SHA 在本 checkout 不可得（见 §2 Drift Warning），无法执行。

---

## 附录 A — 复现方法

本报告的关键判定均可复现。生成示例与 validator 的对比测试模式：

```ts
import { DefaultSchemaPromptAdapter } from '<core>/runtime-v2/adapter/schema-prompt-adapter.js';
import { DiagRootCauseOutputV1Schema, DefaultDiagRootCauseValidator } from '<core>/runtime-v2/diagnostician/diag-rootcause-output.js';

const adapter = new DefaultSchemaPromptAdapter();
const example = JSON.parse(adapter.generateExample(DiagRootCauseOutputV1Schema));
example.taskId = 'task-1';
const result = await new DefaultDiagRootCauseValidator().validate(example, 'task-1');
// → { valid: false, errors: ['rootCause must start with "People: "...'], errorCategory: 'output_invalid' }
```

schema 属性集对比（R-03 / NEW-04）：

```ts
Object.keys(ArtificerRuleOutputSchema.properties).sort();            // 顶层 11 键 ≡ typebox
Object.keys(ArtificerRuleOutputSchema.properties.goldenTraceCases.items.properties).sort();  // 7 键 ≠ typebox 8 键
```

## 附录 B — 本次审计中执行过的检查

| 检查 | 结果 |
|---|---|
| `git rev-parse HEAD` | `191ae1af588a68950af1de5a3b9265771a7b3e8d` |
| `git cat-file -t cdec05d4b` | `fatal: could not get object info`（对象不存在） |
| `npm ci` | EXIT=0 |
| `node scripts/check-docs-structure.cjs` | `OK: docs/.private/ 0 tracked, 9 required files exist, 0 stray root .md files.` |
| vitest 复现 NEW-01（示例 vs validator） | `valid: false`，1 error（前缀不匹配） |
| vitest 复现 R-02（示例 vs validator） | `valid: true`（因缺 `requiresContextVersion` 未触发 v2 门控） |
| vitest 属性集对比（R-03 / NEW-04） | 顶层 11≡11；嵌套 7≠8 |
| vitest `Value.Cast` 静默填充 | `{tags:['example']}` → `{tags:['example','']}`，Check 通过 |
| 临时测试文件 | 已全部删除，未入库 |
