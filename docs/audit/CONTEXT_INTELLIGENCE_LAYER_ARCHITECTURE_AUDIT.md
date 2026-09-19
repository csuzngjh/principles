# Context Intelligence Layer Architecture Audit

> **报告类型**：只读架构审计（Read-Only Architecture Audit）
> **工单**：PRI-842 — Context Intelligence Layer Architecture Audit
> **核心问题**：PD 是否需要恢复旧 ContextManifest / Progressive Disclosure 设计，还是应基于当前架构建立更轻量的 Consumer-driven Context Contract？
> **日期**：2026-09-19
> **纪律**：未修改代码 / 配置 / flag / 数据库；未创建 PR；生产库未触碰（本审计纯源码 + git history + 已有审计证据，无需生产探针）。

## Executive Summary

```text
PRI_842_RESULT = OPTION_B_CONSUMER_CONTEXT_CONTRACT

一句话结论：
旧 ContextManifest/Progressive Disclosure 平面（PRI-634 三层）不是"值得恢复的好设计"，
而是一套被生产实测证伪的 producer 侧机制（Layer 0 信封生产 0/320、Layer 1 即使被
Owner 开启也结构性 no-op）；相反，PR #1756 的 formation-context.ts 已经验证了
consumer 侧契约模式的有效性——两度实验（PRI-838 +51.3pp、PRI-841 C>B 5-1）证明
"消费者在 prompt 边界做有界解析"就是正确的 Context Intelligence Layer 形态。
推荐：不恢复旧平面，不建 Context Registry 新子系统；把 formation-context.ts
当作消费者契约模块的自然生长点，MVP = 3 处连接/收敛（Evaluator 证据接入、
Artificer 诊断证据接入、有界投影单权威）。
```

关键依据（三角互证）：

1. **历史实测**（PRI-835 MEASURED）：320 个生产 artifact 中带 Layer 0 信封 **0 个**、带 predecessorSummary **0 个** ⇒ 任何"读摘要"路径结构性 absent。
2. **现行实测**（PRI-838/841 MEASURED）：consumer 侧 resolver 接线两度产生可测收益（Scribe +51.3pp 方向复现 6–1；Artificer 候选集 C>B 5–1）。
3. **架构判例**（AGENTS.md P7）：formation-context.ts 有 **2 个 materially different 消费者**（Scribe/Artificer）= 真实 seam；Context Registry 在当前消费者数量下 = speculative abstraction。

---

## Background

证据链（四步）：

| 步骤 | 产物 | 关键发现 |
|---|---|---|
| PRI-815 Trinity Boundary Spike | Trinity 瘦身方向确立 | 不恢复三 agent 复杂度 |
| PRI-835 Connectivity Audit | DC-1..DC-5 五断点 + 历史平面考古 | 信息一直在库里，缺的是连接 |
| PR #1756（PRI-838/839） | formation-context.ts 落地 main | DC-1/DC-3 修复（Scribe v4 / Artificer v8） |
| PRI-841 Propagation Validation | `ARTIFICER_EXPANSION_REQUIRED` | Scribe 提升未传到 RuleCode 质量（B 2–4 A）；候选集传回（C 5–1 B）；A→B 的传播形态=效率（L2 轮次 −32%） |

当前问题已从"有没有信息"转变为"**正确的信息是否到达正确消费者**"（PRI-841 结论 2：瓶颈是 producer→consumer 的消费能力）。

## Current Architecture

（代码级证据在 `docs/audit/PRI-835-formation-context-connectivity-audit.md` §3 与 `D:/pd-labs/pri841/CURRENT_PIPELINE_MAP.md`，本节只述与决策相关的骨架。）

```text
Pain → diag_rootcause → diag_distiller → diag_router
                                          ↓
Dreamer(1–5 候选) → Philosopher(thesis) → Scribe(Principle+intentContract) → Artificer(RuleCode) → Evaluator → rollout → Owner approval → Activation → RuleHost(每调用 RuleContextV2)

formation-context.ts（PR #1756，消费者侧有界解析器）:
  resolveFormationContext(dreamerId) → { dreamerProposals[≤5], sourceDiagnosis, provenance }
  消费者 1: Scribe prompt（v4 条件块）
  消费者 2: Artificer prompt（v8 候选集 + differenceSummary）
```

## Historical Context Design

### 六能力生卒表（源码 + git history 锚定）

| Capability | 文件（均已删除） | 引入 | 死亡 | 原设计目的 | 判定 |
|---|---|---|---|---|---|
| **ContextManifest** | `internalization/context-manifests.ts` | `d83cb2bbf`（PRI-634 PR B；修订 `e5c805f88`） | `0a8fa715`（PRI-819 R-06，2026-09-18） | runner 声明式声明"我需要哪些前驱字段" | **已删除；不建议恢复**（生产从未生效） |
| **ContextResolution** | `internalization/context-resolution.ts` | `d83cb2bbf` | `0a8fa715` | 按 manifest 提取字段 + 预算分配 + `context_truncated` 事件 | **已删除；不建议恢复**（同上） |
| **Progressive Disclosure（Layer 2 两阶段评估）** | `internalization/progressive-evaluator.ts`、`resolve-injection.ts` | `128c38f4b`（PR #1277） | `0a8fa715` | evaluator Stage1 摘要 / Stage2 raw 回溯 | **已删除；不建议恢复**（evaluator 单阶段运行且 DC-4 读侧问题与此无关——缺的是输入，不是分阶段） |
| **PromptBudgetManager** | `internalization/prompt-budget-manager.ts` | `128c38f4b` | `0a8fa715` | token 硬预算 + 优先级截断 | **已删除；不建议恢复为全局管理器**；其"硬帽+降级顺序"思想已被 formation-context 的 `enforceTotalBudget`（ERR-134 回归锁定）以 124 行实现于消费侧 |
| **CandidateLineage** | `internalization/candidate-lineage.ts` | `e7f1b5a59`（PR 3）；修复 `2a16f352f`/`2ca93dbe6`（PRI-717） | `0a8fa715` | 跨级血缘回溯 + request-scoped cache | **已删除；不建议恢复模块**；其"按 id 走 predecessor"语义由 resolveFormationContext 单跳实现（生产 formation 100% 单跳可达，PRI-838 实测 39/39） |
| **Artifact Summary Envelope（Layer 0 写入侧）** | `internalization/attach-summary-envelope.ts` | `0d6619852`（PR 1） | `0a8fa715` | artifact 携带自身 + 前驱 TL;DR | **已删除；恢复=重蹈覆辙**（生产 0/320 写入是它被删的直接证据） |

### 为什么旧平面死了（结构性原因，非执行不力）

1. **Producer 侧信封要求每个生产者先做额外工作**（写摘要），而没有人有义务读——生产激励为零，Layer 0 恒空。
2. **Reader 的 manifest 依赖 Layer 0 的输出**：Layer 1 被 Owner 开启后仍恒 fallback（读不到不存在的信封）——"开关是开的、功能是死的"。
3. **三层 flag 全部 default OFF 且从未 graduation**（`d83cb2bbf` 提交信息自述），R-06 按 lifecycle 契约转 gone 墓碑（终态，恢复需 Owner 显式决策）。
4. 设计文档自己承认边界（design §2.3："PD 是管道而非 agent loop，无法实现真正的按需加载"）。

## Existing Asset Inventory（当前可复用资产）

| 资产 | 位置 | 消费者数 | 状态 |
|---|---|---|---|
| **formation-context.ts** | `internalization/formation-context.ts`（`5508ed6e`，730 行） | **2**（Scribe + Artificer，materially different） | ✅ 生产路径，真实 seam |
| `resolveFormationContext` / `projectDreamerProposals` / `projectDiagnosisOutput` / `summarizeCandidateDifferences` / `enforceTotalBudget` | 同上 | 上述 2 + PRI-841 实验复用 | ✅ 有界（400c/字段、≤5 候选、8000c 硬帽） |
| **artifact-summary.ts**（唯一幸存的旧模块后代） | `internalization/artifact-summary.ts` | 2（owner-decision-review + formation-context 契约仿写） | ✅ `deriveArtifactSummary` 在用 |
| `resolveRevisionFeedback` | scribe/artificer runner | 修订轮 | ✅ |
| **BehaviorExamplePackAssembler** | `openclaw-plugin/src/core/behavior-example-pack-assembler.ts` | Artificer（CLI 路径） | ✅ pain lineage + trajectory → Owner 标注包 |
| **RuleContextV2 装配器** | `openclaw-plugin/src/hooks/gate.ts:82`（`rulecode_context_v2`，core ON） | RuleHost 每次工具调用 | ✅ 运行时上下文（历史+派生事实） |
| clamp 助手（×3 私有拷贝） | artifact-summary / quality-scorecard/validation / formation-context | 各 1 | ⚠️ 重复（P4 违和，见 MVP-3） |

## Context Flow Map（当前真实数据流）

### Scribe（v4，PR #1756 后）

| 输入 | 进 prompt？ | 证据 |
|---|---|---|
| Philosopher artifact（全文） | ✅ 恒定 | `scribe-prompt-builder.ts` payload |
| Dreamer **全候选**（≤5，有界排序） | ✅ 可解析时 | formationContext.dreamerProposals |
| Diagnosis evidence（diag_router 优先：rootCause/violatedPrinciples/evidence/recommendations） | ✅ 可解析时 | formationContext.sourceDiagnosis |
| Provenance（pain/diag/dreamer 工件 id） | ✅ | formationContext.provenance |
| 原始 Pain 原文 | ❌（仅诊断投影携带的证据数组） | 结构性（无直连） |
| Owner 修订反馈 | ⚠️ 仅修订轮 | `resolveRevisionFeedback` |

### Artificer（v8，PR #1756 后）

| 输入 | 进 prompt？ | 证据 |
|---|---|---|
| Scribe artifact（principleDraft + intentContract + antiPatterns + risks 全文） | ✅ 恒定 | runner buildContext |
| BehaviorExamplePack（Owner 标注，**必需 fail-loud**） | ✅ **仅 CLI 通道** | PRI-780；consumer cycle 无包通道（见 ND-1） |
| Dreamer **候选集**（≤5 + differenceSummary + omittedCount） | ✅ 可解析时 | dreamerContext（v8） |
| adversarial/repair/revision 反馈 + priorValidatorErrors | ✅ 修复环 | 既有 |
| hostSemanticContext（宿主工具目录） | ✅ 宿主声明时 | PRI-741 |
| **Diagnosis rootCause** | ❌（仅经包的 pain lineage 间接） | ND-2 |

### Evaluator

| 输入 | 进 prompt？ | 证据 |
|---|---|---|
| Artificer artifact（全文，含 goldenTraceCases） | ✅ | `evaluator-prompt-builder.ts:231` |
| Scribe artifact（经 sourceTrace 解析） | ✅ | `evaluator-runner.ts:461` |
| intentContract / previousEvaluation（收敛契约）/ hostToolCatalog | ✅ | `:233-237` |
| **Pain / Diagnosis / 候选 / formationContext** | ❌ **全部缺失** | ND-3（= DC-4 读侧） |

### Runtime Activation / RuleHost

| 上下文 | 影响 activation/runtime？ | 证据 |
|---|---|---|
| RuleCode（node:vm 硬化编译） | ✅ 唯一执行体 | production-gate-deps |
| RuleContextV2（每次调用：trajectory 历史 + 派生事实） | ✅ | `gate.ts:82`（core flag ON） |
| Principle 文本归属（block 消息携带） | ✅ | principle_receipt_block_copy |
| 原则溯源/诊断/候选 | ❌ 不进入运行时（设计如此：规则逻辑内嵌；运行时只看行为事实） | — |

## Disconnect Findings（系统化断点图，当前 HEAD）

> 格式：Producer / Consumer / Lost information / Impact / Evidence。DC-1..DC-5 沿用 PRI-835 编号；ND-* 为本次新登记。

| ID | Producer → Consumer | 丢失信息 | 影响 | 证据 | 状态 |
|---|---|---|---|---|---|
| **DC-1** | Dreamer/Diagnosis → Scribe | ~~全候选/诊断/痛感~~ | — | — | ✅ **已修复**（PR #1756；PRI-838 +51.3pp、PRI-841 B>A 6–1） |
| **DC-3** | Dreamer → Artificer | ~~candidates[1..n]~~ | — | — | ✅ **已修复**（PR #1756 v8；PRI-841 C>B 5–1） |
| **DC-2** | Philosopher → 下游 | 被批判否定的候选索引 | 下游无法校验"未复活被否方案"，须自行重建批判 | 全仓无 `rejectedCandidate*` 字段（PRI-835；HEAD 复核未变） | 🔴 OPEN（需 schema 变更，非本 MVP） |
| **DC-4a** | Pain/Diagnosis → Evaluator | 原始痛感、根因、候选 | evaluator 只能判"规则忠于原则**文本**"，不能判"原则忠于**痛感**" | `evaluator-prompt-builder.ts:226-244` 输入清单 | 🔴 OPEN（**MVP-1 目标**） |
| **DC-4b** | Evaluator → Principle 修订 | 风险/失败案例回写 | 原则错误只能经 rollout 窄路修订 | `revision-reopen.ts:119-121`（kind: scribe/artificer 窄路） | 🟡 OPEN by design（治理语义，勿轻动） |
| **DC-5** | Runtime receipts → Learning | block/放行实况 | 观测闭环≠学习闭环 | PRI-835 §5E；HEAD 复核 0 消费者 | 🔴 OPEN（大机制，非本 MVP） |
| **ND-1** | Owner 标注 → auto consumer cycle | BehaviorExamplePack | **自动链 Artificer 恒 fail-loud**（`behavior_example_pack_missing`），RuleCode 只能经 CLI Operator 路径 | `internalization-consumer-cycle.ts:569-575`（runnerOptions 无包字段，HEAD 复核） | ⚪ **设计使然**（v2 要求 Owner 标注=治理特性，非缺陷；记录边界） |
| **ND-2** | Diagnosis → Artificer | rootCause/根因证据 | Artificer 从原则文本间接推导"为什么"，未直连根因 | artificer prompt 输入清单（PRI-841 map；HEAD 复核） | 🟡 OPEN（**MVP-2 目标**） |
| **ND-3** | Evaluator artifacts → 未来 formation | 历史评审结论/失败案例 | 同痛感重复犯错无跨 formation 记忆 | evaluator 工件持久化但 formation 链无消费者 | 🔴 OPEN（Learning 契约缺失，随 DC-5） |

## Consumer Context Requirements（Phase 4——需求定义，非实现）

### Scribe Contract（当前满足度：高）

- Required：诊断证据 ✅ · 候选全集 ✅ · provenance ✅ · 约束（antiPatterns 经 philosopher）✅
- Missing（低优先）：原始 Pain 原文（诊断投影已携带证据数组；边际价值待证）

### Artificer Contract（当前满足度：中高）

- Required：principle ✅ · intentContract ✅ · 候选集+差异摘要 ✅ · Owner 标注示例 ✅ · 修复反馈 ✅ · 宿主语义 ✅
- Missing：**diagnosis rootCause**（ND-2——为什么这个行为是痛；当前从原则文本二阶推导）· 例外场景（正例在包内，覆盖面受 Owner 标注数量限制）

### Evaluator Contract（当前满足度：中——**最大缺口**）

- Required：规则产物 ✅ · 源原则 ✅ · intentContract ✅ · 期望行为（goldenTraceCases 在 artificer 工件内）✅ · 工具目录 ✅
- Missing：**provenance（原始 pain/diagnosis/候选）** ❌ —— 无法判定"原则本身是否忠于痛感"（DC-4a）；**验证场景独立源**（复用 Owner 案例判定自身生成物，自举风险由 repair loop 缓解）

### Learning Contract（未来 formation ← 历史 evaluation；当前满足度：零）

- Required：历史失败案例 · 已否决方向（DC-2）· 运行时 block 实况（DC-5）——全部 OPEN，属下一阶段议题，不入本次 MVP。

## Architecture Options（Phase 5）

### Option A — 恢复旧 ContextManifest 平面

- **优点**：设计文档完整（871 行）；声明式需求清单在概念上清晰；git 历史可整体找回。
- **缺点**：① 生产实测证伪（Layer 0 = 0/320，Layer 1 开而无效）；② 恢复要求全生产者加信封写入（侵入所有 runner）；③ 三个 flag 是 **gone 终态墓碑**，恢复=推翻 PRI-819 Owner 退役裁决；④ PromptBudgetManager 从未真实触发过，属未经验证的复杂度。
- **风险**：HIGH——把已判死的复杂度请回来，且违反 lifecycle 治理。
- **符合当前架构？** ❌（与 PRI-815 瘦身方向、R-06 Owner 裁决直接冲突）

### Option B — Consumer-driven Context Contract

- **优点**：① **已被验证两次**（PR #1756 两半 = 两次 consumer 侧接线，PRI-838/841 量化收益）；② formation-context.ts 是现成生长点（2 真实消费者 = P7 真实 seam）；③ 每条连接局部、可测、可逆、fail-loud 降级（事件词表成熟）；④ 无新权威/新库/新 flag；⑤ 有界投影在消费侧 = token 控制贴着真实预算点。
- **缺点**：① 逐边 resolver 有重复倾向（clamp ×3 已现）；② 无全局预算视野（跨消费者总额无协调）；③ 契约存在于代码注释与 SPEC 中，无独立文档面（漂移需 review 拦截）。
- **风险**：LOW-MEDIUM——纪律成本，非结构风险。

### Option C — Hybrid（Context Registry + 消费者需求契约 + 全局预算控制）

- **优点**：单一预算权威；契约显式化；对多消费者扩展性最好。
- **缺点**：① Registry 在 2 个消费者下 = **speculative subsystem**（P7 红线：零到一消费者 → 通常投机；两消费者 → 质疑 seam；三+ 才谈 registry）；② "消费者需求契约"层概念上就是 ContextManifest 换名——有重蹈覆辙的真实风险；③ 全局预算管理器正是从未被触发过的 PromptBudgetManager。
- **风险**：MEDIUM——架构漂移向"ContextManifest 2.0"。

### 评分表

| Dimension | A（恢复旧平面） | B（消费者契约） | C（混合） |
|---|---|---|---|
| Complexity | ✗ 高（全生产者侵入+三层） | ✅ **低**（逐边局部） | ✗ 中高（新子系统） |
| Reuse existing code | ✗ 低（复活死码） | ✅ **高**（扩展现有 seam） | ⚠️ 中（复用但外加壳） |
| Governance safety | ✗ **低**（推翻 gone 终态裁决） | ✅ **高**（只读连接，零新权威） | ⚠️ 中（registry=新治理面） |
| Token control | ⚠️ 理论全局/实际从未生效 | ✅ 消费侧硬帽已实证（8000c+降级顺序） | ⚠️ 全局预算未验证 |
| Migration risk | ✗ 高 | ✅ **低**（每步可逆） | ⚠️ 中 |
| Long-term scalability | ⚠️ 未证 | ⚠️ 中（消费者多了需再评估） | ✅ 理论最高 |

**结论：B 全面胜出；C 的"理论扩展性"在第三个真实消费者出现前不构成行动理由（记录为触发条件，而非现在建设）。**

## Recommended Direction（含 Minimal MVP）

**方向：OPTION_B——以 formation-context.ts 为消费者契约模块的自然生长点，Connection before Creation。**

### 如果只能改 3 个地方

| # | 改动 | 类型 | 关闭断点 | 为什么是它 |
|---|---|---|---|---|
| **MVP-1** | **Evaluator Formation Context**：`evaluator-runner.buildContext` 调用**现有** `resolveFormationContext`（镜像 scribe-runner:219 的接线形态），prompt builder 加条件 provenance 块 | 连接（一次取件+一个条件块） | DC-4a | 全链最大未满足契约（ evaluator 是唯一同时看规则与原则却看不见痛感的决策点）；模式已被 Scribe/Artificer 两次验证；PRI-841 显示消费者接入即收益 |
| **MVP-2** | **Artificer Diagnosis Evidence**：artificer 侧复用 `resolveFormationContext` 的 `sourceDiagnosis` 块注入 prompt（与现有 dreamerContext 并列） | 连接 | ND-2 | PRI-841 失败分类 B 证明"消费面宽度"是质量传播杠杆；诊断块已在 resolver 输出中，仅缺一个消费者 |
| **MVP-3** | **单一有界投影权威**：三处私有 clamp（artifact-summary / quality-scorecard / formation-context，PRI-838 follow-up #2 已登记）收敛为 formation-context.ts 导出的一个助手 | 收敛（P4） | 重复消除 | 这是 Option B 缺点①的直接解；也是"Budget Guard"的正确形态——**一个钳制语义权威，而非全局预算管理器** |

**明确不做**（记录）：DC-2（philosopher 落盘被否候选——需跨边界 schema 变更，且候选集已部分代偿）；DC-4b（原则回写边——治理语义）；DC-5/ND-3（Learning 契约——独立 initiative）；ND-1（auto cycle 包通道——治理特性非缺陷）；任何 Registry/全局预算器（触发条件：≥3 个真实消费者 且 实测跨 resolver 预算冲突）。

## Governance Impact（Phase 7）

| 检查项 | MVP-1/2/3 影响 |
|---|---|
| Owner Authority | **零**（只读上下文连接；approval/activation/RuleHost 不触） |
| Principle Provenance | **增强**（evaluator 首次能对照原始痛感验证原则忠实度） |
| Rule Approval | **零**（审批流输入不变） |
| Runtime Governance | **零**（运行时 gate/RuleContextV2 不变） |
| 新增 authority？ | **无** |
| 新增 source of truth？ | **无**（formation 证据仍派生自 pi_artifacts；包仍 Owner 标注） |
| 新增 durable store？ | **无**（零 schema 变更） |
| 双 pipeline？ | **无**（同一批 runner/prompt 条件扩展，缺证据时回退现形态） |
| flag？ | **无新 flag**（PR #1756 模式即无 flag：可解析即注入，降级即事件） |

## Next Steps

1. **Owner 裁决本审计方向**（OPTION_B + MVP-1/2/3）——若批准，逐条立单（建议 PRI 粒度：一条一个连接，均可独立验收：MVP-1/2 = prompt 契约版本 bump + vslice 测试；MVP-3 = 纯收敛 + 字节等价回归）。
2. **PRI-841 续跑**（ZAI 配额 2026-09-22 重置后，harness 断点续跑至 16 三元组）——把 EXPLORATORY 幅度做实，同时为 MVP-1 提供 evaluator 侧的基线。
3. **触发条件记录**（非现在建设）：第 3 个真实消费者出现 / 实测跨 resolver token 冲突 → 届时再评估是否从 B 演进到 C 的**局部**形态（如共享 budget 常量表），仍不建 registry。
4. **DC-2 / DC-5 / ND-3** 保持 OPEN 登记，随 Learning 契约议题（Context Intelligence Layer 的第二阶段）另立 SPEC。

---

# 附录 — 证据与纪律

**基线（Phase 0）**

```text
BASE_SHA          = 99666f436374e8510cd3a5d563fc91009faa0db3  (= origin/main, 含 PR #1754)
current branch    = main（与 origin 同步）
PR#1756 merge     = a07981c9（已验证为 HEAD 祖先）
PRE1756 基线      = 89eb275e（历史模块存在态，供本审计 diff）
```

**关键 git 锚点**：引入 `0d6619852`(L0) / `128c38f4b`(L2+预算) / `e7f1b5a59`(lineage) / `d83cb2bbf`(manifest+resolution)；删除 `0a8fa715`(R-06)；继任 `5508ed6e`(formation-context, PR #1756)。

**纪律声明**

```text
CODE_CHANGES   = NONE（唯一新增 = 本审计文档，untracked）
DB_ACCESS      = NONE（本审计无需生产数据——全部结论可由源码+git+既有 MEASURED 审计支撑）
CONFIG/FLAG    = NONE
PR             = NONE
LINEAR         = NONE（按任务指令；方向待 Owner 裁决后再立单）
```

**Final Verdict**

```text
PRI_842_RESULT = OPTION_B_CONSUMER_CONTEXT_CONTRACT
```
