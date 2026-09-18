# PRI-835 — Formation Context Connectivity Audit

## PD 数据管道信息连通性只读审查

> **报告类型**：只读架构审计（Read-Only Architecture Audit）
> **审计对象**：PD Core Value Pipeline 的信息连通性（Formation Context Connectivity）
> **日期**：2026-09-18
> **核心问题**：PR #1753 证明「恢复 formation evidence 输入」可显著提升 Principle 输出质量（+85.7pp）。PD 是否早已设计共享信息池 / Formation Context / Progressive Disclosure 机制？若存在，为什么没有成为生产默认路径？

---

# 0. Baseline（Phase 0）

```text
BASE_SHA                = 89eb275e33f6f072ace012c5285ae3f3b498f0a8   (origin/main, 2026-09-18 12:30:17 +0800)
BASE_SHA_SUBJECT        = Merge pull request #1746 from csuzngjh/ai/PRI-799-phase-c-final-cutover
LOCAL_WORKTREE_SHA      = fad746fc  (branch=main, 落后 origin/main —— 本地 checkout 早于 R-06 与 PR #1753)
REPO                    = D:\Code\principles
RELATED_WORKTREE        = D:\Code\_worktrees\principles\PRI-815-trinity-quality-first @ b81a3188  (= PR #1753 head)
WORKSPACE               = C:\Users\Administrator\WorkBuddy\2026-09-18-17-34-30
PRODUCTION_PD_HOME      = D:\.openclaw\workspace\.pd
INSTALLED_RUNTIME       = 1.245.2   (update-history.json, 2026-09-16T13:44:00Z)
PROBE_HARNESS           = D:\pd-probe-835\   (repo 外，符合隔离要求)
```

**production state: READ ONLY** — 本审计的所有查询满足：

- 不写 DB（`new Database(path, { readonly: true, fileMustExist: true })`）
- 不生成 production artifact
- 不触发 agent run
- 不修改源码 / 配置 / feature flag / Linear / 未创建 PR

### 0.1 一条必须先声明的时序事实

本审计的两个关键事件发生在**同一天相隔 1 小时**：

| 时间 (2026-09-18) | 事件 | commit |
|---|---|---|
| 09:45 | **R-06（Owner 决策）**：退役三个 dormant progressive-disclosure flag，**删除**共享信息平面的全部运行时模块 | `0a8fa715` |
| 10:45 | **PR #1753 合并**：实验证明「恢复 formation evidence」→ 质量 +85.7pp | `0dc70ee6` |
| 12:30 | origin/main HEAD | `89eb275e` |

即：**承载该类连接修复的通用机制被删除后 1 小时，证明该类问题真实且高价值的实验才被合并。** 本审计所有结论绑定 `89eb275e`（两事件之后的状态）。

### 0.2 已遵守的硬约束

```text
禁止修改源码          已遵守（本报告为唯一新增文件，docs/ 文档，未提交）
禁止修改数据库        已遵守（只读连接）
禁止创建 PR           已遵守
禁止修改生产配置      已遵守
禁止修改 feature flag 已遵守
禁止修改 Linear 状态  已遵守
```

---

# 1. Executive Summary

## 1.1 三个直接答复

**Q1：PD 是否已经设计了共享信息池 / Formation Context / Progressive Disclosure 机制？**

**是。设计完整，且已实装过，然后被删除。**

- **设计**：`docs/superpowers/specs/2026-07-14-internalization-progressive-disclosure-design.md`（871 行，**在 origin/main 中**）。标题即「内化管道上下文工程：渐进式披露设计方案」，针对工单族 **PRI-511/512/513「信息共享池三层级」**。设计出三层信息架构（TL;DR / 结构化摘要 / 原始详情）+ ContextManifest 声明式需求 + PromptBudgetManager 硬预算 + CandidateLineage 跨级回溯 + 两阶段评估。
- **实装**：`1ce9d825 / d83cb2bb`（PRI-634 PR A/B，2026-09-03 合并）把 Layer 2（CandidateLineage ancestry）接进真实 Agent 生产上下文路径，完成三层 fact-acquisition 通道合成。principles-core 8 个文件 +1860/−57 行。
- **删除**：`0a8fa715`（PRI-819 R-06，2026-09-18）以「dormant 从未 graduation」为由，删除 `context-manifest(s).ts` / `context-resolution.ts` / `resolve-injection.ts` / `prompt-budget-manager.ts` / `candidate-lineage.ts` / `progressive-evaluator.ts` / `attach-summary-envelope.ts`，并把三个 flag 转为 `gone` 墓碑。

> `FormationContext` / `ContextPool` / `ContextRegistry` / `EvidenceStore` / `LineageResolver` / `ArtifactContext` / `ProgressiveDisclosure` / `ProgressiveLoading` 这 8 个命名**从未在代码中出现过**（`git grep -l -i` 在 origin/main 全仓 0 命中）。PD 的实际命名是 **ContextManifest / CandidateLineage / Progressive Disclosure 三层架构**。

**Q2：为什么没有成为生产链路默认路径？**

三个串联原因，逐条有实证：

1. **三层 flag 全部 default OFF 且从未 graduation**。`d83cb2bb` 的提交信息原文：「**feature flags 保持默认 OFF（无 graduation）**」。PRI-634 PR B 只完成了「接线」，没有完成「启用」。
2. **Layer 1 被启用但结构上必然失效**（Owner 只开了后两层，缺 Layer 0 写入侧）。见 §4.2 —— 这是「开关打开但依然是 no-op」的经典形态。
3. **一条上游数据通道在生产上 100% 为空** —— MEASURED：生产库 320 个 PI artifact 中，带 `predecessorSummary` 的 **0 个**，带 `summary` 信封的 **0 个**。缺 Layer 0 ⇒ manifest 路径结构性 absent ⇒ 恒 fallback。

**Q3：PR #1753 根因分类？**

**类别 B —— 已有数据 + 已有接口 + 已有先例，只是没有连接。** 但必须补一条限定：**通用载体已被移除**（详见 §7）。PR #1753 的 Arm B 修复发生在**实验 harness 的 prompt addendum**，而不是开启共享信息平面。

## 1.2 发现的 disconnected capability（按价值排序）

| ID | 断点 | 性质 | 证据强度 |
|---|---|---|---|
| **DC-1** | **Scribe 拿不到 dreamer 候选内容 / 诊断证据 / 原始 Pain** | 结构性丢弃（不是预算截断） | **MEASURED**（PR #1753 实验 +85.7pp；生产 31/33 dreamer 为多候选） |
| **DC-2** | **Philosopher 不记录「被否定的候选」** | 语义信息未落盘 → 下游无从恢复 | MEASURED（全仓无 `rejectedCandidate*` 字段） |
| **DC-3** | **Artificer 只消费 `candidates[0]`** | 已有能力被人为收窄 | MEASURED（`resolveDreamerContext` 显式取 `[firstCandidate]`） |
| **DC-4** | **Evaluator 的风险/failed cases 不回写 Principle** | 无回写边（仅窄路：rollout needs_revision → scribe） | 代码结构判定 |
| **DC-5** | **运行时反馈（block/receipt）只到观测面，不到学习面** | 观测闭环 ≠ 学习闭环 | 与 PRI-750 D-1/D-2 一致 |

## 1.3 最重要的一条结构性观察

**链条后段的证据比前段更丰富，呈现「倒挂」。**

```text
Scribe    （产出 canonical Principle + intentContract） ← 只拿到 philosopher artifact
   ↓
Artificer （产出 RuleCode）                            ← 拿到 pain lineage 证据包 + dreamer 五维
                                                            + intentContract + antiPatterns
                                                            + repair/adversarial/revision 反馈
```

定义「Owner 意图」的阶段（Scribe）拿到的上下文最少；**实现该意图**的阶段（Artificer）拿到的上下文最多。PR #1753 的 +85.7pp 正是修复这个倒挂。

---

# 2. Context Architecture Map（Phase 1）

## 2.1 命名组件存在性（origin/main，`git grep -l -i` over `packages/**/*.ts`）

| 组件 | 存在 | 用途 | 当前消费者 |
|---|---|---|---|
| **ContextManifest** | ⚠️ **曾存在，R-06 已删除** | runner 声明式声明「我需要哪些前驱字段」（design §4.2） | **0**（删除前也仅被 flag-gated 分支读取） |
| **context-manifests.ts**（SCRIBE_/ARTIFICER_/EVALUATOR_MANIFEST） | ⚠️ 曾存在，已删除 | 逐阶段 manifest 常量 | **0** |
| **ContextResolver / context-resolution.ts** | ⚠️ 曾存在，已删除 | 按 manifest 提取字段 + 预算分配 + `context_truncated` 事件 | **0** |
| **PromptBudgetManager / prompt-budget-manager.ts** | ⚠️ 曾存在，已删除 | token 硬预算 + 优先级截断 | **0** |
| **CandidateLineage / candidate-lineage.ts** | ⚠️ 曾存在，已删除 | 跨级血缘回溯 + request-scoped cache | **0** |
| **ProgressiveEvaluator / progressive-evaluator.ts** | ⚠️ 曾存在，已删除 | evaluator 两阶段（Stage1 摘要 / Stage2 raw 回溯） | **0**（evaluator 现为单阶段） |
| **attach-summary-envelope.ts**（Layer 0 writer） | ⚠️ 曾存在，已删除 | 写入侧 ArtifactSummary 信封 | **0** |
| **ArtifactSummary / `deriveArtifactSummary`** | ✅ **存在（唯一幸存者）** | 从已校验结构化输出派生有界摘要 | `owner-decision-review.ts:266`（Owner 决策评审卡片） |
| **FormationContext** | ❌ 不存在 | — | — |
| **ContextPool / ContextRegistry** | ❌ 不存在 | — | — |
| **EvidenceStore / LineageResolver / ArtifactContext** | ❌ 不存在 | — | — |
| **ProgressiveDisclosure / ProgressiveLoading** | ❌ 不存在（仅作散文名出现） | — | — |

## 2.2 「共享信息池」的真实载体（生产在用，非 flag-gated）

设计被删除后，同类能力以 **bespoke resolver** 形态继续存在于生产：

| 载体 | 位置 | 形态 | 谁消费 |
|---|---|---|---|
| **`resolveDreamerContext`** | `internalization/artificer-runner.ts:228-344`；调用点 `:740` | 手写单跳：读 scribe artifact 的 `sourceTrace.dreamerArtifactId` → `artifactStore.getArtifactById` → 抽 `candidates[0]` 五维 | Artificer prompt |
| **`resolveRevisionFeedback`** | `internalization/scribe-runner.ts:255-265`；同形实现在 artificer | 读 `PITaskMetadata.revisionFeedback` → 追加 `<revision_feedback>` 块 | Scribe（修订轮）、Artificer |
| **`BehaviorExamplePack`** | `internalization/behavior-example-pack.ts`；装配器 `openclaw-plugin/src/core/behavior-example-pack-assembler.ts` | **pain lineage + trajectory** → 1 负例 + `ownerDesiredOutcome` + ≤3 正例 + ≤5 evidenceRefs | Artificer prompt（**必需**，缺失 fail loud） |
| **`injectRunnerLineageIfAbsent` / `reconcileLineageEcho` / `resolveLineageArtifactIds`** | `internalization/peer-runner-contracts.ts`、`runner/base-peer-runner.ts:490-516` | **仅 ID / 身份字段**的注入与回显校正 | 各 runner（**不传内容**） |

> **关键区分**：PD 的 `lineage` 词汇在生产中主要指 **身份管道**（谁是谁的父），**不是内容管道**。`resolveLineageArtifactIds` 的注释是 "Resolve artifact IDs from predecessor tasks for **lineage tracking**"，返回 `{ ids, hasRejected }` 写进 `pi_artifacts.lineage_artifact_ids`。它不把任何前驱**内容**送进 prompt。

## 2.3 三层架构的原始设计（`docs/superpowers/specs/2026-07-14-...-design.md`）

| 层 | 原设计内容 | 对应 flag | 现状 |
|---|---|---|---|
| **Layer 0** | 写入侧冗余：artifact 携带自身 TL;DR + 直接前驱 TL;DR（design §4.1） | `artifact_summary_redundancy` | `gone` 墓碑 |
| **Layer 1** | 读取侧按 ContextManifest 取结构化摘要（200–500 token），PromptBudgetManager 硬预算截断（§4.2/§4.3） | `context_manifest_budget` | `gone` 墓碑 |
| **Layer 2** | CandidateLineage 跨级回溯 raw 字段（§4.4）+ 两阶段评估（§4.5） | `progressive_evaluator` | `gone` 墓碑 |
| **Layer 3** | Operator surface：`context-trace` CLI（旧 `pd-cli/src/commands/runtime-internalization-context-trace.ts`，445 行） | 无 flag | R-06 已删除命令 + BDD feature/steps |

---

# 3. Pipeline Connectivity Matrix（Phase 2 + Phase 3）

## 3.1 真实代码路径与逐阶段输入

```text
Pain ──▶ diag_rootcause ──▶ diag_distiller ──▶ diag_router
                                                    │
        ┌──────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐
        │ Dreamer  │──▶│ Philosopher  │──▶│  Scribe  │──▶│ Artificer│──▶│ Evaluator │──▶ rollout
        │ 1–5 候选 │   │ 单一 thesis  │   │ 正式化+   │   │ RuleCode │   │  对抗验证 │
        └──────────┘   └──────────────┘   │intentCtr │   └──────────┘   └───────────┘
             │                           └──────────┘
             └──────── 旁路消费（Artificer 直取 candidates[0]）────────┘
```

## 3.2 逐阶段：输入 / 输出 / 信息损失点

| 阶段 | 实际收到的输入（file:line） | 产出的 artifact | 信息损失点 |
|---|---|---|---|
| **Pain → Diagnostician** | `diagnostician-prompt-builder.ts:64-96`：`diagnosisTarget`、`conversationWindow`（`HistoryQueryEntry[]`）、`sourceRefs`、完整 `DiagnosticianContextPayload`、可选 `intentDoc.raw`（未经转义全文） | `diagnostician` / `diag_*` artifact | ⚠️ **有界截断（有损但可观察）**：`evidence-sanitizer.ts:26` `MAX_EVIDENCE_VALUE_CHARS=200`、`:39` `MAX_COMMAND_PREVIEW_CHARS=2000`（head 65% / tail 30%）、`:40-42` `MAX_DEPTH=4 / MAX_KEYS=50 / MAX_ARRAY_ITEMS=20`；`pain-signal-bridge.ts:33-34` `MAX_EVIDENCE_ENTRIES=8 / MAX_EVIDENCE_NOTE_CHARS=200`。截断带显式 `___TRUNCATED___` 标记 + `truncationWarnings` ⇒ **不是断链** |
| **Diagnostician → Dreamer** | `dreamer-runner.ts:130-183`：`predecessorOutput` = **前驱 artifact 的完整 `contentJson`**（JSON.parse 后原样传入） | `DreamerOutput{valid, taskId, candidates[1..5], sourcePainId?, contextRefs, generatedAt}` | ✅ **无损失**（直接前驱全文） |
| **Dreamer → Philosopher** | `philosopher-runner.ts:186-220`：**仅** `dreamerArtifact` 全文 + `sourceDreamerArtifactId` | `PhilosopherOutputV1{sourceDreamerArtifactId, thesis, principleCandidate{title,rationale,scope,confidence}, risks[]}` | ❌ **多候选 → 单一 thesis**；且**不落盘被否定的候选**（见 DC-2） |
| **Philosopher → Scribe** | `scribe-runner.ts:165-211` → `scribe-prompt-builder.ts:158-167`：payload **仅含** `{taskId, contextHash, sourcePhilosopherArtifactId, sourceDreamerArtifactId?, philosopherArtifact, promptContractVersion}`；`startRun({ contextItems: [] })` | `ScribeOutputV1{principleDraft{title,statement,rationale,applicability[],antiPatterns[],confidence}, intentContract, sourceTrace, risks[], generatedAt}` | ❌❌ **DC-1：原始 Pain / 诊断证据 / dreamer 候选内容 / 被拒备选 —— 全部结构性丢弃** |
| **Scribe → Artificer** | `artificer-runner.ts:740-753`：`scribeArtifact` 全文 + `behaviorExamplePack`（必需）+ `dreamerContext` + `adversarialFeedback` + `repairFeedback` + `revisionFeedback` + repairEvidence | artificer artifact（RuleCode） | ⚠️ **DC-3**：`resolveDreamerContext:305` 显式 `const [firstCandidate] = candidatesField` ⇒ 只取候选 0 |
| **Artificer → Evaluator** | `evaluator-prompt-builder.ts`：`artificerArtifact` + `scribeArtifact` + `intentContract` + `previousEvaluation` + `hostToolCatalog` | evaluator artifact | ❌ 无 pain / diagnosis ⇒ 无法判定「是否忠于原始痛感」 |
| **Evaluator → Rollout** | `rollout-reviewer-prompt-builder.ts`：`evaluatorArtifact`（code_chain）或 `scribeArtifact`（principle_semantic） | rollout artifact | ❌ 无 pain / diagnosis |
| **Rollout → 治理/激活** | — | approval / activation | ❌ 无 pain / diagnosis |

## 3.3 Trinity 信息断点审计（Phase 3 逐项答复）

### Dreamer

| 问题 | 答复 |
|---|---|
| 产生的 candidate / hypothesis / evidence 是否进入 Philosopher？ | ✅ **是**（dreamer artifact 全文） |
| 是否进入 Scribe？ | ❌ **否** —— **DISCONNECTED_CAPABILITY** |
| 严重度 | **高**。生产 MEASURED：33 个 dreamer artifact 中 **31 个（93.9%）携带 ≥2 个候选**（5 个候选 ×25、4 ×6、2 ×1、1 ×1）。即被丢弃的不是 1 条冗余信息，而是**平均约 4.7 条互不相同的可执行纠正路径** |

### Philosopher

| 问题 | 答复 |
|---|---|
| 是否独立查询 context？ | ❌ **否**。只消费 `dreamerArtifact`（`philosopher-runner.ts:186-220`）。它不查 DB、不取原始 Pain、不取诊断证据 |
| 是否只消费 Dreamer summary？ | 消费 **Dreamer 全文**（不是 summary）—— 这一边是健康的 |
| 生产独立消费者 | **0 个**（唯一结构化消费者是 Scribe；其余为 UI 读 `principleCandidate.title` 与读**不存在字段**的 legacy 死代码） |
| 新增断点 | **DC-2**：`thesis` 收敛时**不记录被否定的候选索引**。全仓 `git grep -i "rejectedCandidate\|selectedCandidate\|chosenCandidate"` 在 internalization 下 **0 命中**（仅 `rollout-reviewer-runner.ts:812` 有**规则层**的 `rejectedCandidates`）。⇒ 即使把 dreamer 全文送给 Scribe，「哪些已被 Philosopher 批判否定」这一语义仍需 Scribe 自行重建 |

### Scribe（PR #1753 的问题确认）

**当前 Scribe 能够主动获得以下信息吗？**

| 需要的输入 | 可获得？ | 证据 |
|---|---|---|
| **Original Pain** | ❌ 否 | payload 无 pain 字段（`scribe-prompt-builder.ts:24-31`） |
| **Diagnosis evidence** | ❌ 否 | 无诊断 artifact 引用，仅有 `sourceDreamerArtifactId` 一个 id |
| **Dreamer candidates** | ❌ 否（**仅 id，无内容**） | 持有 `sourceDreamerArtifactId` 但 **从不用它取内容** —— 对比 Artificer 的 `resolveDreamerContext` 正是用同一个 id 去取 |
| **Rejected alternatives** | ❌ 否 | 上游未落盘（DC-2） |
| **Historical corrections** | ❌ 否（首轮） | formation 阶段无该通道 |
| **Owner feedback** | ⚠️ **仅修订轮** | `scribe-runner.ts:238-241`：`revisionFeedback` 存在才追加 `<revision_feedback>` 块；来源 `owner-resolution-service.ts:255`（`record.ownerInstruction`）。首轮 = 行为不变 |

```text
QUALITY_IMPACT: HIGH
```

**理由（三条独立证据）**：

1. **实验证据**：PR #1753 Phase A 把三块证据（`sourceDiagnosis` / `dreamerProposals` 全候选 / `provenance`）加入 Scribe 输入 → `W=19 L=1 T=1`，`NET_ADVANTAGE = 85.7pp`（`docs/audit/pri-815-quality-first/PHASE_A_REPORT.md:14-15`）。
2. **结构证据**：Scribe 是全链**唯一**同时触碰 Owner authority 与 runtime effect 的产物（canonical Principle + `intentContract`），有 9+ 条独立生产消费者（含运行时 prompt 激活）。它拿到的上下文却是全链**最少**的。
3. **数据证据（MEASURED）**：生产 56 个 scribe artifact 中，`sourceTrace.dreamerArtifactId` **56/56 存在** ⇒ 连接所需的**标识符已经在手上**，缺的只是一次 `getArtifactById` 调用。

---

# 4. Feature Flag Audit（Phase 4）

## 4.1 Flag 普查（origin/main，共 46 条）

`feature-flag-contract.ts` DEFAULT_FEATURE_FLAGS 全量导出见 §附录 A。与信息连通性相关的条目：

| flag | category | main 默认 | 生产实际 | 是否分歧 |
|---|---|---|---|---|
| `artifact_summary_redundancy` | **gone** | false | **false** | — |
| `context_manifest_budget` | **gone** | false | **true** | ⚠️ **分歧** |
| `progressive_evaluator` | **gone** | false | **true** | ⚠️ **分歧** |
| `internalization_auto_consumer` | quiet | true | false（`source: owner`） | ⚠️ 分歧 |
| `intent_engineering` | quiet | false | true | ⚠️ 分歧 |
| `diagnostician_llm_degradation` | quiet | true | false | ⚠️ 分歧 |
| `diagnostician_split_pipeline` | quiet | true | true | — |
| `evaluator_artificer_repair_loop` | quiet | true | true | — |
| `artificer_output_retry` | quiet | true | true | — |
| `principle_receipt_ledger` | quiet | true | true | — |
| `pain_diagnosis_persistence` | quiet | false | **false** | — |
| `l2_dreamer` | quiet | false | false | — |

## 4.2 Potential Disabled Capability Matrix

| 能力 | 存在 | 默认状态 | 生产状态 | 影响 |
|---|---|---|---|---|
| **Formation Context（跨级前驱内容注入）** | ⚠️ 曾存在（PRI-634），**R-06 已删除** | OFF → gone | gone | **高**。Scribe 无法获得跨级证据（DC-1） |
| **Evidence loading（Layer 0 写入侧信封）** | ⚠️ 曾存在，已删除 | OFF → gone | **false** | **高**。MEASURED：320 artifact 中带 `summary` 信封 **0 个**、带 `predecessorSummary` **0 个** ⇒ 下游任何「读摘要」路径**结构性 absent** |
| **Candidate visibility（Layer 1 manifest+budget）** | ⚠️ 曾存在，已删除 | OFF → gone | **true**（Owner override） | **高**。⚠️ **Layer 1 被启用但结构上必然 no-op** —— manifest 声明的 `philosopher.predecessorSummary.*` 依赖 Layer 0 写入的信封，而 Layer 0 未开且 100% 为空 ⇒ 恒 fallback 到全量注入。**这是「开关是开的、功能是死的」形态** |
| **Progressive disclosure（Layer 2 两阶段评估）** | ⚠️ 曾存在，已删除 | OFF → gone | **true**（Owner override） | **中**。evaluator 现为单阶段，Stage2 raw 回溯路径消失 |
| **Layer 3 operator surface（`context-trace` CLI）** | ⚠️ 曾存在，已删除 | 无 flag | 不可用 | **中**。该层的存在意义正是**观测**上述 flag 是否真的生效；它被删除后，Layer 1 的「开而无用」不再有 first-class 观测面 |
| **`resolveDreamerContext`（bespoke 单跳）** | ✅ 存在 | 无 flag（生产硬编码） | **启用** | 正例：证明「artifact id → 前驱内容 → prompt」模式可行 |
| **`BehaviorExamplePack`（pain lineage 证据包）** | ✅ 存在 | 无 flag（必需） | **启用** | 正例：证明 pain 原始证据**已经有管道**进入决策节点（Artificer） |

## 4.3 R-06 退役的连带效果（审计新发现）

生产 `config.yaml` 第 91–99 行现状：

```yaml
  artifact_summary_redundancy:
    category: quiet
    enabled: false
  context_manifest_budget:
    category: quiet
    enabled: true      # ← Owner 曾显式开启
  progressive_evaluator:
    category: quiet
    enabled: true      # ← Owner 曾显式开启
```

`0a8fa715` 的墓碑注释原文：

> 「Kept as gone tombstones per the census lifecycle contract so a stale `enabled: true` override is **rejected observably** instead of being silently ignored.」

⇒ **一旦生产升级到含 R-06 的构建（> 1.245.2），Owner 此前对 Layer 1 / Layer 2 的显式开启将被「可观察地拒绝」。** 产品语义上，Owner 的授权被终止 —— 这符合治理契约（gone 是终态），但**建议 Owner 确认这是有意为之**：因为该授权从未产生过任何实际效果（§4.2 显示 Layer 1 本就是 no-op），R-06 实际移除的是一个「已经失效的开关」而非一个「在用的能力」。

---

# 5. High Value Disconnected Inputs（Phase 5）

## A. Pain → Diagnosis

**问题**：Diagnosis 是否看到完整的用户纠正 / trajectory / tool calls / previous failures，还是只有摘要？

**答复：看到完整集合，但经过有界脱敏截断。** 判为 **CONNECTED_BUT_LOSSY（非断链）**。

- `diagnostician-prompt-builder.ts:64-96` 传入完整 `DiagnosticianContextPayload` + `conversationWindow: HistoryQueryEntry[]`。
- 但 `evidence-sanitizer.ts` 施加硬边界：单值 200 字符（`:26`）、命令预览 2000 字符且 head 65% / tail 30%（`:39`、`:274-277`）、深度 4 / 键 50 / 数组项 20（`:40-42`）、pain 证据条目 8 / 备注 200 字符（`pain-signal-bridge.ts:33-34`）。
- **合规性**：截断是**显式**的 —— 插入 `___TRUNCATED___` / `<N more items>` / `<truncated>` 标记，并产出 `truncationWarnings`。这满足 PD 的「no silent cut」契约。
- **附带发现（新）**：`pain-signal-bridge.ts:681` 存在 `rootCausePreview: diagnosticianOutput.rootCause.slice(0, 80)` —— 诊断结论以 **80 字符预览**回写到 pain 侧。若该预览被下游当作「诊断结论」消费，属于**降采样引用**；本审计未发现它在 formation 链路上被当作权威输入，故仅登记为观察项。

## B. Diagnosis → Dreamer

**答复：完全连接。**

`dreamer-runner.ts:130-183` 取前驱 artifact 的 `contentJson`，`JSON.parse` 后**原样**作为 `predecessorOutput` 传入 prompt（失败时降级为原始字符串而非丢弃）。无字段裁剪、无摘要化。Dreamer 因此能看到诊断的 `rootCause` / 违反原则 / 证据数组。

## C. Evaluator → Principle

**答复：基本断链（DC-4）。** 仅存一条窄路。

- Evaluator 的输入是 `artificerArtifact` + `scribeArtifact`（`evaluator-prompt-builder.ts`），**不读 pain / diagnosis** ⇒ 它判断的是「规则是否忠于原则文本」，**不是**「原则是否忠于原始痛感」。
- Evaluator 的 `needs_revision` 反馈流向 **Artificer**（`evaluator_artificer_repair_loop`，default ON，2 轮上限 → `needs_human_review`），即修正**规则实现**，**不回写 Principle 文本**。
- 唯一能改 Principle 的路径：`rollout_reviewer` needs_revision → `resolveRolloutRevisionTarget`（`revision-reopen.ts:119-121`，`kind: 'scribe' | 'artificer'`）→ scribe 以 `revisionFeedback` 修订。这是一条**窄路**（需 rollout 判定 + 修订预算），不是 Evaluator 直接回写。
- ⇒ **Evaluator 发现的 risk / failed cases / boundary 不构成 Principle 的修正信号。**

## D. Principle → RuleCode

**答复：连接良好 —— 这是全链最富裕的一条边（正例）。**

| 从 Principle 传递到 RuleCode 的内容 | 证据 |
|---|---|
| `intentContract` 五字段（ownerIntent / targetBehavior / forbiddenBehavior / evidenceSource / validationExpectation） | `artificer-runner.ts:898` `extractIntentContract`；prompt builder 显式要求「intentContract 优先于与之矛盾的修复指令」 |
| `antiPatterns` / `applicability` / `risks` | 经 `scribeArtifact` 全文传入 |
| **examples（Owner 标注）** | `BehaviorExamplePack`（必需，`artificer-prompt-builder.ts` 头注释：缺失 fail loud）：含 `ownerDesiredOutcome` + 1 负例 + ≤3 正例 + ≤5 evidenceRefs |
| **原始证据** | `BehaviorExamplePackAssembler`（`openclaw-plugin/src/core/behavior-example-pack-assembler.ts`）从 **pain lineage + trajectory** 装配，且强制同 session 校验（`:122`） |
| dreamer 五维 | `dreamerContext`（`candidates[0]`） |
| 修复/对抗/修订反馈 | `repairFeedback` / `adversarialFeedback` / `revisionFeedback` |

⇒ **Phase 5 的目标形态（「已有数据 + 已连接」）在 Artificer 这条边上已经实现。** 这正是 §1.3 的倒挂证据：**Artificer 有 pain 证据包，而 Scribe 没有。**

## E. Runtime Feedback → Learning

**答复：有观测闭环，无学习闭环（DC-5）。**

| 环节 | 现状 |
|---|---|
| block reason 产出 | `principle_receipt_block_copy`（default ON）：block 消息携带 principle 归属 |
| receipt 落盘 | `principle_receipt_ledger`（default ON）→ `principle-application-ledger.ts`；writer 在 `openclaw-plugin/src/hooks/gate.ts:184,353,682`、`hooks/prompt.ts:717` |
| receipt 消费者 | `pd-cli/src/commands/principles-stats.ts`（只读统计）、`host-runtime/src/product-telemetry/milestone-readers.ts:42-58`（里程碑计数） |
| **回流到 formation？** | ❌ `git grep -i "blockReason"` 在 `pain-signal-bridge.ts` / `pain-ingress.ts` / `internalization/*` **0 命中** |
| 结论 | 运行时证据进入的是**观测面 / 治理面**，**没有**进入 Evidence Flow 的起点（Pain Admission → Diagnosis）。与 PRI-750 §5 的断点 D-1（Receipt ↔ Trajectory，最严重）与 D-2（Receipt ↔ Outcome）一致 |

---

# 6. Priority Recommendations（Phase 6）

## 6.1 Low Cost / High Impact Candidates

评分口径：**成本** = 是否已有数据 + 已有接口 + 已有先例；**收益** = 是否作用于有独立生产消费者、且能被实测的决策节点；**风险** = 是否引入新的跨边界身份字段 / 是否改变治理语义。

| # | 候选 | 证据 | 预计收益 | 成本 | 风险 |
|---|---|---|---|---|---|
| **C1** | **Scribe 直取 dreamer 全候选 + 诊断证据**（复用 `resolveDreamerContext` 模式，改 `ScribeRunner.buildContext`） | PR #1753 `W19/L1/T1`、`+85.7pp`；生产 31/33 dreamer 为多候选；`scribe.sourceTrace.dreamerArtifactId` 生产 **56/56 存在**；`artifactStore.getArtifactById` 已是既有接口 | **HIGH**（直接抬升 canonical Principle 质量） | **LOW**（一次取件 + prompt 追加） | **中**：token **+24.9%（MEASURED）**，需预算；`SCRIBE_PROMPT_CONTRACT_VERSION` v3→v4；`sourceTrace` 语义不变 |
| **C2** | **Artificer 从 `candidates[0]` 扩到全候选** | `artificer-runner.ts:305` 显式 `[firstCandidate]`；生产 31/33 有多候选 | **MEDIUM**（RuleCode 可实现多条纠正） | **LOW**（同一 resolver 内改循环） | **低-中**：prompt 变长；`ArtificerDreamerContext` 需从单值对象改为数组（跨边界形状变更） |
| **C3** | **Philosopher 落盘被否定的候选索引** | 全仓无 `rejectedCandidate*` 字段 | **MEDIUM**（让「不得复活被批判否定的候选」成为可校验契约而非提示词要求） | **MEDIUM**（需改 `philosopher-output.ts` schema） | **中**：跨边界身份字段 +1；validator 需同步 |
| **C4** | **Evaluator → Principle 反馈边** | evaluator 不读 pain/diagnosis；无回写 principle 路径 | **MEDIUM-HIGH**（把「原则是否忠于痛感」纳入验证） | **HIGH**（需新边，非「已有接口」） | **高**：触及治理语义（谁有权改 Principle） |
| **C5** | **Owner 显式指令提升为首轮前置上下文** | `owner-resolution-service.ts:255` 已产出 `ownerInstruction` → `revisionFeedback`；`scribe-runner.ts:238` 仅修订轮读取 | **MEDIUM** | **LOW** | **中**：首轮注入 Owner 指令可能违反「Evidence-First Attribution」—— 需 Owner 明确裁决 |

## 6.2 唯一推荐的 P0

**C1。** 理由：它是**唯一被实测量化过**的落点（PR #1753 的 Phase A 就是这个变量）、成本最低、且连接所需标识符在生产 100% 已存在。它也正是 PR #1753 已经冻结为「PHASE B 输入」的认知契约：

```text
FORMATION EVIDENCE (KEEP — the validated Phase A information-flow repair):
  Scribe/formalize 输入 = 生产 payload + 三块冻结证据：
    sourceDiagnosis（含 rootCause/violatedPrinciples/evidence 数组）
    dreamerProposals（全部候选，非仅选中项）
    provenance（source pain / diagnosis task / artifact ids）
```
（`docs/audit/pri-815-quality-first/FROZEN_COGNITIVE_CONTRACT.md:16-21`）

## 6.3 明确不推荐

本次审计**不建议**：删除 Trinity、重写 pipeline、创建新数据库、新建 memory system、恢复被删除的 PRI-634 三层平面。设计文档自身已诚实声明其适用性边界（design §2.3：「PD 是管道而非 agent loop，无法实现真正的 agent 主动按需加载」），而生产数据证明其 Layer 0 从未产生过一条记录 —— 复活它不在本次命题内。

---

# 7. 与 PR #1753 的对比（Phase 7）

```text
PR #1753:
  增加 formation evidence
  ↓
  质量 +85.7pp（W=19 L=1 T=1，EXPLORATORY；GPT6 独立校准 B6/A3/T3）
```

**判定：A（新能力创造）还是 B（已有能力恢复连接）？**

## 结论：**B —— 已有能力恢复连接**，但附一条关键限定

### 判定为 B 的三条证据

| 维度 | 判定 | 证据 |
|---|---|---|
| **数据** | **B（已有）** | diagnosis artifact 的 `rootCause` / `violatedPrinciples` / `evidence` 数组、dreamer 的 1–5 候选，**在生产库中已持久化且可读**（MEASURED：320 artifact，其中 dreamer 33 / philosopher 63 / scribe 56） |
| **接口** | **B（已有）** | `ArtificerRunner.resolveDreamerContext`（`artificer-runner.ts:228-344`）已示范完整模式：untrusted parse → 依 id `getArtifactById` → 结构校验 → 注入 prompt。`artifactStore.getArtifactById` 是既有接口 |
| **Scribe 侧标识符** | **B（已有）** | `scribe-runner.ts:205` 已把 `sourceDreamerArtifactId` 放进 context，`scribe-prompt-builder.ts:162-164` 已把它写进 payload —— **id 在手，只是没人用它取内容** |

### 必须附上的限定：通用载体已被移除

**PR #1753 的 Arm B 不是「开启 PRI-634 共享信息平面」**，而是实验 harness 里的一个 **prompt addendum**：

```text
ARM_SYSTEM_PROMPT_HASHES: A = a47db8f47552   B = bc47a6df83bd
                          （delta = B_ADDENDUM pri815-b-addendum.v1 + 3 evidence payload blocks）
B_ADDENDUM = scripts/pri-815/b-addendum.mjs
```
（`PHASE_A_REPORT.md:10-11`、`FROZEN_COGNITIVE_CONTRACT.md:22-26`）

而承载该类连接的**通用机制**（Layer 0/1/2 + CandidateLineage + ContextManifest + PromptBudgetManager）已在 **PR #1753 合并前 1 小时**被 R-06 删除（§0.1）。

并且 PR #1753 自身**未做任何生产改动**：
> 「principleFormation implementation NOT started in this PR — Phase B is a separate effort with the frozen cognitive contract」（`PHASE_A_REPORT.md:49`、`:101`）

### 判定含义

```text
PR #1753 根因 = B（恢复连接）
但"恢复"的载体 = 实验 harness 的一次性 addendum，而非既有的通用平面
⇒ Phase B 实施时，没有通用机制可复用，只能按 resolveDreamerContext 的 bespoke 模式逐边接线
```

**这既是好消息也是坏消息：**

- ✅ **风险低**：有生产先例（Artificer 的 `resolveDreamerContext` 已经在跑），模式、错误处理、可观察性约定都是现成的（fail-loud + `dreamer_context_skipped` / `dreamer_artifact_missing` 事件）。
- ⚠️ **长期成本**：每接一条边就多一个 bespoke resolver。PRI-634 原本要消灭的正是这种重复（design §1.3 问题 E：「`resolveDreamerContext` / `extractScribeArtifactId` 是 bespoke 实现」）。**在该平面被删除后，这个重复问题回到了起点。**

### 同类候选（B 类，已在 §6 量化）

| 候选 | 分类 | 理由 |
|---|---|---|
| **C1** Scribe ← dreamer 全候选 + 诊断证据 | **B** | 数据已有 + 接口已有 + id 已到手（生产 56/56） |
| **C2** Artificer ← 全候选 | **B** | 同一 resolver 已存在，只是人为取 `[0]` |
| **C5** Owner 指令首轮化 | **B** | `ownerInstruction` → `revisionFeedback` 管道已存在，只是首轮不读 |
| C3 Philosopher 落盘被拒候选 | **A/B 之间** | 概念已有（rollout 层 `rejectedCandidates`），但 principle 层 schema 需新增字段 |
| C4 Evaluator → Principle 回写边 | **A** | 不存在该边，需新增（成本 HIGH，且触及治理语义） |

---

# 8. Owner Review Card

## 8.1 三个需要 Owner 注意的判断题

**① R-06 的删除边界是否过宽？**

R-06 删除的是「从未 graduation 的 dormant 平面」，这个判定与生产实测一致（Level 0 信封 0/320）。但该平面同时包含**一类通用接口骨架**：「从 artifact id 解析前驱内容并注入 prompt」。该骨架被删除后，PR #1753 的 Phase B 只能重复 bespoke 实现。

> 建议：请 Owner 确认 —— 这是**有意的**（接受逐边 bespoke 成本），还是**应当保留接口骨架**（不保留 flag，仅保留 resolver 抽象）。

**② 生产 config 中的两个 `enabled: true` 即将被拒绝——确认无碍？**

`context_manifest_budget: true` 与 `progressive_evaluator: true` 是 Owner 曾显式开启的覆盖。升级到含 R-06 的构建后将被作为 `gone` 墓碑**可观察地拒绝**。由于 Layer 1 依赖未开启的 Layer 0，这两个开关本就从未产生效果，故实际能力损失为 **0**；但**授权记录**会被终止。

> 建议：确认升级说明中如实记录此项，避免 Owner 事后误判「能力被删」。

**③ PR #1753 的 +85.7pp 强度如何采信？**

实验方已自陈三项限制（`PHASE_A_REPORT.md:111-117`）：judge 与 generator 同族（glm-5.3，独立通道全不可用）、下游为 scenario-gated 代理而非生产 rulehost VM、成本 +24.9% 超 guard。GPT6 独立校准（12 对）给出 **B 偏好 6 / A 3 / TIE 3** —— 方向独立支持，但 **19:1 的幅度可能被放大**。

> 建议：以「方向确定性高、幅度待复现」采信。

## 8.2 一句话结论

> **PD 早就设计并实装过共享信息池（PRI-511/512/513 → PRI-634），但三层 flag 全部 default OFF 且从未 graduation，其中 Layer 1 即使被 Owner 开启也因缺 Layer 0 而结构性失效（生产 0/320 信封）；该平面随后被 R-06 作为 dormant 删除。PR #1753 的 +85.7pp 属于「已有数据 + 已有接口 + 已有先例、只是没有连接」的 B 类修复，但它用的是一次性 prompt addendum 而非既有平面 —— 因此 Phase B 没有通用载体可复用，建议的最低成本高收益落点是 C1（Scribe 直取 dreamer 全候选 + 诊断证据）。**

---

# 附录 A — Feature Flag 全量普查（origin/main，46 条）

```text
prompt                          | core  | true
code_tool_hook                  | core  | true
rulecode_safety_controls        | core  | true
rulecode_owner_live_decision    | core  | true
defer_archive                   | core  | true
correction_observer             | quiet | false
signal_collector                | quiet | true
internalization_auto_consumer   | quiet | true
internalization_full_chain      | core  | true
prompt_full_pipeline            | quiet | false
story_a_approval_completion     | quiet | true
feedback_channel                | quiet | true
release_manager_shadow          | gone  | false
release_manager_write_authority | gone  | false
gfi                             | quiet | false
evolution_worker                | gone  | false
empathy_observer                | gone  | false
diagnostician_async_cli         | quiet | false
diagnostician_core_grounding    | quiet | true
internalization_core_grounding  | gone  | false
diagnostician_split_pipeline    | quiet | true
diagnostician_llm_degradation   | quiet | true
l2_dreamer                      | quiet | false
code_rule_capability            | core  | true
intent_engineering              | quiet | false
rulecode_context_v2             | quiet | true
failed_tasks_observability      | quiet | true
evaluator_artificer_repair_loop | quiet | true
artificer_output_retry          | quiet | true
artifact_summary_redundancy     | gone  | false   ← R-06 退役（Layer 0）
context_manifest_budget         | gone  | false   ← R-06 退役（Layer 1）
progressive_evaluator           | gone  | false   ← R-06 退役（Layer 2）
host.codex                      | core  | true
abstraction_layer_v1            | quiet | false
principle_receipt_block_copy    | quiet | true
principle_receipt_ledger        | quiet | true
principle_receipt_self_report   | quiet | false
principle_governance_projection_v2 | quiet | true
failed_task_recovery_console    | quiet | true
pain_diagnosis_persistence      | quiet | false
governance_experience_v1        | quiet | true
anonymous_product_telemetry     | quiet | false
codex_conversation_ingestion    | quiet | false
nocturnal                       | gone  | false
idle_trigger                    | gone  | false
new_user_onboarding             | core  | true
```

---

# 附录 B — 可复现命令

```bash
export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Windows/System32:/c/Windows"
cd /d/Code/principles

# B1 基线锚定（不要信本机 origin/main 跟踪 ref，用 ls-remote）
git ls-remote origin refs/heads/main

# B2 命名组件存在性（0 命中 ⇒ 该名字从未存在）
git grep -l -i -- "ContextManifest\|CandidateLineage\|PromptBudgetManager" origin/main -- 'packages/**/*.ts'

# B3 共享信息平面设计文档（在 main 中）
git cat-file -e origin/main:docs/superpowers/specs/2026-07-14-internalization-progressive-disclosure-design.md
git show origin/main:docs/superpowers/specs/2026-07-14-internalization-progressive-disclosure-design.md | sed -n '123,200p'

# B4 R-06 退役的完整影响面
git show --stat 0a8fa715

# B5 PR #1753 的合并内容与 Phase A 结果
git show --stat --format='%H%n%P%n%ci%n%s' 0dc70ee6
git show origin/main:docs/audit/pri-815-quality-first/PHASE_A_REPORT.md | sed -n '1,50p'
git show origin/main:docs/audit/pri-815-quality-first/FROZEN_COGNITIVE_CONTRACT.md

# B6 Scribe 的真实输入契约（DC-1 的结构证据）
git show origin/main:packages/principles-core/src/runtime-v2/internalization/scribe-prompt-builder.ts | sed -n '149,172p'
git show origin/main:packages/principles-core/src/runtime-v2/internalization/scribe-runner.ts | sed -n '165,211p'

# B7 已有先例：Artificer 的 bespoke 单跳（只取 candidates[0]）
git show origin/main:packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts | sed -n '228,344p'

# B8 生产只读计数（readonly:true，绝不写）
node D:/pd-probe-835/probe1.cjs
node D:/pd-probe-835/probe2.cjs
```

---

# 附录 C — 证据资产

| 资产 | 路径 | 性质 |
|---|---|---|
| 主报告 | `docs/audit/PRI-835-formation-context-connectivity-audit.md` | 本文件（未提交） |
| 只读探针 1 | `D:\pd-probe-835\probe1.cjs` | 表结构 + 计数 |
| 只读探针 2 | `D:\pd-probe-835\probe2.cjs` | `content_json` 键存在率 + 候选分布 |
| 源码快照 | `D:\pd-probe-835\src\*.ts` | 从 origin/main 导出的只读副本（9 个文件） |
| 设计文档快照 | `D:\pd-probe-835\progressive-disclosure-design.md` | origin/main 版本 |
| Spike 快照 | `D:\pd-probe-835\pri815-spike.md` | PRI-815 结构调查报告 |

**MEASURED 与 ESTIMATED 的区分（强制）**

| 指标 | 类别 |
|---|---|
| PR #1753 `NET_ADVANTAGE = 85.7pp`、`W=19/L=1/T=1`、token `+24.9%` | **MEASURED**（PRI-815 冻结实验数据） |
| 生产 320 artifact / 33 dreamer / 63 philosopher / 56 scribe；`predecessorSummary` 0 / `summary` 信封 0 | **MEASURED**（本审计只读探针） |
| `scribe.sourceTrace.dreamerArtifactId` = 56/56 | **MEASURED**（本审计只读探针） |
| dreamer 多候选分布 5×25 / 4×6 / 2×1 / 1×1 | **MEASURED**（本审计只读探针） |
| 「Scribe 拿不到 X」 | **MEASURED**（源码契约 + prompt payload 结构） |
| C1 的 token 增量在真实 Scribe 上的具体数值 | **ESTIMATED**（沿用 PR #1753 的 24.9% 外推，未在本审计重跑） |
| C4 的收益 | **ESTIMATED**（未实施） |

---

# 附录 D — 纪律声明

```text
CODE_CHANGES        = NONE
PRODUCTION_CHANGES  = NONE
PR_CREATED          = NONE
DB_WRITES           = NONE
AGENT_RUNS          = NONE
CONFIG_WRITES       = NONE
FLAG_WRITES         = NONE
LINEAR_WRITES       = NONE
```

- 本审计唯一新增的文件是本文档（`docs/audit/` 下的 Markdown 文档），**未提交、未开 PR**。
- 所有对 `origin/main` 的读取通过 `git show` / `git grep`（纯只读，不改工作树）。
- 所有对生产 `state.db` 的访问通过 `better-sqlite3` 的 `{ readonly: true, fileMustExist: true }` 连接。
- 未启动任何 PD runtime / agent / consumer cycle。
