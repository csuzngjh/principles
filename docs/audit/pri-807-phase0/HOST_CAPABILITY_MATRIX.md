# PRI-807 Phase 0 — Worker E: Host Capability Matrix

> **角色**：Worker E（Host Parity / Runtime Evidence），只读审计。
> **任务书**：PRI-807 Phase 0「current-main Reality Audit」，Issue #40。
> **判定纪律**：能力只用 SUPPORTED / PARTIAL / UNSUPPORTED / UNVERIFIABLE；
> 每条重要事实附 file / symbol / line / 实际 checkout SHA；
> 禁止仅凭 grep 下结论——每格追 host 侧 emitter / 事件 / receipt 的真实生产路径。

---

## 1. Scope

回答一个问题：

> **同一 Principle / RuleCode 在 OpenClaw 与 Codex（以及 current main 声明的其它 production host）上，真实可用能力是否一致？哪些链只存在设计图里？**

本文档覆盖：

- 两个 production host 的能力矩阵（signal ingestion → rollback，共 11 个维度）；
- current main 声明的 production host 集合；
- shared host-runtime 包的共享面与分叉面；
- host-specific emitter 各自写出的事件清单；
- eventLog 的写入端与消费端；
- rulehost receipts 的产生条件与 host 差异；
- shadow summary 的数据来源；
- promotion evidence 的来源与在哪一 host 产生；
- §5 Carry-forward 各项（R-22 / 双 gate / prompt receipt / installed-runtime parity）的 current-main 裁决。

**不在本文档**：不改 `packages/**`、不修 bug、不建 subsystem、不改 config、不碰 Linear。
唯一写入 = 本文件。

---

## 2. Baseline

### 2.1 实际 checkout SHA

```
git rev-parse HEAD
191ae1af588a68950af1de5a3b9265771a7b3e8d
```

任务书要求的基线：

```
cdec05d4bc4252151c7f9f118bdad90f25067594
```

**结论：不等 → BASELINE: NOT SYNCED（Drift Warning）**

### 2.2 Drift Warning

`cdec05d4bc4252151c7f9f118bdad90f25067594` **在本次 checkout 中根本不存在**：

```
$ git cat-file -t cdec05d4bc4252151c7f9f118bdad90f25067594
fatal: git cat-file: could not get object info
```

```
$ git log --all --format=%H | grep -ci "^cdec05d4"
0
```

```
$ git rev-list --all --count
4630
```

因此任务书要求的两个 drift 方向 diff 均无法产出：

- `git log --oneline <HEAD>..cdec05d4b` → `fatal: bad object cdec05d4b`
- `git log --oneline cdec05d4b..<HEAD>` → 同上（起点对象不存在）

**影响面判定**：

- 本 checkout 的 `origin/main` = `191ae1af`（PR #1705 合并点），`git branch -a --contains` 显示
  `cdec05d4b` 既不在此仓库对象库、也不在任何远端分支/标签的可达历史里（4630 个 commit 全扫描）。
- 任务书自述该 SHA 是"本地 Lead Auditor 锁定的基线"，而我们的 checkout 来自 CNB 镜像远端——
  属于**跨仓库/跨镜像的基线不同源**，不是本地操作失误。
- **本文档全部结论仅对实际 checkout SHA `191ae1af` 负责**，不对 `cdec05d4b` 负责。
- 若 Owner 认定 `cdec05d4b` 位于 GitHub 权威仓库且晚于 `191ae1af`，则本矩阵需要在该 SHA 上重跑；
  但当前证据只能证明：**该对象在本执行环境不可得**（UNVERIFIABLE at that SHA）。

### 2.3 历史事实种子（§1 允许项）

任务书提到的 `docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md` 与 `VERIFICATION-D.md`
**在当前 checkout 的 main 上不存在**：

```
$ ls docs/audit/agent-pipeline-audit-2026-09-15/
ls: cannot access 'docs/audit/agent-pipeline-audit-2026-09-15/': No such file or directory
```

它们只存在于未合并分支 `origin/ai/cnb-dev/issue-31`（commit `f0bca97c`）：

```
$ git branch -a --contains f0bca97c
  remotes/origin/ai/cnb-dev/issue-31
```

该分支的 commit message 自述历史发现（**引用，非本文档证据**）：

- 「Codex 无 rulehost_evaluated 事件通道」
- 「/:id/disable 绕过 Owner 授权与决策审计」
- 「词库 hitCount 恒 0 / match() 无生产调用者」

按任务书 §1，这些仅作历史种子；下文 §5 的每条裁决均**重新回源 current main 代码**。

---

## 3. Current Authorities

### 3.1 Host 集合的权威定义

```ts
// packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:47
export type GovernanceHostKind = 'openclaw' | 'codex';
```

**current main 声明的 production host 恰为 2 个**：OpenClaw、Codex。

旁证（同一事实的另一个表达）：

```ts
// packages/principles-core/src/host/host-adapter.ts:187-191
readonly hostId: string;                 // e.g. 'codex', 'openclaw'
readonly hostKind: 'inprocess' | 'subprocess';   // OpenClaw in-process / Codex subprocess
```

`docs/adr/0020-codex-cli-host-adapter.md` §1 提到的 Claude Code / OpenCode / Pi 属
"future hosts (anticipated)"，**未注册进 `GovernanceHostKind`**，不计入本矩阵列。

### 3.2 各能力维度的权威模块

| 维度 | 权威模块 | 文件 |
|---|---|---|
| RuleHost 评估（shared） | `createProductionRuleHostGate` | `packages/host-runtime/src/production-rulehost-gate.ts` |
| RuleHost 评估（OpenClaw legacy） | `handleBeforeToolCall` | `packages/openclaw-plugin/src/hooks/gate.ts` |
| Host 编排/di spatch | `createProductionHostRuntime` | `packages/host-runtime/src/index.ts` |
| OpenClaw host adapter | `createOpenClawHostRuntime` | `packages/openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts` |
| Codex host adapter | `CodexHooksHostAdapter` + `pd-hook.ts` | `packages/codex-adapter/src/` |
| Host 事件发射端口 | `HostEventEmitter` | `packages/principles-core/src/host/host-adapter.ts:181` |
| OpenClaw 事件落盘 | `EventLogService` | `packages/openclaw-plugin/src/core/event-log.ts` |
| Codex 事件落盘 | `codexEventEmitter` | `packages/codex-adapter/src/pd-hook.ts:25` |
| Shadow 聚合 | `summarizeRuleCodeShadowEvents` | `packages/principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts` |
| Promotion 就绪 | `evaluateRuleCodePromotionReadiness` | `packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts` |
| Gate block receipt | `persistGateBlock` / `accountSharedDeny` | `packages/openclaw-plugin/src/hooks/gate-block-helper.ts`、`gate.ts:619` |
| Feature flag registry | `DEFAULT_FEATURE_FLAGS` | `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` |

### 3.3 结构性事实：共享包不拥有 receipt

`HostEventEmitter` 的全部方法（`host-adapter.ts:181-184`）：

```ts
export interface HostEventEmitter {
  recordRuntimeV2ActivationsInjected(data: RuntimeV2PromptActivationsInjectedEventData): void;
  recordToolCall(sessionId: string | undefined, data: ToolCallEventData): void;
}
```

**只有 2 个方法，没有 `recordRuleHostEvaluated`、没有 `recordGateBlock`。**

验证（shared 包与 codex-adapter 全文搜索）：

```
$ grep -rn "rulehost_evaluated|activationMode" \
    packages/host-runtime/src/ packages/codex-adapter/src/ packages/principles-core/src/host/
(无输出)
```

这是本矩阵的**根因结构**：所有 rulehost / gate receipt 事件都活在 OpenClaw 插件里，
shared 契约从未把这些能力提升为 host-neutral 端口。

---

## 4. Contract Map

### 4.1 能力矩阵

判定词：`SUPPORTED` / `PARTIAL` / `UNSUPPORTED` / `UNVERIFIABLE`。

| # | Capability | OpenClaw | Codex | Authority | Evidence（file:symbol:line + 生产路径） |
|---|---|---|---|---|---|
| 1 | signal ingestion | SUPPORTED | SUPPORTED（窄） | OpenClaw: `signal-collector-host.ts`；Codex: `ingestion.ts` | OpenClaw 走 in-process signal collector；Codex 走 transcript/live observation 写入 `ingestGovernanceObservations`（`packages/codex-adapter/src/ingestion/ingestion.ts:108`），由 `turn_complete`/`before_prompt_build`/`after_tool_call` 触发（`pd-hook.ts:99`） |
| 2 | pain admission | SUPPORTED | SUPPORTED | OpenClaw: `hooks/pain.ts#emitPainDetectedEvent`；Codex: `governance-signal-admission.ts#admitOne` | **分叉**：Codex admission 显式只收 codex（`governance-signal-admission.ts:734`：`if (candidate.hostKind !== 'codex') return { ok:false, reason:'unsupported_host_kind' }`）。即同一 admission 模块在 OpenClaw 上**不产生 canonical pain task**；OpenClaw 走自己的 `service.recordPain`（`packages/openclaw-plugin/src/hooks/pain.ts:228`） |
| 3 | prompt injection | SUPPORTED | SUPPORTED | `buildActivePrinciplePromptContext` | 共享路径 `packages/host-runtime/src/index.ts:251`，两 host 都经 `createProductionHostRuntime().beforePromptBuild`；OpenClaw 另有 legacy 分支（`index.ts:379` 依 `runtimeGate.enabled`） |
| 4 | RuleHost evaluation | SUPPORTED | PARTIAL | shared: `production-rulehost-gate.ts`；OpenClaw legacy: `hooks/gate.ts` | Codex 只能跑 shared gate（`pd-hook.ts:186` → `production-rulehost-gate.ts`）。**Codex 不提供 `ruleContextProvider`**（`pd-hook.ts:189-191` 注释 + 未传参），因此 v2 规则被 shared gate 结构化跳过：`rule_context_v2_unavailable`（`production-rulehost-gate.ts:301`），并被 `annotateContextWarnings` 标注为 host-unsupported（`pd-hook.ts:79`）。v1 规则可评估 |
| 5 | shadow mode | SUPPORTED | UNSUPPORTED | OpenClaw: `openclaw-plugin/src/core/rule-host.ts#evaluateDetailed` | shadow 评估逻辑**只存在于 OpenClaw 插件**（`rule-host.ts:201-246` 产出 `shadowDecisions`）。shared gate 的 SQL **只取 live**：`WHERE a.channel='code_tool_hook' AND a.deactivated_at IS NULL` + `if (!row \|\| row.action !== 'code_tool_hook_live_activate') continue`（`production-rulehost-gate.ts:217,260`）→ Codex 的 shadow 激活**从不被评估** |
| 6 | rulehost_evaluated evidence | SUPPORTED | **UNSUPPORTED** | OpenClaw: `event-log.ts#recordRuleHostEvaluated` | 唯一写入者 `EventLogService.recordRuleHostEvaluated`（`packages/openclaw-plugin/src/core/event-log.ts:191`），调用点全在 OpenClaw：`gate.ts:117`（shadow）、`gate.ts:134`（live）、`gate.ts:584`（shared-path 结果映射）。shared 包与 codex-adapter **零调用点**（§3.3 全文搜索） |
| 7 | promote readiness | SUPPORTED | **UNSUPPORTED（结构性）** | `evaluateRuleCodePromotionReadiness` | 读 `evidenceSnapshot.shadowSummary.observed`；`observed === null` → `unavailable` + `runtime_shadow_evidence: shadow_telemetry_source_unavailable`（`promotion-readiness-evaluator.ts:41-42`）。shadowSummary 由 `summarizeRuleCodeShadowEvents` 从 `rulehost_evaluated`+`activationMode==='shadow'` 事件算得（`rulecode-shadow-summary.ts:32`）。**Codex 无该事件 → observed 恒 null → promote 结构性不可达** |
| 8 | live enforcement | SUPPORTED | SUPPORTED（受限） | shared gate | 两 host 都走 `production-rulehost-gate.ts`：block→`deny`（`production-rulehost-gate.ts:382,387`）。Codex 编码只支持 `allow/deny/modify/observe`（`codec/output-encoder.ts:26`：`deny is unsupported for ${kind}` 非 before_tool_call 时抛错）。**`requireApproval` / `auto_correct` 在 Codex 上不存在**（ADR-0020 §10.2.1 明文声明；`gate.ts:211-232` 的实现只在 OpenClaw） |
| 9 | gate block receipt | SUPPORTED | **UNSUPPORTED** | `persistGateBlock` / `accountSharedDeny` | receipt 写入者全在 OpenClaw：`recordGateBlockAndReturn`（`gate.ts:200` legacy）、`accountSharedDeny`（`gate.ts:619` shared-path），落 trajectory `gate_blocks`（`trajectory.ts:798`）+ EventLog `gate_block` + receipt ledger。**shared 包无此端口的任何实现或抽象** |
| 10 | trajectory persistence | SUPPORTED | SUPPORTED | OpenClaw: `core/trajectory.ts`；Codex: `trajectory.ts` via ingestion | Codex 经 `ingestGovernanceObservations` 写入（`ingestion.ts:108-113`）；gate block 行**不写**（见 #9）。即 Codex 有 trajectory，但没有 gate-block 类 trajectory 证据 |
| 11 | rollback | SUPPORTED | SUPPORTED（不同机制） | flags: `host.codex` / `abstraction_layer_v1` | `host.codex` default `enabled: true`（`feature-flag-contract.ts:362`）→ false 时 `pd-hook.ts:153-155` 输出 `{}`+exit 0+结构化 stderr（rc-9）。`abstraction_layer_v1` default `enabled: false`（`feature-flag-contract.ts:363`）→ **OpenClaw 生产默认走 legacy 路由**（`index.ts:144-153`，`shouldUseSharedHostRuntime`） |

### 4.2 Shared host-runtime 包的共享面 vs 分叉面

**共享（两 host 都经 `createProductionHostRuntime`）**：

- `beforePromptBuild`：`active-principle-prompt.ts#buildActivePrinciplePromptContext`（`index.ts:251`）
- `beforeToolCall`：`production-rulehost-gate.ts#createProductionRuleHostGate`（`index.ts:249`）
- `afterToolCall`：`production-pain-evidence.ts#createProductionPainEvidenceHandler`（`index.ts:243`）

**分叉（只有单侧）**：

| 能力 | OpenClaw 专属 | Codex 专属 |
|---|---|---|
| shadow 评估 | ✅ `rule-host.ts` | ❌ |
| rulehost_evaluated 发射 | ✅ `event-log.ts` | ❌ |
| gate block receipt | ✅ `gate-block-helper.ts` | ❌ |
| `requireApproval`/`auto_correct` | ✅ `gate.ts:211-232` | ❌ |
| runtime context provider（v2 规则前置） | ✅ `index.ts:270-275` | ❌（`pd-hook.ts:189` 明确不传） |
| governance signal admission | ❌（`unsupported_host_kind`） | ✅ `governance-signal-admission.ts:734` |
| transcript ingestion | ❌ | ✅ `ingestion.ts` |

### 4.3 Host-specific emitter 写出的事件清单

**OpenClaw**（`EventLogService`，`event-log.ts`）：

```
rulehost_evaluated        (event-log.ts:192)   ← shadow + live
rulehost_unhealthy        （shadow summary 消费）
rule_enforced
rulehost_blocked
rulehost_requireApproval
rulehost_auto_correct_proposed
gate_block                （gate-block-helper.ts）
runtime_v2_prompt_activations_injected (event-log.ts:211)
tool_call
hook_execution
... (OpenClaw 全量事件表)
```

**Codex**（`codexEventEmitter`，`pd-hook.ts:25-51`）**只有 2 个**：

```ts
recordRuntimeV2ActivationsInjected(...)   // → runtime_v2_prompt_activations_injected
recordToolCall(sessionId, data)           // → tool_call
```

```
$ grep -n "recordRuleHost\|rulehost" packages/codex-adapter/src/pd-hook.ts
(无输出)
```

**两个 host 的事件清单不对称：`rulehost_evaluated` 与 `gate_block` 在 Codex 侧完全没有生产者。**

### 4.4 eventLog 写入端与消费端

| 事件 | 生产者 | 消费者 |
|---|---|---|
| `rulehost_evaluated` | OpenClaw only（`gate.ts:117,134,584`） | `pd-cli` `readShadowSummaryForActivation`（`runtime-activation.ts:115`）、`pd-console` `readRuleCodeTelemetry`（`ActivationsConsoleModel.ts:221`）、`rulecode-shadow-summary.ts:32` |
| `runtime_v2_prompt_activations_injected` | 两 host：OpenClaw `prompt.ts:657` + shared `index.ts:265`；Codex `pd-hook.ts:27` | `pd-cli` `principles-stats.ts:49` |

消费端读取路径（两读者同源，ERR-031）：

```ts
// packages/pd-cli/src/commands/runtime-activation.ts:69
export const RULECODE_EVENT_LOG_CANDIDATE_DIRS: readonly string[] = ['.pd/logs', '.state/logs'];
```

OpenClaw 写 `.state/logs`（`EventLogService`）；Codex 写 `.state`（`pd-hook.ts:186`:
`codexEventEmitter(path.join(resolution.workspaceDir, '.state'))`）——即使 Codex 未来补写该事件，
需确认目录约定一致。**当前无效，因为 Codex 根本不产生该事件类型。**

### 4.5 rulehost receipts 的产生条件与 host 差异

**产生条件（shared gate）**：仅当 `mergeDecisions` 返回 `block`
（`production-rulehost-gate.ts:382,387`）→ 返回 `{ decision: 'deny', reason, metadata }`。

**差异**：

| | OpenClaw | Codex |
|---|---|---|
| deny 决策本身 | shared gate 或 legacy gate | shared gate |
| receipt ledger 行 | ✅ `recordPrincipleApplication`（`gate.ts:230-263` / `accountSharedDeny`） | ❌ 无实现 |
| trajectory `gate_blocks` 行 | ✅ `persistGateBlock`（`gate-block-helper.ts:105`） | ❌ 无实现 |
| EventLog `gate_block` | ✅ | ❌ |

**结论：Codex 上"规则真的 block 了工具调用"这件事，除 Codex 自身 stdout 的一次性 deny 外，
在 PD 侧没有任何持久化证据。** 属 P2（核心价值闭环在特定 host 不可达）。

### 4.6 shadow summary 的数据来源

- 谁产生：**只有 OpenClaw**（`rulehost_evaluated` with `activationMode==='shadow'`，`gate.ts:117`）
- 谁聚合：`summarizeRuleCodeShadowEvents`（`rulecode-shadow-summary.ts:17`）
  - pd-cli：`readShadowSummaryForActivation`（`runtime-activation.ts:115`）
  - pd-console：`readRuleCodeTelemetry`（`ActivationsConsoleModel.ts:221`）

### 4.7 promotion evidence 的来源

promote 决策读 `PromotionEvidenceSnapshot`（含 `shadowSummary`）：

```ts
// packages/pd-cli/src/commands/runtime-activation.ts:612
shadowSummary: readShadowSummaryForActivation(workspaceDir, activationId),
// packages/pd-console/src/server/models/ActivationsConsoleModel.ts:493
shadowSummary: telemetry.shadowSummary,
```

该证据的**唯一产地 = OpenClaw 的 `rulehost_evaluated` 事件流**。

→ **在 Codex 上，promotion evidence 的产地不存在。**
即使一个 RuleCode 在 Codex 上被 live 激活并正常 block，它的 `shadow_evidence` 仍为 null，
`runtime_shadow_evidence` check 恒 `unavailable`。**这是 host 间语义不一致，不是缺一个字段。**

---

## 5. Confirmed / Fixed / Drifted（对 §5 Carry-forward 的裁决）

### 5.1 R-22：Codex 侧无 `rulehost_evaluated` 事件通道 → shadow 证据恒不可得、promote 结构性不可达

**裁决：CONFIRMED（current main 仍然成立）**

证据链（逐段回源）：

1. 唯一写入者是 OpenClaw 的 `EventLogService.recordRuleHostEvaluated`（`event-log.ts:191`），
   调用点全部在 `packages/openclaw-plugin/src/hooks/gate.ts`（117 / 134 / 584）。
2. shared 端口 `HostEventEmitter` **没有**该方法（`host-adapter.ts:181-184`）。
3. Codex emitter `codexEventEmitter` 只实现 2 个方法（`pd-hook.ts:25-51`）。
4. 全文搜索确认 shared / codex-adapter / core-host 三处**零出现** `rulehost_evaluated`。
5. 消费端 `promotion-readiness-evaluator.ts:41-42` 把 `observed===null` 升级为
   `unavailable` + `shadow_telemetry_source_unavailable`。

**严重度：P2**（核心价值闭环——shadow→promote 的学习回边——在 Codex 上结构性不可达）。

补充：此为**结构性**不可达，非配置可解。Codex 用户无论如何开启 shadow 激活，
都不会有任何 shadow 评估发生——因为 shared gate 的 SQL 直接过滤掉了 shadow 行
（`production-rulehost-gate.ts:217,260`）。

### 5.2 OpenClaw legacy gate 与 shared gate 的保护差异

**裁决：CONFIRMED（两套 gate 并存，且生产默认走 legacy）**

| | legacy gate | shared gate |
|---|---|---|
| 入口 | `handleBeforeToolCall`（`gate.ts:28`） | `createProductionRuleHostGate`（`production-rulehost-gate.ts:135`） |
| 启用条件 | `runtimeGate.enabled === false`（默认，`index.ts:379`） | `abstraction_layer_v1 = true` |
| 默认值 | **生产默认**（`feature-flag-contract.ts:363` `enabled: false`） | 非默认 |
| shadow 支持 | ✅ | ❌（SQL 只取 live） |
| receipt / gate_blocks | ✅ `gate.ts:200,659` | ✅ 经 `accountSharedDeny`（`gate.ts:619`）+ `onBeforeToolResult` 回调（`index.ts:273-280`） |
| `requireApproval` / `auto_correct` | ✅ `gate.ts:211-232` | ❌（协议收敛为 allow/deny/modify/observe） |
| 超时预算 | 无（同步） | 有 `GATE_DEADLINE_MS = 3_000`（`production-rulehost-gate.ts:33`） |
| artifact 大小预算 | 无 | ✅ `ARTIFACT_CONTENT_BYTES` / `RULE_SOURCE_BYTES` / `RULE_BATCH_SOURCE_BYTES` |
| 退行契约扫描 | 无（旧实现直接读） | ✅ `scanRetiredContractSymbols`（`production-rulehost-gate.ts:318`） |

**保护差异的实质**：shared gate 有更多**预算与硬化保护**（deadline、artifact 预算、retired-contract 扫描），
但**丢失 shadow 与 requireApproval / auto_correct**。legacy gate 反之。

**测试覆盖**：

- legacy：`packages/openclaw-plugin/tests/hooks/gate-rule-host-pipeline.test.ts`、
  `gate-rule-host-real-pipeline.test.ts`、`gate-legacy-contract-compatibility.test.ts`
- shared parity：`packages/openclaw-plugin/tests/bdd/openclaw-shared-host-runtime-parity.steps.test.ts`
  （对应 `.feature` `docs/specs/features/story-a/openclaw-shared-host-runtime-parity.feature`）

**严重度：P2**（两套 gate 语义不等价，且"哪套在跑"由默认关闭的 quiet flag 决定 →
默认路径与受测 parity 路径不是同一条）。

### 5.3 prompt principle 的 runtime exposure 是否有 receipt

**裁决：PARTIAL**

- 有 receipt：`runtime_v2_prompt_activations_injected`，两 host 都发。
  - OpenClaw：`prompt.ts:657`（带 `runId`，PRI-750）
  - shared path：`index.ts:265`（带 `runId: event.context.turnId`）
  - Codex：`pd-hook.ts:27`（带 `runId`，来自 `turn_id`）
- **但 receipt 的粒度不一致**：
  - OpenClaw 的 `prompt.ts:657` 额外带 `legacySelectedCount`、`legacyTotalChars`、
    `legacyTruncated`、`crossBlockDuplicateIds`、`skipReason`、`nextAction`
  - shared path（`index.ts:265`）与 Codex 的只带 v2 侧字段，**没有 legacy 预算字段**
- `toolCallId` 有类型定义（`event-types.ts:163`）但**注入事件路径未填充**
  （`grep toolCallId` 在 `event-log.ts` / codex emitter 中无注入事件上下文）。

**所以**：文本原则注入后**有**可验证回执（回应了 PR #1663 的缺口），
但 **host 间字段集不对称**（P3，文档/证据语义漂移）。

### 5.4 installed runtime 与 source runtime 是否同 contract

**裁决：UNVERIFIABLE（本次审计范围内）**

- 代码层面：`install-layout` / `create-principles-disciple` 存在发布包装链路
  （`packages/install-layout/`、`packages/create-principles-disciple/`）。
- 但 PRI-665 类分叉（node_modules 旧副本）需要**运行时证据**（真实安装目录比对），
  本次为纯只读代码审计、无安装态样本 → 无法判定。
- 相关可查的偏序事实：`packages/create-principles-disciple/tests/codex-host-installer.test.ts`
  与 `docs/audit/install-upgrade-investigation-2026-09-05.md` 存在，可作为后续运行时核实的入口。

**严重度：P3（latent debt / 需运行时核实）**

### 5.5 附带发现（Carry-forward 之外，由 §4 推导）

- §4.2 表格中 `governance signal admission` 是 **Codex-only** 能力
  （`governance-signal-admission.ts:734`）。OpenClaw 走完全不同的 pain 路径。
  → 两 host 的 "pain admission" 语义**不等价**，同一 Principle 的 pain 证据链来源不同。

---

## 6. NEW Findings

### NEW-E1：Codex 无 rulehost_evaluated 通道，shadow→promote 学习回边在 Codex 结构性断裂

- **ID**：NEW-E1
- **Severity**：P2
- **Claim**：Codex host 从不产生 `rulehost_evaluated` 事件，因此
  `shadowSummary.observed` 恒为 null，`runtime_shadow_evidence` check 恒 unavailable，
  RuleCode promote 在 Codex 上结构性不可达。
- **Evidence**：
  - `packages/principles-core/src/host/host-adapter.ts:181-184`（emitter 无该方法）
  - `packages/codex-adapter/src/pd-hook.ts:25-51`（Codex emitter 只有 2 方法）
  - `packages/openclaw-plugin/src/core/event-log.ts:191`（唯一写入者，OpenClaw 专属）
  - `packages/principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:32`（消费）
  - `packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts:41-42`（升级为 unavailable）
  - SHA：`191ae1af588a68950af1de5a3b9265771a7b3e8d`
- **Why it matters**：Golden Journey 的终点是"Agent 行为真实改变"，而 promote 是
  shadow→live 的唯一通道。Codex 用户永远停在 shadow 阶段（且连 shadow 评估都不发生），
  PD 在 Codex 上的"行为内化"闭环缺失最后一环。
- **Affected stage**：shadow mode → promote readiness（§4.1 #5、#6、#7）
- **Current protection**：**无**。所有 `rulehost_evaluated` 测试均在
  openclaw-plugin（`tests/core/event-log.test.ts`、`tests/hooks/gate-*.test.ts`）
  与 pd-cli/pd-console 侧；codex-adapter 测试集（18 个文件）**零覆盖**该事件。
  即：没有任何 test/guard 会因"Codex 不发 rulehost_evaluated"而失败。

### NEW-E2：Codex 上"规则 block 了工具调用"在 PD 侧无持久化证据

- **ID**：NEW-E2
- **Severity**：P2
- **Claim**：shared gate 在 Codex 上可以 deny，但 deny 的 receipt / trajectory 行 /
  EventLog gate_block 三个持久化都不发生。
- **Evidence**：
  - `packages/host-runtime/src/production-rulehost-gate.ts:382,387`（deny 决策）
  - `packages/openclaw-plugin/src/hooks/gate-block-helper.ts:105`（receipt 实现，OpenClaw 包内）
  - `packages/openclaw-plugin/src/hooks/gate.ts:619-668`（`accountSharedDeny`，OpenClaw 包内）
  - `packages/codex-adapter/src/pd-hook.ts:186-195`（dispatch 后只 encode 输出，无 receipt 调用）
  - SHA：`191ae1af`
- **Why it matters**：live enforcement 在 Codex 上"发生了但不可对账"。
  Owner 无法从 Console/CLI 看到 Codex 侧的 enforcement 历史，
  违反 PD 的 Owner-relevant-behavioral-evidence 定位。
- **Affected stage**：live enforcement → gate block receipt（§4.1 #8、#9）
- **Current protection**：**无**。

### NEW-E3：shadow 评估能力只存在于 OpenClaw；shared gate 结构上排除 shadow 激活

- **ID**：NEW-E3
- **Severity**：P2
- **Claim**：shadow 模式不是"host-neutral 能力被 host 少接了一条线"，
  而是**实现本身就在 OpenClaw 插件里**；shared gate 连加载 shadow 行的 SQL 都没有。
- **Evidence**：
  - `packages/host-runtime/src/production-rulehost-gate.ts:260`：`if (!row || row.action !== 'code_tool_hook_live_activate') continue;`
  - `packages/openclaw-plugin/src/core/rule-host.ts:201-246`：shadow 评估唯一实现
  - `packages/host-runtime/src/production-rulehost-gate.ts:217`：SQL 无 shadow 谓词
  - SHA：`191ae1af`
- **Why it matters**：即便未来给 Codex 补 `ruleContextProvider`，
  shadow 仍不会在 Codex 上评估——因为 shared gate 根本不加载 shadow 激活。
  修复成本被显著低估：这不是"补一个 emitter"，而是"把 shadow 能力提升为 shared 合同"。
- **Affected stage**：shadow mode（§4.1 #5）
- **Current protection**：**无**。

### NEW-E4：production default 下 OpenClaw 走 legacy gate，shared parity 不是默认路径

- **ID**：NEW-E4
- **Severity**：P3
- **Claim**：`abstraction_layer_v1` 默认 `enabled: false`，
  OpenClaw 生产默认走 legacy `handleBeforeToolCall`；
  而 host parity 测试（`.feature`）是围绕 shared runtime 写的。
  → **受测路径 ≠ 默认路径**。
- **Evidence**：
  - `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:363`（default false）
  - `packages/openclaw-plugin/src/index.ts:144-153`（`shouldUseSharedHostRuntime`）
  - `packages/openclaw-plugin/src/index.ts:379`、`424`、`482`（依 gate 分支）
  - `docs/specs/features/story-a/openclaw-shared-host-runtime-parity.feature:7`（Background: `abstraction_layer_v1 enabled`）
  - SHA：`191ae1af`
- **Why it matters**：parity 证据只覆盖非默认路径；默认路径（legacy）与 shared
  在 shadow / requireApproval / auto_correct 上语义不同（§5.2）。
  "parity" 的结论不能自动外推到生产默认行为。
- **Affected stage**：live enforcement、shadow mode、gate receipt（§4.1 #5/#8/#9）
- **Current protection**：部分——legacy 有自己的测试集，但没有测试断言
  "legacy 与 shared 在 Owner 可见行为上等价"。

### NEW-E5：host 间 prompt injection receipt 字段集不对称

- **ID**：NEW-E5
- **Severity**：P3
- **Claim**：OpenClaw 的注入 receipt 带 legacy 预算字段（`legacySelectedCount` /
  `legacyTotalChars` / `legacyTruncated` / `crossBlockDuplicateIds` / `skipReason`），
  shared path 与 Codex 不发这些字段；`toolCallId`（`event-types.ts:163`）在注入路径未被填充。
- **Evidence**：
  - `packages/openclaw-plugin/src/hooks/prompt.ts:657-690`（全字段）
  - `packages/host-runtime/src/index.ts:265-280`（v2 字段 + runId）
  - `packages/codex-adapter/src/pd-hook.ts:27-34`（同 shared）
  - `packages/principles-core/src/runtime-v2/types/event-types.ts:160-163`
  - SHA：`191ae1af`
- **Why it matters**：跨 host 读取同一 receipt 的消费者（如 `principles-stats.ts`）
  在 Codex 上会得到字段缺失的语义，属证据语义不一致。
- **Affected stage**：prompt injection（§4.1 #3）
- **Current protection**：**无**（无断言 host 间 receipt 字段一致性的测试）。

### NEW-E6：pain admission 是 Codex-only 能力，两 host 的 pain 链语义不同源

- **ID**：NEW-E6
- **Severity**：P3
- **Claim**：`admitOne` 显式拒绝非 codex host；
  OpenClaw 走自己的 `service.recordPain` 路径。
  → "同一 Principle 的 pain 证据"在两 host 上由不同 authority 产生。
- **Evidence**：
  - `packages/host-runtime/src/governance-signal-admission.ts:734`（`unsupported_host_kind`）
  - `packages/openclaw-plugin/src/hooks/pain.ts:228`（OpenClaw 自有 recordPain）
  - `packages/host-runtime/src/production-pain-evidence.ts:308`（shared pain handler，两 host 共用）
  - SHA：`191ae1af`
- **Why it matters**：pain 是 PD 诊断的输入。两 host 的 pain 若来源不同、
  去重/身份语义不同，则跨 host 的"重复行为模式"诊断不可比。
- **Affected stage**：signal ingestion、pain admission（§4.1 #1、#2）
- **Current protection**：部分——各 host 有测试，但无跨 host pain 语义等价性断言。

---

## 7. Protection Gaps

现有 test / guard 是否保护 host parity？

| 能力面 | 现状 | 缺口 |
|---|---|---|
| Codex hook 契约 | ✅ `codex-adapter/tests/`（18 文件：codec whitelist、g1 contract、pd-hook production、output whitelist） | 覆盖 decode/encode/dispatch，**不覆盖 PD 侧证据产生** |
| OpenClaw legacy gate | ✅ 3 个 pipeline 测试 + BDD feature | — |
| OpenClaw shared gate parity | ✅ `openclaw-shared-host-runtime-parity.steps.test.ts` + `.feature` | 仅 OpenClaw，**非默认路径**（NEW-E4） |
| Codex shadow / promote | ❌ | **零覆盖**：没有任何测试会在 Codex 缺 `rulehost_evaluated` 时失败（NEW-E1） |
| Codex gate receipt | ❌ | **零覆盖**：无测试断言 Codex deny 后有 receipt（NEW-E2） |
| 跨 host 事件清单一致性 | ❌ | 无 contract test 枚举 "每个 host 必须发出的运行事件集合" |
| 跨 host prompt receipt 字段 | ❌ | 无字段集一致性断言（NEW-E5） |
| 跨 host pain 语义 | ❌ | 无等价性断言（NEW-E6） |
| installed vs source runtime | ⚠️ 有 installer 测试，但非运行时比对 | 需运行时证据（§5.4） |

**结构性缺口**：`HostEventEmitter`（`host-adapter.ts:181`）作为唯一的
host→PD 事件端口，**没有把 rulehost / gate receipt 纳入 contract**。
因此"host parity"在类型层面就不可表达——缺一个事件不能编译失败。

**另**：`packages/host-runtime/src/host-liveness-contract.ts` 存在，
但其范围是 host liveness（health probe），**不覆盖能力矩阵**。

---

## 8. Suggested Contract Invariants

> 只写 invariant，不写实现方案（D9：设计决策交 Owner）。

1. **INV-H1（证据产生对称性）**：若某个 host 上存在 `code_tool_hook` 通道的 live 或
   shadow 激活评估，则该 host 必须产生等价的 `rulehost_evaluated` 事件，
   其 `activationId` / `activationMode` / `matched` / `decision` 字段语义在所有 host 间一致。

2. **INV-H2（enforcement 可对账性）**：任何 host 上产生的 `deny` 决策，
   必须在 PD 权威存储中留下可对账的 receipt（trajectory 或等价持久化），
   且跨 host 可查询。

3. **INV-H3（promotion 证据的 host 无关性）**：`runtime_shadow_evidence` check 的
   通过与否，必须只取决于"该 RuleCode 是否真的产生了足够的 shadow 观察"，
   而不取决于"Owner 的默认宿主是哪一个"。

4. **INV-H4（默认路径即受测路径）**：Owner 可见行为契约的 parity 证据，
   必须覆盖各 host 的**默认**配置路由，而不是仅覆盖非默认的 quiet 开关路径。

5. **INV-H5（receipt 字段集 host 无关）**：同一事件类型在任一 host 上的
   必填字段集合相同；host 专属字段必须显式标记可选且不得改变消费端语义。

6. **INV-H6（能力缺口必须可观测）**：任一 host 不支持某能力时，
   该缺口必须在运行时以结构化 reason + nextAction 暴露（rc-9），
   不得表现为"静默零事件"。当前 Codex 的 shadow 不可用属**静默零事件**，
   违反此 invariant。

7. **INV-H7（host contract 可表达性）**：host→PD 的事件端口契约应能表达
   "该 host 支持哪些证据类事件"，使缺失成为类型/契约层面的显式事实，
   而非需要全文搜索才能发现。

---

## 9. Out of Scope

- **不实现任何修复**。本文件只做事实登记与 invariant 建议。
- **不修改** `packages/**`、`src/**`、`.github/**`、`AGENTS.md`。
- **不改 config / feature flag / ADR / Linear**。
- 未覆盖：Worker A–D、F 的职责范围（本轮仅 Worker E 的 host parity 维度）。
- 未覆盖：真实运行时 host 行为（本审计为代码级 + 事件链级证据；
  installed runtime 与 source runtime 的一致性见 §5.4，需运行时证据）。
- 未覆盖：Python/其他语言 host、Claude Code / OpenCode / Pi（未注册为 production host）。
- 未做：任何性能/负载测量；任何对 `cdec05d4b` 基线的结论（该对象不可得，见 §2.2）。

---

## 附录 A：本次审计的搜索与验证命令（可复现）

```bash
git rev-parse HEAD                                         # 191ae1af...

# 基线不存在
git cat-file -t cdec05d4bc4252151c7f9f118bdad90f25067594   # fatal: could not get object info
git log --all --format=%H | grep -ci "^cdec05d4"           # 0
git rev-list --all --count                                 # 4630

# §3.3 emitter 无 rulehost
grep -rn "rulehost_evaluated\|activationMode" \
  packages/host-runtime/src/ packages/codex-adapter/src/ packages/principles-core/src/host/
# (无输出)

# §4.1 #5/#6 shadow + event 只在 OpenClaw
grep -rn "rulehost_evaluated" packages/ --include="*.ts" | grep -v ".test.ts"
# → openclaw-plugin/event-log.ts, gate.ts; principles-core consumers

# §4.1 #7 promote 结构性不可达
grep -n "shadow_telemetry_source_unavailable" \
  packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts

# §4.1 #11 flag 默认值
grep -n "abstraction_layer_v1\|'host.codex'" \
  packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts

# §5.3 prompt receipt 三处发出点
grep -rn "recordRuntimeV2ActivationsInjected" packages/ --include="*.ts" | grep -v ".test.ts"
```

## 附录 B：未验证项（如实声明）

| 项 | 原因 |
|---|---|
| `git log <HEAD>..cdec05d4b` 与反向 diff | 该对象在本次 checkout 对象库中不存在（§2.2） |
| installed runtime vs source runtime 同 contract | 需运行时/安装态证据，超出只读代码审计范围（§5.4） |
| `REPORT.md` / `VERIFICATION-D.md` 的历史结论复核 | 文件不在 current main，仅在未合并分支 `origin/ai/cnb-dev/issue-31`（§2.3） |
| Linear 工单状态 | 零密钥姿态，无法访问（章程 §6） |
