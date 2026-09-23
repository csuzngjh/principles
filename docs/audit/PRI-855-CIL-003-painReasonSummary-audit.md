# PRI-855 CIL-003 PainReasonSummary Producer Gap Audit

> 只读架构审计。无代码/schema/配置变更。
> 审计问题：`painReasonSummary` 有消费者——生产者是真的缺失，还是该字段已被更权威来源替代？

---

## Executive Summary

`painReasonSummary` 在 PD 中**从来没有过生产写入者**（2026-05-20 PRI-185 引入读者时即如此，全历史 `-S` 检索无删除写入者的痕迹）。它不是被遗弃的 writer，而是一个**自诞生起就按"可选呈现槽位"设计的字段**：PRI-530 receipt 设计规格 §7.4 明文规定"只在 artifact 实际携带时显示，缺失时降级，不编造来源"，且有测试/BDD 锁定该降级路径。

它的语义内容（"这条原则源自什么 pain"）如今已有**单一权威来源链**：`pain_events.reason/text`（PRI-844 一等 pain evidence）→ diagnostician `diagnostic_json` / `rootCauseSummary` → `resolveSummary()` 优先链 → `evidenceRefs`/`intentContract`（已被转发进生产 rule contentJson）。

因此：**不应为补齐该字段新增独立 writer（违反 P4，制造第二个摘要权威）**。字段当前职责 = bounded presentation evidence，不影响任何治理权威（approval authority / allowedActions / completeness / activation 均不读取它）。其最终去留（映射 formation 证据 vs 废弃）应作为 PRI-858 已建议的「Owner 决策证据面」合并 SPEC（CIL-002 + CIL-003）的设计决策点，与本审计前置两份报告的结论一致。

`PRI_855_CIL003_RESULT=SPEC_REQUIRED`（范围并入 CIL-002+CIL-003 合并 SPEC；本审计单独否决方案 A"就地补 writer"）。

---

## Baseline

```
BASE_SHA (local HEAD) = 47946c16cf6dbf88234c03b1038c401aea4fde86
branch                = main
origin/main SHA       = e3bbcfb693477ae40577ba20f521b872f2f9797c
本地 main             = 落后 origin/main 22 提交（ahead 0 / behind 22）
```

- 关键复核：全部 VERIFIED 结论已在 `origin/main`（e3bbcfb6）上用 `git grep` 逐点复读，行为一致（读者 3 处、生产写者 0 处、字段清单不变）。
- 最近合并的相关工作：PRI-843/846（evaluator formation context）、PRI-844（pain evidence 一等化）、PRI-855 覆盖度审计（CIL-003 登记处）、PRI-858（Owner 决策上下文审计）。
- 本地仓库代码状态不足以推翻结论；behind-22 已核实不改变本审计任何事实判定。

---

## Definition Map（Q1）

| Location | Type | Purpose | Evidence |
|---|---|---|---|
| （无 schema/interface 定义） | — | 该字段**没有任何权威类型定义**：不在 `ArtificerRuleOutputSchema`（`packages/principles-core/src/runtime-v2/internalization/artificer-output.ts:77-106`）、不在 `DreamerOutputV1Schema`（`dreamer-output.ts:78-81`）、不在任何 DB 列 | VERIFIED |
| `openclaw-plugin/src/core/principle-receipt-metadata.ts:66-84` | 局部内联类型（`extractArtifactFields` 返回值） | 从 `pi_artifacts.content_json` 防御性提取（rc-1/rc-2），仅 reader 侧 | VERIFIED |
| `principles-core/.../activation/writers/rule-host-writer.ts:395-398` | 局部 `unknown` 读取 + typeof 守卫 | `contentJson` 里的自由 key，非契约字段 | VERIFIED |
| `principles-core/.../internalization/evaluator-prompt-builder.ts:192` | prompt 文本引用 | 指示评估器可读 `painReasonSummary`——同样非类型化 | VERIFIED |
| `feature-flags/feature-flag-contract.ts:338,341` | 注释 | `principle_receipt_block_copy` flag 描述提及"optional painReasonSummary source line" | VERIFIED |

**结论**：它从来不是 interface/schema/API contract 层面的字段，而是 `content_json` JSON blob 里的一个**约定俗成的可选 key**。生产 DB 中它的存在与否完全取决于写入方是否恰好塞过它（demo/seed 数据）。

---

## Consumer Map（Q2）

| Consumer | File:Line | Purpose | User Visible? |
|---|---|---|---|
| RuleHostWriter 审批上下文 | `rule-host-writer.ts:395-411` | 作为 approval `triggerReason`；缺失时回退固定文案 `'RuleHost candidate requires human approval before activation.'` | 是——Console approvals 卡（`pd-console/src/ui/utils/validators.ts:1661,1689` 解析 `triggerReason` 展示） |
| Principle Receipt 元数据 | `principle-receipt-metadata.ts:82-83,199` | 提取后 `slice(0,60)` 成 `sourceSummary`，进入拦截文案的"来源"行 | 是——agent 转述 + 工具卡片（`gate-block-helper.ts:308-316`，仅当字段真实存在才显示来源行） |
| Evaluator prompt | `evaluator-prompt-builder.ts:192` | 提示评估器用 pain 来源校对 code intent | 否（模型上下文）；生产 rule artifact 无此字段 ⇒ 该引用在生产中是**死读路径**（INFERRED） |
| 测试/BDD（约 20 文件） | `rule-host-writer.test.ts:931,942`、`principle-receipt-metadata.test.ts:139`、`principle-receipt-block-copy.steps.test.ts` 等 | 锁定"缺失回退"与"存在才显示"两向行为 | 否 |

治理面重点：**Owner Decision（Console approvals）与 Evidence View（receipt block copy）是仅有的两个人类可见消费点，且两者都有已测试的缺失降级路径。** Reports/Audit 面无消费者。

---

## Producer Map（Q3）

| Producer候选 | File:Line | Source Data | Runtime Path? |
|---|---|---|---|
| Story A demo 种子 | `story-a-demo.ts:89,139` | 硬编码 demo 文案 | 否——`pd demo story-a` CLI 专用（PRI-246，9a1de9773） |
| Proven-channel 合成基线 | `proven-channel-baseline.ts:123` | 硬编码 `Synthetic:` 前缀 | 否——验证基线数据 |
| 测试 fixture | openclaw-plugin tests 多处 | 手工注入 | 否 |
| legacy-import | `pd-cli/src/legacy/legacy-import.ts:146-154` | 计算 `reasonSummary` 写入 **`tasks.diagnostic_json`** —— 是**另一个 key、另一张表**，不是本字段 | 是（legacy 同步），但与 painReasonSummary 无关 |
| 生产 rule artifact 组装 | `evaluator-runner.ts:3192-3212` `ruleContent` 字段清单 | implementationCode / goldenTrace(Cases) / affectedTools / ruleHostGateDecision / sourceArtificerArtifactId / adversarialResult / requiresContextVersion / evidenceRefs / intentContract | **不含 painReasonSummary** |
| Artificer 工具契约 | `artificer-l2-tool-contract.ts:365` 提交字段清单 | taskId…evidenceRefs, requiresContextVersion | **不含 painReasonSummary** |
| Scribe/Dreamer 输出 schema | `scribe-output.ts` / `dreamer-output.ts:68-81` | 原则文本 / candidates | **不含 painReasonSummary** |

**Producer Status: MISSING**（VERIFIED：生产写入路径不存在；且 Q7 证明历史上也从未存在过）。

---

## Source Authority Analysis（Q4）

painReasonSummary 想表达的语义 = "此原则/规则源于哪个被纠正的 pain"。该事实当前的权威链：

1. **Pain 原始来源**：`pain_events` 表（`host-runtime/src/production-pain-evidence.ts:417-419`，PRI-844）——`reason`（结构化 `tool=…; error=…; path=…`）、`text`（evidence 条目）、`severity`、`canonical_pain_id`。这是运行时 pain 的 first-class 记录。
2. **Diagnosis 来源**：diagnostician 任务 `diagnostic_json`（含 `reasonSummary`，`legacy-import.ts:148-154`；及诊断工件）；`rootCauseSummary` 已进入证据链摘要优先链。
3. **摘要权威函数**：`resolveSummary()`（`evidence-chain-contract.ts:510-522`）已定义该语义的**单一裁决顺序**：`candidateTitle > rootCauseSummary > painText > painReason > fallback`。
4. **Formation/Provenance 通道**：rule artifact 已携带 `evidenceRefs`（PRI-490，`evaluator-runner.ts:3203-3207`）与 `intentContract`（PRI-703，`:3208-3211`）指向原则/pain 上游；`FormationProvenance.sourcePainId` 通道存在但有独立的 CIL-006 编造风险（另案）。

**判定**：painReasonSummary 是上述 1–3 的**下游重复摘要**，且为无 schema、无写入契约的重复。任何新 writer 都只是在 4 个已竞争的事实源上再加第 5 个。

---

## PRI-858 Relationship（Q5）

- PRI-858 审计（`docs/audit/PRI-858-owner-decision-context-audit.md:18-20,167-168,224-227`）建议的方案 A：Owner 决策证据面复用 `resolveFormationContext()` / `FormationDiagnosisProjection` 做 bounded 投影，并明文将 CIL-003 并入同一 SPEC，"避免再造第二写入者（P4）"。本审计独立复核支持该判断。
- 关系结论（INFERRED，标注为推断）：若该合并 SPEC 落地，Owner 在决策面将看到来自 pain/diagnosis 权威的来源证据，`triggerReason`/`sourceSummary` 两个呈现槽位可由同一投影供给——届时 `painReasonSummary` 这个 blob key 本身即成为可废弃的遗留读取分支（旧数据仍可在降级链里读，直到清退）。
- 它不是"PRI-858 取代后剩下的孤儿"（PRI-858 的 SPEC 尚未立项），而是**同一断点的旧式呈现需求 + 新式权威来源已经先行到位**的错位。

---

## Historical Timeline（Q7）

| Date | Commit/Issue | Decision |
|---|---|---|
| 2026-05-20 | `2d788b2a4` / PRI-185 (#654) | 引入**读者**：RuleHostWriter 审批上下文从 contentJson 读 painReasonSummary 作 triggerReason，同时定义缺失回退。该 commit 仅 4 个文件（dispatcher/types/writer/test），**从未包含生产者** ⇒ "有读者无写者"是自诞生状态，非后来被删（VERIFIED via `git log -S` 全史 + `git show --stat`） |
| 2026-05-24/25 | `9a1de9773` / PRI-246 | Story A demo 与 proven-channel 基线**硬编码写入**该字段——生产中该 key 的几乎唯一来源 |
| 2026-06-18 | `eae6f5f69` / PRI-421..428 (#963) | RuleHost MVP 生产 rule artifact 组装成型（`assembleRuleArtifact`），字段清单**不含** painReasonSummary |
| 2026-06-20 | `ac84abd68` / PRI-436 (#985) | SQLite 成为 RuleHost 唯一来源；写入路径不变 |
| 2026-08-16 | `e1c1f111e` / PRI-530 (#1327) | Principle Receipt P0 消费该字段作"来源行"，设计规格 §7.4 明文：**"只在 painReasonSummary 存在时显示（当前约 1/10 artifact 有）……不编造来源"**——缺失=设计内降级，非疏漏（spec:176,211） |
| 2026-09-19 | PRI-855 覆盖度审计 | CIL-003 登记（P2）："有读者、无生产写者"，建议与 CIL-002 合并 SPEC |
| 2026-09-19 | PRI-858 审计 | 复核 CIL-003 并入方案 A 的 SPEC 范围；PRI_858_RESULT=SPEC_REQUIRED |
| 2026-09-19 | PRI-844 (#1764 合并) | pain evidence 一等化——`pain_events.reason/text` 成为来源事实权威 |

（PRI-437 `4314b752a`、PRI-486、PRI-494、PRI-519 等仅将字段作为测试 fixture 传播，无决策意义。）

---

## Solution Options（Q8）

| 方案 | 说明 | 复杂度 | 风险 |
|---|---|---|---|
| A 保留字段并补 writer | 在 `assembleRuleArtifact` 或 scribe 链转发 pain 摘要进 contentJson | 低（改动小）但**制造第 5 个摘要事实源** | **违反 P4 单一权威**；摘要与 pain_events/diagnosis 漂移后无法裁决谁真；receipt 截断链再复制一份（`slice(0,60)`）——Multiple Summary Authority Risk = **YES，否决** |
| B 映射已有 Formation/Diagnosis 证据 | 两个消费槽位（triggerReason、sourceSummary）改由 `resolveFormationContext()`/`resolveSummary()` 权威链供给，字段本身不新增写入 | 中（跨 consumer 改造）| 依赖 CIL-002 SPEC 落地；对旧 blob 数据需保留只读降级链 |
| C 删除字段/废弃 | 直接移除读者与 demo 写入 | 低 | 会破坏已交付的 PRI-530 receipt 来源行能力与既有 BDD 契约，且 Owner 决策证据面尚未接通——先删后接=净信息损失；**只能在 B 落地后执行** |
| D 暂不处理 | 维持降级常态 | 零 | Owner 审批卡永远显示泛化 triggerReason；prompt 死读路径留存；CIL-003 已登记，不处理=接受 P2 长期挂账 |

**推荐路径**：D→B→C 序贯——不单独立项，在 CIL-002+CIL-003 合并 SPEC 内取 B（连接而非创建，P2.1 Connection Before Creation），SPEC 的验收标准里同时钉死 C（字段读取分支进入 deprecation 名单）。

---

## PRI-858 补充 · Governance Review

`painReasonSummary` 是否影响治理权威？**不影响。**（VERIFIED）

- approval authority / `allowedActions` / completeness / activation 判定：**零读取点**。`rule-host-writer.ts` 只将其用于 `triggerReason` 显示字符串（`:409-411,430`），写入 `approvals.trigger_reason` 列是纯记录；`principle-receipt-metadata.ts:201-203` catch-all 降级且注释明示"never break the block decision"；gate 拦截决策完全不读取它。
- 因此其定位是 **presentation evidence（bounded 呈现层）**：影响的是 Owner"看到什么理由"，不是"系统允许什么动作"。缺口的真实性质是**呈现质量退化到泛化文案**，不是治理正确性问题——这也是 P2（而非 P0/P1）定级的依据。

---

## Recommendation

1. **不为 painReasonSummary 新增独立 writer**（方案 A 明确否决；本审计的独立增量结论）。
2. 维持 PRI-855/PRI-858 已有建议：进入「Owner 决策证据面」合并 SPEC（CIL-002 + CIL-003），以既有 `resolveFormationContext()` / `FormationDiagnosisProjection` / `resolveSummary()` 优先链为唯一来源，向 `triggerReason` 与 `sourceSummary` 两个呈现槽位做 bounded 投影（方案 B）。
3. 在该 SPEC 中同步登记字段废弃路线（方案 C 次序在 B 之后）：schema 层本无此字段，废弃成本仅在两个 reader 的降级链清理。
4. 顺手项（SPEC 内一行即可）：`evaluator-prompt-builder.ts:192` 对 `painReasonSummary` 的引用在生产中是死读路径，应随字段废弃一并改指权威来源。

---

## Final Result

```
PRI_855_CIL003_RESULT=SPEC_REQUIRED
VERIFIED_COUNT=11
INFERRED_COUNT=3
UNKNOWN_COUNT=2
```

VERIFIED（11）：① 无 schema/契约级定义；② 读者=rule-host-writer triggerReason（含锁定回退的测试）；③ 读者=receipt sourceSummary（含"存在才显示"BDD 锁定）；④ 读者=evaluator prompt 文本；⑤ 生产 writer 不存在（assembleRuleArtifact 字段清单）；⑥ 全历史无 writer 曾被删除（-S 检索 + PRI-185 stat）；⑦ PRI-530 规格明文"缺失=设计内降级、不编造"；⑧ pain_events/resolveSummary 权威链存在且不含本字段；⑨ 治理权威零读取点（纯 presentation）；⑩ origin/main(e3bbcfb6) 复核一致；⑪ PRI-855/858 前置登记与建议原文。

INFERRED（3）：① 活库 9/96 含字段 artifact 大概率源自 demo 播种（未做只读 DB 逐行核对）；② evaluator prompt 死读路径对产出质量的影响未测量；③ 合并 SPEC 的自然终点是 B→C（字段清退）。

UNKNOWN（2）：① 生产 workspace 中 triggerReason 泛化回退的实际发生率与 Owner 感知（NOT VERIFIED）；② 旧 blob 数据中 painReasonSummary 与 pain_events 真值的一致性（NOT VERIFIED，无 DB 探测授权范围内动作）。

**核心问题回答**：`painReasonSummary` 在当前 PD 架构中的真实职责是**前 pain-evidence-一等化时代的可选呈现槽位**——它的信息本体已有单一正确来源（`pain_events` → diagnosis → `resolveSummary()` 优先链），字段本身不构成事实权威，也不缺一个"应该补上的生产者"；缺的是把权威来源连接到两个呈现消费点的那根线，而那根线已经有一个待立项的 SPEC 归属（CIL-002+CIL-003 合并）。
