# SPEC-PD-PIPELINE-SPINE-001 — 配套技术设计与实施方案

- **版本**：v0.2
- **日期**：2026-11-23
- **状态**：Draft for Owner Review（未批准；未开始实现）
- **上位规范**：[SPEC-PD-PIPELINE-SPINE-001（v0.2）](./SPEC-PD-PIPELINE-SPINE-001.md)
- **源码事实基线**：`origin/main@5e3b8d53d`
- **规范性数据契约**：[PD 行为偏差事件与相对评价规范](../concepts/PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md)、[MVP Core Loop Contract](../architecture/MVP_CORE_LOOP_CONTRACT.md)
- **标注约定**：文中标注 `〔现有能力〕` 的符号已在当前源码中存在；标注 `〔新增能力〕` 的符号当前不存在，实施前不得以现有能力名义引用；标注 `〔收编删除〕` 的代码块为重复组装，迁移后删除。

---

## 1. 技术决策摘要

| 决策点 | 选定方案 | 否决的备选方案与原因 |
|---|---|---|
| 顶层入口形态 | 保持既有双权威：写/同步触发走 `@principles/core` `PainToPrincipleService`〔现有能力〕，后台周期走 `@principles/host-runtime` `runPendingDiagnosticianOnce` / `runInternalizationConsumerCycle`〔现有能力〕 | 否决新建 `createPipelineRuntime` 大门面：违反 P2.1，且 `core` 内的 `pain-submit-capability.ts` 不能反向依赖 `host-runtime` |
| 宿主协作者防漏 | 在 `@principles/host-runtime` 新增纯组装函数 `resolveWorkspacePipelineHostDeps`〔新增能力〕，返回全必填 `WorkspacePipelineHostDeps`（零 `?`） | 否决继续在 7+ 个入口各自手写 5 个协作者构造：已先后造成 PRI-1230/1233、PRI-1265 与本次 D1 |
| 诊断 CLI 手搓收编与缓存隔离 | 在 `pain-signal-runtime-factory.ts` 抽出**不进缓存**的 `createDiagnosticianRunnerBundle`〔新增能力〕，供缓存版 `createPainSignalBridge` 与一次性 CLI（`diagnose.ts`、`pain-retry.ts`）共用 | 否决直接把 `runtimeAdapterOverride` 塞进 `createPainSignalBridge`：`bridgeCache` 按 `workspaceDir` 缓存，CLI 的 `--runtime test-double` 或临时覆盖参数会污染缓存或被旧缓存吞掉 |
| `deviationAnchor` 与 `anchor` 双轨 | 写侧统一补写规范 `PainAnchor { type: 'established_principle', ref: '<id>@<ver>' }`；读侧 `SqliteContextAssembler` 在 `anchor` 缺失时回退解析 `deviationAnchor` 并记录可观测说明 | 否决直接删掉 `deviationAnchor`：存量 `tasks.diagnostic_json` 与 `pain-ingress` 契约仍有历史记录，读侧必须先兼容 |
| `candidate internalize` 账本门禁 | 在准入检查通过后，先校验 `ledgerAdapter.isAvailable()`（PRI-915），再校验 `listForCandidate(candidateId).length > 0`；未入账本返回结构化 `refused` + `nextAction` | 否决直接调 `listForCandidate` 判空：账本文件锁冲突不可读时 `listForCandidate` 返回 `[]`，不做 `isAvailable()` 前置会把 I/O 故障误报为“未入账本”（`rc-9` 违例） |
| 内化单步执行收编 | 从 `internalization-consumer-cycle.ts` 抽出 `executeSelectedInternalizationTask`〔新增能力〕，收编 `runtime-internalization-run-once.ts` 的 6 分支 Runner switch〔收编删除〕 | 否决把 `rulehost-pipeline-runner.ts` 强行并入租约编排器：它是显式同步多轮对抗算子，列入架构守卫白名单即可 |
| 连通性自动化证明 | 用非默认特征探针值跑穿真实入口的 Canary Spine Test〔新增能力〕，直接在假模型收到的请求消息与 SQLite 落盘行上断言 | 否决“静态字段清单 + AST 键扫描”：`serializePITaskMetadata` 已集中列举 28 个键，静态扫描抓不到 D1–D4 中任何一个缺陷，且制造第二份真相（P4） |

---

## 2. 包依赖与模块落点

### 2.1 依赖方向（零新增跨包边）

```text
@principles/core
  ├─ runtime/pain-to-principle-service.ts          [扩展: +sourceMaterialAuthorization 透传]
  ├─ runtime/pain-signal-runtime-factory.ts        [重构: 抽出 createDiagnosticianRunnerBundle]
  ├─ runtime/pain-ingress.ts                       [修复: deviationAnchor 同步派生 anchor]
  ├─ runtime/store/context/sqlite-context-assembler.ts [修复: 读侧兼容 deviationAnchor]
  └─ runtime/internalization/internalization-orchestrator.ts [收紧: correlationId 血缘不变量]
        ▲
        │（既有单向依赖，core 不反向引用任何上层包）
@principles/host-runtime
  ├─ src/workspace-pipeline-host-deps.ts           [新增: resolveWorkspacePipelineHostDeps]
  ├─ src/diagnostician-auto-run.ts                 [迁移: 改用 resolveWorkspacePipelineHostDeps]
  └─ src/internalization-consumer-cycle.ts         [重构: 抽出 executeSelectedInternalizationTask]
        ▲
        │（既有单向依赖）
  ┌─────┴──────────────────────┬─────────────────────────┬────────────────────────┐
pd-cli                   openclaw-plugin           codex-adapter          workbuddy-adapter
  ├─ pain-record.ts        └─ src/hooks/pain.ts      └─ workspace-worker.ts └─ workspace-worker.ts
  ├─ diagnose.ts              [迁移协作者打包]           [迁移协作者打包]        [迁移协作者打包]
  ├─ pain-retry.ts
  ├─ candidate.ts
  └─ runtime-internalization-run-once.ts
```

硬约束核对：
- `packages/principles-core/io-seam-registry.json` **无需新增条目**（core 只增加纯端口参数传递与纯 JSON 字段归一化，不新增任何文件系统或 SQLite I/O）。
- `@principles/core/runtime` 公开桶（`packages/principles-core/src/runtime/index.ts`）导出变更须同步更新 `runtime-barrel-surface.json` / `export-surface-baseline.json`（若有新增公开工厂符号，见 §3.3）。

---

## 3. 详细模块设计

### 3.1 缺陷 D1 修复与宿主协作者单一装配（Phase 1B + Phase 2A）

#### 3.1.1 `@principles/core`：`PainToPrincipleService` 补齐授权端口透传

文件：`packages/principles-core/src/runtime/pain-to-principle-service.ts`

1. 在 `PainToPrincipleServiceOptions`（当前第 42–78 行）新增：
   ```ts
   /**
    * PRI-1283 R2 / SPEC-PD-PIPELINE-SPINE-001: latest-consent gate for
    * governance-sourced material on synchronous diagnosis runs. Consulted per
    * context assembly / stage execution; absent = fail-closed
    * (denyAllSourceMaterialAuthorization).
    */
   sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
   ```
2. 在 `recordPain` 同步路径调用 `createPainSignalBridge` 处（当前第 276–289 行）透传：
   ```ts
   sourceMaterialAuthorization: this.opts.sourceMaterialAuthorization,
   ```
3. **异步路径说明（已核实无需改动）**：`recordPain` 在 `asyncMode === true` 时（含 `pain-submit-capability.ts` 的 MCP 路径）只调用 `persistPendingPainSignal` 写入 `tasks` 表，不构造 `SqliteContextAssembler`；授权门在实际执行该任务的后台 worker / `diagnose` / `pain-retry` 中按最新状态实时判定。

#### 3.1.2 `@principles/host-runtime`：`resolveWorkspacePipelineHostDeps`〔新增能力〕

新增文件：`packages/host-runtime/src/workspace-pipeline-host-deps.ts`（并从 `packages/host-runtime/src/index.ts` 导出）

```ts
import type {
  EffectivePdConfig,
  IntentDocReader,
  SourceMaterialAuthorizationPort,
  TelemetryEvent,
  TrajectoryTurnReader,
} from '@principles/core/runtime';
import { createHostIntentDocReader } from './intent-doc-reader.js';
import { createConsentLedgerSourceMaterialAuthorization } from './source-material-authorization.js';
import { createGovernanceTrajectoryTurnReader } from './governance-trajectory-turn-reader.js';
import { createWorkspaceTelemetryEmitter } from './workspace-telemetry-emitter.js';
import { isAutomaticPainSubmissionAuthorized } from './auto-pain-authorization.js';

export interface WorkspacePipelineHostDeps {
  readonly intentDocReader: IntentDocReader;
  readonly trajectoryTurnReader: TrajectoryTurnReader;
  readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
  readonly telemetrySink: { emitTelemetry: (event: TelemetryEvent) => void };
  readonly isAutoPainSubmissionAuthorized: () => boolean;
}

export interface ResolveWorkspacePipelineHostDepsInput {
  readonly workspaceDir: string;
  readonly effectiveConfig: EffectivePdConfig;
  /**
   * OpenClaw Gateway hook 进程内已持有基于 WorkspaceContext.trajectory 的
   * TrajectoryTurnReader，可通过此字段覆写；所有其他入口统一使用
   * governance store reader（并与本函数创建的 sourceMaterialAuthorization 绑定）。
   */
  readonly trajectoryTurnReaderOverride?: TrajectoryTurnReader;
}

export function resolveWorkspacePipelineHostDeps(
  input: ResolveWorkspacePipelineHostDepsInput,
): WorkspacePipelineHostDeps {
  const sourceMaterialAuthorization = createConsentLedgerSourceMaterialAuthorization(input.workspaceDir);
  const trajectoryTurnReader = input.trajectoryTurnReaderOverride
    ?? createGovernanceTrajectoryTurnReader({
      workspaceDir: input.workspaceDir,
      sourceMaterialAuthorization,
    });
  return {
    intentDocReader: createHostIntentDocReader({
      workspaceDir: input.workspaceDir,
      effectiveConfig: input.effectiveConfig,
    }),
    trajectoryTurnReader,
    sourceMaterialAuthorization,
    telemetrySink: createWorkspaceTelemetryEmitter(input.workspaceDir),
    isAutoPainSubmissionAuthorized: () => isAutomaticPainSubmissionAuthorized(input.workspaceDir),
  };
}
```

迁移调用点清单（共 7 处）：
1. `packages/pd-cli/src/commands/pain-record.ts:452`（同时修通 `--wait` 缺 `trajectoryTurnReader` 与 `sourceMaterialAuthorization`）
2. `packages/openclaw-plugin/src/hooks/pain.ts:50`（传入 `trajectoryTurnReaderOverride`，补齐 `sourceMaterialAuthorization` 与 `telemetrySink`）
3. `packages/host-runtime/src/diagnostician-auto-run.ts:156`
4. `packages/codex-adapter/src/worker/workspace-worker.ts:427` 与 `:520`
5. `packages/workbuddy-adapter/src/worker/workspace-worker.ts:392`
6. `packages/pd-cli/src/commands/diagnose.ts`（随 §3.3 一并收编）
7. `packages/pd-cli/src/commands/pain-retry.ts`（随 §3.3 一并收编）

---

### 3.2 缺陷 D2 修复：`deviationAnchor` 与 `anchor` 单轨化（Phase 1B）

#### 3.2.1 权威格式对照（已按源码核实）

- `pain-submit-capability.ts:181` 已定义原则锚点唯一格式：`ANCHOR_ID_PATTERN = /^(?<id>[^@\s]+)@(?<version>\d+)$/u`。
- 因此 `PainDeviationAnchor { principleId, principleVersion }` 与 `PainAnchor` 的确定性双向关系为：
  ```ts
  export function deviationAnchorToPainAnchor(da: PainDeviationAnchor): PainAnchor | undefined {
    const ref = `${da.principleId}@${da.principleVersion}`;
    return parsePainAnchor({ type: 'established_principle', ref });
  }
  ```

#### 3.2.2 写侧与读侧改动点

1. **纯转换辅助函数**：放在 `packages/principles-core/src/runtime/context-payload.ts`（紧邻 `parsePainAnchor`），保证写侧与读侧共用同一校验（`1 <= ref.length <= 300`，拒绝空串与超长串，`rc-1 / rc-3`）。
2. **写侧补齐**（消除新写入记录缺 `anchor`）：
   - `packages/principles-core/src/runtime/pain-ingress.ts:141`（`buildLegacy`）：当 `report.deviationAnchor !== undefined` 时，除保留 `legacy.deviationAnchor` 兼容字段外，同步写入 `legacy.anchor = deviationAnchorToPainAnchor(report.deviationAnchor)`；`LegacyPainSubmission` 接口补 `anchor?: PainAnchor`。
   - `packages/pd-cli/src/commands/pain-record.ts:490`：传入 `...(binding.anchor ? { anchor: binding.anchor } : {})`。
   - `packages/principles-core/src/runtime/pain-signal-bridge.ts:484`（`buildDiagnosticJson`）：若 `data.anchor === undefined && data.deviationAnchor !== undefined`，兜底派生 `anchor`，保证任何直接调 `PainSignalBridge` 的旧调用方也写出规范 `anchor`。
3. **读侧兼容**（保护历史已落盘任务）：
   - `packages/principles-core/src/runtime/store/context/sqlite-context-assembler.ts:661-670`（`reconstructDiagnosticianRecord`）：
     - 优先解析 `parsed.anchor`；
     - 当 `parsed.anchor === undefined` 且 `Object.hasOwn(parsed, 'deviationAnchor')` 时，用结构守卫校验 `{ principleId, principleVersion }` 并经 `deviationAnchorToPainAnchor` 还原为 `anchor`；若 `deviationAnchor` 存在但结构非法，向 `ambiguityNotes` 推入明确说明（`rc-9`，绝不静默吞掉）。

---

### 3.3 缺陷 D3 修复与诊断 CLI 手搓收编（Phase 2A）

#### 3.3.1 为什么不能直接让 CLI 调缓存版 `createPainSignalBridge`

实测 `diagnose.ts` 与 `pain-retry.ts` 存在 3 个合法特殊需求：
1. 支持 `--runtime test-double` 与命令行模型参数覆盖（`--provider / --model / --api-key-env / --base-url / --max-retries / --timeout`）；若写入进程级 `bridgeCache`，会污染同进程后续调用或命中旧缓存忽略覆盖参数。
2. `pd diagnose` 支持 `--no-intake`（只运行 `SplitDiagnosticianRunner.run(taskId)`，不执行 `PainSignalBridge.onDiagnosisComplete` 自动入库）。
3. `pd pain retry` 同时包含“已有任务重跑（`diagnoseRun`）”与“死信重放（`PainSignalBridge.onPainDetected`）”两条分支。

#### 3.3.2 抽出无缓存 `createDiagnosticianRunnerBundle`〔新增能力〕

文件：`packages/principles-core/src/runtime/pain-signal-runtime-factory.ts`

从现有 `createSplitBridge`（第 720–887 行）内部原位抽出无缓存组装函数，**不改变 `createPainSignalBridge` 的任何现有行为与缓存语义**：

```ts
export interface CreateDiagnosticianRunnerBundleOptions {
  readonly workspaceDir: string;
  readonly ledgerAdapter: LedgerAdapter;
  readonly owner: string;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly runtimeKind: string;
  readonly stageTimeoutMs: number;
  readonly effectiveConfig?: EffectivePdConfig;
  readonly stateManager?: RuntimeStateManager; // CLI 已初始化 stateManager 时复用，避免双连接
  readonly intentDocReader?: IntentDocReader;
  readonly trajectoryTurnReader?: TrajectoryTurnReader;
  readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
  readonly telemetrySink?: { emitTelemetry: (event: TelemetryEvent) => void };
}

export interface DiagnosticianRunnerBundle {
  readonly stateManager: RuntimeStateManager;
  readonly contextAssembler: SqliteContextAssembler;
  readonly committer: SqliteDiagnosticianCommitter;
  readonly runner: SplitDiagnosticianRunner;
  readonly executionTiming: ExecutionTiming;
  readonly dispose: () => Promise<void>;
}
```

收编效果：
- `createPainSignalBridge` 内部改为调用 `createDiagnosticianRunnerBundle` 后再包装 `CandidateIntakeService` + `PainSignalBridge` 并写入 `bridgeCache`。
- `packages/pd-cli/src/commands/diagnose.ts` 删除第 388–408 行与第 556–585 行的手搓 `SqliteContextAssembler + Diag*Runner + SplitDiagnosticianRunner`，改为调用 `resolveWorkspacePipelineHostDeps` + `createDiagnosticianRunnerBundle`。
- `packages/pd-cli/src/commands/pain-retry.ts` 删除第 632–648 行与第 694–724 行的同款手搓代码，改为调用同一函数；死信分支复用返回的 `runner`。
- **D3 自动闭环**：`createDiagnosticianRunnerBundle` 内部固定执行 `resolveExecutionTiming` 并向阶段 Runner 与父 `SplitDiagnosticianRunner` 同时注入 `leaseTtlMs` 与 `heartbeatIntervalMs`。

---

### 3.4 缺陷 D4 修复：`candidate internalize` 账本入库前置门禁（Phase 1B）

文件：`packages/pd-cli/src/commands/candidate.ts`（`handleCandidateInternalize`，第 454 行准入检查通过之后、`buildDreamerSeedFromCandidate` 之前）

执行顺序（严格遵守 `cli-1 / cli-4 / cli-5 / cli-6` 与 PRI-915）：

1. 构造 `const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: `${workspaceDir}/.state` });`
2. **先查账本可读性**：
   - 若 `!ledgerAdapter.isAvailable()`：返回 `status: 'write_failed'`（或 `refused`），`reason: 'ledger_unavailable'`，`nextAction: 'Inspect .state/ledger.json permissions or lock state and re-run pd candidate internalize.'`，`process.exit(1)` 并终止（零任务创建）。
3. **再查该候选是否已有账本原则条目**：
   - 若 `ledgerAdapter.listForCandidate(opts.candidateId).length === 0`：返回 `status: 'refused'`，`reason: 'candidate_not_in_ledger'`，`nextAction: \`Run 'pd candidate intake --candidate-id ${opts.candidateId} --confirm' to register a principle in the ledger before internalizing.\``，`process.exit(1)` 并终止（`--dry-run` 下同样返回该 `refused` 结论且零写入）。

---

### 3.5 内化单步执行收编与构造点架构守卫（Phase 2B）

#### 3.5.1 抽出 `executeSelectedInternalizationTask`〔新增能力〕

文件：`packages/host-runtime/src/internalization-consumer-cycle.ts`

将第 915–1120 行的“按 `taskKind` 构造对应 Peer Runner 并执行单任务”抽出为模块导出的共享函数：

```ts
export interface ExecuteSelectedInternalizationTaskInput {
  readonly workspaceDir: string;
  readonly stateManager: RuntimeStateManager;
  readonly orchestrator: InternalizationOrchestrator;
  readonly taskId: string;
  readonly taskKind: PeerRunnerKind;
  readonly adapter: PDRuntimeAdapter;
  readonly effectiveConfig: EffectivePdConfig;
  readonly owner: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly logger: ConsumerCycleLogger;
  readonly hostToolCatalog?: ConsumerHostToolCatalog;
  readonly toolSemantics?: ToolSemanticRegistry;
  readonly artificerHostSemanticContext?: ArtificerHostSemanticContext;
  readonly artificerEvidence?: ArtificerEvidencePreflightVerdict | null;
  readonly trustedFacts?: ArtificerTrustedFactsPort;
}
```

迁移：
- `runInternalizationConsumerCycle` 原位调用该函数，行为逐字节保持不变。
- `packages/pd-cli/src/commands/runtime-internalization-run-once.ts` 删除第 720–855 行的 6 分支手搓 `new DreamerRunner / PhilosopherRunner / ScribeRunner / ArtificerRunner / EvaluatorRunner / RolloutReviewerRunner`，改为先解析 CLI `runtimeAdapter`（含 `--runtime test-double`），再调用 `executeSelectedInternalizationTask`。

#### 3.5.2 全仓构造点白名单守卫

文件：`packages/principles-core/src/runtime/__tests__/architecture-regression.test.ts`

新增静态回归测试，扫描 `packages/*/src/**/*.ts`（排除 `*.test.ts`、`__tests__`）：
- `new (DiagRootCause|DiagDistiller|DiagRouter|SplitDiagnostician)Runner\(` **仅允许出现在**：
  - `packages/principles-core/src/runtime/pain-signal-runtime-factory.ts`
  - 显式实验白名单：`packages/pd-cli/src/services/synthetic-baseline-runner.ts`、`packages/pd-cli/src/services/pain-flood-simulation-runner.ts`
- `new (Dreamer|Philosopher|Scribe|Artificer|Evaluator|RolloutReviewer)Runner\(` **仅允许出现在**：
  - `packages/host-runtime/src/internalization-consumer-cycle.ts`
  - 显式算子白名单：`packages/pd-cli/src/services/rulehost-pipeline-runner.ts`
- `new PainSignalBridge\(` **仅允许出现在**：
  - `packages/principles-core/src/runtime/pain-signal-runtime-factory.ts`
  - `packages/pd-cli/src/commands/pain-retry.ts`（死信重放分支，且其 `runner` 必须来自 `createDiagnosticianRunnerBundle`）
  - 上述 2 个实验白名单文件。

---

### 3.6 后继血缘不变量收紧（Phase 3）

文件：`packages/principles-core/src/runtime/internalization/internalization-orchestrator.ts`、`internalization-state-machine.ts`、`ledger-identity.ts`

1. 新增纯解析辅助函数 `resolveAuthoritativeCorrelationId(piTask: PITaskRecord): string | null`：
   - 若 `typeof piTask.correlationId === 'string' && piTask.correlationId.trim() !== ''`，返回 `piTask.correlationId.trim()`；
   - 兼容历史存量无 `correlationId` 的根任务：若 `piTask.taskKind === 'dreamer'`，调用既有 `candidateIdFromDreamerTaskId(piTask.taskId)`（`ledger-identity.ts:67`）派生一次；
   - 其余情况返回 `null`。
2. 在 `proposeNextTask`、`commitNextTaskProposal` 与 `reopenTaskForRevision`（及 evaluator 修复任务播种）处：
   - 若源任务的 `resolveAuthoritativeCorrelationId` 返回 `null`，`commitNextTaskProposal` 返回结构化拒绝 `{ decision: 'invalid_task_metadata', taskId, reason: 'missing_correlation_id_lineage' }`（`rc-6` fail-closed，不创建无血缘后继）；
   - 所有新建后继与修复任务的 `pi_metadata.correlationId` 强制写入该非空值。

---

### 3.7 Canary Spine Test 详细设计（Phase 1A）

位置：`packages/host-runtime/tests/pipeline-spine-canary.e2e.test.ts`（放在 `host-runtime` 测试层，因为它同时跨越 `core`、`host-runtime` 协作者装配、提示投影与 RuleHost 门，不引入反向依赖）。

#### 3.7.1 假模型记录器（Schema-aware Recording Adapter / Local Fake Server）

按每次调用的 `outputSchemaRef` / stage 标识返回满足 TypeBox schema 的确定性合法 JSON，同时把每次调用收到的完整 `{ systemPrompt, userPrompt, timeoutMs, runtimeKind }` 追加到内存审计数组 `capturedInvocations[]`。

#### 3.7.2 探针矩阵与断言表

| 探针令牌 | 注入位置 | 必须在何处断言命中 | 撤回/异常负向断言 |
|---|---|---|---|
| `CANARY_REASON_9f3a` | `recordPain({ reason })` | Stage A/B/C 请求体、`principle_candidates`、Scribe/Evaluator `formationContext` 请求体 | — |
| `CANARY_OWNER_CORRECTION_7b2c` | `recordPain({ correctionEvidence })` | Stage A 请求体、`admission_json`（`ownerStatementPresent: true`） | — |
| `P_CANARY_ANCHOR_4d1e@1` | ① MCP `anchor`；② CLI `deviationAnchor` | 两条入口在 Stage A 请求体中**均必须出现** `P_CANARY_ANCHOR_4d1e@1`（修 D2 前 ② 必红） | 非法格式进入 `ambiguityNotes` |
| `CANARY_TURN_TEXT_8e5f` | `governance_observations`（`codex` 已授权会话） | 经 `PainToPrincipleService` 同步诊断时，Stage A 请求体**必须出现**（修 D1 前必红） | 将 consent ledger 改为 `revoked` 后重跑，Stage A 请求体**不得出现**该串，且 `ambiguityNotes` 含 `consent_revoked` |
| `CANARY_INTENT_2a6d` | `<workspace>/INTENT.md` + `intent_engineering=true` | Stage A 请求体 + 持久化 `intentSnapshot` + Scribe `IntentContractV2` | 开关关闭时不读文件 |
| 账本原则 UUID `<L_UUID>` | `CandidateIntakeService` 生成 | `pi_artifacts.source_principle_id === <L_UUID>`、`activations.target_ref === 'ledger://<L_UUID>'`、注入回执 `principle_applications.principle_id === <L_UUID>` | 未入账本候选调 `handleCandidateInternalize` 必拒（`candidate_not_in_ledger`） |

---

### 3.8 Phase 0、Phase 4、Phase 5 实施要点

1. **Phase 0（生产快照漏斗脚本）**：
   - 脚本路径：`scripts/dev/pipeline-funnel-snapshot.mjs`（只读工具，强制检查输入路径不在 `<workspace>/.pd/` 或 `~/.pd/` 原位目录——必须指向 `.tmp/` 下的复制件，从代码层杜绝违反 AGENTS §1.1）。
   - 输出指标：按全量与近 30 天窗口输出各阶段计数、转化率与 Top 失败/拒绝 `reasonCode` 分布，生成报告 `docs/reports/PD_PIPELINE_FUNNEL_BASELINE_20261123.md`。
2. **Phase 4（开关死分支清理与阶段合并评估门）**：
   - 先输出一张 55 开关实证分类表（A 类：旧代码已删的纯死开关，如 `diagnostician_split_pipeline`；B 类：生产恒开但保留紧急制动价值的开关；C 类：活跃实验开关），仅对经 Owner 签字确认的 A 类开关逐个提 PR 删分支。
   - 阶段合并评估严格走 `npm run lab:*` 既有链路（AGENTS §25A），不新建评估脚本。
3. **Phase 5（原则有效性派生读模型）**：
   - 位置：`packages/principles-core/src/runtime/principle-effectiveness-read-model.ts`（纯只读聚合，零写操作）。
   - 输出结构对每条活跃原则显式区分：`injectionCount`（存在性回执，不等同于有效）、`verifiedComplianceCount` / `verifiedDeviationCount`（仅计入满足 `PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md` 证据要求的结构化记录）、`postActivationAnchoredPainCount`（激活时间之后锚定到该 `principleId` 的新 Pain 数）、`verdict: 'insufficient_evidence' | 'observed_deviation' | 'active_monitored'`（绝不用“无报错”推导“已内化成功”）。

---

## 4. 验证与回归门禁清单

每个实施 PR 交付前必须通过以下对应门禁（除常规单测与 `npm run error:context` 双遍路由外）：

1. **先红证明**：Phase 1 PR 描述必须贴出修复 D1/D2/D4 前 Canary Spine Test 与对应单测失败的真实终端摘要。
2. **CLI 契约测试（AGENTS §10）**：修改 `pain-record.ts`、`diagnose.ts`、`pain-retry.ts`、`candidate.ts`、`runtime-internalization-run-once.ts` 时，必须跑过 `packages/pd-cli/tests/commands/` 对应套件，验证 `--json` 单一 JSON stdout（`cli-1`）、`--dry-run` 零副作用（`cli-4`）、失败零脏写（`cli-5`）与 `reason + nextAction`（`cli-6`）。
3. **PD-Lab 影响评估（AGENTS §25A）**：
   - Phase 0 / 1 / 2 / 3 / 5：不改动任何 Agent 提示词策略或判定阈值（仅补齐原本就应到达的已授权上下文与锚点），`PD-Lab Impact: NOT_REQUIRED`（在 PR 模板注明原因）。
   - Phase 4b（若启动阶段合并）：改变 Agent 拓扑与提示词，`PD-Lab Impact: REQUIRED`。

---

## 5. Linear 工单拆分映射

为满足工作区工单治理规则（归属明确活跃 Project、单父工单直接子工单数 `< 5`、远期条件门控项不混入当前活跃执行队列），拆分为 **1 个总控父工单 + 4 个当前可执行子工单 + 2 个条件门控远期工单**：

| 工单号 | 层级 | 对应阶段 | 标题 | 归属 Project | 初始状态 | 前置阻塞 |
|---|---|---|---|---|---|---|
| `PRI-1289` | 父工单 | Phase 0–3 总控 | `[SPEC-PD-PIPELINE-SPINE-001] 核心管道主干收敛与端到端连通性总控` | PD 产品瘦身与架构收敛 | `Todo` | 无 |
| `PRI-1290` | 子工单 1 | Phase 0 | `[Pipeline Spine][Phase 0] 生产工作区快照 30 天全链路漏斗与流失归因基线（只读）` | PD 产品瘦身与架构收敛 | `Todo` | 无（可与 `PRI-1291` 并行） |
| `PRI-1291` | 子工单 2 | Phase 1A + 1B | `[Pipeline Spine][Phase 1] Canary Spine 端到端探针测试与 D1/D2/D4 现存断线止血` | PD 产品瘦身与架构收敛 | `Todo` | 无（可立即启动） |
| `PRI-1292` | 子工单 3 | Phase 2A（含 D3） | `[Pipeline Spine][Phase 2A] resolveWorkspacePipelineHostDeps 协作者收口与诊断 CLI 收编（含 D3 心跳补齐）` | PD 产品瘦身与架构收敛 | `Todo` | `blockedBy PRI-1291` |
| `PRI-1293` | 子工单 4 | Phase 2B + Phase 3 | `[Pipeline Spine][Phase 2B/3] 内化单步执行收编、全仓构造点架构守卫与后继 correlationId 血缘收紧` | PD 产品瘦身与架构收敛 | `Todo` | `blockedBy PRI-1292` |
| `PRI-1294` | 远期工单 A | Phase 4 | `[Pipeline Spine][Phase 4] 已退役双轨开关死分支清理与阶段合并 PD-Lab 评估门` | PD 产品瘦身与架构收敛 | `Backlog` | `blockedBy PRI-1290, PRI-1289` |
| `PRI-1295` | 远期工单 B | Phase 5 | `[Pipeline Spine][Phase 5] 原则有效性派生读模型（注入 / 遵循偏离证据 / 同锚点 Pain 复发）` | PD 数据管道演进与学习闭环 | `Backlog` | `blockedBy PRI-1290, PRI-1289` |
