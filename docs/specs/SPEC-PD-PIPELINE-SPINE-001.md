# SPEC-PD-PIPELINE-SPINE-001 — PD 核心管道主干收敛规范

- **版本**：v0.2
- **日期**：2026-11-23
- **状态**：Draft for Owner Review（未批准；未开始实现）
- **v0.2 对抗式自审修订**：
  1. 修正 v0.1 将 `runtimeKind`（模型执行后端）误读为 `hostKind`（宿主归属）的事实错误；移除“强制 `hostKind` 必填”的错误设计（手动无会话 CLI 录入合法状态即为无 `hostKind`）。
  2. 按 P2.1（先连接、再创造）砍掉新建顶层门面 `createPipelineRuntime`：复用 `@principles/core` 既有写入门面 `PainToPrincipleService` 与 `@principles/host-runtime` 既有周期函数，改为提供单一宿主协作者装配函数并收编 3 个手搓 Runner 的 CLI 入口。
  3. 用“探针值端到端一致性测试（Canary Spine Test）”替代“静态字段清单 + AST 键名扫描”，避免制造第二份真相（P4）。
  4. 砍掉对 `PITaskMetadata` 28 个字段的三分组重排（`serializePITaskMetadata` / `mergePITaskMetadata` 已集中收口，拆子对象只有测试夹具改动成本、无故障收益），改为只收口真实双轨字段与后继血缘不变量。
  5. 补入自审新核实的 4 个现存断线缺陷（§3.2 D1–D4），并提前到 Phase 1B 止血；修正 PRI-1267 已修复 `candidate internalize` 准入检查但仍缺账本入库检查的精确现状；修复附录 A 复跑命令的未加引号展开问题。
- **范围**：Pain → 诊断 → 候选准入与账本入库 → 内化 → 激活 → 注入/拦截 → 行为证据 这条核心链路的协作者装配、跨跳数据连通性与有效性闭环
- **事实基线**：`origin/main@5e3b8d53d`。§3 的全部数字与代码锚点均在该基线上实测，复跑命令见附录 A。
- **配套技术设计**：[SPEC-PD-PIPELINE-SPINE-001 — 配套技术设计与实施方案](./SPEC-PD-PIPELINE-SPINE-001-TECHNICAL-DESIGN.md)
- **不改变**：Pain 语义、诊断/内化业务规则、Owner 审批权、任务状态机（`MVP_CORE_LOOP_CONTRACT` INV-01..08）、物理数据库布局、Workspace 数据归属
- **关联**：
  - `docs/architecture/MVP_CORE_LOOP_CONTRACT.md`（语义基线，本 SPEC 不修改）
  - `docs/plans/2026-11-10-architecture-complexity-remediation-plan.md`（存储端口 / 配置 / 判定原因；本 SPEC 不重复）
  - `docs/architecture/principle-identity-reconciliation.md`（I2/I3 已落地，本 SPEC 只堵剩余旁路）
  - `docs/specs/SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001-v1.0.md`（租约与心跳已合入工厂，本 SPEC 补齐绕过工厂的 CLI 入口）
  - `docs/specs/SPEC-PD-SERVICE-HOST-001.md`（后台生命周期调度；Phase 2–4 已合入 `pd-cli/src/services/service-host/`，本 SPEC 不触碰调度所有权）

> **一句话结论**
>
> PD 核心管道的业务阶段、序列化器与身份盖章主体都已存在；真正让维护困难、让断线反复发生的，是**各入口各自拼装可选协作者**、**3 个 CLI 命令绕过共享工厂手搓 Runner**、以及**缺少一条用非默认探针值跑穿全链的端到端测试**。本 SPEC 不新建顶层门面、不重排表结构，通过“先红探针测试 → 修现存 4 处断线 → 收口协作者与手搓入口”把复杂度增量做到 **≤ 0**。

---

## 1. 背景与问题

Owner 当前面临两个核心痛点：

1. **改动成本高**：从痛苦信号采集、诊断、原则生成、RuleCode 对抗验证到激活与适应性检查，链路跨包多、入口多、开关多，改一处要翻十几个文件。
2. **连通性无把握**：无法确定管道各跳之间还有没有“写了没读”或“某条入口漏传依赖导致静默降级”的数据和字段。

仓库历史证明第 2 点无法靠人工审计根治：`docs/audit` 与 `docs/reports` 已积累百余份审计报告，PRI-835（formation context 未进提示）、PRI-1265（CLI/worker 漏传 `trajectoryTurnReader`）、配置字段被校验器漏拷等事故，本质都是同一类结构问题——**协作者与跨跳字段靠各入口自觉传递，漏传时降级为“看似正常运行”**。

---

## 2. 目标、非目标与 Complexity Delta

### 2.1 目标

| ID | 目标 | 可验证的验收结果 |
|---|---|---|
| G1 | “有没有漏接字段/依赖”由 CI 自动回答 | 一条探针值端到端测试（Canary Spine Test）覆盖 `prompt` 与 `code_tool_hook` 两条主路径；任一必达探针未进入下游模型请求体或落库记录，CI 立即变红 |
| G2 | 止住当前已核实的 4 处真实断线 | §3.2 的 D1–D4 全部先红后绿修复 |
| G3 | 宿主协作者只在一处组装，不再可选漏传 | `host-runtime` 提供单一 `resolveWorkspacePipelineHostDeps`（字段全必填）；所有宿主 worker、OpenClaw hook、CLI 命令共用它 |
| G4 | 消除生产代码中的野生 Runner 组装 | `diagnose.ts`、`pain-retry.ts`、`runtime-internalization-run-once.ts` 不再手搓 Runner；CI 守卫锁死构造点白名单 |
| G5 | 消除跨跳双轨字段与无账本孤儿链 | `deviationAnchor` 收敛到单一 `anchor`；未入账本（Ledger）的候选不得排入 `dreamer` 任务；后继任务强制继承 `correlationId` |
| G6 | 闭合“原则是否有效”的观测回路 | 每条已激活原则一个派生读模型：注入次数、遵循/违反证据数、激活后同类 Pain 复发数（证据不足报 `unknown`） |

### 2.2 非目标

- 不重写管道，不新增业务阶段，不新增顶层门面类（复用 `PainToPrincipleService`、`createPainSignalBridge`、`runPendingDiagnosticianOnce`、`runInternalizationConsumerCycle`）。
- 不把 `PITaskMetadata` 的 28 个字段拆成嵌套子对象（`serializePITaskMetadata` 与 `mergePITaskMetadata` 已集中收口，改形状只制造测试夹具噪音）。
- 不合并 `state.db` 与 `trajectory.db`，不做存量数据迁移。
- 不按行数拆大文件（如 `evaluator-runner.ts` 4104 行）。
- 不新增特性开关（`mvp-q-3-how-disabled`）。
- 不重复 11-10 整改计划已覆盖的存储端口、配置校验与 UI 校验器生成化。

### 2.3 Complexity Delta（AGENTS §13）

```text
Complexity Delta

New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: YES (1 pure dependency-bundle builder `resolveWorkspacePipelineHostDeps` in `@principles/host-runtime`, replacing 8 ad-hoc wiring blocks; net -3 Runner assembly sites)
New runtime feature flag: NO
New cross-package dependency: NO (`pd-cli`, `openclaw-plugin`, `codex-adapter`, `workbuddy-adapter` already depend on `@principles/host-runtime` and `@principles/core`)
New host/platform-specific behavior: NO
New external/network capability: NO
```

对唯一一项 `YES` 的说明：
1. **为何现有模块未覆盖**：`host-runtime` 已有各单个协作者工厂（`createHostIntentDocReader`、`createGovernanceTrajectoryTurnReader`、`createConsentLedgerSourceMaterialAuthorization`、`createWorkspaceTelemetryEmitter`、`isAutomaticPainSubmissionAuthorized`），但没有把它们打包成不可漏项的整体，导致每个入口手写一套，反复漏项（PRI-1265、本次 D1）。
2. **隐藏了什么复杂度**：隐藏“5 个宿主侧协作者如何按同一份工作区与授权台账联动构造”（例如 `trajectoryTurnReader` 与 `contextAssembler` 必须共享同一个 `sourceMaterialAuthorization` 实例）。
3. **为何不能更小**：不抽这个包函数，8 个入口仍需各自传 5 个参数，无法在编译期阻止第 9 个入口漏传。
4. **如何验证**：编译期全必填 + Phase 1A 探针测试 + CI 构造点守卫。
5. **如何回退**：内联回调用点即可，无持久化影响。

---

## 3. 当前事实（`origin/main@5e3b8d53d` 实测）

### 3.1 装配面盘点

| 层 / 能力 | 既有权威入口 | 绕过权威入口的手搓点 / 分散点 | 实测后果 |
|---|---|---|---|
| Pain 写入与同步触发 | `@principles/core` `PainToPrincipleService`（公开桶标注唯一写入入口，架构测试保护） | `PainToPrincipleService`、`codex` worker（2 处）、`workbuddy` worker、`diagnostician-auto-run`、`openclaw hooks/pain.ts`、`pain-record.ts` 各自拼装协作者 | 新增协作者时总有入口漏传（见 D1） |
| 诊断三阶段执行 | `@principles/core` `createPainSignalBridge`（`pain-signal-runtime-factory.ts:808-835`） | `pd-cli/src/commands/diagnose.ts:557-584`、`pd-cli/src/commands/pain-retry.ts:695-725`（另有 2 个实验 runner：`synthetic-baseline-runner.ts`、`pain-flood-simulation-runner.ts`） | 两个生产 CLI 手搓 `Diag*Runner + SplitDiagnosticianRunner`，**漏配了工厂已有的租约心跳**（见 D3） |
| 内化单轮消费 | `@principles/host-runtime` `runInternalizationConsumerCycle`（`internalization-consumer-cycle.ts:941-1068`） | `pd-cli/src/commands/runtime-internalization-run-once.ts:720-830` 手搓 6 个 Runner；`pd-cli/src/services/rulehost-pipeline-runner.ts:338-508` 同步直连 Runner（不走租约编排器） | 同一 Runner 的构造参数（如 `ledgerIdentity`、`hostSemantics`、预检门）在 3 个文件里人工同步 |
| 编排器构造 | `InternalizationOrchestrator` | 5 处：`internalization-consumer-cycle.ts`、`runtime-internalization-run-once.ts`（2 处）、`runtime-internalization-wake-once.ts`、`runtime-internalization-enqueue-successors.ts` | 每次新增门禁端口（如 `sourceMaterialAuthorization`）需改 5 处 |

### 3.2 本次源码核查确认的 4 个现存断线缺陷

以下 4 项均已在当前 `origin/main@5e3b8d53d` 代码上核实，不是历史报告转述：

| ID | 位置 | 事实证据 | 实际影响 |
|---|---|---|---|
| **D1** | `pain-to-principle-service.ts:42-78, 276-290`；`pain-record.ts:452-473` | PRI-1283 R2 为 `createPainSignalBridge`、`SqliteContextAssembler` 与诊断三阶段 Runner 增加了 `sourceMaterialAuthorization` 门，未传时默认 `denyAllSourceMaterialAuthorization`（`sqlite-context-assembler.ts:143`）。但 `PainToPrincipleServiceOptions` **未声明该字段**，调用 `createPainSignalBridge` 时未传；同时 `pain-record.ts`（`--wait` 同步诊断路径）也未传 `trajectoryTurnReader` | 任何经 `PainToPrincipleService` 同步跑诊断的路径，都会把已获授权的 `governance_observation:` 证据与提升窗口按“未授权”过滤掉；`pd pain record --wait` 绑定的会话原文也读不到 |
| **D2** | 写：`pain-ingress.ts:141`、`pain-record.ts:490`、`pain-signal-bridge.ts:484`；读：`sqlite-context-assembler.ts:663-684` | MCP 提交（`pain-submit-capability.ts:583-592`）同时写 `anchor` 与 `deviationAnchor`；但 `pain-ingress.ts` 与 `pain-record.ts` 只写 `deviationAnchor`，而 `SqliteContextAssembler.reconstructDiagnosticianRecord` **只读 `parsed.anchor`，完全不读 `parsed.deviationAnchor`** | 经 `pain-ingress` / `pain-record` 提交的 `deviationAnchor` 落进了 `diagnostic_json`，但在诊断上下文装配时丢失，Stage A 模型看不到 |
| **D3** | `diagnose.ts:557-584`、`pain-retry.ts:695-725` vs `pain-signal-runtime-factory.ts:795-807` | `SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001` 在共享工厂里接入了 `resolveExecutionTiming`（向各阶段传入 `leaseTtlMs` 与 `heartbeatIntervalMs`），但 `diagnose.ts` 与 `pain-retry.ts` 手搓 Runner 时未传这两个参数 | 手动执行 `pd diagnose` 或 `pd pain retry` 时，子阶段退回默认租约窗口，长耗时诊断仍存在租约过期风险 |
| **D4** | `pd-cli/src/commands/candidate.ts:394-524` | PRI-1267 已为 `handleCandidateInternalize` 补上 `enforceFullAdmissionForWrite`（准入未过会拒绝），但它**不检查候选是否已写入原则账本（Ledger Intake）** | 对 `pd diagnose --no-intake` 留下的未入账本候选执行 `pd candidate internalize`，会直接创建 `dreamer` 任务，跑完多轮 LLM 后在激活边界因账本无对应原则被拒 |

### 3.3 已就位、无需重造的机制（防止过度设计）

1. **元数据序列化已集中**：`pitask-metadata.ts:778-857` 的 `serializePITaskMetadata` 与 `mergePITaskMetadata` 已统一管理全部 28 个字段（其中 23 个可选），不存在多处手写 spread 漏拷字段的问题。
2. **播种与 Scribe 身份盖章已就位**：`buildDreamerTaskSeed`（`intake-to-internalization-bridge.ts:271`）已固定写入 `correlationId: input.candidateId`；`ScribeRunner`（`scribe-runner.ts:695-744`）已实现 I2 链式盖章（账本瞬时不可读时 fail-soft 留空并打事件，由激活边界 `ledger-identity.ts` 按 `candidate_lineage` 兜底解析；`code_tool_hook` 渠道身份异常已 fail-closed 转 `needs_human_review`）。
3. **父 run 的 `runtimeKind` 已修复**：`split-diagnostician-runner.ts:325` 的 `this.runtimeKind ?? 'openclaw'` 是模型执行适配器标识（如 `'pi-ai'`），且生产构造点均已显式传入 `runtimeKind`；不是 `GovernanceHostKind`。
4. **规模与开关基线**：特性开关注册 55 个（`feature-flag-contract.ts`）；`internalization/` 非测试源码 94 个文件；建表定义 44 张唯一表；引用原则账本的非测试源码 77 个文件。
5. **未测量的事实**：当前生产工作区近 30 天的真实漏斗转化率本次**未测**（9 月审计 `pd-pipeline-health-audit-v1.md` 的“121 工件 1 激活”不能代表现状），由 Phase 0 只读补测。

---

## 4. 架构设计

### 4.1 四项收敛原则

| # | 原则 | 具体做法 |
|---|---|---|
| C1 | **探针先行，测真实边界** | 不维护脱离代码的字段登记表；用非默认探针值跑穿生产入口，在假模型收到的实际请求体与数据库落盘记录上断言 |
| C2 | **补齐既有门面，不建第二门面** | 写入与同步诊断走 `PainToPrincipleService`；后台诊断走 `runPendingDiagnosticianOnce`；内化走 `runInternalizationConsumerCycle`（及从中抽出的单任务执行函数）；只在 `host-runtime` 增加一个全必填的宿主协作者打包函数 |
| C3 | **单轨字段 + 单一入队闸门** | 锚点统一为 `anchor`（读侧兼容历史 `deviationAnchor`）；播种 `dreamer` 前强制满足“准入通过 **且** 原则账本条目已存在” |
| C4 | **分批逆序可回退** | 每阶段独立成 PR、先红后绿；按逆序回退，不新增开关，不改 SQLite 表结构 |

### 4.2 宿主协作者单一打包入口（消除漏传）

在 `@principles/host-runtime` 提供唯一协作者构造函数：

```ts
export interface WorkspacePipelineHostDeps {
  readonly intentDocReader: IntentDocReader;
  readonly trajectoryTurnReader: TrajectoryTurnReader;
  readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
  readonly telemetrySink: { emitTelemetry: (event: TelemetryEvent) => void };
  readonly isAutoPainSubmissionAuthorized: () => boolean;
}

export function resolveWorkspacePipelineHostDeps(input: {
  readonly workspaceDir: string;
  readonly effectiveConfig: EffectivePdConfig;
  /** OpenClaw 进程内已有 WorkspaceContext.trajectory 时传入；其余入口统一走 governance store reader */
  readonly trajectoryTurnReaderOverride?: TrajectoryTurnReader;
}): WorkspacePipelineHostDeps;
```

关键约束：
1. **返回对象的 5 个属性全部必填（无 `?`）**，且内部保证 `trajectoryTurnReader` 与返回给调用方的 `sourceMaterialAuthorization` 共享同一授权判定逻辑。
2. `PainToPrincipleServiceOptions` 补齐 `sourceMaterialAuthorization?: SourceMaterialAuthorizationPort` 并透传给 `createPainSignalBridge`（core 层保持纯端口类型，不反向依赖 `host-runtime`）。
3. `hostKind` 保持按真实来源可选传入（`GovernanceHostKind | undefined`）：绑定了宿主会话时必填，无会话的手动 CLI 录入保持 `undefined`，绝不伪造。
4. 若某个协作者在当前环境下无数据可读（如无 `INTENT.md`、无轨迹记录、授权已撤回），由该协作者实现按既有 `rc-9` 规则产生 `ambiguityNotes` 或结构化降级事件，而不是在入口传 `undefined`。

### 4.3 收编 3 个手搓 Runner 的 CLI 入口

1. **`pd diagnose` 与 `pd pain retry`**：删除两个文件内手搓 `DiagRootCauseRunner / DiagDistillerRunner / DiagRouterRunner / SplitDiagnosticianRunner` 的重复装配块；给 core 的诊断工厂增加可选的 `runtimeAdapterOverride`（供 CLI `--runtime test-double` 与命令行覆盖参数使用），使 CLI 与后台 worker 100% 共用同一套阶段装配、同一套 `resolveExecutionTiming` 租约心跳与同一套 `sourceMaterialAuthorization`。
2. **`pd runtime internalization run-once`**：从 `host-runtime/src/internalization-consumer-cycle.ts` 抽出单步已选任务执行函数 `executeSelectedInternalizationTask(...)`，供 `runInternalizationConsumerCycle` 与 `runtime-internalization-run-once.ts` 共用，删除 CLI 里 150 行 `if (runnerKind === ...)` 的重复 Runner 构造。
3. **`rulehost-pipeline-runner.ts` 与实验 runner**：`synthetic-baseline-runner.ts`、`pain-flood-simulation-runner.ts`、`rulehost-pipeline-runner.ts` 明确归入 operator/lab 显式白名单；CI 守卫禁止在白名单之外新增任何 `new *Runner(`、`new SplitDiagnosticianRunner(`、`new PainSignalBridge(`。

### 4.4 单轨字段与单一播种闸门

1. **`deviationAnchor` 收敛为 `anchor`（修 D2）**：
   - 读侧（`SqliteContextAssembler.reconstructDiagnosticianRecord`）：当 `parsed.anchor` 缺失且 `parsed.deviationAnchor` 合法时，按 `established_principle` 锚点解析并附一条可观测兼容记录，保证存量任务不丢数据。
   - 写侧（`pain-ingress.ts`、`pain-record.ts`）：统一同时产出标准 `anchor: { type: 'established_principle', ... }`；后续版本在确认无内部读者后再退役冗余顶层写键。
2. **准入 + 账本入库 → 播种单一闸门（修 D4）**：
   - `handleCandidateInternalize` 在准入通过后，若候选尚未写入原则账本（`listForCandidate(candidateId)` 为空），必须拒绝并给出明确 `nextAction: 'Run pd candidate intake <candidateId> --confirm first'`（或显式提供先 intake 再播种的组合流，不在未入账本状态下直接写 `dreamer` 任务）。
3. **后继血缘不变量**：
   - `IntakeToInternalizationBridge` 播种时已写 `correlationId = candidateId`；在 `InternalizationOrchestrator` 生成后继任务提议与 reopen 修订任务时，断言 `correlationId` 非空且与父任务一致，缺失即 fail-closed（`rc-6`），确保任意深度的内化任务都能 O(1) 反查回 `candidateId → taskId → sourcePainId`。

### 4.5 Canary Spine Test（探针值端到端一致性测试）

新增一套不依赖真实外网 LLM、但走真实 SQLite（临时工作区）+ 真实生产入口的端到端测试：

1. **输入探针包（全为非默认特征值，绝不与默认值撞车）**：
   - `reason`: `'CANARY_REASON_9f3a'`
   - `correctionEvidence`: `{ text: 'CANARY_OWNER_CORRECTION_7b2c', classification: 'owner_statement', channel: 'cli_owner_statement' }`
   - `anchor` / `--deviated-principle`: `'P_CANARY_ANCHOR_4d1e'`
   - 授权轨迹库预置一条 `codex` 会话原文 `'CANARY_TURN_TEXT_8e5f'` 与一条 `governance_observation:codex|...` 证据引用，并授予 `codex` 采集授权
   - 工作区预置 `INTENT.md`（含 `'CANARY_INTENT_2a6d'`）并开启 `intent_engineering`
   - 非默认 `timeoutMs: 432_100`
2. **两条路径全覆盖**：
   - 路径 A（`prompt` 短链）：`PainToPrincipleService.recordPain` → 诊断三阶段（A/B/C）→ 准入与账本 Intake → `runInternalizationConsumerCycle`（Dreamer → Philosopher → Scribe → RolloutReviewer）→ 自动激活 → `prompt-injection-projection` 构造出的系统提示文本。
   - 路径 B（`code_tool_hook` 全链）：同上进入 Artificer → Evaluator（含沙箱重放）→ RolloutReviewer → Approval → Shadow → Promote Live → `production-rulehost-gate` 拦截回执。
3. **逐跳硬断言**：
   - 在假模型服务收到的**每一次 LLM 请求消息全文**中，断言该阶段应见的探针字符串真实出现（例如 Stage A 请求体必须同时包含 `CANARY_TURN_TEXT_8e5f`、`CANARY_OWNER_CORRECTION_7b2c`、`P_CANARY_ANCHOR_4d1e`、`CANARY_INTENT_2a6d`；Scribe / Evaluator 请求体必须包含 formation context 投影出的诊断根因与来源）。
   - 撤回 `codex` 授权后重跑同一装配，断言 `CANARY_TURN_TEXT_8e5f` **不再出现**且 `ambiguityNotes` 含 `consent_revoked`（同时锁死连通性与隐私撤回安全门）。
   - 断言最终 `pi_artifacts.source_principle_id`、`activations.target_ref`、`principle_applications.principle_id` 三者与账本原则 UUID 完全一致。

> 验证能力对照：在当前未修改的 `origin/main` 上，这套测试会在 D1（`PainToPrincipleService` 过滤掉授权证据）和 D2（CLI `deviationAnchor` 未进 Stage A 请求体）上**直接变红**，满足 AGENTS §0 第 3 条“先红回归测试”要求。

---

## 5. 核心跨跳契约核对表（已按源码核实）

| 跳点 | 关键数据 / 字段 | 权威载体 | 当前状态 |
|---|---|---|---|
| 入口 → 诊断任务 | `sourcePainId`、`provenance`、`hostKind`、`sessionIdHint`、`evidence[]`、`correctionEvidence`、`painIngress`、`recovery` | `tasks.diagnostic_json`（`buildDiagnosticJson`） | **已接通**（`PainToPrincipleService` 侧缺 `sourceMaterialAuthorization` 导致读取被拒，归 **D1**） |
| 入口 → 诊断任务 | `anchor` vs `deviationAnchor` | `tasks.diagnostic_json` → `SqliteContextAssembler` | **断线（D2）**：CLI/ingress 只写 `deviationAnchor`，装配器只读 `anchor` |
| 诊断执行租约 | `stageTimeoutMs`、`leaseTtlMs`、`heartbeatIntervalMs` | `pain-signal-runtime-factory.ts` → Runner | **部分断线（D3）**：共享工厂已接通；`diagnose.ts` / `pain-retry.ts` 手搓 Runner 漏接 |
| 诊断 → 候选准入 | `recommendation_kind`、`confidence`、`trigger_pattern`、`action`、`admission_json` | `principle_candidates` | **已接通**（PRI-1267 已补齐 `candidate internalize` 准入门） |
| 候选 → 账本 → 播种 | 账本原则条目 + `dreamer-<candidateId>-<channel>` + `correlationId` | `ledger.json` + `tasks.diagnostic_json` | **旁路缺口（D4）**：`candidate internalize` 未校验账本条目存在即可排任务 |
| 内化链跨跳上下文 | `inputArtifactRefs`、`sourceTrace`、`lineage_artifact_ids` → `formationContext` | `pi_artifacts` + `formation-context.ts` | **已接通**（PRI-838/839/843 已覆盖 Scribe / Artificer / Evaluator / Owner 决策） |
| 内化 → 激活身份 | `pi_artifacts.source_principle_id` → `activations.target_ref` → `principle_applications.principle_id` | `scribe-runner.ts`（I2）+ `ledger-identity.ts`（I3） | **已接通**（堵住 D4 后即可消除新孤儿链） |
| 激活 → 有效性反馈 | 注入回执、RuleHost 拦截、干预证据、同类 Pain 复发 | `principle_applications`、`gate_blocks`、`intervention_evidence_records`、`pain_events` | **分散未聚合**（归 Phase 5 派生读模型） |

---

## 6. 实施阶段

各阶段按顺序推进；每个阶段可拆为小型 PR。**回退规则**：按逆序回退（后一阶段依赖前一阶段引入的辅助函数或测试时，不可跳过后一阶段单独回退中间阶段）。

### Phase 0 — 生产快照漏斗基线（只读，0 代码改动）

- **做什么**：将当前工作区的 `state.db` 与 `trajectory.db` 复制到 `.tmp/` 隔离目录，只读统计全量与近 30 天漏斗：`pain_events`（分自动/手动/宿主）→ 诊断任务（分状态）→ 候选（分准入结论）→ 账本条目 → 内化各阶段任务 → 审批/注意队列 → 激活（分渠道）→ 注入/拦截回执。
- **硬边界**：严禁直接打开或修改 `<workspace>/.pd/` 与 `~/.pd/runtime/` 下的活体文件（AGENTS §1.1）。
- **产出**：一份简明漏斗表写入 `docs/reports/`，用于确认后续阶段优先级（若 90% 流失仍在入口或审批积压，Phase 4/5 按实际瓶颈重排）。

### Phase 1A — Canary Spine Test 落地（先红）

- **做什么**：按 §4.5 实现端到端探针测试套件（含授权开启与撤回双断言）。对当前已知断线（D1、D2）保留精确的先红证据记录。
- **改动面**：仅测试与测试夹具，不改生产代码。

### Phase 1B — 修复现存 4 处断线（D1–D4 转绿）

- **做什么**：
  1. **修 D1**：`PainToPrincipleServiceOptions` 增加 `sourceMaterialAuthorization` 并透传；补齐 `pain-record.ts` 的 `trajectoryTurnReader` 与 `sourceMaterialAuthorization`。
  2. **修 D2**：`SqliteContextAssembler` 兼容读取历史 `deviationAnchor`，`pain-ingress.ts` / `pain-record.ts` 同步写入规范 `anchor`。
  3. **修 D4**：`handleCandidateInternalize` 增加账本已入库前置检查（无账本条目时结构化 `refused` + `nextAction`）。
  4. **修 D3（或与 Phase 2 合并）**：补齐 `diagnose.ts` / `pain-retry.ts` 的租约心跳配置。
- **验收**：Phase 1A 探针测试全绿，且针对 D1–D4 各有一条独立回归单测（修前红、修后绿）。

### Phase 2 — 协作者打包与手搓 Runner 收编

- **做什么**：
  1. 在 `host-runtime` 落地 `resolveWorkspacePipelineHostDeps`，逐个迁移：`diagnostician-auto-run`、`codex` worker、`workbuddy` worker、`openclaw hooks/pain.ts`、`pain-record.ts`、`diagnose.ts`、`pain-retry.ts`。
  2. 收编 `diagnose.ts`、`pain-retry.ts` 到 core 诊断工厂；从 `internalization-consumer-cycle.ts` 抽出单任务执行器收编 `runtime-internalization-run-once.ts`。
  3. 在 `architecture-regression.test.ts` 增加构造点白名单守卫，禁止在共享工厂/白名单之外新增 `new *Runner(`、`new SplitDiagnosticianRunner(`、`new PainSignalBridge(`。
- **拆分建议**：按包拆 3 个小 PR（① `host-runtime` 函数 + 内部调用点；② `pd-cli` 收编；③ 宿主 worker / plugin 迁移 + CI 守卫），每批保持 Phase 1A 全绿。

### Phase 3 — 后继血缘不变量收紧

- **做什么**：在 `InternalizationOrchestrator` 的后继任务生成与修订重开路径上，强制校验 `correlationId` 非空且与上游任务一致（`rc-6` fail-closed）；对历史无 `correlationId` 的存量在途任务保留从 `dreamer-<candidateId>-<channel>` 解析一次并前向写实的兼容出口。
- **验收**：伪造缺失/不一致 `correlationId` 的负向测试必拒；`MVP_CORE_LOOP_CONTRACT` INV-02 / INV-07 / INV-08 既有测试全部保持通过。

### Phase 4 — 开关退役与阶段合并评估（须 Owner 逐项拍板）

- **前置条件**：Phase 0–3 完成（`antipattern-prep-next-phase`）。
- **4a 退役已无分支价值的开关**：盘点 55 个开关中“旧实现已从代码树删除”（例如 `pain-signal-runtime-factory.ts:776` 注释已写明单体 `DiagnosticianRunner` 已不存在的 `diagnostician_split_pipeline`）或生产恒开且无回退目标的开关，列清单由 Owner 确认后逐个清理死分支。
- **4b 评估减少 LLM 跳数**：候选仅限“诊断 Stage B+C（distiller + router）”与“`prompt` 渠道 Dreamer + Philosopher”。必须按 `docs/process/PD-LAB-USAGE.md`（AGENTS §25A）跑离线基准对比，证明原则/规则质量与准入精确率不退化后才可合并；无数据不合并。

### Phase 5 — 原则有效性派生读模型

- **做什么**：按账本 `principleId` 聚合现有 `principle_applications`、`gate_blocks`、`intervention_evidence_records`、`pain_events` 与 adaptive linkage，输出派生视图：注入/评估次数、有证据的遵循/偏离计数、激活后同锚点 Pain 复发计数。
- **硬约束**：严格遵守 [`docs/concepts/PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md`](../concepts/PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md)——不新建写入表（P4），不把“任务成功”推断为“遵循原则”，证据不足一律标记 `insufficient_evidence`。
- **前置门**：若将其暴露到 Console 主视图（MVP-Core 范围变更），开工前须经 Owner 确认并按私有文档情绪价值指南补齐设计（AGENTS §4、§5、§26）。

---

## 7. MVP 契约核对（AGENTS §4）

| ID | 回答 |
|---|---|
| `mvp-q-1-what-if-skip` | D1–D4 继续在生产存在（同步诊断静默丢授权证据、CLI 锚点进不了模型、未入账本候选空跑 LLM）；每次加新字段或新入口继续靠人工审计抓漏 |
| `mvp-q-2-how-observed` | Phase 0：漏斗报告；Phase 1A/1B：CI 探针测试由红转绿 + CLI 结构化拒绝原因；Phase 2：构造点数量净降与架构守卫；Phase 5：CLI/Console 按原则展示有效性证据 |
| `mvp-q-3-how-disabled` | 零新增开关；所有改动不碰数据库表结构，按 PR 逆序可安全 revert |
| `mvp-q-4-emotional-value` | Phase 0–4：`N/A — no direct Owner-facing behavior.` Phase 5：消除 Owner“激活了原则却不知道它到底有没有改变 Agent 行为”的盲飞焦虑（实现前按 `$PD_PRIVATE_DOCS_DIR/product/emotional-value.md` 核对） |

---

## 8. 风险与并行冲突控制

| 风险 | 影响 | 缓解 |
|---|---|---|
| 收编 `diagnose.ts` / `pain-retry.ts` 改变 CLI 输出细节或退出码 | 违反 §10 CLI 契约 | 保留 CLI 外层输出整形与重试循环，只替换内部 Runner 组装；跑全量 CLI 契约测试（`cli-1..cli-7`） |
| 与在途分支冲突（Service Host Phase 5 cutover、Feedback Resilience PRI-1273/1275/1276） | 合并冲突 | 不修改 `pd-cli/src/services/service-host/**` 与 `pd-mcp-server/src/submit-assembly.ts`；开工前执行 `git worktree list` 与 `npm run error:context`（AGENTS §0） |
| 探针测试耦合提示词措辞导致脆弱 | 改提示模板就误报 | 只断言**输入探针字面量**出现在请求体中，不断言提示词固定装饰文案 |

---

## 9. 需要 Owner 拍板的事项

1. **是否批准按 v0.2 启动 Phase 0 + Phase 1A + Phase 1B**（测量漏斗 + 探针测试 + 修掉已确认的 D1–D4 断线）。
2. **`pd candidate internalize` 对未入账本候选的策略（D4）**：倾向 **方案 A（严格拒绝，提示先执行 `pd candidate intake`）** 还是 **方案 B（在 `internalize` 内自动先完成账本 intake 再排 `dreamer`）**？推荐方案 A（职责单一，符合 `cli-5`）。
3. **Phase 4 与 Phase 5 是否保留在本 SPEC 作远期路线**，还是只把 Phase 0–3 作为本 SPEC 的交付闭环、Phase 4/5 等漏斗数据出来后另立工单。

---

## 附录 A：可复跑实测命令

以下命令在仓库根目录执行，均使用显式引号参数，不依赖未加引号的 Shell 变量展开：

```bash
# 1. PainSignalBridge 生产构造点
rg -n "new PainSignalBridge\(|await createPainSignalBridge\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 2. 诊断阶段 Runner 生产构造点（可见共享工厂 1 处 + CLI 手搓 2 处 + lab 2 处）
rg -n "new (SplitDiagnostician|DiagRootCause|DiagDistiller|DiagRouter)Runner\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 3. 内化阶段 Runner 生产构造点（可见 3 个文件）
rg -l "new (Dreamer|Philosopher|Scribe|Artificer|Evaluator|RolloutReviewer)Runner\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 4. D1 核验：PainToPrincipleService 是否声明或透传 sourceMaterialAuthorization
rg -n "sourceMaterialAuthorization" packages/principles-core/src/runtime/pain-to-principle-service.ts || echo "MISSING"

# 5. D2 核验：deviationAnchor 的非测试读写点（对比 sqlite-context-assembler.ts 无命中）
rg -n "deviationAnchor" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 6. PITaskMetadata 字段总数与可选字段数（28 / 23）
sed -n '/^export interface PITaskMetadata/,/^}/p' \
  packages/principles-core/src/runtime/internalization/pitask-metadata.ts | rg -c "^  \w+\??:"
sed -n '/^export interface PITaskMetadata/,/^}/p' \
  packages/principles-core/src/runtime/internalization/pitask-metadata.ts | rg -c "^  \w+\?:"

# 7. 特性开关注册数（55）
rg -c "^\s*id: '" packages/principles-core/src/runtime/feature-flags/feature-flag-contract.ts
```

## 附录 B：与既有规范的职责边界

| 主题 | 归属文档 |
|---|---|
| 存储访问端口、空结果与错误的区分 | `docs/plans/2026-11-10-architecture-complexity-remediation-plan.md` |
| 配置字段覆盖校验、Console `validators.ts` 生成化 | 同上 + `docs/reports/PD_MAINTENANCE_GOALS_20261110.md` |
| 租约续期、阶段预算与父任务心跳 | `docs/specs/SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001-v1.0.md` |
| 后台触发所有权与 OS Scheduler | `docs/specs/SPEC-PD-SERVICE-HOST-001.md` |
| 提交身份预绑定、回执兜底与授权撤回清理 | `docs/specs/SPEC-PD-FEEDBACK-RESILIENCE-001.md` |
| **协作者防漏装配、手搓入口收编、跨跳探针测试与现存 D1–D4 止血** | **本 SPEC（v0.2）** |
