# PD Principle Evolution Audit（原则演化审计）

> **审计类型**：只读架构审计（Reality Audit per `AGENTS.md` §P2.1）
> **审计对象**：PD Runtime V2 的 Pain → Principle → RuleCode → Activation 学习闭环
> **审计日期**：2026-09-23
> **约束遵守**：未修改任何代码；未创建 PR；未创建 Linear 工单；未触碰 `~/.pd/runtime`、`~/.openclaw/extensions/principles-disciple`、`<ws>/.pd/`
> **生产数据来源**：`D:\.openclaw\workspace\.pd\state.db`（只读副本 `D:\pd-probe-evo\state.db`，15,417,344 bytes，快照时间 2026-09-23T11:52 GMT+8）+ `D:\.openclaw\workspace\.state\principle_training_state.json`（124,868 bytes，lastUpdated 2026-09-22T16:04:09.594Z）

---

# Executive Summary

## 结论一句话

**「一次 Pain 产生一次新 Principle」不仅是风险，而是当前系统的既定契约（by construction），不是模型倾向造成的意外。**

实测：**122 次 Pain → 122 条 Principle，映射严格 1:1，零例外**（122 个 distinct painId，无一个 painId 产生 >1 条原则，也无一条原则来自 >1 个 pain）。
同期的 RuleCode 只有 **4 条**。122 : 4 的比例说明瓶颈不在规则层，而在「原则被创建」这一步就已经失控。

## 三个必须区分的状态

审计的核心产出是区分「不存在」与「存在但没有接入」。本仓在这件事上的真实分布是：

| 能力 | 真实状态 | 定位证据 |
|---|---|---|
| Core Axiom 去重（T-01..T-10） | **存在且已接入** | `internalization_core_grounding` 已退役为无条件行为（`feature-flag-contract.ts:261`）；`philosopher-runner.ts:96` / `scribe-runner.ts:131` / `dreamer-runner.ts:93` 默认 `coreGrounding: true` |
| 「已有原则」检索能力 | **存在但没有接入** | `agent-tool-contract.ts:131` `buildDreamerL2Tools()` 提供 `read_principles` 工具，但其唯一入口被 `l2_dreamer: enabled: false` 关闭（`config.yaml:69-71`） |
| L2 原则读取器 | **存在但只读 active** | `build-l2-principle-reader.ts:43` 硬过滤 `status === 'active'`；存量 122 条中只有 9 条满足 |
| L1 容量硬上限 = 12 | **存在但没有接入** | `l1-hard-cap.ts:44` `enforceL1HardCap()` 除 barrel 导出与单测外**无任何生产调用方** |
| 剪枝风险信号（watch/review） | **存在但结构上恒为空** | `pruning-read-model.ts:93,96` 要求 `derivedPainCount === 0`；122/122 条原则的 `derivedFromPainIds` 长度恰为 1 |
| 弃用就绪度评估 | **存在但结构上不受理** | `deprecated-readiness.ts` 依赖 `PrincipleLifecycleEvidence.rules` 指标；122/122 条原则 `ruleIds` 为空 |
| 语义去重 / embedding / cluster | **不存在** | 全仓 `packages/**/src` 内无 principle 域的 similarity/embedding/dedup 实现 |
| principle → behavior fingerprint | **不存在**（同思想只存在于 feedback 域） | `runtime-v2/feedback/fingerprint.ts` 是 feedback report 的 sha256 去重，与 principle 无关 |
| merge / reuse / consolidate / extend | **不存在** | `grep -E "mergePrinciple\|reuseExisting\|extendPrinciple\|consolidate"` 在 `packages/**/src` 命中 0 |
| 规则冲突检测 | **不存在** | `conflictsWithPrincipleIds` 由 `principle-tree-ledger-adapter.ts:38` 硬编码为 `[]`，无任何写入方 |
| 注入预算选择器 | **存在且已接入，但排序为「优先级 + 新近度」** | `prompt-builder/principle-selection.ts:64-76`（同优先级下 newer first） |

## 关键纠正（审计发现的假设偏差）

原任务描述中的链路含 **Arbiter** 阶段。**该阶段已不存在**——`docs/adr/0005-nocturnal-internalization-merger.md:159` 明确记录 `nocturnal-arbiter.ts` 被删除，由 **Evaluator + Validator** 取代。当前生产链路实际为：

```
Pain → Diagnostician（split: diag_router → diag_distiller → diag_rootcause）
     → Dreamer → Philosopher → Scribe → Artificer → Evaluator → RolloutReviewer
     → 写入 principle-tree ledger → Owner Approval → Activation(prompt / code_tool_hook)
```

`consumer-decision.ts:25-32` 的 `FULL_CHAIN_CONSUMER_RUNNER_KINDS` 是这条链的权威枚举。

---

# Current Architecture

## 存储拓扑：三个写入面，一次创建

| 存储 | 位置 | 当前规模 | 角色 |
|---|---|---|---|
| Principle Tree Ledger | `<ws>/.state/principle_training_state.json` | **122 principles / 0 rules / 0 implementations / 23 metrics** | 原则树单一真相（SSOT）。`_tree.principles` 键为 UUID |
| `pi_artifacts` | `<ws>/.pd/state.db` | 921 行（**917 `principle` + 4 `rule`**） | 各 agent 产物的不可变日志（Dreamer/Philosopher/Scribe/… 每阶段一行） |
| `principle_candidates` | `<ws>/.pd/state.db` | 138 行（49 `principle` / 40 `rule` / 17 `prompt` / 16 `implementation` / 1 `defer`） | Diagnostician 阶段产出的候选池 |

Ledger 的写入入口唯一：

```
pd-cli/src/commands/{candidate,diagnose,pain-retry}.ts
  └─ admission-gate.ts:21 checkAdmissionGate()       ← 只拦 'defer' + confidence
       └─ candidate-intake-service.ts:220 intake()
            └─ candidate-intake.ts:291 LedgerAdapter.writeProbationEntry()
                 └─ principle-tree-ledger-adapter.ts:60  PrincipleTreeLedgerAdapter
                      └─ principle-tree-ledger.ts:440  addPrincipleToLedger()
```

自 `principle-tree-ledger.ts:7-14` 起，该模块自 2026-09 起即为 ledger 的**单一写入者**（PRI-459，含跨进程文件锁）。

## 创建契约：`LedgerPrincipleEntry`（11 字段）

`candidate-intake.ts:131-143` 定义，字段与来源一一对应：

| 字段 | 来源 | 备注 |
|---|---|---|
| `id` | `randomUUID()` | 永不复用 |
| `title` | candidate.title | |
| `text` | recommendation.text → candidate.description | |
| `triggerPattern` | recommendation.triggerPattern | Optional |
| `action` | recommendation.action | Optional |
| `status` | **固定 `'probation'`** | 契约硬编码 |
| `evaluability` | **固定 `'weak_heuristic'`** | 契约硬编码 |
| `sourceRef` | `candidate://<candidateId>` | **仅自幂等键** |
| `artifactRef` | `artifact://<artifactId>` | 可追溯性 |
| `taskRef` | `task://<taskId>` | 可追溯性 |
| `createdAt` | `new Date().toISOString()` | |

**`LedgerPrincipleEntry` 中不存在任何指向「其他已有原则」的字段**：没有 `relatedPrincipleIds`、没有 `parentPrincipleId`、没有 `supersedes`、没有 `similarTo`。

## 落盘时的硬编码（决定性问题）

`principle-tree-ledger-adapter.ts:23-47` 的 `expandToLedgerPrincipleStatic()`：

```ts
status: 'candidate' as const,
priority: 'P1' as const,
scope: 'general' as const,
valueScore: 0, adherenceRate: 0, painPreventedCount: 0,
derivedFromPainIds: [candidateId],      // ← 恒为长度 1
ruleIds: [],                            // ← 恒为空
conflictsWithPrincipleIds: [],          // ← 恒为空
```

这三个恒量**精确解释了全部生产观测**：

- `derivedFromPainIds` 长度恒 1 ⇒ 实测 122 条全部来自且仅来自 1 个 pain（pain 多重性分布 `{"1":122}`）
- `ruleIds` 恒空 ⇒ 实测 **0/122** 条原则拥有 RuleCode
- `conflictsWithPrincipleIds` 恒空 ⇒ 实测 **0/122** 条原则声明过冲突

也就是说，**「原则之间有关系」这件事在数据模型上无法表达，在写入路径上无法产生**。这不是漏做了一步检索，而是契约层面排除了关系。

---

# Principle Lifecycle Analysis

## 1.1 Principle Entity 数据模型

原则的富 schema 定义在 `runtime-v2/types/principle-schema.ts:29-54`（`Principle` interface，23 字段）+ `runtime-v2/evolution/evolution-types.ts:57-90`（`EvolutionPrinciple`，24 字段）。

对 122 条生产原则做字段在位率统计（`_tree.principles`）：

| 字段 | 用途 | 在位率 | 缺失判定 |
|---|---|---|---|
| `id` | UUID 主键 | 122/122 | — |
| `version` | 版本号 | 122/122 | 恒为 `1`，无版本演进 |
| `text` | 原则正文（注入用） | 122/122 | — |
| `triggerPattern` | **触发条件** | 122/122 但值多为 `""` | **实质缺失**：intake 允许 Optional，`adapter:34` 回落 `''` |
| `action` | 执行动作 | 122/122 | — |
| `status` | `candidate/probation/active/deprecated/archived` | 122/122 | 分布：**113 `candidate` / 9 `active`**；无 `deprecated`、无 `archived` |
| `priority` | P0/P1/P2 | 122/122 | **恒为 `P1`**（adapter 硬编码）⇒ 优先级完全不携带信息 |
| `scope` | general/domain | 122/122 | **恒为 `general`** ⇒ 作用域完全不携带信息 |
| `domain` | 领域标签 | **0/122** | **缺失** |
| `evaluability` | deterministic/weak_heuristic/manual_only | 122/122 | 由于 `selectPrinciplesForInjection` 的 `highRisk` 判定读它，恒 `weak_heuristic` 意味着永不进入高优先路径 |
| `valueScore` | 价值分 | 122/122 | **恒为 0** |
| `adherenceRate` | 遵守率 | 122/122 | **恒为 0** |
| `painPreventedCount` | 已预防疼痛数 | 122/122 | **恒为 0** |
| `lastPainPreventedAt` | 最近预防时间 | **0/122** | **缺失** |
| `derivedFromPainIds` | 来源 pain | 122/122 | 恒长度 1 |
| `ruleIds` | 关联规则 | **0/122** | **缺失（恒空）** |
| `conflictsWithPrincipleIds` | 冲突原则 | **0/122** | **缺失（恒空）** |
| `supersedesPrincipleId` | 取代关系 | **0/122** | **存在但从未被写入** |
| `coreAxiomId` | 关联核心公理 | **0/122** | **缺失**（但 `routing-policy.ts:147-153` 读它以做路由加成 ⇒ 加成永不生效） |
| `createdAt` / `updatedAt` | 时间戳 | 122/122 | — |
| `deprecatedAt` / `deprecatedReason` | 弃用溯源 | **0/122** | **缺失** |
| `lastTriggeredAt` | **LRU 淘汰信号** | **0/122** | **缺失**（`l1-hard-cap.ts:12` 正是靠它排序淘汰） |
| `detectorMetadata` | 行为检测器规格 | **0/122** | **缺失**（`evolution-types.ts:22-55` 有完整 `PrincipleDetectorSpec` 契约，无用例） |
| `abstractedPrinciple` | 抽象表述 | **0/122** | **缺失** |
| `suggestedRules` | 建议规则 | **0/122** | **缺失** |

### Current Principle Model

```
字段:
  id / version / text / action / createdAt / updatedAt          —— 完整可用
  status / priority / scope / evaluability                       —— 存在但取值退化（priority 恒 P1、scope 恒 general）
  derivedFromPainIds                                             —— 存在但恒长度 1
  triggerPattern                                                 —— 结构存在、值多为空串

用途:
  text            → 唯一的注入载荷（prompt-builder/principle-selection.ts:88）
  status          → 唯一的准入闸门（active 才可注入，build-l2-principle-reader.ts:44）
  priority        → 注入排序主键（principle-selection.ts:64）—— 但因恒 P1 而失效
  createdAt       → 注入排序次序键（principle-selection.ts:75，newer first）
  derivedFromPainIds → 剪枝模型的唯一风险输入（pruning-read-model.ts:210）

缺失（结构性，非配置问题）:
  ruleIds / conflictsWithPrincipleIds        —— 写入路径硬编码为空
  supersedesPrincipleId                      —— 字段已存在于 schema，无写入方
  lastTriggeredAt                            —— LRU 淘汰所需信号，无写入方
  coreAxiomId / domain / abstractedPrinciple —— 无写入方
  detectorMetadata / suggestedRules          —— 契约已定义（evolution-types.ts），无写入方
  lastPainPreventedAt                        —— 无写入方
  以及：任何指向「其他已有原则」的关系字段本身
```

## 1.2 生命周期各阶段的真实状态

### 阶段 A — 创建（`Pain → Principle`）

`candidate-intake-service.ts:1-18` 自述的 6 步流程：

```
1. Validate input
2. Check idempotency (existsForCandidate) — O(1) lookup
3. Load candidate from DB
4. Load artifact from DB and parse recommendation
5. Build 11-field LedgerPrincipleEntry
6. Write via adapter.writeProbationEntry()
```

**第 2 步是唯一的一次查找，而它是自我幂等检查**（`existsForCandidate` 在 `principle-tree-ledger-adapter.ts:77-96` 中按 `derivedFromPainIds.includes(candidateId)` 匹配），回答的是「这个候选写过了吗」，**不是**「已有原则里有类似的吗」。

因此实际路径是：

```
Pain
 └─(无检索)
    └─ LLM 生成新 Principle
```

而不是任务书假设的：

```
Pain → 已有 Principle 检索 → 覆盖判断 → reuse / extend / create
```

**判定：无检索分支。系统从未询问过「是否已有覆盖」。**

### 阶段 B — 晋升（`candidate → active`）

`evolution-reducer.ts:167` 定义 `candidate → probation → active` 的两级跃迁。当前 113 条停在 `candidate`，9 条到达 `active`——**晋升率 7.4%**。

值得注意的是 `evolution_worker: enabled: false`（`config.yaml:42-44`）。这意味着**批量自动晋升目前是关闭的**，9 条 active 是通过别的路径（人工/CLI）产生的。

### 阶段 C — 激活与注入

注入选择器 `prompt-builder/principle-selection.ts:116` 的算法：

```
1. Sort all principles by priority (P0 > P1 > P2), then by recency
2. Iterate, accumulate character count
3. Stop when adding would exceed budgetChars
4. Force-include at least one P0
```

`DEFAULT_PRINCIPLE_BUDGET = 4000` 字符（`principle-selection.ts:202`）。

**两处关键的演化压力来源**：

1. **排序键是 recency（newer first）而非 usage**（`principle-selection.ts:75`）。新原则天然挤掉旧原则。由于 `priority` 恒为 `P1`、`lastTriggeredAt` 全缺，**「新近度」实际上是唯一的排序变量**。
2. 该选择器**只做预算截断，不做语义选择**。预算耗尽即静默丢弃，而非「选最相关的 N 条」。

生产实测注入宽度（`principle_applications`，`kind='prompt_injected'`）：

| session_id | 注入条目数 | distinct principles |
|---|---|---|
| bcd13cd3-… | 16 | 16 |
| 8e64912c-… | 16 | 16 |
| 34a98742-… | 16 | 16 |
| 974cb8b3-… | 15 | 15 |
| 7ecae8e5-… | 15 | 15 |
| 79f5ffe4-… | 12 | 12 |

累计 1150 条 presence 级记录，覆盖 **19 个 distinct principle_id**。单条最长寿者 `Model-Evidence-Reversibility-V` 被注入 **610 次**。

### 阶段 D — 淘汰（Eviction）

设计意图（`docs/adr/0013:23` 原话）：

> L1 容量只能依靠 LRU + cap = 12（PRI-139）兜底——无效但被频繁触发的原则会一直占住 cap。

代码实体（`l1-hard-cap.ts`）：

```ts
export const DEFAULT_L1_HARD_CAP = 12;
export const MAX_L1_HARD_CAP = 12;
export function enforceL1HardCap(candidates, config): L1EvictionResult
```

**调用方盘点（全仓 `packages/**`，含测试）：**

- `runtime-v2/index.ts:705` — barrel 导出
- `runtime-v2/__tests__/l1-hard-cap.test.ts` — 单测
- `runtime-v2/__tests__/architecture-regression.test.ts:2897` — 导出存在性断言

**生产调用方：0 个。**

`pruning-read-model.ts` 只消费常量用于**上报**（`l1Cap: this.l1Cap`，`activeL1Count: byStatus.active`），**不消费 `enforceL1HardCap`**。

当前 active = 9，cap = 12。**容量闸门在尚未触顶时即为空转状态**，而 113 条候选正在后面排队。

### 阶段 E — 剪枝信号（Pruning Signals）

`pruning-read-model.ts:88-100` 的风险判定：

```ts
function computeRiskLevel(ageDays, derivedPainCount, opts) {
  if (ageDays >= opts.reviewThresholdDays && derivedPainCount === 0) return 'review';
  if (ageDays >= opts.watchThresholdDays && derivedPainCount === 0) return 'watch';
  return 'none';
}
```

两个条件都要求 **`derivedPainCount === 0`**。而 122/122 条原则的 `derivedFromPainIds` 长度恒为 1。

**推论：`getHealthSummary()` 的 `watchCount` 与 `reviewCount` 在当前系统的任何状态下都恒为 0。** 剪枝读模型存在、已接入 CLI（`pd-cli/src/commands/runtime-pruning.ts`，注册为 `runtime pruning` 子命令且 **`hidden: true`**，`index.ts:937`）与控制台健康检查（`pd-console/src/server/models/HealthCheckModel.ts:400`），但它对现有原则集**永远沉默**。

### 阶段 F — 弃用（Deprecation）

`deprecated-readiness.ts` 的权重契约依赖 `PrincipleLifecycleEvidence.rules` 提供的 `averageRuleCoverage` / `averageFalsePositiveRate` / `repeatedErrorReductionScore`（`lifecycle-metrics.ts`）。122/122 条原则 `ruleIds` 为空 ⇒ `principle.rules.length === 0`。

对照 `routing-policy.ts:169-179`，其第一条分支即：

```ts
if (principle.rules.length === 0) {
  reasonCodes.push('insufficient_data', 'no_material_rules');
  return { route: 'defer', confidence: 50, ... };
}
```

**推论：全部 122 条原则在生命周期路由上落入 `defer / insufficient_data / no_material_rules`。整条生命周期管理能力（弃用就绪度、路由推荐、效果指标）在数据上从未被激活过。**

### 生命周期总览

```
Pain ──1:1──> Principle(candidate) ──7.4%──> Principle(active) ──┐
                    ▲ 122 条            ▲ 9 条                   │ 注入（预算 4000 字符，
                    │ 无检索            │ 无淘汰闸门             │  按 recency 排序）
                    │ 无合并            │ watch/review 恒空      ▼
                    │ 无冲突            │ 弃用评估不受理       Agent 上下文
                    └───────────────────┴─────────────────────────────┘
                                        无回流：效果信号（1 条 rule_blocked）不足以触发任何回收
```

---

# Existing Dedup Capability

任务书要求按 semantic / behavior / outcome 三层检查。三层的结论如下。

## 4.1 Semantic Dedup — **不存在**

全仓检索（`packages/**/src`，排除 `dist/`）针对 `similar|similarity|embedding|duplicate|dedup|cluster|consolidat|reuse` 的命中全部落在**非原则域**：DB 错误处理、feature flag 注册、schema conformance、artifact 去重等。**principle 域内不存在任何文本相似度计算。**

### 唯一近似物：`read_principles` 工具（存在但没有接入）

`agent-tool-contract.ts:132-167` 注册了一个 Dreamer L2 工具，其 description 原文即声明了去重意图：

> `'Read the core axioms (T-01..T-10) plus already-internalized active principles. Call this BEFORE proposing candidates so your output is grounded in the existing principle hierarchy and does not duplicate or contradict it.'`

但它有三重限制：

1. **开关关闭**：`l2-agent-loop-adapter.ts:457` 挂载该工具集，而挂载分支受 `l2_dreamer` 门控；生产配置 `config.yaml:69-71` 为 `enabled: false`。
2. **只读 active**：`build-l2-principle-reader.ts:40-51` 过滤 `p.status !== 'active'`。存量 122 条中 **113 条不可见**。
3. **不阻断**：即便调用，输出仅为文本提示；prompt 层的对应约束是「note this in the risks array」（`philosopher-prompt-builder.ts:113`），是建议而非门禁。

**实际调用痕迹为零**：`SELECT COUNT(*) FROM runs WHERE input_payload LIKE '%read_principles%' OR output_payload LIKE '%read_principles%'` → **0**；`artifacts.content_json LIKE '%read_principles%'` → **0**。

`l2_dreamer` 门控下的 L2 运行时实测（`runtime_kind='pi-ai-l2'`）：**350 次运行，334 次失败，16 次成功**。且**全部 350 次都是 `artificer` 任务**，失败原因 217 + 117 条统一为：

> `behavior_example_pack_missing: v2-only Artificer generation requires a BehaviorExamplePack`

即：**L2 agent loop 在生产中从未承载过 Dreamer 任务，因此承载去重能力的工具从未有过被执行的机会。**

### 名字相似但作用域完全不同：`semantic-selector.ts`

`owner-decision/semantic-selector.ts` 名字含 `selector`，但它是 **Owner UI 的展示文本选择器**：从**同一条原则**的多个来源字段（scribe / distiller / philosopher / candidate）中挑一个人可读的整字段，供治理台展示。`selectLearnedPrincipleV0()` 的输入是单条原则的候选文本，**不跨原则比较**。它不构成 Principle Resolver，不应被误认为已有能力。

## 4.2 Behavior Dedup — **不存在**

问题：两个文字不同的原则（「不要猜测」/「行动前验证事实」）是否可能生成相同 RuleCode？

**RuleCode（rule 制品）的绑定关系**（`principle-schema.ts:84-102`）：

```ts
export interface Rule {
  id: string;              // 'rule-<rulehost|evaluator>-<hash>'
  name: string;
  type: RuleType;          // hook | gate | skill | test | prompt
  triggerCondition: string;
  enforcement: 'block' | 'warn' | 'log';
  action: string;
  principleId: string;     // ← 单值绑定
  parentRuleId?: string;
  status: RuleStatus;
  coverageRate: number;
  falsePositiveRate: number;
  implementationPath?: string;
  testPath?: string;
}
```

回答三个子问题：

1. **是否绑定唯一 Principle？** 是。`Rule.principleId: string` 为**单值**。`pi_artifacts.source_principle_id` 同样单值。
2. **是否允许多个 Principle 生成相同规则？** **结构上允许，且无法被发现。** rule 的 id 形如 `rule-rulehost-pain_host_<sha256>-evaluator-r1-<suffix>`，其 hash 来自 pain/task 上下文，**不含 principle 身份，也不含行为指纹**。行为等价的规则会得到两个不同的 `rule.id`，且没有任何字段能把它们关联起来。`rule-code-validator.ts` 全文只做**安全**检查（`require` / `import` / `eval` / `process` 等 30 条 forbidden pattern），**零**去重逻辑。
3. **是否存在 `principle -> behavior fingerprint`？** **不存在。** 仓库唯一的 fingerprint 实现是 `runtime-v2/feedback/fingerprint.ts:47`：

```ts
fingerprint = sha256hex(`${type}|${area ?? 'general'}|${normalizedTitle}`)
```

这是 **feedback report** 的去重指纹（`FEEDBACK_FINGERPRINT_TITLE_LIMIT = 80`），与 principle/rule 无任何数据通路。**这是「思想存在、作用域错位」的典型案例——底料有，未接到原则域。**

**生产交叉验证（`pi_artifacts` 中 `artifact_kind='rule'` 的 4 条）：**

| `source_principle_id` | 形态 | 说明 |
|---|---|---|
| `基线锚定与可观察验收：以确认基线为参照，改动须对比验收且不可劣化` | **原则正文文本** | 外键指向文本而非 id |
| `基线锚定与不可劣化护栏：迭代须以可对比证据验收` | **原则正文文本** | 同上 |
| `2d23707d-11a3-4484-a35d-124e19904eac` | **UUID** | 同一字段的另一种形态 |
| `Dependency completeness before downstream synthesis` | **英文标题** | 第三种形态 |

**同一外键字段出现三种取值形态（正文 / UUID / 标题）⇒ 该字段不可用于任何关联查询。** 这本身即是「行为去重不可实现」的直接证据：即便存在行为指纹，当前也无法把 rule 稳定地归因到 principle。

## 4.3 Outcome Dedup — **不存在（且当前不可能实现）**

所需指标与在位情况：

| 指标 | 承载处 | 实测 |
|---|---|---|
| `correction count` | 无字段 | — |
| `success rate` | `PrincipleValueMetrics.benefitScore` | **23 条 metrics 记录全为 0** |
| `violation frequency` | `LegacyPrincipleTrainingState.observedViolationCount` | ledger 中 0 条 |
| `adherence` | `Principle.adherenceRate` | **122/122 恒为 0** |
| 效果级遥测 | `principle_applications.level='effect'` | **仅 93 条**：92 `self_reported` + **1 `rule_blocked`** |
| 存在级遥测 | `principle_applications.level='presence'` | 1150 条 `prompt_injected` |

`principle_applications` schema（`state.db`）本身是完整的：

```sql
CREATE TABLE principle_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principle_id TEXT NOT NULL,
  activation_id TEXT, rule_id TEXT,
  channel TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('effect','presence')),
  kind TEXT NOT NULL CHECK (kind IN ('rule_blocked','auto_correct_applied','self_reported','prompt_injected')),
  session_id TEXT, tool_name TEXT, file_path TEXT, digest TEXT, created_at TEXT NOT NULL
)
```

**结论：遥测表结构足够，但 effect 级数据只有 93 条、其中 1 条为机械可验证的 `rule_blocked`。**

`rule_id` 非空行数 = **1**（全表 1243 行）。`activation_id` 非空 = 1150。

**推论：判断「两个原则的实际效果是否重复」在当前数据下完全不可行。** 且这不是采样问题——`rule_id` 近乎全空，是因为 0 条原则绑定了规则。

---

# Data Evidence

## 6.1 Principle 数量与增长趋势

**Ledger 总量：122 条**（`_tree.principles`）。增长按天：

| 日期 | 新增 |
|---|---|
| 2026-09-01 | 7 |
| 2026-09-03 | 10 |
| 2026-09-04 | 4 |
| 2026-09-05 | 6 |
| 2026-09-09 | 2 |
| 2026-09-13 | 5 |
| 2026-09-14 | 2 |
| 2026-09-15 | 6 |
| 2026-09-17 | 8 |
| 2026-09-18 | 2 |
| 2026-09-19 | 9 |
| 2026-09-20 | 8 |
| **2026-09-21** | **25** |
| **2026-09-22** | **28** |

**22 天 122 条；最后两天 53 条，占全量的 43%。** 增长率本身在加速，且曲线与「internalization 全链自动化（`internalization_full_chain: enabled: true`，`config.yaml:30-32`）」的开启时间吻合。

## 6.2 来源与链路完整性

- **distinct painId 引用数：122**；principles：122 ⇒ **映射严格 1:1**
- **pain 多重性分布：`{"1": 122}`** ⇒ 无一个 pain 产生 >1 条原则
- **orphan 检查**：122 个 `derivedFromPainIds` 全部能在 `principle_candidates` 中找到对应行 ⇒ **orphan = 0**（链路引用完整）
- **`pi_artifacts` 按 agent 分布**：`principle` 917 条中，diagnostician 163 / scribe 140 / artificer 118 / evaluator 112 / dreamer 108 / philosopher 108 / rollout_reviewer 76
- **各 agent 的 formation 数**：dreamer 108 / philosopher 108 / scribe 140 / rollout_reviewer 76 ⇒ **对照 122 条 ledger 原则，pipeline 端到端基本无丢弃**

## 6.3 Principle : RuleCode 比例

| 层 | 数量 | 证据 |
|---|---|---|
| Ledger principles | 122 | `_tree.principles` |
| Ledger rules | **0** | `_tree.rules` |
| Ledger implementations | **0** | `_tree.implementations` |
| `pi_artifacts` kind=`principle` | 917 | state.db |
| `pi_artifacts` kind=`rule` | **4** | state.db |
| `activations` 总数 | 20 | 18 `prompt` + 2 `code_tool_hook` |
| `activations` 当前未停用 | 11 | `deactivated_at IS NULL` 的 prompt 激活 |
| `activations` code 通道 | **2**（均已停用） | `code_tool_hook_live_activate` / `_shadow_activate`，`deactivated_at` 均非空 |
| `approvals` | 42（30 pending / 10 approved / 2 rejected） | state.db |

**122 条原则 → 4 条规则制品 → 2 次 code 通道激活（且均已下线）。**

## 6.4 Pain → Principle → RuleCode 链路抽样（20 条，取最近创建）

| # | createdAt | painId | principleId | status | 源候选 kind | rulecode | 主题簇 |
|---|---|---|---|---|---|---|---|
| 1 | 2026-09-22 | b9cc7bf5 | 6522447f | active | principle | none | 证据优先/完成声明 |
| 2 | 2026-09-22 | 34ccb72b | 858bdd31 | candidate | **implementation** | none | 状态持久化/时效 |
| 3 | 2026-09-22 | 9c902446 | cf422443 | active | principle | none | 证据优先/完成声明 |
| 4 | 2026-09-22 | 71cb5a36 | 4c7dab25 | candidate | **prompt** | none | （未归类） |
| 5 | 2026-09-22 | c63a5d54 | ea9b5bc9 | candidate | **rule** | none | 输出校验/门禁 |
| 6 | 2026-09-22 | 22e820d7 | bb0a4303 | active | principle | none | 输出校验/门禁 |
| 7 | 2026-09-22 | eb693015 | e618e858 | candidate | **implementation** | none | （未归类） |
| 8 | 2026-09-22 | 9d5e2a25 | 7b5bb4e2 | active | principle | none | 状态持久化/时效 |
| 9 | 2026-09-22 | 097ffa39 | 6fbc11b8 | candidate | **rule** | none | （未归类） |
| 10 | 2026-09-22 | e68d1118 | aa04cd12 | candidate | **implementation** | none | （未归类） |
| 11 | 2026-09-22 | 57d43479 | 52a5a168 | active | principle | none | 状态持久化/时效 |
| 12 | 2026-09-22 | a6eac720 | 99b60115 | candidate | principle | none | 证据优先/完成声明 |
| 13 | 2026-09-22 | fed0787f | 0521e029 | candidate | **prompt** | none | （未归类） |
| 14 | 2026-09-22 | e87308c8 | 0969cc05 | candidate | principle | none | 受众视角/可理解性 |
| 15 | 2026-09-22 | be80504b | 30502685 | candidate | **prompt** | none | （未归类） |
| 16 | 2026-09-22 | 386fbbf5 | ef83f362 | candidate | principle | none | （未归类） |
| 17 | 2026-09-22 | f0a3c0d8 | 4c497878 | candidate | **prompt** | none | 源文件哈希/mtime |
| 18 | 2026-09-22 | d9046dae | b504beff | candidate | **rule** | none | 证据优先/完成声明 |
| 19 | 2026-09-22 | a7b6a4a6 | 891bc0a0 | candidate | **implementation** | none | （未归类） |
| 20 | 2026-09-22 | 21bc6e76 | dbb16755 | candidate | principle | none | （未归类） |

### 分类结论（A 真正新知识 / B 扩展 / C 重复 / D RuleCode 重复）

先给出方法论警告：**中文原则之间的表层词法相似度极低**。对 122 条原则做字符 trigram Jaccard，**最高的一对仅 0.212**（`5292e588` vs `778f40d9`，两条都是 PowerShell 编码问题）。这意味着：

> **纯词法去重在本数据集上会失效。** 语义重复以「同问题不同措辞」形式存在，必须依赖语义表征或 LLM 判定。

按连通分量聚类（字符 bigram Jaccard 阈值）：

| 阈值 | 边数 | 规模>1 的簇 | 可合并冗余条数 |
|---|---|---|---|
| ≥ 0.20 | 8 | 5 | **7** |
| ≥ 0.15 | 26 | 17 | **23** |
| ≥ 0.10 | 89 | 16 | **69**（含一个 46 条链式大簇） |

同一簇内的真实样本（阈值 ≥0.20）：

```
[4] PowerShell/编码契约
    be22fffd  在 PowerShell 脚本落地前，检查目标解释器版本并拦截编码不匹配的情况。
    ba41069b  在工具层为脚本执行增加编码/环境预检：当检测到脚本包含非 ASCII 字符且目标解释器可能为 Windows PowerShell 5.1 时…
    5292e588  在 Agent 系统提示或工作流指令中加入：『在 Windows 上创建或执行含非 ASCII 字符的脚本前，必须先确认目标解释器版本与编码契约…
    778f40d9  当 Agent 准备创建或执行 PowerShell 脚本（尤其是 Windows 平台且脚本含非 ASCII 字符）时，强制先确认目标解释器版本与编码契约…

[4] 源文件哈希/mtime 校验
    3824d083  将'源文件为准'确立为不可绕过的通用原则：任何跨会话/跨状态合并、同步或巡检动作，都必须以可观察的源对象（mtime+内容哈希）…
    badd3df5  实现一个自动化的源文件内容一致性校验工具，在每次心跳巡检或跨会话合并时自动比对源文件 mtime 与内容哈希…
    2785f12c  为跨会话状态合并与心跳巡检增加强制校验门：合并前必须核对源文件 mtime+内容哈希…
    24326b7a  在巡检与合并相关提示词中明确加入强制指令：不得依据先前会话记忆判断状态是否有变化，必须核对源文件 mtime+内容实际状态后…

[3] 机制链路验证
    0ef41732  在诊断提示词/流程指令中，明确要求诊断者遵循 T-03 证据优先原则：在断言根因或宣称结果前必须先以可观察事件日志验证机制链路…
    5612a49a  将'先验证机制链路，再断言根因'固化为通用原则…
    9f0a1834  建立强制机制链路验证门控：诊断流程在基于统计启发式形成根因结论前…
```

**分类判定：**

| 类别 | 判定 | 依据 |
|---|---|---|
| **A. 真正新知识** | **少数**。保守阈值（≥0.15）下 122 条中 17 个簇覆盖既有重复，余下约 **99 条**表面上互不相同 | 但「互不相同」不等于「互不重叠」——见 B |
| **B. 已有原则扩展** | **大量且为主体**。主题簇统计：证据优先/完成声明 **35**、状态持久化/时效 **11**、PowerShell 编码 **8**、输出校验/门禁 **6**、受众可读性 **5**、源文件哈希 **5**、意图确认 **3**、交付形态 **2**、全局引用 **2**、基线锚定 **2**、未归类 **43** | 前 4 个簇合计 **60/122 = 49%** |
| **C. 已有原则重复** | **确有**。保守阈值下 **23 条可合并**（122 → 99）；放宽到 ≥0.10 则 **69 条可合并**（122 → 53）。典型：PowerShell 编码 4 条、源文件 mtime 4 条、机制链路验证 3 条 | 且注：`基线锚定` 两条 **active** 原则（`985c092e` / `2d23707d`）语义高度重叠，说明重复已越过晋升闸门 |
| **D. RuleCode 重复** | **当前样本不足以判定**，但 **结构上无法判定** | 仅 4 条 rule 制品，且其 `source_principle_id` 取值形态不一致（文本/UUID/标题），无行为指纹字段 |

**额外发现：类型污染。** 20 条抽样中有 **9 条（45%）** 的源候选 `recommendation_kind` 不是 `principle`（`rule` ×3、`prompt` ×4、`implementation` ×2）。全量统计：

| 源候选 recommendation_kind | ledger 中的条数 | 占比 |
|---|---|---|
| `principle` | 49 | 40.2% |
| **`rule`** | **40** | **32.8%** |
| **`prompt`** | **17** | **13.9%** |
| **`implementation`** | **16** | **13.1%** |

**59.8% 的 ledger「原则」来自自身类型声明并非 principle 的候选。** 根因：`admission-gate.ts:138-175` 的 CLI 侧准入只过滤 `defer` 与 `confidence`，**不按 `recommendationKind` 区分下游通道**；`candidate-intake-service.ts` 亦无 kind 分支，所有非 defer 候选统一经 `writeProbationEntry()` 落入原则树。

---

# Root Cause

任务书给出的 A/B/C/D 四个候选，逐一判定。

## 判定：**B 为主因，C 为并存的结构性缺陷，A 为贡献因素，D 为潜伏因素**

### B —— 缺少检索能力：**成立，且是首要原因**

**但必须精确表述**：这不是「实现遗漏了一个查询」，而是**契约层面排除了检索存在的可能**。四条独立证据：

1. **契约无位置**。`LedgerPrincipleEntry`（`candidate-intake.ts:131-143`）11 个字段中没有任何字段能表达「与已有原则的关系」。
2. **流程无步骤**。`candidate-intake-service.ts:1-18` 的 6 步自述流程中，唯一查询是 `existsForCandidate`（自我幂等），无覆盖判断。
3. **落盘无关系**。`principle-tree-ledger-adapter.ts:23-47` 硬编码 `ruleIds: []` / `conflictsWithPrincipleIds: []` / `derivedFromPainIds: [candidateId]`。
4. **能力空转**。唯一的检索通道（`read_principles`）被 `l2_dreamer: enabled: false` 关闭，且其承载运行时（`pi-ai-l2`）在生产中 **95.4% 失败**（334/350）、且只跑过 `artificer`。

叠加第 5 条数据证据：**0 次 `read_principles` 调用痕迹**存在于 1612 条 runs 与 921 条 pi_artifacts 中。

**因此「PD 是否已有 Pain → 已有 Principle 检索」的答案，在语义上是「存在一个未接通的接口」，在工程上等价于「不存在」。** 若必须在任务书要求的二选一中断言：

> **Current State: No Principle Resolver exists.**

（`read_principles` 是 L2 agent 的一个可选只读工具，不是 resolver：它不参与准入决策、不产生 reuse/create 判定、不在 intake 路径上。）

### C —— 缺少生命周期管理：**成立，且严重程度高于预期**

三条本应发挥作用的回收机制，**全部处于「存在但结构上永不触发」状态**：

| 机制 | 存在性 | 未生效的原因 |
|---|---|---|
| L1 硬上限 12 | 代码存在（`l1-hard-cap.ts:44`），有单测 | **无生产调用方**；剪枝读模型只上报不执行 |
| LRU 淘汰信号 | 算法存在（按 `lastTriggeredAt` 排序） | **`lastTriggeredAt` 在 122/122 条原则中缺失**，无写入方 |
| 剪枝风险标记 | 读模型存在且已接入 CLI + Console | **`derivedPainCount === 0` 前置条件**与 `derivedFromPainIds` 恒长度 1 直接冲突 ⇒ watch/review 恒为 0 |
| 弃用就绪度 | 逻辑存在（`deprecated-readiness.ts`） | 依赖 `rules` 指标；122/122 无规则 ⇒ 恒 `not-ready` / `insufficient_data` |
| 注入排序 | 存在且生效 | 但排序键是 **recency（newer first）**，与「保留有效原则」目标方向相反；`priority` 恒 `P1` 使主键失效 |

**换一种说法：PD 建好了「淘汰机器」，但既没有给机器通电（无调用方），也没有提供燃料（`lastTriggeredAt` 缺失），还设了一个永远为假的前置条件（`derivedPainCount === 0`）。**

### A —— 模型生成质量：**成立但不是主因，且方向与假设相反**

任务书猜测「Philosopher 太喜欢创造新原则」。代码证据显示**模型没有选择权**：

- `philosopher-prompt-builder.ts:80-114` 的协议要求产出「a single philosophical thesis」+「a principle candidate」，**输出契约就是一条新原则**，无 reuse/extend 分支。
- 唯一的去重指令是 `philosopher-prompt-builder.ts:113` 与 `scribe-prompt-builder.ts:171`：检查是否与 **core axiom（T-01..T-10）** 重复，且处置方式是「note this in the risks array」——**建议性，非阻断性**。
- `internalization_core_grounding` 已退役为无条件行为，因此模型**确实**看得到 10 条 core axiom，但**完全看不到那 122 条累积原则**。

**所以 A 的准确表述是：模型在「只被告知 10 条公理、完全不知 122 条存量」的信息条件下，忠实地为每次 pain 生成了 1 条新原则。** 这不是生成质量问题，而是**信息供给问题**——即 B。

### D —— RuleCode 抽象层不足：**当前不是瓶颈，但是既定的下一道墙**

- 反驳「D 是主因」：只有 4 条 rule 制品，规则层远未饱和。瓶颈在上游（原则创建）。
- 支持「D 是潜伏风险」：`Rule.principleId` 为单值、rule id 不含行为指纹（`rule-code-validator.ts` 零去重逻辑）、`pi_artifacts.source_principle_id` 取值形态不一致（文本/UUID/标题三种）⇒ **一旦规则层开始规模化，「一码多源」将在结构上不可发现、不可合并**：

```
Principle A ─┐
             ├─→ 行为等价的 RuleCode（两个不同 rule.id，无指纹关联）
Principle B ─┘
```

**是否可能发生？—— 是，schema 允许；且当前无任何机制能检测到。**

## 根因链（汇总）

```
[契约层] LedgerPrincipleEntry 无关系字段 + adapter 硬编码 conflicts/ruleIds 为空
   ↓
[流程层] intake 6 步无检索步骤；唯一查询是自我幂等
   ↓
[能力层] read_principles 被 l2_dreamer=false 关闭，且只读 active（113/122 不可见）
   ↓
[回收层] cap 无调用方 / lastTriggeredAt 无写入 / pruning 前置条件恒假 / 弃用评估无规则可依
   ↓
[观测结果] 1:1 Pain→Principle × 122；RuleCode 4 条；冲突 0 条；合并 0 次；弃用 0 次
```

**一句话根因：PD 把「原则演化」实现成了「原则累积」。演化所需的三个动作——检索、合并、淘汰——在契约、流程、能力三个层面同时缺席。**

---

# Recommended Evolution Path

遵循 `AGENTS.md` §P2.1 的 **Connection Before Creation** 与 §P7 的 No Speculative Abstraction：以下全部为**增量演化**，不新增子系统，优先接通既有能力。

## Phase 0 — 只读观察（0 代码变更风险，先补指标）

目的：在动任何开关前，先让「原则是否需要复用」变成可测量的事实。

| # | 指标 | 承载方式 | 为什么必须在前置 |
|---|---|---|---|
| 0.1 | **准入决策分布** | 新增 `principle_admission` 事件（`decision: create / reuse / extend / defer`）落地到 `pd-data-audit/metrics/` 或现有 telemetry 通道 | 这是 Phase 1 的唯一成功判据 |
| 0.2 | **新原则的 top-1 相似度** | 离线脚本：对每条新原则计算与「创建时间更早的全部原则」的最大 trigram-Jaccard，记录分布 | Phase 1 的阈值必须由本分布决定，而非拍脑袋。注意当前观测上限仅 0.212 |
| 0.3 | **L1 占用与 cap 命中** | 已有 `PruningReadModel.getHealthSummary()` 的 `activeL1Count` / `l1Cap` | 当前 9/12，需要知道何时触顶 |
| 0.4 | **`lastTriggeredAt` 覆盖率** | 直接统计 ledger 字段在位率（当前 0/122） | 淘汰算法的燃料缺口必须量化 |
| 0.5 | **注入宽度与预算消耗** | 从 `principle_applications`（`kind='prompt_injected'`，已含 `session_id`）派生每次会话的注入条数与字符数 | 已有数据可支撑，无需新埋点。当前观测峰值 16 条/会话 |
| 0.6 | **effect 级信号覆盖率** | 统计 `level='effect'` 条数占比（当前 93/1243 = 7.5%，其中机械可验证者 1 条） | 这决定 Outcome Dedup 何时才可能立项 |
| 0.7 | **类型污染率** | ledger entry 按源候选 `recommendation_kind` 分组（当前 59.8% 非 principle） | 不先修污染，任何去重都在脏面上作业 |
| 0.8 | **剪枝信号恒空告警** | 显式断言 `watchCount + reviewCount` 是否长期为 0；若是则说明前置条件失配 | 防止「能力存在但沉默」再次被误读为「无风险」 |

**Phase 0 的验收**：能回答「过去 30 天新增的原则中，有多少条与既有原则的相似度超过阈值」。当前无法回答，这本身就是最该先修的事。

## Phase 1 — 最小闭环（接通既有能力，不造新系统）

目标形态：

```
Pain
 └─→ Existing Principle Search          ← 复用 buildL2PrincipleReader（放宽过滤）
      └─→ reuse / extend / create 三态判定   ← 新增 admission 步骤（不是新子系统）
           ├─ reuse   : 不写新原则，挂接 pain 到既有原则（derivedFromPainIds 追加）
           ├─ extend  : 写新原则 + 建立 supersedes/related 关系
           └─ create  : 现状路径
```

按性价比排序的实施建议：

**1. 先修类型污染（最低成本，最高杠杆）**
在 `admission-gate.ts` 的 kind 维度上区分下游通道：非 `principle` 候选不应无差别落入原则树。或在 ledger 侧保留 kind 标记以便过滤。**当前 59.8% 的存量「原则」根本不是原则** —— 这一步不依赖任何模型能力。

**2. 打开或绕过 `read_principles`（关键路径）**
- 优先方案：`l2_dreamer: enabled: true`。但需先解决 `pi-ai-l2` 的 `behavior_example_pack_missing` 失败（334/350）——**该开关打开前必须先在 L2 上跑通 dreamer 任务**。
- 降级方案（风险更低）：**把 active+candidate 原则列表作为固定段内联进 Dreamer/Philosopher 的 system prompt**，绕过 L2 依赖。代价是 prompt 长度，收益是不依赖未通路的运行时。
- 两项都必须同步放宽 `build-l2-principle-reader.ts:44` 的 `status === 'active'` 过滤——否则 **113/122 条原则对生成器始终不可见**。建议改为返回 `active` + `candidate` 并标注状态。

**3. 在 intake 前插入三态判定（最小闭环的核心）**
在 `candidate-intake-service.ts` 的 6 步流程中，于第 5 步之前插入第 4.5 步 `resolveExistingPrinciple()`：
- **短路层（确定性，零成本）**：复用 `feedback/fingerprint.ts` 的纯哈希思路，对归一化后的 `triggerPattern + action` 求 hash，命中即 `reuse`。这能捕获完全同构的重复。
- **语义层（必须引入）**：Phase 0.2 已证明词法上限仅 0.212，**纯词法不足以支撑语义去重**。建议先用已有 `pi-ai` 运行时做一次 LLM 判定（输入：新候选 + top-K 既有原则），而非直接上 embedding 基建（后者违反 P7）。
- **输出落库**：`ruleIds` 同级的 `relatedPrincipleIds` / `supersedesPrincipleId`。**`supersedesPrincipleId` 字段在 `principle-schema.ts:48` 已存在，只缺写入方** —— 这是 Connection Before Creation 的教科书案例。

**4. 补齐 `lastTriggeredAt` 的写入方**
数据源已存在：`principle_applications` 表按 `principle_id` + `created_at` 记录了每次注入。派生一个「最近触发时间」的只读投影即可填上 `lastTriggeredAt`，让 `enforceL1HardCap` 的排序键第一次拥有数据。

**5. 接通 cap**
在 active 晋升路径上调用 `enforceL1HardCap`（现成函数，现成单测）。注意：**当前 9/12 尚未触顶，此步不是当务之急**，但必须在 Phase 1 结束前接通，否则 Phase 2 的合并成果无处收纳。

**Phase 1 的验收判据**：`principle_admission` 事件中 `reuse + extend` 占比 > 0，且新增原则速率相对 Phase 0 基线下降。

## Phase 2 — 高级能力（仅在 Phase 1 数据支撑后立项）

| 能力 | 前置条件 | 设计要点 |
|---|---|---|
| **Consolidation（合并存量）** | Phase 0.2 的相似度分布 + 人工确认的阈值 | 保守起点为 trigram-Jaccard ≥ 0.15 的 **17 个簇 / 23 条冗余**（→ 122 降至 99）。**不要用 ≥0.10**：该阈值下出现一个 46 条成员的链式大簇，transitive chaining 会误伤无关原则 |
| **Composite Principle（组合）** | 规则层规模化 + 行为指纹 | 必须先引入 `principle → behavior fingerprint`，否则「多原则共享一码」不可发现。可参考 `feedback/fingerprint.ts:47` 的三元组哈希形态（`type\|area\|normalizedTitle`） |
| **Principle Lifecycle（正式生命周期）** | 弃用就绪度有规则可依 | `principle-lifecycle-event.ts` 的类型面已存在；`deprecated-readiness.ts` 逻辑已存在。**缺的只是 `rules` 指标的真实数据** |
| **规则冲突检测** | rule 数量进入两位数 | 需先规范化 `pi_artifacts.source_principle_id` 的取值形态（当前文本/UUID/标题三种混用），否则外键不可用 |
| **Outcome Dedup** | `level='effect'` 占比显著提升 | 当前 7.5%，机械可验证者 1 条。这是最远期的一项，不应提前投入 |

---

# Risks

## 实施风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | **打开 `l2_dreamer` 会改变生成分布** | 高 | 必须先修 `pi-ai-l2` 的 `behavior_example_pack_missing`（334/350 失败）。任何开关变更需 A/B；仓库已具备 harness：`npm run dev:evolution-evidence` / `dev:evolution-init`（`scripts/dev/pipeline-evolution/`） |
| R2 | **语义去重阈值误合并** | 高 | 阈值必须由 Phase 0.2 的经验分布决定。≥0.10 会产生 46 条链式大簇 —— 这是典型的 transitive chaining 陷阱。合并必须可逆（`supersedesPrincipleId` + 保留被合并原则的别名） |
| R3 | **一次性清理 122 条存量是不可逆的 Owner 决策** | 高 | Phase 0 只读；Phase 1 只影响新增；存量合并只在 Phase 2 且必须逐簇人工确认（`runtime pruning review` 子命令已提供人工决定日志 `appendPruningReview`，且已 **`hidden: true`**，需评估是否披露） |
| R4 | **引入 LLM 判定带来 token 成本与新不确定性** | 中 | 优先确定性短路（fingerprint）；LLM 仅处理短名单（top-K）。不要先建 embedding 基建（违反 `AGENTS.md` §P7） |
| R5 | **在污染面上作业** | 中 | 59.8% 的 ledger 条目源种类并非 principle。**必须先修类型过滤，再做任何去重**，否则会「合并」掉本不该存在于原则树的记录 |
| R6 | **P4 单一真相被破坏** | 中 | 相似度/准入决策只可作为**派生投影**（read model），不得成为第二写权威。`principle-tree-ledger.ts:7-14` 明确 ledger 为 SSOT 且已有跨进程锁——新增任何相似度缓存都必须遵守此边界 |
| R7 | **`pi_artifacts.source_principle_id` 外键形态不一致** | 中 | 三种取值形态（正文/UUID/标题）使该字段不可用于关联。任何依赖它的合并逻辑必须先做形态归一 |

## 观测风险（本次审计暴露的「沉默失效」模式）

**PD 存在一类特定缺陷：能力已实现、已导出、已有单测，但无生产调用方或无有效数据，因而在外观上「看起来已具备」。** 本次识别出 5 例：

1. `enforceL1HardCap` — 有函数、有单测、无调用方
2. `PruningReadModel` 风险信号 — 已接入 CLI + Console，但前置条件恒假
3. `deprecated-readiness` — 逻辑完整，但输入指标恒空
4. `read_principles` — 工具完整，被 flag 关闭且承载运行时 95% 失败
5. `lastTriggeredAt` / `Rule.principleId` 关联 / `conflictsWithPrincipleIds` — 字段存在，无写入方

**建议**：把「声明式能力 vs 生产调用方」的对照关系纳入既有门禁思路（参考 `npm run check:runtime-contract`、`npm run check:workspace-tools` 的形态）。**否则下一轮审计会再次把「存在但没有接入」误读为「已具备」。**

## 未决问题（本次审计未能确证，需 Owner 或后续调查）

1. **「122 条原则」是否为全量真实规模？** Ledger 为唯一 SSOT，但 `D:\.openclaw\workspace` 下另有 `.principles/PRINCIPLES.md`（2,437 B）、`.principles/THINKING_OS.md`、`.state/principles/`（**空目录**）等历史遗存。需确认是否还有其他写入面。
2. **9 条 active 原则的晋升路径。** `evolution_worker: enabled: false`，故批量自动晋升未启用。这 9 条的晋升由谁触发、经过何种 Owner 决策，需单独追溯。
3. **`principle_candidates`（138）与 ledger `derivedFromPainIds`（122）的 16 条差额**。已确认 orphan = 0（所有 122 个引用都能在 candidates 中找到），但反向的 16 条（candidates 中有而 ledger 中无）是 `pending` 未消费还是失败丢弃，未确认。
4. **`pi-ai-l2` 的 `behavior_example_pack_missing` 是否为设计意图。** 350 次运行全部为 artificer、334 次失败，症状高度一致，需区分「配置缺失」与「功能未完工」。
5. **`recommendation_kind` 混入原则树是设计还是缺陷。** `candidate-intake.ts:28` 的字段溯源表明确写 `status: Fixed: 'probation'`，但 adapter 实际写 `'candidate'`；契约与实现已存在偏移，需确认哪个是权威。
