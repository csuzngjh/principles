# SPEC-PD-PIPELINE-SPINE-001 — 配套技术设计与实施方案

- **版本**：v0.5
- **日期**：2026-11-23
- **状态**：Draft for Owner Review（未批准；未开始生产代码实现）
- **上位规范**：[SPEC-PD-PIPELINE-SPINE-001（v0.5）](./SPEC-PD-PIPELINE-SPINE-001.md)
- **源码事实基线**：`origin/main@679dcc93f`
- **规范性数据契约**：[PD 行为偏差事件与相对评价规范](../concepts/PD_BEHAVIOR_DEVIATION_EVENT_AND_RELATIVE_EVALUATION.md)、[MVP Core Loop Contract](../architecture/MVP_CORE_LOOP_CONTRACT.md)
- **标注约定**：文中标注 `〔现有能力〕` 的符号已在当前源码中存在；标注 `〔新增能力〕` 的符号当前不存在，实施前不得以现有能力名义引用；标注 `〔收编删除〕` 的代码块为重复组装，迁移后删除。
- **v0.5 关键技术修订摘要**：
  1. §3.4.2 修正 D4 候选类型数据源：`resolveCandidatePrincipleIdentity` 必须传 `candidate.rawRecommendationKind`（`recommendationKind` 是 `candidate-store.ts` 明文标注的 fail-open 归一化读视图，禁止用于写边界判定）；`rule` 放行以验证后原始类型为准；登记 `pain-signal-bridge.ts:1766` 与 `diagnose.ts` 现存传归一化 kind 的同类隐患。
  2. §3.8 修正 Phase 0 数据库路径：`state.db` 位于 `.pd/`（非 `.state/`），脚本复用 `resolveStateDbPath` / `resolveTrajectoryDbPath`；偏斜窗口拆分为快照偏差（两 T1 之差 ≤5s）与跨库写入允许延迟（≤60s）两层语义，关联缺失以记录自身时间戳 vs 对方 T1 判定；`dispose()` 前先关闭 SQLite 连接（Windows 文件占用）。
  3. §3.6.2/§3.6.3 补齐根全盲边界：根 `dreamer` 三个身份来源全盲时仅后代携带的 `correlationId` 不得采纳；测试矩阵 11→12 场景。
- **v0.4 关键技术修订摘要**：
  1. §3.1.2 补充**调用方条件构造契约**：运行期 `boolean` 的 `asyncMode`（`pain-record.ts:450` 的 `asyncFlagEnabled && !opts.wait`）无法直接满足可辨识联合，必须分支构造两个字面量对象，禁止断言绕过。
  2. §3.4.2 修正 D4 执行顺序与 Admission 文档 fail-closed：`findExistingDreamerTask` 去重明确前移至身份门禁之前；`getAdmissionDocument` 的 `{ ok: false }`（按 `candidate-store.ts` 契约=损坏文档，不得当作缺失）一律 `refused`，优先复用 `enforceFullAdmissionForWrite` 已验证快照。
  3. §3.6.2/§3.6.3 加固 Phase 3：根 `dreamer` 的 `taskId` 与 `diagnosticJson` 双源身份必须交叉一致（`A+B` 拒绝），悬空父引用 fail-closed；测试矩阵由 7 扩至 11 场景。
  4. §3.8 明确 Phase 0 双库快照非原子性：记录两库快照时间/指纹与最大偏差窗口、跨库缺失按偏斜窗口判定、清理改为快照返回的受控 `dispose()`（不导出 `removeStagingRoot`）。
- **v0.3 关键技术修订摘要**：
  1. 补入全仓第 8 处协作者迁移点 `packages/openclaw-plugin/src/commands/pain.ts:333`（恒同步入口），并为 `PainToPrincipleServiceOptions` 增加同步/异步可辨识联合类型约束及 `new PainToPrincipleService(` 构造点守卫。
  2. 撤销原 D3“缺租约心跳”误诊（`resolveExecutionTiming` 默认 `120s / 40s` 已覆盖）；保留 `createDiagnosticianRunnerBundle` 作为纯去重与缓存隔离重构，并明确 `ownsStateManager` 资源释放契约。
  3. 重写 §3.4 D4 门禁：移除 `isAvailable() + listForCandidate()` 双读方案与错误的 `--confirm` 参数，改为在可内化路由判定后单次快照复用 `resolveCandidatePrincipleIdentity`〔现有能力〕+ `evaluateDreamerSeedSuppression`〔现有能力〕，精确区分 `principle` 未入账本（严格拒绝）、`principle_reuse`（抑制播种）与 `rule` 尚未绑定（放行至 `ScribeRunner` 预检）。
  4. 重写 §3.6 Phase 3 血缘算法：严格限定 `isPeerRunnerKind`（隔离 `DiagnosticianStageKind`），改为带 `getTask` 的有界父链回溯校验器，覆盖父子篡改检测与历史在途后代链恢复。
  5. 重写 §3.7 测试分层与 §3.8 Phase 0 快照：消除 `host-runtime → pd-cli` 反向测试依赖，拆为三层测试；Phase 0 复用 `pain-recall-read-model.ts` 的 `stageWalSnapshot`〔现有能力〕。

---

## 1. 技术决策摘要

| 决策点 | 选定方案 | 否决的备选方案与原因 |
|---|---|---|
| 顶层入口形态 | 保持既有双权威：写/同步触发走 `@principles/core` `PainToPrincipleService`〔现有能力〕，后台周期走 `@principles/host-runtime` `runPendingDiagnosticianOnce` / `runInternalizationConsumerCycle`〔现有能力〕 | 否决新建 `createPipelineRuntime` 大门面：违反 P2.1，且 `core` 内的 `pain-submit-capability.ts` 不能反向依赖 `host-runtime` |
| 宿主协作者防漏与同步类型门 | 在 `@principles/host-runtime` 新增 `resolveWorkspacePipelineHostDeps`〔新增能力〕（返回 5 字段全必填）；`PainToPrincipleServiceOptions` 在同步模式下类型级要求显式传入 `sourceMaterialAuthorization` 与 `trajectoryTurnReader` | 否决保持同步模式全可选：否则新入口仍可绕过 `resolveWorkspacePipelineHostDeps` 直接 `new PainToPrincipleService({...})` 静默回退拒绝授权材料 |
| 诊断 CLI 手搓收编与缓存隔离 | 在 `pain-signal-runtime-factory.ts` 抽出**不进 `bridgeCache`** 的 `createDiagnosticianRunnerBundle`〔新增能力〕，用 `ownsStateManager` 严格管理资源释放 | 否决直接调缓存版 `createPainSignalBridge`：CLI 的 `--runtime test-double`、`--no-intake` 与模型参数覆盖会污染或被 `bridgeCache` 吞掉；同时明确这不是修心跳 bug（默认心跳已生效），而是消除 100+ 行重复组装 |
| `deviationAnchor` 与 `anchor` 双轨 | 写侧（`pain-ingress.ts`、`pain-signal-bridge.ts`）统一补写规范 `PainAnchor { type: 'established_principle', ref: '<id>@<ver>' }`；读侧 `SqliteContextAssembler` 在 `anchor` 缺失时回退解析 `deviationAnchor` | 否决新增 CLI `--deviated-principle` 参数（避免无需求扩 scope）；否决直接删 `deviationAnchor`（保护存量任务） |
| `candidate internalize` 权威门禁（D4） | 在可内化路由判定后，单次快照复用 `resolveCandidatePrincipleIdentity`〔现有能力〕+ `evaluateDreamerSeedSuppression`〔现有能力〕；对未入账本 `principle` 候选严格拒绝并提示 `pd candidate intake --candidate-id <id> --workspace "<path>"` | 否决 v0.2 的 `isAvailable() + listForCandidate()`（双读竞态 + 漏判多原则歧义 + 漏抑制 `principle_reuse`）；**同时否决对 `rule` 候选的 `reason === 'missing'` 一刀切拒绝**（`CandidateIntakeService` 不写 `rule` 候选，`ruleCandidateBindings` 在下游 `ScribeRunner` 预检阶段才等待 Owner 绑定） |
| 内化单步执行收编 | 从 `internalization-consumer-cycle.ts` 抽出 `executeSelectedInternalizationTask`〔新增能力〕，收编 `runtime-internalization-run-once.ts` 的 6 分支 Runner switch〔收编删除〕 | 否决把 `rulehost-pipeline-runner.ts` 强行并入租约编排器：它是显式同步对抗算子，列入架构守卫白名单即可 |
| 内化父链血缘收紧 | 仅对 `PeerRunnerKind` 执行有界父链回溯 `resolveAuthoritativeCorrelationId(piTask, getTask)`〔新增能力〕，校验全链无冲突并支持从根 `dreamer` 恢复历史链 | 否决单节点纯函数（查不出父子不一致，且会阻断已走到 `philosopher/scribe` 的历史无 `correlationId` 链）；否决作用于 `DiagnosticianStageKind`（诊断子任务无 `candidateId`） |
| Phase 0 只读快照 | 复用 `pain-recall-read-model.ts` 的 `stageWalSnapshot`〔现有能力〕（`main + -wal` 双文件 T0/T1 指纹校验暂存拷贝，返回值携带受控 `dispose()` 清理闭包，不导出通用删除函数） | 否决裸 `fs.copyFileSync('state.db')`：WAL 模式下会漏未 checkpoint 提交，且在并发写入/checkpoint 时可能产生不一致页 |

---

## 2. 包依赖与模块落点

### 2.1 依赖方向与跨包导出面（零新增跨包边）

```text
@principles/core
  ├─ runtime/pain-to-principle-service.ts               [扩展: +sourceMaterialAuthorization 透传 + 同步/异步类型可辨识联合]
  ├─ runtime/pain-signal-runtime-factory.ts             [重构导出 #1: createDiagnosticianRunnerBundle]
  ├─ runtime/pain-recall-read-model.ts                  [导出既有只读原语: stageWalSnapshot 供 Phase 0 脚本复用]
  ├─ runtime/context-payload.ts                         [新增内部纯转换: deviationAnchorToPainAnchor]
  ├─ runtime/pain-ingress.ts / pain-signal-bridge.ts    [修复: deviationAnchor 同步派生 anchor]
  ├─ runtime/store/context/sqlite-context-assembler.ts  [修复: 读侧兼容 deviationAnchor]
  └─ runtime/internalization/internalization-orchestrator.ts [收紧: PeerRunnerKind 有界父链 correlationId 校验]
        ▲
        │（既有单向依赖，core 不反向引用任何上层包；测试同样禁止反向引用）
@principles/host-runtime
  ├─ src/workspace-pipeline-host-deps.ts                [新增导出 #2: resolveWorkspacePipelineHostDeps]
  ├─ src/diagnostician-auto-run.ts                      [迁移: 改用 resolveWorkspacePipelineHostDeps]
  └─ src/internalization-consumer-cycle.ts              [重构导出 #3: executeSelectedInternalizationTask]
        ▲
        │（既有单向依赖）
  ┌─────┴──────────────────────┬──────────────────────────────┬────────────────────────┐
pd-cli                   openclaw-plugin                codex-adapter          workbuddy-adapter
  ├─ pain-record.ts        ├─ src/core/pain-service.ts    └─ workspace-worker.ts └─ workspace-worker.ts
  ├─ diagnose.ts           ├─ src/hooks/pain.ts             [2 处迁移协作者打包]    [迁移协作者打包]
  ├─ pain-retry.ts         └─ src/commands/pain.ts
  ├─ candidate.ts             [双入口共用同一工厂 + 协作者打包]
  └─ runtime-internalization-run-once.ts
```

硬约束核对：
- **跨包公开符号增量共 3 个**（`createDiagnosticianRunnerBundle`、`resolveWorkspacePipelineHostDeps`、`executeSelectedInternalizationTask`）+ 1 个既有内部只读快照函数 `stageWalSnapshot` 暴露给仓库内脚本；更新 `@principles/core/runtime` 公开桶时必须同步更新 `runtime-barrel-surface.json`、`export-surface-baseline.json` 与 `export-admissions.json`。
- `packages/principles-core/io-seam-registry.json` **无需新增条目**（`stageWalSnapshot` 已在 `pain-recall-read-model.ts` 注册边界内，其余改动无新 I/O）。

---

## 3. 详细模块设计

### 3.1 缺陷 D1 修复、全仓 `PainToPrincipleService` 盘点与协作者打包（Phase 1B + Phase 2A）

#### 3.1.1 全仓 5 处 `new PainToPrincipleService(` 分类处置表

| # | 文件位置 | 运行模式 | 当前缺失项 | 处置方案 |
|---|---|---|---|---|
| 1 | `packages/pd-cli/src/commands/pain-record.ts:452` | `--wait` 或 `!diagnostician_async_cli` 时**同步** | `trajectoryTurnReader`、`sourceMaterialAuthorization` | Phase 1B 补齐依赖；Phase 2A 切换至 `resolveWorkspacePipelineHostDeps` |
| 2 | `packages/openclaw-plugin/src/hooks/pain.ts:57` | `!diagnostician_async_hook` 时**同步** | `sourceMaterialAuthorization`、`telemetrySink` | Phase 1B 补齐；Phase 2A 与 #3 合并为插件内单一工厂 `createPluginPainToPrincipleService(wctx)` |
| 3 | `packages/openclaw-plugin/src/commands/pain.ts:333` | 未传 `asyncMode`，**恒同步** | `trajectoryTurnReader`、`sourceMaterialAuthorization`、`telemetrySink` | **v0.3 新增必改点**：同上，复用 `wctx.trajectory` + `resolveWorkspacePipelineHostDeps` |
| 4 | `packages/host-runtime/src/governance-signal-admission.ts:2589` | `asyncMode: true`（纯异步落库） | 无（异步落库不运行 `SqliteContextAssembler`） | 保持 `asyncMode: true` 分支类型合法；列入构造守卫白名单并注释原因 |
| 5 | `packages/principles-core/src/runtime/pain-submit-capability.ts:620` | `asyncMode: true`（MCP 纯异步落库） | 无（位于 `core` 内，不得依赖 `host-runtime`） | 保持 `asyncMode: true` 分支类型合法；列入构造守卫白名单 |

#### 3.1.2 `@principles/core`：`PainToPrincipleServiceOptions` 同步/异步可辨识联合

文件：`packages/principles-core/src/runtime/pain-to-principle-service.ts`

将 `PainToPrincipleServiceOptions` 收紧为按 `asyncMode` 区分的可辨识契约（消除同步路径漏传授权/轨迹依赖却能通过编译的隐患）：

```ts
interface PainToPrincipleServiceBaseOptions {
  readonly workspaceDir: string;
  readonly stateDir: string;
  readonly ledgerAdapter: LedgerAdapter;
  readonly owner?: string;
  readonly autoIntakeEnabled?: boolean;
  readonly effectiveConfig?: EffectivePdConfig;
  readonly getEnvVar?: (name: string) => string | undefined;
  readonly intentDocReader?: IntentDocReader;
  readonly telemetrySink?: { emitTelemetry: (event: TelemetryEvent) => void };
  readonly isAutoPainSubmissionAuthorized?: () => boolean;
}

export type PainToPrincipleServiceOptions =
  | (PainToPrincipleServiceBaseOptions & {
      readonly asyncMode: true;
      readonly trajectoryTurnReader?: TrajectoryTurnReader;
      readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
    })
  | (PainToPrincipleServiceBaseOptions & {
      readonly asyncMode?: false;
      /** 同步或可能走同步诊断的入口必须显式注入；单测可显式传空读取器与 denyAllSourceMaterialAuthorization */
      readonly trajectoryTurnReader: TrajectoryTurnReader;
      readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
    });
```

并在 `recordPain` 同步路径调用 `createPainSignalBridge` 处透传 `sourceMaterialAuthorization: this.opts.sourceMaterialAuthorization`。

**调用方条件构造契约（v0.4 新增，实施前必读）**：上述联合的两个分支分别要求 `asyncMode` 为字面量 `true` / `false`（或省略）。而现有调用点算出的 `asyncMode` 是**运行时 `boolean`**（`pain-record.ts:450`：`const asyncMode = asyncFlagEnabled && !opts.wait`；`openclaw-plugin/src/hooks/pain.ts` 同型），`boolean` 不能收窄到任一分支字面量，直接 `new PainToPrincipleService({ ...base, asyncMode })` 无法通过类型检查。所有生产构造点必须改为条件构造：

```ts
const serviceOptions: PainToPrincipleServiceOptions = asyncMode
  ? { ...baseOptions, asyncMode: true as const }
  : {
      ...baseOptions,
      asyncMode: false as const,
      trajectoryTurnReader,        // 来自 resolveWorkspacePipelineHostDeps
      sourceMaterialAuthorization, // 来自 resolveWorkspacePipelineHostDeps
    };
```

语义要求：① 异步分支不强制创建同步诊断才需要的上下文依赖；② 同步分支在编译期强制提供授权与轨迹读取器；③ 禁止以 `as` 断言把 `boolean` 强转字面量掩盖依赖缺失（该模式列入架构守卫扫描项）。

#### 3.1.3 `@principles/host-runtime`：`resolveWorkspacePipelineHostDeps`〔新增能力〕

新增文件：`packages/host-runtime/src/workspace-pipeline-host-deps.ts`（从 `packages/host-runtime/src/index.ts` 导出）

```ts
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
  /** OpenClaw Gateway hook / command 进程内已持有 WorkspaceContext.trajectory 时覆写 */
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

迁移调用点清单（共 **8 处**）：
1. `packages/pd-cli/src/commands/pain-record.ts:452`
2. `packages/openclaw-plugin/src/hooks/pain.ts:50`（与 #3 收敛至共享 `createPluginPainToPrincipleService(wctx)`）
3. `packages/openclaw-plugin/src/commands/pain.ts:333`（**v0.3 新增**）
4. `packages/host-runtime/src/diagnostician-auto-run.ts:156`
5. `packages/codex-adapter/src/worker/workspace-worker.ts:427` 与 `:520`
6. `packages/workbuddy-adapter/src/worker/workspace-worker.ts:392`
7. `packages/pd-cli/src/commands/diagnose.ts`（随 §3.3 收编）
8. `packages/pd-cli/src/commands/pain-retry.ts`（随 §3.3 收编）

---

### 3.2 缺陷 D2 修复：`deviationAnchor` 与 `anchor` 单轨化（Phase 1B）

1. **权威格式**：复用 `pain-submit-capability.ts:181` 的 `<principleId>@<principleVersion>` 规则，在 `packages/principles-core/src/runtime/context-payload.ts` 紧邻 `parsePainAnchor` 新增：
   ```ts
   export function deviationAnchorToPainAnchor(da: PainDeviationAnchor): PainAnchor | undefined {
     if (!da.principleId.trim() || !da.principleVersion.trim()) return undefined;
     const ref = `${da.principleId.trim()}@${da.principleVersion.trim()}`;
     if (!/^[^@\s]+@\d+$/u.test(ref)) return undefined;
     return parsePainAnchor({ type: 'established_principle', ref });
   }
   ```
2. **写侧补齐**：
   - `packages/principles-core/src/runtime/pain-ingress.ts:141`（`buildLegacy`）：当 `report.deviationAnchor !== undefined` 时，同步设置 `legacy.anchor = deviationAnchorToPainAnchor(report.deviationAnchor)`（`LegacyPainSubmission` 增加 `anchor?: PainAnchor`），保留 `legacy.deviationAnchor` 以兼容旧测试/观测消费者。
   - `packages/principles-core/src/runtime/pain-signal-bridge.ts:484`（`buildDiagnosticJson`）：当 `data.anchor === undefined && data.deviationAnchor !== undefined` 时兜底派生 `anchor`。
   - 注：不在 `pd pain record` 新增 `--deviated-principle` 参数（当前 `RecordOptions` 无该能力，遵循 P3 不扩无关 CLI 范围；`pain-record.ts:490` 同步透传 `binding.anchor` 即可）。
3. **读侧兼容**：
   - `packages/principles-core/src/runtime/store/context/sqlite-context-assembler.ts:661-670`（`reconstructDiagnosticianRecord`）：当 `parsed.anchor === undefined` 且 `Object.hasOwn(parsed, 'deviationAnchor')` 时校验 `{ principleId, principleVersion }` 并经 `deviationAnchorToPainAnchor` 还原；字段存在但格式非法时向 `ambiguityNotes` 推入明确说明（`rc-9`）。

---

### 3.3 诊断 CLI 重复 Runner 收编（Phase 2A，纯去重与防漂移重构）

> **v0.3 勘误说明**：`resolveExecutionTiming()` 已默认提供 `leaseTtlMs = 120_000` 与 `heartbeatIntervalMs = 40_000`，`diagnose.ts` 与 `pain-retry.ts` 当前**并不存在心跳缺失故障**。本节重构目的严格限定为：消除两处共 ~100 行重复 Runner 装配、隔离 `--runtime test-double` / `--no-intake` 免污染 `bridgeCache`、防止未来新增阶段协作者再次漏传。

文件：`packages/principles-core/src/runtime/pain-signal-runtime-factory.ts`

```ts
export interface CreateDiagnosticianRunnerBundleOptions {
  readonly workspaceDir: string;
  readonly ledgerAdapter: LedgerAdapter;
  readonly owner: string;
  readonly runtimeAdapter: PDRuntimeAdapter;
  readonly runtimeKind: string;
  readonly stageTimeoutMs: number;
  readonly effectiveConfig?: EffectivePdConfig;
  /** 外部已初始化并持有生命周期的 stateManager；传入时 bundle.dispose() 绝不关闭它 */
  readonly stateManager?: RuntimeStateManager;
  readonly intentDocReader: IntentDocReader;
  readonly trajectoryTurnReader: TrajectoryTurnReader;
  readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
  readonly telemetrySink?: { emitTelemetry: (event: TelemetryEvent) => void };
}

export interface DiagnosticianRunnerBundle {
  readonly stateManager: RuntimeStateManager;
  readonly ownsStateManager: boolean;
  readonly contextAssembler: SqliteContextAssembler;
  readonly committer: SqliteDiagnosticianCommitter;
  readonly runner: SplitDiagnosticianRunner;
  readonly executionTiming: ExecutionTiming;
  readonly dispose: () => Promise<void>;
}
```

资源与契约硬约束：
1. **双连接与误关防护**：`const ownsStateManager = options.stateManager === undefined;`——当 `diagnose.ts` 或 `pain-retry.ts` 传入已打开的 `stateManager` 时，`bundle.dispose()` 只清理内部监听器，**绝不调用 `stateManager.close()`**，由 CLI 外层 `finally` 按原逻辑关闭；仅当工厂自建 `stateManager`（如 `createPainSignalBridge` 路径）时才在 `dispose()` 中关闭。
2. **CLI 契约零变更**：保留 `diagnose.ts` 的 `--no-intake`、ERR-067 外层 `retried` 重试循环与输出 JSON 结构；保留 `pain-retry.ts` 的死信重放（`PainSignalBridge.onPainDetected`）与已有任务重跑（`diagnoseRun`）双分支。

---

### 3.4 缺陷 D4 修复：`candidate internalize` 权威身份与播种抑制门禁（Phase 1B）

文件：`packages/pd-cli/src/commands/candidate.ts`（`handleCandidateInternalize`）

#### 3.4.1 为什么必须复用 `resolveCandidatePrincipleIdentity` + `evaluateDreamerSeedSuppression`

1. **禁止 `isAvailable() + listForCandidate()` 双读**：两次独立文件读取存在 TOCTOU 竞态，且 `listForCandidate().length > 0` 漏放 `length > 1` 的多原则歧义；`PrincipleTreeLedgerAdapter.resolveCandidatePrincipleIdentity`（`principle-tree-ledger-adapter.ts:145`）已在单次文件快照内统一裁决 `ledger_unavailable`、`ledger_corrupt`、`missing`、`ambiguous`、`conflicting_authorities`、`binding_revoked`、`target_missing`、`target_ineligible`。
2. **必须同时运行 `evaluateDreamerSeedSuppression`**：当候选已通过复用决议或精确去重绑定到既有原则（`identity.basis === 'principle_reuse'`），或处于 `reuse_pending_owner` / `pendingOwnerDecision` 时，按 Phase 7.2 B2.5 规范**禁止创建重复 Dreamer 任务**（同文件 `candidate.ts:1232` 已实现，`handleCandidateInternalize` 此前漏接）。
3. **必须保留 `rule` 候选的合法播种窗口**：`CandidateIntakeService`（`candidate-intake-service.ts:641`）仅对 `recommendation_kind === 'principle'` 写账本；新 `rule` 候选在 Dreamer 启动前天然尚无 `ruleCandidateBindings`（`identity` 返回 `{ status: 'unresolved', reason: 'missing' }`），其 Owner 规则绑定发生在下游 `ScribeRunner` 预检阶段（`awaiting_owner_binding`）。因此对 `rule` 候选的 `reason === 'missing'` **必须放行播种**，与 `PainSignalBridge`（`pain-signal-bridge.ts:1788`）和 `diagnose.ts:858` 保持 100% 一致。

#### 3.4.2 精确执行顺序（v0.4 修正：去重前置于身份门禁，`ok:false` fail-closed）

`handleCandidateInternalize` 的目标顺序（现行代码为 seed → `--dry-run` → `findExistingDreamerTask` → `createTask`；本设计把既有任务去重明确前移到身份门禁之前）：

```
enforceFullAdmissionForWrite          （准入写门禁，内部已 getAdmissionDocument 并 fail-closed）
  → decideInternalizationRoute        （defer/implementation 等不可内化 → 既有 no_task_created）
  → resolveSourcePainIdFromDiagnostician + buildDreamerSeedFromCandidate
  → findExistingDreamerTask           （去重前移：已存在任务直接返回 status:'existing'，
                                       不被后续账本身份变化误报为拒绝）
  → 【D4 身份与抑制门禁】（本节伪代码）
  → --dry-run 预览 / createTask
```

```ts
const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
// v0.5：必须传原始持久化字段。candidate.recommendationKind 是
// resolveRecommendationKind() 的 fail-open 归一化视图（非法值折叠为 'principle'，
// candidate-store.ts 明文 "DO NOT use this field for write-boundary decisions"）；
// 传归一化值会让非法 kind 永远绕过 candidate_kind_invalid 分支。
const rawKind = validateRecommendationKind(candidate.rawRecommendationKind);
const identity = ledgerAdapter.resolveCandidatePrincipleIdentity(opts.candidateId, candidate.rawRecommendationKind);

// 优先复用 enforceFullAdmissionForWrite 已验证过的 Admission 文档快照（可由该门禁
// 返回已读文档，或在本函数顶部共享一次读取结果），避免第二次独立读取窗口。
// 若实现上仍需二次读取，{ ok: false } 按 candidate-store.ts 契约是损坏/不可读文档，
// 必须 fail-closed —— 绝不折叠为「无文档」放行：
const admissionDoc = await stateManager.getAdmissionDocument(opts.candidateId);
if (!admissionDoc.ok) {
  // 输出 { status: 'refused', reason: `admission_document_unreadable:${admissionDoc.reason}`,
  //        nextAction: 'inspect principle_candidates.admission_json; repair or re-run diagnosis' } 并 exit(1)
}
const pending = pendingOwnerDecision(admissionDoc.document ?? null);
const suppression = evaluateDreamerSeedSuppression({
  identity,
  processing: admissionDoc.document?.processing,
  ...(pending !== null ? { pendingOwnerDecision: { decision: pending.decision } } : {}),
});

if (suppression.suppress) {
  // 按 candidate.ts:1240-1260 同款 reason / nextAction 返回 status: 'refused' 并 exit(1)
}

if (identity.status !== 'resolved') {
  // rule 放行必须基于 validateRecommendationKind() 校验后的原始类型（null = 非法 kind，
  // 已由 candidate_kind_invalid fail-closed，不会到达此分支）。
  const allowUnboundRuleSeed = rawKind === 'rule' && identity.reason === 'missing';
  if (!allowUnboundRuleSeed) {
    const nextAction = identity.reason === 'missing'
      ? `pd candidate intake --candidate-id ${opts.candidateId} --workspace "${workspaceDir}"`
      : identity.nextAction;
    const reason = identity.reason === 'missing'
      ? 'candidate_not_in_ledger'
      : `ledger_identity_${identity.reason}`;
    // 输出 CandidateInternalizeResult { status: 'refused', reason, nextAction } 并 exit(1)（零任务创建）
  }
}
```

> 注 1：已核实 `packages/pd-cli/src/program.ts:1356-1364`，`pd candidate intake` 的真实参数为 `--candidate-id <id> [-w, --workspace <path>] [--json] [--dry-run]`，不含 `--confirm`。
>
> 注 2：现有 `diagnose.ts:877` 与 `candidate.ts:1231` 的抑制输入采用 `admissionDoc.ok ? ... : undefined` 折叠写法（历史惯例）。本门禁是新增的 fail-closed 判定点，**不得**复制该惯例；上述两个既有调用点是否同步收紧列为实施期可选项，不属本 PR 范围。
>
> 注 3（v0.5）：同类隐患亦存在于 kind 数据源——`pain-signal-bridge.ts:1766` 与 `diagnose.ts` 向 `resolveCandidatePrincipleIdentity` 传入归一化的 `candidate.recommendationKind ?? 'principle'`（而非 `rawRecommendationKind`），非法持久化 kind 在这两条既有路径上同样无法触发 `candidate_kind_invalid`。本门禁必须使用 `rawRecommendationKind`；既有两处的同步修正列为实施期可选修复（与注 2 的 `ok:false` 折叠写法一并评估）。

---

### 3.5 内化单步执行收编与全仓构造点守卫（Phase 2B）

#### 3.5.1 抽出 `executeSelectedInternalizationTask`〔新增能力〕

文件：`packages/host-runtime/src/internalization-consumer-cycle.ts`

将第 915–1120 行的 6 种 `PeerRunnerKind` 构造与执行逻辑抽出为共享函数，供 `runInternalizationConsumerCycle` 与 `packages/pd-cli/src/commands/runtime-internalization-run-once.ts` 共用。必须附带 **6 种 Runner 等价性单测（Parity Tests）**，逐项断言 `ScribeRunner.ledgerIdentity`、`ArtificerRunner` 的 `hostToolCatalog` / `toolSemantics` / `artificerHostSemanticContext` / `artificerEvidence` / `trustedFacts` 及 `EvaluatorRunner` 沙箱参数在周期路径与 `run-once` 路径完全一致。

#### 3.5.2 全仓构造点白名单守卫

文件：`packages/principles-core/src/runtime/__tests__/architecture-regression.test.ts`

扫描 `packages/*/src/**/*.ts`（排除测试文件），锁定四类构造点白名单：
1. `new (DiagRootCause|DiagDistiller|DiagRouter|SplitDiagnostician)Runner\(`：仅限 `pain-signal-runtime-factory.ts` 及 2 个显式实验白名单（`synthetic-baseline-runner.ts`、`pain-flood-simulation-runner.ts`）。
2. `new (Dreamer|Philosopher|Scribe|Artificer|Evaluator|RolloutReviewer)Runner\(`：仅限 `internalization-consumer-cycle.ts` 及显式同步对抗算子 `rulehost-pipeline-runner.ts`。
3. `new PainSignalBridge\(`：仅限 `pain-signal-runtime-factory.ts`、`pain-retry.ts`（死信重放分支，且其 `runner` 来自 `createDiagnosticianRunnerBundle`）及上述 2 个实验白名单。
4. **`new PainToPrincipleService\(`（v0.3 新增守卫）**：仅限已核实的白名单文件（`pain-record.ts`、`openclaw-plugin` 共享服务工厂、`governance-signal-admission.ts`、`pain-submit-capability.ts`），且所有非 `asyncMode: true` 构造点必须经 `resolveWorkspacePipelineHostDeps` 提供完整依赖。

---

### 3.6 内化链 `correlationId` 有界父链回溯与一致性收紧（Phase 3）

文件：`packages/principles-core/src/runtime/internalization/internalization-orchestrator.ts`、`internalization-state-machine.ts`

#### 3.6.1 作用域硬边界：严格隔离 `DiagnosticianStageKind`

`InternalizationOrchestrator.proposeNextTask`（第 564–595 行）同时包含 `isDiagnosticianStageKind(piTask.taskKind)` 与 `isPeerRunnerKind(piTask.taskKind)` 两条分支。诊断子任务（`diag_rootcause → diag_distiller → diag_router`）在候选生成前运行，**本来就不携带 `correlationId`**（由 `parentTaskId` 与 `dependencyTaskIds` 关联）。因此本节校验**仅在 `isPeerRunnerKind(piTask.taskKind)` 分支、Evaluator 修复播种与 `reopenTaskForRevision` 中执行**，`DiagnosticianStageKind` 分支保持原样不触碰。

#### 3.6.2 有界父链回溯校验算法 `resolveAuthoritativeCorrelationId`

```ts
export type CorrelationLineageResolution =
  | { readonly ok: true; readonly correlationId: string; readonly recoveredFromLegacyRoot: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'missing_correlation_id_lineage'
        | 'conflicting_parent_correlation_id'
        | 'conflicting_root_identity_sources'
        | 'dangling_parent_reference'
        | 'parent_chain_cycle_or_depth_exceeded';
      readonly detail: string;
    };

const MAX_LINEAGE_DEPTH = 10;

export async function resolveAuthoritativeCorrelationId(
  leafTask: PITaskRecord,
  getTask: (taskId: string) => Promise<TaskRecord | null>,
): Promise<CorrelationLineageResolution>;
```

判定规则：
1. 从当前 `leafTask` 开始沿 `parentTaskId` 向上遍历（最多 `MAX_LINEAGE_DEPTH = 10` 跳，用 `visited: Set<string>` 防环；超限或成环返回 `parent_chain_cycle_or_depth_exceeded`）。
2. **悬空父引用 fail-closed（v0.4 新增）**：回溯中任一节点声明了非空 `parentTaskId` 但 `getTask(parentTaskId)` 返回 `null`（父链断裂、无法证明血缘来源），即使该节点自身带有 `correlationId` 也立即返回 `{ ok: false, reason: 'dangling_parent_reference' }`。
3. 收集沿途所有非空 `correlationId`（trim 后）以及链顶根任务 `rootTask`：
   - **父子冲突检测**：若链上出现 ≥ 2 个不同的非空 `correlationId`（例如根 `dreamer` 为 `cand-A`，子 `philosopher` 被写成 `cand-B`），立即返回 `{ ok: false, reason: 'conflicting_parent_correlation_id' }`；
   - **根身份双源交叉校验（v0.4 修正，禁止 `??` 静默偏向）**：若 `rootTask.taskKind === 'dreamer'`，分别提取 `fromTaskId = candidateIdFromDreamerTaskId(rootTask.taskId)` 与 `fromSeed = candidateIdFromDreamerSeed(rawRoot.diagnosticJson)`——这是两个独立持久化事实，按下表裁决：
     | `fromTaskId` | `fromSeed` | 裁决 |
     |---|---|---|
     | `A` | `A` | `rootSeedId = A` |
     | `A` | `B`（`B ≠ A`） | `{ ok: false, reason: 'conflicting_root_identity_sources' }` |
     | `A` | `null` | `rootSeedId = A` |
     | `null` | `B` | `rootSeedId = B` |
     | `null` | `null` | `rootSeedId = null`（进入不可恢复分支） |
   - **根锚点核对**：若链上非空 `correlationId` 与非空 `rootSeedId` 不一致，返回 `conflicting_parent_correlation_id`；
   - **正常命中（v0.5 根佐证要求）**：若链上存在唯一非空 `correlationId`，还须获得根侧佐证——`rootSeedId` 与其一致，或根任务自身携带同一 `correlationId`；若根 `dreamer` 的 `taskId`、`diagnosticJson` 与自身 `correlationId` 三个身份来源全部无法佐证（例如仅某个后代节点携带 `correlationId`），视为无法证明血缘来源，返回 `{ ok: false, reason: 'missing_correlation_id_lineage' }`；
   - **历史无 `correlationId` 在途链恢复**：若整条链（例如历史 `Dreamer → Philosopher → Scribe` 均无 `correlationId`）能够沿 `parentTaskId` 追溯到 `rootTask.taskKind === 'dreamer'` 且 `rootSeedId !== null`（经上述双源校验），返回 `{ ok: true, correlationId: rootSeedId, recoveredFromLegacyRoot: true }`，并在新生成的后继任务中前向持久化该 `correlationId`；
   - **不可恢复孤儿任务**：其余情况返回 `{ ok: false, reason: 'missing_correlation_id_lineage' }`，`commitNextTaskProposal` / `reopenTaskForRevision` fail-closed 拒绝创建无血缘后继。

#### 3.6.3 Phase 3 必测矩阵（v0.5 扩至 12 个场景）

| # | 测试场景 | 预期结果 |
|---|---|---|
| 1 | 新 `Dreamer → Philosopher → Scribe` 正常推进 | 全链 `correlationId === candidateId` |
| 2 | 子任务 `correlationId = cand-B` 而父任务 `Dreamer` 为 `cand-A` | 拒绝（`conflicting_parent_correlation_id`），零后继创建 |
| 3 | 历史在途链 `Dreamer(无) → Philosopher(无) → Scribe(无)` 推进下一跳 | 沿 `parentTaskId` 追溯到根 `Dreamer` 恢复 `candidateId`，新后继写实 `correlationId` |
| 4 | 孤儿 `Philosopher(无 correlationId)` 且 `parentTaskId` 缺失或指向不存在任务 | fail-closed 拒绝（`missing_correlation_id_lineage` 或 `dangling_parent_reference`） |
| 5 | `diag_rootcause → diag_distiller → diag_router` 后继提议 | **完全不受影响**，正常生成后继提议 |
| 6 | `Evaluator → Artificer Repair → Evaluator` 修复循环 | 修复任务与重审任务继承同一 `correlationId` |
| 7 | `reopenTaskForRevision` 修订重开 | 保持原 `candidateId` 血缘不变；父链篡改时拒绝 |
| 8 | 子任务**有** `correlationId` 但 `parentTaskId` 指向不存在任务 | fail-closed 拒绝（`dangling_parent_reference`） |
| 9 | 根 `Dreamer`：`taskId` 含 `cand-A` 而 `diagnosticJson` 写 `cand-B` | 拒绝（`conflicting_root_identity_sources`） |
| 10 | 父链自环（`A.parentTaskId = B`、`B.parentTaskId = A`） | 拒绝（`parent_chain_cycle_or_depth_exceeded`） |
| 11 | 链深恰好 10 跳 / 11 跳边界 | 10 跳内正常裁决；11 跳拒绝（`parent_chain_cycle_or_depth_exceeded`） |
| 12 | 根 `Dreamer` 全盲（`taskId` 不可解析、`diagnosticJson` 无 candidateId、自身无 `correlationId`），仅后代 `Philosopher` 带 `correlationId = cand-A` | fail-closed 拒绝（`missing_correlation_id_lineage`） |

---

### 3.7 分层探针与组合根测试详细设计（Phase 1A）

严格遵循包单向依赖，不把 CLI 测试塞进 `host-runtime`：

#### Layer A：`packages/host-runtime/tests/`（2 个端到端探针文件）

1. **`pipeline-spine-prompt-canary.e2e.test.ts`**（基础主干常驻探针）：
   - 录制型 Fake Runtime Adapter 不仅符合 TypeBox Schema，且产出的根因引用真实探针 `sourceRef`、候选满足 `checkAdmissionGate` 准入条件、Scribe 产出符合 `DefaultScribeValidator` 业务规则。
   - 探针断言表：
     - `CANARY_REASON_9f3a`：出现在 Stage A/B/C 请求体、`principle_candidates`、Scribe 请求体；
     - `CANARY_OWNER_CORRECTION_7b2c`：出现在 Stage A 请求体与 `admission_json`（`ownerStatementPresent: true`）；
     - `P_CANARY_ANCHOR_4d1e@1`：分别通过 ① MCP `anchor` 与 ② **`evaluatePainIngress({ painType: 'principle_deviation', deviationAnchor })`** 两条真实入口提交，Stage A 请求体均必须包含 `P_CANARY_ANCHOR_4d1e@1`（修 D2 前 ② 必红）；另测历史仅含 `deviationAnchor` 的任务行恢复与非法格式写入 `ambiguityNotes`；
     - `CANARY_TURN_TEXT_8e5f`：预置已授权 `codex` 会话观察记录，经 `PainToPrincipleService` 同步路径诊断时 Stage A 请求体必现（修 D1 前必红）；将授权账本翻转为 `revoked` 后重跑，断言该串从请求体消失且 `ambiguityNotes` 记录 `consent_revoked`；
     - `CANARY_INTENT_2a6d`：开启 `intent_engineering` 时进入 Stage A 请求体与 `intentSnapshot`；
     - 最终账本原则 UUID 一致性：`pi_artifacts.source_principle_id`、`activations.target_ref`、`principle_applications.principle_id` 三者全等。
2. **`pipeline-spine-rulecode-canary.e2e.test.ts`**（`code_tool_hook` 高风险渠道集成探针）：
   - 覆盖 `rule` 候选播种 → Dreamer/Philosopher → `ScribeRunner` 预检停靠 `awaiting_owner_binding` → Owner 绑定原则身份 → Scribe → Artificer → Evaluator（沙箱重放）→ RolloutReviewer → 审批 → Shadow/Live → `production-rulehost-gate` 拦截回执全链。

#### Layer B：`packages/pd-cli/tests/commands/`（CLI 真实入口测试）

- 验证 `pain-record --wait` 真实注入授权与轨迹读取器（修 D1 前红、修后绿）；
- 验证 `handleCandidateInternalize` 的 D4 完整矩阵：① 未入账本 `principle` 候选返回 `refused / candidate_not_in_ledger` 且 `nextAction` 为 `pd candidate intake --candidate-id <id> --workspace "<path>"`；② `principle_reuse` 已复用候选返回抑制拒绝；③ 未绑定 `rule` 候选正常创建 `dreamer` 任务；④ `defer` 候选维持 `no_task_created`；⑤ 账本多原则歧义或损坏时 fail-closed 拒绝。
- Phase 2A/2B 时验证 `diagnose`、`pain-retry`（含外部 `stateManager` 不被提前关闭、死信重放分支不变）与 `runtime-internalization-run-once`。

#### Layer C：`packages/openclaw-plugin/tests/`（插件双入口测试）

- 同时测试 `src/hooks/pain.ts` 与 `src/commands/pain.ts`（修 D1 前红、修后绿），证明两条入口均传入 `WorkspaceContext.trajectory` 读取器与同一工作区的 `sourceMaterialAuthorization`。

---

### 3.8 Phase 0、Phase 4、Phase 5 实施要点

1. **Phase 0（复用 WAL 安全暂存快照的漏斗分析脚本，v0.4 修订）**：
   - **受控快照接口**：在 `packages/principles-core/src/runtime/pain-recall-read-model.ts` 调整 `stageWalSnapshot` 导出形态——返回值携带受控 `dispose()` 闭包负责清理暂存目录（`{ stagedDbPath, fingerprint, capturedAt, dispose }`），**不导出**通用目录删除函数 `removeStagingRoot`（避免把任意路径删除能力暴露给所有消费者）。存量 `pd pain recall` 调用点同步改用 `dispose()`。
   - **跨库非原子性约束（v0.5 细化语义）**：`stageWalSnapshot` 每次只处理**单个**数据库；`state.db`（`.pd/state.db`）与 `trajectory.db`（`.state/trajectory.db`）两次调用是两个独立线性化点，不构成跨库原子快照。**快照时间偏差不等于跨库写入延迟**——例如 `state.db` 快照完成 1s 后 `trajectory.db` 快照完成，其关联写入可能 10s 后才落盘。脚本必须：① `capturedAt` 取各库快照的 **T1 线性化点**（非拷贝开始时间）；② 分别记录两库 T1 与文件指纹写入报告；③ 区分两层窗口——**快照偏差窗口**（两 T1 之差，建议 ≤5s，超差自动重试一次，仍超差在报告中标注）与**跨库写入允许延迟**（关联写入允许晚于先快照库 T1 的时长，建议 ≤60s）；④ 跨库关联缺失以**现存记录自身时间戳 vs 对方库 T1** 判定（不能依赖不存在的记录自己的时间戳）：记录时间早于对方 T1 且超出写入允许延迟→判定流失；否则标 `skew_window_candidate`（可延迟复查）。若未来需要严格跨库一致性，另行设计共享快照/写入协调机制，不在本期范围。
   - 新增 `scripts/dev/pipeline-funnel-snapshot.mjs`：经 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath` 定位工作区的 `state.db` 与 `trajectory.db`（**不硬编码路径**），调用 `stageWalSnapshot`（自动完成 `main + -wal` 双文件拷贝、副本哈希校验与 `main → wal → main` T1 线性化点复核；若遇并发写入竞争则最多有限重试 3 次，仍不一致则 fail-loud 退出，绝不读取半截快照，也绝不在源工作区创建 `-shm`），在临时目录以 `{ readonly: true, fileMustExist: true }` 打开统计；**`dispose()` 前先关闭全部 SQLite 连接**（Windows 下未关闭连接会导致临时文件占用、清理失败），输出 `docs/reports/PD_PIPELINE_FUNNEL_BASELINE_<YYYYMMDD>.md`。
2. **Phase 4（开关死分支清理与阶段合并评估门）**：保持 `Backlog` 门控；阶段合并必须走 `npm run lab:*`（AGENTS §25A）。
3. **Phase 5（原则有效性只读派生读模型）**：保持 `Backlog` 门控；严格只读聚合，证据不足一律返回 `insufficient_evidence`。

---

## 4. 验证与回归门禁清单

1. **先红证明（AGENTS §0.3）**：Phase 1 PR 必须保留修复 D1、D2、D4 前三层测试红灯的真实运行记录。
2. **CLI 契约测试（AGENTS §10）**：覆盖 `--json` 纯净度（`cli-1`）、`--dry-run` 零写入（`cli-4`）、失败零脏写（`cli-5`）与真实可执行 `nextAction`（`cli-6`）。
3. **PD-Lab 影响评估（AGENTS §25A）**：Phase 0–3、5 为 `NOT_REQUIRED`（不改提示词策略与判定阈值）；Phase 4b 阶段合并为 `REQUIRED`。

---

## 5. Linear 工单拆分映射（同步至 v0.5 口径）

| 工单号 | 层级 | 对应阶段 | 标题 | 归属 Project | 状态 | 前置阻塞 |
|---|---|---|---|---|---|---|
| `PRI-1289` | 父工单 | Phase 0–3 总控 | `[SPEC-PD-PIPELINE-SPINE-001] 核心管道主干收敛与端到端连通性总控` | PD 产品瘦身与架构收敛 | `In Progress`（SPEC 评审中） | 无 |
| `PRI-1290` | 子工单 1 | Phase 0 | `[Pipeline Spine][Phase 0] 生产工作区 WAL 安全快照 30 天全链路漏斗与流失归因基线（只读）` | PD 产品瘦身与架构收敛 | `Todo` | 无（可与 `PRI-1291` 并行） |
| `PRI-1291` | 子工单 2 | Phase 1A + 1B | `[Pipeline Spine][Phase 1] 分层 Canary 探针测试与 D1/D2/D4 三处现存断线止血` | PD 产品瘦身与架构收敛 | `Todo` | 无（可立即启动） |
| `PRI-1292` | 子工单 3 | Phase 2A | `[Pipeline Spine][Phase 2A] resolveWorkspacePipelineHostDeps 8 处收口与诊断 CLI 去重收编` | PD 产品瘦身与架构收敛 | `Todo` | `blockedBy PRI-1291` |
| `PRI-1293` | 子工单 4 | Phase 2B + Phase 3 | `[Pipeline Spine][Phase 2B/3] 内化单步执行收编、构造点守卫与 PeerRunnerKind 父链血缘收紧` | PD 产品瘦身与架构收敛 | `Todo` | `blockedBy PRI-1292` |
| `PRI-1294` | 远期工单 A | Phase 4 | `[Pipeline Spine][Phase 4] 已退役双轨开关死分支清理与阶段合并 PD-Lab 评估门` | PD 产品瘦身与架构收敛 | `Backlog` | `blockedBy PRI-1290, PRI-1289` |
| `PRI-1295` | 远期工单 B | Phase 5 | `[Pipeline Spine][Phase 5] 原则有效性派生读模型（注入 / 遵循偏离证据 / 同锚点 Pain 复发）` | PD 数据管道演进与学习闭环 | `Backlog` | `blockedBy PRI-1290, PRI-1289` |
