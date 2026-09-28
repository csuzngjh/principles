# Principle Purification — Phase 0 Reality Audit + Implementation SPEC

> **状态**：Draft for Owner Review
> **类型**：Reality Audit + Implementation SPEC（Phase 0）
> **上游**：`docs/audit/principle-evolution-audit.md`
> **日期**：2026-09-23
> **约束遵守声明**：本 SPEC 起草期间**未修改任何源码**、**未创建 PR**、**未创建 Linear 工单**、**未执行任何 migration**、**未删除任何数据**、**未引入 embedding**、**未设计完整 Resolver**。所有生产数据读取均为只读副本 `D:/pd-probe-evo/state.db`（源 `.pd/state.db` 15,417,344 B）+ `<ws>/.state/principle_training_state.json`（124,868 B，lastUpdated 2026-09-22T16:04:09.594Z）。

---

# Problem

## P1 — Principle Ledger 被类型污染

`<ws>/.state/principle_training_state.json` 的 `_tree.principles` 共 **122 条**，其中 **59.8% 的来源候选并非 `principle` 类型**：

| 来源候选 `recommendation_kind` | ledger 条数 | 占比 |
|---|---|---|
| `principle` | 49 | 40.2% |
| `rule` | **40** | **32.8%** |
| `prompt` | **17** | **13.9%** |
| `implementation` | **16** | **13.1%** |
| 合计 | **122** | 100% |

即：Principle Tree 同时容纳了原则、规则、Prompt 指令、实现建议四类语义完全不同的东西。这不是「数据质量瑕疵」，而是**类型系统在存储边界上的失效**。

## P2 — 由此派生的四个下游故障

1. **去重无法可靠进行** —— 语义去重的前提是「被比较的对象同质」。把 `run npm test before commit`（规则）与 `Evidence Over Assumption`（原则）放进同一集合做相似度，得到的簇没有语义含义。
2. **生命周期指标失真** —— `PruningReadModel` 的 watch/review、`deprecated-readiness` 的就绪度、`routing-policy` 的 skill/code/defer 路由，全部按「原则」假设读取这批数据；其中相当比例根本不是原则。
3. **演化无法建立** —— 上游 `docs/audit/principle-evolution-audit.md` 已证明「1 Pain → 1 Principle」是既定契约。在污染未清除前，任何 Resolver 都是在脏面上作业。
4. **Owner 治理面失真** —— Console 的 `PrinciplesConsoleModel` / `ApprovalsGroupedConsoleModel` 直接 `loadLedger()`；Owner 看到的「原则列表」里有 73 条不是原则。

## P3 — 本 SPEC 的定位

**只解决「类型边界」这一件事。** 不实现 Resolver、不做去重、不做生命周期管理、不做存量合并。理由见 `Non Goals`。

---

# Current Architecture

## 2.1 两个存储面

| 面 | 位置 | 当前规模 | 权威性 |
|---|---|---|---|
| **Principle Tree Ledger** | `<ws>/.state/principle_training_state.json` → `_tree.principles` | **122 条目 / 0 rules / 0 implementations** | 唯一 SSOT（`principles-core/src/principle-tree-ledger.ts:1-14`，PRI-459 起含跨进程文件锁） |
| **PI Artifacts** | `<ws>/.pd/state.db` → `pi_artifacts` | 921 行（**917 `artifact_kind='principle'`** / **4 `artifact_kind='rule'`**） | 各 agent 产物日志 |

注意 `pi_artifacts.artifact_kind` 的枚举 `PI_ARTIFACT_KINDS` 只有 4 个取值 —— `principle` / `rule` / `skill` / `patch`（`peer-runner-contracts.ts:220-225`），**其中没有任何一个能表达 `prompt` 或 `implementation` 或 `defer` 语义**；且实测数据只出现过 `principle`(917) 与 `rule`(4) 两值（`skill` / `patch` 零使用）。内部化链路上的所有阶段产物（dreamer/philosopher/scribe/…）统一写 `artifact_kind='principle'`。**⇒ artifact 面既无法区分语义类型，也无法承载 prompt/implementation 类建议。**

`state.db` 无 `principles` 表；无独立 Rule / Prompt / Implementation 注册表（`store/` 目录仅含 artifact / candidate / commit / context / history / intent / lifecycle / pain / pain-diagnosis / run / task / trajectory）。

## 2.2 账本写入链路（通路 B）

```
CLI:      pd diagnose --intake          → diagnose.ts:562
          pd candidate intake           → candidate.ts:1100
          pd pain-retry (dead letter)   → pain-retry.ts:616
自动:      DiagRouterRunner.onDiagnosisComplete
                                     → pain-signal-bridge.ts:808

  ↓ 三条路径汇聚到同一个服务
CandidateIntakeService.intake(candidateId)          candidate-intake-service.ts:220
  ↓
LedgerAdapter.writeProbationEntry(entry)            candidate-intake.ts:291
  ↓
PrincipleTreeLedgerAdapter.writeProbationEntry()    principle-tree-ledger-adapter.ts:60
  ↓ expandToLedgerPrincipleStatic()                 principle-tree-ledger-adapter.ts:23-47
addPrincipleToLedger(stateDir, ledgerPrinciple)     principle-tree-ledger.ts:440
```

`CandidateIntakeService` 自述的 6 步流程（`candidate-intake-service.ts:1-18`）：

```
1. Validate input
2. Check idempotency (existsForCandidate)    ← 自我幂等，非类型判断
3. Load candidate from DB
4. Load artifact from DB and parse recommendation
5. Build 11-field LedgerPrincipleEntry
6. Write via adapter.writeProbationEntry()   ← 无条件写
```

**这 6 步中没有任何一步读取或判断 `recommendation_kind`。**

## 2.3 kind 路由链路（通路 A）——**已存在**

**任务书 Step 3 要求设计的 Admission Router，仓库中已经存在，且不止一份。**

**（a）纯函数路由决策** — `runtime-v2/internalization/internalization-route.ts`

```ts
const KIND_ROUTE_MAP = {
  principle:      'principle-ledger',
  rule:           'rule-candidate',
  implementation: 'implementation-candidate',
  prompt:         'prompt-injection-candidate',
  defer:          'deferred',
};
export function decideInternalizationRoute(recommendation): InternalizationRouteDecision
```

**（b）路由 → 通道映射 + MVP 通道白名单** — `runtime-v2/internalization/intake-to-internalization-bridge.ts`

```ts
export const CANDIDATE_KIND_TO_ROUTE = { principle:'principle-ledger', rule:'rule-candidate',
  implementation:'implementation-candidate', prompt:'prompt-injection-candidate', defer:'deferred' };

export const ROUTE_CHANNEL_MAP = {
  'principle-ledger':          'prompt',
  'rule-candidate':            'code_tool_hook',
  'implementation-candidate':  'skill',
  'prompt-injection-candidate':'prompt',
};

export const MVP_ENABLED_CHANNELS = new Set(['prompt','code_tool_hook','defer_archive']);
```

**（c）确定性 admission 规则** — `computeBridgeDecision()`（同文件 :129-188）：`defer` → 不可内部化；route 无通道映射 → 不可内部化；通道不在 MVP 白名单 → 不可内部化；`rule-candidate` 缺机械证据（`triggerPattern`+`action`）→ **降级到 prompt 通道**。

## 2.4 消费方清单（purification 的影响面）

`loadLedger(` 在生产代码中共 **44 处**（`packages/**` 排除 `dist/` 与测试），横跨 `principles-core` / `openclaw-plugin` / `pd-cli` / `pd-console` / `host-runtime`，关键几处：

| 消费方 | 位置 | 用途 |
|---|---|---|
| Console 原则列表 | `pd-console/src/server/models/PrinciplesConsoleModel.ts:292,304,389` | Owner 治理面 |
| Console 审批分组 | `pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts:188` | 审批面 |
| Console 生命周期 | `pd-console/src/server/models/ConsoleLifecycleDatasource.ts:40` | 生命周期展示 |
| 剪枝读模型 | `principles-core/src/runtime-v2/pruning-read-model.ts:175,297,358` | watch/review 信号 |
| L2 原则读取器 | `principles-core/src/runtime-v2/build-l2-principle-reader.ts:74` | Dreamer 上下文 |
| 生命周期服务 | `openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts:127` | 晋升/弃用 |
| promote/disable/archive/rollback | `openclaw-plugin/src/commands/*-impl.ts` | Owner 命令面 |
| 内化消费循环 | `host-runtime/src/internalization-consumer-cycle.ts:498` | 链路驱动 |
| 训练状态 | `openclaw-plugin/src/core/principle-training-state.ts:71,85,176` | 内化指标 |
| 反射/回放 | `openclaw-plugin/src/core/reflection/reflection-context.ts:27,42`、`replay-engine.ts:53` | 历史重放 |

**⇒ 任何对 ledger 条目语义的改动，必须在这 44 个读取面保持向后兼容。**

## 2.5 激活面与账本正交（重要的解耦事实）

Prompt 激活**不读 ledger**，而是 artifact 驱动：

```
host-runtime/src/active-principle-prompt.ts:69
  artifact = await artifactStore.getArtifactById(activation.artifactId)
  → resolvePrincipleFromArtifact(...)   prompt-activation-reader-contract.ts:48
```

`activations` 表自带 `artifact_id`。**⇒ 纯化 ledger 不会切断 prompt 激活通道**（激活锚点是 `pi_artifacts`，不是 ledger）。这是目标方案可行性的关键前提。

---

# Root Cause

## 3.1 决定性证据：写入与路由的**时序**

两条独立通路的调用顺序，在**同一段代码里相隔 5 行**：

**自动路径** — `pain-signal-bridge.ts:797-821`

```ts
if (this.autoIntakeEnabled) {
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const admission = admissionResults[i];
    if (!candidate || !admission) continue;

    if (admission.admission.decision !== 'admitted') {   // :803  门禁：只判证据充分度
      this.emitAdmissionEvent(candidate.candidateId, admission.admission);
      continue;
    }

    const intakeResult = await this.intakeService.intake(candidate.candidateId);  // :808  ← 无条件写账本
    ledgerEntryIds.push(intakeResult.id);
    ledgerEntryByCandidate.set(candidate.candidateId, intakeResult.id);

    try {
      const route = CANDIDATE_KIND_TO_ROUTE[candidate.recommendationKind ?? ''];  // :813  ← kind 路由在此，已晚于写入
      if (route) { ... buildDreamerSeedFromCandidate(...) ... }                   //      只决定是否 seed
```

方法名自述的意图顺序（同文件 `:755`）：`Handles admission → intake → seedDreamer after a successful diagnosis.`
—— **`intake` 在 `seedDreamer` 之前，是设计如此。但门禁 `:803` 从不看 `kind`。**

**CLI 路径** — `pd-cli/src/commands/diagnose.ts`

```ts
for (const candidate of candidates) {
  const admissionBlock = checkAdmissionGate(candidate);      // :547  只判 defer + confidence
  if (admissionBlock) { ...continue; }
  const entry = await intakeService.intake(candidate.candidateId);   // :562  ← 无条件写账本
  ...
}

// 账本全部写完之后，才开始 kind 感知的 seed 阶段
if (opts.intake !== false) {
  for (const candidate of candidates) {
    const kind = candidate.recommendationKind;
    if (kind === 'defer' || kind === 'implementation') continue;      // :602  ← kind 只影响 seeding
    ...
    const route = CANDIDATE_KIND_TO_ROUTE[kind ?? ''];               // :607
    const channel = ROUTE_CHANNEL_MAP[route];
    const ready = !!channel && MVP_ENABLED_CHANNELS.has(channel);
    const seed = buildDreamerSeedFromCandidate(candidate, { route, ready, ... });
```

**⇒ `diagnose.ts:602` 显式跳过 `implementation` 的 seeding，但 `:562` 早已把它写进账本。** 这 5 行的间距就是根因的形状。

## 3.2 四层数据闭环（互相独立、互相印证）

**① 类型分布**：122 条 = principle 49 + rule 40 + prompt 17 + implementation 16。

**② `implementation` 条目的链路证据为零**

| 来源 kind | ledger 条数 | 拥有**任一** `pi_artifacts` 产物 | 拥有 **scribe** 产物 |
|---|---|---|---|
| `principle` | 49 | **49/49** | **49/49** |
| `rule` | 40 | **40/40** | **40/40** |
| `prompt` | 17 | 17/17 | 17/17 |
| **`implementation`** | **16** | **0/16** | **0/16** |

`implementation` 候选 **18/18 没有 dreamer 任务**（被 `computeBridgeDecision` 正确地以「channel `skill` 不在 MVP 白名单」拒绝），**却仍有 16 条出现在账本里**。⇒ **这 16 条只可能由 `intake()` 单独写出，与内部化链完全无关。** 这是「写入通路独立于路由通路」的最硬证据。

**③ 被拒的候选数 ≠ 缺失的账本数**：`implementation` 候选共 18 条，账本中有 16 条 —— 拒绝机制对**账本**完全无约束力。

**④ 路由层在工作，但作用域不含账本**

| dreamer 任务 `pi_metadata.channel` | 数量 |
|---|---|
| `prompt` | 66 |
| `code_tool_hook` | 42 |
| （`skill`） | **0** ← 白名单外，被正确拒绝 |

`demotedFromChannel` 出现次数 = 0（42 条 rule 候选全部携带完整机械证据，未被降级）。
⇒ **路由层没有任何故障。它只是不在账本写入路径上。**

## 3.3 六条根因（按因果强度排序）

### RC-1（主因）— 写入与路由解耦，且写入在先
`intake()` 在 `pain-signal-bridge.ts:808` / `diagnose.ts:562` 无条件执行；`route` 在 `:813` / `:607` 才被计算。**kind 只决定「链路是否继续」，从不决定「账本是否写入」。**

### RC-2 — 门禁判据不含类型
`evaluateAdmission()`（`admission-gate.ts:42-85`）的四个判据全部是证据充分度：`recommendationKind === 'defer'` / `inputEvidenceCount === 0` / `confidence < 0.5` / `evidenceCount === 0`。
`evaluateCandidateAdmissionFromRecord()`（`:138-175`，CLI 共享闸门）只有 `defer` + `confidence`。
**两者都没有「类型是否可写入本账本」这个判据。**

### RC-3 — 写入适配器不接收类型上下文
`expandToLedgerPrincipleStatic()`（`principle-tree-ledger-adapter.ts:23-47`）的入参是 `LedgerPrincipleEntry`（11 字段），**不含 kind**；输出固定写入 `derivedFromPainIds:[candidateId]` / `ruleIds:[]` / `conflictsWithPrincipleIds:[]`。
⇒ 即使 route 判为 `implementation-candidate`（不可内部化），适配器仍会生成一个语法上完全合法的 `Principle` 实体。

### RC-4 — 未知类型 fail-open 到 `principle`
`store/candidate/recommendation-kind-resolver.ts:11-16`：

```ts
export function resolveRecommendationKind(raw: unknown): RecommendationKind {
  if (typeof raw === 'string' && VALID_RECOMMENDATION_KINDS.has(raw)) return raw;
  return 'principle';          // ← 非法/缺失/大写/数字/对象/数组 一律回落 principle
}
```

单测（`recommendation-kind-resolver.test.ts:14-26`）明确固化了这一行为（`'skill'→principle`、`''→principle`、`42→principle`、`{}→principle`）。
⇒ **任何形态异常的类型值都会变成「原则」**。这是「越界即入原则」的最后一重放大器。

### RC-5 — 目标注册面缺位（非根因，但是方案的必要约束）
- 无独立 Rule / Prompt / Implementation 注册表。
- `tree.rules` 的唯一写入者是 `openclaw-plugin/src/core/principle-compiler/ledger-registrar.ts:78`，而 `principle-compiler` 只被 `evolution-reducer.ts:25` 消费；`evolution_worker: enabled: false`（`config.yaml:42-44`）⇒ **Rule Registry 无生产写入面**，实测 `_tree.rules = 0`。
- ⇒ **「只做拒绝」会让被拒候选无处可去（数据丢失）。** 这是下面 Option 选择的关键约束。

### RC-6 — 通道语义重叠（解释「为什么污染不可见」）
```ts
ROUTE_CHANNEL_MAP['principle-ledger']           = 'prompt';
ROUTE_CHANNEL_MAP['prompt-injection-candidate'] = 'prompt';
```
**原则与 Prompt 建议共享同一个激活通道。** 加之 `pi_artifacts.artifact_kind` 只有 `principle`/`rule` 两值、链路产物统一记 `principle`
⇒ **从通道、从 artifact、从 ledger 存量三个视角都无法反推语义类型。污染在观测面上是隐形的。**

## 3.4 Current Flow / Root Cause（任务书要求的最小表述）

```
Current Flow:

  Candidate (recommendation_kind ∈ {principle, rule, prompt, implementation, defer})
     │
     ├─ 通路 A（链路入口，kind 感知 ✓）
     │     decideInternalizationRoute → CANDIDATE_KIND_TO_ROUTE → ROUTE_CHANNEL_MAP
     │     → MVP_ENABLED_CHANNELS 白名单   [implementation→'skill' 被正确拒绝]
     │
     └─ 通路 B（账本写入，kind 无感知 ✗）
           CandidateIntakeService.intake()  ← 无 kind 分支
           → PrincipleTreeLedgerAdapter.writeProbationEntry()
           → addPrincipleToLedger()
           ★ 对 4 种 kind 一视同仁地写入 Principle Tree
           ★ 且执行顺序早于通路 A（pain-signal-bridge.ts:808 vs :813）


Root Cause:

  RC-1  写入与路由解耦且写入在先：kind 只决定「链路是否继续」，不决定「账本是否写入」
  RC-2  门禁判据不含类型：admission gate 只判 defer + 证据充分度
  RC-3  写入适配器不接收类型上下文：LedgerPrincipleEntry 11 字段无 kind
  RC-4  未知类型 fail-open 到 principle：resolveRecommendationKind 默认 'principle'
  RC-5  目标注册面缺位：无 Rule/Prompt/Implementation registry；tree.rules 无生产写入面
  RC-6  通道语义重叠：principle-ledger 与 prompt-injection-candidate 共用 'prompt' 通道
```

**一句话**：**PD 已经有了正确的路由器，但把它装在了链路的门口，而不是账本的门口。**

---

# Type Boundary Matrix

## 4.1 概念边界（任务书 Step 2 要求）

判定准则：**「这条知识若被违反，正确的响应是什么？」**

| | 违反后的正确响应 | 语义层级 |
|---|---|---|
| **Principle** | 需要**判断**——理解情境后决定如何行动 | 长期可迁移的**行为认知** |
| **Rule** | 可以**机械执行**——由代码判定并强制 | 可判定的**触发-动作约束** |
| **Prompt** | 需要**改变模型的注意焦点**——不改变约束，只改变表达 | **指令注入** |
| **Implementation** | 需要**修改系统**——代码/工具层面的能力建设 | **工程实现变更** |

## 4.2 Type Boundary Matrix

| Type | Purpose（是什么） | 判据（怎么认出它） | Storage（应存于） | Lifecycle（生命周期） |
|---|---|---|---|---|
| **Principle** | 长期可迁移的行为认知；跨任务、跨工具、跨领域成立 | 条件句/价值判断形态（"任何…都必须…"）；**无可机械判定的触发条件**；违反需要理解情境才能纠正 | **Principle Ledger**（`_tree.principles`）— 现存 SSOT | candidate → probation → active → deprecated → archived（`principle-enums.ts`），由 Owner 审批驱动 |
| **Rule** | 可机械判定的触发-动作约束；面向工具/文件/命令 | **必须同时具备 `triggerPattern` + `action`**，且 `triggerPattern` 可被代码匹配 | **Rule 面**：`_tree.rules`（嵌套于同一 ledger）+ `pi_artifacts(kind='rule')` + `activations(channel='code_tool_hook')` | candidate → shadow → live → retired（`activation_decisions` / `activation_control_states`） |
| **Prompt** | 对模型注意力的指令级调整；措辞优化 | 文本形如「在系统提示词中加入…」；**无独立行为判据**，依附于宿主 prompt 段落 | **激活面**：`activations(channel='prompt')` + `pi_artifacts` 的 scribe 产物（当前实现） | activate / deactivate（`activations.activated_at / deactivated_at`） |
| **Implementation** | 系统能力建设：新工具、新检查、新管线 | 文本形如「实现…」「增加一个自动化工具…」；**要求改变系统而非改变行为** | **Implementation 面**：`_tree.implementations` + `pi_artifacts`；MVP 阶段应为 `deferred` | candidate → active → disabled → archived（`ImplementationLifecycleState`，`VALID_LIFECYCLE_TRANSITIONS`） |

## 4.3 判据的**可判定性验证**（生产实测，零 LLM）

对 `principle_candidates` 全表 138 行逐字段统计填充率：

| `recommendation_kind` | n | `abstracted_principle` | `trigger_pattern` | `action` |
|---|---|---|---|---|
| `principle` | 54 | **54 (100%)** | 0 | 0 |
| `rule` | 45 | 0 | **45 (100%)** | **45 (100%)** |
| `implementation` | 18 | 0 | 0 | 4 |
| `prompt` | 20 | 0 | 1 | 2 |
| `defer` | 1 | 0 | 0 | 0 |

**两个 100% 精确的正判别器（覆盖 99/138 = 71.7%）：**
- `kind = principle` ⟺ `abstracted_principle` 非空（**54/54 命中，且其余 4 个 kind 全部 0 命中** ⇒ 该特征是 principle 的独占特征）
- `kind = rule` ⟺ `trigger_pattern` **且** `action` 同时非空（**45/45 命中**；其他 kind 最高 4/18 = implementation、1/20 = prompt、0/54 = principle ⇒ 该特征是 rule 的准独占特征）

**两个正判别器都缺失的剩余类（39/138 = 28.3%）**：`prompt`(20) / `implementation`(18) / `defer`(1)。这三类**没有正字段签名**，只能靠「不具备 principle 与 rule 的特征」反推，且 `prompt` 与 `implementation` 彼此的字段画像高度相似（prompt: trigger 1 / action 2；implementation: trigger 0 / action 4）—— **无法用字段区分**。

⇒ **因此本 SPEC 规定：`recommendation_kind` 是权威分类依据，字段判别器仅作交叉校验，不单独用作分类依据**（见 4.4）。

且该判别器**已在仓库中成文**——`internalization-route.ts:79-118` 的 readiness 契约正是：
> `principle` requires `abstractedPrinciple`；`rule` requires `triggerPattern` + `action`

⇒ **对占比最大的两类（principle / rule，占 ledger 存量 73%）类型判定不需要 LLM、不需要 embedding、不需要人工标注**，现有字段已是精确判别器。这直接决定了 Data Migration 可以做到确定性、可复现、可审计。

对 ledger 存量 122 条的二次交叉验证（按 `derivedFromPainIds[0]` 反查 candidate）：

| kind | ledger 条数 | 携带 `triggerPattern`+`action` 的条数 |
|---|---|---|
| `principle` | 49 | **0/49** |
| `rule` | 40 | **40/40** |
| `prompt` | 17 | 1/17 |
| `implementation` | 16 | 0/16 |

**同一判别器在 ledger 侧复现一致。** 双路径互证。

## 4.4 边界上的已知灰色地带（须显式承认）

1. **`prompt` vs `implementation` vs `defer`（39 条候选，ledger 中 33 条）无正字段判别器**：三者在 `abstracted_principle` / `trigger_pattern` / `action` 上几乎全空，字段画像无法区分（见 4.3）。`prompt` 的文本形态偏「在系统提示中加入…」，但**这只是启发式，不是判别器**（`principle` 中也有 4 条以「将 Owner…」开头却包含提示词语义）。
   本 SPEC 的处理：**以 `recommendation_kind` 为权威**（它是 Diagnostician 的原始产出），字段判别器仅作交叉校验。**这是一个必须显式承认的边界：纯化的正确性依赖 `recommendation_kind` 自身的准确性**（见 Q3）。
2. **`principle` 的 `action` 字段**：49 条 principle 的 ledger `action` 全为空串，而 40 条 rule 的 action 全部有值。⇒ 「原则不需要 action」在数据上成立，但要警惕：**这可能是 intake 把 action 丢在了别处**，属 `Open Questions`。
3. **`implementation` 的 4 条带 action**：边界不完全干净，说明 Diagnostician 自身对类型的判定也存在噪声。**这属于 RC 的上游**，本 SPEC 不解决，但需记录（见 `Open Questions` Q3）。

---

# Design Goals

1. **G1 类型纯净**：`_tree.principles` 只承载 `recommendation_kind === 'principle'` 的条目。新写入路径在类型层面不可绕过。
2. **G2 可追溯**：每一条 ledger 条目的类型来源可确定性重建（无需 LLM、无需人工），且重建过程可复现、可审计。
3. **G3 不丢数据**：纯化不得删除任何候选，也不得让任何候选静默消失。被拒的候选必须有**显式 disposition**。
4. **G4 零新 SSOT**：不新建原则/规则/prompt 的第二真相。所有落点复用既有存储面。
5. **G5 读取面兼容**：44 处 `loadLedger()` 消费方在纯化后不报错、不静默改变语义。
6. **G6 为 Resolver 预留**：纯化后的 ledger 必须是**同质可比集合**，并在数据上具备 Resolver 所需的最小字段。
7. **G7 增量可逆**：每一步都可单独开启/回退；门禁开启前必须先有影子观测。

# Non Goals

1. **不实现 Principle Resolver / Selector**（任务书硬约束 7）。本 SPEC 只交付边界。
2. **不做语义去重、不做存量合并、不做 embedding**（任务书硬约束 6）。
3. **不做生命周期管理**（cap 执行、LRU、弃用流转）——属 `principle-evolution-audit` 的 Phase 1/2。
4. **不执行 migration**（任务书硬约束 4）。本 SPEC 只描述方案，执行需 Owner 另行授权。
5. **不删除任何数据**（任务书硬约束 5）。
6. **不新建 Rule / Prompt / Implementation registry**——RC-5 的补位标注为 `Follow-up Candidate`，不在本次范围（P7 无可变轴：当前 0 个实现）。
7. **不修复 Diagnostician 自身的类型判定噪声**（4.4-3），只记录。
8. **不改 `pi_artifacts.artifact_kind`**（917/4 的现状与链路语义耦合，改动面过大且非本问题必需）。

---

# Target Architecture

## 7.1 目标形态（任务书 Step 3）

```
Recommendation (recommendation_kind)
        │
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Admission Router                                        │
  │  = 既有的 CANDIDATE_KIND_TO_ROUTE + ROUTE_CHANNEL_MAP     │  ← 复用，不新建
  │    + MVP_ENABLED_CHANNELS                                 │
  └──────────────────────────────────────────────────────────┘
        │
        ├── principle ─────► Principle Ledger
        │                     `_tree.principles`（现存 SSOT）
        │
        ├── rule ──────────► Rule 面
        │                     `_tree.rules` + pi_artifacts(kind='rule')
        │                     + activations(channel='code_tool_hook')
        │
        ├── prompt ────────► 激活面
        │                     activations(channel='prompt')
        │                     （artifact 驱动，见 2.5 —— 与 ledger 正交）
        │
        └── implementation ─► MVP 阶段：deferred
                              （channel 'skill' 不在 MVP_ENABLED_CHANNELS）
```

**关键判断：这张图 100% 已经存在，缺的只是从 Router 到 Ledger 的那一条闸门线。**

## 7.2 Connection Before Creation 映射（任务书要求）

| 目标架构中的元素 | 复用对象 | 状态 |
|---|---|---|
| Admission Router | `internalization-route.ts` `KIND_ROUTE_MAP` + `decideInternalizationRoute()` | **Existing and usable** |
| Route → Channel 映射 | `intake-to-internalization-bridge.ts` `ROUTE_CHANNEL_MAP` + `CANDIDATE_KIND_TO_ROUTE` | **Existing and usable** |
| MVP 通道白名单 | `intake-to-internalization-bridge.ts` `MVP_ENABLED_CHANNELS` | **Existing and usable** |
| 类型判别器 | `principle_candidates` 的 `abstracted_principle` / `trigger_pattern` / `action` + `internalization-route.ts:79-118` 契约 | **Existing and usable（100% 精确）** |
| Principle Ledger | `principle-tree-ledger.ts`（PRI-459 单写者 + 文件锁） | **Existing and usable** |
| Rule 落点 | `_tree.rules`（`createRule`，:497）+ `pi_artifacts(kind='rule')` | **Existing but disconnected**（写入者 `ledger-registrar` 被 `evolution_worker=false` 挂空） |
| Prompt 落点 | `activations(channel='prompt')` + artifact 驱动读取 | **Existing and usable** |
| Implementation 落点 | `_tree.implementations` + `ImplementationLifecycleState` | **Existing but disconnected**（MVP 阶段 `skill` 通道关闭，应保持 deferred） |
| 类型标记字段 | `LedgerPrinciple` 无类型字段；`principle-schema.ts` 无 `entryKind` | **Need new（最小、可空、加性）** |
| 类型生命周期事件 | `principle-lifecycle-event.ts` 已含 `rule_created` / `rule_enforced` / `rule_retired` / `implementation_added` | **Existing but disconnected**（无发射方） |
| 类型感知路由（原则内部） | `routing-policy.ts` 的 `skill` / `code` / `defer` | Existing（语义不同：指实现路径，非类型） |

**⇒ 本 SPEC 需要的真正新增物只有一件：ledger 条目上的一个可空类型标记 + 一处闸门谓词。其余全部复用。**

## 7.3 闸门设计（单一判据，两处调用）

**判据（单一真相，复用现成常量）**：

```ts
// 不新建函数也可以：直接读现成表
const isLedgerEligible = (kind: string): boolean =>
  CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger';
```

**调用点（把闸门前移到 `intake()` 之前）**：

| # | 文件 | 位置 | 现状 | 目标 |
|---|---|---|---|---|
| 1 | `principles-core/src/runtime-v2/pain-signal-bridge.ts` | `:806`（`admission` 判定后、`:808` intake 前） | 只判 `admitted` | `admitted && isLedgerEligible(kind)` |
| 2 | `pd-cli/src/commands/diagnose.ts` | `:553`（`checkAdmissionGate` 后、`:562` intake 前） | 只判 admission | `+ isLedgerEligible(kind)` |
| 3 | `pd-cli/src/commands/candidate.ts` | `:594` / `:804` / `:1100` 三处 `intake()` | 只判 admission | 同上；`candidate intake` 手动命令保留 `--force-legacy-intake` 显式逃生舱 |
| 4 | `pd-cli/src/commands/pain-retry.ts` | `:616`（经 `PainSignalBridge`） | 随 #1 自动生效 | — |

**注**：闸门必须落在 **`intake()` 调用之前**（不是 `writeProbationEntry` 之内）。理由：`writeProbationEntry` 位于 `LedgerAdapter` 接口层（`candidate-intake.ts:275-309`），在其中拒写会导致 `CandidateIntakeError` 语义混淆（该接口的既有错误码全部是 `*_NOT_FOUND` / `*_FAILED` / `INPUT_INVALID`，没有「类型不该来」这一类）；且在写入层拒写会留下「候选已被 `intake()` 消费但账本无条目」的不一致窗口。

## 7.4 类型标记（唯一新增字段）

复用 `LedgerPrinciple`（`types/ledger-store.ts:101-109`）已有的开放形状，新增一个**可空、加性**字段：

```ts
export interface LedgerPrinciple extends Principle {
  // ...existing...
  /** 来源候选的 recommendation_kind。历史条目由 backfill 补齐；新条目由 intake 写入。 */
  sourceRecommendationKind?: 'principle' | 'rule' | 'prompt' | 'implementation' | 'defer' | 'unknown';
  /** 该条目是否在 pure-001 之前写入（污染期标记）。 */
  legacyContaminated?: boolean;
}
```

**为什么用「加性可空字段」而不是「新集合」**：`LedgerPrinciple` 已有先例（`suggestedRules?` / `lastTriggeredAt?` / `detectorMetadata?` 全是可选插件侧字段，`ledger-store.ts:101-108`），且 ledger codec 的 `parsePrinciples()` 用 `{...value}` 展开（`ledger-codec.ts:88-94`），**未知字段天然被保留** ⇒ 不需要 codec 改动，向后兼容。

## 7.5 数据流（纯化后）

```
Diagnostician
  → principle_candidates（recommendation_kind, abstracted_principle, trigger_pattern, action）
      → Admission（defer + confidence + evidence）      [既有]
      → ★ NEW: Ledger Eligibility Gate = CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger'
           ├─ true  → intake() → writeProbationEntry(entry + sourceRecommendationKind) → Principle Ledger
           └─ false → 不写账本；候选进入显式 disposition（见 8.4）
      → Dreamer seed（既有，kind 感知，按 ROUTE_CHANNEL_MAP + MVP_ENABLED_CHANNELS）
```

---

# Data Migration

## 8.1 约束与前提

- **约束**：不删除（硬约束 5）、不执行（硬约束 4）、任何历史数据改变必须可追溯。
- **可判定性前提已满足**：类型可由 `derivedFromPainIds[0]` → `principle_candidates.recommendation_kind` **确定性推导**。已验证 orphan = 0（122/122 的 `derivedFromPainIds` 全部能在 `principle_candidates` 中找到对应行）。交叉验证判别器在 ledger 侧独立复现一致（4.3）。

## 8.2 三个 Option 的完整比较

### Option A — 迁移（wrong entry → correct registry）

把 40 条 `rule` / 17 条 `prompt` / 16 条 `implementation` 从 `_tree.principles` 移出，写入各自正确的注册面。

| 维度 | 评估 |
|---|---|
| **可行性** | ✗ **目标面缺位**。`_tree.rules` 的唯一写入者是 `ledger-registrar.ts`，其唯一消费者 `principle-compiler` 只被 `evolution-reducer` 调用，而 `evolution_worker: enabled: false`。`_tree.implementations` 同样无生产写入面。Prompt 面只有 `activations` 而它锚定 artifact 而非候选。 |
| **风险** | **极高**。① 破坏 P4（需要新造目标 SSOT 或激活一条休眠链路）；② 44 处 `loadLedger()` 消费方将观察到条目消失；③ 「移动」本质是删除+新建，与硬约束 5 冲突；④ 一旦推导逻辑有误则不可逆。 |
| **成本** | 高（需先补 3 个注册面写入路径，再迁移，再回归 44 个消费方） |
| **可追溯性** | 需额外引入 lineage 记录才能满足「可追溯」 |
| **推荐** | **✗ 不采用** |

### Option B — 标记 legacy contaminated

保留全部 122 条**原位不动**，为每条补齐类型标记（`sourceRecommendationKind` + `legacyContaminated: true`），由**读取面**按标记过滤 / 分组。

| 维度 | 评估 |
|---|---|
| **可行性** | ✓ 高。推导是确定性的（字段已存在 + orphan=0 + 判别器双路径互证）；写入是加性可空字段（codec 天然保留未知字段，无 schema 迁移） |
| **风险** | **中**。① 标记期间若 `principle_candidates` 被清理则推导失效 ⇒ 需在标记前做**快照留档**；② 读取面需逐一确认过滤策略（44 处）；③ `legacyContaminated` 标记本身可能被下游误读为「无效」 |
| **成本** | 中（1 次确定性回填 + 44 处读取面评审） |
| **可追溯性** | **强**。每条条目的类型来源 = `derivedFromPainIds[0]` → `principle_candidates.recommendation_kind`，可随时重放验证 |
| **推荐** | **✓ 推荐（主方案）** |

### Option C — 保留只读历史（快照 + 冻结）

把当前 ledger 做只读快照（`principle_training_state.legacy-20260923.json`），并从**读取面**中排除污染条目。

| 维度 | 评估 |
|---|---|
| **可行性** | ✓ 中。快照零风险；但「从读取面排除」等价于对 49 条真原则之外的内容做软删除，会让「已 consumed 的候选」在治理面上消失 |
| **风险** | **低-中**。不改变原文件 ⇒ 零不可逆风险；但会让 73 条候选进入「无可见归属」状态，可能被误读为丢数据（恰好违反 G3） |
| **成本** | 低 |
| **可追溯性** | **强**（快照冻结） |
| **推荐** | **✓ 推荐（作为 B 的卫生措施，不单独作为主方案）** |

## 8.3 推荐组合：**B 为主 + C 为卫生措施，明确不采用 A**

```
Step M1  快照留档（只读，零风险）
         cp <ws>/.state/principle_training_state.json
            <ws>/.state/principle_training_state.legacy-<date>.json
         + 导出分类依据面（否则推导不可复现）：
           SELECT candidate_id, recommendation_kind, abstracted_principle,
                  trigger_pattern, action FROM principle_candidates
           → D:/pd-probe-purify/candidates-<date>.json
         + 记录两份文件的 sha256 / 条目数 / 导出时间，写入迁移报告

Step M2  确定性分类报告（只读，不写）
         对 122 条逐一推导 sourceRecommendationKind
         产出 purityReport: { total, byKind, unclassified[], crossCheckMismatch[] }
         ★ 门禁：unclassified 必须为 0，否则中止

Step M3  标记回填（加性写入，可逆）
         为每条补 sourceRecommendationKind + legacyContaminated
         不改变任何既有字段、不删除任何条目
         ★ 每批 ≤10 条，逐批校验条目总数不变

Step M4  读取面按标记过滤/分组（逐面评审）
         原则面（Console 原则列表、L2 reader、剪枝、生命周期）→ 只读 kind='principle'
         审计面（ApprovalsGrouped、pain-chain、replay）→ 保留全量，按标记分组展示
         ★ 44 处逐一给出「过滤」或「保留」的判定与理由

Step M5  被拒候选的 disposition（见 8.4）
```

**为什么不做 A**：A 需要先激活或新建 3 个目标注册面，这直接违反「不新建 SSOT」与 P7（当前 0 个实现 = speculative）。**A 是 Phase 2 的事，前提是 Rule/Prompt/Implementation 面先有生产写入路径。**

**为什么 B 满足「可追溯」**：标记的**来源**是 `principle_candidates`（不可变的历史记录），标记的**推导**是纯函数，标记的**结果**可被任何人在任何时间重放验证。且原文件在 M1 已有快照。

**为什么不删**：硬约束 5；且 73 条非原则条目是**有价值的诊断信号**——它们证明 Diagnostician 在按设计产出 4 类建议，问题出在路由，不在生成。

## 8.4 被拒候选的 disposition（G3 的关键）

门禁开启后，非 `principle` 候选不再写账本。**它们必须有一个显式归宿**，否则就是静默丢数据。本 SPEC 规定三选一，且**必须在遥测中落一条 disposition 记录**：

| 候选 kind | disposition | 依据 |
|---|---|---|
| `rule` | 已由 `computeBridgeDecision` 处理：有机械证据 → `code_tool_hook` 通道（→ RuleCode 链路）；无 → 降级 `prompt` 通道 | `intake-to-internalization-bridge.ts:167-170`，既有逻辑 |
| `prompt` | 已由 `ROUTE_CHANNEL_MAP` 处理：`prompt` 通道 → 激活面 | `:126`，既有逻辑 |
| `implementation` | **新增**：`deferred`（`skill` 通道不在 MVP 白名单）；候选状态保持 `pending` 并携带原因 `channel_mvp_disabled` | `MVP_ENABLED_CHANNELS`，既有常量 |
| `defer` | `deferred`（既有） | `admission-gate.ts:43-50` |

**⇒ 门禁本身不产生新归宿，它只是把「已经在链路层发生的事」补到「账本层」。** 这就是 Connection Before Creation 的直接体现：**被拒候选的归宿逻辑全部现成，缺的只是别再把它们复制一份到原则树。**

---

# API Changes

## 9.1 契约变更（加性，全部向后兼容）

| # | 变更 | 位置 | 类型 | 影响面 |
|---|---|---|---|---|
| C1 | `LedgerPrinciple` 新增 `sourceRecommendationKind?` / `legacyContaminated?` | `runtime-v2/types/ledger-store.ts:101-109` | 加性可空字段 | codec 用 `{...value}` 展开 ⇒ **无需改 codec**（`ledger-codec.ts:88-94`） |
| C2 | `LedgerPrincipleEntry` 新增 `sourceRecommendationKind?` | `runtime-v2/candidate-intake.ts:131-143` | 加性可空字段 | 11 字段 → 12 字段；现有构造点仅 `candidate-intake-service.ts:196-207` 一处 |
| C3 | `expandToLedgerPrincipleStatic()` 透传该字段 | `adapter/principle-tree-ledger-adapter.ts:23-47` | 函数体变更 | 无签名变更 |
| C4 | **NEW** ledger 资格谓词 `isLedgerEligible(kind)` | 建议置于 `runtime-v2/internalization/internalization-route.ts`（与 `KIND_ROUTE_MAP` 同源，避免第二个真相） | 新增纯函数（4 行） | 无 |

## 9.2 行为变更（闸门）

| # | 位置 | 变更 | 可回退 |
|---|---|---|---|
| B1 | `pain-signal-bridge.ts:806` | `admitted` → `admitted && isLedgerEligible(candidate.recommendationKind)` | 是（谓词置恒真） |
| B2 | `pd-cli/src/commands/diagnose.ts:553` | 同上 | 是 |
| B3 | `pd-cli/src/commands/candidate.ts`（`:594` / `:804` / `:1100`） | 同上；`candidate intake` 手动命令增加 `--force-legacy-intake` 逃生舱（默认关闭，使用时必须打印警告） | 是 |

## 9.3 明确**不**变更的接口

- `LedgerAdapter` 接口签名（`candidate-intake.ts:275-309`）不变 —— 拒写在闸门层，不在适配器层（见 7.3 注）。
- `addPrincipleToLedger()` 签名（`principle-tree-ledger.ts:440`）不变。
- `INTAKE_ERROR_CODES` 不新增错误码 —— 门禁不产生 `CandidateIntakeError`。
- `ACTIVATION_*` / `ROUTE_CHANNEL_MAP` / `MVP_ENABLED_CHANNELS` 全部不变。
- `WorkflowFunnelLoader` / `pi_artifacts` schema 不变。

## 9.4 观测新增（Phase 0 前提）

| 事件 | 载荷 | 用途 |
|---|---|---|
| `ledger_intake_eligibility_evaluated` | `{ candidateId, recommendationKind, route, eligible, decision: 'allowed'\|'refused', reason }` | 影子期基线；验收判据 A3 的守恒等式依赖它 |
| `ledger_intake_refused` | `{ candidateId, recommendationKind, disposition: 'deferred'\|'channel_X', reason }` | 证明「拒绝 ≠ 丢失」 |

---

# Rollout Plan

**四阶段，每阶段独立可回退。门禁（Enforce）在影子期建立基线之前不开启。**

| 阶段 | 内容 | 行为变化 | 回退 | 通过判据 |
|---|---|---|---|---|
| **P0 观测** | 只加 C1/C2/C3（类型标记）+ `ledger_intake_eligibility_evaluated` 事件。不改任何门禁 | **无** | 删字段 | 事件中 `eligible=false` 的比例稳定可复现 |
| **P1 影子** | 计算 `would-refuse` 集合，写 `ledger_intake_refused`，但**仍允许写入** | **无** | 停发事件 | 影子拒绝集与 P0 基线一致；无 `unclassified` kind |
| **P2 门禁** | 开启 B1/B2/B3。非 principle 候选不再写账本 | **有**（核心变更） | 谓词置恒真 | ledger 新增条目 100% 为 `kind='principle'`；**守恒等式成立**（见 A3）；`ledger_intake_refused` 与 disposition 一一对应 |
| **P3 存量标记** | 执行 `Data Migration` M1→M4 | 读取面语义变化 | 恢复读取面过滤 + 使用 M1 快照 | 122 条全部有标记；`unclassified = 0`；条目总数不变（122） |
| **P4 读取面收口** | 44 处 `loadLedger()` 消费方逐面确认 | 展示面变化 | 逐个回退 | 原则面只展示 kind='principle'；审计面保留全量 + 分组 |

**前置依赖（必须在 P2 之前完成）**：
1. 决策点 D1：`implementation` 候选的最终归宿（保持 `deferred` / 还是要求 Owner 显式裁决）—— **需 Owner 决策**。
2. 决策点 D2：`candidate intake` 手动命令是否需要 `--force-legacy-intake` 逃生舱（若 Owner 要求「零绕过」，则不加）。
3. 决策点 D3：`prompt` 候选的归宿 —— 当前它与原则共用 `prompt` 激活通道（RC-6）。**纯化后 `prompt` 候选不再进 ledger，是否影响其激活路径？** 已核实：**不影响**（激活是 artifact 驱动，`active-principle-prompt.ts:69`）。但激活面的**列表语义**会变化（`activations` 仍会新增，但对应 ledger 条目不再存在）⇒ 需确认 Console 审批面能否接受「有 activation 但无 ledger 条目」。

---

# Risks

| # | 风险 | 等级 | 触发条件 | 缓解 |
|---|---|---|---|---|
| **R1** | **账本/候选快照缺失导致分类不可复现** | 高 | `principle_candidates` 被清理后才做 M2 | M1 强制先做账本快照；M2 产出 `purityReport` 并冻结（含候选表只读导出） |
| **R2** | **被拒候选静默消失（违反 G3）** | 高 | 门禁开启但 disposition 未落遥测 | 守恒等式进验收（A3）；`ledger_intake_refused` 为 P2 的放行前置 |
| **R3** | **44 处读取面语义漂移** | 高 | M4 未逐面评审 | M4 强制逐面给出「过滤/保留」判定；分阶段（P3/P4 分离） |
| **R4** | **Console 出现「有 activation 无 ledger 条目」** | 中 | 见 Rollout D3 | P1 影子期先观测；Console 面在 P4 单独回归 |
| **R5** | **`legacyContaminated` 标记被误读为「条目无效」** | 中 | 下游按标记删除/忽略 | 命名上避免「invalid」；文档明确「标记 ≠ 删除」；剪枝模型不得消费该标记做淘汰（会与「不删除」冲突） |
| **R6** | **闸门位置放错层（放进 `writeProbationEntry`）** | 中 | 实施者图省事 | 7.3 已明确理由：会造成 `intake()` 已消费但账本无条目的不一致窗口 |
| **R7** | **Diagnostician 自身的类型噪声**（4 条 implementation 携带 action、1 条 prompt 携带 rule 字段） | 中 | 上游判定不准 | 本 SPEC 不解决，登记为 `Follow-up Candidate`；闸门按 kind 判定不按字段判定，故噪声不会污染账本 |
| **R8** | **`resolveRecommendationKind` fail-open 到 principle（RC-4）未修复** | 中 | 上游写入异常 kind | 闸门用 `CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger'`，未知 kind 映射不到 ⇒ **天然 fail-closed**。这是不修改 `resolveRecommendationKind` 也能收敛的关键（改动它会影响 `sqlite-candidate-store` / `sqlite-artifact-store` 两处读取语义，风险大于收益） |
| **R9** | **P4 中误把 `_tree.rules`/`_tree.implementations` 的为空当作错误** | 低 | 收口时误判 | 已在 `Current Architecture` 记录：二者为空是「无生产写入面」的预期结果，不是缺失 |
| **R10** | **纯化被误认为「问题已解决」** | 中 | 读者只看到 ledger 变干净 | 报告与 SPEC 双处显式声明：**纯化只恢复同质可比性，不减少原则数量**（`Non Goals` 1/2/3 已列） |

---

# Acceptance Criteria

## AC-1 — 未来 `rule` / `prompt` / `implementation` 是否还能进入 Principle Ledger？

**答：不能。且不可被绕过。**

**判据（单一真相）**：
```ts
CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger'
```
`CANDIDATE_KIND_TO_ROUTE` 的 5 个 kind 中只有 `principle` 映射到 `principle-ledger`（`intake-to-internalization-bridge.ts:114-120`）。

**为什么不可绕过**：
- 闸门置于 **`intake()` 之前**（`pain-signal-bridge.ts:806` / `diagnose.ts:553` / `candidate.ts` 三处），是写入的唯一入口路径。
- 未知 / 未映射 kind → `CANDIDATE_KIND_TO_ROUTE[kind]` 为 `undefined` ≠ `'principle-ledger'` ⇒ **fail-closed**。这同时收敛了 RC-4（`resolveRecommendationKind` 的 fail-open 到 principle）而不需要改它。

**验证测试（P2 放行前置）**：
1. 对 5 个 kind 各构造一个 `admitted` 候选，跑 `onDiagnosisComplete` → 断言只有 `kind='principle'` 产生 ledger 条目。
2. 构造一个 `recommendationKind` 为 `'unknown_xyz'` / `undefined` / `null` 的候选 → 断言 **不产生** ledger 条目（fail-closed 回归）。
3. 断言 `_tree.principles` 条目数增量 == `kind='principle'` 且 `admitted` 的候选数。

## AC-2 — 历史 122 条如何处理？

**答：原位保留 + 确定性类型标记 + 读取面按标记过滤。不迁移、不删除。**

| 步骤 | 产出 |
|---|---|
| M1 | `principle_training_state.legacy-<date>.json` 快照（只读）+ sha256 |
| M2 | `purityReport`：`{ total: 122, byKind: { principle: 49, rule: 40, prompt: 17, implementation: 16 }, unclassified: 0, crossCheckMismatch: 0 }` |
| M3 | 每条补 `sourceRecommendationKind` + `legacyContaminated: true`；**条目总数仍为 122** |
| M4 | 原则面按 `kind='principle'` 过滤（49 条）；审计面保留全量 + 分组 |

**可追溯性的三重保证**：
1. **来源可重放**：`derivedFromPainIds[0]` → `principle_candidates.recommendation_kind`（orphan=0 已实证）。
2. **判别器可互证**：`abstracted_principle` ⟺ principle（54/54 精确）、`trigger_pattern`+`action` ⟺ rule（45/45 精确），与 kind 结论交叉验证一致。
3. **快照可对照**：M1 快照 + `purityReport` 冻结，任何人可复算。

**明确不做**：不采用 Option A（目标注册面缺位，见 8.2）；不删除任何条目。

## AC-3 — 如何验证「新产生 Principle 数量下降不是因为丢数据」？

**答：靠守恒等式 + 显式 disposition 遥测。下降必须伴随等量的可归属记录。**

**守恒等式（P2 的放行门禁）**：

```
候选总数（新产生的 principle_candidates）
  = Σ(kind='principle' ∧ admitted)         → 应等于 ledger 新增条目数
  + Σ(kind='principle' ∧ refused)          → 应有 admission 拒绝记录（既有）
  + Σ(kind≠'principle' ∧ admitted)         → 应等于 ledger_intake_refused 计数
  + Σ(全部 refused)                         → 应有 admission 拒绝记录（既有）
  + Σ(pending 未处理)                       → 应等于 candidate.status='pending' 计数
```

**并逐候选校验 disposition 完备性**：每个非 principle 候选必须落且仅落一个归宿：

| kind | 期望 disposition | 证据来源 |
|---|---|---|
| `rule`（有机械证据） | `code_tool_hook` 通道 | `tasks.diagnostic_json.pi_metadata.channel='code_tool_hook'`（实测 42） |
| `rule`（无机械证据） | `prompt` 通道（降级） | `pi_metadata` + `demotedFromChannel`（实测 0） |
| `prompt` | `prompt` 通道 | `pi_metadata.channel='prompt'`（实测 66，含 principle） |
| `implementation` | `deferred` + `reason=channel_mvp_disabled` | **新增遥测** |
| `defer` | `deferred` | `admission-gate.ts:43-50`（既有） |

**判定规则**：
- ✅ **下降合法**：`ledger 新增 = kind=principle ∧ admitted` 且每个被拒候选在遥测中都有 disposition 记录。
- ❌ **下降非法**：出现「候选已 `consumed` 但既无 ledger 条目、又无 disposition 记录」。**此条件应在 P1 影子期就作为 CI 断言建设。**

**辅助证据（可复现命令）**：对任意时间窗，`Σ 各 kind 的候选数` 应等于 `ledger 新增 + 各通道 task 新增 + deferred 数`。任一差额即数据丢失。

## AC-4 — 如何保证未来 Principle Evolution Resolver 可以建立？

**答：本 SPEC 只交付 3 个必要前提中的第 1 个，且显式标注另两个为未决项。不得声称纯化使 Resolver 可建。**

| # | 前提 | 本 SPEC 是否覆盖 | 证据 / 缺口 |
|---|---|---|---|
| **1** | **类型纯净（同质可比集合）** | ✅ **覆盖** | AC-1 + AC-2。Resolver 比较的对象必须同质 —— 这是前提而非充分条件 |
| **2** | **可比较的语义表征** | ⚠️ **部分覆盖，需 Phase 2** | ledger 侧 `abstractedPrinciple` = **0/122 缺失**（字段在位率统计）；`coreAxiomId` = 0/122；`domain` = 0/122。⇒ **纯化后 ledger 仍是「只有 text+action 可比」的集合。** 上游 `docs/audit/principle-evolution-audit.md` 已实测：122 条中文原则 trigram-Jaccard **最高仅 0.212** ⇒ **纯词法不足以支撑语义去重**。`principle_candidates.abstracted_principle` 有 54/138（全部属 kind=principle）可用作**回填源**，这是 Phase 2 的确定性抓手 |
| **3** | **行为可判定（行为指纹）** | ❌ **未覆盖，需 Phase 2** | `Rule.principleId` 单值；rule id 不含行为指纹（`rule-code-validator.ts` 零去重逻辑）；`pi_artifacts.source_principle_id` 取值形态不一致（**原则正文文本 / UUID / 英文标题** 三种）⇒ 外键不可用 |

**⇒ AC-4 的正确结论**：

> **纯化是 Resolver 的必要前提，不是充分条件。** 本 SPEC 完成后，Resolver 仍有 2 个未解依赖：
> (a) **语义表征缺失** —— ledger 无 `abstractedPrinciple` / `coreAxiomId` / `domain`；需从 `principle_candidates.abstracted_principle`（54 条可用）回填，或由 Philosopher/Scribe 阶段补齐；
> (b) **行为指纹缺失** —— 需引入 `principle → behavior fingerprint`（可参考 `runtime-v2/feedback/fingerprint.ts:47` 的三元组 sha256 形态，但**不得用于 embedding**，硬约束 6）。
>
> **这两项均不得在本 SPEC 中实现**，应在 `principle-evolution-audit` 的 Phase 1/Phase 2 立项。

---

# Open Questions

| # | 问题 | 影响 | 需要的证据 / 决策 |
|---|---|---|---|
| **Q1** | 49 条 `kind=principle` 的 ledger `action` **全部为空串**，而 40 条 `kind=rule` 的 action 全部有值。这是「原则不需要 action」的语义事实，还是 intake 丢失了 action？ | 影响 Type Boundary Matrix 中 Principle 的判据表述 | 需读 `candidate-intake-service.ts:196-207` 的 `action: recommendation.action` 与 `principle_candidates` 的 reconcile；**Owner 或后续调查** |
| **Q2** | Console 审批面能否接受「有 `activation` 但无 ledger 条目」（D3） | 决定 P4 的回归范围 | 需走查 `ApprovalsGroupedConsoleModel.ts:188` 与 `activations` 的 join 语义 |
| **Q3** | Diagnostician 自身的类型判定噪声（4/18 implementation 带 action、1/20 prompt 带 rule 字段） | 属 RC 的上游；不解决会持续产生边界模糊候选 | 需评估 `diagnostician` 的 PHASE 4 taxonomy prompt |
| **Q4** | `_tree.rules` 与 `_tree.implementations` 的生产写入面何时补位 | 决定 Option A 何时可以重新评估 | 取决于 `evolution_worker` 是否重新启用 |
| **Q5** | `resolveRecommendationKind` 的 fail-open 是否应改为 fail-closed | 本 SPEC 用闸门规避（R8），但字段本身仍 fail-open | 改它会波及 `sqlite-candidate-store.ts:29` / `sqlite-artifact-store.ts:48` 两处读取语义；需单独评估 |
| **Q6** | 122 条是否为全量真实规模 | 影响 AC-2 的完整性 | 已核实 `<ws>/.state/principles/` 为空目录、`.principles/PRINCIPLES.md` 为历史遗存；仍建议在 M1 快照时做一次全盘扫描确认无第二写入面 |

---

# 附录 A — 既有能力三分法（任务书 Step 5）

## A.1 Existing and usable（直接复用，零新增）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 类型 → 路由映射 | `internalization-route.ts:43-48` `KIND_ROUTE_MAP` | AC-1 的判据来源 |
| 路由 → 通道映射 | `intake-to-internalization-bridge.ts:114-127` `CANDIDATE_KIND_TO_ROUTE` / `ROUTE_CHANNEL_MAP` | 闸门 + disposition 判据 |
| MVP 通道白名单 | 同文件 `:108-112` `MVP_ENABLED_CHANNELS` | `implementation` 应 deferred 的依据 |
| 确定性 readiness 契约 | `internalization-route.ts:79-118`（principle↔abstractedPrinciple / rule↔triggerPattern+action） | 类型判别器的权威定义 |
| 类型判别字段 | `principle_candidates.abstracted_principle` / `trigger_pattern` / `action` | 4.3 的 100% 精确判别器 |
| Principle Ledger（含文件锁单写者） | `principle-tree-ledger.ts:1-14, 440` | 落点，不改 |
| Ledger codec 的 `{...value}` 展开 | `ledger-codec.ts:88-94` | 加性字段无需 schema 迁移 |
| Prompt 激活（artifact 驱动） | `active-principle-prompt.ts:69` + `prompt-activation-reader-contract.ts:48` | 证明纯化不切断激活 |
| 剪枝/健康读模型 | `pruning-read-model.ts` | 读取面之一（注意 R5） |

## A.2 Existing but disconnected（存在，需接通或保持挂空）

| 能力 | 位置 | 现状 | 本 SPEC 的处理 |
|---|---|---|---|
| `decideInternalizationRoute()` | `internalization-route.ts:52` | 仅被 `candidate.ts` 的 4 处 CLI 调用；`pain-signal-bridge` 走 `CANDIDATE_KIND_TO_ROUTE` 未调它 | **不统一**（两表同源，统一会扩大变更面）；闸门直接用 `CANDIDATE_KIND_TO_ROUTE` |
| `LedgerAdapter` 类型上下文 | `candidate-intake.ts:275-309` | 接口无 kind 概念 | **不改签名**（见 7.3 注） |
| Rule Registry 写入面 | `principle-compiler/ledger-registrar.ts:78` ← `evolution-reducer.ts:25` ← `evolution_worker=false` | `_tree.rules = 0` | **保持挂空**；登记为 Follow-up（Q4） |
| Implementation 写入面 | `_tree.implementations` + `ImplementationLifecycleState` | `= 0`，`skill` 通道 MVP 关闭 | **保持 deferred** |
| 类型生命周期事件 | `principle-lifecycle-event.ts`（含 `rule_created`/`rule_retired`/`implementation_added`） | 无发射方 | **本 SPEC 不启用**；作为 Phase 2 的现成类型面记录 |
| `supersedesPrincipleId` | `principle-schema.ts:48` | 字段存在，**0/122 被写入** | 不属本次范围（Resolver 才需要） |
| `enforceL1HardCap` | `l1-hard-cap.ts:44` | 无生产调用方 | 不属本次范围 |
| `routing-policy.ts`（skill/code/defer） | `internalization/routing-policy.ts:134` | 语义不同（指**实现路径**，非**类型**） | **明确区分，不要混用命名** |

## A.3 Need new（真正新增，仅 2 项）

| # | 新增物 | 规模 | 为什么不能复用 |
|---|---|---|---|
| **N1** | `LedgerPrinciple` 的 `sourceRecommendationKind?` + `legacyContaminated?` 字段 | 2 个可空字段 | ledger 条目上**无任何类型字段**（`principle-schema.ts:29-54` 23 字段全部与类型无关） |
| **N2** | ledger 资格谓词（4 行，复用 `CANDIDATE_KIND_TO_ROUTE`） | 1 个纯函数 | 「类型是否可写本账本」这一判断在仓库中**不存在**（RC-1/RC-2/RC-3 均指向其缺位） |

**除 N1/N2 外，本 SPEC 不新增任何模块、表、SSOT、feature flag。**

---

# 附录 B — 证据资产

| 资产 | 位置 |
|---|---|
| 只读 DB 副本 | `D:/pd-probe-evo/state.db`（源 `<ws>/.pd/state.db`，15,417,344 B） |
| 账本快照 | `<ws>/.state/principle_training_state.json`（124,868 B） |
| 探针脚本 | `D:/pd-probe-evo/`：`schema.cjs` / `live.cjs` / `chan.cjs` / `path.cjs` / `boundary.cjs` / `resolver.cjs` |
| 上游审计 | `docs/audit/principle-evolution-audit.md` |

# 附录 C — 纪律声明

```
SOURCE_CODE_MODIFIED        = NO
PR_CREATED                  = NO
LINEAR_ISSUE_CREATED        = NO
MIGRATION_EXECUTED          = NO
DATA_DELETED                = NO
EMBEDDING_INTRODUCED        = NO
FULL_RESOLVER_DESIGNED      = NO
NEW_SSOT_INTRODUCED         = NO
NEW_MODULE_INTRODUCED       = NO (除 N1/N2 两个字段/谓词，均为加性)
SECOND_AUTHORITY            = NO
PRODUCTION_RUNTIME_TOUCHED  = NO
INSTALL_DIR_MODIFIED        = NO (~/.pd, ~/.openclaw/extensions, <ws>/.pd 均未触碰)
```
