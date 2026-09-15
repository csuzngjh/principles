# PRI-807 Phase 0 — Worker E: Host Capability Matrix

> **角色**：Worker E（Host Parity / Runtime Evidence），只读审计。
> **任务书**：PRI-807 Phase 0「current-main Reality Audit」，Issue #51。
> **基线分支**：`audit/pri-807-phase0-base`。
> **判定纪律**：能力判定只用 **SUPPORTED / PARTIAL / UNSUPPORTED / UNVERIFIABLE**；
> 每条重要事实附 file / symbol / line / 实际 checkout SHA；
> 禁止仅凭 grep 下结论——每格必须追 host 侧 emitter / 事件 / receipt 的真实生产路径。

---

## 1. Scope

回答一个问题：

> **同一 Principle / RuleCode 在 OpenClaw 与 Codex（以及 current main 声明的其它 production host）上，真实可用能力是否一致？哪些链只存在设计图里？**

覆盖任务书 §4.1–§4.4 与 §5：

- 两个 production host 的 11 维能力矩阵；
- current main 声明的 production host 集合；
- shared host-runtime 的共享面与分叉面；
- host-specific emitter 各自写出的事件清单；
- eventLog 的写入端与消费端；
- rulehost receipts 的产生条件与 host 差异；
- shadow summary 数据来源（谁产生、谁聚合）；
- promotion evidence 来源（promote 读什么、该证据在哪个 host 产生）；
- §5 Carry-forward 四项裁决（R-22 / 双 gate / prompt receipt / installed-vs-source parity）。

**不在本文档**：不改 `packages/**`、不修 bug、不建 subsystem、不改 config、不碰 Linear、不修源码。
唯一写入 = 本文件。

---

## 2. Baseline

### 2.1 实际 checkout SHA

```
$ git rev-parse HEAD
cdec05d4bc4252151c7f9f118bdad90f25067594
```

任务书锁定基线：

```
cdec05d4bc4252151c7f9f118bdad90f25067594
```

**BASELINE: SYNCED**（完全一致，无 Drift Warning；结论对本 SHA 负责）。

### 2.2 环境事实

| 项 | 值 | 证据 |
|---|---|---|
| checkout SHA | `cdec05d4b` | `git rev-parse HEAD` |
| 基线分支 | `audit/pri-807-phase0-base` = `cdec05d4b` | `git rev-parse origin/audit/pri-807-phase0-base` |
| Node / npm | `v24.21.0` | `node -v` |
| npm registry 实测 | core `1.284.12` / host-runtime `0.7.4` / codex-adapter `0.4.3` / principles-disciple `1.243.4` | `npm view <pkg> version` |

### 2.3 历史种子

`docs/audit/agent-pipeline-audit-2026-09-15/REPORT.md`（§6 治理下游）与 `VERIFICATION-D.md` 存在，已作事实种子使用；**所有判定均已回源 current main 重验**，未直接沿用历史结论。

---

## 3. Current Authorities

### 3.1 production host 集合（current main 声明）

`HostAdapter` 契约明确：**只有 Codex 实现该接口**。

- `packages/principles-core/src/host/host-adapter.ts:13-16` — "Only `CodexHooksHostAdapter` implements this interface"；OpenClaw 保持直接 `api.on()` 注册。
- 全仓 `implements HostAdapter` 命中唯一：`packages/codex-adapter/src/host-adapter.ts:43`。
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:47` — `GovernanceHostKind = 'openclaw' | 'codex'`（语义注册表）。
- feature flag 注册表只有 `host.codex`（`feature-flag-contract.ts:362`），**没有** `host.openclaw`（OpenClaw 由插件安装即生效）。

**结论**：current main 声明的 production host = **OpenClaw + Codex**，无第三个。

### 3.2 各能力的权威模块

| 能力面 | 权威模块 |
|---|---|
| 统一路由 / 结果校验 | `packages/host-runtime/src/index.ts`（`createHostRuntime` / `createProductionHostRuntime`） |
| RuleHost 评估（host-neutral） | `packages/host-runtime/src/production-rulehost-gate.ts` |
| RuleHost 评估（OpenClaw legacy） | `packages/openclaw-plugin/src/core/rule-host.ts` |
| pain 证据写入（host-neutral） | `packages/host-runtime/src/production-pain-evidence.ts` |
| prompt 注入（host-neutral） | `packages/host-runtime/src/active-principle-prompt.ts` |
| 事件落盘（OpenClaw） | `packages/openclaw-plugin/src/core/event-log.ts`（`EventLog`） |
| 事件落盘（shared/Codex） | `packages/principles-core/src/runtime-v2/pain-signal-observability.ts:68`（`appendEventLogLine`） |
| shadow 聚合 | `packages/principles-core/src/runtime-v2/activation/rulecode-shadow-summary.ts:15` |
| shadow 读取目录 | `packages/pd-cli/src/commands/runtime-activation.ts:69` / `ActivationsConsoleModel.ts:176` |
| promote readiness | `packages/principles-core/src/runtime-v2/activation/promotion-readiness-evaluator.ts:23` |
| host 契约（promote 用） | `packages/host-runtime/src/host-liveness-contract.ts:4`（`OPENCLAW_HOST_LIVENESS_CONTRACT`） |
| tool 语义 | `packages/principles-core/src/runtime-v2/internalization/tool-semantic-registry.ts:128` |
| 安全熔断 | `packages/openclaw-plugin/src/core/rulecode-safety-circuit.ts:14` |

### 3.3 关键结构事实：OpenClaw 有两条门，Codex 只有一条

| 路径 | 入口 | 何时生效 |
|---|---|---|
| OpenClaw legacy | `index.ts:425` → `handleBeforeToolCall` | `abstraction_layer_v1=false`（**默认**，`feature-flag-contract.ts:363`） |
| OpenClaw shared | `index.ts:431` → `sharedHostRuntime.dispatchBeforeToolCall` | `abstraction_layer_v1=true`（显式开启） |
| Codex shared | `pd-hook.ts:186-193` → `createProductionHostRuntime` | 始终（无 legacy 分支） |

`packages/openclaw-plugin/src/index.ts:140-156`（`shouldUseSharedHostRuntime`）是这条分叉的唯一权威。

---

## 4. Contract Map — 能力矩阵

**判定词**：SUPPORTED / PARTIAL / UNSUPPORTED / UNVERIFIABLE。
**注意**：OpenClaw 两列分别给出（legacy 是默认路径，shared 是显式开启路径），因为二者能力不等价。

| # | Capability | OpenClaw (legacy) | OpenClaw (shared) | Codex | Authority | Evidence（生产路径） |
|---|---|---|---|---|---|---|
| 1 | signal ingestion | PARTIAL | PARTIAL | PARTIAL | `signal-collector-host.ts` / `governance-signal-admission.ts` | **OpenClaw**：`prompt.ts:406` `detectSync` 从用户消息取纠正信号（关键词恒开；LLM 深判受 `signal_collector` 旗标门控，`feature-flag-contract.ts:195` 默认 OFF）。**Codex**：不走 `detectSync`；走 transcript 摄取 `pd-hook.ts:97-124` `runConversationIngestion`，受 `codex_conversation_ingestion` 门控（`feature-flag-contract.ts:427` **默认 OFF**）。两者**机制完全不同**（实时消息 vs 事后 transcript），非同一实现的两宿主接线 |
| 2 | pain admission | SUPPORTED | SUPPORTED | SUPPORTED | `production-pain-evidence.ts` | **两宿主共用**同一 handler（`index.ts:243-248` 默认装配；Codex 于 `pd-hook.ts:186` 注入 `hostKind:'codex'`）。实测：Codex 侧 `tool_calls` 落行（`pd-hook.production.test.ts:66-74`）；pain 行写入受 `admitted` 条件约束（`production-pain-evidence.ts:382`）：`outcome.failure && WRITE_TOOLS.has(toolName) && trigger.shouldCreateDiagnosticTask` |
| 3 | prompt injection | SUPPORTED | SUPPORTED | SUPPORTED | `active-principle-prompt.ts:26` | **OpenClaw**：`index.ts:258-265` → `handleBeforePromptBuild`。**Codex**：`pd-hook.ts:186-193` 共享 runtime 的 `beforePromptBuild`（`index.ts:250-295`），输出经 `output-encoder.ts:35` 的 `additionalContext`。实测：`pd-hook.production.test.ts:135` 断言 `additionalContext` 含注入文本 |
| 4 | RuleHost evaluation | SUPPORTED | SUPPORTED | PARTIAL | `production-rulehost-gate.ts:134` / `rule-host.ts:194` | **OpenClaw legacy**：`rule-host.ts:194 evaluateDetailed`，自载 SQLite 激活。**OpenClaw shared**：`production-rulehost-gate.ts:137`。**Codex**：同一 shared gate——**但 v2 规则被结构性挂起**：`pd-hook.ts:190-191` 明确**不传** context provider → `production-rulehost-gate.ts:300-302` 命中 `rule_context_v2_unavailable` 跳过。实测：`pd-hook.production.test.ts:113-122` 证明 v2 规则在 Codex 放行且 stderr 带结构化 unsupported 注记。v1 规则在 Codex 可正常评估（实测可 deny） |
| 5 | shadow mode | SUPPORTED | **UNSUPPORTED** | **UNSUPPORTED** | `rule-host.ts:199-213` | **唯一产生点**在 OpenClaw legacy：`rule-host.ts:200` 过滤 `activationMode==='shadow'`，`:202-205` 逐个 `evaluate` 并 push `shadowDecisions`。**shared gate 完全无 shadow 分支**：`production-rulehost-gate.ts:260` 显式 `if (row.action !== 'code_tool_hook_live_activate') continue;`——shadow 激活被静默跳过（无 warning）。故 OpenClaw shared 与 Codex **都不执行 shadow 评估** |
| 6 | `rulehost_evaluated` evidence | SUPPORTED | PARTIAL | **UNSUPPORTED** | `event-log.ts:191` | **OpenClaw legacy**：`gate.ts:114-129`（shadow）+ `:134-144`（live，带 `activationId`）。**OpenClaw shared**：`gate.ts:584-588`（仅 live；**不带 `activationId`**，见 §6 NEW-E2）。**Codex**：emitter 只实现 `recordRuntimeV2ActivationsInjected` + `recordToolCall`（`pd-hook.ts:25-51`），shared gate 全文**零**事件写入（`production-rulehost-gate.ts` 无 `appendEventLogLine`）。故 Codex 恒无 `rulehost_evaluated` |
| 7 | promote readiness | SUPPORTED | PARTIAL | **UNSUPPORTED** | `promotion-readiness-evaluator.ts:23` / `runtime-activation.ts:115` | promote 证据读 `.pd/logs` + `.state/logs` 的 `events_*.jsonl`（`runtime-activation.ts:69,86-111`）。Codex 虽写同构文件（`pd-hook.ts:189` → `.state/logs`），但**不含 `rulehost_evaluated`**（#6）→ `summarizeRuleCodeShadowEvents`（`rulecode-shadow-summary.ts:32`）恒 `observed=0` → `promotion-readiness-evaluator.ts:41-43` 判 `shadow_telemetry_source_unavailable` → `status='unavailable'`。OpenClaw shared 同理（无 shadow 事件），仅 legacy 路径可达 |
| 8 | live enforcement | SUPPORTED | SUPPORTED | PARTIAL | `production-rulehost-gate.ts:382-389` | **OpenClaw legacy**：`gate.ts:149-191` 完整（block + requireApproval + auto_correct）。**OpenClaw shared**：`gate.ts:543-580 handleSharedRuleHostResult` 处理 deny。**Codex**：仅 `deny` 可编码（`output-encoder.ts:26` 限定 `deny` 只对 `before_tool_call` 合法）；shared gate 的 `mergeDecisions` 可返回 `requireApproval`/`auto_correct`（`rule-host-evaluator.ts:88-92`），但 `production-rulehost-gate.ts:382` 只特判 `block`，其余落回 `allow`（`index.ts:149-153` 的 result 语义校验也拒绝带 reason 的非 deny）→ **approval/auto-correct 语义在 Codex 与 OpenClaw shared 上丢空**。实测：Codex deny 真实生效并有 BDD 覆盖（`pd-hook.production.test.ts:136-137`） |
| 9 | gate block receipt | SUPPORTED | SUPPORTED | UNSUPPORTED | `gate-block-helper.ts:105` / `gate.ts:120` | `persistGateBlock` 只存在于 `openclaw-plugin`（`gate-block-helper.ts:105`），写出 trajectory `gate_blocks`（`trajectory.ts:803`）+ EventLog `gate_block`。**Codex 无任何 gate_blocks 写者**：全仓 grep `gate_blocks` 在 `codex-adapter/**` 与 `host-runtime/**` 零命中。Codex 的 block 只反映在 stdout `permissionDecision:deny` 与 stderr 诊断，**不产生可对账 receipt** |
| 10 | trajectory persistence | SUPPORTED | PARTIAL | PARTIAL | `trajectory.ts:625` / `production-pain-evidence.ts:388-400` | **OpenClaw**：`tool_calls` + `assistant_turns`（`llm.ts:209` / `trajectory-collector.ts:147`）+ `user_turns` + `gate_blocks`。**Codex**：仅 `tool_calls`/`sessions`（`production-pain-evidence.ts:389-400`）+ governance 观测表；**无 `assistant_turns` 写者**（Codex 不订阅 `llm_output`，`host-adapter.ts:31-41` subscribedEvents 无该事件）→ `run_id` 锚点缺一侧 |
| 11 | rollback | SUPPORTED | SUPPORTED | PARTIAL | `sqlite-activation-safety-store.ts:127,175,273` | **OpenClaw**：`pd activation deactivate`（CLI，`runtime-activation.ts:1549`）、Console `emergency-pause`（`activations.ts:91`）、`emergency-deactivate`（`:90`）、`recover-to-shadow`、以及熔断自动隔离（`rulecode-safety-circuit.ts:70`）。**Codex**：上述 Owner 控制**全部由 OpenClaw/Console 侧产生**（写同一 state.db），Codex 侧唯一自救是 `host.codex.enabled=false`（`pd-hook.ts:153-155`，$pd-disable）。**且 pinned 安装版 gate 不读这些控制表——见 §6 NEW-E1** |

### 4.1 共享 vs 分叉（§4.4 必查第 1 项）

**共享（同一实现、同一语义）**：

- `createProductionHostRuntime` 路由与结果校验（`index.ts:161-209`）；
- `createProductionRuleHostGate`（`production-rulehost-gate.ts:134`）；
- `createProductionPainEvidenceHandler`（`production-pain-evidence.ts:308`）；
- `buildActivePrinciplePromptContext`（`active-principle-prompt.ts:26`）；
- `appendEventLogLine` 行格式（`pain-signal-observability.ts:68`）；
- `runInternalizationConsumerCycle`（`internalization-consumer-cycle.ts`，OpenClaw auto-consumer 与 Companion worker 共用）。

**分叉（各宿主自有）**：

| 事项 | OpenClaw | Codex |
|---|---|---|
| 宿主扩展模型 | in-process `api.on()` | subprocess stdin/stdout |
| tool 语义声明 | `OPENCLAW_TOOL_SEMANTICS`（`constants/tool-semantics.ts`） | `CODEX_TOOL_SEMANTICS`（`tool-semantics.ts:21-24`，仅 `Bash`/`apply_patch`） |
| context provider | 有（`index.ts:266-271 buildRuleContextIfEnabled`） | **无**（`pd-hook.ts:190-191`） |
| 事件 emitter | `EventLog`（含 rulehost_*） | `codexEventEmitter`（仅 2 类） |
| 熔断 | `observeRuleCodeSafety`（`gate.ts:108`） | **无**（零调用者） |
| gate block 记账 | `persistGateBlock` | **无** |
| prompt 排除 | `selectLegacyPrinciplesForPrompt`（legacy 去重） | 无 legacy 层 |
| 额外通道 | `llm_output` / `trajectory` / manual pain | 无 |

### 4.2 eventLog 写入端与消费端（§4.4 必查第 3 项）

**写入端**

| 事件类 | OpenClaw (legacy) | OpenClaw (shared) | Codex |
|---|---|---|---|
| `rulehost_evaluated`(shadow) | ✅ `gate.ts:117` | ❌ | ❌ |
| `rulehost_evaluated`(live) | ✅ `gate.ts:134`（带 activationId） | ✅ `gate.ts:584`（**无 **activationId） | ❌ |
| `rule_enforced` / `rulehost_blocked` | ✅ `gate.ts:152,159` | ✅ `gate.ts:590-591` | ❌ |
| `rulehost_requireApproval` | ✅ `gate.ts:221` | ❌（无 requireApproval 映射） | ❌ |
| `rulehost_auto_correct_*` | ✅ `gate.ts:246,322,386,411` | ❌ | ❌ |
| `rulehost_unhealthy` / `rulehost_skipped` | ✅ `rule-host.ts:747` 等 | ❌ | ❌ |
| `gate_block` | ✅ `gate-block-helper.ts` | ✅ 同 | ❌ |
| `runtime_v2_prompt_activations_injected` | ✅ `prompt.ts:657` | ✅ `index.ts:265` | ✅ `pd-hook.ts:27-35` |
| `tool_call` | ✅ `after-tool-call-helpers.ts:254` | ✅ `production-pain-evidence.ts:321` | ✅ 同 |
| `hook_execution` | ✅ `index.ts` 多处 | ✅ 同 | ❌ |

**消费端**

| 消费者 | 读什么 | 位置 |
|---|---|---|
| shadow summary（promote） | `.pd/logs` + `.state/logs` 的 `events_*.jsonl` | `runtime-activation.ts:69,86-118` |
| Console 遥测 | 同两目录 | `ActivationsConsoleModel.ts:176,197,225` |
| principle stats | 仅 `.state/logs` | `principles-stats.ts:11,171` |
| 熔断 | 读 state.db `activation_control_states`（非 events） | `rulecode-safety-circuit.ts:63` |

**关键落差**：Codex 事件写 `.state/logs`（`pd-hook.ts:189`）——**目录被 reader 覆盖**（`runtime-activation.ts:69` 含 `.state/logs`）——但**事件类型缺失**，故 R-22 不是「目录找不到」而是「事件不存在」。

### 4.3 shadow summary 数据来源（§4.4 必查第 5 项）

- **谁产生**：仅 `gate.ts:114-129`（OpenClaw legacy，逐 shadow 决策写 `activationMode:'shadow'`）。
- **谁聚合**：`summarizeRuleCodeShadowEvents`（`rulecode-shadow-summary.ts:15`），过滤条件 `entry.type==='rulehost_evaluated' && entry.data.activationMode==='shadow'`（`:32`）。
- **谁消费**：`readShadowSummaryForActivation`（`runtime-activation.ts:115-119`）→ `buildPromotionEvidenceSnapshot`（`:604-612`）；Console 走 `readRuleCodeTelemetry`（`ActivationsConsoleModel.ts:221-246`）。
- **数据产生点与聚合点在物理上分属不同包**：产生在 plugin，聚合在 core，读取在 pd-cli/pd-console。

### 4.4 promotion evidence 来源（§4.4 必查第 6 项）

promote 决策读 10 项固定检查（`promotion-readiness-evaluator.ts:3-7`），其中：

- 6 项由 `collectOpenClawPromotionChecks` 产出（`openclaw-promotion-checks.ts:119-156`），其 `runtime_compatibility` / `emergency_controls` / `runtime_shadow_evidence` **全部依赖 `HOST_CONTRACT`**；
- 传入的 host 契约硬编码为 **`OPENCLAW_HOST_LIVENESS_CONTRACT`**（`runtime-activation.ts:598`、`ActivationsConsoleModel.ts:477`）；
- 该契约 `version:'openclaw-legacy@1'`，校验器只接受这一字面量（`openclaw-promotion-checks.ts:42-46`）；
- `hostRuntimeVersion` 亦硬编码 `'openclaw-legacy@1'`（`runtime-activation.ts:611`、`ActivationsConsoleModel.ts:492`）。

**结论**：promote 证据链**按定义只认 OpenClaw legacy**。Codex 上没有对应的 host 契约常量（全仓无 `CODEX_HOST_LIVENESS_CONTRACT`），也没有 Codex 侧 shadow 事件源 → **promote 在 Codex 结构性不可达**（双重断链）。

---

## 5. Confirmed / Fixed / Drifted — §5 Carry-forward 裁决

### 5.1 R-22【P2】Codex 侧无 `rulehost_evaluated` 事件通道 → **CONFIRMED（加强）**

**任务书命题**：Codex 侧无 `rulehost_evaluated` 事件通道 → shadow 证据恒不可得、promote 在该宿主结构性不可达。

**current-main 复核（三道独立证据）**：

1. **生产点唯一**：`recordRuleHostEvaluated` 定义 `event-log.ts:191`；调用点只有 OpenClaw `gate.ts:117,134,584`（+ 测试/seed）。`production-rulehost-gate.ts` 全文无事件写入。
2. **emitter 能力面**：`codexEventEmitter`（`pd-hook.ts:25-51`）仅两方法。`HostEventEmitter` 接口（`host-adapter.ts:181-184`）本身也只有这两个方法——**接口层面就没有 rulehost 通道**。
3. **生产者前置缺失**：即使补 emitter，shared gate 也不产 shadow 决策（`production-rulehost-gate.ts:260` 只处理 live）→ 需同时补两处。

**加强（超出原命题）**：R-22 未涵盖的**两个新增宿主缺口**：

- **NEW-E2**：OpenClaw shared 路径的 live 事件**缺 `activationId`**（`gate.ts:587` 只带 `ruleId`），而 legacy 路径已补（`gate.ts:140-142`，注释明示 ISSUE-023 审计缺口）→ 切到 shared 后 `rulehost_evaluated` 无法对账到规则，**重演 ISSUE-023**。
- **NEW-E3**：shadow 在 OpenClaw shared 与 Codex 上**被静默跳过**（`production-rulehost-gate.ts:260` 无 warning），违反 rc-9（有意义的降级必须可观察）。

**判定**：**CONFIRMED**（并升级为 3 条事实）。

### 5.2 双 gate 并存与其保护差异 → **CONFIRMED（部分表述需修正）**

| 问题 | 裁决 | 证据 |
|---|---|---|
| 两套 gate 是否并存 | **CONFIRMED 并存** | `index.ts:424-431` 二分支；`shouldUseSharedHostRuntime`（`:140-156`） |
| 各自保护什么 | **CONFIRMED 不等价** | legacy 覆盖 shadow + live + requireApproval + auto_correct + 熔断 + gate_block 记账；shared 仅 live deny + gate_block 记账 |
| 默认走哪条 | **CONFIRMED legacy** | `abstraction_layer_v1` = `quiet` + `enabled:false`（`feature-flag-contract.ts:363`），ADR-0020 §10.5（`docs/adr/0020-codex-cli-host-adapter.md:332`）规定 `true` 仅用于受控 parity 验证 |
| 测试各覆盖谁 | **CONFIRMED 覆盖不均** | legacy：`gate-rule-host-pipeline.test.ts`、`gate-rule-context-v2.vm-e2e.test.ts`、`rule-host-sqlite-source.test.ts`、`j10-rule-governance-states.test.ts` 等 8+ 文件。shared：`host-runtime-registration.test.ts`（路由）+ `bdd/openclaw-shared-host-runtime-parity.steps.test.ts`（3 条路径：prompt/gate/pain）。**无任何测试覆盖 shared 路径的 shadow 行为**（`host-runtime/tests/*.ts` 全文 `shadow` 仅出现在 `safety_isolated` 提示串中） |

**修正（相较历史表述）**：历史 D 轮 NEW-10 表述为「护栏只在 shared gate」。current main 复核后需限定：**预算/退役符号护栏在 shared gate 与 legacy 均有**（shared `production-rulehost-gate.ts:318-323,341-343`；legacy `rule-host.ts:611-631`），**但熔断护栏只在 legacy**（`rulecode-safety-circuit.ts` 唯一调用者 `gate.ts:108` + `rule-host.ts:747`，shared 路径无）。

**判定**：**CONFIRMED**（表述限定后成立）。

### 5.3 prompt principle 的 runtime exposure 是否有 receipt（PR #1663 后现状）→ **CONFIRMED / 部分为 PARTIAL**

| 项 | OpenClaw | Codex | 证据 |
|---|---|---|---|
| 注入事件 | SUPPORTED | SUPPORTED | `prompt.ts:657` / `index.ts:265` / `pd-hook.ts:27` |
| `runId` 绑定 | SUPPORTED（DIRECT） | PARTIAL（仅事件内） | OpenClaw `prompt.ts:664` 的 `runId` 直绑 `assistant_turns.run_id`（`trajectory.ts:633` 写 `run_id`）；Codex 把 `turn_id` 映射为事件 `runId`（`index.ts:276`），但**Codex 无 `assistant_turns` 写者** → 无 DB 侧锚点 |
| 事件目录 | `.state/logs` | `.state/logs`（同构） | `event-log.ts:62` / `pain-signal-observability.ts:73` |
| 消费 | `principles-stats.ts:171`（仅 `.state/logs`） | 同（目录一致） | — |

**结论**：**文本原则注入在 2 个 host 上都有 receipt 事件**（`runtime_v2_prompt_activations_injected`），且 PR #1663（PRI-750，commit `b17934b6`）后 `runId`/`toolCallId` 已注入（`host-adapter.ts:75-83`）。
**PARTIAL 项**：Codex 的 receipt 有事件级 `runId` 但无 DB 侧 `assistant_turns.run_id` 锚点（`index.ts:257-259` 注释自陈「the Codex DB-side anchor is a follow-up」）→ **receipt 的「turn 级对账」在 Codex 只能靠事件文件**。

**判定**：**CONFIRMED**，其中 Codex 侧 DB 锚点 = **PARTIAL**（已知的、注释自陈的 follow-up）。

### 5.4 installed runtime 与 source runtime 是否同 contract → **DRIFTED（严重，见 §6 NEW-E1）**

任务书提示历史 PRI-665（1.229.0 node_modules 旧副本分叉崩溃）。**current main 复核结论：又出现一次同类分叉，且这次影响的是 Owner 紧急控制**。

`plugins/principles-disciple/runtime-version.json` 锁定：

```json
{ "codexAdapter": "0.1.0", "hostRuntime": "0.1.0", "core": "1.252.0" }
```

**实测（真实 npm 安装 + 真实调用）**，pinned `host-runtime@0.1.0` 与 repo source 的能力面**不一致**：

| 能力 | repo source（`cdec05d4b`） | pinned 0.1.0（真实安装） | 实测结果 |
|---|---|---|---|
| 全局紧急暂停 | `production-rulehost-gate.ts:198-208` 读 `global_rulecode_pauses` | **无该查询** | 塞入 paused 行后 pinned **仍然 deny**（暂停被无视） |
| 安全隔离 | `:242-245` 检查 `enforcement==='safety_isolated'` | **无该检查** | `enforcement='safety_isolated'` 后 pinned **仍然 deny** |
| 控制状态校验 | `:246-249` 要求 `enforcement==='eligible'` | **无该检查** | 同上 |
| 退役契约符号豁免 | `:318-323` `scanRetiredContractSymbols` | **无** | 引 `recentThinking` 的规则在 pinned 上**照常执行并 deny** |

**对照**：`host-runtime@0.1.1` 起已含这两处守卫（`global_pause=1 control_states=1`），`0.7.4` 与 repo source 守卫面一致。即 **0.1.0 → 0.1.1 之间引入的 Owner 控制护栏，从未进入 Codex 用户实际安装的 pinned 版本**。

**实测复现摘要**（Node v24.21.0，`npm install @principles/codex-adapter@0.1.0 @principles/host-runtime@0.1.0 @principles/core@1.252.0`）：

```
baseline (无暂停):        {"decision":"deny","reason":"PINNED_DENY"}          ← 规则生效
+ global_rulecode_pauses: {"decision":"deny","reason":"PINNED_DENY"}          ← 暂停被无视
+ enforcement=safety_isolated: {"decision":"deny","reason":"PINNED_DENY"}     ← 隔离被无视
+ 退役符号规则:            {"decision":"deny","reason":"RETIRED_RULE_EXECUTED"} ← 退役契约被执行
```

**同场景在 `host-runtime@0.7.4`**：

```
baseline:                 {"decision":"deny","reason":"PINNED_DENY"}
+ global pause:           {"decision":"allow","warnings":["global_rulecode_pause_active; ..."]}   ← 暂停生效
+ safety_isolated:        {"decision":"allow","warnings":["activation_safety_isolated: act1; ..."]} ← 隔离生效
+ 退役符号规则:            {"decision":"allow","warnings":["legacy_rule_contract_dependency: recentThinking ..."]} ← 正确跳过
```

**判定**：**DRIFTED**。`pinned ≠ source`，且分叉落在 Owner 紧急控制面 → 定级 **P1**（见 NEW-E1）。

### 5.5 §5 各项总表

| 项 | 判定 |
|---|---|
| R-22 | **CONFIRMED**（并加强为 3 条） |
| 双 gate 保护差异 | **CONFIRMED**（熔断护栏限定为 legacy-only） |
| prompt receipt | **CONFIRMED**（Codex DB 锚点 = PARTIAL） |
| installed vs source contract | **DRIFTED（P1）** |

---

## 6. NEW Findings

### NEW-E1【P1】pinned Codex runtime（host-runtime@0.1.0）不实施 Owner 紧急控制，且执行退役契约规则

- **ID**：NEW-E1
- **Severity**：**P1** —— 判据：Owner gate 被绕过 + active RuleCode 高风险执行。Owner 在 Console 上执行 `emergency-pause`（全局暂停全部 live RuleCode）后，**Codex 用户机器上 pinned 安装的 gate 继续执行并 deny/allow**；`safety_isolated`（熔断自动隔离）同样被无视。这不是「无旁路」而是**旁路已存在且无人接线却已被实际安装**。
- **Claim**：current main 的 Codex 安装链（`$pd-setup` → `runtime-version.json` 的 pins）装的是 `host-runtime@0.1.0`，其 gate 缺 3 处生产守卫（全局暂停、`enforcement` 校验、退役契约扫描），使 Owner 控制在该宿主上不可依赖，并使已退役契约的规则照常执行。
- **Evidence**：
  - pins：`plugins/principles-disciple/runtime-version.json:2-4`（`hostRuntime: "0.1.0"`）；安装脚本按其拉取 `plugins/principles-disciple/scripts/pd-setup.cjs:119,143-145`。
  - repo source 守卫：`packages/host-runtime/src/production-rulehost-gate.ts:198-208`（global pause）、`:246-249`（enforcement 校验）、`:318-323`（退役符号）。
  - pinned 0.1.0 实测缺守卫：`npm pack @principles/host-runtime@0.1.0` → `dist/production-rulehost-gate.js` 全文 **0** 次 `global_rulecode_pauses` / `activation_control_states`；0.1.1 起为 1/1。
  - 实测复现（上文 §5.4 四组对照 + 0.7.4 对照）。
  - 轮换断层窗口：`@principles/host-runtime` 0.1.0 发布于 2026-08-14；守卫由 `41cf97ee`（2026-08-21，PRI-434/rollout）与 `19df0f9c`（2026-08-21，durable safety isolation）引入；pins 自 `3dbcb24f`（2026-08-15）后**再未更新**。
- **Why it matters**：PD 的核心承诺是「Owner 批准 / 可停用 / 可回滚」。在 Codex 宿主上，pinned runtime 让**紧急暂停与安全隔离失效**——这是产品边界（`docs/product/PRODUCT_IDENTITY.md` 的 reversible 语义）的实质破口，而非普通 bug。同时退役契约规则被执行会**静默改变 owner-approved 语义**（旧 RuleCode 读 `recentThinking` 得 `undefined`，行为漂移）。
- **Affected stage**：live enforcement / gate block / rollback（能力矩阵 #8、#11）。
- **Current protection**：**无**。`codex-plugin-bundle.test.ts:467-468` 把 `'0.1.0'` 断言成了**期望值**（fixture 复读 pins 文件，只证明脚本按 pin 安装，**不证明 pin 是最新/正确**）。无任何测试比较 pins 与 npm latest，也无测试对 pinned runtime 断言守卫存在。

### NEW-E2【P2】OpenClaw shared 路径的 live `rulehost_evaluated` 缺 `activationId`

- **Severity**：**P2** —— 判据：host 间证据语义不一致 + 审计可对账性回退。
- **Claim**：legacy 路径已按 ISSUE-023 补齐 `activationId`（`gate.ts:140-143`），shared 路径的事件不带该字段（`gate.ts:584-588`）。一旦 `abstraction_layer_v1` 开启，`rulehost_evaluated` 无法对账到具体激活 → **ISSUE-023 已修缺口在 shared 路径重演**。
- **Evidence**：`packages/openclaw-plugin/src/hooks/gate.ts:587`（`ruleId, activationMode: 'live'`，无 `activationId`）对比 `:142`（`activationId: report.liveDecisionActivationId`）；shared gate 的 result `metadata` 只在 deny 时带 `ruleId`/`principleId`（`production-rulehost-gate.ts:387`），allow 时甚至无 ruleId。
- **Why it matters**：Owner 在 Console 上按 activation 维度审计「这条规则实际评估了多少次」时，shared 路径统计会静默偏低（事件存在但不归属），而降级无提示（rc-9 面）。
- **Affected stage**：rulehost_evaluated evidence（#6）。
- **Current protection**：`bdd/openclaw-shared-host-runtime-parity.steps.test.ts` 覆盖 prompt/gate/pain 三路径，**未断言事件字段完备性**。

### NEW-E3【P2】shadow 激活在 shared gate 上被静默跳过（无结构化 warning）

- **Severity**：**P2** —— 判据：核心价值闭环（shadow → promote）在 shared/Codex 不可达，且降级不可观察。
- **Claim**：`production-rulehost-gate.ts:260` 对非 live 激活 `continue` 且**不 `addWarning`**，于是 shadow 激活既不被评估也不被报告。用户/审计者无法从任何输出知道「有 N 条 shadow 激活被跳过」。
- **Evidence**：`packages/host-runtime/src/production-rulehost-gate.ts:259-261`（`if (!row || row.action !== 'code_tool_hook_live_activate') continue;`，无 warning）；对照 legacy 在 shadow 加载时会显式 warn（`rule-host.ts:525-530`，含 nextAction）。
- **Why it matters**：shadow 是 PD「先观察再启用」的核心安全机制。在 shared/Codex 上它不工作且无提示，Owner 会误以为「已在观察」，实际 `observed=0` 直到 promote 时才以 `unavailable` 形式暴露（晚发现问题）。
- **Affected stage**：shadow mode（#5）→ promote readiness（#7）。
- **Current protection**：无。

### NEW-E4【P2】Codex 无 gate block receipt（`gate_blocks` 表零写者）

- **Severity**：**P2** —— 判据：核心价值闭环的「证据」一环在 Codex 不可达。
- **Claim**：Codex 的 deny 只体现为 stdout `permissionDecision:deny` + stderr 诊断；不写 `gate_blocks`、不写 `gate_block` 事件、不写 receipt ledger。
- **Evidence**：`persistGateBlock` 唯一定义 `packages/openclaw-plugin/src/hooks/gate-block-helper.ts:105`；`gate_blocks` 写入唯一生产点 `packages/openclaw-plugin/src/core/trajectory.ts:803`。`codex-adapter/**` 与 `host-runtime/**` 对 `gate_blocks` **零命中**。对照 `production-pain-evidence.ts:321` 证明 Codex 确实会走共享写路径（tool_call 有写），差异是「无 gate_block 记账器」。
- **Why it matters**：Owner 在 Console 看「今日拦截数」读 `gate_blocks`（`GovernanceConsoleModel.ts:464-473`）——Codex 上的拦截**不计入**，治理统计系统性偏低。
- **Affected stage**：gate block receipt（#9）。
- **Current protection**：无（Codex 生产测试只断言 stdout/stderr 与 `tool_calls`）。

### NEW-E5【P2】Codex 无安全熔断（`observeRuleCodeSafety` 零调用者）

- **Severity**：**P2** —— 判据：host 间保护不一致，且该保护是「RuleCode 行为失控」的自动兜底。
- **Claim**：熔断（protected capability 命中、连续错误、超范围 block 比例等 → 自动 `safety_isolate`）只在 OpenClaw 挂载。Codex 既不调用熔断，也不因熔断结果放行。
- **Evidence**：`observeRuleCodeSafety` 定义 `packages/openclaw-plugin/src/core/rulecode-safety-circuit.ts:14`；调用者仅 `gate.ts:108`（legacy）与 `rule-host.ts:747`（插件内）。`production-rulehost-gate.ts` 与 `codex-adapter/**` 零引用。
- **Why it matters**：熔断是「规则开始大规模误拦时自动止损」的唯一自动化机制。Codex 上一条行为退化的 live 规则会**无限期**执行，只能靠 Owner 手动 `emergency-deactivate`——而该手动路径在 pinned 版本上还被 NEW-E1 削弱。
- **Affected stage**：live enforcement（#8）→ rollback（#11）。
- **Current protection**：无。

### NEW-E6【P3】Codex 无法表达 `requireApproval` / `auto_correct`，且该降级不可观察

- **Severity**：**P3** —— 判据：文档/契约漂移 + latent debt（两宿主 decision 语义面不等价，但 v2-only 生成契约使 `auto_correct` 实际不可产出）。
- **Claim**：shared gate 的 `mergeDecisions` 可返回 `requireApproval`/`auto_correct`（`rule-host-evaluator.ts:88-92`），但 `production-rulehost-gate.ts:382` 只特判 `block`，其余落 `allow`；Codex encoder 也只能编码 `deny`（`output-encoder.ts:26`）。降级无 warning。
- **Evidence**：`packages/host-runtime/src/production-rulehost-gate.ts:379-389`；`packages/codex-adapter/src/codec/output-encoder.ts:26`；`packages/principles-core/src/runtime-v2/internalization/rule-host-evaluator.ts:88-92`。**缓解事实**：v2 生成契约只允许 `allow`/`block`（`artificer-prompt-builder.ts:246`），故 `auto_correct` 实际不可产出；`requireApproval` 在 result 语义校验（`index.ts:149-153`）下也无法带 reason 通过。
- **Why it matters**：契约面与实现面存在无声偏移，未来若放开 v2 decision 集合会静默失效。
- **Affected stage**：live enforcement（#8）。
- **Current protection**：无（间接由 v2 生成契约限制）。

### NEW-E7【P3】pins 的正确性无自动化守护

- **Severity**：**P3** —— 判据：latent debt（NEW-E1 的**制度性成因**）。
- **Claim**：`runtime-version.json` 的 pins 只由发布流程**手工**更新（文件自陈 `note`），仓库无任何检查比较 pins 与 npm latest / 与 repo source 能力面。唯一涉及 pins 的测试把当前值硬编码为期望（`toBe('0.1.0')`），从而**锁死**了 drifts。
- **Evidence**：`plugins/principles-disciple/runtime-version.json:5`（note 自述「Release process: update these pins ... after npm smoke + install tests pass」）；`packages/codex-adapter/tests/codex-plugin-bundle.test.ts:467-468`；全仓 grep：无 workflow / script 触碰 `runtime-version.json`（`.github/workflows/*` 与 `scripts/*` 零命中）。
- **Why it matters**：NEW-E1 不是一次疏忽，而是**没有守护的结构性后果**——同类漂移可再次发生且不可探测。
- **Affected stage**：rollback / 发布包装链路。
- **Current protection**：无。

### NEW-E8【P3】Codex 无 `assistant_turns` 写者 → receipt 无 DB 侧 turn 锚点

- **Severity**：**P3**（与 R-22 同族的可观察性缺口，但代码已自陈）
- **Claim**：OpenClaw 的 `runId` 直绑 `assistant_turns.run_id`；Codex 只能把 `turn_id` 写进 events JSONL，DB 侧无 `assistant_turns` 行。
- **Evidence**：`assistant_turns` 写者唯一：`packages/openclaw-plugin/src/core/trajectory.ts:625`（调用者 `llm.ts:209`、`trajectory-collector.ts:147`）；Codex `subscribedEvents()` 无 `llm_output`（`packages/codex-adapter/src/host-adapter.ts:31-41`）。`packages/host-runtime/src/index.ts:257-259` 注释自陈 "the Codex DB-side anchor is a follow-up"。
- **Why it matters**：跨 host 的「同一 turn 为何被拦」对账在 Codex 只能靠事件文件，无法 JOIN 到 turn 内容。
- **Affected stage**：trajectory persistence（#10）/ prompt receipt。
- **Current protection**：无（已知 follow-up）。

---

## 7. Protection Gaps — 现有 test/guard 是否保护 host parity

| 保护面 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| OpenClaw legacy gate | **强** | `gate-rule-host-pipeline.test.ts`、`gate-rule-context-v2.vm-e2e.test.ts`、`rule-host-sqlite-source.test.ts`、`rule-host-resource-bounds.test.ts`、`j10-rule-governance-states.test.ts` | — |
| OpenClaw shared gate | **中** | `host-runtime-registration.test.ts`（路由）、`bdd/openclaw-shared-host-runtime-parity.steps.test.ts`（prompt/gate/pain 三路径） | shadow 行为零覆盖；事件字段完备性未断言（NEW-E2/E3） |
| Codex 共享 runtime | **中** | `pd-hook.production.test.ts`（三路径 + v2 挂起）、`pd-hook-owner-loop.test.ts`、`pd-hook-slice-b.test.ts` | 无 gate_block / 熔断 / shadow 断言（NEW-E3/E4/E5） |
| **host parity 本身** | **几乎无** | 唯一跨 host 文件是 `PRI-634-F` 的 per-host tool declaration（`host-tool-declaration.ts` + 冲突检测 `host-tool-semantic-resolver.ts:56-66`）；`legacy-rule-contract-parity.test.ts` 只对契约符号 | **不存在**「同一能力在 2 host 是否等价」的对照测试。`bdd/openclaw-...parity.feature` 的 parity 指的是 **legacy vs shared**，不是 OpenClaw vs Codex |
| **pinned vs source** | **零** | `codex-plugin-bundle.test.ts:467-468` 硬编码当前 pin | NEW-E1/E7 |
| 事件通道完整性 | **无** | `HostEventEmitter`（`host-adapter.ts:181-184`）只有 2 方法，接口层无 rulehost 通道 | R-22 在类型层面固化 |
| Owner 控制在非 OpenClaw 宿主 | **无** | `OPENCLAW_HOST_LIVENESS_CONTRACT` 是唯一契约常量；`openclaw-promotion-checks.ts:42` 只接受 `openclaw-legacy@1` | Codex 无 rollback 能力声明，也无测试 |

**总判定**：当前 test/guard **不保护 host parity**。可对账的只有「各宿主自己的三路径能跑通」，没有「两宿主能力等价（或差异被显式登记）」的守护。这恰好解释了 NEW-E1/E4/E5 能长期存在。

---

## 8. Suggested Contract Invariants

> 只写 invariant，不写方案（D9：不做架构设计；实现选项交 Owner）。

**INV-E1**：任何被 production host 实际加载的 runtime 包版本，其**生效能力面**必须与仓库 source 的对应能力面一致，或差异被显式登记为已知的子集并可从用户侧观察。

**INV-E2**：Distribution pin（`runtime-version.json`）必须被至少一项自动化检查约束为「存在 / 可安装 / 能力面符合预期」三者之一失败即 fail-loud。

**INV-E3**：Owner 的 out-of-band 控制（全局暂停 / 单条停用 / 安全隔离）在**每一个** production host 上必须同等生效，或该宿主必须显式声明不支持并提供可观察的 next action。

**INV-E4**：`rulehost_evaluated` 若在某 host 上被写入，其字段集合（至少 `activationId`、`activationMode`、`ruleId`、`decision`、`matched`）在 host 间必须一致；写入路径不得因路径切换而回退既有字段。

**INV-E5**：任一 activation 因模式（shadow/live）或状态（safety_isolated / non-eligible / duplicate）被跳过时，宿主侧必须产生结构化、有界、带 reason 的可观察输出（不得静默 `continue`）。

**INV-E6**：block/deny 的治理记账（gate block receipt）必须在所有 production host 上产生等价的持久事实，或在文档与能力矩阵中显式标为 UNSUPPORTED 并说明后果。

**INV-E7**：promotion 证据的来源必须按 host 命名并分列；不得以单一宿主的契约常量（`openclaw-legacy@1`）充当全部宿主的 runtime capability 声明。

**INV-E8**：跨 host 的 turn/tool 血缘锚点必须落在**同一持久层**（要么两 host 都有 DB 侧的 `assistant_turns.run_id`，要么两 host 都只依赖事件层），不得一侧有 DB 锚点、另一侧只有事件锚点而无声明。

---

## 9. Out of Scope

- 不改 `packages/**`、`src/**`、`.github/**`、`AGENTS.md` 或仓库根任何文件；
- 不修任何 bug（含 NEW-E1..E8 全部条目）；
- 不建新 subsystem / 不新增 feature flag / 不改 config；
- 不碰 Linear、不碰 `.pd/` 运行时状态；
- 不评估 OpenClaw legacy 与 shared 之间**功能语义之外**的差异（如性能、并发）；
- 不评估 non-production host（ADR-0020 提及的 Claude Code / OpenCode / Pi 均为规划，current main 无实现）；
- 不给出 NEW-E1 的修复方案（属设计决策，交 Owner；见 INV-E1/E2/E3）。

---

## A. 附：本报告使用的可复现验证命令

```bash
# 基线
git rev-parse HEAD                        # cdec05d4bc4252151c7f9f118bdad90f25067594

# pinned 版本能力面（关键）
npm pack @principles/host-runtime@0.1.0
tar xzf principles-host-runtime-0.1.0.tgz
grep -c global_rulecode_pauses package/dist/production-rulehost-gate.js   # 0  ← 缺守卫
grep -c activation_control_states package/dist/production-rulehost-gate.js  # 0  ← 缺校验

# 对照 0.1.1 / latest
npm pack @principles/host-runtime@0.1.1 ; # → 1 / 1
npm pack @principles/host-runtime@0.7.4 ; # → 1 / 1（与 repo source 同面）

# 真实安装复现（建 state.db + live 规则 + 暂停/隔离行，调 createProductionHostRuntime）
npm install @principles/codex-adapter@0.1.0 @principles/host-runtime@0.1.0 @principles/core@1.252.0
# 结果：global pause / safety_isolated / 退役契约 三者均被 pinned gate 无视

# repo 守卫位置
sed -n '198,208p;242,249p;318,323p' packages/host-runtime/src/production-rulehost-gate.ts

# R-22 三道证据
grep -rn "recordRuleHostEvaluated" packages/openclaw-plugin/src/hooks/gate.ts
grep -c "appendEventLogLine" packages/host-runtime/src/production-rulehost-gate.ts   # 0
sed -n '25,51p' packages/codex-adapter/src/pd-hook.ts

# shared gate 静默跳过 shadow
sed -n '259,261p' packages/host-runtime/src/production-rulehost-gate.ts
```

**报告结束** — 基线 `cdec05d4bc4252151c7f9f118bdad90f25067594`，BASELINE: SYNCED。
