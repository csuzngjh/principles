# PRI-855 Context Intelligence Layer Coverage Audit

日期：2026-09-19 · 执行者：后端审计 AI · 性质：Architecture Audit / Reality Verification（零代码修改）

---

## Executive Summary

**PRI_855_RESULT = SPEC_REQUIRED**

本次审计在源码层面确认：PRI-838/839/846 之后，Formation Context 连接模式
（`resolveFormationContext()` → bounded projection → prompt）已在
Scribe / Artificer(部分) / Evaluator 三处落地，**上游 Dreamer→Philosopher 段与
下游 Owner 决策面（Activation / Console）仍存在有证据支撑的断链**。

7 项发现为 VERIFIED（断链机制有 file:line 证据），其中：

- **CIL-001（P2，正确性）**：Artificer 的 context hash 未覆盖其 prompt 实际携带的
  dreamer 候选集——同一仓库在 Scribe 与 Evaluator 两处已明确声明并修复过该不变量，
  Artificer 是唯一漏网者。属既有模式内的偏差，非新设计。
- **CIL-002（P1，Owner 面）**：Owner 决策评审（`buildOwnerDecisionReview`）经血缘
  BFS **已经把诊断工件取进内存**，却只向 Owner 报告祖先工件的 `taskKind` 名单；
  rootCause / violatedPrinciples / evidence 一律不呈现。Owner 批准原则时看不到产生
  它的 pain——与 PRI-843 修复前的 Evaluator 断点同构，且本仓库已用 +85.7pp 实验
  证明"看见来源意图"提升产出质量。
- **CIL-003（P2）**：Activation 审批卡读取 `painReasonSummary`，但全仓生产代码中
  该字段**没有任何写入者**——一条半建成的死连接。
- **CIL-004（P2）**：Philosopher 结构上无法触达诊断（任务图单跳依赖 + 无 resolver
  调用），而它已持有 `resolveFormationContext` 所需全部四个参数。连接可行性
  VERIFIED；质量收益 NO QUALITY EVIDENCE，建议先测量后 SPEC。
- **CIL-005（P2，发生条件 UNKNOWN）**：Dreamer 唯一的诊断通路脆弱——候选仅带
  `artifactId` 无 `taskId` 时 `dependencyTaskIds` 为空，运行静默降级为
  `predecessorOutput: null`；同一任务行上写好的 `artifact://` 诊断引用从未被解析。
- **CIL-006（P2，已知未修）**：`sourcePainId` 是 LLM 依 few-shot 示例编造的字符串，
  而任务记录里有真值。PRI-838 §7.4 已登记为 follow-up，本次确认仍未修复。
- **CIL-007（P3）**：Artificer 的 truncationNotes 只进事件不进 prompt（Scribe 会向
  模型披露截断）；且所有 `*_formation_*` resolver 事件不在持久化 allowlist 内，
  截断证据进程退出即消失。

RuleHost / Replay / Validation 的 DISCONNECTED 均有明文架构边界（INV-05 /
zero-I/O contract）支撑，判定 **NOT A BUG**。`pain_diagnoses` 表为
flag-off 的休眠能力，判定 **Category C（配置/推广问题）**，不是开发问题。

---

## Evidence Rules

- **VERIFIED**：本审计直接读源码核对过 file:line（下文引用的行号均在 HEAD 上
  人工复核，非仅转述）。
- **INFERRED**：由多项 VERIFIED 推断，明确标注 `Inference:`。
- **NOT VERIFIED / UNKNOWN**：无法从仓库确认（如需生产 DB 探测），如实标注。

### Baseline

```text
BASE_SHA       = ac41ef6e736fbece6f55aa3323a1732b78e7f2b4
current branch = main（与 origin/main 一致）
PR #1756       = a07981c9 已确认在 main（PRI-838 formation context recovery）
PR #1766       = ac41ef6e 已确认在 main（PRI-846 evaluator formation context）
```

---

## Current Pipeline Map

全部由源码调用链建立，非文档转录。`⌘` 表示已连接 formation context。

| Stage | Producer | Consumer | 读取方式 | Evidence |
|---|---|---|---|---|
| Pain | `pain_events`(trajectory.db)：`pain-signal-observability.ts:149-188`；Owner 纠正 `correctionEvidence`：`context-payload.ts:134-147`，写入 `pain-signal-bridge.ts:372-374` | Diagnostician 上下文装配器（唯一 prompt 通路） | `sqlite-context-assembler.ts:230-237, 404-425` → `rootcause-prompt-builder.ts:186-205` | PRI-844 (f7226af6) 已连根因阶段；distiller/router prompt 无纠正证据消费（NOT VERIFIED 是否应有） |
| Diagnosis | diag_rootcause/distiller/router → `pi_artifacts`（`diag-router-runner.ts:321-330` 等）+ legacy `artifacts.kind='diagnostician_output'`（committer 双写） | Dreamer | `dreamer-runner.ts:161-172`：第一个 succeeded 依赖的**第一个工件**全文 `predecessorOutput`，无预算、无 taskKind 过滤 | ⌘ 已连（全文未截断）；fragility 见 CIL-005 |
| Dreamer | `dreamer-runner.ts:266-279` 写 `pi_artifacts`(kind='principle') | Philosopher | `philosopher-runner.ts:165-176`：`listBySourceTaskId(depId)` 首工件全文 | 候选全量到达 ✅；诊断不可达 ❌（CIL-004） |
| Philosopher | `philosopher-output.ts:23-28,40-52`（仅 `{thesis, principleCandidate(单个), risks}`，无被否候选记录） | Scribe | `scribe-runner.ts:202-211` 首工件全文 | DC-2 仍未落盘（PRI-835:89 登记） |
| Scribe ⌘ | `scribe-runner.ts:410-419` | Artificer | `artificer-runner.ts:729-753` | PRI-838：`resolveFormationContext` 于 `scribe-runner.ts:219-225`，投影进 prompt `scribe-prompt-builder.ts:232` + 冻结 addendum `:75-91` |
| Artificer ⌘(半) | `artificer-runner.ts:983-996` | Evaluator | `evaluator-runner.ts:513-518` | PRI-839：仅 `projectDreamerProposals`+`summarizeCandidateDifferences`（`artificer-runner.ts:44,246-347`），**无 sourceDiagnosis / provenance** |
| Evaluator ⌘ | verdict `:853-862`；rule `:3192-3229` | Activation | `activation-dispatcher.ts:402-404`(近似行,读工件)、`writers/rule-host-writer.ts:394-410` | PRI-846 (ce788eb4)：`evaluator-runner.ts:535-542` 从 scribe 权威 id 解析 + `:2075-2083` `principle_pain_mismatch` 路由到 needs_human_review |
| Activation | approvals / activations 表 | Owner（Console 决策面） | `OwnerDecisionConsoleModel.ts:20,179` → `buildOwnerDecisionReview` | ❌ 诊断内容被获取后丢弃（CIL-002）；`painReasonSummary` 无生产写入者（CIL-003） |
| RuleHost | — | 运行时 VM | `rule-host-contracts.ts:21-58` `RuleHostInput` 无任何 artifact/lineage 字段 | **设计如此**（`rule-context-v2.ts:1-19` zero-I/O 宪章，INV-05）→ NOT A BUG |
| Replay/Validation | replay 证据进修复 prompt（`repair-replay-resolver.ts:303-324` 读 evaluator 工件） | Artificer | `artificer-runner.ts:646-652,786-790` | 域内已连；对 formation 证据 DISCONNECTED-BY-DESIGN |

关键结构事实（VERIFIED）：**formation 证据只存在于 prompt，从不落盘于工件**。
`ScribeOutputV1`（`scribe-output.ts:30-45`）无 formationContext 字段，工件写入即
`contentJson: JSON.stringify(output)`（`scribe-runner.ts:416`）；evaluator rule 内容
（`evaluator-runner.ts:3192-3212`）字段清单中无 pain/dreamer/diagnosis。任何下游
（含 Console、回放、审计）都无法重建"当时模型被展示了什么"。
`Inference:` 这限制了未来一切质量归因实验的可观测性。

---

## Context Producer Inventory

| Data Source | Exists | Storage | Producer | Consumers（除 formation-context.ts 外） | Evidence |
|---|---|---|---|---|---|
| Dreamer 候选集（1–5）| Y | `pi_artifacts.contentJson` | `dreamer-runner.ts:266-279` | Scribe/Evaluator(经 resolver)、Artificer(经 projectDreamerProposals) | formation-context.ts:294,307 |
| 诊断投影（rootCause/violated/evidence/recommendations）| Y | `pi_artifacts`（diag_* 行，kind 均为 'principle'，阶段身份只在 task 行） | `diag-*-runner.ts` 各自 :288-330 | 仅 Scribe/Evaluator | `formation-context.ts:464-468,688-702,748` |
| Provenance（`sourcePainId`、`lineageArtifactIds`）| Y | dreamer 工件行 + task `pi_metadata` | `base-peer-runner.ts:493-517`；pain id 为 LLM 输出 | Scribe/Evaluator prompt；Activation 仅做**存在性**核验 | `formation-context.ts:775-776`；`promotion-evidence-snapshot.ts:68-70`；`promotion-readiness-reader.ts:41-42` |
| 真 `sourcePainId` | Y | dreamer seed 的 `diagnosticJson` 顶层 | `internalization/intake-to-internalization-bridge.ts:248` | **无** —— runner 从不读取（CIL-006） | grep dreamer/philosopher `pain`=0 命中 |
| `inputArtifactRefs`（含 `artifact://` 诊断引用）| Y | 同上 `:213-222` | 同 | **无消费者解析**（CIL-005 的回退素材已在场） | `dreamer-runner.ts:130-187` 仅读依赖的 outputRefs |
| `pain_diagnoses`（pain 键控的结构化诊断，跨 run 1:N）| Y | state.db（DDL `store/sqlite-connection.ts:678-691`） | `pain-signal-bridge.ts:707-751`，**flag `pain_diagnosis_persistence` 默认 OFF**（`feature-flag-contract.ts:372`，已核实） | **零生产读取者**：`getDiagnosesByPainId` 全仓仅 store/facade/测试命中（已 grep 核实） | → Category C |
| `correctionEvidence`（PRI-844）| Y | `tasks.diagnostic_json` | `pain-signal-bridge.ts:372-374` | 唯一读取者 `sqlite-context-assembler.ts:404-425` → rootcause prompt | 已连（窄路：仅根因阶段） |
| Philosopher 被否候选 | **N** | — | 无落盘（DC-2） | 无从谈起 | `philosopher-output.ts:23-28,40-52` |
| `*_formation_*` resolver/truncation 遥测 | Y(瞬时) | 进程内 EventEmitter | `formation-context.ts:710-790` | **不在持久化 allowlist**（`workspace-telemetry-emitter.ts:36-42` 六个事件名，已核实） | → CIL-007 关联 |
| ArtifactSummary envelope | Y(定义) | 无生产写入者 | `artifact-summary.ts:86-90` 仅 Owner 评审即时派生 `:266-269` | — | 悬空定义，不立项（Phase 6） |

---

## Consumer Matrix

| Consumer | 现在读什么 | Formation Context 状态 | 断链证据是否闭合 |
|---|---|---|---|
| Dreamer | 诊断工件全文（条件性，见 CIL-005）| **CONNECTED（脆弱）** | 上游 pain 真值/引用在场不读 ✅ |
| Philosopher | dreamer 工件全文 | **DISCONNECTED**（诊断结构不可达；已握有 resolver 全部入参）| ✅（CIL-004）|
| Scribe | philosopher 全文 + resolver 投影 + addendum | **CONNECTED**（PRI-838，含 cache identity `scribe-runner.ts:227-244`）| n/a |
| Artificer | scribe 全文 + dreamer 候选投影 + 行为例包/对抗/修复反馈 | **PARTIAL**：候选 ⌘；诊断/provenance ❌；**hash ❌**（CIL-001）；无 philosopher critique 却被告知尊重它（`artificer-prompt-builder.ts:296,299`，NOT VERIFIED 是否有意）| ✅ |
| Evaluator | artificer + scribe 原文 + resolver 投影 + mismatch 路由治理效应 | **CONNECTED**（PRI-846，`evaluator-runner.ts:528-558,2063-2083`）| n/a（但证据不落盘，见结构事实）|
| Activation | rule/principle 工件；lineage 仅存在性核验；审批卡 fallback 文案 | **DISCONNECTED** | ✅（CIL-002/003）|
| RuleHost | 冻结 runtime snapshot | DISCONNECTED **BY DESIGN**（INV-05）| NOT A BUG |
| Replay/Validation | evaluator 工件的 replay 判定；3/5 模块 pure-by-contract | DISCONNECTED **BY DESIGN** | NOT A BUG |
| Console | 决策面经 `buildOwnerDecisionReview`；证据链面自带 SQL 读 pain/diagnosis（`EvidenceChainConsoleModel.ts:194-313`，:312 已核）| **DISCONNECTED（决策面）** —— 与证据链面不 join | ✅（CIL-002）|

---

## Verified Findings

### CIL-001 · P2 · VERIFIED — Artificer context hash 未覆盖 prompt 实际携带的候选集

- **Problem**：PRI-839 给 Artificer prompt 注入了 dreamer 候选集，但 cache 身份仍只覆盖 scribe 工件。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts:751` — `contextHash: BasePeerRunner.hashContextRefs([artifactRef])`（artifactRef = scribe 一条）
  - 对照 Scribe：`scribe-runner.ts:226-244` 把 `formationContext.provenance.sourceDreamerArtifactId` + 诊断 id 折入 refs
  - 对照 Evaluator：`evaluator-runner.ts:544-557`，注释原文："*The context hash must cover the evidence the prompt actually carries … otherwise replay/cache could serve a prompt that predates the formation evidence*"
  - `git log -L` 显示 artificer 该行自 PRI-508/509（10607949f / b43c138e）未动（研究代理核验；本次未重复执行）
- **Impact**：dreamer 工件被 upsert 重写（`sqlite-pi-artifact-store.ts:75-88` 原地换 artifact_id/content）后，Artificer 可能命中旧 cache、跑在候选集变更前的 prompt 上，且回放无法归因。
- **Why not solved**：resolver 自身不管 cache identity；两处已修复的消费者各修各的，没有跨消费者守卫。
- **Action**：小型修正 SPEC——把 `dreamerContext` 的 artifact id 折入 hash，与 scribe/evaluator 同构。`Confidence: high`。

### CIL-002 · P1 · VERIFIED（断链）/ INFERRED（影响）— Owner 决策面丢弃自己已经取到的诊断内容

- **Problem**：Owner 批准原则时，评审代码已把包括 `diag_*` 在内的祖先工件全部取进内存，却只呈现"存在哪些阶段名"，rootCause/evidence 永不露出。
- **Evidence**：
  - `owner-decision-review.ts:221-236` BFS `getArtifactById`+`getTask`；`:250-261` `selectLineageArtifact` 只保留 `'artificer' | 'scribe'`；`:377-379` 对余下工件**只读 taskKind**；`:400-406` checklist note 即 taskKind 名单
  - `OwnerDecisionConsoleModel.ts:179` 决策视图直接消费该 snapshot；`OwnerDecisionViewModel.ts:628` 连 `lineage_artifact_ids` 列都查了
  - 诊断内容在 Console 有展示能力，但在**未 join 的另一面**：`EvidenceChainConsoleModel.ts:194-313`
  - 设计注释 `:359-373` 只承诺"报告 durable 事实、不冒充质量判断"——呈现 rootCause 文本恰是事实而非判断；注释 R3 反例 1（`:367-368`）自认 lineageResolvable "不足以宣称证据来源"
- **Inference**：与 PRI-843 修复前的 Evaluator 同构（"is the principle faithful to the pain" 无法被问）；PRI-815/838 已测得来源意图注入使 Scribe 质量 +85.7pp。对 Owner 裁决的同幅提升未测量。
- **Action**：Category B。建议 SPEC（Owner 决策面 bounded 诊断投影，复用 `resolveFormationContext` / `FormationDiagnosisProjection` 现成契约，不新建抽象）。

### CIL-003 · P2 · VERIFIED — 审批卡 `painReasonSummary`：有读者、无生产写者

- **Evidence**：
  - 读者：`activation/writers/rule-host-writer.ts:395-411`（缺省回退泛化文案）
  - 写者：全仓 grep 仅 demo/legacy fixtures（`proven-channel-baseline.ts`、`story-a-demo.ts`）与测试注入；生产 rule 内容字段清单 `evaluator-runner.ts:3192-3212` 不含该字段
  - 同文件测试 `rule-host-writer.test.ts:931` 锁定了"缺失时稳定回退"——回退是常态
- **Impact**：v2 生产链路的 code_tool_hook 审批卡永远不显示 pain 来源。属半建成连接（与 CIL-002 同主题：Owner 证据面）。
- **Action**：与 CIL-002 合并为同一 SPEC 范围（决策面呈现什么、由哪个权威供给），避免为补字段再造第二写入者（P4）。

### CIL-004 · P2 · VERIFIED（连接缺口与可行性）/ NO QUALITY EVIDENCE（收益）— Philosopher 拿不到诊断

- **Evidence**：
  - 任务图：`internalization-state-machine.ts:376-385` `dependencyTaskIds: [currentTask.taskId]`（仅 dreamer，单跳）
  - `philosopher-runner.ts:140-179` 只走一跳、只取首工件，无 `getArtifactById`/`lookupTask`；payload 四字段 `{taskId, contextHash, dreamerArtifact, sourceDreamerArtifactId}`（`philosopher-prompt-builder.ts:135-141`；测试 `philosopher-prompt-builder.test.ts:45-70` 锁定）
  - 可行性：`sourceDreamerArtifactId` 已在手（`philosopher-runner.ts:173`）+ `this.artifactStore` + `stateManager.getTask` + `emitEvent` = resolver 四参数齐备（对照 `formation-context.ts:455-473`）
  - 后果面：philosopher 被要求产出泛化 thesis（prompt `:87`）却无 rootCause/evidence 可校对；其输出 `principleCandidate` 仅单个且**不记录被否候选**（`philosopher-output.ts:23-28,40-52` = DC-2，另案登记）
- **NOT VERIFIED**：无任何注释/AUDIT 声明"Philosopher 故意不看诊断"；PRI-835:174 记录了该边形状但未列为 DC 项。
- **Action**：先做小样本 A/B（同 PRI-815 harness 形状）再决定是否 SPEC；不直接立项开发。

### CIL-005 · P2 · VERIFIED（机制）/ UNKNOWN（生产发生频率）— Dreamer 诊断单通路 fragility

- **Evidence**：
  - `intake-to-internalization-bridge.ts:296-307` 准入只要求 `taskId|artifactId|sourceRunId` 三者其一；`:224-228` 但 `dependencyTaskIds` **仅**来自 `sourceTaskId` ⇒ artifactId-only 候选得到空依赖（测试锁死：`intake-to-internalization-bridge.test.ts:283-294`，研究代理引用）
  - `dreamer-runner.ts:141,143` 空依赖 → `predecessorOutput` 静默为 `null`，运行继续（`dreamer-prompt-builder.test.ts:191-198` 将 null 视为受支持形态）
  - 同时 `:213-222` 已在同一 seed 写入 `artifact://<diagnostician_output>` 引用，`dreamer-runner.ts` 从不解析（imports `:17-32` 无任何按 id 读工件的路径；`formation-context.ts:714` 是该层唯一 `getArtifactById`）
  - 有依赖时也仅取**第一个**工件且无 taskKind 过滤（`:161-164`），而 resolver 为此发明了 `FORMATION_DIAGNOSIS_TASK_KINDS` 优先序（`formation-context.ts:83,695-700`）
- **NOT VERIFIED**：生产 candidate 是否存在 artifactId-only 案例（需只读 DB 探测）。
- **Action**：最小修正是"依赖为空/不匹配时回退解析 `inputArtifactRefs` 的 artifact:// 引用"——纯连接修复、零新抽象。若生产探测证实为零发生，降级为 CIL-005b（first-artifact 无 kind 过滤）单列。

### CIL-006 · P2 · VERIFIED · 已知未修 — `sourcePainId` 由 LLM 编造并充当溯源权威

- **Evidence**：任务行写有真值（`intake-to-internalization-bridge.ts:248`）但 dreamer 不读；
  prompt few-shot 示例含 `"sourcePainId":"pain-null-crash"`（`dreamer-prompt-builder.ts:91`）且约束仅说
  "optional string"（`:106`）；下游 `formation-context.ts:349,775` 把工件里的这个字符串原样抬进
  `FormationProvenance.sourcePainId`。对照同文件 `:105` 对 `sourcePrincipleId` 有显式反编造规则 +
  `stripFabricatedCorePrincipleIds`（`dreamer-runner.ts:346`）——同类风险一处设防一处裸奔。
- **PRI-838 §7.4 已登记**（`docs/audit/PRI-838-839-formation-context-connection-repair.md:533` 节内 "sourcePainId never populated"）。本次确认代码现状未变。
- **Action**：归入 CIL-005 同一 SPEC（同一条数据链：seed 真值 → runner 注入 → 工件即权威）。

### CIL-007 · P3 · VERIFIED — 截断可观测性两处不对称

- **Evidence**：Artificer 的 `truncationNotes` 只 `emitEvent('dreamer_context_partial')`，返回对象仅 `{candidates, differenceSummary, omittedCandidateCount}`（`artificer-runner.ts:331-346`，本次直接核实），模型无从得知"看到的是有界视图"（Scribe addendum 则有降级披露义务 `scribe-prompt-builder.ts:90`）；且所有 `*_formation_*` 事件不在持久化 allowlist（`workspace-telemetry-emitter.ts:36-42`，本次直接核实）⇒ 事后无法回答"这次降质是证据不足还是预算截断"。
- **Action**：不单独立项；作为 CIL-001/002 SPEC 的观察性随附项记录。

---

## False Positives Reviewed

| # | 表面断点 | 判定 | 证据 |
|---|---|---|---|
| F1 | RuleHost 不读 formation context | **NOT A BUG** | `rule-host-contracts.ts:21-58` 无字段可承载；`rule-context-v2.ts:1-19` zero-I/O 宪章 + 架构回归测试；INV-05 边界（PRI-815 文档 :633,:692）|
| F2 | Replay/Validation 不读诊断 | **NOT A BUG**（4/5 pure-by-contract；`repair-replay-resolver.ts`、`adversarial-loop.ts` 有 store 但契约限定判定机制）| 各文件头注释（研究代理引 :2-25）|
| F3 | `pain_diagnoses` 无人读 | **Category C 配置/推广** | 写入受默认 OFF 的 `pain_diagnosis_persistence` 门控（`feature-flag-contract.ts:372`，已核实）；表空是 flag 状态而非缺码 |
| F4 | Artificer 无 sourceDiagnosis | **NOT VERIFIED 理由的既定契约**，非事故 | `formation-context.ts:32-34` 声明 Artificer 份额=candidates+differences；PRI-839 票面即 "Candidate Expansion"；但找不到"为何不需要来源意图"的论证——留作 CIL-004 类测量议题，不立项 |
| F5 | Philosopher 输入被截断风险 | 不存在 | 输入边未设限（无 FORMATION_* import），与 Dreamer 同为全文直达 |
| F6 | `ArtifactSummaryEnvelope` 悬空定义 | **Future Idea** | 无写入者无读取者（`artifact-summary.ts:77-90` 仅定义+注释引用），清理属 PRI-819 类工作 |
| F7 | Console `[principle_pain_mismatch]` 无专属渲染 | 已可经 generic concerns 到达 Owner（`owner-decision-review.ts:466-468`）| 专属呈现 = 锦上添花，无质量证据，**Future Idea** |
| F8 | Dreamer/Philosopher payload 无预算上限 | 现状非缺陷 | 诊断/dreamer 全文边自 PRI-107 起即如此；预算体系（PRI-815/R-06）明确只管投影边；无溢出事故证据 |

---

## Priority Recommendation

```text
优先级 1（建议 SPEC，合并范围）:
  「Owner 决策证据面连接」 = CIL-002 + CIL-003（+CIL-007 观察性随附）
  理由: 唯一直接作用于 Owner 裁决质量的断链；复用现成
       resolveFormationContext/FormationDiagnosisProjection 契约；
       PRI-843→846 已给同构修复走完 设计→实验→落地 全流程。

优先级 2（小型修正 SPEC，可独立先行）:
  CIL-001 Artificer context hash —— 一行语义的既有模式收敛，
  属正确性缺陷而非设计增强，Change surface 最小。

优先级 3（先测量后立项）:
  CIL-004 Philosopher 诊断可达性、F4 Artificer 诊断需求
  —— 连接可行性 VERIFIED，但收益 NO QUALITY EVIDENCE；
  用 PRI-815/841 harness 形状做小样本 A/B 再裁。

优先级 4（与 3 并行、只读探测）:
  CIL-005 生产 DB 探测（candidate lineage 字段分布）→ 决定是否
  连同 CIL-006 立项「pain 真值贯通」。

不立项: F1–F3、F5–F8（设计边界 / 配置问题 / 无证据的 nicer-to-have）。
DC-2（Philosopher 被否候选落盘）维持 PRI-835/841 既有登记,不重复立项。
```

## Next Actions

1. Owner 裁决：是否批准优先级 1（建议卡建议 ticket 名：`PRI-855A owner-decision-evidence-surface`）与优先级 2。
2. 生产只读探测：candidate 表 `task_id/artifact_id/source_run_id` 空值分布（解 CIL-005 UNKNOWN）。
3. 若做优先级 3，复用 `scripts/` 下 PRI-841 harness（配额 2026-09-22 重置后可续跑）。
4. 本审计对 `formation evidence 不落盘`（Pipeline Map 末段）不立项：改 schema 属新持久化事实源，Complexity Delta 不划算，除非未来回放归因出现实际需求。

---

## Final Classification

- **Category A（已解决）**：Scribe(PRI-838)、Evaluator(PRI-846)、Artificer 候选集(PRI-839)、Owner 纠正证据→根因阶段(PRI-844)。
- **Category B（真实断链，建议 SPEC）**：CIL-001、CIL-002、CIL-003、CIL-004（需先测量）、CIL-005/006（需先探测）。
- **Category C（配置/推广）**：`pain_diagnoses` 休眠（F3）。
- **Category D（仅理论改善）**：F5–F8 全部。

```text
PRI_855_RESULT=SPEC_REQUIRED
VERIFIED_FINDINGS_COUNT=7
INFERRED_FINDINGS_COUNT=2   (CIL-002 质量影响、Pipeline-Map 结构事实的归因限制)
UNKNOWN_COUNT=3             (CIL-005 生产发生频率；F4 排除诊断的理由是否存在；correctionEvidence 是否应达 distiller/router)
```
