# PRI-638 — Diagnostician Kill-Switch 语义收敛（调查结论 + 设计）

Baseline SHA: `246ab81be3c3a2ebb7869cc1c52ddb18ce5de880` (2026-09-01T11:38:31Z, Merge PR #1478 / PRI-641)
Worktree: `D:/Code/principles-PRI-638` (branch `pri638-diag-killswitch`)

本文是"先证明，再收敛"的第一阶段产物。所有结论均来自最新 main 的生产代码，
由 `packages/principles-core/src/runtime-v2/__tests__/pri638-diagnostician-capability-characterization.test.ts`
用真实 wiring（computeEffectivePdConfig → createPainSignalBridge → PainSignalBridge → RuntimeStateManager）实测。

---

## 1. 两个 authority 是否仍存在

| 候选 | 是否仍存在 | 生产消费者 |
| --- | --- | --- |
| **A** `features.diagnostician_split_pipeline` | 是 | `pain-signal-runtime-factory.ts:613/618/623`（runner 选择 + split/async 一致性 guard）<br>`pd-cli/src/commands/diagnose.ts:395`<br>`pd-cli/src/commands/pain-retry.ts:528` |
| **B** `internalAgents.agents.diagnostician.enabled` | 是 | `config/pd-config-agent-binding.ts:171` `resolveAgentRuntimeBinding()`<br>→ `pain-signal-runtime-factory.ts:324` `resolveRuntimeConfigFromPdConfig()`<br>→ `pd-cli/src/services/resolve-runtime-from-pd-config.ts:118` |

### A 已经从 implementation selector 漂移成第二个 kill switch

`packages/principles-core/src/runtime-v2/internalization/` 下只剩：

```
diag-rootcause-runner.ts
diag-distiller-runner.ts
diag-router-runner.ts
split-diagnostician-runner.ts
```

**全库不再存在单体 `DiagnosticianRunner` 类。** 因此 `diagnostician_split_pipeline=false`
不再选择任何真实 legacy 实现，而是走到 `pain-signal-runtime-factory.ts:520`
`runner = new DisabledDiagnosticianRunner()` —— 它已经是一个 kill switch，
只是名字还叫 rollout flag。这正是 issue §7 描述的漂移，现已证实。

---

## 2. 实测双开关矩阵

矩阵由表征测试打印（`PRI-638 MATRIX`）。`providerStartRunCalls` 通过 spy
`OpenClawCliRuntimeAdapter.prototype.startRun`（唯一的 provider 入口）计数。

| internalAgents.diagnostician.enabled | diagnostician_split_pipeline | bridge 构造 | Pain/task 落库 | bridge 结果 | errorCategory | task 终态 | attemptCount | provider 调用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| true | true | ok | yes | （正常跑 split pipeline） | — | — | — | >0（未在本套探测，见注 1） |
| true | false | ok | yes | `failed` | `capability_missing` | `pending` | 0 | **0** |
| false | true | **threw** | **no** | — | — | — | — | **0** |
| false | false | **threw** | **no** | — | — | — | — | **0** |

注 1：enabled 分支的 pipeline 单阶段预算是 `timeoutMs/3 = 100s`，整套跑下来 >90s，
不适合进 characterization 套件；其正常路径已由 `diag-chain-e2e.test.ts` /
`golden-path-diagnostician-e2e.test.ts` 覆盖，PRI-638 不改动它。

threw 的原文：

```
[PainSignalRuntimeFactory] Config resolution failed: disabled.
Agent 'diagnostician' is disabled.
nextAction: Enable agent 'diagnostician' in .pd/config.yaml internalAgents.agents.diagnostician.enabled
```

---

## 3. 六个入口的真实 authority

| 入口 | 真实路径 | 当前 authority | disabled 时表现 |
| --- | --- | --- | --- |
| **Automatic Pain** | `openclaw-plugin/src/hooks/pain.ts:103` → `PainToPrincipleService.recordPain` → `createPainSignalBridge` → `onPainDetected` | **B**（绑定解析）优先；B 通过后再由 **A** 选 runner | B=false → `createPainSignalBridge` 抛出 → `recordPain` catch → `status:'failed'`，**task 不创建**；A=false → task 创建，`failed`/`capability_missing` |
| **Manual Pain** (`pd pain record` / `/pd-pain`) | `pd-cli/src/commands/pain-record.ts:90`；`openclaw-plugin/src/commands/pain.ts:340` | 同 automatic（共用 `PainToPrincipleService`） | 同 automatic —— **automatic 与 manual 在 authority 上一致**，但 disabled 语义是"抛异常"，与 A 的"结构化结果"不一致 |
| **`pd diagnose`** | `diagnose.ts`：`resolveRuntimeAdapterFromConfig`（→ B）**先**执行，随后 `diagnose.ts:395` 读 A 选 runner | **B 先、A 后** | B=false → `ConfigResolutionError`，reason=`disabled`，走通用 config-failure 分支 exit 1；A=false → `DisabledDiagnosticianRunner` |
| **`pd pain retry`** | `pain-retry.ts`：`resolveRuntimeFromPdConfig`（→ B）决定 runtimeKind；`:528` 读 A 选 runner | **B 先、A 后** | B=false → runtimeKind 解析失败 → `refuseExit(reason:'missing_runtime')`，**把 Owner 主动关闭误报成"配置缺失"** |
| **Runtime factory** | `createPainSignalBridge` → `resolveRuntimeConfigFromPdConfig` → `resolveAgentRuntimeBinding` | **B** | **hard throw**（`Error`），把 Owner disable 当成 unexpected failure |
| **Recovery** | `codex-adapter/src/worker/workspace-worker.ts:185` `createPainSignalBridge` → `executePendingDiagnosis`；`host-runtime/src/governance-signal-admission.ts:862` async 模式 | **B** | B=false → worker 的整 cycle 变 `mode:'degraded'` / reason `diagnostician_execution_failed`（catchUp + reconcile + downstream 全被丢弃）；admission 返回 `task_submit_failed`。**B=false 时 Pain 根本没有 task，`pd pain retry` 会 `task_not_found`，恢复路径不存在** |

### 关键 divergence

1. **B 是 hard throw，A 是 structured result**。同一个"Diagnostician 不可用"意图，两种表示。
2. **B=false 丢 Pain**：`createPainSignalBridge` 在 `recordPain` 的 try 块第一行抛，
   `onPainDetected`/`submitPainSignal`（唯一写 task 的地方）根本没机会执行 → 违反 §14。
3. **B=false 无恢复路径**：没有 task，`pd pain retry` → `task_not_found`；codex worker 也无从捞取。
4. **`pd pain retry` 误报**：B=false 被报成 `missing_runtime`（"No --runtime specified and no
   .pd/config.yaml runtime binding found"）——Owner 会以为配置坏了，实际是自己关的。
5. **codex worker 整 cycle 降级**：B=false 时 catchUp/reconcile 已完成的工作被 `report` 丢弃。
6. **retry budget**：A=false 时 task 保持 `pending`/`attemptCount=0`，不烧预算；
   B=false 时压根没有 task。两条路径都**不消耗** LLM retry budget（当前无 bug，
   修复方案必须保持这一点）。

---

## 4. Canonical Capability Authority

```
internalAgents.agents.diagnostician.enabled
```

理由（不是拍脑袋）：

* 它是 **PD 其他 internal agent 统一使用的 capability 契约**：`resolveAgentRuntimeBinding()`
  对 `dreamer / philosopher / scribe / artificer / evaluator / rolloutReviewer / diagnostician`
  一视同仁，返回 `{ ok:false, readiness:'disabled', reason, nextAction }`（issue §9）。
* 它落在 PRI-637 收敛后的 canonical `.pd/config.yaml`（issue §22），不新建任何配置源。
* Console 的 Control Center 已经把它作为 agent toggle 暴露（`ControlCenterPage.tsx:386`、
  `pd-console/src/server/routes/config.ts:163` `updateAgentBinding`）——Owner 的心智模型就在这里。
* A（`diagnostician_split_pipeline`）在 Console 里只是一个 feature flag 标签
  （`enum-labels.ts:102` '诊断器分流管线'），不是 Owner 的 capability 开关。

## 5. Implementation Rollout Authority

```
diagnostician_split_pipeline = DEPRECATE / DEFER DELETE
```

* **不删除 flag**（issue §11 observation window 硬约束）。
* **移除它的 kill-switch 责任**：`split=false` 不再产出 `DisabledDiagnosticianRunner`。
  因为已经不存在第二个实现，"选择实现"这个语义本身已经消失。
* 保留 `split && !async_cli` 的 config 一致性 guard 原样不动——它只在 Owner **显式**
  改过这两个 flag 时才触发，且 fail loud 带 nextAction；改动它会动到 observation flag 语义。
* 未来单独做 `DELETE FLAG`（issue §48）。

---

## 6. 统一 disabled 语义（目标）

```
Diagnostician capability is disabled by Owner configuration
(internalAgents.agents.diagnostician.enabled = false)
```

* errorCategory 复用既有 `capability_missing`（`error-categories.ts` 已有，`PDErrorCategory` 一等公民）。
* `FailureCategory` 新增 `capability_disabled`（additive），使 Owner disable 不再被
  `pd pain record` 的 `failureCategory === 'config_missing'` 分支误当成"配置坏了"。
* `PainSignalBridgeResult` / `RunnerResult` 各加一个 optional `nextAction`（additive）。
* 所有入口：Pain 落库、provider 调用 0、task 保持 `pending`/`attemptCount` 不变、
  给出 nextAction、re-enable 后可恢复。

## 7. 复杂度增量目标

```
Capability authorities:          2 → 1
Independent disable checks:      3 (factory throw / CLI flag A / CLI flag A) → 1 resolver
Disabled representations:        3 (throw / DisabledRunner / missing_runtime) → 1 (capability_missing)
New subsystem:                   0
New feature flag:                0
New durable source of truth:     0
New persisted state:             0
```
