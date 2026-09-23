# Context Intelligence Layer Final Consolidation Audit

> 只读架构审计。无代码/schema/配置/flag/Linear 变更。
> 核心问题：① PD 是否已形成稳定的 Consumer-driven Context Contract 模式？② 还有哪些**真实断链**值得继续修复？
> 判定纪律：Source Exists → Consumer Exists → Contract Broken → Measured Value，四问全过才算值得修的断点。

---

## Executive Summary

**Consumer-driven Context Contract 模式已经成立。** 全仓只有一个事实 resolver（`formation-context.ts`），四个消费者（Scribe / Artificer / Evaluator / Owner Decision）按同一套不变式接线：bounded 投影、contextHash 覆盖实注入证据、rc-9 可观测降级、治理中立（证据不进 capability/authority）。PRI-846（81d2d0ca 复审修复后）、PRI-859（#1769）、PRI-858（#1770）三笔修复在当前 main 全部验证落地，且各自的锁定的测试都在。

`painReasonSummary` 判定为 **LEGACY**：3 个读者、0 个生产写者（第三次独立复核一致），其语义已被 `resolveFormationContext` / `resolveSummary()` 权威链取代；但它的收敛路线存在**未裁决的路线张力**——Backlog 票 PRI-861 提议"组装时 echo 写入"，而 PRI-858 SPEC v1.1 与本链审计结论均反对任何新 writer、建议读时投影。这需要一次 Owner 路线裁决，不需要新调查。

**唯一新发现的未票化真实断点：CIL-006（`sourcePainId` 由 LLM 自由文本经 resolver 直抬为 provenance）——且 PRI-858 刚刚把这条未设防通道从"模型可见"升格为"Owner 决策卡可见"。** 同一文件对 `sourcePrincipleId` 有显式反编造守卫，`sourcePainId` 裸奔。此项 P2、值得小 SPEC。

其余：Philosopher（已票化、实验门槛正确）、Dreamer 单跳 fragility（发生率未测）、CIL-007 持久化（低值顺带）、Linear 重复票（卫生）。

`CIL_FINAL_STATUS=MINOR_GAPS_FOUND`

---

## Baseline

```
BASE_SHA (local HEAD)  = 47946c16cf6dbf88234c03b1038c401aea4fde86
branch                 = main（落后 origin/main，全部结论在 origin/main 上复核）
origin/main SHA        = 0909c7f31e52f43ea851f63cb888bb752d432a46
```

| 票 | 在 main？ | 证据（VERIFIED） |
|---|---|---|
| PRI-842 / PRI-843 | 审计文档在 main；843 技术结论经 846 落地 | `docs/audit/CONTEXT_INTELLIGENCE_LAYER_ARCHITECTURE_AUDIT.md`；PRI-843 票面仍 Backlog |
| PRI-846 | ✅ | `ce788eb4` + 复审修复 `81d2d0ca`，merge `ac41ef6e`（#1766） |
| PRI-855 | ✅ | `e7f97a73`，merge `47946c16`（#1767） |
| PRI-859 (CIL-001) | ✅ | `dabbf387`，merge `7e8bf2f0`（#1769）；Linear Done |
| PRI-858 (CIL-002) | ✅ | `407e9056`，merge `50ac89d2`（#1770）；Linear Done |
| CIL-003 审计 | 文档在工作区（本会话交付，未提交，属只读任务合规状态） | `docs/audit/PRI-855-CIL-003-painReasonSummary-audit.md` |

---

## Current Context Graph

```
Pain (pain_events, PRI-844 一等化)
 ↓  (bridge: 任务行种真值 sourcePainId :248 — dreamer 不读，见 GAP-1)
Diagnosis (diag_* 工件, pi_artifacts)
 ↓
Dreamer ── 单跳 first-artifact 读 predecessorOutput（无 resolver；CIL-005 残留）
 ↓
Philosopher ── 无 formation 消费（设计选择，已票化 PRI-860 待 A/B）
 ↓
Scribe ──✅ PRI-838：resolveFormationContext → prompt 投影 + addendum；hash 覆盖
 ↓
Artificer ──✅ PRI-839 投影 + ✅ PRI-859：contextRefs=[artifactRef, sourceDreamerArtifactId] 进 hash（prompt 形状不变）
 ↓
Evaluator ──✅ PRI-846：resolveFormationContext（evaluator-runner.ts:536）；contextRefs 含 dreamer+diagnosis id；mismatch 路由以 formationContextPresent 为前置
 ↓
Owner Decision ──✅ PRI-858：resolveOwnerFormationEvidence → brief.formationEvidence（bounded、rc-9 notes、digest 覆盖、治理中立测试）→ Console 决策卡「形成来源」
```

| Consumer | Input Context | Source | Resolver | Evidence Visible | Status |
|---|---|---|---|---|---|
| Scribe | dreamer proposals + diagnosis + provenance | `pi_artifacts` lineage | `resolveFormationContext`（scribe-runner.ts:35） | prompt | CONNECTED |
| Artificer | bounded 候选集 + differences | 同上 | `projectDreamerProposals`/`summarizeCandidateDifferences`（artificer-runner.ts:44）+ PRI-859 hash | prompt + cache identity | CONNECTED |
| Evaluator | formation 证据 + 规则 + 原则文本 | 同上 | `resolveFormationContext`（evaluator-runner.ts:536） | prompt + 治理路由 | CONNECTED |
| Owner Decision | bounded 诊断投影 + sourcePainId + provenance + notes | scribe `sourceTrace.dreamerArtifactId` → 同一 resolver（窄 read-only view 适配） | `resolveFormationContext`（owner-decision-review.ts） | Console 决策卡（snapshot digest 覆盖） | CONNECTED（evaluator 分支；rollout 分支未投影=范围外） |
| RuleHost 审批卡 triggerReason | ~~painReasonSummary~~（死字段） | 权威源存在于 resolver | ❌ 未接 | 泛化回退文案为常态 | **DISCONNECTED** |
| Receipt sourceSummary | 同上 | 同上 | ❌ 未接 | 来源行永不出现（生产） | **DISCONNECTED** |
| Philosopher | 仅 dreamer 工件 | — | 无（grep 零命中） | — | DISCONNECTED（设计选择，见 GAP 矩阵） |
| Dreamer | predecessorOutput（单跳首工件） | dependencyTaskIds | 无 resolver | — | PARTIAL（CIL-005） |

**resolver 消费者总数 = 4（2 类 materially different：runner prompt 侧 / read-only review 侧），符合"非投机 seam"判定。**

---

## Completed Fix Verification

### PRI-843/846 — Evaluator

- **Before**：evaluator 只能判"规则忠于原则文本"，问不出"原则忠于 pain"（prompt 无诊断输入）。
- **After**：`evaluator-runner.ts:534-570`（origin/main 实读）——从 scribe 权威 `sourceTrace.dreamerArtifactId` 解析；`contextHash` 折叠 dreamer+diagnosis id（"prompt 实际携带的证据必须进身份"不变式）；失败路径发 `evaluator_formation_*` 事件（`telemetry-event.ts:310-314`，scribe 侧 `:192-196`，ERR-136 复审教训已入记录树）。
- **Evidence**：VERIFIED（代码实读 + merge `ac41ef6e` + ERR-136 pattern record）。

### PRI-859 — Artificer context identity

- **Prompt content**：`dreamerContext` 形状未变（`ResolvedDreamerContext` 把 provenance 作 sibling 传出，注释明示"never inside it"）。
- **Identity hash**：`contextRefs = [artifactRef, ...(resolvedDreamer ? [sourceDreamerArtifactId] : [])]` → `hashContextRefs`；缺省回退旧身份。
- **Consistency**：与 scribe（PRI-838）/ evaluator（PRI-846）同一规则，三阶段不变式现已齐平。
- **Evidence**：VERIFIED（`git show dabbf387` 全 diff + 231 行回归测试 `artificer-runner-vslice.test.ts`）。

### PRI-858 — Owner Decision

- **Evidence visible**：`brief.formationEvidence = {version, sourcePainId, diagnosis?(bounded projection), provenance, notes≤8}`；legacy 无 dreamer id ⇒ 字段缺席；有 id 解析失败 ⇒ 无 diagnosis + 可观测 reason notes（`formation_context_unavailable` 兜底）——正是 SPEC"证据不可用 + reason code"形态。
- **Authority unchanged**：专项测试 "is governance-neutral: only visibility changes, authority and state machine do not"；`FormationArtifactReader` 窄 view 适配未拓宽 `PIArtifactStore`；identity 测试 "does not reuse the old identity" 锁定 digest 覆盖。
- **Evidence**：VERIFIED（本会话完整读 diff + 7 项测试清单 + UI/i18n 文件 + Linear 票 Done 评论同步）。

---

## Consumer Gap Matrix

| # | Consumer/点位 | Needs Context? | Source Exists? | Connected? | Impact | Recommendation | 分类 |
|---|---|---|---|---|---|---|---|
| G1 | `sourcePainId` 数据可信性（resolver provenance 抬取） | 是 | 真值在 bridge 任务行（`intake-to-internalization-bridge.ts:248`），但 dreamer 不读；工件值来自 LLM（`dreamer-output.ts:83` optional string；few-shot `dreamer-prompt-builder.ts:91` 含编造样例 `"pain-null-crash"`） | 已连接但**未设防**：`formation-context.ts:350,796` 原样直抬；同型风险 principleId 有守卫（`stripFabricatedCorePrincipleIds`），painId 无 | PRI-858 后该值**直接展示给 Owner**，编造风险升格为决策面信任风险 | 小 SPEC：provenance 以任务行 seed 为准/不匹配即置 null（镜像既有守卫模式）；**未票化** | **A VERIFIED GAP** |
| G2 | RuleHost triggerReason / Receipt sourceSummary | 是（呈现） | 是（resolver 投影） | 否——读者存在、写的字段无人写（第三复核：3 读者 0 生产 writer） | 审批卡永远泛化文案；receipt 来源行生产不可见 | 已票化 PRI-861（Backlog）；但需先做**路线裁决**（见下） | **A VERIFIED GAP**（已票化） |
| G3 | Philosopher 诊断输入 | 未证明 | 是 | 否 | 无质量证据；PRI-855 明令"先 A/B 再立项" | 已由 PRI-860 正确票化（实验门 + Decision Rule） | **B DESIGN CHOICE** |
| G4 | Dreamer 空依赖/首工件单跳（CIL-005） | 是 | 部分（artifactId-only seed 时依赖为空→静默 null 路径仍在） | 机制断，发生率未测 | 生产是否实际走该形态 UNKNOWN | 最小连接修复（回退解析 `inputArtifactRefs`），随 G1 或 follow-up 顺带；不单独立项 | **D UNKNOWN**（机制 VERIFIED，频率未测） |
| G5 | `*_formation_*` 事件持久化（CIL-007 残留） | 观察性 | 是 | 半：事件名已注册达 emitter（PRI-846 修复），但 `CRITICAL_EVENT_ALLOWLIST` 仅 5 项、无 formation（`workspace-telemetry-emitter.ts:38-45` 实读） | 事后无法回答"降质是证据不足还是截断" | 不单独立项；任一后续票顺带加 2-3 个 resolved/failed 事件 | **C LOW VALUE** |
| G6 | Evaluator prompt 死引用 `painReasonSummary`（`evaluator-prompt-builder.ts:192`） | — | — | 生产中恒为空读 | 无实测影响；SPEC v1.1 明确 Deferred（需独立模型行为验证） | 随 G2 路线落地时一并改指权威字段 | **C LOW VALUE** |
| G7 | Rollout-reviewer 决策分支无 formationEvidence | 未分析 | 是 | 否（PRI-858 只加 evaluator 分支） | 未评估该面 Owner 是否需要来源证据 | 不立项；若 G2 落地后观察 | **D UNKNOWN** |

---

## painReasonSummary Review

1. **是否仍是权威来源？** 否。全仓无 schema/契约定义；语义权威的现行链 = `pain_events.reason/text`（PRI-844）→ diag 工件 → `resolveSummary()` 优先链（`evidence-chain-contract.ts:510-522`）→ `resolveFormationContext` 投影。
2. **是否有生产 writer？** 无（第三次独立复核，origin/main `0909c7f3`：写入点仅 story-a-demo / proven-channel-baseline / 测试 fixture；`assembleRuleArtifact` 字段清单不含）。历史上也从未有（`git log -S` 全史；PRI-185 引入读者即无写者）。
3. **现存 reader**：`rule-host-writer.ts:395-411`（triggerReason + 测试锁定的回退）、`principle-receipt-metadata.ts:82-83,199`（sourceSummary + "不编造"BDD）、`evaluator-prompt-builder.ts:192`（prompt 死引用）。
4. **是否应该迁移？** 是，但**先裁决路线再动代码**：
   - **路线甲（PRI-861 现方案）**：组装时经 resolver echo 一份 bounded 摘要进 rule contentJson——写时快照，读者零改动；代价是 rule 工件里多一个持久化的派生副本（P4 灰区：工件不可变，诊断工件若被修复轮更新则副本发散）。
   - **路线乙（CIL-003 审计 + PRI-858 SPEC 建议）**：读者改读时投影（复用 `resolveOwnerFormationEvidence` 形态），字段进入废弃名单。与 PRI-858 SPEC v1.1 的核心决定（"Do NOT add painReasonSummary writer"）字面一致——但注意 PRI-861 票面把 echo 定义为"never re-derive, 无第二权威"，与 SPEC 禁止的是 `pain_events→writer→contentJson` 直写链，两者并非逻辑矛盾，是**同一断点的两种收敛路线**。
   - **本审计立场**：不再补任何调查即可裁决；裁决归 Owner。删除 legacy reader（Phase 3）在两路线下都需兼容性证据（活库旧数据带该字段的实际占比未探测），维持现状正确。

`painReasonSummary Status: LEGACY`（迁移票已存在；禁止的是把它升格为需要独立生产者喂养的权威字段）。

---

## Architecture Health Review

对照 Consumer-driven Context Contract 四项病灶检查（均在 origin/main）：

| 检查项 | 结论 | 证据 |
|---|---|---|
| 第二套 resolver | **不存在** | `git grep resolveFormationContext` 全 src：定义 1 处（formation-context.ts:725,831），消费者 scribe/evaluator/owner-review，artificer 用其投影件；无平行实现 |
| duplicate summary authority | **一处残留** | `resolveSummary()` 优先链 + pain_events + diag 工件为现存权威；painReasonSummary 读者是消费残留而非竞争权威（无写者）；G2 路线裁决前风险冻结 |
| hidden context store | **不存在** | 无新库/新表/新 blob 存储；`OwnerFormationEvidence` 是 snapshot 内的 bounded 字段，落盘面 = 既有 `briefSemanticHash` 覆盖的 brief 本体 |
| unnecessary projection | **不存在** | 唯一新增投影件（`FormationArtifactReader/View`）有明确消费理由：read-only review store 不应伪造写面列满足 `PIArtifactRecord`——契约注释自证且结构兼容旧调用方；PRI-860 的"先实验再投影"门是正确的防投机机制 |

不变式已三阶段齐平并各有测试：**注入证据进 hash**（838/846/859）、**降级可观测**（rc-9 notes/事件 + 词汇注册，ERR-136 教训入库）、**观测不授权**（858 governance-neutral 测试）。

**Architecture Health: GOOD**（残留两项登记在案：G1 可信性、G2 收敛路线，均属"连接后的质量/裁决"问题，不是模式缺陷）。

---

## Remaining Work

优先级规则执行结果：**P0/P1 = 空**。没有任何一项同时满足"断链 + 源在 + 消费方在 + 已测收益"（G2 收益是呈现质量，无失败事故证据，维持 P2）。

| Issue | Evidence | Priority | Need SPEC? |
|---|---|---|---|
| **R1** CIL-006 `sourcePainId` 反编造（G1）——provenance 以任务行 seed 为准或 mismatch 置 null | `formation-context.ts:350,796` vs `dreamer-output.ts:83`/few-shot `:91`；principleId 守卫先例；**未票化，本审计唯一新立项建议** | **P2**（PRI-858 后 Owner 可见性放大） | 是——小 SPEC（单 resolver 文件 + 消费者测试镜像守卫模式）；可与 G1 的"是否改读任务行"一次裁决 |
| **R2** PRI-861 路线裁决（甲 echo-write vs 乙 read-projection） | 票面 vs PRI-858 SPEC v1.1 核心决定 vs CIL-003 审计路线 B；证据已饱和 | P2 | 不需要新调查；需要 Owner 一次路线决定，决定后各自自然成票 |
| **R3** CIL-005 dreamer 空依赖回退解析 `inputArtifactRefs` | PRI-855 CIL-005（机制 VERIFIED）；生产频率仍 NOT VERIFIED | P3 | 不单独立项；随 R1 或 R2 落地顺带 |
| **R4** PRI-860 Philosopher A/B | 已票化 Backlog（P3），Decision Rule 正确（实验先于实现） | P3 | 实验后按结果定 |
| **R5** CIL-007 formation 事件进持久化 allowlist | `workspace-telemetry-emitter.ts:38-45` 实读 | P3 | 否——顺带项 |
| **R6** Linear 卫生：PRI-856/857（Backlog）与 Done 的 PRI-858/859 完全同名，为重复票 | `linear issue PRI-856/857` 实读（标题同、票内 Acceptance 已被 #1770/#1769 满足） | P4 | 否——按 §21 规则 10 做 close-out（Canceled with rationale），本审计仅登记不操作 |
| **R7** legacy reader 删除评估（Phase 3） | 需兼容性证据：活库中带该字段 artifact 的实际占比、旧决策卡回放需求 | 暂缓 | 禁止——"无兼容性证据不得删除"（SPEC v1.1 原文），条件未成熟 |

---

## Recommendation

1. **判定模式成立**：Consumer-driven Context Contract 不再是愿景而是当前 main 的可验证现实——单一 resolver、统一身份/降级/治理不变式、四消费者同构接线、且两次复审（ERR-135/136 族）都选择了"修守卫不撤防"而非造第二机制。PD 已从"信息搬运"进入"按消费者需求连接事实"。
2. **不要再造 Context 抽象**：本轮无任何一项需要新 seam/新投影惯用法；所有建议（R1/R3/R5）都是既有机制内的连接或守卫镜像。
3. **立一张新票给 R1**（唯一未票化的 VERIFIED GAP），并在同一票或票面评论里完成 R2 的路线裁决记录——两案共用同一 resolver 契约，裁决时应一并考虑 G6 死引用的清理时机。
4. **执行 R6 close-out**（下次 reconcile/人工均可）。
5. 观察面：PRI-861 无论走哪条路线，落地后用 resolver 现成 `formation_context_resolved` 事件测一次真实收益（Owner 卡展示率 / triggerReason 非泛化率），补上本链一直缺失的"Measured Value"环节，再谈 reader 删除（R7）。

---

## Final Result

```
CIL_FINAL_STATUS=MINOR_GAPS_FOUND
VERIFIED_COUNT=13
INFERRED_COUNT=4
UNKNOWN_COUNT=3
```

**VERIFIED（13）**：① 基线与四票合并状态；② resolver 全仓唯一定义 + 四消费者清单；③ PRI-846 接线与 hash 覆盖（实读）；④ PRI-846 事件词汇注册（ERR-136 修复后）；⑤ PRI-859 contextRefs 折叠代码与回退语义；⑥ PRI-859 回归测试在场；⑦ PRI-858 投影/降级/治理中立/digest 四要件；⑧ painReasonSummary 3 读者 0 生产写者（origin/main 第三复核）；⑨ 语义替代权威链存在（pain_events→resolveSummary→resolver）；⑩ CIL-006 现状代码事实（schema optional + few-shot 样例 + resolver 直抬 + 任务行真值不读 + principleId 有守卫对照）；⑪ philosopher 零 formation 引用 + PRI-860 票面与 Decision Rule；⑫ CIL-007 持久化 allowlist 无 formation 事件；⑬ PRI-856/857 与 858/859 重复票事实。

**INFERRED（4）**：① PRI-858 将 G1 风险从模型面升格到 Owner 决策面（信任影响幅度未测）；② PRI-861 echo 路线将形成持久化派生副本（工件不可变 × 诊断可更新）；③ CIL-005 生产发生率偏低（任务图多数线性，未测）；④ rollout 分支是否需证据未分析。

**UNKNOWN（3）**：① triggerReason 泛化回退在生产 workspace 的实际占比（NOT VERIFIED）；② 全部修复轮拓扑下 BFS 单跳可达 diag_* 的覆盖率（PRI-858 U2 仍开放）；③ 活库 `sourcePainId` 字段编造率（无 DB 探测授权动作）。

**一句话结论**：链已连通、模式已稳定；剩下的不是一个新 Context 架构问题，而是一个**数据可信性守卫**（R1）和一次**收敛路线裁决**（R2）。
