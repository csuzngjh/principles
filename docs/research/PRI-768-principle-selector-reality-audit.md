# PRI-768 Principle Selector Reality Audit（独立复核版）

- 日期：2026-09-23
- 类型：只读架构审计（READ-ONLY）。零源码改动、零配置改动、零数据库写入、零 PR、零新建 Linear issue
- 任务书：`PRI-768 Principle Selector Reality Audit`（Owner 下发）
- 证据等级：所有关键结论附 `file:line` / 真实构建产物复现 / live 数据库只读查询 / live 事件日志；`MEASURED` 与 `ESTIMATED` 严格分开标注
- 探针与原始数据：`D:/pd-probe-pri768/`（`probe1..8.*` + `_raw` 输出）

## 基线声明

```text
REPO_LOCAL_HEAD      = ccc69252 (Merge PR #1839)
UPSTREAM_MAIN        = 602ee705e89d0bed1b6aae20356c06587807537b  (git ls-remote origin refs/heads/main)
                      local HEAD 是 upstream main 的祖先（fast-forward 关系，非分叉）
PROD_RUNTIME_VERSION = 2.1.0 / releaseId bundled-2.1.0-69115f70496e
PROD_SOURCE_COMMIT   = e5e2b16b4e1aa18e0b736a6957613906cf65d582  → 是 local HEAD 的祖先（已核对）
LIVE_WORKSPACE       = D:/.openclaw/workspace   (.pd/state.db 15.4MB, .state/logs/events_*.jsonl ×9)
PROBE_SET            = 4182 条 runtime_v2_prompt_activations_injected 事件（2026-09-16 → 2026-09-23）
```

> **本报告是独立复核，不是首份报告。** 仓库内已存在一份同日更早的审计：`docs/audit/PRI-768-runtime-principle-selector-reality-audit.md`（2026-09-22 23:50，BASE_SHA `4072eee7`，41037 bytes）。本次未采信其结论，而是**用不同的方法（真实构建产物 + 历史状态重建 + 1:1 事件复现）从头重验**。备份与 sha1：`D:/pd-probe-pri768/PRI-768-runtime-principle-selector-reality-audit.md`（`088a13eefcf05d30e464ebd8a9d112705da5243d`）。
> **复核结果：核心结论一致（无 Selector），但有三处重要修正与新增证据，见 §0.2。**

---

## 0. Executive Summary

### 0.1 一句话结论

**PD 生产链路上不存在任何按任务选择原则的 Runtime Principle Selector。** 决定"这一轮 Agent 记住哪些 Principle"的机制是：

```text
SELECT * FROM activations WHERE channel='prompt' AND deactivated_at IS NULL
  ORDER BY activated_at ASC          ← ★ 唯一排序键：激活时间，最老在前
        ↓
filterPromptActivations / resolvePrincipleFromArtifact   （保序过滤）
        ↓
trimToBudget(list, 2000, escapeXml)  ← ★ 首个装不下即 break，其后全部出局
        ↓
renderPrinciplesToDirectives         （渲染）
```

即 `load all → sort by activation ASC → hard-prefix-truncate`，**不是** `rank → pack`。

```text
SELECTOR_AUDIT_RESULT = NO_REAL_RUNTIME_SELECTOR
ROOT_CAUSE(C)         = SELECTOR_MISSING          （主因，CONFIRMED）
ROOT_CAUSE(E)         = PACKER_SEMANTICS_COMPOUND  （ASC 序 + break 硬截断 + 记账面 ≠ 投影面）
REFUTED               = A(budget too small) / D(selector exists but ineffective)
```

### 0.2 相对既有审计的三处修正与新增

| # | 内容 | 性质 |
|---|---|---|
| **M1** | **PR #1844 至今仍为 `OPEN`，未合并**（`gh pr view 1844`：`state=OPEN`, `mergedAt=null`）。任务书"PR #1844 已将 UX 层补充"的前提**在代码事实上不成立**——该 UX 缓解尚未进入任何生产版本。 | **修正任务书前提** |
| **M2** | 共享投影函数 `buildActivePrinciplePromptContext()` **不是 live 注入路径**（`abstraction_layer_v1: enabled=false`）。但它是 PRI-890（已部署）审批告警与 PR #1844 预算预告的**唯一数据源**。实测该函数在当前数据上只投喂 **3/11** 条（1998/2000c，饱和 99.9%），而 live 路径投喂 **9/11**。⇒ **面向 Owner 的预算预告与真实生产行为不属同一记账面**，会系统性夸大饥饿程度。 | **新增关键发现** |
| **M3** | 用仓库 dist 纯函数 + 历史 DB 状态**重建任意时刻的激活集**，在 5 个时间点上对 4182 条真实事件做 1:1 复现：`idsMatch=true, charsMatch=true` **5/5**。机制从"推断"升级为"复现"。另测得记账面/投影面差异为 **1893c → 3850c（×2.03）/ 4205c（×2.22，self-report 开）**，高于既有审计的 1.84× 估计。 | **新增强证据** |

### 0.3 生产现况（截至 2026-09-23T02:54Z，MEASURED）

| 指标 | 值 |
|---|---|
| prompt 通道活跃激活 | **11** 条 |
| 实际进入 Agent 上下文 | **9** 条（1893c 记账） |
| 被 FIFO 饥饿排除 | **2** 条 |
| 其中"从未被注入过一次"（全量 4182 事件中 0 次） | **2** 条 —— 「交付前强制重跑完整管线…」「以核验过的最新资产状态为产出依据，而非记忆」 |
| 全量事件中 `v2Truncated=true` | 667 / 4182（15.9%） |
| 饱和（≥1900c）事件 | 616 / 4182（14.7%） |
| legacy `<evolution_principles>` 块 | 恒空（`legacySelectedCount=0`） |

最新两条原则（09-22 16:01:52 / 16:04:09 批准）**此刻仍被排除在外，一次都没进过 Agent 上下文**。这不是历史事故——是当前正在发生的生产状态。

---

## 1. Current Architecture（生产注入链路全追踪）

### 1.1 两条路径 · 只有一条是 live

`packages/openclaw-plugin/src/index.ts:140-156` 的 `shouldUseSharedHostRuntime()` 由 feature flag `abstraction_layer_v1` 决定路由：

| flag | 路径 | 状态 |
|---|---|---|
| `abstraction_layer_v1 = false` | **plugin-local**（`handleBeforePromptBuild` 第 3 参为空） | **LIVE**（live `config.yaml:103-105` 实测 `enabled: false`） |
| `abstraction_layer_v1 = true` | **shared host-runtime**（`createProductionHostRuntime.beforePromptBuild` → `buildActivePrinciplePromptContext`） | 未启用（Codex 适配器同源） |

> 任务书把 `buildActivePrinciplePromptContext()` 画在链路上。**这个假设需要修正**：它是设计中的共享内核，但 live 上走的是 plugin-local 的 `PromptActivationReader` + `trimToBudget`。二者语义同构（都是 ASC 序 + 前缀截断），但**记账面不同**（见 §5.3）。

### 1.2 LIVE 生产调用链（逐跳，含 file:line）

```text
OpenClaw before_prompt_build
  ↓ [packages/openclaw-plugin/src/index.ts:378-381]
    runtimeGate.enabled=false → handleBeforePromptBuild(event, hookContext)   ← 无 sharedActivePrinciplePrompt
  ↓ [packages/openclaw-plugin/src/hooks/prompt.ts:595-598]
    new PromptActivationReader(workspaceDir).readActivatedPrinciples()
  ↓ [packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts:37-38]
    store.listPromptActivations()
  ↓ [packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts:110-113]
    SQL: WHERE channel='prompt' AND deactivated_at IS NULL
         ORDER BY activated_at ASC                    ← ★ 唯一排序键在此（SQL 层）
  ↓ [packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:40-46]
    filterPromptActivations()            （保序 + 有效性过滤）
  ↓ [a.a.:48-113]
    resolvePrincipleFromArtifact()       （artifact_kind='principle' && validation_status='validated'）
  ↓ [prompt.ts:604-629]
    与 legacy reducer active/probation 取并集去重 → dedupedV2   （live 上 legacy 恒空，等于恒等变换）
  ↓ [prompt.ts:635-645]
    trimToBudget(dedupedV2, RUNTIME_V2_PRINCIPLE_BUDGET=2000, escapeXml)
  ↓ [prompt-activation-reader-contract.ts:129-138]
    for (const p of principles) {
      if (remaining < entry.length + 1) { truncated = true; break; }   ← ★ 硬前缀截断在此
    }
  ↓ [prompt.ts:656-693]
    alignInjectedPrinciples → eventLog.recordRuntimeV2ActivationsInjected
                              （.state/logs/events_*.jsonl）
  ↓ [prompt.ts:789-798]
    renderPrinciplesToDirectives(dedupedV2, runtimeV2PrincipleIds)
      → prependSystemContext（system prompt 头部，最高注意力位）
  ↓ [prompt.ts:809-820]
    truncateInjectionToBudget（9000c 全局 size-guard）
      ← 只裁 appendSystemContext 的各块；prependSystemContext 从不被裁
  ↓
Agent Prompt（【ACTIVE BEHAVIOR DIRECTIVES】块）
```

### 1.3 逐问回答

| 任务书问题 | 答案 | 证据 |
|---|---|---|
| 1. Active principles 存储在哪？ | SQLite `activations` 表（`channel='prompt'`, `action='prompt_activate'`, `deactivated_at IS NULL`）+ `pi_artifacts`（原则正文） | `sqlite-activation-state-store.ts:108-123` |
| 2. 哪个模块负责"选择"注入原则？ | **没有任何模块负责选择**。读取由 `PromptActivationReader`（live）/ `buildActivePrinciplePromptContext`（shared）承担；取舍由 `trimToBudget` 的字符装箱承担 | `runtime-v2-prompt-activation-reader.ts:21-90`、`active-principle-prompt.ts:102-118` |
| 3. 是否存在 selector？ | **不存在**（详见 §2） | 全仓检索 + 逐消费者核查 |
| 4. selector 的输入是什么？ | N/A。等价输入 = `workspaceDir` + SQLite 两张表。**无任务/意图/焦点/tags/effect 输入** | `readActivatedPrinciples()` 签名仅 `workspaceDir` |
| 5. selector 的输出在哪消费？ | N/A。等价的"读出列表"消费链见 §1.2 | — |
| 6. budget truncation 在哪发生？ | 两处同构：`prompt-activation-reader-contract.ts:131-134`（live）与 `active-principle-prompt.ts:112-115`（shared） | 均已 1:1 复现 |
| 7. 是否存在 fallback？ | 有三级 fail-open，但**都不是"选择降级"**：① config 不可读 → 用默认值继续；② `state.db` 不存在 → 空注入 + warning；③ artifact 解析失败 → warn 后跳过该条。**没有任何"预算不足时换一条更相关的"降级** | `active-principle-prompt.ts:38-61,68-93`；`prompt.ts:743-745` |

---

## 2. Audit Existing Selector Capability

### 2.1 结论：名字像 selector 的组件全部核查完毕，**没有一个服务运行时注入**

| 组件 | 位置 | 真实职责 | 是否服务 v2 注入 |
|---|---|---|---|
| `selectLearnedPrincipleV0/V1` | `runtime-v2/owner-decision/semantic-selector.ts` | Owner **决策卡展示文本**挑选（tier 序 + 可读性门） | **否**（治理 UI） |
| `selectPrinciplesForBootstrap` | `openclaw-plugin/src/core/bootstrap-rules.ts:35` | Rule bootstrap CLI 的 violation 计数排序 | **否**（CLI） |
| `selectCorePrinciples` | `runtime-v2/core-principles/core-axiom-block.ts:60` | 静态身份公理按 scope **恒注入**，无选择语义 | **否**（恒注入） |
| `selectPrinciplesForInjection` | `prompt-builder/principle-selection.ts:116-191` | **唯一名副其实的选择器**：priority(P0>P1>P2) + createdAt 新者优先，贪心装箱，溢出 `continue` + P0 强制保留 | **否** —— 只服务 legacy `<evolution_principles>` 块，**而该块在 live 上恒空**（4182/4182 事件 `legacySelectedCount=0`） |
| `filterPromptActivations` | `prompt-activation-reader-contract.ts:40-46` | 按有效性过滤，**保序** | 是，但**无选择语义** |
| `trimToBudget` | 同上 `:115-141` | **截断器**：first-fit + `break` | 是，但**无选择语义** |
| `PromptActivationReader` | `openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts` | **reader**：读全量 + 推导 authority | 是，但**无选择语义** |

### 2.2 "为什么仍然出现 FIFO 饥饿"——如果不存在 selector 的话

因为**根本没有让位的机制**。`activated_at ASC` 决定了队头永远先占位，`break` 决定了队尾永远先出局，而唯一的"让位"手段是**人工退役更老的激活**。生产数据给出了这条因果链的直接证据（§4.2）。

### 2.3 明确证明"不存在"的方法

1. 全仓（限定 `packages/*/src`）检索 `selector|select|ranking|score|priority|relevance|working set|budget|injection|principle context|active principle` 各变体；
2. 对每个命中项逐一核查**消费者**而非名字（上表）；
3. 核查注入读取函数的**签名**——`readActivatedPrinciples()` 无任何任务/意图参数，且 `resolvePrincipleFromArtifact()` 只取 `principleId + text`，**tags/scope/domain/triggerPattern/applicability 在注入期被丢弃**（`prompt-activation-reader-contract.ts:86-102`）；
4. 用 5 个真实时间点的 1:1 复现反证"存在任何未观察到的重排"（§4.3）。

---

## 3. Analyze Current Budget Behavior

### 3.1 `buildActivePrinciplePromptContext` 及其调用者

| 调用者 | 位置 | 场景 |
|---|---|---|
| `createProductionHostRuntime.beforePromptBuild` | `packages/host-runtime/src/index.ts:250-254` | 共享路径（`abstraction_layer_v1=on`）/ Codex 适配器 |
| `ApprovalsConsoleModel.checkPromptInjectionBudget` | `packages/pd-console/src/server/models/ApprovalsConsoleModel.ts:226-243` | **审批时的 Owner 告警**（PRI-890，已部署） |
| 测试 | `packages/host-runtime/tests/production-host-runtime.test.ts` | 单测 |

### 3.2 真实策略判定（用代码说话）

| 候选策略 | 是否成立 | 证据 |
|---|---|---|
| FIFO（按激活时间，最老优先） | **✅ 成立，且是唯一排序键** | `sqlite-activation-state-store.ts:112` `ORDER BY activated_at ASC` |
| LRU | ❌ | 无 last-used 感知，无访问时间列 |
| priority | ❌（v2 通道） | `ActivatedPrinciple` 接口无 `priority`；`resolvePrincipleFromArtifact` 不读取任何优先级字段（`prompt-activation-reader-contract.ts:5-20`）。priority 只存在于 legacy 通道 |
| activation time | ✅ | 同上（FIFO 即 activation time） |
| character length | ✅ **作为截断依据**，不作为排序依据 | `contract:131` `if (remaining < entry.length + 1) … break` |
| fixed ordering | ✅ | 全链保序：filter 保序 → dedup 保序 → trimToBudget 保序 → render 保序。**从 SQL 到 prompt 无任何一步重排** |

数学表述：

```text
injected = { p ∈ Active | Σ_{q ≤ p in ASC order} cost(q) ≤ 2000 }
```

即"ASC 序前缀"。被排除的永远是**激活最晚的那一批**，与其相关性、篇幅、疗效、Owner 授权时间全部无关。

**与 legacy 选择器的两处硬差异（同一仓库内两种哲学）**：

| 维度 | legacy `selectPrinciplesForInjection` | v2 `trimToBudget` |
|---|---|---|
| 排序 | priority + createdAt（新者优先） | activated_at ASC（**老**者优先） |
| 溢出后 | `continue`（继续尝试更小的项）+ P0 强制保留 | `break`（**其后全部出局，不评估**） |

### 3.3 预算常量

`RUNTIME_V2_PRINCIPLE_BUDGET = 2000`（`prompt-activation-reader-contract.ts:3`）——**硬编码常量，无任何配置项**（全仓检索 `promptContextBudget|principlePromptBudget|injectionBudget|budgetChars` 无 config 命中）。`pd principles stats` CLI 只读取它用于展示。计量单位是 JS string length（UTF-16 code unit），**不是 token**。

---

## 4. Production Evidence Analysis

数据源：`D:/.openclaw/workspace/.pd/state.db`（`readonly: true`）+ `.state/logs/events_*.jsonl`（12 个文件，2026-09-16 → 09-23）+ `.pd/logs/events_*.jsonl`（双目录已扫，避免 PRI-577 类漏读）。**全部只读，未写入任何数据。**

### 4.1 计数

```text
Principle count (prompt channel, active):        11
Injected (live, 2026-09-23):                      9   / 1893 chars ledger
Injection budget:                               2000 chars
Budget saturation events (>= 1900c):             616 / 4182   (14.7%)
v2Truncated=true events:                         667 / 4182   (15.9%)
Legacy block non-empty events:                     0 / 4182
```

注入事件签名直方图（MEASURED）：

| 签名 | 次数 | 时期 |
|---|---|---|
| `1P / 300C / trunc=false` | 3202 | 早期单条激活期 |
| `10P / 1905C / trunc=true` | 582 | 09-20 → 09-21 19:32 |
| `10P / 1905C / trunc=false` | 34 | 同上边界 |
| `10P / 1864C / trunc=true` | 57 | 09-21 19:33 → 09-22 23:00 |
| `10P / 1864C / trunc=false` | 164 | 同上 |
| `9P / 1893C / trunc=true` | 21 | 09-22 23:06 → 现在 |
| 其他 | 122 | 过渡窗口 |

### 4.2 长期占用预算者 & 被排除者（MEASURED）

**当前 11 条活跃原则的全时程注入次数**（分母 = 4182 次注入构建）：

| # | Principle | 激活时间 | 文本长 | 全时程被注入次数 | 首次被注入 | ASCII 序位 |
|---|---|---|---|---|---|---|
| 1 | 意图缺口即风险信号：方向性产出前先澄清并以小样验证 | 09-18 23:42 | 178 | 978 | — | 1 |
| 2 | 交付前以受众视角自检可理解性并设置强制评审关卡 | 09-18 23:44 | 122 | 977 | — | 2 |
| 3 | Owner 约定持久化并在阶段开工与生成类行动前强制召回比对 | 09-18 23:46 | 178 | 977 | — | 3 |
| 4 | 约定召回门：Owner 约定首次表达即持久化… | 09-18 23:47 | 182 | 977 | — | 4 |
| 5 | 有后果的变更前，以全局引用证据探明关联面… | 09-19 17:11 | 101 | 865 | — | 5 |
| 6 | 指令模糊时先确认意图边界，采用最保守的最小删减变更 | 09-19 22:23 | 117 | **249** | **09-21 19:33:58** | 6 |
| 7 | 以可校验的持久化状态为决策依据… | 09-22 15:09 | 258 | **28** | **09-22 23:06:00** | 7 |
| 8 | 交付前以可观察证据自检：将验收基准显式化并固化为流程门禁 | 09-22 16:01 | 183 | **28** | **09-22 23:06:00** | 8 |
| 9 | 生成式任务须实施全时程约束锁定与分段校验门禁 | 09-22 16:01 | 222 | **21** | **09-22 23:55:31** | 9 |
| 10 | 交付前强制重跑完整管线，以可版本追踪的证据核验宣称 | 09-22 16:01 | 180 | **0** | **从未** | 10 |
| 11 | 以核验过的最新资产状态为产出依据，而非记忆 | 09-22 16:04 | 230 | **0** | **从未** | 11 |

**这张表的每一行都在讲同一个故事：首次被注入的时间 = 某条更老原则被退役的时间。**

| 被退役原则 | 退役时间 | 立即受益者（首次注入时间） | 饥饿时长 |
|---|---|---|---|
| Model-Evidence-Reversibility-Verification Loop（216c, 09-01 激活）<br>先以可观察证据验证系统状态…（97c, 09-18 激活） | 09-21 19:33:43 | 「指令模糊时…」→ 09-21 19:33:58（**+15s**）<br>「结论必须由可观察证据背书…」→ 09-21 19:33:58 | 2 天 / ~574 次构建 |
| 意图锚定…／基准锚定…／等待与轮询… | 09-22 23:00–23:01 | 「以可校验的持久化状态…」「交付前以可观察证据自检…」→ 09-22 23:06:00（+5min） | ~7 小时 |
| 结论必须由可观察证据背书… | 09-22 23:52:53 | 「生成式任务须实施全时程约束锁定…」→ 09-22 23:55:31（+2.6min） | ~7.9 小时 |
| （无退役） | — | 「交付前强制重跑完整管线…」「以核验过的最新资产状态…」 | **∞（进行中）** |

另有历史零注入案例：「基线锚定与不可劣化护栏…」（09-15 13:22 激活 → 13:41 退役），全时程 0 次注入。

> **这是"Owner 批准成功、激活成功、但从未进入 Agent 行为"的最直接、可计数的生产证据。** 而事件中除一个布尔 `v2Truncated` 外，**没有任何"谁被丢/为何被丢"的结构化字段** —— 治理面完全不可观测。

### 4.3 1:1 复现（MEASURED，方法学核心）

用**仓库真实 dist 构建产物**（`packages/principles-core/dist/runtime-v2/activation/prompt-activation-reader-contract.js` 的 `trimToBudget` + `resolvePrincipleFromArtifact`，`dist/prompt-builder/xml-escape.js` 的 `escapeXml`）在内存中重建历史激活集并重放：

| 采样时刻 | 活跃/可解析 | 模拟结果 | 最近真实事件 | ids 一致 | chars 一致 | 被排除 |
|---|---|---|---|---|---|---|
| 09-20 12:00Z | 11 / 11 | 10P / 1905c / trunc | 09-20 12:03:47 10P/1905c | ✅ | ✅ | 「指令模糊时…」 |
| 09-21 19:28Z | 12 / 12 | 10P / 1905c / trunc | 09-21 19:28:02 10P/1905c | ✅ | ✅ | 「指令模糊时…」「结论必须由可观察证据背书…」 |
| 09-21 19:35Z | 10 / 10 | 10P / 1864c / 不截断 | 09-21 19:38:57 10P/1864c | ✅ | ✅ | 无 |
| 09-22 22:00Z | 15 / 15 | 10P / 1864c / trunc | 09-22 22:02:51 10P/1864c | ✅ | ✅ | 09-22 新增的 5 条**全部** |
| 09-23 00:30Z | 11 / 11 | 9P / 1893c / trunc | 09-23 00:43:30 9P/1893c | ✅ | ✅ | 「交付前强制重跑…」「以核验过的最新资产…」 |

**5/5 逐字符一致。** 机制不是推断出来的，是被复现出来的。这也反证了 §1.2 的链路中**不存在任何未观察到的重排**。

### 4.4 预算压力归因（MEASURED）

| 项 | 值 |
|---|---|
| 当前 11 条原则文本总长 | 1951c |
| 单条文本均值 | 177c |
| **记账面**（`- [id] text`，9 条） | **1893c** |
| **投影面**（`renderPrinciplesToDirectives`，同样 9 条，self-report **off**） | **3850c**（×2.03） |
| **投影面**（self-report **on**，live 配置如此） | **4205c**（×2.22） |
| shared 路径的固定块头开销 | **595c**（占 2000c 预算的 **29.75%**，与原则无关） |
| shared 路径单条 directive 边际成本 | ~380c |

**两个结论：**

1. **压力主因是"条数 × 固定渲染开销"，不是单条过长。** 单条文本仅 177c，但渲染成 directive 后约 380–467c。
2. **live 路径的"2000c 预算"并没有约束真正进 prompt 的内容。** 记账 1893c，实际注入 4205c —— **超出预算 2.1 倍**。共享路径按渲染长度记账（更诚实，但同样条数下装得更少）。这两条路径的行为**不可互换**。

---

## 5. Root Cause（任务书 A–E 判定）

### 5.1 逐项判定

| 选项 | 判定 | 证据 |
|---|---|---|
| **A. Budget too small** | **❌ 非根因** | ① 2000→4000 只是把饱和点推后：ASC 序尾部的新原则**依然**排在队尾，只是晚一点出界。② 记账/投影 ×2.22 意味着"调大预算"的上下文代价被系统性低估——账面 4000c 实际会注入 ~8900c。③ 11 条原则文本仅 1951c，**数据量离"预算不够"还很远**，是渲染开销与排序策略在吃预算。 |
| **B. Principles lifecycle missing（旧原则从不退役）** | **⚠️ 真实贡献者，但非根因** | 退役**能**解饥饿（§4.2 每一个"首次注入"都紧跟在退役之后）——这恰好证明退役被当成了人工泄压阀在用，是 lifecycle 失效的**症状**。但"批准→激活→从未注入"这条链的直接机制与退役无关：即使从不退役，一条**正确**的选择器也能让新原则进场。 |
| **C. Selector missing** | **✅ 主因，CONFIRMED** | 生产注入链**零任务上下文输入**（`readActivatedPrinciples(workspaceDir)`，签名无任务/意图/焦点参数）；全仓无任何服务注入的选择函数（§2.1）；tags/scope/applicability 等 schema 字段在注入期被丢弃（`contract:86-102`）。 |
| **D. Selector exists but ineffective** | **❌ REFUTED** | 不存在可被"无效"的 selector。最接近的 `selectPrinciplesForInjection` 服务的是 legacy 块，**而 legacy 块 live 恒空（0/4182）**，既没被绕过也没失效——它根本没在工作面上。 |
| **E. 其他** | **✅ 复合机制，与 C 并列"病灶"** | ① **`break` 语义**：首个装不下即终止，比 legacy 的 `continue` 更硬，其后所有条目（哪怕更小、更相关）**从不被评估**。② **ASC 方向**：最老优先，与"新批准的更需要验证"的治理直觉相反。③ **记账面 ≠ 投影面（×2.22）**：预算既不真实约束产出，又使面向 Owner 的数字失真。④ **出界者零观测**：事件只有布尔 `v2Truncated`，无被丢 id/位次/原因。 |

### 5.2 结论

```text
PRIMARY   : C — SELECTOR_MISSING
            （生产链路无任务感知选择能力；该能力有完整设计却处于 Hold）
COMPOUND  : E — PACKER_SEMANTICS
            （activated_at ASC 前缀 + break 硬截断 + 记账面≠投影面 + 出界零观测）
CONTRIB   : B — LIFECYCLE（退役被当作人工泄压阀）
REFUTED   : A（预算不够）、D（selector 无效）
```

**confidence: HIGH。** 依据：机制 5/5 逐字符复现 + 因果时间链（首次注入 ⇔ 退役）+ 全仓组件逐个排除。

**remaining uncertainty:**

1. **本机仅有单一 workspace 证据**（`D:/.openclaw/workspace`）。其他用户/workspace 的原则库存规模不同，饱和点不同，但**机制同构**（代码是同一份）。
2. **`legacySelectedCount` 恒空**的根因未在本审计展开（既有审计记为 v6-08）。若 legacy 块将来恢复非空，跨块去重会改变 v2 的候选池——但**不改变 ASC/break 语义**。
3. **未验证 other hosts**（Codex 适配器路径未跑真实数据）；按代码它走 shared 路径，故贫血程度比 live 更重（3/11 vs 9/11）。
4. 未测 token 成本（预算单位是字符，本机无对应 tokenizer 事实），故"×2.22 换算成 token"未给数。

---

## 6. Design Recommendation（No Implementation）

### 6.1 首要结论：**不要新建 Selector 设计**

`docs/superpowers/specs/2026-08-22-principle-working-set-selector-spec.md`（**v0.2**，状态 `Proposal — Hold`）**已存在且自洽**，且其 §1.1 在 2026-08-22 就已把本审计的问题定义为"预算截断相关性盲"。本审计在 `ccc69252` / 生产 `2.1.0(e5e2b16b)` 上逐项复核，**SPEC §5.2 的代码事实断言仍然成立**。

按 AGENTS.md（P3 最小变更面、P7 无投机抽象、MVP-first）与 SPEC 自身的阶段纪律：

> **不需要"新增"能力，需要的是 Owner 对 SPEC Phase 1/2 的启动决策。**

### 6.2 若确认需要 Selector —— 契约草案（**对齐既有 SPEC，不另立设计**）

**Input**（SPEC §7/§8 已定义，此处只做审计侧的可达性标注）

| 输入 | 可达性 | 现成读取器 |
|---|---|---|
| Current Task / 本轮用户消息 | ✅ 可达（`event.prompt`） | `extractUserMessageFromPrompt` |
| Intent | ✅ 可达（INTENT.md，flag 已开） | `intent-doc-reader.ts` / `buildIntentFrictionBlock` |
| Current Focus | ✅ 可达（CURRENT_FOCUS.md） | `safeReadCurrentFocus` / `extractSummary` |
| Candidate Principle 元数据（id/text/title/statement） | ✅ 可达 | `resolvePrincipleFromArtifact` |
| Principle tags/scope/domain/triggerPattern | ⚠️ **schema 有、注入期被丢弃** | 需在 Candidate Card 构造时读取 artifact `content_json` 并显式透传 |
| Pain history | ✅ 可达（`pain_events`） | 既有 store |
| **Effect history** | ⚠️ **数据存在但注入期零消费**（`principle_applications` 1039 行） | 需新建只读查询；**注意既有坑：effect 回执 `activation_id` 长期为 NULL**，归因连接未修前不能作为排序主键 |
| Owner priority | ❌ v2 激活工件**无此字段** | legacy 通道有，v2 无——若需要，属**新增数据**，须走 SPEC 修订 |

**Output**

```text
WorkingSet {
  selected:   Array<{ principleId, reason, confidence }>   // 0..3
  discarded:  Array<{ principleId, reasonCode }>           // ★ 必须是结构化字段，不能只有布尔
  budget:     { usedChars, budgetChars }
  skipReason?: string                                       // fail-open 时
}
```

`discarded` 是本审计相对 SPEC 的**新增硬要求**：没有它，Owner 永远看不到"谁被换了出去"，治理闭环仍然断在 §4.2 那个位置上。

**Constraints（必须满足）**

| 约束 | 具体含义 | 证据 |
|---|---|---|
| Owner 可解释 | 每条 selected 必须带可读 reason；每条 discarded 必须带 reasonCode | §4.2 出界零观测 |
| 可审计 | 决策必须落事件（含输入摘要 + 输出 + skipReason），可事后重放 | 既有 `recordRuntimeV2ActivationsInjected` 形状可扩展 |
| 可回滚 | 单 flag 回到当前 FIFO 行为；**不得让指针/状态无法还原** | SPEC §12 双 flag（shadow/live）设计 |
| 不替代 Owner authority | Selector 只决定"哪些进上下文"，绝不决定"哪些被批准/退役" | AGENTS.md P4 单一真相源；SPEC R7（core_principles/P0 移出治理范围） |
| **记账面必须与投影面统一** | 预算判定必须基于**实际进 prompt 的长度** | §4.4：1893c → 4205c（×2.22） |
| **双路径 parity** | plugin-local 与 shared 必须同改同测 | `openclaw-shared-host-runtime-parity.feature` 现有场景**未覆盖**记账面差异 |
| 不新增 Context 子系统 | Intent/Focus 均有现成读取器，直接复用 | SPEC §5.4 |

### 6.3 三个相互独立的决策面（推荐落点，非实施）

| 面 | 内容 | 行为变更 | 前置条件 |
|---|---|---|---|
| **面 1 · 观测/治理** | ① 事件补 `discardedPrincipleIds[]` + 出界位次 + reasonCode；② 修正 PRI-890/PR #1844 的预算预告数据源（见 §6.4） | **零**（纯信息增量，rc-8 有界序列化） | 无 |
| **面 2 · 顺序/装箱策略** | `continue` 替代 `break` / newest-first / per-principle 配额 / 记账面统一 | **有**（Owner 可见行为） | 先补 ASC/FIFO 特征测试 + 双路径 parity 场景（**当前零排序特征测试保护**） |
| **面 3 · 选择能力** | = SPEC Phase 1/2 | 有 | Owner `mvp-exception` 或路线图 §23 重启条件 |

### 6.4 针对 PR #1844 的具体发现（可直接作为评审意见）

1. **`state = OPEN`，`mergedAt = null`** —— UX 缓解尚未进入生产。
2. **数据源与生产不一致**：`promptInjection { budget, usedChars, truncated }` 与 `checkPromptInjectionBudget` 均来自 `buildActivePrinciplePromptContext`（共享路径），而 live 走 plugin-local。实测同一份数据：共享路径 **3/11 条、1998/2000c**，live 路径 **9/11 条、1893/2000c**。⇒ 预告的 `usedChars` 会把 1893 报成 1998，把"排除 2 条"报成"排除 8 条"，**方向保守但数值失真**。
   **建议**：预告与告警应使用**与注入同一路径**的投影（或先做 §6.3 面 2 的记账面统一），否则 Owner 会基于错误数字做退役决策。
3. 已部署的 runtime（2.1.0 / e5e2b16b）**含** PRI-890 的服务端 `injection_budget_excluded` 警告（`~/.pd/runtime/console/dist/server/models/ApprovalsConsoleModel.js` 已核），**不含** PR #1844 的中文化与批准前预告。

---

## 7. Shadow Mode Proposal（验证方案设计，不替换 production）

对齐 SPEC §12 的**双 flag**（shadow / live）与 RuleCode 既有 shadow→live 先例；不在同步注入路径上加 LLM 调用（SPEC §9）。

```text
┌─ 现有注入路径（FIFO + 2000c）────────→ 实际进 Agent 上下文（不变，flag=off 时逐字节不变）
│
└─ Selector Shadow 分支（旁路，无副作用）
        ↓ 同一输入：candidate set + Intent + Focus + 本轮任务摘要
        ↓ Selector 输出 WorkingSet { selected[0..3], discarded[], reason, confidence }
        ↓ 只落事件，不改注入
        ↓
   与 FIFO 结果 Compare（离线）
        ↓
   Owner Review（生效情况页：一致性 / 冲突 / 新原则是否进场）
        ↓
   Measure（窗口聚合）
```

### 7.1 必须观察的指标

| 指标 | 定义 | 数据来源 | 为什么 |
|---|---|---|---|
| **relevance**（人工盲评） | Owner/评审对 selected 与本轮任务相关性的判定 | 抽样 review | 唯一的"对不对"的判据，机器无法自证 |
| **missed critical principles** | shadow 选中但 FIFO 排除的条数 / 反向 | 事件 diff | 直接量化"选择器救回了什么" |
| **FIFO starvation rate** | 活跃原则中 0 次注入的占比 | 现有 §4.2 口径 | **本审计已建立基线**：当前 2/11 = 18.2% |
| **injection efficiency** | 单位预算内被判定"相关"的原则条数 | 事件 + review | 预算利用率 |
| **behaviour improvement** | shadow 选中原则 self-report 命中率 / 相关 run 的 correction 下降 | `principle_receipt_self_report` + `user_corrections` | 需先确认 effect 回执 `activation_id` 归因连接已修（否则归因不可用） |
| **budget adherence** | 投影面实际字符 vs 预算 | 事件新增字段 | 当前 ×2.22 偏离必须先钉住 |

### 7.2 前置与红线

- **前置**：① 记账面统一（否则影子对照的基线本身失真）；② 事件补 `discarded[]`（否则无法做 diff）；③ effect 回执归因是否已修必须先确认。
- **红线**：shadow 分支**不得**写 `activations` / `pi_artifacts` / `principle_applications`；失败必须 fail-open 且落 `skipReason`（rc-9）；flag off 时**逐字节**等同现状（SPEC §12 验收要求）。
- **本机可立即做的零风险预演**（无需任何代码改动）：本审计 §4.3 的"DB 状态重建 + 纯函数重放"harness 已具备做"FIFO vs 假设算法"**离线 A/B** 的能力——可先用历史 4182 条事件做**回测**（"若换成 newest-first，会救回谁"），**零行为风险**即可量化收益。

---

## 8. Open Questions

1. `legacySelectedCount=0` 恒空（v6-08）的根因未查——若修复，跨块去重将改变 v2 候选池。
2. `principle_applications` 的 `activation_id` 归因为 NULL（既有审计记录 93/93）是否已修？决定"behaviour improvement"指标是否可用。
3. 预算单位是字符。若要走 token 计费，本机无对应 tokenizer 事实，需单独验证。
4. 共享路径（3/11）与 plugin 路径（9/11）的**记账面统一**应由谁承担（PRI-890 侧 / host-runtime 侧）？涉及跨包契约，未在本审计范围内定案。
5. 生产 workspace 之外的用户装机，库存规模分布未知；"饱和成为常态"的阈值（约多少条原则）未做敏感性分析。

---

## 9. 纪律声明

| 声明 | 状态 |
|---|---|
| 未修改任何源码 | ✅ |
| 未修改任何配置 | ✅ |
| 未创建 PR | ✅ |
| 未新建 Linear issue | ✅ |
| 数据库访问全部 `readonly: true` | ✅（`better-sqlite3` `{readonly:true, fileMustExist:true}`） |
| 未改动 runtime behavior | ✅ |
| 未接受 SPEC/既有讨论作为事实（均以代码 + 生产数据重验） | ✅ |
| 未为证明假设而筛选证据（M1/M2 明确推翻任务书前提） | ✅ |
| `MEASURED` / `ESTIMATED` / `NOT_MEASURED` 分标 | ✅ |

## 10. 证据资产

```text
D:/pd-probe-pri768/
  probe1.cjs   activations / pi_artifacts 元数据与计数
  probe2.mjs   共享路径 greedy 装箱仿真（self-report on/off）+ trimToBudget 对照
  probe3.mjs   事件日志扫描（双目录）+ 注入统计 + 频率表
  probe4.mjs   事件签名直方图 / 有序集签名
  probe5.mjs   全时程注入次数 vs 当前活跃集（零注入原则识别）
  probe6.mjs   逐原则首次/末次注入时间线
  probe7.mjs   历史状态重建 + 1:1 事件复现（5/5 idsMatch & charsMatch）
  probe8.mjs   记账面 vs 投影面（1893c → 3850c / 4205c）
  PRI-768-runtime-principle-selector-reality-audit.md  既有审计备份 (sha1 088a13ee…)
```

关键 file:line 索引：

```text
packages/principles-core/src/runtime-v2/activation/sqlite-activation-state-store.ts:108-123   ORDER BY activated_at ASC
packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:3      RUNTIME_V2_PRINCIPLE_BUDGET = 2000
packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:40-46  filterPromptActivations
packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:86-102 resolvePrincipleFromArtifact（只取 id+text）
packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:115-141 trimToBudget（first-fit + break）
packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts:155-194 renderPrinciplesToDirectives
packages/principles-core/src/prompt-builder/principle-selection.ts:116-191                       legacy 选择器（priority+recency+continue）
packages/openclaw-plugin/src/core/runtime-v2-prompt-activation-reader.ts:21-90                  live reader（仅 workspaceDir 输入）
packages/openclaw-plugin/src/hooks/prompt.ts:51-80                                             selectLegacyPrinciplesForPrompt
packages/openclaw-plugin/src/hooks/prompt.ts:595-645                                          live 读取 + trimToBudget
packages/openclaw-plugin/src/hooks/prompt.ts:789-798                                          投影进 prependSystemContext
packages/openclaw-plugin/src/index.ts:140-156                                                 shouldUseSharedHostRuntime（abstraction_layer_v1）
packages/host-runtime/src/active-principle-prompt.ts:31-136                                    共享投影（非 live）
packages/pd-console/src/server/models/ApprovalsConsoleModel.ts:226-243                          PRI-890 审批告警（用共享投影）
```

## 附：最终判定

```text
SELECTOR_AUDIT_RESULT        = NO_REAL_RUNTIME_SELECTOR
ROOT_CAUSE_PRIMARY           = C  SELECTOR_MISSING
ROOT_CAUSE_COMPOUND          = E  PACKER_SEMANTICS (ASC prefix + break + ledger≠projection + no-discard-observability)
CONTRIBUTOR                  = B  LIFECYCLE (retirement used as manual relief valve)
REFUTED                      = A (budget too small) / D (selector exists but ineffective)
CONFIDENCE                   = HIGH
PRODUCTION_REPRODUCTION      = 5/5 exact (idsMatch && charsMatch)
CURRENT_STARVATION           = 2 / 11 principles, 0 injections in 4182 events
PR_1844_STATE                = OPEN (NOT MERGED) — UX mitigation absent from all production versions
NEXT_STEP                    = Owner decision on SPEC v0.2 Phase 1/2; 先做面 1（零行为变更观测）+ 记账面统一
```
