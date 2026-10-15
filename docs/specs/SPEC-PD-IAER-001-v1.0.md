# SPEC-PD-IAER-001 v1.0

# PD 内置代理证据就绪与可靠执行修复

**英文名称：** Internal Agent Evidence Readiness & Reliable Execution

**状态：** Proposed — Implementation Ready
**优先级：** P0
**目标分支：** 基于 PD `39ebac3f5` 创建独立实施分支
**参考 Pi 版本：** 本地 Pi 1.2.0，`b06c1f2cf`
**当前 PD 运行依赖：** Pi 0.85.1

## 1. 执行摘要

本 SPEC 修复 PD 内部代理管道中已由生产数据证实的输入契约和任务恢复缺陷。

**核心问题：**

Artificer V2 生成 RuleCode 必须获得真实、经过 Owner 标注的 `BehaviorExamplePack`。

目前专用 RuleHost CLI 已提供 Owner 标注案例的读取和组装路径，但自动消费者创建 ArtificerRunner 时，没有注入该证据包。

因此 ArtificerRunner 在模型调用前抛出 `behavior_example_pack_missing` 普通 Error，随后被通用 Runner 处理为可重试的执行失败，导致无效重试和错误的故障统计。

**目标行为：**

> 缺少可信输入时，代理不执行、不伪造、不盲目重试；系统明确记录证据缺口，允许 Owner 补充后安全恢复。获得完整证据时，Artificer 按原有 L2 验证和治理流程正常工作。

本次不以扩大多轮 Agent 的使用范围为目标。

## 2. 已核实的生产事实

### 2.1 版本基线

| 组件 | 当前状态 |
|---|---|
| PD 源码 | `39ebac3f5` |
| Pi 本地最新源码 | 1.2.0 |
| PD 声明的 Pi 依赖 | `^0.85.1` |
| 实际安装的 Pi SDK | 0.85.1 |
| Dreamer L2 | 生产配置关闭 |
| Code Rule Capability | 生产配置开启 |
| Artificer Output Retry | 生产配置开启 |

### 2.2 生产数据

数据来源：`D:\.openclaw\workspace\.pd\state.db`

审计时：

- 运行记录总数：2,036。
- Artificer L2 运行记录：401。
- Artificer L2 失败记录：385。
- 上述 385 条失败全部包含 `behavior_example_pack_missing`。
- 其中 251 条归类为 `execution_failed`，134 条归类为 `max_attempts_exceeded`。
- 失败运行中位耗时约 0.01 秒，说明绝大多数未进入真正的多轮模型执行。
- 9 月 23 日后新增 51 条相同类型的失败记录。

这些数据反映的是运行尝试次数，不是 385 个独立失败任务。

### 2.3 关键源码

| 位置 | 已确认事实 |
|---|---|
| `packages/host-runtime/src/internalization-consumer-cycle.ts:458–500` | 根据 Artificer 任务类型及功能开关选择 L2 |
| 同文件 `:627–631` | 创建 ArtificerRunner 时未提供 `behaviorExamplePack` |
| `packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts:548–562` | Runner 从依赖中获取 BehaviorExamplePack |
| 同文件 `:828–829` | 缺失证据包时抛出普通 Error |
| `packages/principles-core/src/runtime-v2/runner/base-peer-runner.ts:223–341` | 任务 Lease、上下文构造、执行、验证生命周期 |
| 同文件 `:675–800` | 持久错误分类与重试状态机 |
| `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:455–486` | CLI 已包含证据包前置检查及注入 |
| `packages/openclaw-plugin/src/core/behavior-example-pack-assembler.ts:96–145` | 已有可信证据包组装实现 |
| `packages/principles-core/src/runtime-v2/internalization/behavior-example-pack.ts` | 已有证据包合同及校验逻辑 |

## 3. 目标与非目标

### 3.1 必须达成的目标

**G1 — 统一证据前置条件**

Artificer V2 的所有生产入口必须遵守相同的证据就绪合同。

**G2 — 消除无效重试**

缺少 Owner 证据包、证据引用失效等不可通过重试自动恢复的问题，不得消耗模型调用和自动重试次数。

**G3 — 支持 Owner 恢复**

缺失证据的任务必须有明确、持久化、可查看的状态。Owner 提供有效证据后，可恢复执行。

**G4 — 保持 RuleCode 安全边界**

不得自动伪造 Owner 标注案例，不得绕过确定性重放、Evaluator、Owner 审批和激活控制。

**G5 — 修复诊断统计**

区分输入准备失败、模型执行失败、业务验证失败以及任务最终状态。

### 3.2 非目标

本次明确不做：

- 不升级 Pi 0.85.1 至 1.2.0。
- 不全面切换内置代理为 L2。
- 不引入 Codemode 或 Pi Durable。
- 不改变 RootCause 的推理模式。
- 不重构 Dreamer、Philosopher、Scribe。
- 不改变 RuleHost 的准入与激活安全策略。
- 不用模型自动生成虚假的 Owner 正反例。
- 不自动重放全部历史失败任务。

Pi 兼容性迁移和自适应 L1/L2 属于后续独立 SPEC。

## 4. 目标执行架构

### 4.1 正常执行

```text
Pain / 上游原则候选
        |
        v
确定性判断是否需要 RuleCode
        |
        v
Owner Evidence Readiness Check
        |
        +-- 有效证据包
        |        |
        |        v
        |   Artificer L2
        |        |
        |   生成 -> 验证 -> 修复
        |        |
        |        v
        |   Evaluator + Sandbox Replay
        |        |
        |        v
        |   现有治理与 Owner 审批
        |
        +-- 缺失/无效证据
                 |
                 v
         needs_human_review
                 |
                 v
          Owner 补充证据
                 |
                 v
          校验 -> 安全恢复
```

### 4.2 任务选择约束

当前自动消费者的 Artificer L2 选择条件主要依赖任务类型和 `code_rule_capability`。

必须补充权威的目标通道判断。

任务确实要求生产 RuleCode 时，必须遵守 V2 证据合同。

任务不需要代码规则时，按其合法的管道职责执行，不得仅因为任务名称为 `artificer` 就自动进入代码生成模式。

不得根据模型自由文本猜测目标通道。

**严禁把缺失证据的 Code Rule 任务静默降级为不需要证据的 V1 RuleCode。**

## 5. 功能需求

### FR-01：统一 Evidence Readiness Gate

**优先级：P0**

建立共享的、无副作用的证据就绪判断合同。

输入至少包含：

- workspace 身份；
- canonical Pain ID；
- 目标任务 ID；
- 权威目标通道；
- Owner 标注的行为案例引用；
- 当前证据版本或修订标识。

输出使用结构化判别联合类型：

```typescript
type EvidenceReadiness =
  | {
      status: 'ready';
      pack: BehaviorExamplePack;
      evidenceHash: string;
      sourcePainId: string;
    }
  | {
      status: 'owner_evidence_required';
      reasonCode: string;
      missingFields: string[];
      nextAction: string;
    }
  | {
      status: 'invalid_evidence';
      reasonCode: string;
      nextAction: string;
    }
  | {
      status: 'not_applicable';
    };
```

该类型为目标合同示意，实际字段须沿用现有项目类型命名规范。

必要验证：

1. Owner 原始意图非空。
2. 存在 1 条 Owner 选定的负面案例。
3. 存在 1–3 条 Owner 选定的正面案例。
4. 所选工具调用来自对应 Pain 的合法证据范围。
5. Tool Call ID 唯一、可解析。
6. 证据包通过既有 `validateBehaviorExamplePack()`。
7. 不得跨 workspace、跨 Pain 或跨 Owner 权限使用证据。
8. 不得将工具成功/失败结果本身视为 Owner 标注。

应复用现有 `BehaviorExamplePackAssembler` 和验证器，而不是创建第二套不一致的验证逻辑。

### FR-02：自动消费者前置拦截

**优先级：P0**

在 `internalization-consumer-cycle.ts` 增加前置检查。

对需要 RuleCode 的任务：

- Evidence Ready：注入有效证据包，进入原有 L2。
- Evidence Missing：记录明确原因，不调用 LLM。
- Evidence Invalid：拒绝继续，保存诊断信息。
- Evidence Not Applicable：按照权威通道规则处理，不创建无关 RuleCode。

证据校验必须发生在真正的模型执行之前。

**验收要求：**

缺失证据时：

- 模型调用次数为 0；
- Artificer 工具调用次数为 0；
- 不创建成功产物；
- 不启动 Evaluator 代码审查；
- 不触发 RuleHost 激活；
- 不进入自动重试循环。

对纯前置拦截，原则上不应创建新的模型运行记录，也不应消耗任务 attemptCount。

### FR-03：可信证据来源与持久化

**优先级：P0**

Owner 标注来源采用现有合同：

- `ownerDesiredOutcome`
- `sourceNegativeToolCallId`
- `positiveToolCallIds`

这些字段必须由经授权的 Owner 操作提供，而非由内置代理自行填写。

在任务持久状态中保存证据选择的版本化引用、内容摘要、Owner 操作来源和关联 Pain ID。

首选复用现有任务元数据与证据存储机制。不要在 `diagnosticJson` 中重复存放整段原始会话或敏感工具输出。

应保留：

- 证据选择引用；
- 修订版本；
- SHA-256 内容摘要；
- 权威 Owner 操作记录引用；
- 创建/更新时刻；
- 关联 Pain、workspace、task。

实际证据内容从权威轨迹数据库恢复，经既有净化与脱敏后组装。

如轨迹被清理或证据内容变化，必须拒绝无声复用旧引用。

必须通过接口注入证据读取能力，避免 Core 直接依赖 OpenClaw 插件实现。

### FR-04：缺失证据的任务状态

**优先级：P0**

复用已有任务状态：

`needs_human_review`

无需新增数据库级任务状态。

通过结构化 `reasonCode` 区分等待证据与其他人工恢复任务。

建议稳定原因码：

- `owner_behavior_examples_required`
- `owner_behavior_examples_invalid`
- `owner_behavior_examples_stale`
- `owner_behavior_examples_scope_mismatch`

诊断信息必须包含下一步恢复动作。

不得将这些情况全部归类为 `execution_failed` 或 `max_attempts_exceeded`。

注意：`needs_human_review` 表示需要授权处理，不等于 Owner 已批准原则或代码执行。

### FR-05：消除重复重试

**优先级：P0**

修复 `ArtificerRunner.invokeRuntime()` 当前的普通 Error 路径。

即使入口前置检查被绕过，Runner 也必须执行防御性证据校验。

缺失证据时：

- 抛出项目标准的结构化输入错误；
- 不进入模型层重试；
- 不进入 L1 fallback；
- 不重新分配完整执行预算；
- 生成可操作的诊断信息。

推荐：

`PDRuntimeError('input_invalid', ...)`

但仅靠此修改不能实现完整的 Owner 恢复流程。

因此必须同时实施 FR-02 和 FR-04，不能只把普通 Error 改成新的异常类型就宣布完成。

### FR-06：Owner 补充证据并恢复

**优先级：P0**

提供可执行的恢复入口，优先复用现有 CLI 命令体系。

要求支持：

1. 查询等待 Owner 证据的 Artificer 任务。
2. 查看缺失字段、Pain 关联和下一步动作。
3. 选择真实负面及正面 Tool Call。
4. 输入 Owner 希望实现的行为结果。
5. 校验证据引用、来源和权限。
6. 持久化证据选择。
7. 以原子状态迁移将任务转为可调度状态。
8. 恢复执行，并保留原任务历史。

**恢复条件：**

只有经授权的操作明确提交了完整、有效的证据选择，才允许恢复。

必须采用带前置状态和版本检查的 SQLite 原子更新，防止两个并发消费者同时恢复、重复执行。

不允许仅通过修改 YAML 开关、重启服务或超时扫描就自动解除证据等待状态。

如原任务重试预算已经耗尽，必须走显式的受控重建或重新调度路径，不得在后台直接清零历史 attemptCount。

### FR-07：统一 CLI 和自动消费者合同

**优先级：P0**

以下入口必须共用同一 Evidence Readiness 语义：

- 自动 internalization consumer；
- 专用 RuleHost pipeline CLI；
- 其他实际可以触发 Artificer V2 的生产入口。

不得出现 CLI 要求 Owner 证据，而自动消费者绕过输入组装直接调用 Runner 的情况。

现有 CLI 行为需要保持向后兼容：

- 有效证据包可正常执行；
- 缺失或无效证据必须拒绝；
- 不产生 V1 RuleCode fallback；
- 原有命令参数保持有效。

### FR-08：统一运行结果与遥测关联

**优先级：P1，本 SPEC 内完成**

现有关键遥测的 `runId` 无法直接对应治理库中的全部 `runs.run_id`。

要求统一记录至少以下标识：

- taskId；
- 持久化 Run ID；
- Adapter Run ID；
- attemptNumber；
- workspace；
- agentKind；
- executionMode；
- reasonCode。

**所有关键事件必须能够通过稳定引用追溯到权威任务和运行记录。**

建议事件包括：

- `artificer_evidence_readiness_checked`
- `artificer_blocked_on_owner_evidence`
- `artificer_owner_evidence_attached`
- `artificer_owner_evidence_resumed`
- `artificer_input_contract_rejected`

记录运行摘要、错误类型和证据引用摘要，不复制原始私密执行轨迹。

### FR-09：历史异常任务审计和恢复工具

**优先级：P1**

提供只读的历史扫描功能，识别：

- 因 `behavior_example_pack_missing` 失败的任务；
- 同一任务多次消耗重试次数；
- 已有成功制品但最终任务失败的情况；
- 已产生审批或其他治理副作用的任务。

输出按独立 Task ID 聚合，而不是只按运行次数聚合。

默认 `dry-run`。

历史任务不得批量自动恢复，也不得覆盖已有成功制品或治理结果。

支持 Owner 对选定任务逐个执行恢复或重新调度。

## 6. 关键状态机

### 6.1 缺失证据

```text
pending
  |
  | preflight: evidence missing
  v
needs_human_review
  |
  | Owner submits valid evidence
  | atomic state + evidence revision check
  v
pending
  |
  v
leased -> running -> validated -> succeeded
```

### 6.2 无效证据

无效、过期、跨范围的证据不得进入模型执行。

需要区分：

- Owner 尚未提供证据：等待 Owner。
- Owner 提供了不合格证据：等待修正。
- 存储不可用：保留明确的存储故障，不误判为 Owner 尚未标注。
- 任务已提交且存在恢复权威记录：优先遵守既有 completion-intent 机制。

### 6.3 并发要求

状态迁移必须同时校验：

- 期望任务状态；
- 当前证据修订；
- workspace / Pain 归属；
- 已存在的 Lease 和完成意图。

不得依赖先读取状态、随后无条件调用 `updateTask()` 的非原子流程。

## 7. 兼容性与安全约束

**C-01：** 不更改现有 `PDTaskStatus` 枚举。

**C-02：** 不改变既有 Owner 审批及 RuleHost 执行权威。

**C-03：** 不产生缺少 Owner 证据的可执行 RuleCode。

**C-04：** 不把模型生成的案例当作 Owner 标注的负例或正例。

**C-05：** 不把 RuleHost 的输入错误自动替换为一般文本原则并声称代码执行成功。

**C-06：** 不改变 Dreamer、Philosopher、Scribe 等代理的生产执行模式。

**C-07：** 现有 completion-intent、任务 Lease、幂等提交和恢复机制必须保持有效。

**C-08：** 证据缺失、证据失效、模型失败、Schema 失败必须使用不同的诊断原因。

**C-09：** 所有敏感轨迹仅在授权 workspace 范围内读取，不进入公开日志。

## 8. 预计修改范围

| 模块 | 修改内容 |
|---|---|
| `host-runtime/src/internalization-consumer-cycle.ts` | 前置证据检查、按权威通道分流、Runner 注入、阻断和遥测 |
| `principles-core/src/runtime-v2/internalization/artificer-runner.ts` | 结构化输入错误、防御性证据校验 |
| `principles-core/src/runtime-v2/internalization/behavior-example-pack.ts` | 复用验证合同，必要时扩展只读判定 |
| `principles-core/src/runtime-v2/store/` | 证据引用持久化、原子状态转换、恢复入口 |
| `openclaw-plugin/src/core/behavior-example-pack-assembler.ts` | 复用原有证据组装与来源验证；避免重复逻辑 |
| `pd-cli/src/services/rulehost-pipeline-runner.ts` | 与自动消费者对齐就绪检查 |
| `pd-cli/src/commands/` | 查询、附加证据及受控恢复操作 |
| Runtime Telemetry | 关联持久化 Run ID 与 Adapter Run ID |

最终具体文件清单以实施时的调用链核查为准，不允许因此扩大到无关子系统。

## 9. 测试计划

### T01：缺失证据前置拦截

给定合法的 Artificer V2 任务，但无 Owner 证据。

预期：

- 任务进入 `needs_human_review`；
- reasonCode 正确；
- 0 次模型调用；
- 0 次 Artificer 工具调用；
- 无新 RuleCode 产物；
- 没有自动重试。

### T02：同一任务重复消费者唤醒

连续触发 10 次消费尝试。

预期：

- 任务保持 `needs_human_review`；
- attemptCount 不增加；
- 不发生重复模型调用；
- 不创建重复产物。

### T03：有效 Owner 证据

提供符合合同的真实负例及正例。

预期：

- 通过现有组装器和 Schema 校验；
- 成功注入 Artificer；
- 允许进入原有 L2 工具循环；
- 不绕过 Evaluator 或沙箱检查。

### T04：不可信或失效证据

覆盖：

- 负例不存在；
- 正例不存在；
- 重复 Tool Call ID；
- 跨 Pain 引用；
- 跨 session 引用；
- 跨 workspace 引用；
- 证据内容已变化；
- 非 Owner 来源提交；
- 恶意 JSON 字段。

预期：全部明确拒绝，不发生模型调用。

### T05：Owner 恢复

任务等待证据时，Owner 补充有效案例并恢复。

预期：

- 授权被验证；
- 证据修订持久保存；
- 状态原子变更；
- 恢复后的任务正常执行；
- 历史审计记录保留。

### T06：并发竞争

两个消费者同时准备执行同一任务。

预期：

- 最多一个消费者获得有效执行资格；
- 不会重复注入证据或启动模型；
- 不会绕过任务 Lease。

### T07：不可重试错误分类

构造 Runner 防御性检查缺失证据包的情况。

预期：

- 返回正确的结构化输入错误；
- 不进入 `execution_failed` 重试循环；
- 错误中保留稳定 reasonCode 和 nextAction。

### T08：不同任务通道

分别构造：

- 需要 RuleCode 的任务；
- 不需要 RuleCode 的任务；
- 目标通道无法从权威元数据解析的任务。

预期：

- 只有合格代码任务进入 Artificer V2；
- 非代码任务不被误路由；
- 通道不明时拒绝猜测；
- 不发生代码规则的静默降级。

### T09：CLI 回归

使用现有 RuleHost CLI：

- 有效案例执行正常；
- 无效案例提前失败；
- 原参数保持兼容；
- 不引入新的 V1 RuleCode 回退。

### T10：真实 SQLite 集成测试

使用临时 workspace 和真实 SQLite 存储，覆盖：

- 证据提交；
- 原子状态转换；
- 消费者重启；
- 任务恢复；
- 重复恢复请求；
- 运行 ID 关联。

禁止只用完全 Mock 的任务状态验证端到端行为。

### T11：历史数据只读审计

在历史数据副本上运行扫描。

预期：

- 能按任务归并同类失败；
- 不将 385 次运行错误报成 385 个独立任务；
- 保留历史成功运行与后续失败的完整序列；
- 不修改生产数据库。

## 10. 实施阶段

### Phase A：P0 输入契约修复

交付：

- Evidence Readiness Gate；
- 自动消费者接线；
- Runner 类型化输入错误；
- `needs_human_review` 状态转换；
- 必需输入失败零自动重试；
- 必需单元与 SQLite 集成测试。

**退出条件：** 缺失证据不再导致 `behavior_example_pack_missing` 重试风暴。

### Phase B：Owner 恢复闭环

交付：

- Owner 证据选择的持久化引用；
- 受控附加及恢复入口；
- 并发 CAS 防护；
- CLI / Consumer 等价合同；
- 安全恢复 E2E。

**退出条件：** Owner 补充证据后，真实任务能恢复且不破坏原有治理边界。

### Phase C：可观测性与历史处理

交付：

- 统一运行关联标识；
- 输入错误专项统计；
- 历史任务 dry-run 审计；
- 回归测试及实施报告。

**退出条件：** 每次失败均能明确归属到输入、执行、验证或提交阶段。

## 11. 发布与回滚

要求使用独立分支和可回滚的增量改造。

不得通过全局关闭 `code_rule_capability` 来掩盖缺陷。

对需要开关的新消费者接线逻辑，提供明确的回滚能力。但无论开关状态如何，**不得恢复会反复调用缺失证据任务的旧危险行为**。

发布前必须完成：

- TypeScript Typecheck；
- 相关单元测试；
- SQLite 集成测试；
- 自动消费者 E2E；
- CLI 回归；
- Owner 恢复测试；
- 全部现有治理门控回归；
- 无真实外部模型费用的故障注入测试。

发布后，按照固定观察窗口检查生产任务数据，不得以单次成功作为验收完成依据。

## 12. 最终验收标准

| 编号 | 验收要求 |
|---|---|
| AC-01 | 无有效 BehaviorExamplePack 时，Artificer V2 模型调用数 = 0 |
| AC-02 | 缺失证据不再产生重复 `execution_failed` 或 `max_attempts_exceeded` |
| AC-03 | 证据等待状态可持久查询，并保留稳定 reasonCode |
| AC-04 | Owner 补充证据后可以安全、幂等地恢复 |
| AC-05 | 所有 V2 执行均通过同一证据合同 |
| AC-06 | 不发生 Owner 标注伪造、跨 Pain 证据污染 |
| AC-07 | 不发生未授权的 RuleCode 生成、激活或静默降级 |
| AC-08 | CLI、Consumer 和 Runner 的输入行为一致 |
| AC-09 | Adapter 运行与持久化 Run 可以关联审计 |
| AC-10 | 历史扫描默认为只读且按独立任务汇总 |
| AC-11 | 现有任务 Lease、completion intent 和治理门控回归通过 |
| AC-12 | 与 Pi 0.85.1 当前运行环境保持兼容 |

## 13. 完成定义（Definition of Done）

以下条件全部成立，才能宣布 SPEC 完成：

1. Phase A、B、C 全部完成。
2. 所有验收测试通过。
3. 没有未解决的 P0/P1 安全和数据一致性缺陷。
4. 所有代码变更可追溯到本 SPEC 的 FR/AC。
5. 在隔离测试中证明缺失 Owner 证据不会触发 LLM。
6. 在真实 SQLite E2E 中证明 Owner 补证和恢复有效。
7. 历史异常数据扫描完成，产生可复核的报告。
8. 主分支已通过相关 CI 门禁。
9. 实施报告记录修改文件、测试证据、残余风险及回滚方式。

**最终验收原则：**

修复完成不是把失败次数隐藏为零，而是使无效任务被正确阻断、可由 Owner 恢复，并使真正具备条件的 Artificer L2 能继续执行可信的代码规则生成与验证。

---

## 14. 后续独立 SPEC

本 SPEC 完成后，才进入以下工作。

**SPEC-PD-PI12-COMPAT-001：Pi 1.2.0 兼容性迁移**

包括 `shouldStopAfterTurn` → `finishTurn`、工具结果合同、统一 Deadline、结构化输出、运行遥测及两套 L2 回归。

**SPEC-PD-AGENT-EXECUTION-POLICY-001：内置 Agent 自适应执行模式**

研究并验证 L1、L1+、L2 的任务选择策略；优先开展 RootCause 的受控证据检索实验，不预设多轮一定优于单轮。

两项均不得成为本 SPEC 的合并前置依赖。
