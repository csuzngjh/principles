# m8-02 Context: PainSignalBridge E2E + Auto-Intake Enable

**Gathered:** 2026-04-28
**Status:** Ready for planning

---

## Phase Boundary

**What this phase delivers:** 自动化 E2E 测试验证 M8 全链路（pain→TaskStore→DiagnosticianRunner→ledger probation entry），并将 PainSignalBridge 的 `autoIntakeEnabled` 从 `false` 切换为 `true`，使 candidate 自动进入 PrincipleTreeLedger。

**Success endpoint:** PainSignalBridge autoIntake enabled + UAT 5/5 pass + M8 ROADMAP 更新为 SHIPPED

---

## Implementation Decisions

### E2E 验证策略
- **D-01:** 自动化 E2E 测试脚本，测试 workspace 为 `os.tmpdir()` 下的临时目录（`/pd-e2e-m8-<pid>-<timestamp>`），不污染真实 workspace
- **D-02:** 测试 workspace 可重复跑（每次新建临时目录），不清理历史（保留现场供人工复核）
- **D-03:** 通过标准：UAT 5项全部 pass，包括 cold start smoke、legacy path removed、bridge init、runtime summary、full chain

### autoIntakeEnabled 开关
- **D-04:** `autoIntakeEnabled = true` 硬编码在 `pain.ts` 的 `getPainSignalBridge()` 中，不留环境变量或运行时开关
- **D-05:** 链路终点必须是 PrincipleTreeLedger probation entry（HG-1 满足）

### 幂等性
- **D-06:** 同一 painId 触发两次时，用 Upsert（INSERT OR REPLACE）策略 — PainSignalBridge 调用处改用 upsert-then-run，不依赖 createTask 的 INSERT 唯一约束
- **D-07:** Upsert 意味着重新跑 DiagnosticianRunner，适用于调试重跑场景

### UAT 待验项
- **D-08:** UAT 5项全过为通过标准，其中 Test 5（pain→ledger entry 全链路）为核心签收
- **D-09:** Legacy path removed 验证（UAT Test 2）需确认 `.state/diagnostician_tasks.json` 不再生效

---

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### M8 架构（来自 m8-01）
- `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` — PainSignalBridge 实现（当前 autoIntakeEnabled=false 待改为 true）
- `packages/openclaw-plugin/src/hooks/pain.ts` — PainSignalBridge 接线位置（getPainSignalBridge 函数）
- `.planning/phases/m8-01-Pain-Signal-Bridge/m8-01-CONTEXT.md` — M8 管线完整描述、legacy code map 分类决策
- `.planning/phases/m8-01-Pain-Signal-Bridge/m8-01-UAT.md` — UAT 5项具体内容（pending 状态）
- `.planning/phases/m8-01-Pain-Signal-Bridge/m8-01-05-SUMMARY.md` — m8-01-05 E2E plan 的待验项（E2E-01/02/03）

### Runtime v2 核心
- `packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts` — TaskStore.createTask（需改为 upsert）
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner.run()
- `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` — CandidateIntakeService.intake()
- `packages/principles-core/src/runtime-v2/store/sqlite-diagnostician-committer.ts` — SqliteDiagnosticianCommitter

### 测试参考
- `packages/openclaw-plugin/tests/integration/pain-diagnostician-loop.e2e.test.ts` — 已有 E2E 测试结构参考
- `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-e2e.test.ts` — M6 E2E 参考

---

## Existing Code Insights

### Reusable Assets
- `PainSignalBridge` — 已有完整实现，只需改 `autoIntakeEnabled: true`
- `SqliteTaskStore.createTask` — 需改 upsert 逻辑（INSERT OR REPLACE）
- `getPainSignalBridge(wctx)` — 工厂函数，所有 runtime-v2 deps 已注入

### Established Patterns
- PainSignalBridge fire-and-forget 错误处理（catch + SystemLogger）— 不改变
- 诊断 runner lease 生命周期由 DiagnosticianRunner 自己管理 — Bridge 不调用 createRun()

### Integration Points
- `pain.ts emitPainDetectedEvent()` → PainSignalBridge.onPainDetected() → stateManager → runner → committer → intakeService → ledger
- `autoIntakeEnabled: true` 链路在 `pain-signal-bridge.ts:108-111`，if 分支改为启用

---

## Specific Ideas

- E2E 测试脚本创建 `~/.openclaw/test-m8` workspace，初始化空 SQLite，运行 pain 注入，验证 ledger entry 存在
- 同一 painId 两次触发：第一次 upsert 创建 task，第二次 upsert 重置状态重新跑（taskId 不变，attempt_count 重置）
- `.bak` 文件（evolution-worker.ts.bak）已在 m8-01 中删除，无需再处理

---

## Deferred Ideas

None — discussion stayed within phase scope.

---

## Next Step

`/clear` then `/gsd-plan-phase m8-02`

