# PD-CAE Stage 1A Offline Replay Contract

> **状态**：Frozen for Stage 1A / 待 Owner 审查；本文件是测试契约，不是生产 ABI，不是实施授权
> **日期**：2026-11-28
> **工单**：PRI-1307（父级 PRI-1306；项目 PD 数据管道演进与学习闭环）
> **代码基线**：`csuzngjh/principles` `e30202366f53df60ccaf7589f7988cf445a52fba`（SPEC/Stage 0 审查基线）；本文撰写时 origin/main 已前进至 `b75e56fd6`，经抽查两份基线间无影响本契约事实的变更（间隔仅为文档与版本号提交）
> **权威输入**：
> - `docs/specs/PD-CAE-SPEC-v1.1-20261128.md`（canonical SPEC v1.1，PR #2816 已入 main）
> - `docs/reviews/PD-CAE-STAGE0-REALITY-AUDIT.md`（Stage 0 审计，结论 LIMITED）
> - `docs/reviews/PD-CAE-STAGE0-OWNER-DECISION.md`（Stage 0 Owner 决策摘要）
> - Linear PRI-1306 描述的 Owner 授权记录：**仅批准 Stage 1A offline work**
>
> **冲突裁决顺序**（本文全篇适用）：Owner 决策（Linear 记录 + Owner 决策摘要）> Stage 0 审计更正 > SPEC v1.1 > SPEC v1.0 审查报告。

---

## 0. 文档性质与阅读指南

本文冻结 Stage 1A 后续所有工单（PRI-1308/1309/1310/1311/1312/1313/1314）共同遵循的离线 replay 测试契约。

**本文是**：

1. 离线测试 fixture 的统一描述结构（Fixture Envelope）；
2. 场景真值标签（Scenario Truth Labels）的唯一权威定义；
3. 三值证据语义、顺序证据、目标归因、宿主证据、覆盖率分类、决策语义、评测结果的冻结口径。

**本文不是**：

1. 生产 ABI。本文定义的所有 fixture 结构、标签、注解词汇都是 **test-only vocabulary**，任何生产代码不得 import 或依赖它们；fixture envelope 不进入任何 `packages/*/src` 生产类型定义；
2. 对 RuleContextV2 的修改（V2 原样保持，包括其已知的 outcome 三值缺陷）；
3. 对 RuleCode / RuleHost / Service Host / 三宿主 Adapter 生产语义的修改；
4. Shadow / Live / Stage 1B+ 的授权。SPEC v1.1 的 Stage 1–4 均为 conditional decision points，本文不构成其中任何一个的批准；
5. 生产阻断阈值定义（本文不设置、也不暗示任何生产阈值）。

**被验证的现有链路**（本阶段只验证，不重新实现）：

```text
tool_calls → RuleContextV2 → RuleCode → Host Gate
```

**机器可读部分**：§2.8 内嵌一份独立 JSON Schema（draft 2020-12），§11 的全部 fixture 示例按该 schema 编写。该 schema 是测试局部资产，不是运行时公共契约（对照 SPEC §5：评估语义的三值不要求立刻新增公共 enum——同理，fixture schema 不要求、也不允许成为公共 ABI）。

---

## 1. Purpose & Scope

### 1.1 目的

本契约服务于**离线 trajectory replay**：在离线、可控、带标签的轨迹上，验证现有治理链路 `tool_calls → RuleContextV2 → RuleCode → Host Gate` 的**证据质量与判断能力**——即：现有链路能否可靠表达证据、区分合理与不合理重试、并识别当前不可评估的边界。

### 1.2 范围约束（逐条对应 Owner 授权）

1. **只做离线 replay**。不运行生产 Shadow，不读取真实 production workspace 数据库，不触碰生产 activation 状态。
2. **不是新增生产治理引擎**。不新建 event DB/table、后台 service/consumer、RuleContextV3、Temporal Engine/DSL、Action Broker、第二套 RuleCode evaluator、独立 Replay Engine 生产组件。
3. **不是新增实时行为监控**。不增加 LLM 实时调用；不改运行时预算。
4. **不改变生产 RuleContextV2**。V2 现状（含 `RuleToolOutcome` 仅 `success|failure|blocked` 与单行 unknown 毒化整窗的行为）作为 **frozen input contract** 被 characterization，不被修改。
5. **不改变 RuleCode 执行语义**。继续复用现有 `evaluate(input, helpers)`、child-process/vm 执行器、`mergeDecisions` 优先级与 Golden Trace replay 入口。
6. **不授权 Shadow 或 Live**。SPEC §8.3 末段"真实生产 Gate 的 Shadow 决策一致"部分按 Owner 授权收窄为：**offline replay 与 production input assembly 的一致性**（即 replay 输入装配路径与生产 `buildRuleHostAction`/`buildRuleHostInput` 的一致性验证），生产 Shadow 一致性验证 defer 到后续 conditional decision point。

### 1.3 成功标准的证据边界

Owner 决策摘要列出的 Stage 1 成功标准中，以下四项依赖真实 workspace 数据统计，**在 Stage 1A 内只能标记为 `UNVERIFIED` / `NOT_MEASURED`**，因为 Linear 授权明确禁止读取真实 production workspace 数据库：

- unknown 行占比及 upgrade 情况（真实分布）；
- backfill/order inversion 是否**真实**发生（真实发生与否）；
- 每宿主可 resource-attributed 的调用比例（真实占比）；
- context unavailable 的真实原因分布（真实分布）。

契约 fixture 可以证明的是**机制层面**的正确性（例如：给定一个 unknown 行，装配行为是什么）；**禁止用 fixture 分布冒充真实数据分布**（对照 `packages/principles-core/tests/fixtures/gate-a-reproducibility/README.md` 的 `NOT_MEASURED`/`AUTHORIZED_REAL_SAMPLE=0` 诚实标记先例）。真实数据统计需要 Owner 另行授权的独立任务。

以下两项不依赖真实数据，属于 Stage 1A 可交付范围：

- 一个 repeated-failure 规则能否在离线 labeled matrix 上区分正控/负控/幂等重试/无效证据；
- replay 与 production RuleContextV2 input assembly 是否一致。

### 1.4 失败归因词汇

首轮失败必须归因到 `data / host / semantic / rule / test` 五类之一（SPEC §9），不得把一切归因于模型。本契约 §10 将此五类编入评测报告词汇。

---

## 2. Fixture Envelope Contract

### 2.1 设计原则

**P-1 四类区分**。每个 fixture 必须显式区分四类信息，禁止混淆：

| 类 | 内容 | 在 envelope 中的位置 | 谁可见 |
|---|---|---|---|
| 1. 真实观测事实 | 模拟生产 `tool_calls` 行与 RuleContextV2 的可观测内容 | `events[].observation`、`currentCall.observation` | 被测系统可见 |
| 2. 离线测试场景的已知真值 | 只有测试 oracle 知道的真值（真实因果顺序、真实结果、幂等性、真实资源同一性） | `events[].truth` | **被测系统不可见**；仅 oracle 用于判定 |
| 3. 被测 RuleCode 的输出 | 规则评测实际产出 | 不在 fixture 中；由执行产生 | 评测报告记录 |
| 4. 最终 Host Gate 的实际效果 | gate/host 层的实际效果 | 不在 fixture 中；由执行产生或标记 UNVERIFIED | 评测报告记录 |

**P-2 禁止循环验证**。fixture 的 label 与 expectation 只能来自：(a) 本契约 §3 的标签定义；(b) 场景作者按 §3 定义的人工/代理判定。**禁止由待测 RuleCode 自己生成 expected label**——例如不允许"先跑规则，再把规则输出写成 expectation"。`provenance.labelAuthority` 字段强制声明标签来源。

**P-3 不复制生产 RuleContextV2**。envelope 不重新定义 history/facts/calls 结构；需要表达 assembled context 时，通过组合引用现有 `RuleContextV2` 类型（与 `GoldenTraceCase.ruleContext` 相同的组合方式，`golden-trace.ts:72-74`）。

**P-4 不成为生产 ABI**。envelope 结构是 test-only vocabulary。禁止：生产代码 import；写入任何生产数据库；作为生产服务间契约。命名上所有 envelope 专有词汇以 `fixture` / `scenario` / `truth` 前缀与生产词汇隔离。

**P-5 不发明证据**。fixture 不得携带生产上不可能产生的证据形态声称其为生产事实（例如：声称某行有 occurredAt；声称 OpenClaw 行有 toolCallId；声称 `blocked` outcome 来自生产写入——`blocked` 在 ABI 中合法但当前无生产 writer）。fixture 可以**构造**任何测试所需状态，但 `observation` 层的每个字段必须对应生产真实存在的字段语义。

**P-6 复用优先**。字段命名复用 `GoldenTraceCaseSchema`（`caseId/toolName/params/expectedDecision/ruleContext`）与 PRI-1208 corpus 先例（版本字段 + provenance 块 + baseline SHA）；词汇复用生产已有的 `EvidenceState`（`yes/no/unknown`）、unavailable reason 字符串、coverage 计数器名。

### 2.2 Envelope 总体结构

一个 fixture 文件描述**一个场景**（一次当前调用 + 其历史事件序列）。顶层结构：

```json
{
  "fixtureVersion": 1,
  "fixtureId": "cae1a-blind-retry-codex-01",
  "scenarioLabels": ["blind_retry_after_failure"],
  "controlClass": "positive_control",
  "description": "……",
  "specRefs": ["SPEC-v1.1 §8.3 item 1"],
  "provenance": { },
  "hostShape": { },
  "events": [ ],
  "currentCall": { },
  "assembly": { },
  "expectations": { },
  "forbiddenInferences": [ ]
}
```

### 2.3 Host Identity（`hostShape`）

声明本场景模拟的宿主形状。**三宿主不强行统一**——每个 fixture 明确属于一个宿主形状；跨宿主场景用 `cross_host_attribution` 标签并在事件级区分 `hostKind`。

| 字段 | 类型 | 含义 |
|---|---|---|
| `host` | `'codex' \| 'workbuddy' \| 'openclaw'` | 宿主形状（必填，单值） |
| `hookRouted` | `boolean` | 该工具调用在此宿主是否会路由到 PD hook。Codex PreToolUse matcher 仅 `Bash\|apply_patch\|pd_submit_pain`（`plugins/principles-disciple/hooks/hooks.json`），其余为 `false` |
| `windowSize` | `number` | 该宿主 RuleContext 窗口大小：OpenClaw 20（`rule-context-assembler.ts:45`）；Codex/WorkBuddy 100（各自 provider 的 `HISTORY_LIMIT`） |
| `identityCapability` | `'host-authoritative' \| 'optional' \| 'absent'` | 调用身份能力：Codex `tool_use_id` required/host-authoritative；WorkBuddy `call_id` optional/缺失不伪造；OpenClaw absent（适配器未透传：`openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts` 全文件无 `toolUseId`/`toolCallId` 引用——缺席证据） |
| `factsDegradation` | `'conservative' \| 'none'` | Codex/WorkBuddy conservative（truncated/execute/other 降级）；OpenClaw none（可能输出伪 `priorReadOfTarget='no'`） |
| `notes` | `string` | 可选补充 |

**禁止**：在 `hostShape` 中声明宿主不具备的能力（例如 OpenClaw `identityCapability: 'host-authoritative'`），即使这会让测试更方便。fixture 必须服从宿主真实能力矩阵（§7）。

### 2.4 Tool Call 事件序列（`events[]`）——三层分离结构

`events` 按 **insertion order**（入库顺序）排列。每个事件是**判别联合**，由 `eventKind` 区分：

- `observed`：产生了 `tool_calls` 行的事件；
- `absent`：真实发生但 PD 未观测到（hook 缺失、宿主盲区、dedupe 折叠、retention 清除）——**没有行，因此没有任何行字段**。

#### 2.4.1 `observed` 事件结构

```json
{
  "eventId": "e1",
  "eventKind": "observed",
  "row": {
    "id": 101,
    "session_id": "session-1",
    "tool_name": "Write",
    "outcome": "failure",
    "duration_ms": 120,
    "exit_code": null,
    "error_type": "write_conflict",
    "error_message": "…",
    "params_json": "{\"file_path\":\"/repo/src/a.ts\",\"content\":\"…\"}",
    "result_preview": "…",
    "created_at": "2026-11-28T10:00:05.000Z",
    "project_dir": "/repo",
    "host_kind": "workbuddy",
    "tool_use_id": "call-001"
  },
  "scenarioMeta": {
    "writerOperation": "live_insert",
    "outcomeEvidenceClass": "live-channel-contract",
    "coverageProvenance": "complete-window-verified",
    "truth": {
      "causalPosition": 1,
      "trueOutcome": "failure",
      "resourceIdentity": "resource:src/a.ts",
      "isObservationOfTarget": false,
      "idempotentEffect": false
    }
  }
}
```

**`row` 层：仅生产 `tool_calls` 原始列**（列名与生产 schema 一致，snake_case）。这是 simulate 模式下装配的唯一输入。

| 列 | 约束 |
|---|---|
| `id` | insertion row identity（AUTOINCREMENT 语义），fixture 内唯一。**仅是行写入顺序**，不声明因果序号 |
| `created_at` | 写入/补记时间，不是动作发生时间。禁止命名为 occurredAt |
| `session_id` / `tool_name` / `outcome` / `duration_ms` / `exit_code` / `error_type` / `error_message` / `params_json` / `result_preview` / `project_dir` / `host_kind` / `tool_use_id` | 与生产列语义一致；`params_json` 为 JSON **字符串**（与生产存储形态一致）；`outcome` 用 writer 词汇（`success\|failure\|unknown\|blocked`），`blocked` 仅允许在明确标注"ABI-legal-but-production-absent"的探测 fixture 中使用 |
| `tool_use_id` | OpenClaw 形状必须为 `null`；WorkBuddy `call_id` 可缺失（`null`）；缺失不得伪造 |
| `project_dir` | verified backfill INSERT 行必须为 `null`（生产 INSERT 列清单不含 project_dir，`production-pain-evidence.ts:383`） |

**禁止放入 `row` 层的内容**：`canonicalKind`、`normalizedPath`——它们是生产装配的**派生输出**（`assembleBehaviorHistory`/`buildRuleHostAction`），不是行输入。fixture 不提供派生值；simulate 模式下由生产代码重新计算，harness 可对照 `assemblyExpectation`（可选）验证装配正确性。提供手工派生值会制造第二真值源并允许不可能的派生——禁止。

**`scenarioMeta` 层：隐藏 oracle 元数据**——对被测系统严格不可见，不进入任何规则输入：

| 字段 | 含义 |
|---|---|
| `writerOperation` | `live_insert \| verified_update \| verified_insert \| legacy_write`——写入**操作语义**。区分 UPDATE 与 INSERT 至关重要：UPDATE 原位改写 outcome（制造 hindsight 风险），INSERT 新行（可能反转可见顺序）。注意：这不是生产列，被测系统不可见 |
| `outcomeEvidenceClass` | outcome 的证据来源分类，枚举同原 §2.4.2（`live-envelope-error`/`live-exit-code`/`live-channel-contract`/`live-result-shape-inferred`/`verified-transcript-upgrade`/`none-unknown`/`authored-synthetic`），语义不变 |
| `coverageProvenance` | 覆盖完整性证据：`complete-window-verified`（oracle 确认窗口覆盖相关全部事件）/`truncated`/`blind-gap`/`unknown`。NO 判定的认知依据——**它是 oracle 元数据，因为生产系统同样无法自证覆盖完整** |
| `truth` | 真值层（`causalPosition`/`trueOutcome`/`resourceIdentity`/`isObservationOfTarget`/`idempotentEffect`/`concurrentWith`），语义不变；`concurrentWith`（可选，eventId 列表）表达真并行——`causalPosition` 为 null 时必须说明是 unknown 还是并发 |
| `targetAttributionOracle` | oracle 的目标归因分类（六类）。**oracle 分类，生产无归因器**；它驱动 expectations，从不进入系统输入 |

#### 2.4.2 `absent` 事件结构

```json
{
  "eventId": "e-hidden",
  "eventKind": "absent",
  "scenarioMeta": {
    "absenceReason": "dedupe-folded",
    "truth": { "causalPosition": 2, "trueOutcome": "failure", "resourceIdentity": "resource:src/a.ts" },
    "wouldHaveBeen": { "tool_name": "Write", "paramsShape": "same-as-e1" }
  }
}
```

`absenceReason`：`hook-unreachable`/`dedupe-folded`/`retention-purged`/`host-blind-spot`。`wouldHaveBeen` 描述若被观测会是什么形态（oracle 参考，非行）。**禁止**：给 absent 事件编造行字段；用"没有行"证明"没有发生"（反向也不成立——absent 事件恰恰表达发生了但没行）。

#### 2.4.3 Outcome Evidence Source 强度分级（修正）

强证据（可独立支持 YES）：`live-envelope-error`、`live-exit-code`、`live-channel-contract`、`verified-transcript-upgrade`——**显式枚举这四类**。
弱证据：`live-result-shape-inferred`（单独不构成 YES）。
无证据：`none-unknown`。
`authored-synthetic` 不参与证据强度判定，使用时必须在 description 说明。

#### 2.4.4 As-of-Decision 投影（决策时点快照）

harness 在 simulate 模式必须执行 as-of-decision 投影：以 `currentInvocation.cutoffAt` 为界——

1. `created_at` 晚于 cutoff 的行**不得进入**装配输入（生产 provider 的 `readWorkspaceRuleContextRowsBefore` 语义）；
2. `verified_update` 行使用 cutoff 之**前**的 outcome 值——UPDATE 前的原值必须在 `scenarioMeta.preUpdateOutcome` 中声明，否则该事件不得用于 simulate（因为决策时点可见的是旧值）；
3. 当前调用自身的行（若已写）必须排除（生产 provider 的 current-id-exclusion 语义）。

**违反投影规则 = hindsight leakage**（对照 `docs/concepts/PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md` §5 cutoff 规则），构成测试基础设施缺陷（`test` 类归因）。

### 2.5 当前调用与决策时点（`currentCall` + `currentInvocation`）

被评估的工具调用。**严格分层**：

```json
{
  "invocationInput": {
    "toolName": "Write",
    "params": { "file_path": "/repo/src/a.ts", "content": "…" },
    "sessionId": "session-1",
    "toolUseId": "call-002",
    "projectDir": "/repo",
    "hostKind": "workbuddy"
  },
  "currentInvocation": {
    "hookType": "PreToolUse",
    "cutoffAt": "2026-11-28T10:00:10.000Z",
    "workspaceDir": "/repo",
    "providerEnabled": true
  },
  "oracle": {
    "ruleHostEvaluability": {
      "hookRouted": true,
      "evaluableKind": true,
      "targetPresence": "resource-attributed",
      "gateEntry": "evaluated"
    },
    "truth": { "resourceIdentity": "resource:src/a.ts", "idempotentEffect": false }
  }
}
```

#### 2.5.1 `invocationInput`（被测系统可见）

仅包含宿主 hook 真实会传递的输入：toolName/params/身份/路径上下文。**禁止**包含 `canonicalKind`/`normalizedPath`（派生输出，由生产装配计算）或任何归因分类（oracle 元数据）。toolName 必须使用宿主真实工具名大小写（WorkBuddy `Write`/`Edit`/`Read`/`Bash`；Codex `apply_patch`/`Bash` 等）——否则测的不是真实语义解析路径。

**Codex `apply_patch` 特别条款**：生产证据显示 Codex patch 载荷在 `patch`/`input`/`command` 信封中，通常**无直接 file_path**——pathless write 经生产装配生成合成目标 `<tool:apply_patch>`（`rule-host-input-builder.ts:253-255`）。fixture 不得虚构 Codex apply_patch 带直接 file_path 的形态；需要 resource-attributed 正控时应使用 WorkBuddy Write/Edit 等真实结构化路径形态。

#### 2.5.2 `currentInvocation`（决策时点快照，必填）

| 字段 | 含义 |
|---|---|
| `hookType` | `PreToolUse`/`PostToolUse` 等——决策发生在执行前还是后。**PreToolUse fixture 的 truth 不得含 `trueOutcome`**（执行未发生，属于 hindsight） |
| `cutoffAt` | hook 解码时捕获的决策截止时间——生产 provider 的 `cutoffAt` 语义（`codex-rule-context-provider.ts:76-79`）。as-of-decision 投影的基准（§2.4.4） |
| `workspaceDir` | PD workspaceDir（可能与 projectDir 不同——workspace scope 场景） |
| `providerEnabled` | rule context provider 是否启用（provider absent 场景为 false，配合 `assembly.mode`） |

#### 2.5.3 `oracle.ruleHostEvaluability`（oracle 分类，被测系统不可见）

逐层声明当前调用在治理链路中的位置（与 §8 coverage taxonomy 对齐）：

| 字段 | 取值 | 含义 |
|---|---|---|
| `hookRouted` | `boolean` | 是否路由到 PD **PreToolUse gate**。注意与 PostToolUse 证据采集分离（§8）：Codex PreToolUse matcher 窄（`Bash\|apply_patch\|pd_submit_pain`），PostToolUse 覆盖宽——一个调用可以被采集为证据但从未经过 gate |
| `evidenceCaptured` | `boolean` | 是否被 PostToolUse 通路采集为证据（独立于 hookRouted） |
| `evaluableKind` | `boolean` | canonicalKind ∈ {write, execute, agent}（`isRuleHostEvaluableKind`，`rule-host-input-builder.ts:312`）——oracle 按生产 registry 推导验证 |
| `targetPresence` | enum（§6） | 当前调用的目标归因 oracle 分类 |
| `gateEntry` | `'evaluated' \| 'skipped-no-target' \| 'skipped-non-evaluable-kind' \| 'hook-unreachable'` | gate 入口结局。`normalizedPath` 为 null/empty → `skipped-no-target` 提前 allow（`production-rulehost-gate.ts:356-360`） |

**一致性约束**：`gateEntry` 必须由前几个字段按生产逻辑推出，不得矛盾。注意生产现实：opaque command 与 synthetic target 只要 normalizedPath 非空就**会被机械评估**——`gateEntry: 'evaluated'` 对它们合法；语义归因漏斗（§8）是另一维度。

### 2.6 Context Availability 与装配方式（`assembly`）

```json
{
  "mode": "simulate",
  "windowTruncated": false,
  "contextOverride": null,
  "overrideJustification": null
}
```

| `mode` | 含义 | 适用 |
|---|---|---|
| `simulate` | harness 从 `events[].observation` 经与生产一致的装配路径（`assembleBehaviorHistory` + host provider 语义 + `computeBehaviorFacts`）推导 ruleContext。**默认且优先**——只有它能测试装配链本身 | 大多数 fixture |
| `override` | 直接给出 authored RuleContextV2（`contextOverride`，必须通过 `validateRuleContextV2`）。**必须填写 `overrideJustification`** 说明为什么 simulate 无法表达（例如 provider 环境性缺席、workspace scope mismatch） | 宿主环境状态类 fixture |
| `absent` | `input.context === undefined`（provider absent 场景）。注意：`undefined` 与 unavailable 是两种不同输入状态，gate 故障遥测不同（`provider_absent` vs `history_unavailable`） | provider absent 负控 |

`windowTruncated`：仅 simulate 模式；为 true 时 harness 在窗口外补充不可见历史行使 read 返回 truncated（或直接用超出 windowSize 的事件数制造截断）。**截断事件仍是观测层事实**——行存在，只是窗口读不到。

**禁止**：在 simulate 模式下手工编辑"期望的" ruleContext 输入给规则——那等于跳过被测装配链；override 模式不得用于本可由 simulate 表达的状态（否则测不到装配链，且构成 evidence fabrication）。

### 2.7 Provenance（版本与来源）

```json
{
  "provenance": {
    "authoredBy": "agent:PRI-1310",
    "authoredAt": "2026-11-28T00:00:00.000Z",
    "baselineSha": "e30202366f53df60ccaf7589f7988cf445a52fba",
    "contractRef": "docs/reviews/PD-CAE-STAGE1A-REPLAY-CONTRACT.md",
    "labelAuthority": "contract-section-3",
    "sourceDocuments": ["docs/specs/PD-CAE-SPEC-v1.1-20261128.md", "docs/reviews/PD-CAE-STAGE0-REALITY-AUDIT.md"]
  }
}
```

- `labelAuthority`：必填，目前唯一合法值 `contract-section-3`（标签语义权威是本契约 §3）。若值是规则 id 或 `rule-output`，整个 fixture 作废（循环验证）。
- `baselineSha`：fixture 编写时的代码基线，用于行为漂移定位（PRI-1208 sourceDigests 先例的简化版）。
- fixture pack 级别另设 `packVersion`（对应 PRI-1208 `corpusVersion` 先例），由 PRI-1310 定义，本文不冻结 pack 容器格式。

### 2.8 JSON Schema（test-only，机器可校验）

以下为 Fixture Envelope 的独立 JSON Schema（draft 2020-12）。§11.1 规范示例按其编写。它是**测试局部资产**：不得被生产代码 import，不得进入 `packages/*/src`。schema 应以 test-only 资产路径独立存放（由 PRI-1310 落盘），本文内嵌副本为权威定义；两处漂移时以内嵌权威为准并修复副本。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://principles-disciple.test/fixtures/cae-stage1a-envelope-v1.json",
  "title": "PD-CAE Stage1A Offline Replay Fixture Envelope (test-only, NOT production ABI)",
  "type": "object",
  "required": ["fixtureVersion", "fixtureId", "scenarioLabels", "controlClass", "evaluationMode", "evaluationAxis", "description", "provenance", "hostShape", "events", "currentCall", "assembly", "expectations", "forbiddenInferences"],
  "additionalProperties": false,
  "properties": {
    "fixtureVersion": { "const": 1 },
    "fixtureId": { "type": "string", "minLength": 1, "pattern": "^cae1a-[a-z0-9-]+$" },
    "scenarioLabels": {
      "type": "array", "minItems": 1,
      "items": { "enum": ["blind_retry_after_failure", "verify_then_retry", "idempotent_retry", "different_target", "unknown_outcome", "backfill_order_inversion", "opaque_target", "synthetic_target", "truncated_history", "duplicate_calls", "cross_host_attribution"] }
    },
    "controlClass": { "enum": ["positive_control", "negative_control", "inconclusive_evidence"] },
    "evaluationMode": { "enum": ["evidence-fidelity", "rule-logic-isolated"] },
    "evaluationAxis": { "enum": ["semantic-correctness", "production-conformance"] },
    "assumptionGrants": {
      "type": "array",
      "items": { "enum": ["ordering-assumed", "outcome-assumed", "identity-assumed", "coverage-assumed", "attribution-assumed"] }
    },
    "description": { "type": "string", "minLength": 1 },
    "specRefs": { "type": "array", "items": { "type": "string" } },
    "provenance": {
      "type": "object",
      "required": ["authoredBy", "authoredAt", "baselineSha", "contractRef", "labelAuthority", "sourceDocuments"],
      "additionalProperties": false,
      "properties": {
        "authoredBy": { "type": "string", "minLength": 1 },
        "authoredAt": { "type": "string", "format": "date-time" },
        "baselineSha": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
        "contractRef": { "type": "string", "minLength": 1 },
        "labelAuthority": { "const": "contract-section-3" },
        "sourceDocuments": { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "ruleUnderTest": {
          "type": ["object", "null"],
          "additionalProperties": false,
          "properties": {
            "ruleId": { "type": "string" },
            "artifactDigest": { "type": "string" },
            "activationMode": { "type": "string" }
          }
        }
      }
    },
    "hostShape": {
      "type": "object",
      "required": ["host", "windowSize", "identityCapability", "factsDegradation"],
      "additionalProperties": false,
      "properties": {
        "host": { "enum": ["codex", "workbuddy", "openclaw"] },
        "preToolGateRouted": { "type": "boolean" },
        "postToolEvidenceCaptured": { "type": "boolean" },
        "windowSize": { "type": "integer", "minimum": 1 },
        "identityCapability": { "enum": ["host-authoritative", "optional", "absent"] },
        "factsDegradation": { "enum": ["conservative", "none"] },
        "notes": { "type": "string" }
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["eventId", "eventKind", "scenarioMeta"],
        "additionalProperties": false,
        "properties": {
          "eventId": { "type": "string", "minLength": 1 },
          "eventKind": { "enum": ["observed", "absent"] },
          "row": { "$ref": "#/$defs/toolCallRow" },
          "scenarioMeta": { "$ref": "#/$defs/scenarioMeta" }
        }
      }
    },
    "currentCall": {
      "type": "object",
      "required": ["invocationInput", "currentInvocation", "oracle"],
      "additionalProperties": false,
      "properties": {
        "invocationInput": {
          "type": "object",
          "required": ["toolName", "params"],
          "additionalProperties": false,
          "properties": {
            "toolName": { "type": "string", "minLength": 1 },
            "params": { "type": "object" },
            "sessionId": { "type": "string" },
            "toolUseId": { "type": ["string", "null"] },
            "projectDir": { "type": ["string", "null"] },
            "hostKind": { "type": ["string", "null"] }
          }
        },
        "currentInvocation": {
          "type": "object",
          "required": ["hookType", "cutoffAt", "workspaceDir", "providerEnabled"],
          "additionalProperties": false,
          "properties": {
            "hookType": { "enum": ["PreToolUse", "PostToolUse", "PostToolUseFailure"] },
            "cutoffAt": { "type": "string", "format": "date-time" },
            "workspaceDir": { "type": "string" },
            "providerEnabled": { "type": "boolean" }
          }
        },
        "oracle": {
          "type": "object",
          "required": ["ruleHostEvaluability"],
          "additionalProperties": false,
          "properties": {
            "ruleHostEvaluability": {
              "type": "object",
              "required": ["hookRouted", "evidenceCaptured", "evaluableKind", "targetPresence", "gateEntry"],
              "additionalProperties": false,
              "properties": {
                "hookRouted": { "type": "boolean" },
                "evidenceCaptured": { "type": "boolean" },
                "evaluableKind": { "type": "boolean" },
                "targetPresence": { "enum": ["resource-attributed", "synthetic-target", "opaque-command", "no-target", "attribution-unprovable", "multi-target"] },
                "gateEntry": { "enum": ["evaluated", "skipped-no-target", "skipped-non-evaluable-kind", "hook-unreachable"] }
              }
            },
            "truth": { "$ref": "#/$defs/eventTruth" }
          }
        }
      }
    },
    "assembly": {
      "type": "object",
      "required": ["mode"],
      "additionalProperties": false,
      "properties": {
        "mode": { "enum": ["simulate", "override", "absent"] },
        "windowTruncated": { "type": "boolean" },
        "contextOverride": { "type": ["object", "null"] },
        "overrideJustification": { "type": ["string", "null"] },
        "assemblyExpectation": {
          "type": ["object", "null"],
          "additionalProperties": true,
          "description": "optional oracle expectations of derived assembly outputs (canonicalKind/normalizedPath per event); compared against actual production derivation, never fed as input"
        }
      }
    },
    "expectations": {
      "type": "object",
      "required": ["evidence", "decision", "safety", "hostEffect"],
      "additionalProperties": false,
      "properties": {
        "evidence": { "$ref": "#/$defs/evidenceExpectations" },
        "decision": { "$ref": "#/$defs/decisionExpectations" },
        "safety": { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 },
        "hostEffect": {
          "type": "object",
          "additionalProperties": false,
          "required": ["verifiability", "expectation"],
          "properties": {
            "verifiability": { "enum": ["probe-verified", "contract-only", "unverifiable"] },
            "expectation": { "type": "string" }
          }
        }
      }
    },
    "forbiddenInferences": { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 }
  },
  "$defs": {
    "toolCallRow": {
      "type": "object",
      "required": ["id", "session_id", "tool_name", "outcome", "params_json", "created_at"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "integer", "minimum": 1 },
        "session_id": { "type": "string" },
        "tool_name": { "type": "string", "minLength": 1 },
        "outcome": { "enum": ["success", "failure", "unknown", "blocked"] },
        "duration_ms": { "type": ["integer", "null"] },
        "exit_code": { "type": ["integer", "null"] },
        "error_type": { "type": ["string", "null"] },
        "error_message": { "type": ["string", "null"] },
        "params_json": { "type": "string" },
        "result_preview": { "type": ["string", "null"] },
        "created_at": { "type": "string", "format": "date-time" },
        "project_dir": { "type": ["string", "null"] },
        "host_kind": { "type": ["string", "null"] },
        "tool_use_id": { "type": ["string", "null"] }
      }
    },
    "scenarioMeta": {
      "type": "object",
      "required": ["truth"],
      "additionalProperties": false,
      "properties": {
        "writerOperation": { "enum": ["live_insert", "verified_update", "verified_insert", "legacy_write"] },
        "preUpdateOutcome": { "enum": ["success", "failure", "unknown", "blocked"] },
        "outcomeEvidenceClass": { "enum": ["live-envelope-error", "live-exit-code", "live-channel-contract", "live-result-shape-inferred", "verified-transcript-upgrade", "none-unknown", "authored-synthetic"] },
        "coverageProvenance": { "enum": ["complete-window-verified", "truncated", "blind-gap", "unknown"] },
        "targetAttributionOracle": { "enum": ["resource-attributed", "synthetic-target", "opaque-command", "no-target", "attribution-unprovable", "multi-target"] },
        "absenceReason": { "enum": ["hook-unreachable", "dedupe-folded", "retention-purged", "host-blind-spot"] },
        "wouldHaveBeen": { "type": ["object", "null"], "additionalProperties": true },
        "truth": { "$ref": "#/$defs/eventTruth" }
      }
    },
    "eventTruth": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "causalPosition": { "type": ["integer", "null"], "minimum": 1 },
        "concurrentWith": { "type": "array", "items": { "type": "string" } },
        "orderUnknownReason": { "type": ["string", "null"] },
        "trueOutcome": { "enum": ["success", "failure", "unknown"] },
        "resourceIdentity": { "type": "string" },
        "isObservationOfTarget": { "type": "boolean" },
        "idempotentEffect": { "type": "boolean" },
        "notes": { "type": "string" }
      }
    },
    "evidenceExpectations": {
      "type": "object",
      "required": ["historyStatus"],
      "additionalProperties": false,
      "properties": {
        "historyStatus": { "enum": ["available", "unavailable"] },
        "contextPresence": { "enum": ["present", "provider-absent"] },
        "unavailableReasonClass": { "type": ["string", "null"], "description": "must reuse production unavailable-reason vocabulary verbatim; free string only until PRI-1310 freezes the vocabulary list" },
        "truncated": { "type": ["boolean", "null"] },
        "factsPosture": { "enum": ["computed", "canonical-unavailable", "degraded-unknown", "not-applicable"] },
        "assembledPriorReadOfTarget": { "enum": ["yes", "no", "unknown", "not-applicable"], "description": "what production computeBehaviorFacts WILL output (assembled fact)" },
        "epistemicPriorReadOfTarget": { "enum": ["yes", "no", "unknown", "not-applicable"], "description": "what the oracle judges epistemically justified given coverage provenance; diverges from assembled when production outputs pseudo-no" },
        "orderingEvidence": { "enum": ["host-native-verified", "insertion-only", "conflicted", "none"] },
        "notes": { "type": "string" }
      }
    },
    "decisionExpectations": {
      "type": "object",
      "required": ["ruleDecision", "gateDecision"],
      "additionalProperties": false,
      "properties": {
        "ruleDecision": {
          "type": "object",
          "required": ["kind"],
          "additionalProperties": false,
          "properties": {
            "kind": { "enum": ["exact", "one-of", "neutral-or-absent", "no-expectation"], "description": "exact=output set equals values exactly; one-of=output in values; neutral-or-absent=rule stays neutral or unmatched; no-expectation=not judged" },
            "values": { "type": "array", "items": { "enum": ["allow", "block", "requireApproval", "auto_correct"] } },
            "disposition": { "enum": ["evaluated-matched", "evaluated-unmatched", "skipped-context-unavailable", "skipped-gate-early-allow", "not-applicable"] }
          }
        },
        "gateDecision": { "enum": ["allow", "deny", "no-expectation"] },
        "goldenTraceMapping": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "expectedDecision": { "enum": ["allow", "block", "propose_correction"] },
            "kind": { "enum": ["positive", "negative"], "description": "Golden Trace vocabulary: positive MUST expect allow (golden-trace.ts validator); blocking/adversarial scenarios map to negative regardless of contract controlClass" }
          }
        }
      }
    }
  }
}
```

**schema 无法表达、由 harness 或评审强制执行的逻辑约束**：

1. `gateEntry` 必须与 evaluability 字段按生产逻辑一致；
2. OpenClaw 形状的 `row.tool_use_id` 与 `invocationInput.toolUseId` 必须为 `null`；Codex 形状应为 host-authoritative 身份；
3. `writerOperation: 'verified_insert'` 的行 `project_dir` 必须为 `null`（`production-pain-evidence.ts:383` 列清单）；
4. `writerOperation: 'verified_update'` 必须声明 `preUpdateOutcome`（as-of-decision 投影需要）；
5. `assembly.mode: 'override'` 必须配非空 `overrideJustification`；
6. `outcome: 'unknown'` 行的 `outcomeEvidenceClass` 必须是 `none-unknown`/`verified-transcript-upgrade`/`authored-synthetic` 之一；
7. `controlClass` 必须与 `scenarioLabels` 按 §3 的标签-控制映射一致；
8. `truth.causalPosition` 在多个事件间不得重复（`concurrentWith` 表达真并行时除外，且互指）；`row.id` 不得重复；
9. `evaluationMode: 'rule-logic-isolated'` 必须配非空 `assumptionGrants`；`'evidence-fidelity'` 不得有 assumptionGrants；
10. `eventKind: 'observed'` 必须有 `row`；`'absent'` 不得有 `row` 且必须有 `absenceReason`；
11. PreToolUse fixture 的 `oracle.truth` 与事件 truth 不得含决策时点后的信息（当前调用的 `trueOutcome` 禁止）；
12. `expectedDecision: 'propose_correction'` 在 Stage 1A v2 规则范围内不使用（PRI-490）；
13. goldenTraceMapping 若存在：`expectedDecision` 非 allow 时 `kind` 必须为 `negative`（`golden-trace.ts:160-162` 校验器）；
14. events 按 `row.id` 升序排列（insertion order），absent 事件无 id 按 scenarioMeta 说明定位。
### 2.9 Expectations（期望层）

expectations 是 oracle 判定输入，分四类：

1. **`evidence`（证据期望）**：装配后证据状态应有的样子——`historyStatus`、`truncated`、`factsPosture`、`priorReadOfTarget`、`orderingEvidence`。这是独立于决策维的期望层：现有 Golden Trace 只能表达决策期望，而 SPEC §8.3 的"必须 unknown""不得命中同目标证据"是对**证据/装配结果**的期望。评测 harness 必须独立评估此层。
2. **`decision`（决策期望）**：`ruleDecision`（exact / one-of / neutral-or-absent / no-expectation + matched）与 `gateDecision`（allow / deny / no-expectation）。`neutral-or-absent` 表示规则应保持中立或未命中——降级证据下的正确姿态。`goldenTraceMapping` 提供到现有 Golden Trace replay 的映射提示（kind + expectedDecision）。
3. **`safety`（安全约束，字符串列表）**：绝不允许发生的行为，例如 `must-not-block-on-unproven-ordering`、`must-not-treat-unknown-as-failure`。安全约束违反一律 FAIL（见 §10），无 inconclusive 余地。
4. **`hostEffect`（宿主效果期望）**：必须带 `verifiability` 分级：`probe-verified`（如 WorkBuddy deny 探针证据）、`contract-only`（只有 SDK/encoder 契约证据）、`unverifiable`（当前无法验证）。**禁止把 contract-only/unverifiable 的 host effect 当作已证明的阻断**。

### 2.10 Forbidden Inferences（禁止推断清单）

每个 fixture 必须显式列出本场景内**禁止得出的结论**，例如：

- `ordering-not-provable`：本场景顺序不可证明；
- `no-target-attribution`：不得做同目标判定；
- `outcome-not-provable`：不得假定上一次结果；
- `history-incomplete`：否定命题不成立；
- `host-effect-unverifiable`：宿主效果不可声称。

该清单是 fixture 评审的 checklist，也是 §10 FAIL 判定的直接依据：被测系统违反任何一条即构成 safety violation。

---

## 3. Scenario Truth Labels

标签是**场景分类词汇**（describes what the scenario IS），不是决策输出词汇。每个标签的定义即 oracle 判定的权威依据（`labelAuthority: 'contract-section-3'`）。

**通用规则**：

1. 一个 fixture 至少一个标签，可多标签（例如 `unknown_outcome` + `truncated_history`）。
2. `controlClass` 三值：`positive_control`（应被规则识别为问题/命中）、`negative_control`（不应被误判为问题）、`inconclusive_evidence`（证据不足，正确姿态是中立/不判定，而非任何一种确定结论）。
3. 标签描述场景本质；`controlClass` 描述该场景在评测中的角色。二者绑定关系在各标签中冻结。
4. **inconclusive_evidence 不是负控**：不判定 ≠ 正确允许（§10）。

### 3.1 `blind_retry_after_failure` — 正控（positive_control）

| 维度 | 定义 |
|---|---|
| 严格含义 | 一次 write/execute/agent 失败后，在**没有重新观察目标资源**的情况下再次执行同类操作。 |
| 成立条件 | (a) 前序事件同资源、失败已证实（YES 级证据）；(b) 失败与重试之间**不存在**对该资源的有效观察事件（truth `isObservationOfTarget: true`）；(c) 目标同一性可判定（`resourceIdentity` 相同且归因为 resource-attributed）；(d) 顺序可证明（§5）。 |
| 必要证据 | 失败的强证据来源（live-envelope-error/live-exit-code/live-channel-contract/verified-transcript-upgrade）；两次调用同资源；顺序证据。 |
| 不成立条件 | 中间存在有效观察（→ `verify_then_retry`）；目标不同（→ `different_target`）；失败未证实。 |
| 无法判定 | outcome UNKNOWN；顺序不可证明；目标归因不可证明；历史截断导致"是否存在中间观察"不可知。 |
| 示例 | `apply_patch` 改 `src/a.ts` 冲突失败（exit_nonzero），随后无 read/search，再次 `apply_patch` 同文件。 |

### 3.2 `verify_then_retry` — 负控（negative_control）

| 维度 | 定义 |
|---|---|
| 严格含义 | 失败后**先重新观察目标资源**，再执行同类操作。 |
| 成立条件 | (a) 失败已证实；(b) 失败与重试之间存在 truth `isObservationOfTarget: true` 且 `resourceIdentity` 与目标相同的事件；(c) 顺序可证明。 |
| 必要证据 | 失败证据 + 观察事件存在（read/search/verify 语义）+ 同资源 + 顺序。 |
| 不成立条件 | 观察对象不是目标资源（`resourceIdentity` 不同——例如读了别的文件）；观察先于失败（顺序不符）。 |
| 无法判定 | 观察事件 outcome 为 unknown 且无法确认观察是否有效；窗口截断导致观察事件不可见——**注意：截断时既不能判 blind retry 也不能判 verify-then-retry，只能 inconclusive**。 |
| 示例 | patch 失败后 `read` 同一文件成功，再次 patch。 |

### 3.3 `idempotent_retry` — 负控（negative_control）

| 维度 | 定义 |
|---|---|
| 严格含义 | 重复执行效果安全的操作（幂等），即使未重新观察也不构成行为问题。 |
| 成立条件 | truth `idempotentEffect: true`（oracle 标注，如重复创建已存在目录的 mkdir -p、重复执行无状态查询）。 |
| 必要证据 | **只能从 truth 层标注**——幂等性在 ABI 中无对应概念，无法从观测证据推导。这正是本标签存在的意义：测试 oracle 是否承认幂等性不可观测。 |
| 不成立条件 | 操作有累积副作用（追加写、重复部署）。 |
| 无法判定 | 无法确定操作是否幂等时——**默认不可判为 blind retry**：幂等性不明 ≠ 非幂等。 |
| 示例 | 重复 `mkdir -p /tmp/build` 两次，第一次因超时标记 failure。 |

### 3.4 `different_target` — 负控（negative_control）

| 维度 | 定义 |
|---|---|
| 严格含义 | 两次调用**不是同一资源**，即使工具相同也不构成"重试"。 |
| 成立条件 | truth `resourceIdentity` 不同，且两者均为 resource-attributed。 |
| 必要证据 | 两次调用的目标归因各自成立。 |
| 不成立条件 | resourceIdentity 相同；任一归因不可证明。 |
| 无法判定 | 任一目标归因不明（opaque/synthetic/unprovable）——**此时禁止判 different_target 负控"通过"**，因为不同性本身未证实；也禁止判同目标。归入 inconclusive_evidence。 |
| 示例 | patch `src/a.ts` 失败后 patch `src/b.ts`。 |

### 3.5 `unknown_outcome` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | 上一次操作结果无法确定（writer outcome 为 unknown，或证据来源不足）。 |
| 成立条件 | 前序事件 outcome `unknown` 且证据来源为 `none-unknown` 类（text_only_response/unconfirmed_result_shape 语义）。 |
| 必要证据 | outcome 缺失的证据链（即"为什么 unknown"可解释）。 |
| 不成立条件 | outcome 有强证据（无论成败）。 |
| 无法判定 | （本标签本身即"无法判定"的分类载体。） |
| 评测要点 | 被测系统在 unknown outcome 下**必须不命中** repeated-failure 类判定；UNKNOWN 不得当 NO（"没有失败证据≠没有失败"），也不得当 YES（"结果不明≠已失败"）。对照生产现状：writer 词汇的 `unknown` 不是合法 `RuleToolOutcome`（`success\|failure\|blocked`），装配时单行 unknown 使整窗降级为 unavailable（`host-runtime/src/behavior-history.ts:37-41`，`assembleBehaviorHistory`）——fixture 应验证降级行为而非假设其已被修复。 |
| 示例 | Codex shell 命令 text-only response，`text_only_response` 原因写入 unknown，随后再次执行命令。 |

### 3.6 `backfill_order_inversion` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | verified backfill 补录使 insertion order（可见顺序）与真实因果顺序不一致。 |
| 成立条件 | truth `causalPosition` 排序与 `insertionRowId` 排序在至少两个事件间不一致，且不一致由 `writerPath: 'verified_backfill'` 造成。 |
| 必要证据 | 事件的 writerPath 构成（live + verified_backfill 混合）；insertionRowId 与 causalPosition 的双重排序。 |
| 不成立条件 | 全部事件同为 live 且按序写入。 |
| 无法判定 | （本标签表达"顺序不可信"的场景类，评测姿态本身即保守。） |
| 评测要点 | **DB insertion order 单独不构成因果顺序证据**（SPEC §5：ordering 的 Yes/No 均要求可信的宿主原生顺序证据）。在 inversion 场景下，依赖可见顺序的 repeated-failure 判定必须 inconclusive/neutral，不得命中。 |
| 示例 | e2（真实先发生）live 写入行 id 102；e1（真实后发生）backfill 补录行 id 101——按 id 排序 e1 看似在前。 |

### 3.7 `opaque_target` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | 目标资源无法可靠识别——典型为 shell command 字符串（命令文本不是资源）。 |
| 成立条件 | currentCall 或事件 `targetAttributionClass: 'opaque-command'`。 |
| 必要证据 | canonicalKind 为 execute，normalizedPath 为 command 原文串（生产现状：execute 的"路径"是命令文本）。 |
| 不成立条件 | 有结构化文件参数。 |
| 无法判定 | （本标签即判定终点：同目标判定不可做。） |
| 评测要点 | 非空 normalizedPath ≠ 资源归因。opaque command 下**禁止**一切同目标/重复目标判定；规则保持 neutral 或不可评估，不得命中也不得"确认无问题"。 |
| 示例 | `bash -c "python manage.py migrate"` 失败后再次执行同一命令串——两次命令字符串相同也不构成已证实的同资源重试。 |

### 3.8 `synthetic_target` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | 目标来自合成推断（如 agent/MCP 调用无结构化路径，系统猜测出一个"目标"），不是声明的资源。 |
| 成立条件 | `targetAttributionClass: 'synthetic-target'`。 |
| 必要证据 | 目标的合成来源可被描述。 |
| 不成立条件 | 有宿主/工具声明的结构化资源。 |
| 评测要点 | 合成目标**不得参与同目标判定的肯定侧**（不能说"两次都是同一目标"）；也不参与否定侧。一切目标相关判定 inconclusive。 |
| 示例 | Task/agent 调用只有 prompt 文本，系统推断其"可能修改 src/a.ts"。 |

### 3.9 `truncated_history` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | 历史证据不完整——窗口截断（行存在但读不到）或可用窗口被耗尽。 |
| 成立条件 | `assembly.windowTruncated: true`，或事件数超出 hostShape.windowSize。 |
| 必要证据 | read 返回 truncated:true 的模拟状态。 |
| 不成立条件 | 窗口完整覆盖相关事件。 |
| 评测要点 | SPEC §5 核心：**No 要求窗口覆盖被证明完整**。"未观察到 X"在截断窗口下不得作为 X 未发生的证据。conservative 宿主（Codex/WorkBuddy）facts 应 degraded-unknown；OpenClaw 无降级（已知缺陷，fixture 记录实际行为而非期待行为）。 |
| 示例 | 相关历史 5 行，OpenClaw 窗口 20 中前 18 行被无关调用占满，read 截断，失败事件不可见。 |

### 3.10 `duplicate_calls` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | 重复调用与去重存在歧义——content-shape dedupe 可能折叠真实重复，或同一 toolUseId 对应多次记录。 |
| 成立条件 | (a) OpenClaw 形状下两个内容形状相同的调用（无 toolUseId 可区分）；或 (b) 同 toolUseId 出现在多行（UPDATE 合并语义）。 |
| 必要证据 | 身份能力的显式声明（hostShape.identityCapability）。 |
| 不成立条件 | 每行有唯一可信 host-authoritative 身份。 |
| 评测要点 | **去重造成的调用身份歧义必须保留 UNKNOWN**（§4）。禁止把"两行内容相同"判为"同一次调用的重复记录"，也禁止判为"两次独立调用"——两者都是过度推断。 |
| 示例 | OpenClaw 两次相同 `write src/config.json` 相同内容，均无 toolUseId；被测系统无法知道这是一次还是两次。 |

### 3.11 `cross_host_attribution` — inconclusive_evidence

| 维度 | 定义 |
|---|---|
| 严格含义 | 跨宿主身份或证据归因不可靠——host_kind 缺失/异值导致行的归属存疑。 |
| 成立条件 | 事件 `hostKind` 为 null（legacy 未 stamp）或与 hostShape.host 不一致（foreign-stamped 行进入窗口）。 |
| 必要证据 | hostKind stamp 状态逐行声明。**hostKind 行变体是测试局部行语义**——生产 `RuleHostContextRow` 不含 hostKind 字段（它只是查询过滤维度），因此 fixture 在 `observation.hostKind` 表达它，不要求生产 ABI 扩展。 |
| 不成立条件 | 全部行 hostKind 与窗口宿主一致。 |
| 评测要点 | 身份无法确认的行不得参与需要确定归属的判定。Codex 窗口无 hostKind 过滤（provider 不过滤）、WorkBuddy 严格过滤、OpenClaw 仅 session 维度——三宿主差异是**被测事实**，不是 fixture 可抹平的噪声。 |
| 示例 | Codex 窗口中出现 host_kind 为 `openclaw` 的 foreign 行（无过滤），其失败证据能否计入 repeated-failure？答案：归属不可证，不得计入。 |

### 3.12 标签-控制类映射冻结表

| 标签 | 允许的 controlClass |
|---|---|
| blind_retry_after_failure | positive_control |
| verify_then_retry | negative_control |
| idempotent_retry | negative_control |
| different_target | negative_control（仅当不同性可证实；否则必须改用 inconclusive 标签组合） |
| unknown_outcome | inconclusive_evidence |
| backfill_order_inversion | inconclusive_evidence |
| opaque_target | inconclusive_evidence |
| synthetic_target | inconclusive_evidence |
| truncated_history | inconclusive_evidence |
| duplicate_calls | inconclusive_evidence |
| cross_host_attribution | inconclusive_evidence |

多标签 fixture 的 controlClass 取最保守者（inconclusive_evidence > positive/negative 按主标签语义，但任一 inconclusive 类标签在场即整体 inconclusive，除非该标签仅修饰非关键路径事件——此时须在 description 中显式论证）。

---

## 4. Three-Valued Evidence Semantics

### 4.1 核心原则

> **没有证据，不等于否定证据。（Absence of evidence is not evidence of absence.）**

三值词汇复用生产已有的 `EvidenceState`（`yes | no | unknown`）——**测试局部使用，不要求也不允许新增生产公共 enum**（SPEC line 116 语义）。UNKNOWN 是一等语义公民，不是错误、不是缺失数据占位符、不是待清洗的噪声。

### 4.2 必须保留 UNKNOWN 的情形（冻结清单）

| # | 情形 | 为什么不是 NO |
|---|---|---|
| U1 | outcome 缺失/unknown | 结果不明 ≠ 操作未发生，也 ≠ 操作失败/成功 |
| U2 | 历史记录截断 | 窗口外不可知；"没看到失败"≠"没有失败" |
| U3 | 身份无法确认（toolUseId 缺失/歧义） | 无法区分"同一调用"与"重复调用" |
| U4 | 目标资源无法归因 | 不能证明同目标，也不能证明不同目标 |
| U5 | 因果顺序无法证明 | insertion order 只是写入顺序（§5） |
| U6 | 宿主事实降级（truncated/execute/other facts） | facts 缺失 ≠ facts 为否 |
| U7 | 去重造成调用身份歧义 | dedupe 折叠 ≠ 只发生一次 |

### 4.3 YES / NO / UNKNOWN 判定表

以命题 P = "存在证据 E"（如"存在同目标的前序失败"）为例，对照 SPEC §5 五命题表：

| 证据状态 | 判定 | 条件 |
|---|---|---|
| YES | 证据存在且可信 | 证据来源为强证据类（§2.4.2 前四类），窗口覆盖完整，身份/归因/顺序均可信 |
| NO | **证据的缺失本身被证明** | 窗口覆盖**可证明完整**（未截断、无盲区、writerPath 全部为 live 且覆盖相关时段），且搜索空间内确无 E。**NO 是强断言**：它要求证明"若 E 存在则必然可见" |
| UNKNOWN | 以上两者都不满足 | U1–U7 任一成立；或窗口截断；或证据来源弱（live-result-shape-inferred 单独不构成 YES） |

其余四命题（同一目标 / A 先于 B / 次数≥N / 次数<N）同构：

| 命题 | YES 要求 | NO 要求 | UNKNOWN 情形 |
|---|---|---|---|
| 同一目标 | 两侧均 resource-attributed 且 truth 层可比对（评测时）/生产上归因可靠 | 两侧均可靠归因且确实不同 | 任一侧 opaque/synthetic/unprovable |
| A 先于 B | 宿主原生可信顺序证据（host-native-verified——当前无宿主具备） | 同上（证明 B 先于 A 或同时） | insertion order（无论 writer 构成如何，含全 live 单 session）、backfill 混合、无时间证据 |
| 次数≥N | 完整窗口内可数出 N 次且身份无歧义 | 完整窗口证明不足 N 次 | 截断/去重歧义/归属不明 |
| 次数<N | 完整窗口证明 | —（该命题的 NO 即次数≥N 的 YES） | 同上 |

### 4.4 反例（禁止的转换）

| 反例 | 错误 | 正确 |
|---|---|---|
| `outcome` 字段为空 → "该操作没有后果" | 字段空 = 证据缺失 = UNKNOWN | 保持 UNKNOWN，降级处理 |
| 窗口内无失败记录（截断） → "之前没有失败" | 截断窗口的否定命题不成立 | UNKNOWN：必须先证明窗口完整才能判 NO |
| 两行内容相同（无身份） → "去重后只算一次" | 身份歧义被任意消解 | UNKNOWN：一次还是两次不可判 |
| normalizedPath 相同 → "同一资源" | 路径串相等不证明资源同一（硬链接、相对路径、命令文本） | 评测中由 truth.resourceIdentity 判定；生产中归因可信度分级 |
| `requireApproval` 决策 → "宿主已暂停执行" | 决策 ≠ 宿主效果 | hostEffect 独立分级验证（§9） |
| unknown 行存在 → "有失败风险，按失败处理" | UNKNOWN 当 YES | 保守降级：不命中、中立、报告 inconclusive |
| unknown 行存在 → "无有效失败证据，当作没失败" | UNKNOWN 当 NO | 同上——UNKNOWN 不是任何一侧的证据 |

### 4.5 三值与评测结果的关系

UNKNOWN 证据 → 评测结果 **INCONCLUSIVE**（§10），既不记 PASS 也不记 FAIL。唯一的例外：当 fixture 的期望本身就是"系统应保持中立/不命中"且系统确实如此时——这是**证据层期望匹配**，记 PASS（评测的是系统的保守性，不是场景的确定性）。此例外必须在 fixture 的 expectations 中显式表达（`decision.ruleDecision.kind: 'neutral-or-absent'`），禁止默认套用。

---

## 5. Ordering Evidence Contract

### 5.1 冻结事实

1. **`insertionRowId`（模拟 `tool_calls.id`）是 insertion row identity**——AUTOINCREMENT 行号，仅证明"哪一行先被写入数据库"。
2. **`insertedAt`（模拟 `created_at`）是写入/补记时间**——行进入数据库的时间，不是动作发生时间。
3. **二者均不能单独证明真实行为因果顺序。**live 顺序写入时二者通常与因果一致，但这是经验相关而非逻辑保证。
4. **verified backfill 可以改变可见 insertion order**：补录 INSERT 的行号大于其后发生的 live 行；UPDATE 不改变行号但改写 outcome——两种情况下"窗口中看到的顺序/状态"都可能与真实因果不一致（审计 P1-3/P1-4）。
5. ABI 中**不存在** occurredAt 或等价物——**禁止在任何 fixture、测试、注解中生成或声称 occurredAt 类虚假时间证据**。

### 5.2 顺序证据分级（`orderingEvidence` 词汇）

| 级别 | 含义 | 可支持的判定 |
|---|---|---|
| `host-native-verified` | 宿主原生可信顺序（如宿主 transcript 序列经 verified 通路确认），且包含并行调用语义 | 顺序命题 YES/NO——**当前无宿主具备此能力**（Stage 0 P0-2：无宿主存在可信的通用动作序列） |
| `insertion-only` | 仅有 DB insertion 顺序。**无论行是否全部 live 写入、单 session、无 backfill，仍只是 insertion-only**：(a) hook 调度、并行工具调用、进程延迟、SQLite 写序列化使 live 写入顺序与因果顺序最多相关而非可证；(b) `writerPath` 不是生产 `tool_calls` 列——被测系统无法观测写入通路，"全 live 无 backfill"的前提对生产系统不可验证 | **不支持** repeated-failure 类因果判定；只能支持"窗口内可见顺序"陈述 |
| `conflicted` | insertion 顺序与其他证据矛盾（backfill inversion） | 必须 inconclusive/neutral |
| `none` | 无任何顺序证据 | 必须 inconclusive/neutral |

### 5.3 三个冻结案例

**案例 1：正常顺序（表面）。** 全部事件 live 写入、单 session、窗口完整、无 backfill，insertionRowId 与 causalPosition 一致。orderingEvidence 仍 = `insertion-only`——即使在这种最干净的形态下，被测系统拥有的也只是 insertion order。**诚实的契约结论：在当前生产证据能力下，repeated-failure 类判定永远无法合法达到 YES**——这不是 fixture 设计失败，而是 Stage 0 P0-2 的契约化表达。需要通过顺序证据测试**规则逻辑**时，必须使用 §5.5 的 `rule-logic-isolated` 评测模式，且不得将其结果计为生产证据就绪。

**案例 2：Backfill 反转。** e-write（causalPosition 1）失败但 outcome 未确认（unknown）；verified backfill 随后升级为 failure 并 INSERT 补充行，行号大于其后 live 写入的观察事件。按 id 排序观察事件在"失败"之前——**可见顺序显示"先观察后失败"，真实顺序是"先失败后观察"**。依赖可见顺序的 verify-then-retry 判定会产生假阴性/假阳性。正确姿态：inconclusive。

**案例 3：顺序不可证明。** 混合 writerPath、跨宿主行、无 transcript 佐证。orderingEvidence = `none`。一切因果判定 inconclusive。

### 5.4 对 repeated-failure 类判定的强制约束

> **如果缺少可信的因果顺序证据，repeated-failure 结论必须为 inconclusive 或 neutral。**

此约束是 safety 类：违反即 FAIL（系统层面），无 inconclusive 余地——因为它构成"伪造因果证据"的行为。

### 5.5 Evaluation Mode（评测模式分离）

由于生产证据能力与现实测试需求之间存在鸿沟，每个 fixture 必须显式声明评测模式：

| 模式 | 含义 | 结果语义 |
|---|---|---|
| `evidence-fidelity`（默认） | 测试完整链路在当前生产证据能力下的行为。所有证据分级按生产现实判定——ordering 最高只能 insertion-only，repeated-failure 类结论在此模式下合法形态只有 inconclusive/neutral | PASS/FAIL/INCONCLUSIVE 均表达对生产证据就绪性的判定 |
| `rule-logic-isolated` | oracle 通过 `assumptionGrants` 显式授予假设（如 `ordering-assumed`、`outcome-assumed`、`identity-assumed`），测试**给定**可靠证据时规则逻辑能否区分场景。授予的假设必须逐条列出，不得隐含 | 结果**仅**说明规则逻辑在假设下的行为，**禁止**计入生产证据就绪性、coverage 或任何"系统能正确治理"的结论；报告必须单列 |

**冻结条款**：

1. `rule-logic-isolated` 模式的 fixture 在 `evaluationMode` 字段显式声明，且 `assumptionGrants` 非空（无假设则无理由用此模式）。
2. 假设授予是 oracle 层的显式输入，不是证据——禁止在报告中含混两者。
3. 聚合报告必须分开两个模式的结果；禁止合并计数。
4. 同一宿主若未来获得 host-contract 级序列化顺序保证（含并行调用语义）并经独立验证，`host-native-verified` 级别才可被启用——启用本身是契约修订事件。

---

## 6. Target Attribution Contract

### 6.1 分类学（六类，冻结）

| 类别 | 定义 | 典型来源 | 允许的判断 | 禁止的推断 |
|---|---|---|---|---|
| `resource-attributed` | 目标可归因到具体资源（结构化文件路径参数经宿主规范化） | apply_patch/Write/Edit 的 file_path | 同/异目标判定（在归因可信度内） | 不免除顺序/结果证据要求 |
| `synthetic-target` | 目标由系统合成推断，非声明资源 | agent/MCP 无路径调用的猜测 | 无（仅记录归因方式） | 一切同目标肯定/否定判定 |
| `opaque-command` | 目标是命令文本串，无结构化资源 | Bash/shell execute | 无 | 把命令串当资源；把相同命令串当同一资源 |
| `no-target` | 该调用本质上无目标资源 | 纯查询、无参工具 | 无 | 伪造目标以"提高覆盖率" |
| `attribution-unprovable` | 可能有目标但当前证据无法归因 | 路径参数残缺、相对路径无基准 | 无 | 同 synthetic；禁止"尽力猜测后按猜测判定" |
| `multi-target` | 一次调用影响多个资源 | patch 多文件、批量命令 | 逐资源归因后才可判定；未逐资源展开前视同 opaque | 把多目标压缩为单一目标判定 |

### 6.2 关键冻结条款

1. **非空 `normalizedPath` ≠ 真实资源归因。**opaque-command 的 normalizedPath 是整串命令原文（生产现状），multi-target 的 normalizedPath 可能只是首个路径。
2. **Shell command 字符串不能自动认定为实际资源。**`rm -rf build/ && npm run build` 中的 `build/` 是文本碎片，不是归因结果。
3. **Patch、multi-target、agent/MCP 无路径等情况必须保留自己的分类**——禁止为了覆盖率好看而强行归并到 resource-attributed。
4. 目标归因影响 gate 入口：`normalizedPath` 为 null/empty → gate `skipped-no-target` 提前 allow（`production-rulehost-gate.ts:356-360`）——fixture 必须如实表达，不得假装这些调用"经过了规则评估"。
5. 资源同一性在评测中只能由 truth `resourceIdentity` 判定；normalizedPath 字符串相等是**启发式相关**，不是同一性证据（相对路径、符号链接、大小写、命令文本反例）。

---

## 7. Host Evidence Contract

三宿主的证据能力**事实不同**（Stage 0 审计与 Adapter 源码），fixture 必须按宿主真实能力构造，不得强行统一 outcome 或 identity 语义。下表为冻结的能力矩阵（证据源：Stage 0 审计 §3/§4、各 host-runtime adapter）。

### 7.1 能力矩阵

| 证据维度 | Codex | WorkBuddy | OpenClaw |
|---|---|---|---|
| Host identity | `host_kind` stamp 由 writer 写入；窗口查询**不过滤** hostKind | 严格 hostKind 过滤 | 仅 session 维度，无 hostKind 概念过滤 |
| Tool call identity | `tool_use_id` host-authoritative（required） | `call_id` **可选，可能缺失**——缺失不得伪造 | toolCallId/runId **未透传**（`openclaw-host-runtime.ts` adapter 层丢弃） |
| Outcome | shell outcome 存在 unknown（`text_only_response`/`unconfirmed_result_shape`） | PostToolUse / PostToolUseFailure 通道契约分流（较强） | 无 error 的 object/array 信封倾向 success（`live-result-shape-inferred` 弱证据） |
| Target attribution | 与工具语义注册表一致 | 同左 | 同左 |
| Ordering | insertion order only（`created_at DESC, id DESC`，100 行窗口，project+时间截断+当前行排除） | 同左（100 行窗口） | insertion order only（`id DESC`，20 行窗口，session-only） |
| Host facts | conservative 降级（truncated/execute/other → facts degraded） | 同左 | **无降级**——truncated/execute/other facts 可能输出伪 `priorReadOfTarget='no'`（已知缺陷） |
| Context availability | provider 100 行窗口 | provider 100 行窗口 | provider 20 行窗口 |
| Host effect | hook 覆盖范围与其他宿主不同（PreToolUse matcher 仅 `Bash\|apply_patch\|pd_submit_pain`） | PostToolUse 证据来源与 PostToolUseFailure 必须区分 | hook 语义随 OpenClaw 插件通道 |
| Dedupe | toolUseId 唯一性可区分重复 | call_id 缺失时退化 | content-shape dedupe **可能折叠真实重复调用** |

### 7.2 冻结条款

1. **OpenClaw**：(a) fixture 中 `toolUseId` 必须为 null；(b) 构造重复调用场景时必须面对 content-shape dedupe 歧义（`duplicate_calls` 标签），不得假设两次相同调用可区分；(c) facts 无降级是**被测事实**——fixture 期望应记录实际行为（可能伪 `no`），并在 `expectations.evidence.notes` 标注该行为为已知缺陷而非正确性基准。
2. **Codex**：(a) shell outcome unknown 是常态证据形态，fixture 必须覆盖；(b) hook 覆盖范围窄——非 matcher 工具的调用 `hookRouted: false`；(c) 窗口不过滤 hostKind，foreign-stamped 行可入窗（cross_host_attribution 场景）。
3. **WorkBuddy**：(a) PostToolUse 与 PostToolUseFailure 是**不同证据来源**，fixture 的 `outcomeEvidenceSource` 必须区分（`live-channel-contract`）；(b) `call_id` 缺失场景必须保留身份 UNKNOWN；(c) **不得将已有 deny evidence 能力误认为所有证据链均已完备**——deny 通路经探针验证 ≠ outcome/ordering/attribution 各链完备。
4. **跨宿主**：禁止 fixture 声称某证据形态"三宿主一致"，除非逐宿主核实。聚合统计必须分宿主分层（§8）。

---

## 8. Coverage Taxonomy

### 8.1 两个不可压缩的维度

**维度 A：Host Capability Coverage**（宿主能力覆盖）——统计对象是**宿主全量工具调用**（含 PD 不可见的），回答"PD 原则上能看到多少"。

**维度 B：Observed Call Evaluation Funnel**（已观测调用评估漏斗）——统计对象是**已进入 PD 证据链的调用**，回答"看到的里面有多少能被有效评估"。

> **Hook Unreachable 是宿主能力覆盖问题（维度 A 的分母侧），不能混入已观测调用的评估分母（维度 B）。**两个维度禁止压缩成单一命中率。

### 8.2 分类定义（修正版）

**统一计算方式**：`ratio = 分子 / 分母`，分母为 0 时报告 `N/A` 而非 0；每项同时报告分子、分母、ratio 三个原始数字，禁止只报 ratio。分类项（5–10）是**划分**（partition）而非漏斗转化——它们的分子互斥且穷尽分母，报告各部分占比而非"转化率"。**无法测量时的统一处理**：`NOT_MEASURABLE_OFFLINE` 或 `UNVERIFIED`，缺失项必须出现在报告中。

**划分不变量**（harness 必须校验）：

- `total host calls = pre-gate unreachable + host-declared`；
- `host-declared = gate-routed + declared-not-routed`（证据采集与 gate 路由分离，见下）；
- `evaluable-kind 调用 = no-target + synthetic-target + opaque-command + resource-attributed + attribution-unprovable + multi-target`（六类互斥穷尽，每调用恰好归属一类）。

**关键区分**：PreToolUse gate 路由与 PostToolUse 证据采集是**两条独立通路**（Codex PreToolUse matcher 窄 `Bash|apply_patch|pd_submit_pain`，PostToolUse 覆盖宽）。一个调用可以被采集为证据却从未经过 gate。

| # | 分类 | 统计对象 | 分子 | 分母 | 排除项 | 可测量性 |
|---|---|---|---|---|---|---|
| 1 | hook unreachable | 宿主全量调用 | 未进入 PD 任何通路的调用数 | 宿主全量调用数（按 canonicalKind 分层） | 无 | **NOT_MEASURABLE_OFFLINE**——需宿主侧计数授权 |
| 2 | host-declared | 宿主全量调用 | hook 已声明接收的调用数 | 宿主全量调用数 | hook unreachable | 部分可测（离线仅 fixture 内比例） |
| 3a | gate-routed（PreToolUse） | host-declared 调用 | 进入 PreToolUse gate 的调用数 | host-declared 调用数 | declared-not-routed 单独计数 | 可测（fixture 内） |
| 3b | evidence-captured（PostToolUse） | host-declared 调用 | 被采集为证据的调用数 | host-declared 调用数 | 独立于 3a，可与 3a 重叠 | 可测（fixture 内） |
| 4 | non-evaluable kind | gate-routed 调用 | canonicalKind ∉ {write, execute, agent} 的调用数 | gate-routed 调用数 | — | 可测 |
| 5 | no target | evaluable-kind 调用 | normalizedPath null/empty | evaluable-kind 调用数 | — | 可测 |
| 6 | synthetic target | evaluable-kind 调用 | 合成目标（含 pathless write 的 `<tool:X>` 形态） | evaluable-kind 调用数 | — | 可测（fixture 标注）；真实分布 UNVERIFIED |
| 7 | opaque command | evaluable-kind 调用 | execute 命令文本目标（mutation regex 未命中时整串；命中时见 §6.2-5 的 heuristic 说明） | evaluable-kind 调用数 | — | 可测 |
| 8 | resource-attributed | evaluable-kind 调用 | 可归因到具体资源 | evaluable-kind 调用数 | — | 可测（fixture）；真实占比 UNVERIFIED |
| 9 | attribution unprovable | evaluable-kind 调用 | 归因不可证明 | evaluable-kind 调用数 | — | 可测（fixture） |
| 9b | multi-target | evaluable-kind 调用 | 一次调用多资源 | evaluable-kind 调用数 | — | 可测（fixture） |
| 10 | context unavailable | gate-entered 调用 | 装配 history/facts 降级 | gate-entered 调用数 | — | 可测（fixture）；真实分布 UNVERIFIED |
| 10b | provider absent | gate-routed 调用 | provider 缺席（input.context undefined） | gate-routed 调用数 | — | 可测（fixture） |
| 11 | evaluated | gate-entered 调用 | 实际进入规则评估 | gate-entered 调用数 | skipped-* 与 context unavailable/provider absent | 可测 |
| 12 | matched | evaluated 调用 | 规则命中 | evaluated 调用数 | — | 可测 |
| 13 | wouldBlock | evaluated 调用 | 决策为 **block** 且宿主 deny 映射为 probe-verified 的调用数 | evaluated 调用数 | **`requireApproval` 不计入**——生产上只有 block 变为 gate deny（`production-rulehost-gate.ts:1025-1031`）；requireApproval 在 OpenClaw 仅记录（`openclaw-plugin/src/hooks/gate.ts:683-689`），Codex/WorkBuddy 无通用暂停通道——作为 decision intent 单独报告 | 可测（fixture）；shadow wouldBlock ≠ 真实阻断 |

**两个显式命名的漏斗**（禁止混淆）：

1. **Mechanical Gate Funnel**：gate-routed → evaluable-kind → gate-entered（normalizedPath 非空）→ context-available → evaluated → matched → wouldBlock。这是生产机械现实——opaque/synthetic 目标只要 normalizedPath 非空**就会被评估**。
2. **Semantically-Attributable Funnel**：evaluated 调用中目标为 resource-attributed 的子集——语义上能支持同目标判定的部分。两个漏斗各自报告，禁止压缩为一个比率。

### 8.3 计算与报告规则

1. 每层转化率 = 分子/分母，**逐层报告，禁止跳层压缩**（如"evaluated/全量调用"这种跨维度混合比率非法——它混合了维度 A 与 B）。
2. 无法测量的项标记 `NOT_MEASURABLE_OFFLINE` 或 `UNVERIFIED`（视原因），**不得省略不报**——缺失本身必须可见。
3. 覆盖统计按宿主分层报告；聚合时给出每宿主分母，禁止混合分母。
4. fixture 集内部的覆盖率（机制正确性）与真实 workspace 覆盖率（分布真实性）是两个不同数字，报告必须分开标注。Stage 1A 只能交付前者。
5. 词汇对齐：context unavailable 的细分沿用生产已有 unavailable reason 字符串与 `RuleCodeVerificationCoverage` / `historical_evidence_only` 既有词汇，不发明平行术语。

---

## 9. Decision Semantics

### 9.1 四个必须分离的概念

| 概念 | 定义 | 生产位置 |
|---|---|---|
| `ruleDecision` | 单个 RuleCode 对输入的判定输出（`allow`/`block`/`requireApproval`/`auto_correct`——生产 RuleHost 词汇） | `RuleHostResult.decision` |
| `gateDecision` | Host Gate 合并全部规则后的门控结局（`allow`/`deny`） | `production-rulehost-gate.ts` merge 结果 |
| `hostEffect` | 宿主侧实际执行效果（工具是否真的被暂停/改写/放行） | 宿主运行时，**大多数情况下 PD 不可直接观测** |
| `degradedReason` | 证据降级原因标记（unavailable reason / fail-closed synthesis 等） | `RuleHostResult.degraded`、history unavailable reason |

### 9.2 关系与禁止事项

1. **`requireApproval` ≠ 宿主已暂停工具执行。**ruleDecision 是判定意图；宿主是否执行暂停取决于宿主 gate 集成效果（hostEffect），二者之间隔着宿主实现。
2. **`wouldBlock` ≠ 真实阻断。**wouldBlock 是反事实陈述（"若真实执行将阻断"），只在 shadow/replay 语境有意义；把它报告为"阻断"是伪造证据。
3. **规则命中 ≠ Gate 决策 ≠ 宿主效果。**三者构成漏斗：命中是规则层事实，gateDecision 是合并层事实，hostEffect 是宿主层事实。评测报告必须分层记录，禁止混用。
4. **GoldenTraceDecision 词汇（`allow`/`block`/`propose_correction`）≠ RuleHostDecision 词汇（`allow`/`block`/`requireApproval`/`auto_correct`）。**fixture 的 `goldenTraceMapping` 仅用于复用现有 Golden Trace replay 入口时的映射提示，二者不可互换使用；`propose_correction` 在 Stage 1A v2 规则范围不使用（PRI-490）。
5. `degradedReason` 是证据质量元数据，不是决策结果；它的存在**改变决策的可信度**（fail-closed 合成的 block 与证据充分的 block 不同），评测必须区分。

### 9.3 hostEffect 验证分级（冻结）

| 级别 | 含义 | 可声称 |
|---|---|---|
| `probe-verified` | 有探针/集成测试直接证据（如 WorkBuddy deny 探针） | "该通路的宿主效果已验证"（限探针范围） |
| `contract-only` | 仅有 SDK/encoder/协议契约证据 | "按契约应当如此"——不得声称已验证 |
| `unverifiable` | 当前无任何验证手段 | 必须如实标记；不得省略 |

---

## 10. Evaluation Outcome

### 10.0 Evaluation Axis（评测轴，每个 fixture 必填）

每个 fixture 通过 `evaluationAxis` 声明它测的是哪个轴——**两个轴不可在同一 fixture 中混合**：

| 轴 | 含义 | 判定基准 |
|---|---|---|
| `semantic-correctness`（默认） | 系统的行为是否符合**正确的证据语义**（本契约 §4/§5/§6） | 正确语义。当前生产实现若含已登记缺陷（§12 R1–R9），此轴上会产生 FAIL——**这是 characterization 的目的而非回归**：此类 FAIL 必须在报告中以 `defect-attributed` 标记并链接缺陷编号，与回归 FAIL 分开计数 |
| `production-conformance` | 系统的行为是否与**当前生产实现的实际行为**一致（含缺陷） | 生产现状。用于钉住现状防漂移；此轴 PASS 不构成"行为正确"的证据 |

示例：unknown 毒化整窗（R1）——`production-conformance` fixture 验证整窗确实降级（钉住现状）；`semantic-correctness` fixture 验证单行 unknown 不应否定整窗其他证据（对当前实现 FAIL，`defect-attributed: R1`）。

### 10.1 三分类冻结定义

**PASS**：证据充分、可信，且被测系统实际行为符合 fixture 全部 expectations（evidence 层 + decision 层 + safety 约束）。对于保守性期望（`neutral-or-absent`），系统确实保持中立/未命中且证据层姿态正确，记 PASS——这是评测系统的保守性，不是把 inconclusive 当成功。

**FAIL**：以下任一类：
1. **错误判断**：在证据充分、可评估的情况下，系统输出与 expectations 矛盾（正控未命中/命中错误、负控误命中）。
2. **安全约束违反**：违反任一 safety 条目或 forbiddenInferences——UNKNOWN 当 NO/YES 使用、伪造因果顺序证据、过度目标归因、把 wouldBlock 声称成真实阻断、hostEffect 越级声称。**安全违反无 inconclusive 余地。**
3. **循环验证**：标签或期望由被测系统产出（评测基础设施缺陷）。

**INCONCLUSIVE**：证据不足、身份不明、顺序不可证明、上下文降级，导致无法形成可靠结论——**前提是 fixture 期望本身要求确定性判定**。若 fixture 期望就是中立/降级姿态，则按 PASS/FAIL 判定系统是否做到了中立。

### 10.2 不得算 PASS 的情况

1. 系统"蒙对了"决策但证据层姿态错误（例如该降级未降级、该截断标记未标记）——evidence 层不匹配即 FAIL（错误判断类），不得因决策巧合而 PASS。
2. inconclusive 场景被记为负控成功——**inconclusive ≠ 负控通过**。
3. hostEffect 为 contract-only/unverifiable 却在报告中声称"阻断/放行已验证"。
4. 任一 forbiddenInference 被违反但被"总体结果正确"掩盖。

### 10.3 不得算 FAIL 的情况

1. 系统在降级/unknown/不可证明场景下保持中立——这是**正确行为**，不是失败。
2. 宿主能力边界导致的不可测（hook unreachable）——归属 `host` 类，不是被测规则的失败。
3. `semantic-correctness` 轴上由已登记缺陷导致的 FAIL——它们是 defect-attributed characterization 结果，与回归 FAIL 分开计数（§10.0），不计为规则/系统的新失败；但在该轴上它们**是** FAIL，不得计入 PASS。`production-conformance` 轴上符合缺陷现状的行为记 PASS（钉住现状），同样不得作为正确性证据。

### 10.4 失败归因五类（SPEC §9）

每次 FAIL 或意外行为必须归因其一：`data`（证据数据缺陷）/ `host`（宿主能力边界）/ `semantic`（语义/装配缺陷）/ `rule`（规则逻辑错误）/ `test`（fixture/测试基础设施错误）。禁止笼统归因"模型不行"。

### 10.5 阈值边界

**本契约不定义任何生产阻断阈值**，也不暗示"inconclusive 比例多高算不可接受"的生产标准。评测报告输出分布，阈值决策属于 Owner 与后续阶段。

---

## 11. Fixture Examples

以下 10 个示例覆盖契约要求的最小集。**§11.1 是唯一规范（normative）示例**——完整 JSON、按 §2.8 schema 机器校验；**§11.2–11.10 是非规范（non-normative）设计注释**——以结构化紧凑形式传达场景设计意图，正式 fixture 由 PRI-1310 按本契约落盘并机器校验后方可执行。每例含：输入事实 / Evidence Source / Ordering / Target Attribution / Context Availability / Expected Classification / 不允许推断 / 预期测试结果。紧凑示例中的宿主/工具名为设计意图速记，落盘时必须使用宿主真实工具名（§2.5.1）。

### 11.1 完整规范示例：确定的 blind retry（WorkBuddy，rule-logic-isolated）

**模式说明**：本例测试**规则逻辑**——给定顺序/证据假设时能否识别 blind retry。它不声称生产证据就绪：在当前生产证据能力下，ordering 无法合法达到 YES（§5.3 案例 1），因此必须使用 `rule-logic-isolated` 并显式授予 `ordering-assumed`。宿主选择 WorkBuddy 的 `Write`——生产真实的结构化 file_path 形态（Codex `apply_patch` 无直接 file_path，见 §2.5.1 特别条款）。

```json
{
  "fixtureVersion": 1,
  "fixtureId": "cae1a-blind-retry-workbuddy-01",
  "scenarioLabels": ["blind_retry_after_failure"],
  "controlClass": "positive_control",
  "evaluationMode": "rule-logic-isolated",
  "evaluationAxis": "semantic-correctness",
  "assumptionGrants": ["ordering-assumed", "coverage-assumed"],
  "description": "WorkBuddy 宿主：Write 写 src/a.ts 失败（PostToolUseFailure 通道强证据），未重新观察即再次 Write 同一文件。规则逻辑正控：给定 ordering-assumed，repeated-failure 类规则应命中。",
  "specRefs": ["PD-CAE-SPEC-v1.1 §8.3 item 1"],
  "provenance": {
    "authoredBy": "agent:PRI-1307-contract",
    "authoredAt": "2026-11-28T00:00:00.000Z",
    "baselineSha": "e30202366f53df60ccaf7589f7988cf445a52fba",
    "contractRef": "docs/reviews/PD-CAE-STAGE1A-REPLAY-CONTRACT.md",
    "labelAuthority": "contract-section-3",
    "sourceDocuments": ["docs/specs/PD-CAE-SPEC-v1.1-20261128.md", "docs/reviews/PD-CAE-STAGE0-REALITY-AUDIT.md"],
    "ruleUnderTest": null
  },
  "hostShape": {
    "host": "workbuddy",
    "preToolGateRouted": true,
    "postToolEvidenceCaptured": true,
    "windowSize": 100,
    "identityCapability": "optional",
    "factsDegradation": "conservative"
  },
  "events": [
    {
      "eventId": "e1",
      "eventKind": "observed",
      "row": {
        "id": 101,
        "session_id": "s1",
        "tool_name": "Write",
        "outcome": "failure",
        "duration_ms": 120,
        "exit_code": null,
        "error_type": "write_conflict",
        "error_message": "conflict at line 42",
        "params_json": "{\"file_path\":\"/repo/src/a.ts\",\"content\":\"x\"}",
        "result_preview": "conflict at line 42",
        "created_at": "2026-11-28T10:00:05.000Z",
        "project_dir": "/repo",
        "host_kind": "workbuddy",
        "tool_use_id": "call-001"
      },
      "scenarioMeta": {
        "writerOperation": "live_insert",
        "outcomeEvidenceClass": "live-channel-contract",
        "coverageProvenance": "complete-window-verified",
        "targetAttributionOracle": "resource-attributed",
        "truth": {
          "causalPosition": 1,
          "trueOutcome": "failure",
          "resourceIdentity": "resource:src/a.ts",
          "isObservationOfTarget": false,
          "idempotentEffect": false
        }
      }
    }
  ],
  "currentCall": {
    "invocationInput": {
      "toolName": "Write",
      "params": { "file_path": "/repo/src/a.ts", "content": "y" },
      "sessionId": "s1",
      "toolUseId": "call-002",
      "projectDir": "/repo",
      "hostKind": "workbuddy"
    },
    "currentInvocation": {
      "hookType": "PreToolUse",
      "cutoffAt": "2026-11-28T10:00:10.000Z",
      "workspaceDir": "/repo",
      "providerEnabled": true
    },
    "oracle": {
      "ruleHostEvaluability": {
        "hookRouted": true,
        "evidenceCaptured": true,
        "evaluableKind": true,
        "targetPresence": "resource-attributed",
        "gateEntry": "evaluated"
      },
      "truth": {
        "causalPosition": 2,
        "resourceIdentity": "resource:src/a.ts",
        "isObservationOfTarget": false,
        "idempotentEffect": false
      }
    }
  },
  "assembly": { "mode": "simulate", "windowTruncated": false, "contextOverride": null, "overrideJustification": null, "assemblyExpectation": null },
  "expectations": {
    "evidence": {
      "historyStatus": "available",
      "contextPresence": "present",
      "unavailableReasonClass": null,
      "truncated": false,
      "factsPosture": "computed",
      "assembledPriorReadOfTarget": "no",
      "epistemicPriorReadOfTarget": "no",
      "orderingEvidence": "insertion-only",
      "notes": "orderingEvidence 如实记录为 insertion-only；本例判定合法性完全来自 ordering-assumed 授予，不来自证据本身"
    },
    "decision": {
      "ruleDecision": { "kind": "one-of", "values": ["block", "requireApproval"], "disposition": "evaluated-matched" },
      "gateDecision": "no-expectation",
      "goldenTraceMapping": { "expectedDecision": "block", "kind": "negative" }
    },
    "safety": ["must-not-treat-unknown-as-failure", "must-not-fabricate-ordering-evidence"],
    "hostEffect": { "verifiability": "unverifiable", "expectation": "not-applicable-offline-replay" }
  },
  "forbiddenInferences": [
    "ordering-not-production-provable：顺序判定合法性完全来自 assumptionGrants，禁止将本例结果解释为'生产证据足以支持 repeated-failure YES'",
    "host-effect-unverifiable：不得声称宿主会实际阻断",
    "no-evidence-fidelity-claim：本例结果禁止计入 coverage 或证据就绪性统计"
  ]
}
```

**对照说明**：`goldenTraceMapping.kind: 'negative'`——Golden Trace 词汇中 blocking/adversarial 场景为 negative（positive 必须 expect allow，`golden-trace.ts:160-162`），与契约 `positive_control` 词汇不同维度，映射表见 §9.2-4。`assembledPriorReadOfTarget` 与 `epistemicPriorReadOfTarget` 分离——前者是生产装配输出，后者是 oracle 认知判定（本例因 coverage-assumed 授予而一致；OpenClaw 伪 no 场景两者分离）。

### 11.2 verify-then-retry（WorkBuddy，负控）

- **输入事实**：e1 write `src/b.ts` failure（通道 PostToolUseFailure，`live-channel-contract`）；e2 read `src/b.ts` success；currentCall write `src/b.ts`。全部 live，session 一致，call_id 均在场。
- **Evidence Source**：失败为 live-channel-contract（强）；观察为 read 事件存在。
- **Ordering**：insertion-only（生产证据现实）；本例在 rule-logic-isolated 模式 + ordering-assumed 下测规则逻辑，关键是 e2 观察事件的存在性。
- **Target Attribution**：三者 resource-attributed，truth resourceIdentity 全同；e2 `isObservationOfTarget: true`。
- **Context Availability**：available，未截断，facts computed，`priorReadOfTarget` 应为 `yes`。
- **Expected Classification**：`verify_then_retry` / negative_control。
- **不允许推断**：不得因"同资源多次 write"命中 blind retry；观察事件存在即否定 blind retry 成立条件。
- **预期测试结果**：PASS = 规则不命中（`neutral-or-absent`）且 facts `priorReadOfTarget: 'yes'`；若规则仍命中 repeated-failure 类 → FAIL（错误判断，`rule` 类归因）。

### 11.3 幂等重试（Codex，负控）

- **输入事实**：e1 `bash` 执行 `mkdir -p /tmp/build` outcome failure（timeout，`live-exit-code`）；currentCall 同一命令。
- **Evidence Source**：exit code 强证据；但关键在 truth `idempotentEffect: true`。
- **Ordering**：insertion-only；rule-logic-isolated 模式 + ordering-assumed。
- **Target Attribution**：注意生产现实——mkdir/touch/rm 等 mutation regex 会提取路径（rule-host-input-builder.ts:239-247），`mkdir -p /tmp/build` 的 normalizedPath 是 `/tmp/build` 而非整串命令；该提取是启发式的，同目标判定认知上仍不可做。
- **Context Availability**：available。
- **Expected Classification**：`idempotent_retry`（+ `opaque_target` 辅助标签）/ negative_control。
- **不允许推断**：幂等性不可从观测推导——本例测试 oracle 是否承认该边界；同时 execute 类多数不归因目标，repeated-failure 同目标判定本就不成立。
- **预期测试结果**：PASS = 不命中 repeated-failure（双重理由：幂等 + 目标不归因）；命中 → FAIL（`rule` 或 `semantic` 类）。

### 11.4 different target（WorkBuddy，负控）

- **输入事实**：e1 patch `src/a.ts` failure；currentCall patch `src/b.ts`。
- **Evidence Source**：live-envelope-error。
- **Ordering**：insertion-only；rule-logic-isolated 模式 + ordering-assumed。
- **Target Attribution**：两侧均 resource-attributed；truth resourceIdentity 不同。
- **Context Availability**：available。
- **Expected Classification**：`different_target` / negative_control。
- **不允许推断**：path 串不等仅是启发式——本例不同性由 truth 确认；评测的是系统是否仅靠"同工具连续调用"误命中。
- **预期测试结果**：PASS = 不命中；误命中 → FAIL（目标归因过度推断，安全违反）。

### 11.5 unknown outcome（Codex，inconclusive）

- **输入事实**：e1 `bash` `python manage.py migrate` outcome `unknown`（`none-unknown`，text_only_response 语义）；currentCall 同一命令。
- **Evidence Source**：`none-unknown`——无可信结果证据。
- **Ordering**：insertion-only。
- **Target Attribution**：opaque-command。
- **Context Availability**：**生产现状**：单行 unknown 毒化整窗 → history unavailable（fixture 验证此降级行为，不假设已修复）。
- **Expected Classification**：`unknown_outcome` / inconclusive_evidence。
- **不允许推断**：unknown ≠ 失败（不得命中）；unknown ≠ 成功/无问题（不得确认安全）。
- **预期测试结果**：PASS = 系统降级（`neutral-or-absent` + `historyStatus: 'unavailable'` 或保守 facts）；若命中 repeated-failure → FAIL（UNKNOWN 当 YES，安全违反）；若报告"无问题" → FAIL（UNKNOWN 当 NO，安全违反）。FIXTURE 期望：即使未来毒化行为修复，unknown outcome 下单次未知结果仍不构成 repeated-failure 证据。

### 11.6 backfill inversion（WorkBuddy，inconclusive）

- **输入事实**（两个变体，落盘时拆分为两个独立 fixture）：**变体 A（INSERT 顺序反转）**：e-observe（causalPosition 2，read `src/c.ts` success，live_insert，row.id 100）；e-fail（causalPosition 1，write `src/c.ts` 真实先失败，backfill verified_insert 补行 row.id 105——id 序与因果序相反）。**变体 B（UPDATE hindsight）**：e-fail 行 live_insert 时 outcome 为 unknown（row.id 98），verified_update 事后原位升级为 failure——行序不变，但**决策时点（cutoffAt 早于 upgrade）可见的是 unknown**：as-of-decision 投影必须使用 preUpdateOutcome（§2.4.4），否则构成 hindsight leakage。
- **Evidence Source**：`verified-transcript-upgrade`。
- **Ordering**：**conflicted**——UPDATE 情形下行序不变但 outcome 事后变化；INSERT 情形下 id 序与因果序相反。可见顺序 ≠ 真实顺序。
- **Target Attribution**：均 resource-attributed 同资源。
- **Context Availability**：available，但 orderingEvidence = conflicted。
- **Expected Classification**：`backfill_order_inversion` / inconclusive_evidence。
- **不允许推断**：禁止按 insertion 顺序断言"先观察后失败"或反之；repeated-failure 结论必须 inconclusive/neutral（§5.4 强制约束）。
- **预期测试结果**：PASS = 系统不命中且保持中立；命中（依赖可见顺序伪造因果）→ FAIL（安全违反 `must-not-fabricate-ordering-evidence`）。

### 11.7 OpenClaw duplicate-call ambiguity（inconclusive）

- **输入事实**：一行可见 write `src/config.json`（observed，row.id 201，无 toolUseId——OpenClaw 身份能力 absent），外加一个 absent 事件（eventKind: absent，absenceReason: dedupe-folded）——真实第二次相同调用被 content-shape dedupe 折叠未成行。oracle 知道真实发生了两次；被测系统只能看到一行。
- **Evidence Source**：`live-result-shape-inferred`（弱）或 `authored-synthetic`。
- **Ordering**：insertion-only；但关键问题是**身份**：content-shape dedupe 可能折叠真实重复——两行是一次调用被记录两次，还是两次独立调用，不可区分。
- **Target Attribution**：resource-attributed（若两行都入窗）。
- **Context Availability**：available。
- **Expected Classification**：`duplicate_calls` / inconclusive_evidence。
- **不允许推断**：禁止判"重复调用"（两次独立），也禁止判"同一次"（dedupe 假象）——次数命题 UNKNOWN（U7）。
- **预期测试结果**：PASS = 次数相关判定保持 UNKNOWN，规则中立；命中"重复执行" → FAIL（身份歧义被任意消解，安全违反）。

### 11.8 truncated facts（OpenClaw，inconclusive）

- **输入事实**：20 行窗口（OpenClaw windowSize）中前 18 行为无关调用，e-fail（write `src/d.ts` failure）与 e-read（read 同文件 success）落在窗口外；read 返回 truncated:true。
- **Evidence Source**：行存在但窗口读不到。
- **Ordering**：不可用于判定（相关事件不可见）。
- **Target Attribution**：currentCall resource-attributed，但历史不可见。
- **Context Availability**：history available 但 truncated:true；facts——OpenClaw 无降级（已知缺陷）可能输出伪 `priorReadOfTarget: 'no'`。
- **Expected Classification**：`truncated_history` / inconclusive_evidence。
- **不允许推断**：否定命题不成立（"窗口内无失败" ≠ "无失败"，U2）；OpenClaw 的伪 `no` 不得被当作真实否定证据。
- **预期测试结果**：PASS = 中立/不命中，且评测报告**如实记录** OpenClaw facts 未降级行为为已知缺陷（`semantic` 类归因，引用审计条目）而非正确性基准；若系统命中 repeated-failure 或声称"确认无先前失败" → FAIL。

### 11.9 opaque shell command（Codex，inconclusive）

- **输入事实**：e1 `bash` `python manage.py migrate --settings=prod` exit 1 failure（`live-exit-code`）；currentCall 同一命令串。注意选用 mutation regex 之外的命令——rm/mv/mkdir/touch/cp/sed -i 会被生产路径提取（rule-host-input-builder.ts:239-247），不构成整串 opaque。
- **Evidence Source**：exit code 强。
- **Ordering**：insertion-only。
- **Target Attribution**：**opaque-command**——normalizedPath 为整串命令原文（mutation regex 未命中）；命令中路径样文本碎片不是归因资源。
- **Context Availability**：available。
- **Expected Classification**：`opaque_target` / inconclusive_evidence。
- **不允许推断**：命令串相同 ≠ 同一资源；normalizedPath 非空 ≠ 资源归因成立。
- **预期测试结果**：PASS = 同目标判定不做，规则对 repeated-failure 保持中立；把命令文本当资源命中 → FAIL（目标归因过度推断，安全违反）。

### 11.10 host effect 不可证明（WorkBuddy，安全边界）

- **输入事实**：与 11.1 同构的 blind retry 正控，但评测关注 hostEffect 层：fixture `hostEffect.verifiability: 'contract-only'`（deny 通路的 encoder/SDK 契约证据，无探针）。
- **Evidence Source / Ordering / Target Attribution / Context Availability**：同 11.1。
- **Expected Classification**：`blind_retry_after_failure` / positive_control。
- **不允许推断**：`requireApproval`/`block` 决策 ≠ 宿主已暂停执行；contract-only 证据不得声称"宿主阻断已验证"；wouldBlock ≠ 真实阻断。
- **预期测试结果**：PASS = 决策层命中正确 **且** 报告将 hostEffect 如实标记为 contract-only；若报告声称"已验证阻断" → FAIL（hostEffect 越级声称，安全违反）。

### 11.11 示例集与标签覆盖矩阵

| 示例 | 标签 | controlClass | 覆盖的核心条款 |
|---|---|---|---|
| 11.1 blind retry | blind_retry_after_failure | positive_control | §3.1, §4, §5 假设边界 |
| 11.2 verify-then-retry | verify_then_retry | negative_control | §3.2, facts priorReadOfTarget |
| 11.3 idempotent | idempotent_retry + opaque_target | negative_control | §3.3 幂等不可观测 |
| 11.4 different target | different_target | negative_control | §3.4, §6 |
| 11.5 unknown outcome | unknown_outcome | inconclusive_evidence | §3.5, §4 U1, 毒化 characterization |
| 11.6 backfill inversion | backfill_order_inversion | inconclusive_evidence | §3.6, §5 |
| 11.7 duplicate ambiguity | duplicate_calls | inconclusive_evidence | §3.10, §4 U7, §7 OpenClaw |
| 11.8 truncated facts | truncated_history | inconclusive_evidence | §3.9, §4 U2/U6 |
| 11.9 opaque command | opaque_target | inconclusive_evidence | §3.7, §6.2 |
| 11.10 host effect | blind_retry_after_failure | positive_control | §9, §10.2 hostEffect 分级 |

---

## 12. 记录的生产实现问题（不修复，仅登记）

以下来自 Stage 0 审计与子代理调查，本契约 fixture 将其作为 characterization 对象，**修复不属于本工单范围**：

| # | 问题 | 位置/证据 | 影响 | 建议归属 |
|---|---|---|---|---|
| R1 | 任一行校验失败即整窗降级 unavailable，毒化类共 5 种：空/非字符串 tool_name（:33-35）、outcome 非合法 `RuleToolOutcome`——writer 词汇 `unknown` 在此失败（:37-41）、params_json 非字符串（:45-47）、params_json 非法 JSON（:52-54）、params_json 非 object（:57-59）；单行问题毒化整个窗口，无逐行降级 | `host-runtime/src/behavior-history.ts:22-59`（`assembleBehaviorHistory`） | 证据可用性过度降级 | PRI-1308/后续 |
| R2 | `RuleToolOutcome` 仅 `success\|failure\|blocked`，无 unknown——writer 词汇（含合法 `unknown`）与装配词汇不对称，unknown 语义在装配边界丢失并转化为整窗降级 | `principles-core/src/runtime/internalization/rule-context-v2.ts:30` | unknown 语义在装配边界丢失 | PRI-1308 |
| R3 | OpenClaw facts 无 conservative 降级，truncated/execute/other 可输出伪 `priorReadOfTarget='no'` | 审计 P1 系列 | 伪否定证据 | PRI-1309 |
| R4 | `BehaviorExamplePackAssembler.buildSelectedCase` 是第 4 个非保守 facts 位点（截断窗口无降级） | 子代理 B 调查 | 同上 | 后续工单 |
| R5 | OpenClaw toolCallId/runId 未透传（适配器全文件无 `toolUseId`/`toolCallId` 引用——缺席证据）；content-shape dedupe 折叠真实重复 | `openclaw-plugin/src/host-runtime/openclaw-host-runtime.ts` | 身份歧义 | PRI-1309 |
| R6 | verified backfill INSERT 列清单不含 project_dir（:383）；UPDATE/INSERT 改变可见顺序/状态 | `host-runtime/src/production-pain-evidence.ts:336-383` | 顺序与归属证据弱化 | PRI-1308 |
| R7 | P2-2 Artificer prompt ordering 矛盾 | 审计 P2-2 | 已知 blocker，标注不修复 | 后续工单 |
| R8 | `workspace-behavior-evidence.ts:180-181` 注释与自身 host_kind 逻辑矛盾（过时注释） | 子代理 A 调查 | 文档噪声 | 后续小修 |
| R9 | GoldenTraceDecision 与 RuleHostDecision 两套决策词汇并存 | `golden-trace.ts` vs `rule-host` | 概念混淆风险（本契约 §9.2-4 已冻结区分） | 本契约已覆盖 |

---

## 13. 契约维护

1. 本文变更须按治理流程（分支 + PR + Owner 审查），不允许无 PR 自直推。
2. 任何新标签/新枚举值的添加必须同时更新：§3 定义、§2.8 schema、§11 示例覆盖矩阵。
3. 后续工单（PRI-1308/1309/1310 等）发现契约不足时，先修订契约再实现——契约先行。

