# PD Principle Working Set 与 Working Set Selector 设计规范

> **版本**: v0.2（修订版）
> **状态**: Proposal — Hold（Phase 0 可按「证据收集」例外先行；Phase 1/2 需满足路线图重启条件或 Owner `mvp-exception`）
> **目标阶段**: Post-MVP Foundation（ADR-0014 暂停期内）
> **前版**: v0.1（2026-08-22 讨论稿）
> **日期**: 2026-08-22
> **代码基线**: main @ 8c0dada1（本文档全部 file:line 断言已于 2026-08-22 对照工作树逐项复核）
> **路线图登记**: docs/plans/post-mvp-conditional-roadmap.md §23
> **Linear**: PRI-562（Phase 0）/ PRI-563（Phase 1）/ PRI-564（Phase 2）/ PRI-565（Phase 3）——工单基于 v0.1 创建，与 v0.2 的差异见 §0 修订记录及各工单评论
> **关联**: ADR-0014 §2.5/§6；post-mvp-conditional-roadmap §1/§17；docs/product/emotional-value.md；docs/product/PRODUCT_IDENTITY.md

---

## 0. v0.1 → v0.2 修订记录

| # | 变更 | 动因 |
|---|------|------|
| R1 | 问题重述：从「注入数量无限增长」修正为「预算截断相关性盲」 | 代码核实注入已有字符预算兜底（legacy 4000/1000 + v2 2000 + 全局 9000），无限增长的前提不成立 |
| R2 | 「Activation Arbiter」更名「Working Set Selector」（agent id `principle-selector`） | 「arbiter」属于已退役的 nocturnal-arbiter god-class（PRI-230 删除，architecture-regression.test.ts:3427 仍在防其复活），避免心智混淆 |
| R3 | 新增 §5「当前代码事实核对」 | v0.1 的现状描述未对照代码；本版全部断言带 file:line |
| R4 | 新增 §9「运行时机与延迟设计」 | v0.1 最大缺口：Arbiter 是同步注入路径上的一次 LLM 调用，时机与延迟完全未设计 |
| R5 | §11 明确双路径 parity 要求 | 注入存在 abstraction_layer_v1 off/on 两条实现路径，Working Set 必须同时接入 |
| R6 | §12 flag 设计重写：单 flag 三态 → 双 flag（shadow/live） | flag 契约只有 core/quiet/gone/legacy_retire + 布尔 enabled，无 shadow 档位；遵循 RuleCode shadow→live 先例 |
| R7 | core_principles 与 P0 移出 Selector 治理范围 | 身份层公理不应由 LLM 取舍；保留现有 P0 强制保留安全网语义 |
| R8 | §13 补验收指标的依赖链 | shadow recall 依赖 principle_receipt_ledger / principle_receipt_self_report（均默认关） |
| R9 | 新增 §14 强制评审章节（MVP 四问 / 情绪价值 / 边界 / RC / ERR / BDD） | AGENTS.md 对功能设计的强制要求，v0.1 全部缺失 |
| R10 | Phase 0 范围重定义：「新增观察」→「启用既有观测 + 一个聚合命令」 | 注入计数/字符数事件与 session receipt 已建成且无 flag 门控；presence/effect ledger 已建成但 `principle_receipt_ledger` 等默认关 |
| R11 | 架构定位定为 hook 侧服务（EmpathyObserver 先例），明确不走 peer-runner 管线 | peer-runner 是异步 lease→poll 模型，套不上同步注入场景 |

---

## 1. 背景与目标

### 1.1 问题重述（R1 修正）

PD 的完整闭环已经打通：Pain → Diagnosis → Principle → Owner Approval → Activation → Prompt/Rule 注入 → Evidence。

但注入环节的选择逻辑是**上下文盲**的：

- **Legacy 路径**：所有 active + probation 原则按 priority（P0→P2）+ createdAt（新者优先）排序，贪心装填 4000 字符预算（probation 另有 1000 字符），超预算即丢弃，仅首个 P0 享受强制保留（`packages/openclaw-plugin/src/hooks/prompt.ts:48-76`、`packages/principles-core/src/prompt-builder/principle-selection.ts:116-191`）。
- **Runtime V2 路径**：全部未停用的 validated prompt 通道激活按 activated_at 升序装填 2000 字符预算，first-fit 硬截断（`packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:39-45,114-140`）。

因此系统真正的结构性缺陷不是 v0.1 所述的「原则数量无限增长导致注意力稀释」——字符预算已经兜住了总量——而是：

> **当预算截断发生时，谁被丢掉完全由优先级和新旧程度决定，与当前任务无关。**

一条与本次任务高度相关的 P2 原则，会因为一条更老或优先级更高的无关原则占着预算而被丢弃；反之，一条与任务无关的原则只要够新就能占据注意力。随着原则库增长，这个任意性会被放大。

### 1.2 核心目标

建立 **Principle Working Set**：

> 从所有 Eligible Principle 中，为当前任务阶段选择少量（0~3 条）最值得进入 Agent 当前认知空间的原则集合；其余原则长期保存在 Repository 中，不影响其地位与证据积累。

- 降低 Principle Noise（重复、无关注入）
- 让预算截断从「按优先级和新旧」变为「按当前任务相关性」
- 保护 Agent Context Budget
- 提升长期内化效果（注意力集中在少数原则上）

---

## 2. 非目标

继承 v0.1 全部非目标，另加两条：

1. **不做 Principle 自动创建** —— 创建仍由 Pain → Diagnosis → Internalization Pipeline → Owner Approval 负责。
2. **不做 Principle 自动修改** —— Selector 无权修改原则内容、状态、Owner Approval。
3. **不做 RuleHost 动态选择** —— RuleHost 是确定性治理（删除保护/危险操作/代码约束/安全规则），继续保持 `RuleHost > LLM 判断`。
4. **不做因果归因** —— 本设计只做 presence/evidence 相关性分析（某条原则被选中后是否伴随 effect 证据），不回答「某条原则是否导致成功」。因果归因属 Attribution Pipeline（post-mvp-conditional-roadmap §1，Hold）。
5. **不做 Memory System** —— Memory 保存过去发生了什么；Working Set 决定当前应该关注什么。
6. **（新）不治理 core_principles 与 P0** —— 身份层公理无条件注入；P0 维持现有强制保留语义。见 §11。
7. **（新）不做每轮消息重新选择** —— 见 §9 触发点设计与 Phase 3。

---

## 3. 核心概念

### 3.1 Eligible Principle

已满足 Owner Approved（或有 owner authority 标注）/ Active / Prompt Eligible（channel=prompt 且未停用且 artifact validated）的原则。Eligible ≠ 当前应该注入。

### 3.2 Principle Working Set

当前 Session / Task 阶段实际进入 Agent Context 的原则子集：

```
数量:      0 ~ 3（不含 P0 与 core_principles，见 §11）
生命周期:  短期（随 session / task_hash / focus_hash 变化而重建）
来源:      Eligible Principles 中的 P1/P2
决定者:    Working Set Selector
```

### 3.3 Working Set Selector（原「Activation Arbiter」，R2 更名）

一个专用内部 Agent。职责：根据当前上下文，从 Eligible Principles 中选择 Working Set，并给出可查的理由。

> **更名说明**：「arbiter」一词属于 2026-05 已删除的 nocturnal-arbiter god-class（PRI-230），`architecture-regression.test.ts:3427,3490` 至今断言源码不得再出现该符号。为避免与退役组件的心智混淆，本设计使用 **Selector**。

输入：INTENT、CURRENT_FOCUS、当前任务摘要、Candidate Cards、历史证据摘要、上一个 Working Set。
输出：selected[]（principleId + reason + confidence）、discarded[]。

---

## 4. 架构总览

```
                 Owner
                   │
          Principle Repository
                   │
          Eligible Principles (P1/P2)
                   │
          Candidate Card Builder ──── Scribe draft artifacts (applicability)
                   │
     ┌─────────────┴─────────────┐
     │   Working Set Selector    │ ← INTENT / CURRENT_FOCUS / task / 上一个 Working Set
     │  (hook 侧服务，默认关)       │
     └─────────────┬─────────────┘
                   │
          Principle Working Set ──→ principle_working_sets 表 (shadow/live)
                   │
        ┌──────────┴──────────┐
        │ Prompt Injection    │ ← abstraction_layer_v1 off: hooks/prompt.ts
        │ (双路径，见 §11)      │ ← abstraction_layer_v1 on: host-runtime/active-principle-prompt.ts
        └──────────┬──────────┘
                   │
               Main Agent
                   │
        Application Evidence (principle_applications)
                   │
          Future Selector 决策的质量反馈
```

---

## 5. 当前代码事实核对（R3 新增）

以下断言全部基于 main @ a36b26a7 逐项核对。

### 5.1 注入路径现状：三条块 + 双路径

注入由 `before_prompt_build` 钩子完成（`packages/openclaw-plugin/src/index.ts:332-429`），在一条 feature flag 上分叉为两条实现路径：

- **abstraction_layer_v1 = off（当前默认）**：走 legacy 组装（`hooks/prompt.ts:238-699`）。
- **abstraction_layer_v1 = on（Codex 共享路径）**：走 shared host-runtime（`packages/host-runtime/src/active-principle-prompt.ts:31-136`，gate 在 `index.ts:171-187,410-413`，flag 默认 off：`feature-flag-contract.ts:221`）。

两条路径下实际注入的原则来自三个块：

| 块 | 选择逻辑 | 预算 | 位置 |
|---|---|---|---|
| `<core_principles>` | 恒注入，不参与选择 | 无上限 | appendSystemContext 末尾（prompt.ts:372-386） |
| `<evolution_principles>` | active+probation，priority 排序 | active 4000 / probation 1000 字符 | appendSystemContext（prompt-helpers.ts:192-217） |
| `【ACTIVE BEHAVIOR DIRECTIVES】`（v2） | 全部未停用 validated 激活，activated_at 升序 | 2000 字符 first-fit | prependSystemContext（prompt.ts:645-657） |

另有全 prompt 9000 字符的 size-guard（`prompt-builder/size-guard.ts:24`），只裁剪 appendSystemContext 各块，**从不裁剪** prependSystemContext。

### 5.2 选择逻辑现状：上下文盲（确认 v0.1 断言）

- 没有任何代码在注入时读取当前任务、用户消息、session 阶段或原则 applicability。
- `InjectionContext.domain` 声明了但从未被消费（`principle-injector.ts:18-27,92-152`）。
- `scope`/`domain` 字段只写不读（`evolution-reducer.ts:78-79,424-425`）。
- `triggerPattern` 只用于事后 pain 指标的关键词匹配（`openclaw-plugin/src/core/pain.ts:36-73`），不参与选择。
- 唯一的情境敏感是整块跳过（heartbeat/cron/subagent，`prompt-builder/minimal-trigger.ts:7-13`），不是逐原则选择。
- 全部预算以字符计，**无 token 计数**。

### 5.3 数据可用性

- Principle 模型字段齐全（`runtime-v2/types/principle-schema.ts:29-54`）：triggerPattern/action/scope/domain/priority/status 等，`derivedFromPainIds[]` 提供 pain lineage。**本阶段确实不需要新增 Principle Metadata**（v0.1 §5.1 成立）。
- **但 applicability[] 不在 Principle 对象上**，而是在 Scribe 草稿 artifact 上（`runtime-v2/internalization/scribe-output.ts:14-21`：title/statement/rationale/applicability[]/antiPatterns[]/confidence）。Selector 的候选卡若要带 applicability，需从草稿 artifact 的 diagnosticJson 读取，且激活原则可能缺少草稿回退链。Candidate Card Builder 必须显式设计这个数据管线（§7）。

### 5.4 INTENT / CURRENT_FOCUS 现状

- **INTENT.md**：已完整实现（读取 `intent-doc-reader.ts:2-70`、注入 intent friction block `prompt.ts:606-631`、诊断器 intentTension），但整体被 `intent_engineering` flag 门控，**默认关**（`feature-flag-contract.ts:163-164`）。
- **CURRENT_FOCUS.md**：session 结束钩子自动维护（`hooks/lifecycle.ts:210-297`），注入受 `contextInjection.projectFocus` 控制，**默认 'off'**（`pd-config-defaults.ts:96-104`）。

结论：v0.1 §5.3 的「INTENT/CURRENT_FOCUS 作为决策输入」在结构上成立。注意：Selector 直接读取这两个文件的内容（`intent-doc-reader.ts` 读 `.principles/INTENT.md`；CURRENT_FOCUS 由 lifecycle 钩子持续维护），**不依赖上述两个注入开关**——是否把 INTENT friction block / project focus 注入主 prompt 是独立的 Owner 产品决策且会改变 prompt 内容，因此不属于本 SPEC 的前置条件，也不纳入 Phase 0（见 §6）。

### 5.5 观测能力现状：Phase 0 的大部分已建成（R10）

| 观测项 | 现状 | 门控 |
|---|---|---|
| 注入计数/字符数事件 | `recordRuntimeV2ActivationsInjected`（含 sessionId/principleIds/injectedCount/injectedCharCount/budget/skipReason，`event-log.ts:206-208`，wired `prompt.ts:529-563`） | 无 |
| session receipt | `setInjectedPrincipleIds`（`session-tracker.ts:435-441`），`/pd-context` 展示（`openclaw-plugin/src/commands/context.ts:114`） | 无（代码注释明确 independent of the ledger flag） |
| presence ledger | `principle_applications` 表（`sqlite-connection.ts:463-485`，level=presence，kind=prompt_injected，session×principle 去重，90 天保留） | `principle_receipt_ledger`（默认关） |
| effect ledger | 同表 rule_blocked / auto_correct_applied / self_reported | 同上 + `principle_receipt_self_report`（默认关） |
| 块内重复检测 | **不存在**（现有去重只有 legacy-vs-v2 跨通道 + session×principle presence） | — |

结论：Phase 0 真正的新增工作只剩「跨块重复检测」+「聚合输出」。其余是翻 flag + 一个只读聚合命令。

### 5.6 内部 Agent 与 flag 机制现状

- 内部 Agent 名单 `INTERNAL_AGENT_NAMES`（`pd-config-types.ts:80-91`，10 个），默认启用仅 4 个（diagnostician/dreamer/scribe/artificer，`pd-config-defaults.ts:61-72`）。
- 能力声明契约是 `{ structuredJson, toolUse?, workingDirectory? }`（`agent-spec.ts:18-27`）——**没有 "reasoning" 这个能力**，且当前无任何生产代码强制能力匹配。
- 不存在「同名 OpenClaw agent 必需」约束：所有 runner 共享一个 runtime adapter，agentId 默认 'main'（`openclaw-cli-runtime-adapter.ts:305,398-452`）。
- flag 契约：category ∈ {core, quiet, gone, legacy_retire}，config 条目仅 `{category, enabled}`（`feature-flag-contract.ts:8`、`pd-config-types.ts:25-28`），**没有 shadow 档位**（见 §12）。
- 已存在成熟的 shadow→live 先例：RuleCode 激活模式 `'shadow' | 'live'`，shadow 执行并记录 shadowDecisions 但不拦截，晋级需 Owner 决策（`rule-host.ts:50,190-191,485-506`；`rulecode-shadow-summary.ts:15-58`）。

---

## 6. 实施范围与阶段

### 6.0 阶段合规总纲（R9）

| 阶段 | 性质 | 当前状态 |
|---|---|---|
| Phase 0 Observability | 证据收集（AGENTS.md 明确允许的例外） | ✅ 可立即实施 |
| Phase 1 Shadow Selector | 新增 LLM 内部 Agent = 架构扩张 | ⛔ Hold，需 Owner `mvp-exception` 或路线图 §23 重启条件满足 |
| Phase 2 Working Set Enable | 改变注入行为 | ⛔ Hold（依赖 Phase 1 数据） |
| Phase 3 Dynamic Reselection | 未来 | ⛔ Hold |

---

### Phase 0 —— Observability（可立即实施，约 2-3 天）

**目标**：验证「原则噪声/截断任意性」假设是否真实存在，产出路线图 §23 需要的触发证据。不改变任何 Agent 行为。

**范围**（R10 修正，远小于 v0.1）：

1. 在观测工作区 `.pd/config.yaml` 翻开：
   - `principle_receipt_ledger: true`
   - `principle_receipt_self_report: true`
   - 以上均为既有代码的配置变更，无新代码路径。（注意：**不翻** `intent_engineering`、**不改** `contextInjection.projectFocus`——两者会把内容注入主 prompt 即改变 Agent 行为，违背本阶段「不改变任何行为」的承诺；Selector 日后直接读 INTENT.md / CURRENT_FOCUS.md 文件即可，见 §5.4。）
2. 新增只读聚合命令 `pd principles stats [--days N] [--json]`：
   - average injected principles/session
   - average principle chars/session（含 budget 与截断次数）
   - duplicate rate（跨块归一化文本重复检测——唯一的新检测逻辑）
   - application correlation（presence → effect/self_reported 的 join 关联）
   - 遵守 cli-1 严格 JSON / cli-6 next action；只读命令天然满足 cli-4/cli-5。
3. 连续 ≥ 2 周产出报告，作为路线图 §23 的触发证据。

**验收**：v0.1 Phase 0 的四项输出指标可从真实数据产出。

---

### Phase 1 —— Shadow Selector（Hold，约 1 周）

**行为**：Selector 异步运行，只落盘 shadow 决策，不影响注入。流程：

```
正常 Prompt Injection（legacy 照常）
        +
Shadow Selector（fire-and-forget）
        |
记录:  legacy 实际选择 vs Selector 推荐选择
       → principle_working_sets 表 mode='shadow'
```

**观察**：如果后续产生 effect 证据的原则集中在 Selector 推荐集内，说明方向正确（shadow recall，§13）。

**前置条件**：Owner 带 `mvp-exception` 的明确批准（参照 Dreamer L2 / Artificer L2 先例，ADR-0014 修正案 2026-06-16/17），且路线图 §23 触发条件核对通过。

---

### Phase 2 —— Working Set Enable（Hold，约 1 周，验证后实施）

**行为**：Prompt Injection 前接入 Working Set Resolver。Fallback 语义（Fail Open）继承 v0.1 并强化：

- 任何异常（timeout / JSON failure / DB failure / model unavailable / 校验失败）→ 恢复 legacy 选择；
- **且必须带结构化 skipReason 落 event log**（复用 `recordRuntimeV2ActivationsInjected` 的 skipReason 字段，rc-9）——不允许静默 fallback。

**额外前置**：双路径 parity 测试（abstraction_layer_v1 off/on）通过（§11），相关 `.feature` 更新经 Owner 确认。

---

### Phase 3 —— Dynamic Reselection（未来，Hold）

触发：Compaction / CURRENT_FOCUS 明显变化 / Task Phase 变化。明确不做每轮重选（成本 + Principle Thrashing + 行为不稳定）。此阶段设计不变，仅登记。

---

## 7. Candidate Card 设计（含数据来源，R3）

Selector 不读完整 Artifact，只读压缩 Card：

```
Principle:     <id + title>
Statement:     <statement 或草稿回退>
Applicability: <来自 Scribe 草稿 artifact 的 applicability[]>
               （数据管线：pi_artifact diagnosticJson → Card Builder；
                 原则无草稿时该字段缺失，Card 必须显式标注 missing，不得编造）
Domain/Scope:  <principle.domain / scope>
Evidence:      Injected: N sessions（principle_applications, kind=prompt_injected）
               Self reported: N（kind=self_reported）
               Rule effect: N（kind=rule_blocked / auto_correct_applied）
               证据字段全部来自 principle_applications 单一数据源（rc-6）
```

证据字段为 90 天滚动窗口内计数；无 receipt 数据时显示 `no_evidence` 而非 0，避免与「有证据但为 0」混淆。

---

## 8. Selector Agent Specification（R11 重写）

| 项 | 值 |
|---|---|
| Config 名 | `principleSelector`（加入 `INTERNAL_AGENT_NAMES`，`pd-config-types.ts:80-91`；默认 `enabled: false`，`pd-config-defaults.ts:61-72`） |
| Agent id | `principle-selector` |
| Capability | `structuredJson`（现行契约 `agent-spec.ts:18-27`；v0.1 的 "reasoning" 不是系统声明的能力） |
| 运行形态 | **openclaw-plugin 内 hook 侧服务**（先例：EmpathyObserver 异步挂接 prompt build hook，ADR-0014 2026-05-30 修正案），**不是** internalization job graph 的 peer runner |
| 门控 | 双门控：feature flag（§12）AND `internalAgents.agents.principleSelector.enabled`（observer 先例 `pd-config-loader.ts:76-80`） |
| 模型 | runtimeProfiles 中配置的 profile（不新增同名 OpenClaw agent 要求，`openclaw-cli-runtime-adapter.ts:305`） |

**为什么不是 peer runner**：peer-runner 是异步 lease→poll→fetch→validate 管线（`peer-runner-contracts.ts`），而 Selector 在 Phase 2 需要结果于 prompt build 时可用。走 hook 侧服务可完全避开 PeerRunnerKind / job-graph / 三个 dispatch 点的改动（R11）。

**输入 Schema**：

```json
{
  "intent": {},          // INTENT.md 内容（Selector 直接读文件；缺失时为空对象）
  "currentFocus": {},    // CURRENT_FOCUS 内容
  "task": {},            // 当前任务摘要
  "cards": [],           // Candidate Cards（§7）
  "previousWorkingSet": {}  // 上一 working set 的 selected_ids
}
```

**输出 Schema**：

```json
{
  "selected": [
    { "principleId": "", "reason": "", "confidence": 0 }
  ],
  "discarded": [
    { "principleId": "", "reason": "" }
  ]
}
```

**限制**：selected 最多 3 条、允许 0 条；confidence ∈ [0,1]；principleId 必须存在于输入 cards 中（校验失败即整单 fallback，不部分采纳）。

**校验**：TypeBox validator，参照 `DefaultScribeValidator` 模式（`scribe-output.ts:83-154`）。

---

## 9. 运行时机与延迟设计（R4 新增）

### 触发点（重建 Working Set 的唯一时机）

1. 新 session 首次 prompt build（session_id 变化）；
2. `task_hash` 变化（当前任务指纹变化）；
3. `focus_hash` 变化（CURRENT_FOCUS 内容哈希变化）；
4. 距上次选择 ≥ minReselectIntervalMs（防抖；建议同 session 内默认不重复，除非 2/3 触发）。

**明确不做**：每轮消息重新选择。

### 延迟策略（分阶段）

- **Phase 1（shadow）**：异步 fire-and-forget。legacy 注入先行，Selector 后台跑完只落盘。零延迟影响——shadow 模式的天然优势。
- **Phase 2（live）**：默认方案 = 同步调用 + 硬超时（`selectorTimeoutMs`，默认 2000ms，可配），超时/失败 fail-open 到 legacy 并记 skipReason；备选方案 = session 开始时预计算、就绪后本 session 后续 prompt 生效（首轮用 legacy）。**两者取舍由 Phase 1 实测延迟（p50/p95）决定，不在本 SPEC 预先拍板。**

### 成本控制

- 每 session 至多 1 次选择（除非 hash 触发）；
- Card 输入压缩（§7）限制 token；
- 模型走最便宜的可用 profile（Selector 是质量判断，不需要最强模型）。

---

## 10. Working Set Storage（R3 修正落点）

表 `principle_working_sets`（DDL 加在 `SqliteConnection.initSchema`，先例 `principle_applications`：`sqlite-connection.ts:463-485`；迁移沿用 PRAGMA table_info 列增 + migrateSchema 版本号模式，`:697-765`）：

| 字段 | 说明 |
|---|---|
| id | TEXT PK |
| session_id | TEXT NOT NULL |
| task_hash / intent_hash / focus_hash | 决策时的上下文指纹（rc-6：与触发时实际上下文同源记录） |
| mode | TEXT CHECK IN ('shadow','live') |
| selected_ids | JSON array |
| decision_json | **有界**（safeStringifyPreview，rc-8）；不存 chain-of-thought / hidden reasoning |
| model / latency_ms | 成本观测 |
| created_at / superseded_at | superseded_at 在新行生效时回填 |

写入方：openclaw-plugin 薄服务（先例 `principle-application-ledger.ts`）。纯逻辑（输出校验、Card 构建、选择契约）在 principles-core；新增核心 I/O 文件须登记 io-seam-registry.json（AGENTS.md 规则）。

---

## 11. Prompt Integration（R5/R7）

### 治理范围（R7）

- **core_principles：不受治理。** 身份层公理（T-01..T-09）无条件注入、无预算上限的现状不变（`prompt.ts:372-386`）。不允许 LLM 决定「这轮要不要带门槛公理」。
- **P0 原则：不受治理。** 维持现有强制保留语义（`principle-selection.ts:166-176`）。若候选中全是 P0，Selector 输出空集，注入行为不变。
- **治理对象** = evolution_principles 的 P1/P2 + v2 behavior directives 中非 P0 部分。

### 双路径 parity（R5）

- `abstraction_layer_v1 = off`（当前默认）：改 `hooks/prompt.ts` 组装路径；
- `abstraction_layer_v1 = on`（Codex 共享路径）：改 `host-runtime/src/active-principle-prompt.ts`；
- 两条路径行为必须一致；`docs/specs/features/story-a/openclaw-shared-host-runtime-parity.feature` 是守护契约，Phase 2 实施时须扩展覆盖 working set 场景；
- 注意 size-guard 不对称：prependSystemContext（v2 directives）从不被 9000 字符 guard 裁剪、appendSystemContext 会——working set 落地后此交互须有显式测试覆盖（EP-09）。

### Legacy / v2 统一

最终形态：Eligible Principles → Working Set Resolver → Prompt Renderer。legacy 的 evolution_principles 与 v2 的 behavior directives 都以 Working Set 为输入源，避免两个选择逻辑各自为政。

---

## 12. Feature Flag 设计（R6 重写）

契约事实：category ∈ {core, quiet, gone, legacy_retire}，config 条目仅 `{category, enabled}`（`feature-flag-contract.ts:8`、`pd-config-types.ts:25-28`），**无 shadow 档位**。v0.1 的「shadow=true → enabled=true」单 flag 三态无法注册。

采用 RuleCode 先例（shadow→live 双态 + Owner 晋级，`rule-host.ts:50,485-506`）拆为两个 flag：

| Flag | Category | 默认 | since | 控制 |
|---|---|---|---|---|
| `principle_working_set_shadow` | quiet | false | 2026-08-22 | Selector 运行并落盘 shadow 决策，不影响注入 |
| `principle_working_set_live` | quiet | false | 2026-08-22 | 注入选择切换为 Working Set；开启时 shadow 记录继续（legacy vs working set 对比） |

注册要求（AGENTS.md）：

- 写入 `.pd/config.yaml` features 段（category/enabled）；
- 生产 loader 消费 + loader 测试证明生效，才算注册完成；
- 双门控：还需 `internalAgents.agents.principleSelector.enabled: true`（默认 false）；
- 回滚：任一 flag 关闭即恢复 legacy 选择，零数据迁移（满足「需 revert 的必须带 flag」规则）。

---

## 13. 验收指标与依赖链（R8）

**依赖链声明（R8）**：shadow recall 与 application correlation 都消费 `principle_applications` 数据，前提是 `principle_receipt_ledger=true` 与 `principle_receipt_self_report=true`（两者当前默认关，`feature-flag-contract.ts:232,239`）。**Phase 0 第一步就是在观测工作区翻开它们**；未翻开前无法验收任何选择质量指标。

| 指标 | 定义 | 要求 |
|---|---|---|
| 效率 | average principle chars/session（含 budget 与截断次数） | 与 legacy 基线相比下降 |
| 选择质量 | shadow recall = 后续产生 effect/self_report 证据的原则中，被 Selector 提前选中的比例 | 措辞为 presence/evidence **相关性**，非因果归因（与非目标 4 一致） |
| 稳定性 | working set churn rate = 相邻两次选择的 Jaccard 距离均值 | 同 session 内除 hash 触发外不得重建 |
| 成本 | selector latency（p50/p95）、token 成本、fallback rate | fallback 必须 ≥99% 带 skipReason（rc-9） |

---

## 14. 强制评审章节（R9 新增）

### 14.1 MVP 四问

**Phase 0（现在可答）：**

1. **mvp-q-1-what-if-skip**：不做则「原则噪声」假设永远无法证实或证伪，路线图 §23/§1 的重启条件无从评估；30 天内每次讨论注入质量都会再被提起。不拒收。
2. **mvp-q-2-how-observed**：`pd principles stats --json` 输出四项指标；receipt 数据可在 console receipts 页查看。
3. **mvp-q-3-how-disabled**：纯只读聚合命令 + 翻开既有 flag；关闭 = 把 receipt flag 翻回 false，无新代码路径需要回滚。
4. **mvp-q-4-emotional-value**：见 §14.2。

**Phase 1/2（草拟，待 Owner 批准）：**

1. **mvp-q-1**：预算截断持续按优先级+新旧任意丢弃原则，Owner 无法解释「为什么这条没带上」；原则库增长后注入质量不可控。
2. **mvp-q-2**：shadow 决策落盘 `principle_working_sets` 表 + 对比报告；live 后 `/pd-context` session receipt 显示 working set 及理由。
3. **mvp-q-3**：两个独立 flag，关闭即恢复 legacy 选择，零数据迁移。
4. **mvp-q-4**：同 §14.2。

### 14.2 情绪价值评审（按 emotional-value.md §7 模板）

**主要服务的情绪价值**：清醒感（只带当前任务真正需要的原则）+ 掌控感（每条选择有可查的理由，不再是黑箱截断）。

**降低的负面情绪**：信息过载（prompt 原则堆积稀释注意力）、不信任感（截断任意且不可解释）。

**核心承诺体现**：

- 沉淀感：Working Set 是注意力的短期分配，不是价值否定——Repository 长期保存全部原则，证据积累不受影响；
- 可验证：shadow 决策与 receipt 关联，选择质量可测量（这不是玄学优化）；
- Owner 最终治理权：flag 默认关、shadow 先行、随时可关、fail-open 不打扰；
- 减少而非增加操心：churn 控制 + 防抖保证稳定，fallback 静默性由 rc-9 禁止。

**风险自省**：若 Selector 选择频繁变化或理由空洞 → 制造新的失控感。缓解：churn rate 硬约束（§13）+ reason 必须落盘可查（§8 输出契约）。

### 14.3 Core/Plugin 边界

| 层 | 内容 | 落点 |
|---|---|---|
| 纯逻辑 | 输出校验、Card 构建、选择契约、触发点判定 | principles-core（不新增核心 I/O；新 I/O 文件登记 io-seam-registry.json） |
| I/O 边界 | LLM 调用、hook 接线、`principle_working_sets` 写入 | openclaw-plugin（先例：principle-application-ledger.ts） |
| 表 DDL | `principle_working_sets` | SqliteConnection.initSchema（既有文件，已登记） |

### 14.4 Runtime Contract 对照

| 规则 | 适用点 |
|---|---|
| rc-1/rc-2 | Selector 输出按 unknown 处理，TypeBox validator 校验后才可用（参照 `DefaultScribeValidator`）；禁止 `as` 绕过 |
| rc-3 | selected 缺失/超限/引用不存在原则 → 整单 fallback 且 fail loud，不静默跳过 |
| rc-4 | selected 数组逐元素校验 principleId 为字符串且 ∈ 输入 cards |
| rc-5 | 解析输出对象键用 `Object.hasOwn` |
| rc-6 | working set 行的 session_id/task_hash/focus_hash 与触发时实际上下文同源记录 |
| rc-7 | N/A（非重试循环）；但触发判定必须读当前状态而非缓存 |
| rc-8 | decision_json 用 safeStringifyPreview 有界序列化；不存 chain-of-thought |
| rc-9 | 一切 fallback（timeout/JSON/DB/model/校验）必须带结构化 skipReason 落 event log |

### 14.5 ERR 参考（≥3 条，如何规避）

| ERR/模式 | 规避方式 |
|---|---|
| EP-01 Trust Boundary Validation（ERR-001/005/009/013） | Selector 输出是 LLM 输出=untrusted；validator 必须真实校验字段名（防 vacuous check）；禁用 `as` 绕过 |
| EP-02 Production Path Wiring（ERR-011/024/035） | 新选择逻辑必须在两条真实注入路径（abstraction_layer_v1 off/on）的生产入口被测试，不能只测 helper；parity 由 openclaw-shared-host-runtime-parity.feature 守护 |
| EP-03 Fail Loud and Observable Degradation（ERR-002/009） | fail-open 不是静默降级：必须带 reason + next action（skipReason 落 event log） |
| EP-07 Runtime State Source Alignment（ERR-004/008/092） | Card 证据与 working set 上下文指纹来自单一数据源（principle_applications + 触发时实际上下文）；per-workspace 缓存按 workspace 键控 |
| EP-09 Test Reality Gap（ERR-088） | shadow 测试断言「shadow 行存在且内容正确」（唯一信号），不能只断言「注入行为未变」——fail-soft 路径也产生该信号 |

### 14.6 BDD 影响评估

| 阶段 | 行为契约 | 相关 .feature | 处置 |
|---|---|---|---|
| Phase 0 | 注入行为不变 | receipt/principle-application-ledger.feature、receipt/pd-context-receipt.feature、receipt/receipt-self-report.feature | 应保持绿；新增 stats 命令若进 CLI 契约，评估 cli/*.feature |
| Phase 1 | 注入行为不变（shadow 只记录） | 同上 | 保持绿；shadow 行为本身应新增场景（若 owner 确认契约值得固化为 .feature） |
| Phase 2 | 注入选择行为改变 | story-a/owner-approve-prompt.feature、story-a/openclaw-shared-host-runtime-parity.feature | 必须评估并可能更新；行为契约变化需 Owner 确认并在 PR 描述说明 |
| 全部 | — | 不删除任何 .feature 文件 | — |

---

## 15. 明确不做清单

- Dynamic Reselection（每轮/事件触发）—— Phase 3 远期
- Event-triggered Principle
- Vector Database / RAG Pipeline
- Attribution System（路线图 §1，Hold）
- 自动 Principle Router（与 Selector 职责重叠但属自动决策，超出 Owner 治理边界）
- 治理 core_principles 与 P0
- Memory System

---

## 16. 附录 A：推荐实施顺序

```
Step 1  翻开 receipt/self-report/intent flags（配置变更，当天）
Step 2  pd principles stats 聚合命令（约 2-3 天）
Step 3  连续 ≥ 2 周观测 → 报告 → Owner 判定（触发路线图 §23 条件核对）
Step 4  Owner mvp-exception 批准 → Phase 1 Shadow Selector（约 1 周）
Step 5  shadow 数据评估（recall / churn / latency / cost）
Step 6  Phase 2 Working Set Enable（约 1 周，含双路径 parity + .feature 更新）
Step 7  （远期）Phase 3 Dynamic Reselection
```

---

## 17. 最终设计原则

PD 不应该让所有经验同时进入 Agent。

```
所有经验长期保存（Repository）
        ↓
只有少量经验进入当前注意力空间（Working Set）
        ↓
行为改变
        ↓
新的证据反馈（principle_applications）
        ↓
未来选择更准确
```

最终目标：

> Principle Repository 管理 Agent 的长期智慧，Principle Working Set 管理 Agent 当前注意力。

这不是 Memory。这是 **Agent Attention Governance Layer**——且每一层选择都必须对 Owner 可解释、可关闭、可回滚。
