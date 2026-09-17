# PRI-813 Phase 2 — Connection Before Creation Audit

> **性质**：只读调查。未修改任何生产代码、未新建 subsystem、未实施、未创建 PR。
> **上一轮（已冻结）**：`docs/audit/PRI-813-CODEX-REALITY-AUDIT.md`
> **本轮唯一目标**：判定 E1 / E2 / E3 的拟议修复究竟是「现有能力断线 / 重复能力 / 有意 unsupported / 确实需要新能力」。

---

## 1. Executive Verdict

> **PRI-813 最终需要的是「连接既有能力」，不是新建能力。**

一句话分解：

| 边 | 结论 | 一句话 |
|---|---|---|
| **E1** shadow evaluation | **DISCONNECTED_CAPABILITY** | shared gate 的同一次行循环里已有全部原语（loader / `evaluateBatch` / budget / 结果校验），只是对非 live 行 `continue`；**不需要把 `rule-host.ts` 的 shadow 代码搬进 host-runtime**。 |
| **E2** evidence emission | **DISCONNECTED_CAPABILITY** | 通道已存在且是**接口显式为此设计**的（`HostEventResult.metadata` 注释：*"Host-neutral evaluation facts"*）；canonical 类型 `RuleHostEvaluatedEventData` 在 **core** 且已导出；core 已有 `appendEventLogLine` 且 **`pd-hook.ts` 已导入**。**不需要扩 `HostEventEmitter` 接口**（扩是可选方案 B，非必需）。 |
| **E3** promotion contract | 机制 = **DISCONNECTED_CAPABILITY**；数据权威 = **NEEDS_ARCHITECTURE_DECISION** | promotion 链**本来就是 host 参数化的**（`hostContract` / `hostRuntimeVersion` / `collectHostChecks` 全是入参）。唯一的 OpenClaw 硬编码是 `validateHostContract` 里的**一个字面量**。缺的不是能力，是「Codex 的 capability 事实由谁拥有」这一架构决定。 |

**New abstraction required**：E1 = **NO**；E2 = **NO**；E3（机制）= **NO**，但 E3 的**数据权威**落到 Owner 决策（见 §15）。

**本轮同时发现**：E3 当前不是一个"缺功能"问题，而是一个**正确性缺陷** —— 见 §6 与 §10 的 `runtime_compatibility` 假通过。

---

## 2. Baseline

```
D:\Code\principles
git status --porcelain   →  ?? .tmp-probe/                              (未跟踪，本轮未触碰)
                            ?? docs/audit/PRI-813-CODEX-REALITY-AUDIT.md  (上一轮产出)
HEAD                     →  ff645bfe91c743163a9cda619064632263b0f275   2026-09-15 22:24 +0800
origin/main (本地跟踪 ref) →  ef6e7ed5e309803061b35ed6fdebc29a950ba15c
HEAD...origin/main       →  0    78      (落后 78 个提交)
package version          →  1.76.1
```

**⚠️ fetch 事实**：`git fetch origin main` 在上一轮已实测失败（SIGTERM / 沙箱无网络）。本轮**未重试**，`origin/main` 用的是本机远程跟踪 ref 的既有值。**不声称已同步 upstream。**

**上一轮报告是否仍对应当前 main —— 已逐文件核验**：

`git diff --stat HEAD..origin/main` 覆盖 E1/E2/E3 全部承载文件，**输出为空**：

```
packages/host-runtime/src/{production-rulehost-gate,rule-implementation-runtime,host-liveness-contract,
                            host-tool-declaration,host-tool-semantic-resolver}.ts
packages/principles-core/src/host/host-adapter.ts
packages/principles-core/src/runtime-v2/activation/{openclaw-promotion-checks,promotion-evidence-snapshot,
                            rulecode-shadow-summary}.ts
packages/principles-core/src/runtime-v2/internalization/rule-host-evaluator.ts
packages/openclaw-plugin/src/hooks/gate.ts
packages/openclaw-plugin/src/core/{rule-host,event-log}.ts
packages/codex-adapter/src/{pd-hook.ts,codec/input-decoder.ts}
packages/pd-cli/src/commands/runtime-activation.ts
packages/pd-console/src/server/models/ActivationsConsoleModel.ts
```

⇒ **上一轮全部结论在 current main 上不变。**

**但 78 个提交里有 3 个 E1/E2/E3 邻域新文件，必须纳入（已逐一读完）**：

| 新文件 | 引入 | 对 E1/E2/E3 的意义 |
|---|---|---|
| `plugins/principles-disciple/scripts/verify-pinned-runtime-capability.cjs` | PRI-810（PR #1724，`bfc6e0d8`） | **Codex 侧 Owner 紧急控制的行为探针**（S1 live deny / S2 global pause / S3 safety isolation / S4 retired contract / S5 release），接 `package.json:25` → `check:runtime-pin`。**与 E3 的 `outOfBandControls` / `protectedCapabilities` 表达同一族事实** → §11 重复能力（D-5）。 |
| `packages/codex-adapter/tests/runtime-pin-guard.test.ts` | 同上 | 引入 `HOST_RUNTIME_FLOOR`（hostRuntime ≥ 0.1.1），是 `runtime_compatibility` 的**第 4 种表达**。 |
| `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts`（改动） | EP002-R4 | 证明 `neutralProbes` 的 toolName（`bash` / `owner_review_access`）是**宿主词表强耦合**的合成用例；裸拷贝到 Codex 会让 `host_liveness_composition` 永久失败（原文：*"made every promotion permanently blocked"*）。 |

---

## 3. Capability Inventory

| # | 能力 | canonical implementation | owner | consumers | classification |
|---|---|---|---|---|---|
| 1 | **Activation 读取** | `host-runtime/src/production-rulehost-gate.ts:209-220`（shared）<br>`openclaw-plugin/src/core/rule-host.ts:336-...`（legacy） | state.db（`activations ⋈ pi_artifacts`）为唯一数据源 | gate / RuleHost | **DUPLICATE_CAPABILITY**（同 SQL、同语义、两处实现） |
| 2 | **Rule 执行原语** | `host-runtime/src/rule-implementation-runtime.ts:93-120`（`createNodeRuleImplementationRuntime` / `evaluateBatch`）<br>`openclaw-plugin/src/core/rule-implementation-runtime.ts:70-143`（`loadRuleImplementationModule` / `callEvaluate`） | 无单一 owner | shared gate / legacy RuleHost | **DUPLICATE_CAPABILITY**（且 shared 版已加固沙箱，插件版**未** —— 见 §11 D-1） |
| 3 | **决策合并（纯逻辑）** | `principles-core/src/runtime-v2/internalization/rule-host-evaluator.ts:46` `mergeDecisions` | core | 两个编排器都 import | **CONNECTED**（唯一真正共享的 primitive） |
| 4 | **Shadow 语义** | `RuleHostActivationMode = 'shadow' \| 'live'` + `RuleHostObservedDecision` + `event.data.activationMode`<br>语义定义：`docs/architecture/ACTIVATION_CHANNELS.md §3.4` + AC-8 | core 类型 + 设计文档 | legacy gate（唯一 producer） | **CONNECTED（类型层）** / **DISCONNECTED（shared 路径无执行者）** |
| 5 | **Event 类型** | `principles-core/src/runtime-v2/types/event-types.ts:465` `RuleHostEvaluatedEventData`（+ Schema `:480`） | core，已导出（`index.ts:1696`） | 无第二定义 | **CONNECTED** |
| 6 | **Event writer** | `principles-core/src/runtime-v2/pain-signal-observability.ts:68` `appendEventLogLine`（格式 SSoT，注释自陈 *"same file and entry shape as the OpenClaw EventLog"*）<br>`openclaw-plugin/src/core/event-log.ts` `EventLogService`（自建 fs 写入） | 格式 owner = core；落盘 owner = 各自宿主 | `pd-hook.ts:28,43` / plugin gate | **DUPLICATE_CAPABILITY**（见 §11 D-2） |
| 7 | **Event emitter port** | `principles-core/src/host/host-adapter.ts:181-184` `HostEventEmitter`（2 方法，PRI-750 引入） | core（接口） | 仅 Codex 路径注入 | **CONNECTED**（但**无 rulehost 通道** → E2 断点） |
| 8 | **Identity（activationId）** | `activations.activation_id`；gate 已持有于 `candidates[].implId`（`production-rulehost-gate.ts:325`）；event 契约字段 `RuleHostEvaluatedEventData.activationId?` | state.db | shadow summary 以它为过滤键 | **DISCONNECTED_CAPABILITY**（见 §9） |
| 9 | **Shadow summary 聚合** | `principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:15-45` | core | `runtime-activation.ts:115` / Console | **CONNECTED（上游为空）** |
| 10 | **Promotion evaluator** | `principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts:23`（10 项 required checks + 定量证据门）<br>`openclaw-promotion-checks.ts:119`（生产 6 项） | core | `PromotionReadinessReader`（pd-cli / Console） | **CONNECTED，且已 host 参数化**（入参 `hostContract`） |
| 11 | **Host capability declaration** | `host-runtime/src/host-tool-declaration.ts`（`.pd/host-tool-semantics/<hostKind>.json`，per-host 文件，host 自写） + `host-tool-semantic-resolver.ts:50`（ONE resolver） | host 自写；resolver 在 host-runtime | pd-cli activation/approval/promotion-readiness、Console Approvals/Activations | **CONNECTED，但 payload 只表达 tool semantics** |
| 12 | **Host liveness contract** | `host-runtime/src/host-liveness-contract.ts:4-20`（唯一的 `OPENCLAW_HOST_LIVENESS_CONTRACT` 常量） + 校验器 `openclaw-promotion-checks.ts:37-85` | host-runtime | 上述 2 个调用点 | **INTENTIONALLY_UNSUPPORTED（对非 OpenClaw）** → E3 |
| 13 | **RuleContextV2 边界** | `principles-core/src/runtime-v2/internalization/rule-context-v2.ts:334-366`（`UNAVAILABLE_RULE_CONTEXT`）+ ADR `2026-06-28-rulecode-context-v2.md` A.3 | core + ADR（Owner 批准） | gate v2 skip / Codex annotate | **INTENTIONALLY_UNSUPPORTED（Codex v2）** —— 已测（`pd-hook.production.test.ts:113-122`） |
| 14 | **GovernanceHostKind** | `principles-core/src/runtime-v2/pain-signal-bridge.ts:47` `'openclaw' \| 'codex'` | core | pain bridge / `createProductionHostRuntime({hostKind})` | **CONNECTED**（host 身份类型已存在） |

---

## 4. E1 Capability Reuse Card — Shadow Evaluation

```text
Capability Reuse Card

Problem:
  shared production gate 只评估 live activation；shadow activation 被静默跳过
  （production-rulehost-gate.ts:259-261 `continue` 无 warning）→ Codex 上
  shadow evidence 恒为空 → promotion 定量门恒不过。

Existing producer:
  OpenClaw legacy：openclaw-plugin/src/core/rule-host.ts:196-254
    evaluateDetailed()
      :199 liveImpls   = activeImpls.filter(activationMode === 'live')
      :200 shadowImpls = activeImpls.filter(activationMode === 'shadow')
      :202-215 逐 impl impl.evaluate(input) → shadowDecisions.push({...result, activationId})
      :246 返回 { liveDecision, liveDecisionActivationId, shadowDecisions, ... }
  ── 但注意：本卡结论是「不需要搬这个函数」。见 "Broken edge"。

Existing consumer:
  principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:15-45
    summarizeRuleCodeShadowEvents() —— 过滤 entry.type==='rulehost_evaluated'
    && entry.data.activationMode==='shadow'（:32）
  上游读者：pd-cli/src/commands/runtime-activation.ts:115 readShadowSummaryForActivation
  终端消费者：promotion-readiness-evaluator.ts:40-43, 65-68

Existing canonical data type:
  core：RuleHostActivationMode（'shadow' | 'live'）
  core：RuleHostResult（rule-host-contracts.ts:81-90）—— 无 activationId 字段，
        由调用方 stamp（legacy 在 rule-host.ts:205 stamp，shared 可同样处理）
  core：RuleHostEvaluatedEventData（types/event-types.ts:465，含 activationId?）

Existing writer:
  唯一 producer = openclaw-plugin/src/hooks/gate.ts:114-129（逐 shadow 决策写事件）

Existing resolver:
  activation 解析 = SQL（两处，见 §11 D-3）
  语义解析 = toolSemantics.resolve()（ToolSemanticRegistry，已 host 声明化）
  *无 shadow 专属 resolver，也不需要*

Existing store:
  state.db：activations（含 action='code_tool_hook_shadow_activate' 行）+ pi_artifacts.content_json
  —— 已存在，shadow 行本来就在库里（legacy 能读到）

Existing host abstraction:
  HostEvent（含 context.toolName/toolInput/workspaceDir/sessionId/turnId）
  HostEventResult.metadata —— 注释原文：
    "Host-neutral evaluation facts; adapters must not forward these into strict host schemas."
  HostEventEmitter（2 方法，E2 用；E1 不需要）
  GovernanceHostKind（'openclaw' | 'codec'）

Existing tests:
  legacy shadow：openclaw-plugin/tests/core/j10-rule-governance-states.test.ts:113-120
    （shadow → liveDecision undefined + shadowDecisions[0].decision==='block'
      + shadowDecisions[0].activationId===ACTIVATION_ID）
  legacy shadow：openclaw-plugin/tests/integration/rulehost-seed-mvp-e2e.test.ts:867-872
  summary：pd-cli/tests/commands/runtime-activation-shadow-telemetry.test.ts
  promotion：principles-core/.../__tests__/openclaw-promotion-checks.test.ts:84-96

Intentional unsupported boundary:
  ADR 2026-06-28-rulecode-context-v2.md A.3（Codex v2 SUSPENDED）
  —— 该边界与 E1 正交，但在实现 E1 时必须原样继承（见 §7）

Broken edge:
  packages/host-runtime/src/production-rulehost-gate.ts:259-261
    for (const [targetRef, group] of groups) {
      if (group.length !== 1) { addWarning('duplicate_active_activation', ...); continue; }
      const [row] = group;
      if (!row || row.action !== 'code_tool_hook_live_activate') continue;   // ← 唯一断点
  │
  └─ 该行的上一行 (:260) 已经完成 enforcement/group 校验；下一行 (:261+) 才开始
     content_json / requiresContextVersion / implementationCode / src 预算 / 评估。
     也就是说：**断点位于 live 语义分支的开头，而不是缺少一个模块。**

Can existing capability be reused directly?
  YES —— 且复用的是 **shared gate 自己已经持有的原语**，不是插件代码：
    1. 行循环本身（:254-330）已经 SELECT + 校验 + budget + JSON.parse + implementationCode
    2. implementationRuntime.evaluateBatch（:349）已按 candidates 批量评估，
       返回与 candidates 索引对齐的 RuleBatchResult[]（:357-378 已逐项对齐+validate）
    3. ruleId/principleId 的 stamp 模式已存在（:374-377）
    所以 shadow 只需：把这些原本只为 live candidates 组装的结果，**同时**对
    action==='code_tool_hook_shadow_activate' 的行收集成「只读评估结果」，
    不做 mergeDecisions、不进 decision、不改 input。

If not, why not?
  N/A（可直接复用）

New abstraction required?
  NO
    - 新 subsystem:  否
    - 新 store:      否（activations 表已含 shadow 行）
    - 新 evaluator:  否（evaluateBatch 已在同一文件同一函数里）
    - 新 runner:     否
    - 新 event type: 否（RuleHostEvaluatedEventData 已在 core）
    - 新 identity:   否（activation_id 已在 row 上）

Classification:
  DISCONNECTED_CAPABILITY
```

### 4.1 支撑 E1 结论的三条直接证据

1. **数据源完全一致** → `REUSE`
   `production-rulehost-gate.ts:209-220` 与 `rule-host.ts:336-...` 是**同一 SQL 形状**（`activations a JOIN pi_artifacts p`，同 `channel='code_tool_hook'`、`deactivated_at IS NULL`、同 `content_json`）。**不需要新 loader。**

2. **执行原语问题——本轮的关键修正**
   第一轮的假设是「shared live gate 与 OpenClaw shadow evaluator 是否调用同一个 execution primitive」。
   **答案：NO —— 它们是两个语义相同的重复原语**（§11 D-1）。
   但**这不改变 E1 的结论**，反而简化它：
   > **E1 不需要统一两个 runtime，也不需要把 shadow 逻辑搬进 host-runtime。**
   > shared gate 用**它自己已经调用的** `implementationRuntime.evaluateBatch` 评估 shadow 行即可 —— 与它评估 live 行完全同一条代码路径。
   > 统一两个 runtime 是**另一件事**（§13 列为 retirement 候选），**不是** E1 的前置条件。

3. **Shadow 语义已在既有类型/设计中表达完整，无需新类型**
   `ACTIVATION_CHANNELS.md §3.4`「Shadow Mode 行为」原文：

   > 1. **Shadow 期间**：RuleHost 加载实现并执行；**不**应用 `decision`（不 block / 不 propose_correction）；每次执行写 ... 记录"如果应用，会发生什么"

   且 `AC-8`：`code_tool_hook` 默认启用 shadow mode。

   ⇒ shadow：**执行 implementationCode = 是**；**允许 block = 否**；**允许 modify input = 否**；**只是记录"如果 live 会怎么判"**；**不产生 failure 语义**；**不影响 Agent**。
   这些全部已由 `activationMode` + `RuleHostObservedDecision` + `RuleHostEvaluatedEventData` 表达。
   **禁止新建 `ShadowEvaluationResult` 等第二类型。**

---

## 5. E2 Capability Reuse Card — Evidence Emission

```text
Capability Reuse Card

Problem:
  Codex/shared 路径无法把 rulehost 评估结果落成 canonical rulehost_evaluated 事件。

Existing producer:
  packages/host-runtime/src/production-rulehost-gate.ts:379-389
    —— gate 已产出并返回 metadata：
       deny : { evaluatedLiveRules, ruleId, principleId }            (:387)
       allow: { evaluatedLiveRules, ruleDecision }                   (:389)
  也是第一轮 E1/E2 断点的同一函数。

Existing consumer:
  1) OpenClaw shared 路径：openclaw-plugin/src/hooks/gate.ts:544-606
     —— 已经读 result.metadata（:545-548）并写事件（:583-591）
     *注意：这段代码已经存在，说明"shared 结果 → 事件"这条消费链已通。*
  2) Codex 路径：codex-adapter/src/pd-hook.ts:186-195
     —— 已持有完整 result（含 metadata），但只把 warnings 转发到 stderr

Existing canonical data type:
  principles-core/src/runtime-v2/types/event-types.ts:465 RuleHostEvaluatedEventData
    + Schema :480 + 已在 index.ts:1696 导出
  EventType 'rulehost_evaluated' 在 event-types.ts 的 EventType union 内

Existing writer:
  A) packages/principles-core/src/runtime-v2/pain-signal-observability.ts:68-81
     appendEventLogLine(stateDir, { ts, type, category, sessionId, data })
     → 写 <stateDir>/logs/events_<date>.jsonl（与 OpenClaw EventLog 同文件同形状）
     **已由 codex-adapter/src/pd-hook.ts:6 导入并在 :28,:43 使用**
  B) packages/openclaw-plugin/src/core/event-log.ts:191-193
     recordRuleHostEvaluated() → this.record('rulehost_evaluated','evaluated',...)
     （EventLogService，自建 fs 写入）

Existing resolver:
  filePath 归一化：buildRuleHostAction(...).normalizedPath（core，两路径都已用）

Existing store:
  <workspaceDir>/.state/logs/events_<date>.jsonl（+ legacy <ws>/.pd/logs 也被 reader 扫）

Existing host abstraction:
  HostEventResult.metadata: Readonly<Record<string, unknown>>
    注释原文："Host-neutral evaluation facts; adapters must not forward these into
              strict host schemas."
    —— 这是接口为"把评估事实交给 adapter"而显式设计的通道。
  HostEventEmitter（principles-core/src/host/host-adapter.ts:181-184，2 方法）
    recordRuntimeV2ActivationsInjected / recordToolCall
    注释：PRI-750 引入，理由是"so shared-path host events carry the natural
          turn/tool ids"。

Existing tests:
  principles-core/.../__tests__/openclaw-promotion-checks.test.ts
  openclaw-plugin/tests/core/event-log.test.ts（含 rulehost_evaluated）
  pd-cli/tests/commands/runtime-activation-shadow-telemetry.test.ts
  codex-adapter/tests/pd-hook.production.test.ts

Intentional unsupported boundary:
  无。事件写入本身没有任何"禁止在 Codex 上写"的决定。

Broken edge:
  production-rulehost-gate.ts 的 metadata **不含逐 activation 的评估明细**
  （只有计数 + 获胜规则的 ruleId/principleId），且
  **不含 shadow 决策**（因为 E1 未评估）。
  ⇒ 即使 adapter 想写，也拿不到 activationId / activationMode / matched 三元组。

Can existing capability be reused directly?
  YES。存在三条**都已就绪**的路径，全部在"允许的变化"预算内：

  ◎ 路径 B′（推荐，改动面最小）——扩既有 metadata
      gate 在既有 metadata 上增加一个 evaluations 明细数组（每条：
        { activationId, activationMode, ruleId, matched, decision }）。
      理由：metadata 的注释就是为"host-neutral evaluation facts"设计的；
            metadata 形状无数组限制（hasValidResultSemantics 只要求它是非数组对象）；
            消费端 gate.ts:583-588 已经在读 metadata 并写事件。
      → 新增 event type: 0；新增 writer: 0；新增 emitter 方法: 0。

  ◎ 路径 A（可选，非必需）——扩 HostEventEmitter
      给 HostEventEmitter 加 recordRuleHostEvaluated(...)。
      代价：1 个接口方法 + 2 处实现（codexEventEmitter / 未来宿主）。
      收益：把"谁写"显式化。
      判定：**不是必需**；若走 B′，pd-hook.ts 直接用已导入的 appendEventLogLine 写即可。

  ◎ 路径 C（等价于 B′ 的变体）
      adapter 侧从 metadata 取明细 → 用 appendEventLogLine（Codex）/ EventLogService（OpenClaw）写。

If not, why not?
  N/A

New abstraction required?
  NO
    - 新 subsystem:  否
    - 新 store:      否
    - 新 writer:     否（appendEventLogLine / EventLogService 都已存在）
    - 新 event type: 否（RuleHostEvaluatedEventData 已在 core 且已导出）
    - 新 interface:  否（metadata 已存在；扩 HostEventEmitter 是可选非必需）

Classification:
  DISCONNECTED_CAPABILITY
```

### 5.1 §7 canonical event ownership —— 谁应该拥有 writer authority？

**先说清两个职责的分层（本轮必须区分）**：

| 层 | 职责 | 现有 owner |
|---|---|---|
| **Business evaluation** | 决定"某条 activation 在本次 tool call 上会怎么判" | `host-runtime`（shared） / `openclaw-plugin`（legacy）。返回值是 `HostEventResult`，**不落盘**。 |
| **Telemetry persistence** | 把评估事实写进 `events_*.jsonl` | `openclaw-plugin`（EventLogService） / `codex-adapter`（appendEventLogLine）。 |

**结论**：

> `rulehost_evaluated` 的 **writer authority 应保持在宿主侧（host adapter / plugin）**，
> **不应**下沉到 `host-runtime` 的 gate 里。

理由（三条，全部来自现有证据）：

1. `HostEventResult` 是**纯返回值契约**，`production-rulehost-gate.ts` 全文**零事件写入**
   （第一轮已核对：无 `appendEventLogLine`、无 EventLog）。让它落盘会破坏
   "gate = 纯评估" 的既有分层，并让 gate 依赖 `stateDir` 约定。
2. 接口作者已经把这件事**显式设计**出来了：`HostEventEmitter` 的 PRI-750 注释说这个 port
   的存在理由是"so shared-path host events carry the natural turn/tool ids"，
   而 `metadata` 的注释说它承载"Host-neutral evaluation facts"。
   ⇒ **评估事实出 gate（metadata），持久化进宿主（emitter / 宿主 writer）。**
3. 跨 host 的 evidence **必须落在同一个文件格式** —— 这个 SSoT 已经是 core 的
   `appendEventLogLine`（其注释自陈与 OpenClaw EventLog "same file and entry shape"），
   所以格式 owner 已在 core，无需再迁。

---

## 6. E3 Capability Reuse Card — Promotion Contract

```text
Capability Reuse Card

Problem:
  promotion 无法在非 OpenClaw 宿主上得出诚实结论。

Existing producer（capability 事实的生产者）—— **这里就是缺口所在**：
  现状：
    OPENCLAW_HOST_LIVENESS_CONTRACT（host-runtime/src/host-liveness-contract.ts:4-20）
      —— 手写字面量（version/supportsShadowEvidence/outOfBandControls/
         protectedCapabilities/neutralProbes），**无生产者、无验证者**。
    PRI-810 探针（origin/main，plugins/principles-disciple/scripts/
      verify-pinned-runtime-capability.cjs）
      —— 行为验证 Codex pinned runtime 是否 honor global pause / safety isolation /
         retired-contract backstop（S1–S5），接 package.json:25 check:runtime-pin。
      ⇒ 它生产的是**同族事实**，但落在 release gate，不进 promotion。
  Codex 侧**没有任何** promotion 可读的 capability 事实。

Existing consumer:
  packages/pd-cli/src/commands/runtime-activation.ts:586-602（collectHostChecks 端口）
    :598  hostContract: OPENCLAW_HOST_LIVENESS_CONTRACT      ← 硬编码
    :611  hostRuntimeVersion: 'openclaw-legacy@1'            ← 硬编码
  packages/pd-console/src/server/models/ActivationsConsoleModel.ts:477, 533-534（同）
  packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts:23

Existing canonical data type:
  principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:4-19
    HostLivenessContract {
      version: string;                      ← 算法从不读它（只在校验器里被比对）
      supportsShadowEvidence: boolean;      ← 被 runtime_shadow_evidence 检查读
      outOfBandControls: readonly (...)[];
      protectedCapabilities: readonly { capabilityId, hostToolAliases }[];
      neutralProbes: readonly { probeId, capabilityId, toolName, params, expectedDecision }[];
    }
  —— **该类型本身已经是 host-neutral 形状**（字段没有一个叫 openclaw）。

Existing writer:
  N/A（这是一个纯数据常量，不是持久化事实）

Existing resolver:
  ◎ host-tool-declaration + host-tool-semantic-resolver（**同构 authority pattern**）
      host-runtime/src/host-tool-declaration.ts
        saveHostToolDeclaration(workspaceDir, declaration)
          → <ws>/.pd/host-tool-semantics/<hostKind>.json（per-host 文件，不互相覆盖）
        loadHostToolDeclarations(workspaceDir) → ALL declarations（fail-loud）
      host-runtime/src/host-tool-semantic-resolver.ts:50
        resolveWorkspaceHostToolSemantics(workspaceDir) → 合并后的 registry
      消费者（文档自陈）：pd-cli activation / approval / promotion-readiness；
        pd-console ApprovalsConsoleModel / ActivationsConsoleModel；
        auto-consumer / codex worker
  ◎ GovernanceHostKind（principles-core/src/runtime-v2/pain-signal-bridge.ts:47）
      'openclaw' | 'codex' —— host 身份类型已存在
  ✗ 没有 host capability / host profile / host registry 的 resolver

Existing store:
  .pd/host-tool-semantics/<hostKind>.json（**只存 tool mappings**）
  ✗ 无 capability declaration store

Existing host abstraction:
  HostInstaller（packages/principles-core/src/host）—— 每宿主一个 installer，
    但表达的是 install/uninstall/detect，不是运行期 capability。

Existing tests:
  principles-core/.../activation/__tests__/openclaw-promotion-checks.test.ts
  host-runtime/tests/host-tool-declaration.test.ts（含 codex.json 的 per-host 用例）
  codex-adapter/tests/runtime-pin-guard.test.ts（HOST_RUNTIME_FLOOR）
  pd-console/tests/.../activations-shadow-telemetry.test.ts
  pd-console/tests/.../rulecode-telemetry-round-trip.test.ts

Intentional unsupported boundary:
  部分是。ADR 2026-06-28 A.2.2 明确：
    "Convergence targets the two coexisting runtime governance routes ...
     `abstraction_layer_v1` keeps selecting the route. **Route unification is a
     non-goal of PRI-780.**"
  ⇒ 双路由并存是**已批准**的架构状态，不是遗漏。
  但「非 OpenClaw 宿主的 promotion 资格」**没有**任何 ADR 决定——它只是被字面量挡住了。

Broken edge:
  A) 唯一真正的硬编码：
     openclaw-promotion-checks.ts:42-46
       if (value.version !== 'openclaw-legacy@1' || value.supportsShadowEvidence !== true
           || !Array.isArray(outOfBandControls) || ...) return null;
     —— **version 字面量比对**是唯一的 OpenClaw 排他点；
        算法其余部分（:119-157）从不读 contract.version。
  B) 调用点把 OpenClaw 常量无条件传进来：
     runtime-activation.ts:598 / ActivationsConsoleModel.ts:477（+ :611 / :533 的字面量）
  C) 默认值：promotion-evidence-snapshot.ts:67
       const hostRuntimeVersion = input.hostRuntimeVersion ?? 'openclaw-legacy@1';

Can existing capability be reused directly?
  **机制层：YES。** promotion 链本来就是 host 参数化的：
    - HostLivenessContract 类型 shape 是 host-neutral
    - collectHostChecks 是**注入端口**（PromotionReadinessReader 构造参数）
    - collectOpenClawPromotionChecks 的 hostContract 是**入参**
    - buildPromotionEvidenceSnapshot 的 hostRuntimeVersion 是**入参**
  算法侧需要 host 的数据只有两项，并且已是"读字段"而非"分支逻辑"：
    - host_liveness_composition ← contract.neutralProbes
    - runtime_shadow_evidence   ← contract.supportsShadowEvidence
  其余：bounded_scope（artifact 内 affectedTools）、owner_identity_configuration
    （actor）—— 完全 host-neutral。

  **数据层：NO —— 这就是需要 Owner 决定的地方。**
  「Codex 的 governance capability 由谁拥有」在仓库里没有答案：
    - 选项 (i) 第二个常量：CODEX_HOST_LIVENESS_CONTRACT（同文件 + 通用化校验器）
      ⇒ 0 新 subsystem/store；但造成**同族事实的第二份手写 SSoT**（与 P4 张力），
         且它会与 PRI-810 探针产生第三条表达。
    - 选项 (ii) 扩既有 host declaration 文件（加 capability 块）
      ⇒ 0 新 store；但把「治理能力」塞进「tool semantics」文件，
         污染 §3#11 的边界（host-tool-declaration 的 payload 是
         ToolSemanticMappingV1[]，且 resolver 的合并语义（同 rawName 必须同 kind）
         对 capability 无意义）。
    - 选项 (iii) 让 PRI-810 探针成为 capability 的**生产者**（host-authored declaration）
      ⇒ 表达最诚实（capability 是**被验证的事实**，不是声明的意图），
         但需要一个新的 declaration store → 触碰「New store: target 0」。
  这三条都有真实代价，且互相排斥 ⇒ **架构决定**。

If not, why not?
  见上 "数据层：NO" 的三个选项各自代价。**没有一条是"零代价的明显答案"。**

New abstraction required?
  机制：NO
  数据权威：**需要 Owner 决定**（可能产生 1 个新声明载体，但不应产生新 subsystem /
           新 evaluator / 新 algorithm / 新 registry / 新 event type）

Classification:
  机制 = DISCONNECTED_CAPABILITY
  数据权威 = NEEDS_ARCHITECTURE_DECISION（见 §15）
```

### 6.1 E3 的当前真实失败模式（比"不可达"更严重）

第一轮说"promotion 结构性不可达"。本轮实测**修正为更精确的结论**：

`runtime-activation.ts:598` **无条件**传入 `OPENCLAW_HOST_LIVENESS_CONTRACT`，**不做 host 判定**。
所以在 Codex 工作区上跑 `pd activation promote`：

| 检查 | 实际结果 | 是否诚实 |
|---|---|---|
| `runtime_compatibility` | **passed** | ❌ **谎报** —— `validateHostContract` 收到的是 OpenClaw 常量，当然通过 |
| `emergency_controls` | `passed`（若 `rulecode_safety_controls` on） | ⚠️ 未验证 Codex 实际是否 honor（PRI-810 探针其实能验，但没接） |
| `runtime_shadow_evidence` | **passed** | ❌ **谎报** —— 读的是 OpenClaw 的 `supportsShadowEvidence: true` |
| 定量证据门（evaluator `:65-68`） | `observed = 0 < 20` | ✅ 诚实地卡住 → `evidence_insufficient` |

**⇒ 实际状态是 `evidence_insufficient`（不是 `unavailable`），且伴随 3 项假通过。**

这是**正确性缺陷**：能力矩阵在 Codex 上被静默显示为"兼容且支持 shadow"。
PRI-813 的"结构性不可达"表述掩盖了这一点。

---

## 7. RuleContextV2 Matrix（硬边界）

判定依据：ADR `2026-06-28-rulecode-context-v2.md` A.3 + 代码位置。

| Host/path | v1 live | v1 shadow | v2 live | v2 shadow |
|---|---|---|---|---|
| **OpenClaw legacy** | SUPPORTED | SUPPORTED | SUPPORTED | SUPPORTED |
| **OpenClaw shared** | SUPPORTED | **DISCONNECTED** | SUPPORTED | **DISCONNECTED** |
| **Codex shared** | SUPPORTED | **DISCONNECTED** | **INTENTIONALLY_UNSUPPORTED** | **INTENTIONALLY_UNSUPPORTED** |

**逐格证据**

| 格 | 依据 |
|---|---|
| OpenClaw legacy v1/v2 live | `gate.ts:68-96` → `wctx.getRuleHost().evaluateDetailed()`；v2 context 由 `buildRuleContextIfEnabled`（`gate.ts:73`）装配（flag `rulecode_context_v2` 默认 **ON**，`feature-flag-contract.ts:306`） |
| OpenClaw legacy v1/v2 shadow | `rule-host.ts:200`（shadowImpls 过滤）+ `:202-215`（逐条 evaluate）+ `:246`（返回 shadowDecisions）；v2 门 (`:552-585`) 在模式切分**之前**，`supportsContextV2 = input.context?.version === 2`（`:198`） |
| OpenClaw shared live | `production-rulehost-gate.ts:259-260` 只放 live；v2 live 通过 `ruleContextProvider` 支持 —— 装配点 `openclaw-plugin/src/index.ts:266` → `buildRuleContextIfEnabled` |
| OpenClaw shared shadow | `production-rulehost-gate.ts:260` `continue` —— 无任何 shadow 分支 |
| Codex v1 live | `pd-hook.ts:186-193` → shared gate；`production-rulehost-gate.ts:260` 放行 live |
| Codex v1 shadow | 同 `:260` 被跳过 |
| Codex v2 live/shadow | `pd-hook.ts:186-193` **不传** `ruleContextProvider`（PRI-780 决定）⇒ `production-rulehost-gate.ts:300-303` 对任何含 `requiresContextVersion` 的 artifact skip + `rule_context_v2_unavailable` warning。**该检查位于模式切分之前 ⇒ 对 shadow 同等生效。** |

### 7.1 「Codex v2 shadow 是否应该执行？」—— 明确回答：**不应该**

**不能说"shadow 不 enforcement，所以可以 context-blind 执行"。** 依据 ADR A.3 原文：

> An earlier draft ... declared a schema-valid unavailable-posture `RuleContextV2` instead,
> keeping v2 rules loaded and relying on the generation-time contract
> "unavailable → allow, matched:false". Codex review round 2 correctly rejected that posture:
> **the contract is prompt-level discipline, not a runtime-enforced invariant** — a persisted
> v2 rule may evaluate context-blind and DENY tool calls that were previously suspended,
> **silently changing governance behavior**. Suspension is the safe, spec-literal choice.

对 shadow 的同构推论（本轮结论，非原文）：

> context-blind 的 shadow 评估会产生**伪 evidence** —— 它向 promotion 报告
> "如果 live 就会 block"，而该判断基于一条**规则并不拥有**的 context。
> live 的害处是"静默改变治理行为"；shadow 的害处是"静默伪造 promotion 依据"。
> 两者同源 ⇒ **v2 shadow 必须与 v2 live 同等 suspended。**

**代码层面已经天然正确**：`production-rulehost-gate.ts:295-304` 的 v2 门禁**在 action 分支之前**，
所以任何在 `:260` 之后新增的 shadow 收集逻辑会**自动继承**这个 suspension。
⇒ **实现 E1 时不需要新增任何 v2 判定**，只需不去"绕过"它。

**已有测试保护**（这是 INTENTIONALLY_UNSUPPORTED 的机械护栏）：
`codex-adapter/tests/pd-hook.production.test.ts:113-122` 断言
`rule_context_v2_unavailable` + `codex_runtime_context_unsupported` 同时出现在 stderr。

> ⚠️ **发现的护栏缺口**：现有测试覆盖 v2-live suspended，但**没有**覆盖"v2 artifact 落到 shadow 行时也不被评估"。
> 因为今天 shared gate 根本不评估 shadow，这个缺口不可观测；一旦 E1 落地，它就会变成**可观测风险**。
> 见 §12 Connection C 的 regression 项。

---

## 8. Writer Authority Matrix（one fact → one writer）

| Fact | Current writer | Other possible writer | Canonical writer candidate | Risk |
|---|---|---|---|---|
| **rulehost evaluation result**（本次 tool call 上某 activation 会怎么判） | **无持久化**。产出者 = `production-rulehost-gate.ts:379-389`（live）/ `rule-host.ts:196-254`（legacy live+shadow）；以 `HostEventResult` / `RuleHostEvaluationReport` **返回** | — | 保持"不落盘"：这是**返回值契约** | 🟡 若让 gate 自己落盘，会破坏 "gate = 纯评估" 分层 |
| **rulehost_evaluated 事件** | `EventLogService.recordRuleHostEvaluated`（`openclaw-plugin/src/core/event-log.ts:191-193`），**全部 3 个调用点都在 `gate.ts`**（`:117` shadow / `:134` legacy-live / `:584` shared-live） | `appendEventLogLine`（core，`pain-signal-observability.ts:68`）—— 已存在、已被 `pd-hook.ts` 使用 | **core 的 `appendEventLogLine` 是格式 SSoT**；**writer authority 留在宿主侧**（plugin / codex-adapter） | 🔴 双 writer 写同一文件（见 §11 D-2） |
| **shadow decision** | `gate.ts:114-129`（唯一） | — | 同上（宿主侧） | 🟡 唯一 producer 集中在 OpenClaw 插件 ⇒ Codex 无 producer（E1） |
| **activationId linkage** | 无（shared 路径直接丢弃） | — | `RuleHostEvaluatedEventData.activationId`（core 契约已有该字段） | 🔴 见 §9 |
| **promotion evidence projection** | `buildPromotionEvidenceSnapshot`（core，`promotion-evidence-snapshot.ts:60`），调用点 = `runtime-activation.ts:604` + `ActivationsConsoleModel.ts:483` | — | **core 唯一**（正确） | 🟡 两个调用点各自硬编码 `hostRuntimeVersion`（`:611` / `:533`） |

**判定**：
- 「评估事实」与「事件持久化」**已正确分层**（前者返回值，后者宿主 writer）⇒ **不要再合并它们**。
- 唯一需要修的是 **§11 D-2 的格式双实现**（事件行格式有两处实现，落同一文件）。
- 第一轮建议的 "OpenClaw private gate 退化为 adapter" **本轮不予支持**：legacy 是 `abstraction_layer_v1=false` 时的**生产默认路由**（§11 D-4），不是残留。

---

## 9. Activation Identity Lineage

```
activations.activation_id
        ↓  【PRESENT】production-rulehost-gate.ts:209-220 SELECT a.activation_id
production gate
        ↓  【PRESENT】:261 `const activationId = row.activation_id`；:325
                      candidates.push({ implId: activationId, ruleId, principleId, ... })
evaluation result
        ↓  【DROPPED】:374-377 只 stamp ruleId / principleId；
                      metadata :387/:389 只有 evaluatedLiveRules / ruleDecision / ruleId / principleId
event payload
        ↓  【ABSENT】（因为 payload 里就没有；E2 的断点）
event log
        ↓  【ABSENT】readShadowSummaryForActivation → summarizeRuleCodeShadowEvents
shadow summary
        ↓  【REQUIRES IT】rulecode-shadow-summary.ts:27
                      `if (... || entry.data.activationId !== activationId) continue;`
promotion evidence
           【null】→ promotion-readiness-evaluator.ts:41-43 / :65-68
```

**逐跳判定**

| 跳 | 状态 |
|---|---|
| activation row.id | **PRESENT** |
| production gate | **PRESENT**（在 `candidates[].implId` 上，且是本地变量 `activationId`） |
| evaluation result | **DROPPED**（只 stamp 了 ruleId / principleId） |
| event payload | **ABSENT** |
| event log | **ABSENT** |
| shadow summary | 需要它，但**无法 RECONSTRUCTED**（无可反查的 ruleId→activationId 映射被持久化） |
| promotion evidence | null |

**唯一真正掉 ID 的边**：`evaluation result → event payload`。
且**不是"拿不到"，是"没往下传"** —— gate 在 `:261` 就把 `activationId` 拿在手里。

⇒ **分类：`DISCONNECTED_CAPABILITY`**（第一轮推断一致）。

**同时注意**：activationId 的**反查**在 legacy 路径是"扫描 implementationSources 匹配 ruleId"
（`rule-host.ts:238-244`，注释标 ISSUE-023）。shared 路径**不必**复制这种反查——
它可以直接用 `candidates[i].implId`（索引与 `batch.results[i]` 对齐，`:357-378` 已建立对齐）。
⇒ 这里也不需要新 identity model，反而共享路径的实现比 legacy 更直接。

---

## 10. Promotion Decomposition

`REQUIRED_PROMOTION_CHECK_IDS`（`promotion-readiness-evaluator.ts:3-7`）共 **10 项**；
`collectOpenClawPromotionChecks` 生产其中 **6 项**（其余 4 项由其他环节提供）。

| # | checkId | 生产者 | 分类 | 说明 |
|---|---|---|---|---|
| 1 | `activation_eligibility` | 非 collectHostChecks | **Host-neutral** | activation 状态/action/mode |
| 2 | `lineage_binding` | 非 collectHostChecks | **Host-neutral** | artifact digest / lineage |
| 3 | `bounded_scope` | `openclaw-promotion-checks.ts:150` | **Host-neutral** | 只读 artifact 自己的 `affectedTools`；判据是"非 `*` / 非 `all`" |
| 4 | `production_compile_load` | 非 collectHostChecks | **Host-neutral** | RuleCode 编译 + load |
| 5 | `golden_trace` | 非 collectHostChecks | **Artifact-specific**，host-neutral 算法 | artifact 自带 goldenTrace |
| 6 | `runtime_compatibility` | `:151` | **算法 host-neutral / 数据 host-specific** | 唯一逻辑：`validateHostContract(input.hostContract) ? passed : failed` |
| 7 | `host_liveness_composition` | `:152` | **算法 host-neutral / 数据 host-specific** | 算法 = 把 `contract.neutralProbes` 合进 artifact 的 goldenTrace 再 replay（`artifactWithNeutralProbes` `:96-117`）；`neutralProbes` 是**宿主词表数据** |
| 8 | `emergency_controls` | `:153` | **算法 host-neutral / 数据 host-specific** | 唯一逻辑：`contract !== null && input.safetyControlsEnabled` |
| 9 | `runtime_shadow_evidence` | `:154` | **算法 host-neutral / 数据 host-specific** | 唯一逻辑：`contract?.supportsShadowEvidence === true` |
| 10 | `owner_identity_configuration` | `:155` | **完全 host-neutral** | 只读 `input.ownerIdentityConfigured` |

**外加定量证据门**（`promotion-readiness-evaluator.ts:40-43, 65-68`）—— **完全 host-neutral**：

```
observed === null            → unavailable / shadow_telemetry_source_unavailable
observed < 20                → evidence_insufficient
matched < 3                  → evidence_insufficient
neutralControl < 1           → evidence_insufficient
shadowAgeMs < 24h            → evidence_insufficient
shadowSummary.errors > 0     → failed / unresolved_shadow_unhealthy_evidence
```

### 10.1 三个重点检查的精确判定

| 检查 | 算法是 OpenClaw-specific 吗？ | 数据是 OpenClaw-specific 吗？ | 结论 |
|---|---|---|---|
| `runtime_compatibility` | **否**（一个 `validateHostContract(...) ? ...`） | 是（contract 对象） | **算法 host-neutral ⇒ 只需 host 数据** |
| `emergency_controls` | **否**（一个布尔与运算） | 是（`contract !== null`） | 同上 |
| `runtime_shadow_evidence` | **否**（**纯字段读取**） | 是（`supportsShadowEvidence`） | 同上 |

⇒ 正确方向**确实是**：

```
collectPromotionChecks(hostCapabilities)      ← 现状已接近
```

而**不是**：

```
collectOpenClawPromotionChecks + collectCodexPromotionChecks   ← 应当避免
```

**唯一的改名需求**：`collectOpenClawPromotionChecks` 这个名字已经名不副实（它的算法 100% host-neutral）。
改名属于预算内允许项（"generalize existing function name"），但**不是必需**（P3 最小改动面）。

### 10.2 一个必须尊重的既有事实（EP002-R4）

`origin/main` 已修：`rule-host-writer.ts` 现在把 `caseId` 以 `host-liveness:` 开头的用例
从 reliability 校验的 tool 名单里**排除**，原文：

> their tool names (bash, owner_review_access) are control surfaces, not business tools,
> and are deliberately absent from the workspace host-tool declaration. Feeding them through
> host-dispatch validation made **every promotion permanently blocked**

⇒ `neutralProbes` 的 `toolName` 与**宿主工具词表强耦合**。Codex 的 shell 工具名是
`Bash`（大写，见 `codex-adapter/src/tool-semantics.ts:21-24`），且**没有** `owner_review_access` 工具。
**裸拷贝 OpenClaw 的 neutralProbes 到 Codex 会重演"permanently blocked"。**
这是 E3 架构决定必须包含的内容（§15）。

---

## 11. Duplicate Capability Findings

本轮扫描 `RuleHost / RuleHostInput / RuleHostResult / shadow / activation / promotion /
host capability / event writer / event emitter / host contract / runtime compatibility`，
发现 **6 组重复**（其中 D-1/D-2 是硬重复，其余是重叠/多表达）。

### D-1【硬重复｜P1】两套 RuleCode 执行原语

| | A：`host-runtime/src/rule-implementation-runtime.ts` | B：`openclaw-plugin/src/core/rule-implementation-runtime.ts` |
|---|---|---|
| 入口 | `createNodeRuleImplementationRuntime().evaluateBatch(rules[], input, timeout)` `:93-120` | `loadRuleImplementationModule(source, filename).callEvaluate(input)` `:70-143` |
| 子进程 | `spawnSync(execPath, ['--max-old-space-size=32','-e', SRC])` `:96` | 同 `:109-119` |
| vm 沙箱 | `vm.createContext(Object.create(null))` `:24` | 同 `:33`（经 `nodeVm` polyfill `:74`） |
| helpers | `isRiskPath / getToolName / getEstimatedLineChanges / getBashRisk / getEpTier` `:38-43` | **完全相同的 5 个** `:37-42` |
| 超时 | 编译 1000ms + batch timeout | 编译 1000ms + 进程 3000ms |
| **沙箱加固** | ✅ 显式加固：只传 **JSON 字符串**给沙箱，注释写明防 `.constructor.constructor` 逃逸到宿主 realm（`:27-32`） | ❌ **未加固**：`context.__pdCallInput = input`（`:43-44`）直接把宿主 realm 对象交给沙箱 |

- **语义是否一致**：功能等价；**安全姿态不一致（B 更弱）**。
- **为何存在两个**：依赖方向（core 不能 import plugin）+ 不同调用形态（批量 vs 单条 + `callEvaluate`）。
- **canonical**：`host-runtime` 版（加固、批量、有 output-bytes/超时分类）。
- **legacy/private**：`openclaw-plugin` 版（仅被 `rule-host.ts:32` 使用）。

### D-2【硬重复｜P1】两个 `events_*.jsonl` writer

| | A：`appendEventLogLine`（core，`pain-signal-observability.ts:68-81`） | B：`EventLogService`（plugin，`core/event-log.ts`） |
|---|---|---|
| 形态 | 纯函数 | 类 + 单例缓存（`EventLogService.get`） |
| 落点 | `<stateDir>/logs/events_<date>.jsonl` | 同 |
| 行形状 | `{ts,date,type,category,sessionId,data}` | 同（A 的注释自陈 "same file and entry shape as the OpenClaw EventLog"） |
| 附加能力 | 无（best-effort，失败不抛） | 脱敏（`redactEventData` + `redactTelemetryString`）、daily stats、flush 策略 |
| 用户 | `codex-adapter/src/pd-hook.ts:28,43` | OpenClaw 全路径 |

- **canonical 格式 owner**：core 的 `appendEventLogLine`（已声明）。
- **风险**：格式演化必须双改；新增事件类型时容易只改一边。

### D-3【软重复｜P2】两处 activation SQL loader

`production-rulehost-gate.ts:214` 与 `rule-host.ts:339`（同 JOIN 形状、同过滤条件、独立维护）。
另有 5+ 处**别的目的**的 activations 查询（safety-circuit / receipt-metadata /
safety-store / compat read-model / console models）—— 那些**不是**重复，是不同读取需求。

### D-4【软重复｜P2】`abstraction_layer_v1` 选路 + 两套编排器

`openclaw-plugin/src/index.ts:142-157 shouldUseSharedHostRuntime()` + `:266` 装配。
**这不是重复，是已批准的并存**：ADR A.2.2 原文 "Route unification is a non-goal of PRI-780"。
`abstraction_layer_v1` **默认 false**（`feature-flag-contract.ts:363`）⇒ **OpenClaw 生产走 legacy**。

### D-5【多表达｜P2】「host capability」有四条互不相通的表达

| # | 表达 | 位置 | 形态 |
|---|---|---|---|
| 1 | `OPENCLAW_HOST_LIVENESS_CONTRACT` | `host-liveness-contract.ts:4-20` | 手写常量（promotion 读） |
| 2 | PRI-810 行为探针 | `plugins/.../verify-pinned-runtime-capability.cjs` | 对已安装字节跑 S1–S5（release gate 读） |
| 3 | `HOST_RUNTIME_FLOOR` | `codex-adapter/tests/runtime-pin-guard.test.ts` | 版本下限断言 |
| 4 | `classifyCodexVersion` | `codex-adapter/src/ingestion/codex-version.ts:48` | Codex CLI 版本区间 |

它们**不是同义**（分别衡量：契约形状 / 已装运行时行为 / 已装版本下限 / 宿主 CLI 版本），
但**没有任何一处把它们关联起来**。E3 的架构决定应在其中指定**哪一条是 promotion 的事实来源**。

### D-6【软重复｜P3】promotion 调用点两处，各自硬编码同一常量

`runtime-activation.ts:598,611` 与 `ActivationsConsoleModel.ts:477,533-534`。
**同一事实、两处字面量**，且有 `runtime-activation.test.ts` / Console 测试各自 pin 住。

### D-7【正向发现｜不是重复】`mergeDecisions`

`principles-core/.../internalization/rule-host-evaluator.ts:46` 是**唯一**被两个编排器共享
且**没有第二实现**的 primitive（`rule-host.ts:28` 与 `production-rulehost-gate.ts:8` 都 import）。
⇒ 证明"共享纯逻辑放 core"这一模式在本仓库是可行且已实践的。

---

## 12. Minimum Connection Plan

> 以下是**连接描述**，不是实现方案。全部只使用"允许的变化"（扩既有接口 / 泛化既有函数名 /
> 复用既有类型 / 接线既有 producer→consumer / 加 regression）。

```
Existing activation store (state.db: activations ⋈ pi_artifacts)
        ↓
Existing shared gate (production-rulehost-gate.ts，行循环 + candidates + evaluateBatch 全在)
        ↓
Existing implementation runtime (host-runtime/src/rule-implementation-runtime.ts:93)
        ↓
Existing RuleHostResult (core：rule-host-contracts.ts:81)
        ↓
[ Connection A ]  把非 live 行的评估结果按 activationId 收进 metadata
        ↓
Existing HostEventResult.metadata ("Host-neutral evaluation facts")
        ↓
[ Connection B ]  宿主侧把 metadata.evaluations 写成既有 canonical 事件
        ↓
Existing RuleHostEvaluatedEventData (core types/event-types.ts:465)
        ↓
Existing event-log writer (appendEventLogLine / EventLogService)
        ↓
Existing shadow summary (core rulecode-shadow-summary.ts:15)
        ↓
Existing promotion evaluator (core promotion-readiness-evaluator.ts:23)
        ↓
[ Connection C ]  调用点按真实宿主解析 hostContract / hostRuntimeVersion
        ↓
Existing host capability authority (待 Owner 决定：常量 / declaration / 探针产物)
```

### Connection A —— shadow 评估产出（E1）

| 项 | 内容 |
|---|---|
| **existing producer** | `production-rulehost-gate.ts:254-330` 的行循环（已 SELECT/校验/budget/解析 JSON/取 implementationCode）+ `:349` `implementationRuntime.evaluateBatch(...)` + `:357-378` 结果对齐与 `validateRuleHostResult` |
| **existing consumer** | 同文件 `metadata` 返回字段（`:387`/`:389`）→ 最终到 `rulecode-shadow-summary.ts:32` |
| **existing contract** | `HostEventResult.metadata: Readonly<Record<string, unknown>>`（`host-adapter.ts:154`）；`RuleHostActivationMode`；event 的 `RuleHostEvaluatedEventData`（`activationId?` / `activationMode?` / `matched` / `decision` / `ruleId`） |
| **连接内容** | 在既有分组循环里，对 `action === 'code_tool_hook_shadow_activate'` 的行**不再 `continue`**，而是走同一 `evaluateBatch`，把结果（不 merge、不决定、不改 input）连同 `activationId` 收进 metadata 的 evaluations 明细 |
| **必须保持的不变量** | ① v2 门禁（`:295-304`）**位置不动** ⇒ v2 shadow 自动继续 suspended<br>② budget（`MAX_ACTIVE_RULES` / `RULE_SOURCE_BYTES` / `RULE_BATCH_SOURCE_BYTES`）与 `enforcement === 'eligible'` / `safety_isolated` 判定**继续对 shadow 生效**<br>③ `duplicate_active_activation` 判定是按 `target_ref` 跨模式聚合的（`:254-258`）—— A 不得改变这个语义<br>④ shadow 结果**不得**进入 `mergeDecisions`（否则会 block）<br>⑤ `host_runtime` gate 仍**不落盘** |
| **新增** | 0 |

### Connection B —— evidence 持久化（E2）

| 项 | 内容 |
|---|---|
| **existing producer** | Connection A 产出的 `metadata.evaluations` |
| **existing consumer** | `rulecode-shadow-summary.ts:32`（读 `entry.data.activationId === activationId && activationMode === 'shadow'`） |
| **existing contract** | `RuleHostEvaluatedEventData`（core，已导出）；`appendEventLogLine(stateDir, {ts,type,category,sessionId,data})`（core）；`EventLogService.recordRuleHostEvaluated`（plugin，已存在） |
| **连接内容** | Codex：`pd-hook.ts` 已持有 result 且**已导入** `appendEventLogLine`（`:6`）→ 遍历 `metadata.evaluations` 写 `type:'rulehost_evaluated'`。<br>OpenClaw shared：`gate.ts:583-591` 已在读 `result.metadata` → 在同一处补 shadow 遍历（并把 `activationId` 一并带上，顺带修 NEW-E2）。 |
| **可选** | 若 Owner 希望显式化"谁写"，再扩 `HostEventEmitter` 加一个 rulehost 方法（**非必需**） |
| **新增** | 0（若走 metadata 路径） |

### Connection C —— promotion 的宿主解析（E3 机制层）

| 项 | 内容 |
|---|---|
| **existing producer** | 跨 host capability 事实（**来源待 Owner 决定**，见 §15） |
| **existing consumer** | `runtime-activation.ts:586-602` 的 `collectHostChecks` 端口；`ActivationsConsoleModel.ts:477` |
| **existing contract** | `HostLivenessContract`（shape 已 host-neutral）；`HostLivenessContract` 入参与 `hostRuntimeVersion` 入参；`GovernanceHostKind`；`resolveWorkspaceHostToolSemantics()`（同构 authority pattern 的既有 resolver） |
| **连接内容** | ① `validateHostContract` 的 `version !== 'openclaw-legacy@1'` 字面量比对 → 改为「校验 **shape** + 接受已知版本集合」<br>② 两个调用点改为**按 workspace 真实宿主**解析 contract 与 `hostRuntimeVersion`，不再无条件传 OpenClaw<br>③ `promotion-evidence-snapshot.ts:67` 的 OpenClaw 默认值改为必填或按宿主传入 |
| **新增** | 0（机制层） |

### Connection D（回归护栏，计入 Connection 预算）

| 项 | 内容 |
|---|---|
| **连接内容** | ① **host parity** 对照：同一 activation 在 OpenClaw / Codex 上的 evidence 语义（第一轮 §9 已指出当前"不存在 host parity 测试"）<br>② **v2 × shadow** 回归：断言 v2 artifact 落到 shadow 行时**不产生** shadow 事件、且 warning 含 `rule_context_v2_unavailable`（补 §7.1 发现的护栏缺口）<br>③ `rulehost_evaluated` shadow 行**必须带 activationId**（把 INV-E4 机械固化） |
| **新增** | 0（测试文件，非子系统） |

---

## 13. Delete / Retire Candidates

> **仅列出，不实施。** 每一项都必须在对应 Connection 落地**之后**才可评估。

| # | 候选 | 前置条件 | 是否本轮建议 |
|---|---|---|---|
| R-1 | `openclaw-plugin/src/core/rule-implementation-runtime.ts`（D-1 的 B 版）退化为 `host-runtime` 版的适配层 | 需先解决 `callEvaluate` 的**单条 + 时间边界**调用形态（`host-runtime` 版只有 batch）。<br>⚠️ **附带安全收益**：B 版沙箱未加固（宿主 realm 对象泄漏），统一到 A 版可消除该差异。 | **列为 candidate，但不建议塞进 PRI-813**（跨包改动 + 影响 legacy 生产路由） |
| R-2 | `EventLogService` 的事件行写入委托给 `appendEventLogLine`（格式单一化） | 需保留 `EventLogService` 的脱敏与 daily stats（可留在 service 层，只把 `appendJsonLine` 换成 core 函数） | **列为 candidate**（与 E2 同族，可同批评估） |
| R-3 | 两个 activation SQL loader 收敛 | 需要先证明 `rule-host.ts:339` 与 `production-rulehost-gate.ts:214` 的**后续处理差异**（legacy 有 cache/fingerprint，shared 无）可被同一 loader 表达 | **列为 candidate，不建议本轮做** |
| R-4 | **OpenClaw legacy 路由 / `rule-host.ts` `evaluateDetailed` 视为残留而删除** | — | ❌ **明确反对**。`abstraction_layer_v1` 默认 false ⇒ legacy 是**生产默认路由**；ADR A.2.2 明确 route unification 是 non-goal。 |
| R-5 | `collectOpenClawPromotionChecks` 改名（去 OpenClaw 前缀） | 无（纯命名） | 可选；属"generalize existing function name"预算内 |

---

## 14. Complexity Delta

按 §17 的预算逐项核对**最小连接方案**（§12 A+B+C+D）：

| 类别 | 目标 | 本方案 | 说明 |
|---|---|---|---|
| New subsystem | 0 | **0** | ✅ |
| New store | 0 | **0** | ✅（activations 表已有 shadow 行；`.state/logs` 已有） |
| New DB table | 0 | **0** | ✅ |
| New evaluator | 0 | **0** | ✅（复用既有 `evaluateBatch` + 行循环） |
| New promotion algo | 0 | **0** | ✅（10 项检查与定量门**一行不改**） |
| New registry | 0 | **0** | ✅ |
| New event type | 0 | **0** | ✅（`RuleHostEvaluatedEventData` 已在 core 并导出） |
| New identity type | 0 | **0** | ✅（`activation_id` 已在 row 上） |
| New background task | 0 | **0** | ✅ |
| New writer | 0 | **0** | ✅（`appendEventLogLine` / `EventLogService` 都已存在） |
| 扩既有接口 | 允许 | **1（可选）** | `HostEventResult.metadata` 增一个明细键（既有形状、非新接口）；`HostEventEmitter` 扩展为**可选非必需** |
| 泛化既有函数名 | 允许 | 0（R-5 可选） | `collectOpenClawPromotionChecks` |
| 复用既有类型 | 允许 | **3** | `HostLivenessContract` / `RuleHostEvaluatedEventData` / `HostEventResult.metadata` |
| 接线 producer→consumer | 允许 | **3** | Connection A / B / C |
| 删重复/私有路径 | 允许 | 0（见 §13） | 本轮不删 |
| 加 regression | 允许 | **3** | Connection D |

**⇒ 复杂度增量：0 新能力。** 唯一"非零"是 E3 的**数据权威**决定（§15），
且它**不应**产生新 subsystem / evaluator / algorithm / registry / event type。

---

## 15. Implementation Readiness Verdict

```
E1 (shadow evaluation)   : READY_TO_RECONNECT
E2 (evidence emission)   : READY_TO_RECONNECT
E3 (promotion contract)  : NEEDS_ARCHITECTURE_DECISION
   └ 机制层             : READY_TO_RECONNECT
   └ 数据权威层         : NEEDS_ARCHITECTURE_DECISION（触发 Stop Condition #3）
```

### 15.1 E3 需要 Owner 决定的**唯一**问题

> **「Codex 的 governance capability 事实由谁拥有、如何被验证？」**

三个互斥选项（本轮**不选择**，交 Owner）：

| 选项 | 形态 | 代价 | 与既有原则的关系 |
|---|---|---|---|
| **(i)** 第二个常量 `CODEX_HOST_LIVENESS_CONTRACT`（同文件）+ 泛化 `validateHostContract` | 手写声明 | 同族事实的**第二份手写 SSoT** | 与 AGENTS.md **P4（One Source of Truth）** 有张力；且会与 PRI-810 探针形成第三条表达 |
| **(ii)** 扩既有 `host-tool-declaration` 文件（加 capability 块） | 复用既有 store + resolver | 把治理能力塞进 tool-semantics 文件，**污染边界**（resolver 的"同 rawName 必须同 kind"合并语义对 capability 无意义） | 破坏 §3#11 的单一职责 |
| **(iii)** 让 PRI-810 探针成为 capability 的**生产者**（capability = 被验证的事实，非声明的意图） | 需 1 个新声明载体 | 触碰「New store: 0」预算 | 最符合 P1（Evidence Over Assumption）；且直接解决 §6.1 的假通过 |

**无论选哪条，都必须一并决定**（来自 §10.2 的硬约束）：

1. Codex 的 `neutralProbes` 如何表达 —— Codex shell 工具名是 `Bash`（大写），
   且**没有** `owner_review_access`。裸拷贝会重演 EP002-R4 的 "permanently blocked"。
2. Codex 的 `supportsShadowEvidence` 在 E1 落地前**必须是 `false`**
   （今天是 `true`，但那是读错了常量）。
3. 多宿主工作区（`resolveWorkspaceHostToolSemantics` 会返回 `['codex','openclaw']`）下，
   promotion 应要求 **all / any / 特定宿主** 具备能力？现状是"永远假设 OpenClaw"。

### 15.2 短 implementation boundary（仅 E1 + E2，可先做）

```
允许改动的文件（source）:
  packages/host-runtime/src/production-rulehost-gate.ts     ← Connection A
  packages/codex-adapter/src/pd-hook.ts                     ← Connection B（Codex）
  packages/openclaw-plugin/src/hooks/gate.ts                ← Connection B（OpenClaw shared）

允许改动的文件（test，Connection D）:
  packages/host-runtime/tests/                              ← gate shadow 行为 + parity
  packages/codex-adapter/tests/                             ← v2×shadow 回归 + 事件落盘
  packages/pd-cli/tests/commands/runtime-activation-shadow-telemetry.test.ts

禁止:
  ✗ 新建任何 package / subsystem / store / table / registry / evaluator / event type
  ✗ 改 mergeDecisions / validateRuleHostResult / RuleHostResult 契约
  ✗ 移动或删除 v2 门禁（production-rulehost-gate.ts:295-304）
  ✗ 改 promotion-readiness-evaluator.ts 的 10 项检查或定量门
  ✗ 改 VERDICT 之外的 promotion 行为（Connection C 不在本批）
  ✗ 让 host-runtime 落盘（writer authority 留在宿主侧）
  ✗ 统一两个 rule-implementation-runtime（§13 R-1，独立批次）

必须先建立的护栏（在本批实现之前）:
  1. 断言 v2 artifact 落到 shadow 行时不产生 shadow 事件（补 §7.1 缺口）
  2. 断言 shadow 事件必带 activationId 且 activationMode==='shadow'
  3. 断言 shadow 评估结果不进入 mergeDecisions（不产生 block / requireApproval）
  4. 断言 budget（MAX_ACTIVE_RULES / RULE_SOURCE_BYTES / batch bytes）对 shadow 生效

E4（Codex PostToolUse 无 exitCode → pain 准入死亡）:
  E4 remains separate issue.   ← 本轮不讨论、不修复、不纳入 PRI-813
```

---

## 附录 A — 本报告引用的关键 file:line

### PD（`D:\Code\principles`）

| 主题 | 位置 |
|---|---|
| E1 断点（唯一） | `packages/host-runtime/src/production-rulehost-gate.ts:259-261` |
| gate 的 live metadata 产出 | `packages/host-runtime/src/production-rulehost-gate.ts:379-389` |
| gate 的 activationId 持有 | `packages/host-runtime/src/production-rulehost-gate.ts:261, 325` |
| gate 的 v2 门禁（模式无关） | `packages/host-runtime/src/production-rulehost-gate.ts:295-304` |
| gate 的 budget / enforcement 校验 | `packages/host-runtime/src/production-rulehost-gate.ts:224-258` |
| 执行原语 A（加固） | `packages/host-runtime/src/rule-implementation-runtime.ts:93-120`（沙箱加固注释 `:27-32`） |
| 执行原语 B（未加固） | `packages/openclaw-plugin/src/core/rule-implementation-runtime.ts:70-143`（`context.__pdCallInput = input` `:43-44`） |
| legacy shadow 生产 | `packages/openclaw-plugin/src/core/rule-host.ts:196-254`（`:200` shadowImpls、`:205` stamp、`:246` 返回） |
| legacy v2 门禁 | `packages/openclaw-plugin/src/core/rule-host.ts:552-585`（`supportsContextV2` `:198`） |
| legacy shadow 语义注释 | `packages/openclaw-plugin/src/core/rule-host.ts:515-531` |
| shadow 落盘（唯一 producer） | `packages/openclaw-plugin/src/hooks/gate.ts:114-129` |
| legacy live 落盘 | `packages/openclaw-plugin/src/hooks/gate.ts:131-147` |
| shared live 落盘（读 metadata） | `packages/openclaw-plugin/src/hooks/gate.ts:544-606`（`:545-548` 读 metadata，`:583-591` 写事件） |
| `mergeDecisions`（唯一共享 primitive） | `packages/principles-core/src/runtime-v2/internalization/rule-host-evaluator.ts:46` |
| `RuleHostResult` | `packages/principles-core/src/runtime-v2/internalization/rule-host-contracts.ts:81-90` |
| `LoadedImplementation` | `packages/principles-core/src/runtime-v2/internalization/rule-host-contracts.ts:96-101` |
| canonical 事件类型 | `packages/principles-core/src/runtime-v2/types/event-types.ts:465`（+Schema `:480`） |
| core writer（格式 SSoT） | `packages/principles-core/src/runtime-v2/pain-signal-observability.ts:62-81` |
| `HostEventEmitter` | `packages/principles-core/src/host/host-adapter.ts:181-184` |
| `HostEventResult.metadata` | `packages/principles-core/src/host/host-adapter.ts:141-155`（`:153-154` 注释） |
| `HOST_EVENT_KINDS` | `packages/principles-core/src/host/host-adapter.ts:46-53` |
| shadow summary 过滤 | `packages/principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:26-45`（`:32` 过滤，`:27` activationId 匹配） |
| shadow summary 读取 | `packages/pd-cli/src/commands/runtime-activation.ts:115-119`（`:117` sourceDirsFound===0 → unavailable） |
| promotion 10 项 required | `packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts:3-7` |
| promotion 定量证据门 | `packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts:40-43, 65-68` |
| promotion 生产 6 项 | `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:119-157` |
| `HostLivenessContract` 类型 | `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:4-19` |
| **E3 唯一字面量** | `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:42-46` |
| neutral probes 合成 | `packages/principles-core/src/runtime-v2/activation/openclaw-promotion-checks.ts:96-117` |
| evidence snapshot 默认值 | `packages/principles-core/src/runtime-v2/activation/promotion-evidence-snapshot.ts:67` |
| 唯一 host liveness 常量 | `packages/host-runtime/src/host-liveness-contract.ts:4-20` |
| promotion 调用点（CLI） | `packages/pd-cli/src/commands/runtime-activation.ts:586-602, 603-614`（`:598`、`:611`） |
| promotion 调用点（Console） | `packages/pd-console/src/server/models/ActivationsConsoleModel.ts:477, 483, 533-534` |
| host declaration store | `packages/host-runtime/src/host-tool-declaration.ts`（`saveHostToolDeclaration` `:97`、`loadHostToolDeclarations` `:140`） |
| host declaration resolver | `packages/host-runtime/src/host-tool-semantic-resolver.ts:50-85` |
| `GovernanceHostKind` | `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:47` |
| 路由 flag（默认 off） | `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:363`（`abstraction_layer_v1`） |
| v2 flag（默认 on） | `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:306` |
| v2 flag 消费者表 | `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-lifecycle.ts:165` |
| 路由选择 | `packages/openclaw-plugin/src/index.ts:142-157`、`:266`（shared 的 ruleContextProvider） |
| Codex 装配（无 context provider） | `packages/codex-adapter/src/pd-hook.ts:186-193`（注释 `:65-79`） |
| Codex 已导入 core writer | `packages/codex-adapter/src/pd-hook.ts:6, 28, 43` |
| Codex 工具语义（仅 2 个） | `packages/codex-adapter/src/tool-semantics.ts:21-24` |
| Codex v2 挂起测试 | `packages/codex-adapter/tests/pd-hook.production.test.ts:113-122` |
| Shadow 语义设计 | `docs/architecture/ACTIVATION_CHANNELS.md §3.4`、AC-8（§6 表） |
| **v2 硬边界 ADR** | `docs/adr/2026-06-28-rulecode-context-v2.md` A.2.2 / A.3（`:137-141`, `:158-177`） |

### origin/main 新引入（本轮新增证据）

| 主题 | 位置 |
|---|---|
| PRI-810 能力探针 | `plugins/principles-disciple/scripts/verify-pinned-runtime-capability.cjs`（S1–S5） |
| 探针接线 | `origin/main:package.json:25`（`check:runtime-pin`） |
| 版本下限 | `packages/codex-adapter/tests/runtime-pin-guard.test.ts:65-68`（`HOST_RUNTIME_FLOOR`） |
| EP002-R4（probe 工具名与宿主词表耦合） | `packages/principles-core/src/runtime-v2/activation/writers/rule-host-writer.ts`（origin/main diff） |

## 附录 B — 与前两轮结论的差异

| 议题 | 第一轮结论 | 本轮修正 |
|---|---|---|
| E1 修复方向 | 隐含"把 `evaluateDetailed` 搬到 host-runtime" | **修正**：不需搬移。断点位于 shared gate 自己行循环的 `continue`；`evaluateBatch` 已在同一函数里被调用 |
| E1/E2/E3 分类 | 未分类 | E1/E2 = DISCONNECTED_CAPABILITY；E3 机制同，数据权威 = NEEDS_ARCHITECTURE_DECISION |
| E2 建议 | "扩 `HostEventEmitter.recordRuleHostEvaluated`" | **修正为非必需**。`metadata`（注释即为 "evaluation facts"）+ 已导入的 `appendEventLogLine` 已足够；扩接口降级为可选 |
| E2 writer 归属 | 未讨论 | 明确：**格式 SSoT 在 core，writer authority 留宿主侧**；gate 保持不落盘 |
| E3 影响 | "结构性不可达" | **更严重且更精确**：当前状态是 `evidence_insufficient` + **3 项假通过**（`runtime_compatibility` / `runtime_shadow_evidence` / 部分 `emergency_controls`）—— 能力矩阵在 Codex 上被静默谎报 |
| E1 影响面 | 含 "OpenClaw shared" | **收窄**：`abstraction_layer_v1` 默认 **false** ⇒ OpenClaw 生产走 legacy；shared 的 shadow 缺口今天实际只影响 **Codex** |
| v2 × shadow | 未回答 | **回答：Codex v2 shadow 必须与 v2 live 同等 suspended**，依据 ADR A.3 同构推论；且 shared gate 的 v2 门禁位置**已天然保证**这点 |
| 新发现 | — | EP002-R4 证明 `neutralProbes` 与宿主词表强耦合 ⇒ Codex contract 不能裸拷贝 |
| 新发现 | — | `HOST_RUNTIME_FLOOR`（PRI-810）与 `collectOpenClawPromotionChecks` 的 `runtime_compatibility` 是"兼容性"的两条互不相通表达 |
| 新发现 | — | D-1 两套执行原语中，**插件版沙箱未加固**（宿主 realm 对象泄漏），shared 版已加固 |

---

*审计执行时间：2026-09-16。所有结论可由附录 A 的 file:line 复现。*
*本文件是本次调查的唯一写入。*
