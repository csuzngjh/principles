# PRI-768 Runtime Principle Selector Reality Audit

- 日期：2026-09-22
- 类型：只读架构现实验证（READ-ONLY ARCHITECTURE AUDIT）——零生产代码/配置/数据库改动，零 PR，零 Linear 写入
- 基线：`BASE_SHA = 4072eee71cc9c745a20b5991628b6ea5ca623487`（`main` == `origin/main`，0 落后），工作树仅含既有 untracked 审计文档
- 触发：PRI-768 Golden User Journey v6 发现 v6-02——Owner 已批准、激活成功的新原则因 `RUNTIME_V2_PRINCIPLE_BUDGET=2000c` + `activated_at ASC` FIFO 饱和而无法进入运行时上下文
- 证据等级：所有关键结论附 file:line / git commit / live 数据库只读查询 / live events 日志 / 既有测试之一

---

## Executive Summary

**结论一句话：当前 PD 生产链路上不存在任何"根据当前任务选择原则"的 Runtime Principle Selector。决定"这一轮 Agent 记住哪些 Principle"的机制是——把全部未停用的 prompt 通道激活按 `activated_at` 升序从 SQLite 读出，按顺序贪心装箱进 2000 字符预算，装不下的（含其后全部）直接截断丢弃。v6-02 不是 Selector 失效，而是"根本无 Selector + FIFO 装箱"这一设计的必然产物。**

四个支撑事实：

1. **注入路径零任务上下文**。Runtime V2 注入读取链 `PromptActivationReader.readActivatedPrinciples()` 的全部输入只有 `workspaceDir`（`packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts:21`）。用户消息、INTENT.md、CURRENT_FOCUS.md、原则 tags/scope/triggerPattern 等一律不进入该链路。
2. **`activated_at ASC` 在 SQL 层**。`sqlite-activation-state-store.ts:111-112`：`ORDER BY activated_at ASC`（最老在前），由 PRI-261（#727，`87b5ac1e0`）为"把激活接进 live 注入"而引入——它天生是一个 **reader**，从未被设计为 selector。
3. **2000c 是最终截断器，不是选择预算**。`trimToBudget`（`prompt-activation-reader-contract.ts:115-141`）按传入顺序首个装不下的条目即 `break`（比 legacy 选择器的"继续尝试更小的"更硬），后续原则全部出局。语义是 `load all → sort by activation ASC → truncate`，不是 `rank → pack`。
4. **v6-02 已在 live 数据上精确复现**。`D:/.openclaw/workspace` live 库 + events 日志：09-20/21 共 **574 次注入事件签名完全相同**（10 条 / 1905c / `v2Truncated=true` / 新原则缺席）；新原则 09-21 19:20:48 激活后 5 次注入仍被拒；19:33 退役 2 条最老激活，**41 秒后**（19:33:58）注入面立即变为 10 条 / 1864c / 不截断 / 新原则在场。用 live 库真实文本模拟 `trimToBudget`：装箱在第 11 位（「指令模糊时先确认意图边界…」，09-19 批准、早已被饿死 574 次注入）处 break，第 12 位的新原则**从未被评估**。

设计意图与现实的关系：PD **有过**任务感知 Selector 的完整设计——`docs/superpowers/specs/2026-08-22-principle-working-set-selector-spec.md`（Working Set Selector，v0.2），且该 SPEC §1.1 早已把本次审计的问题陈述为结构性缺陷（"预算截断相关性盲"）。但 SPEC 状态为 **Proposal — Hold**（Phase 1/2 需 Owner `mvp-exception`，登记于 post-mvp-conditional-roadmap §23，PRI-562~565）。只有 Phase 0（观测）已落地（`pd principles stats` 命令、receipt flags）。**上下文盲截断因此是"已诊断、已设计、按 MVP 纪律被刻意搁置"的现状，不是接线事故。**

```text
SELECTOR_AUDIT_RESULT=NO_REAL_RUNTIME_SELECTOR
V6_02_PRIMARY_ROOT_CAUSE=F（BUDGET_PACKER_DESIGN_CAUSES_FIFO_STARVATION；Secondary=A MISSING_SELECTOR_CAPABILITY）
```

---

## Audit Baseline

```text
BASE_SHA=4072eee71cc9c745a20b5991628b6ea5ca623487
BRANCH=main（与 origin/main 同步，rev-list 计数 0）
WORKTREE_STATUS=clean（仅 docs/audit、docs/testing、docs/specs 下既有 untracked 审计产物，无代码改动）
```

PRI-768 v6 所验证修复均在基线内（v6 报告基线 `e91ad97a` 为本基线祖先）：PRI-844 `fb397452`、PRI-846（#1766）、858（#1770）、859（#1769）、862（#1772）、863（#1775）、866（#1801）、v5 后续 `ce403c8c7`（correctionEvidence / ledger id / 分组血缘 / outcome 接线）——`git merge-base --is-ancestor` 语义经 v6 报告确认且本基线更新。

环境非阻塞，审计继续。

---

## Current Production Architecture

Live 工作区 `D:/.openclaw/workspace` 实测配置（只读读取 `.pd/config.yaml`）：

| flag | live 值 | 含义 |
|---|---|---|
| `features.prompt` | **enabled=true** | Runtime V2 prompt 注入通道开启 |
| `abstraction_layer_v1` | **enabled=false**（默认） | 生产走 **plugin-local legacy 组装路径**，非共享 host-runtime 路径 |
| `intent_engineering` | enabled=true | INTENT.md friction block 作为上下文块注入（与选择无关） |
| `principle_receipt_ledger` / `self_report` | enabled=true | presence/effect 回执开启（SPEC Phase 0 落地部分） |

因此 v6-02 事发时实际生产数据流是 **OpenClaw plugin-local 路径**（下文主链），共享 host-runtime 路径与 Codex 路径语义相同（见 Legacy vs Runtime V2 节）。

---

## Component Inventory

全仓搜索 `PrincipleSelector|select.*principle|principle.*select|trimToBudget|activated_at|RUNTIME_V2_PRINCIPLE_BUDGET|runtime_v2_prompt_activations_injected` 等后的完整组件清单（所有"名字像 selector 的东西"均已逐一核查消费者）：

| Component | File | Responsibility | Producer | Consumer |
|---|---|---|---|---|
| `SqliteActivationStateStore.listPromptActivations` | `packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts:108-123` | 读 activations 表，**SQL `ORDER BY activated_at ASC`** | activations 表（激活管线写入） | PromptActivationReader、host-runtime |
| `filterPromptActivations` | `prompt-activation-reader-contract.ts:40-46` | 过滤 `channel=prompt && action=prompt_activate && deactivatedAt=null`；**保序** | listPromptActivations | 同上 |
| `resolvePrincipleFromArtifact` | `prompt-activation-reader-contract.ts:48-113` | artifact 行 → `{principleId, text}`，fail-loud 校验（rc-3/rc-5） | pi_artifacts 表 | 同上 |
| `PromptActivationReader` | `packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts:12-157` | **reader 非 selector**：输入仅 workspaceDir，读全部激活+artifact，推导 authority | SQLite | `handleBeforePromptBuild`（prompt.ts:595-598） |
| `trimToBudget` | `prompt-activation-reader-contract.ts:115-141` | **FIFO 装箱截断器**：按传入顺序累计，首个装不下即 `break`；header 占 32c | dedupedV2 列表 | prompt.ts:636 |
| `RUNTIME_V2_PRINCIPLE_BUDGET=2000` | `prompt-activation-reader-contract.ts:3` | 字符预算常量（JS string length，非 token） | — | trimToBudget、host-runtime、principles-stats |
| `renderPrinciplesToDirectives` | `prompt-activation-reader-contract.ts:155-194` | 把 injectedIds 渲染成 `【ACTIVE BEHAVIOR DIRECTIVES】` XML directive 块（实际进 prompt 的投影） | trimToBudget 输出的 id 集 | prompt.ts:786-793 |
| `selectPrinciplesForInjection`（legacy 选择器） | `packages/principles-core/src/prompt-builder/principle-selection.ts:116-191` | priority(P0>P1>P2)+createdAt 新者优先贪心装箱，`continue` 尝试更小项，P0 强制保留；**同样任务盲** | evolutionReducer active/probation | **仅** legacy `<evolution_principles>` 块（prompt.ts:66-67） |
| `selectLegacyPrinciplesForPrompt` | `packages/openclaw-plugin/src/hooks/prompt.ts:51-80` | legacy 块组装（active 4000c / probation 1000c）+ 剪枝 mask | reducer + pruning mask | prompt.ts:568、index.ts:250（dedup 供体） |
| `buildActivePrinciplePromptContext` | `packages/host-runtime/src/active-principle-prompt.ts:31-136` | 共享路径 v2 注入：同 ASC 顺序 + 顺序装箱，**预算按渲染后 directive 长度计** | SQLite | OpenClaw 共享路径（`abstraction_layer_v1=true`，live 关闭）、Codex 适配器 |
| `handleBeforePromptBuild` | `packages/openclaw-plugin/src/hooks/prompt.ts:300-836` | prompt 组装总装：三块原则 + size-guard + 事件回执 | 上游全部 | OpenClaw `before_prompt_build` 钩子（index.ts:301-399） |
| `recordRuntimeV2ActivationsInjected` | `packages/openclaw-plugin/src/core/event-log.ts:211`（`.state/logs/events_*.jsonl`） | 注入回执事件（principleIds/injectedCharCount/budget/v2Truncated/skipReason…） | prompt.ts:657-693 | 审计/统计（principles-stats） |
| `selectLearnedPrincipleV0/V1`（semantic-selector） | `packages/principles-core/src/runtime-v2/owner-decision/semantic-selector.ts` | **Owner 决策卡展示文本挑选**（tier 序 + 可读性门），非运行时注入 | 决策卡视图 | owner-decision-view（governance UI） |
| `selectPrinciplesForBootstrap` | `packages/openclaw-plugin/src/core/bootstrap-rules.ts:35` | Rule bootstrap CLI 的 violation 计数排序，非 prompt 路径 | training store | bootstrap 命令 |
| `selectCorePrinciples` | `packages/principles-core/src/runtime-v2/core-principles/core-axiom-block.ts:60` | 静态身份公理按 scope 恒注入，无选择语义 | 代码内注册表 | `<core_principles>` 块 |
| Principle schema（tags/scope/domain/triggerPattern/applicability） | `runtime-v2/types/principle-schema.ts`、scribe-output | **数据存在但无任何注入期消费者**（SPEC §5.2 断言，本审计复核成立；`principle-injector.ts` 已删除，其死字段 `InjectionContext.domain` 已不存在） | 内部化管线 | 无注入期消费者 |

---

## Production Call Chain

从最终注入事件反向追踪到的真实函数链（live 生产路径，`abstraction_layer_v1=off`）：

```text
OpenClaw before_prompt_build 事件
  ↓ [packages/openclaw-plugin/src/index.ts:301-399]  plugin.register 钩子注册
  ↓ runtimeGateFor → shouldUseSharedHostRuntime（index.ts:140-152；abstraction_layer_v1=false → legacy 路由）
  ↓ [packages/openclaw-plugin/src/hooks/prompt.ts:300]  handleBeforePromptBuild(event, ctx)   ← 无 sharedActivePrinciplePrompt
  ↓ [prompt.ts:595-598]  new PromptActivationReader(workspaceDir).readActivatedPrinciples()
  ↓   [runtime-v2-prompt-activation-reader.ts:37-38]  store.listPromptActivations()
  ↓     [sqlite-activation-state-store.ts:112]  SQL: …WHERE channel='prompt' AND deactivated_at IS NULL
  ↓                                              ORDER BY activated_at ASC   ← ★ activated_at ASC 在此（SQL 层）
  ↓   [prompt-activation-reader-contract.ts:40]  filterPromptActivations（保序过滤）
  ↓   [runtime-v2-prompt-activation-reader.ts:59]  resolvePrincipleFromArtifact（逐行，保序；authority 推导 :65）
  ↓ [prompt.ts:604-629]  与 legacy active/probation 取并集去重 → dedupedV2（保序过滤）
  ↓ [prompt.ts:636]  trimToBudget(dedupedV2, 2000, escapeXml)
  ↓   [prompt-activation-reader-contract.ts:129-138]  for 循环顺序装箱，remaining < entry.length+1 → truncated=true; break
  ↓        ← ★ 2000c 最终截断在此（非选择约束；break 非 continue，比 legacy 更硬）
  ↓ [prompt.ts:656-693]  alignInjectedPrinciples → eventLog.recordRuntimeV2ActivationsInjected（.state/logs/events_*.jsonl）
  ↓ [prompt.ts:785-794]  renderPrinciplesToDirectives(dedupedV2, injectedIds) → prependSystemContext（system prompt 头部，最高注意力位）
  ↓ [prompt.ts:805-812]  truncateInjectionToBudget（9000c 全局 size-guard；只裁 appendSystemContext 各块，从不裁 prependSystemContext，size-guard.ts:61-80）
  ↓
OpenClaw Agent Prompt（prependSystemContext 内的【ACTIVE BEHAVIOR DIRECTIVES】）
```

每一步顺序语义：filter（保序）→ dedup（保序）→ trimToBudget（保序 + break 截断）→ render（只渲染 injectedIds，保序）。**从 SQL 读出到 prompt 无任何一步重排、重查或按相关性筛选。**

共享 host-runtime 路径（`abstraction_layer_v1=on` / Codex）等价链：`createProductionHostRuntime.beforePromptBuild`（`host-runtime/src/index.ts:251-254`）→ `buildActivePrinciplePromptContext`（`active-principle-prompt.ts:64` 同一 `listPromptActivations` ASC）→ 顺序装箱（:105-118，`break`，预算按渲染后 directive 长度）→ 注入。

---

## Selector Reality

### A. 是否真的存在 Selector？

**生产注入路径上：不存在。**

```text
Class / Function: 不存在。最接近的 selectPrinciplesForInjection 是 legacy 块专用，v2 通道无任何选择函数。
File: —
Entry Point: —
Callers: —
Input Type: —（readActivatedPrinciples() 签名仅 workspaceDir，无任务/意图/焦点参数）
Output Type: —
```

现有机制的真身：**reader + FIFO packer**。`PromptActivationReader` 的名字与职责都是"读"，`trimToBudget` 的职责是"截"，二者组合 = 全量按激活时间顺序注入、装不下截断。

被逐一排除的同名嫌疑（名字像 selector，但均不服务运行时注入）：`selectLearnedPrincipleV0/V1`（Owner 决策卡展示文本）、`selectPrinciplesForBootstrap`（Rule bootstrap CLI）、`selectCorePrinciples`（静态公理恒注入）、`selectPrinciplesForInjection`（legacy 块，见下）。

**legacy 块的选择器**（`selectPrinciplesForInjection`）确实在生产路径上，且是唯一名副其实的"选择"函数——但它选择依据是 priority + createdAt 新旧，同样与任务无关（见 Ranking Algorithm 节）。且 live 工作区上 legacy 块实际为空（下文 v6 Evidence 节：`legacySelectedCount=0` 持续成立），v2 FIFO 是**唯一实际在投喂原则的通道**。

### B. 候选池

`SELECT * FROM activations WHERE channel='prompt' AND deactivated_at IS NULL ORDER BY activated_at ASC`（sqlite-activation-state-store.ts:112）+ join `pi_artifacts` 校验 `artifact_kind='principle' && validation_status='validated'`（contract:65-71）。即：**全部**未停用的已验证 prompt 激活，无 scope/lineage/tags 预过滤，无数量上限。

---

## Selector Inputs

| Input | Exists | Available to Selector（v2 注入链） | Used for Ranking |
|---|---|---|---|
| 当前 user task / user turn | 存在（event.prompt） | **否**——readActivatedPrinciples 不接收；prompt.ts 中 user message 只喂 SignalCollectorHost（pain 检测，prompt.ts:397-415） | 否 |
| intent（INTENT.md） | 存在（live flag on） | **否**——`buildIntentFrictionBlock` 产物 intentBlockContent 只进 appendSystemContext（prompt.ts:743-780），从不进选择链 | 否 |
| current-focus（CURRENT_FOCUS.md） | 存在 | **否**——projectContextContent 只进 appendSystemContext（prompt.ts:495-553）；live 默认 projectFocus=off | 否 |
| principle text | 存在 | 是（渲染用） | 否（只参与字符预算，不参与取舍依据） |
| tags/scope/domain/triggerPattern | schema 存在（principle-schema.ts:29-54） | **否**——resolvePrincipleFromArtifact 只取 principleId+text，其余字段在注入期被丢弃 | 否 |
| applicability（Scribe 草稿） | 存在于 artifact diagnosticJson | **否**——无注入期读取 | 否 |
| activation time | 存在 | 是 | **是——且是唯一排序键**（SQL ASC，方向为最老优先） |
| effect evidence（principle_applications 1039 行） | 存在（live 库） | **否**——注入期零消费 | 否 |
| priority / principle kind | legacy 块存在；v2 激活工件无此字段进链 | legacy 选择器消费 priority；v2 链不消费 | 仅 legacy 块 |

关键区分成立：**数据存在 ≠ selector 实际消费**。v2 注入链消费的输入完整列表 = `workspaceDir` + SQLite 两张表。仅此而已。

---

## Ranking Algorithm

**v2 通道：不存在 ranking。** 全部顺序语义如下：

1. 唯一排序键：`activated_at ASC`（SQL 层，最老在前）——`sqlite-activation-state-store.ts:112`。
2. 唯一过滤：channel/action/validated/未停用（contract:40-46、65-71）。
3. 唯一"取舍"：字符预算贪心，`remaining < entry.length + 1 → truncated=true; break`（contract:129-138）。无 threshold、无 tie-breaker、无 recency 权重、无 priority、无 budget-aware 重排、无部分入选。
4. 与 legacy 选择器的两处硬差异：legacy 用 priority+recency 排序且溢出后 `continue`（能装进后续更小的项）+ P0 强制保留（principle-selection.ts:138-176）；v2 用激活序且溢出即 `break`（后续全部出局，哪怕更小更相关）。

### `activated_at ASC` 到底在哪一层 / 属于哪个 Case

**Case C + D 的合体，按任务书定义归类为 Case D 最准确**：Selector 完全未参与最终 injection——因为根本不存在 Selector；读出顺序（SQL ASC）即注入顺序，packer 只做"装到哪一条为止"的截断。不是 Case A（Selector 自行按年龄排序——没有 Selector），不是 Case B（downstream 重排——无人重排），不是单独 Case C（eligibility 过滤后全部进入 FIFO——过滤只按有效性，不按 eligibility-by-relevance）。

---

## Selector Output Consumption

（无 Selector 输出可追踪；等价问题是"读出列表之后的全部变换"）

```text
listPromptActivations（SQL ASC）
        ↓ filterPromptActivations        [preserves order: YES] [preserves membership: 有损-按有效性]
        ↓ resolvePrincipleFromArtifact    [preserves order: YES] [preserves membership: 有损-按工件有效性]
        ↓ legacy 去重 dedupedV2           [preserves order: YES] [preserves membership: 有损-去跨块重复]
        ↓ trimToBudget                    [preserves order: YES] [preserves membership: 有损-前缀截断（break）]
        ↓ injectedIds（Set）
        ↓ renderPrinciplesToDirectives    [preserves order: YES] [preserves membership: YES-只渲染 injectedIds]
        ↓ prependSystemContext（9000c size-guard 从不触及）
        ↓
runtime_v2_prompt_activations_injected 事件记录的 principleIds === 实际进 prompt 的 principleIds
```

中间无 re-query、无 reorder、无 merge 重排（legacy+v2 是两个独立块，不合并）。**最终进入 prompt 的原则列表 = ASC 序前缀，与任何"选择结果"无关。**事件回执（principleIds/activationIds/artifactIds 经 alignInjectedPrinciples 对齐，prompt.ts:656）如实反映注入面，无第二真相。

---

## Budget Semantics

1. **`2000c` 是字符（JS string length / UTF-16 code unit），不是 token**。中文字符计 1。无任何 token 计数代码（复核 SPEC §5.2 断言成立）。
2. **谁读取**：`trimToBudget(dedupedV2, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml)`（prompt.ts:636，plugin 路径）；`buildActivePrinciplePromptContext`（active-principle-prompt.ts:112，共享路径）；`principles-stats` CLI（展示用）。
3. **执行阶段**：prompt build 内、去重后、渲染前（plugin 路径）；共享路径按渲染后长度逐条累加。
4. **selection constraint 还是 final truncation**：**final truncation**。上游无任何按预算的筛选；预算只决定"ASC 序前缀到哪里为止"。
5. **超预算时谁留下/谁被丢弃**：留下 = 激活最早的若干条（前缀）；丢弃 = 其后全部（break 语义下甚至不尝试更小的）。**与相关性、priority、效果证据、owner 授权时间全部无关——最老的永远留，最新的永远先死。**
6. **超预算观测**：有，且质量良好——`v2Truncated` 进事件（prompt.ts:675）、plugin logger warn（prompt.ts:638-640，live 网关日志可见）、host 路径另有 `prompt_context_truncated` warning（active-principle-prompt.ts:119-121）。**但零消费闭环**：没有任何机制把 `v2Truncated=true` 反馈给 Owner 审批面（v6-02 的治理断点：批准流程对预算饱和零提示）。
7. **`v2Truncated=true` 的计算**：plugin 路径 = trimToBudget 循环中第一个装不下的条目触发（contract:131-134）；host 路径 = 渲染后累计长度 >2000（active-principle-prompt.ts:112-115）。

**判定：当前行为是 `load all → sort by activation ASC → truncate`，不是 `rank → pack`。**

---

## Runtime Projection

实际进 prompt 的投影是 `renderPrinciplesToDirectives` 的 **XML directive 块**（`<directive id=… authority=…>` + `MANDATORY: <text>` + 固定两行约束语，contract:180-183），非完整 Principle、非 runtime summary、非 activation text。

**预算记账与实际注入投影不一致（plugin 路径特有发现）**：

| 表示 | 每条长度（live 10 条实测） | 用途 |
|---|---|---|
| 记账行 `- [id] text`（trimToBudget） | 143–226c（合计 ~1822c） | 预算与 truncated 判定 |
| 注入 directive 块（renderPrinciplesToDirectives） | 297–380c（合计 ~3352c） | **实际进 prompt** |

即 plugin 路径的"2000c 预算"实际放进 prompt 的内容可达 ~3300–3700c（≈1.84× 记账值）。共享路径按渲染长度记账（更诚实，但同库能装条数更少）——**同一数据在两条路径下的注入行为不可互换**（SPEC §11 parity 关注点，`openclaw-shared-host-runtime-parity.feature` 现有场景未覆盖此差异）。

预算压力归因：当前 live 10 条均值 text≈143c、directive≈335c。**压力主要来自条数 × 固定渲染开销，而非单条过长**；但记账/投影的 1.84× 差异意味着即使把记账预算调大，实际 prompt 膨胀也比账面快——修预算数字前必须先统一记账面（只调查，不优化）。

---

## Intent Integration

```text
Intent（INTENT.md → intent-doc-reader → buildIntentFrictionBlock）
  ↓ 是否进入 Runtime Principle Selector？
  ✗ 否。intentBlockContent 仅作为上下文块进 appendSystemContext（prompt.ts:743-780），选择链零消费。
```

| Context | Producer | Current Consumer | Selector Consumer? |
|---|---|---|---|
| INTENT.md | `pd intent` CLI（Owner 撰写）；读取 `intent-doc-reader.ts` | prompt hook（friction block 上下文注入）；diagnostician Stage A intentTension（`diagnostician-prompt-builder.ts:81-83`） | **否** |
| 信号/纠正（SignalCollectorHost） | user message | pain/correction 检测 → pain_events | **否** |
| Context Intelligence Layer（842/843/846/863） | evaluator context contract | evaluator 诊断形成面 | **否**（与 prompt 注入面无连线） |

**Runtime Principle Selector 与 PD 已有 Context Intelligence / Intent / Focus 完全脱节——不是"接了没用好"，是从来没有连线。**这正是 Working Set Selector SPEC §5.4 预留的接入点（Selector 直接读 INTENT.md / CURRENT_FOCUS.md 文件，不依赖注入开关）。

---

## Current Focus Integration

```text
Current Focus（CURRENT_FOCUS.md → safeReadCurrentFocus → autoCompressFocus → extractSummary）
  ↓ 是否进入 Runtime Principle Selector？
  ✗ 否。projectContextContent 仅进 appendSystemContext（prompt.ts:495-553、772-780）；live 默认 projectFocus=off。
```

| Context | Producer | Current Consumer | Selector Consumer? |
|---|---|---|---|
| CURRENT_FOCUS.md | lifecycle 会话结束钩子维护（`hooks/lifecycle.ts`） | prompt hook（project_context 块，config 默认 off） | **否** |

---

## Legacy vs Runtime V2

| 维度 | Legacy `<evolution_principles>` 块 | Runtime V2 `【ACTIVE BEHAVIOR DIRECTIVES】` |
|---|---|---|
| 数据源 | evolutionReducer（`.state` 事件流重放 + ledger tree） | activations + pi_artifacts（SQLite） |
| 选择逻辑 | priority(P0>P1>P2) + createdAt 新者优先，贪心 4000c/1000c，溢出 continue，P0 强制保留 | **无选择**：activated_at ASC 全量，2000c first-fit break |
| 任务上下文 | 无 | 无 |
| live 实际状态 | **恒空**（legacySelectedCount=0，v6-08，本审计在最新事件复核仍为 0；reducer 读取面与 _tree ledger 状态面脱节） | 唯一实际注入通道（10 条/1864c） |
| 路径并行 | `abstraction_layer_v1` off：plugin-local；on：shared host-runtime（含 Codex） | 同左，两路径 ASC 语义相同、预算记账面不同（见 Runtime Projection） |

并行路径无行为冲突（都上下文盲），但有**记账面分歧**（plugin：记账行 vs 注入投影；shared：记账即投影）与 **legacy 读取面断连**（v6-08）。金句级结论：**所谓双通道注入，在 live 上实际是单通道（v2 FIFO），且该通道无选择语义。**

---

## Test Coverage Reality

已核查的 selector/injection 测试群（按层分类）：

| 测试 | 层 | 实际证明的命题 |
|---|---|---|
| `prompt-activation-reader-contract.test.ts`（core unit） | unit | filter/resolve/trimToBudget 的**纯函数语义**：过滤条件、fail-loud、**ASC 输入序下前缀截断**（:317-341） |
| `principle-selection.test.ts`（core unit） | unit | legacy 选择器：priority+recency 排序、预算、P0 保留 |
| `runtime-v2-prompt-activation.test.ts`（plugin，606 行） | integration（mock 事件） | 接线存在性：激活→注入、未激活不注入、flag 门、fail-loud、跨块去重 |
| `runtime-v2-prompt-triple-proof.test.ts`（plugin） | runtime（真实 DB+JSONL，无 mock） | 三重证据：激活行 + 注入事件 + **同一原则连续 3 次构建均被注入**——证明的是"全量注入"语义，非选择语义 |
| `runtime-v2-activations-injected-pairing.test.ts` | integration | 事件三数组对齐（rc-6），截断下不错配 |
| `prompt-diet.test.ts` / `prompt-size-guard.test.ts` / `prompt-golden.test.ts` / `prompt-characterization.test.ts` | integration | 块的有无/总体 9000c 上限/快照 |
| `prompt-intent-injection.test.ts` | integration | INTENT block 注入（上下文面，非选择面） |
| `openclaw-shared-host-runtime-parity.steps.test.ts`（BDD） | E2E 契约 | 双路径 parity（未覆盖预算记账面分歧） |

### 已覆盖

激活有效性过滤、fail-loud 降级（rc-9）、flag 门、跨块去重、截断标志与事件对齐、全量注入接线、"每次构建都注入"（triple-proof 3/3）。

### 未覆盖（全部无任何测试）

1. **任务条件化选择**：`task A 选 P1 / task B 选 P2` 类命题——全仓零匹配（生产 API 无 task 入参，此类测试不可能存在）。全仓搜索 `task.*select.*principle` 等模式零命中。
2. 饱和时的**排除原因**观测（哪条因什么被丢）。
3. 预算记账面 vs 投影面的 1.84× 分歧。
4. `activated_at ASC` 之外任何排序策略的行为锁定（因此未来改排序时无特征测试保护）。
5. legacy 块恒空（v6-08）的回归防护。

测试现实与生产现实一致：**测试锁死的是"FIFO 全量截断"这个行为本身**——它们不是漏掉了 Selector，而是在忠实地保护一个没有 Selector 的设计。

---

## PRI-768 v6 Evidence Replay

v6-02 报告断言逐条在本审计中用 live 生产数据复核（`D:/.openclaw/workspace`，全部只读）：

**① 激活事实**（state.db 只读查询）：13 条 prompt 通道激活记录；事发窗口活跃 12 条；新原则「结论必须由可观察证据背书：无查验则显式降级为推断」`activated_at=2026-09-21T19:20:48`（文本 173c）；2 条最老激活（「Model-Evidence-Reversibility-Verification Loop」216c / 「先以可观察证据验证系统状态…」97c）`deactivated_at=2026-09-21T19:33`。

**② 注入事件**（`.state/logs/events_2026-09-20/21/22.jsonl`，共 623 条注入事件）：

| 窗口 | 事件签名（n/chars/v2Truncated/含新原则） | 次数 |
|---|---|---|
| 09-20 起～19:32 | `10 / 1905c / true / false` | **574** |
| 19:33:58 起（退役后 41 秒）～09-22 | `10 / 1864c / false / true` | 49 |

新原则激活（19:20:48）到退役（19:33）之间的 3 次构建（19:28/19:30/19:32）均仍在 `1905c/true/false` 签名内——**激活成功 ≠ 注入**，与 v6 报告"批准后首 2 个会话未含新原则"一致。最新一条事件（09-22T00:28Z）同时复核了 v6-08：`legacySelectedCount=0`、`crossBlockDuplicateIds=[]`。

**③ trimToBudget 精确模拟**（用 live 库真实 id+text，纯内存计算）：事发窗口 12 条活跃时，ASC 序前 10 条装入（1895c 记账 + join 换行 = 事件实测 1905c，逐字符吻合），循环在**第 11 位「指令模糊时先确认意图边界，采用最保守的最小删减变更」（09-19 22:23 批准）处 break**——第 12 位新原则**从未被评估到长度**。退役 2 条最老后 10 条全装（1854c+10=1864c，`truncated=false`），与事件完全一致。

**④ 追溯性发现**：新原则不是第一个受害者。「指令模糊时…」自 09-19 批准起就被同一 FIFO 饿死（574 次注入事件期间它始终在第 11 位出界）——v6 报告"此前已有 1 条 Owner 已批准原则静默失效"的量化确认：**574 次**。若未退役，随着原则继续增长，ASC 序尾部的每一条新批准都会以同样方式静默失效，且事件里除布尔 `v2Truncated` 外无任何"谁被丢/为何被丢"的结构化记录。

---

## Designed Intent vs Production Reality

**DESIGNED INTENT**（`docs/superpowers/specs/2026-08-22-principle-working-set-selector-spec.md` v0.2，状态 **Proposal — Hold**；登记 `post-mvp-conditional-roadmap.md` §23；Linear PRI-562/563/564/565）：

- 明确诊断了本审计确认的现状（SPEC §1.1/§5.2，代码基线 8c0dada1/a36b26a7 逐行核对，本审计在 4072eee7 复核仍然成立）："当预算截断发生时，谁被丢掉完全由优先级和新旧程度决定，与当前任务无关"。
- 设计的解法：Working Set Selector——hook 侧内部 Agent（`principle-selector`），输入 INTENT + CURRENT_FOCUS + 任务摘要 + Candidate Cards + 上一 Working Set，输出 0–3 条 selected[]（含 reason+confidence）+ discarded[]；shadow→live 双 flag；fail-open + rc-9 skipReason；双路径 parity。
- 分阶段纪律：Phase 0 观测（**已落地**：`pd principles stats` 命令在 `pd-cli/src/commands/principles-stats.ts` 且已注册；live receipt flags 已翻开）；Phase 1 Shadow Selector / Phase 2 Working Set Enable **Hold**，需 Owner `mvp-exception` 或路线图 §23 重启条件。

**CURRENT PRODUCTION REALITY**：PRI-261（#727，`87b5ac1e0`，2026-08-16 前后）为打通"激活→注入"断链而建的 reader（commit 原文："the live OpenClaw prompt hook only reads from the legacy evolutionReducer… The two systems were never connected"）带入了 ASC 序 + 2000c size guard。此后该链路的**选择维度从未演进**——无后续 commit 引入任务上下文、相关性或 priority 进 v2 注入序（`git log -S "ORDER BY activated_at ASC"` 仅 PRI-261 一族；`RUNTIME_V2_PRINCIPLE_BUDGET` 同源）。

**差距定性**：不是"设计已实现但被绕过"，也不是"接线断了"，而是**设计被刻意 Hold 在 Phase 0，生产停留于 Phase 0 之前的 PRI-261 应急接线上**。v6-02 是该差距的第一次 Owner 可见事故。`activated_at ASC` 与 2000c 的历史合理性：在激活数 ≪ 预算的年代，ASC 全量注入 = 简单、确定、可回滚，且完全满足"激活即可见"；它变成缺陷是**原则库存增长的必然结果**，而非实现走样。

---

## Root Cause

### v6-02 分类（任务书 A–H 枚举）

**Primary Root Cause: F — BUDGET_PACKER_DESIGN_CAUSES_FIFO_STARVATION**

证据：
- 直接机制：`trimToBudget` break 语义（contract:131-134）× SQL `ORDER BY activated_at ASC`（store:112）× 预算饱和（12 条活跃 / 2000c）→ 第 11 位出界、第 12 位未评估（模拟 + 574 次事件签名复现）。
- "新批准必输给旧批准"的方向性由 ASC 唯一决定；budget 是截断器非选择约束（Budget Semantics 节）。
- 事故可逆操作恰是"移除 ASC 序前缀成员"（退役 2 条最老）——41 秒后新原则入场，因果闭环。

**Secondary: A — MISSING_SELECTOR_CAPABILITY**

证据：生产注入链无任何任务/意图/焦点输入（Selector Inputs 表全绿叉）；该能力有完整设计（Working Set Selector SPEC）但状态 Hold。F 是病灶表现，A 是病灶土壤——但若只有 F 的机制而无预算饱和（原则数少），事故不会发生；且即便有 Selector，break 式 packer 仍可能截断（F 独立于 A 成立）。

明确排除：
- B（SELECTOR_NOT_IN_PRODUCTION_PATH）——不成立，生产路径上不存在可被绕过的 Selector（legacy 选择器未被绕过，它只负责 legacy 块且 live 恒空）。
- C（OUTPUT_OVERRIDDEN）——不成立，无下游重排/重查。
- D（CONTEXT_INSUFFICIENT）——不成立，是上下文**零接入**，不是接入不足。
- E（RANKING_INADEQUATE）——不成立，无 ranking 可言。
- G（EXPECTED_DESIGN_BEHAVIOR）——部分为真（ASC+2000 是既定设计且按 SPEC 纪律 Hold 了演进），但 v6-02 的"Owner 批准成功却零提示失效"超出任何已批准设计的验收意图（SPEC 自己将其列为待解缺陷；批准流程无预算感知非有意行为），故不选 G 为 Primary。

---

## Complexity Risk

1. **最大风险 = 把本审计结论读成"立即新建一个 Selector 子系统"。**该子系统**已有**完整 SPEC 且被 Owner 纪律性地 Hold——绕过 Hold 直接实施 Phase 1/2 违反 AGENTS.md（MVP-first、antipattern-prep-next-phase）。正确路径是带着 v6-02 的 P0 证据回到 Owner 面前，激活 SPEC 既定的 `mvp-exception`/路线图 §23 决策流程。
2. **次风险 = 只调预算数字**（2000→4000 等）。不改变 ASC break 语义，只是推迟饱和点；且 plugin 路径记账/投影 1.84× 差异会让真实 prompt 膨胀比账面快一倍，调大预算的上下文代价被系统性低估。
3. **第三风险 = 双路径漂移**。任何预算/排序修改若只改 plugin 路径，`abstraction_layer_v1` 翻开后行为静默分叉（parity .feature 现有场景不覆盖记账面差异）。
4. 观测缺口：`v2Truncated` 只有布尔，无"被丢 id 列表 + 原因"字段——修观测面是零行为风险的信息增量，但注意 rc-8 有界序列化。

---

## Minimal Fix Boundary

（根因已定，按任务书此处仅划边界，不做方案推荐/不实施。）

问题可分解为三个**相互独立**的决策面，任何修复都应显式声明落在哪个面：

1. **观测/治理面（零行为变更）**：让"批准时预算已饱和/新激活将排在出界位"在审批面可见（v6 报告修复建议 1 的方向）；事件补"被丢弃 id + 出界位次"结构化字段。不触碰注入行为，不需要 Selector，回滚 = 撤销展示。
2. **顺序/装箱策略面（行为变更，无 LLM）**：在现有 reader→packer 链内改排序键或截断策略（如 newest-first、priority 感知、per-principle 配额、continue 替代 break）。最小改动点：`listPromptActivations` 的 SQL 序 / `trimToBudget` 的循环语义 / `dedupedV2` 排序（prompt.ts:629-636 之间）。必须双路径同改 + parity 场景补齐 + 特征测试先行（当前无排序特征测试保护）。
3. **选择能力面（= 既有 SPEC Phase 1/2）**：任务感知 Working Set。**不新建第二个 Selector 设计**——SPEC v0.2 已存在且自洽（含 flag/fallback/parity/BDD 全套），缺的只是 Owner 启动决策。Intent/Focus 均有现成读取器可复用（SPEC §5.4），无需新增 Context 子系统。

最小充分路径推断：面 1 独立可交付（直接消解"批准 ≠ 生效且无人知晓"的治理断点）；面 2 是面 3 到来前的止血选项但改变 Owner 可见行为需显式批准；面 3 由 Owner 按路线图 §23 拍板。

---

## Questions Answered

1. **当前是否真的存在 Runtime Principle Selector？** 不存在。生产注入链 = reader + FIFO packer；唯一名实相符的选择器服务 legacy 块（priority+recency，同样任务盲），且 live 上该块恒空。
2. **真实代码位置？** v2 链：`prompt-activation-reader-contract.ts`（filter/resolve/trimToBudget/render）+ `sqlite-activation-state-store.ts:108-123`（ASC SQL）+ `runtime-v2-prompt-activation-reader.ts`（plugin reader）+ `prompt.ts:589-794`（组装）；共享路径 `host-runtime/src/active-principle-prompt.ts`。legacy 选择器：`prompt-builder/principle-selection.ts:116`。
3. **谁调用它？** `handleBeforePromptBuild`（OpenClaw `before_prompt_build`，`openclaw-plugin/src/index.ts:301-399`）；共享路径经 `createProductionHostRuntime.beforePromptBuild`（`host-runtime/src/index.ts:251`），Codex 适配器同源。
4. **消费 task 吗？** 否（函数签名无此入参；user message 只喂信号检测）。
5. **消费 intent 吗？** 否（INTENT block 仅作上下文注入）。
6. **消费 current-focus 吗？** 否（仅 project_context 块，live 默认 off）。
7. **产生 relevance ranking 吗？** 否。唯一排序键是 `activated_at ASC`（SQL 层）。
8. **最终 injection 是否严格使用其结果？** 不适用（无 Selector）；读出序 = 注入序，中间仅保序过滤/去重/前缀截断，无重排。
9. **`activated_at ASC` 位于哪一层？** SQL：`sqlite-activation-state-store.ts:112`（及 includeDeactivated 变体 :111）；引入于 PRI-261（#727 `87b5ac1e0`）。
10. **为什么第 11/12 条新原则输给更旧原则？** ASC 全量读出 + 2000c first-fit break：最老前缀占满预算，第 11 位 break 后第 12 位（新原则）从未被评估。574 次注入事件 + 逐字符模拟双重复现。
11. **2000c 是选择预算还是 truncation budget？** 字符（非 token）final truncation budget，非选择约束。
12. **当前系统是 contextual / priority / FIFO / hybrid？** v2 实际通道 = **纯 FIFO**（激活序前缀截断）；legacy 块 = priority+recency（live 恒空）；故生产实效 = FIFO 单通道。
13. **若原则增长到 100 条会怎样？** ASC 前 ~10-13 条（≈2000c 记账值）恒定注入，其余 ~90 条**全部、永久、静默**不可见（除非更老的被退役）；每次批准的新原则默认排在出界位；无报警进审批面。可注入集与任务完全无关且被首批激活永久锁死——结构性失效，非线性劣化。
14. **v6-02 是 bug、wiring、算法还是设计？** 设计使然（FIFO packer 设计 × 预算饱和），叠加选择能力缺位（Secondary A）。非实现 bug、非接线断裂。
15. **是否需要新增系统？** 选择能力已有完整 SPEC（Working Set Selector）且 Hold——不需要"新增"，需要 Owner 决策"是否启动"；观测面修复不需要新系统。
16. **可复用现有 intent/current-focus 吗？** 可以。两者均有现成读取器（`intent-doc-reader.ts`、`safeReadCurrentFocus`），SPEC §5.4 已明确 Selector 直读文件、不依赖注入开关——零新 Context 子系统。
17. **最小修复边界？** 三独立决策面：观测/治理面（零行为变更，可独立交付）→ 顺序/装箱策略面（行为变更需双路径 parity + 特征测试先行）→ 选择能力面（既有 SPEC Phase 1/2，待 Owner `mvp-exception`/路线图 §23）。

---

## Recommendation

（按任务书约束：以下为根因确定后的**决策建议排序**，非实施。）

1. **先治"无人知晓"，再治"谁被留下"**：面 1（批准面预算感知 + 事件补出界观测）是唯一无行为风险的即时修复，且直接针对 v6-02 的 P0 定性（"Owner 批准 ≠ 行为改变且零提示"）。
2. **把本报告作为 SPEC v0.2 Phase 1/2 的触发证据回填**：路线图 §23 要求"触发证据"；v6-02 的 574 次静默截断 + 41 秒因果闭环是最强的实证材料。是否启动 Shadow Selector 属 Owner 决策（`mvp-exception` 流程），AI 不应代启。
3. **若 Owner 选择止血（面 2）**：先补 ASC/FIFO 特征测试与双路径记账面 parity 场景，再动排序——当前零特征保护下改序 = 盲改。
4. **独立立单建议**（本次只读，未创建）：① plugin/shared 双路径预算记账面统一（1.84× 差异）；② legacy 块恒空（v6-08）的读取面修复或明示退役；③ `v2Truncated` 事件补被丢 id 结构化字段（rc-8 有界）。

---

## 附：最终判定

```text
SELECTOR_AUDIT_RESULT=NO_REAL_RUNTIME_SELECTOR

V6_02_PRIMARY_ROOT_CAUSE=F（BUDGET_PACKER_DESIGN_CAUSES_FIFO_STARVATION）
V6_02_SECONDARY_ROOT_CAUSE=A（MISSING_SELECTOR_CAPABILITY — designed in SPEC 2026-08-22, deliberately Held post-MVP）
```

对核心问题的最终回答：**PD 现在怎样决定"这一轮 Agent 应该记住哪些 Principle"？——它不决定。它按批准时间从老到新整列装入，装满为止。** 新原则之所以在 Owner 批准、激活成功后仍进不了运行时，是因为它排在这条时间队的尾部，而队头永远不会让位，系统在任何环节都不对此发出 Owner 可见的信号。
