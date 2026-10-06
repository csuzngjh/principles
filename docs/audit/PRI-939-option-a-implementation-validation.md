# PRI-939 Option A 实施验证 — Reuse Gate Degradation Visibility

- 日期：2026-10-06
- 分支：`ai/PRI-939-degradation-visibility`（worktree `D:\Code\_worktrees\principles\PRI-939-degradation-visibility`，base = origin/main `020c1d7e`）
- 上游：`docs/audit/PRI-939-phase2-governance-reliability-audit.md` Option A（Owner 已授权实施）
- 性质：最小治理增强。**门行为零变更**（Rule 4 / 挂起语义 / reuseDecision / reuseEvidence / 候选状态机全部未动）。

---

## 1. Files Changed

| 文件 | 变更 |
| --- | --- |
| `packages/host-runtime/src/workspace-telemetry-emitter.ts` | Phase 1：`CRITICAL_EVENT_ALLOWLIST` += `reuse_gate_triggered`、`reuse_evaluation_unavailable`（**刻意不含** `reuse_evaluation_recommended`——recommended 已由 candidateOutcomes/reuseEvidence 持久承载，落盘会形成第二决策日志）；文档注释同步 |
| `packages/principles-core/src/runtime-v2/pain-signal-runtime-factory.ts` | Phase 2：`createBridgeTelemetryEventEmitter` 增加可选 `sink` 参数（缺省=原 storeEmitter 单例，零行为变更）；`PainSignalRuntimeFactoryOptions.telemetrySink?`；`constructBridge` 把 sink 传入 bridge |
| `packages/principles-core/src/runtime-v2/pain-to-principle-service.ts` | Phase 2/3：`PainToPrincipleServiceOptions.telemetrySink?` 透传给两处 `createPainSignalBridge`；输出 `observabilityWarnings` 改为 **bridge 降级注记 + observability 写入警告** 合并 |
| `packages/principles-core/src/runtime-v2/candidate-intake-service.ts` | Phase 3：`ledger_entry` 结果变体增加**既有字段名** `reuseRecommendation?`（仅 auto-shape hook 跑过且放行时填充；gate 内的降级 reason 不再在边界处丢失） |
| `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts` | Phase 3：新窄投影类型 `ReuseEvaluationOutcomeSignal {status, reason?}`；`PainCandidateOutcome.reuseRecommendation?`；`PainSignalBridgeResult.observabilityWarnings?`；intake 循环捕获 hook outcome → outcome 循环投影（unavailable reason 截断 200 字符）+ 收集结构化降级警告 |
| `packages/pd-cli/src/services/workspace-telemetry.ts` | Phase 2：**新增**（19 行）`createWorkspaceTelemetryEmitter(workspaceDir)` —— 构造复用既有 `WorkspaceTelemetryEmitter`（与 consumer-cycle:452 同款装配），persist 失败降级到 stderr 结构化警告（cli-1：stdout JSON 契约不受污染） |
| `packages/pd-cli/src/commands/candidate.ts` | Phase 2：review 路径两处 `storeEmitter.emitTelemetry` → workspace emitter |
| `packages/pd-cli/src/commands/pain-record.ts` | Phase 2：`PainToPrincipleService` 注入 `telemetrySink` |
| `packages/pd-cli/src/commands/pain-retry.ts` | Phase 2/3：dead-letter bridge 与 persistPainDiagnosis 两处 emitter 注入 sink；intakeResults 的 consumed 条目透传 `reuseRecommendation`（窄投影） |
| `packages/pd-cli/src/commands/diagnose.ts` | Phase 2/3：两处直接 emit + persistPainDiagnosis emitter 注入 sink；intakeResults 同上透传 |
| `packages/pd-cli/src/commands/health.ts` | Phase 4：`WorkspaceHealth.reuseEvaluation` 节 —— 只读展示 critical-events.jsonl 中**最近一条** `reuse_evaluation_unavailable`（at/candidateId/reason≤200）；文件缺失/不可读非致命 |

测试新增/修改：

| 文件 | 内容 |
| --- | --- |
| `packages/host-runtime/tests/workspace-telemetry-reuse-events.test.ts` | 新增：T2 sink 层（unavailable/gate_triggered 落盘且 reason 保留、recommended **不入** sink、非 allowlist 事件不落盘） |
| `packages/pd-cli/tests/commands/workspace-telemetry-wiring.test.ts` | 新增：装配守卫（四命令必须构造 workspace emitter；四命令禁现 `storeEmitter.emitTelemetry`；工厂必须 wrap 既有单例；bridge 工厂 sink 注入点存在） |
| `packages/pd-cli/tests/e2e/reuse-evaluation-prod-validation.test.ts` | 追加 PRI-939 Option A 块：T1（recommended 不落 sink）/T2（unavailable 经真实 handler 落盘 + reason 保留）/T4（unavailable 下 `--decide create`/`--decide reuse` 双向可用）/T5（双工作区隔离：各自 sink 只含各自 candidateId） |
| `packages/principles-core/src/runtime-v2/principle-reuse/__tests__/reuse-decision-flow.test.ts` | 追加 PRI-939 Option A 块：unavailable→CREATE 且 result 携带 reason + 账本语义不变（T2/T3）；recommended→create 携带 outcome；flag-off → undefined（T11 不变量）；bridge 层 outcome+observabilityWarnings（reason 截 200） |
| `packages/pd-cli/tests/commands/candidate-intake.test.ts`、`pain-retry.test.ts` | 既有 core mock 收窄为 importOriginal 展开（新 import 链引入 host-runtime 的传递依赖所需；override 语义不变） |

## 2. Architecture Delta

- **零新抽象**：复用既有 `WorkspaceTelemetryEmitter`（PRI-634 A3）、既有 `mapBridgeTelemetryToStoreEvent` 映射、既有结果字段名 `reuseRecommendation`。唯一新文件是 19 行的 CLI 构造工厂（四处调用点的构造复用，非新 emitter 类）。
- **依赖方向不变**：pd-cli 已依赖 host-runtime 与 core；core 侧只新增"可选 sink 注入口"（core 不感知 host-runtime，符合 io-seam/依赖规则；无新增注册 seam——sink 是既有 telemetry 流的宿主注入，不是新 I/O 能力）。
- **数据流不变量**：telemetry 仍是 observation-only（SPEC v0.3.2 §11）；`unavailable` 永不自动 reuse；CREATE 在 Rule 4 下照常。allowlist 仍是封闭集（7 项）。

## 3. Telemetry Flow（实施后）

```
auto 路径（pain record / pain retry / diagnose）
  bridge → mapBridgeTelemetryToStoreEvent → WorkspaceTelemetryEmitter(sink)
      ├─ allowlist 命中（reuse_gate_triggered / reuse_evaluation_unavailable）
      │     → <workspace>/.pd/telemetry/critical-events.jsonl 持久化（新增能力）
      └─ 其余 → 原样转发 storeEmitter 单例（行为不变）

Owner review（pd candidate review）
  reuse_evaluation_recommended/unavailable → workspace emitter
      ├─ unavailable → 落盘（新增）
      └─ recommended → 只转发（刻意不落盘：无第二决策日志）

Owner 输出面（同一时刻）
  candidateOutcomes[i].reuseRecommendation = {status, reason?}（reason≤200，仅 unavailable）
  observabilityWarnings += "semantic reuse evaluation unavailable for candidate <id> (<reason>) — learning proceeded without duplicate protection (Rule 4); nextAction: pd candidate review ..."

pd health（只读摘要）
  health.reuseEvaluation.lastUnavailable ← critical-events.jsonl 尾部扫描
```

## 4. Owner Visibility Before/After

| 场景 | Before | After |
| --- | --- | --- |
| unavailable → CREATE（94e4dd62 场景） | CLI 输出 plain `consumed`，无任何评估痕迹；遥测发射即丢 | `intake.candidates[i].reuseRecommendation = {status:"unavailable", reason:"...404..."}`（pain retry/diagnose）+ `observabilityWarnings[0]`（pain record envelope）+ critical-events.jsonl 持久行 + `pd health` 摘要 |
| 评估正常 → 挂起 | reuse_review_required 可见（遥测丢） | 行为不变 + `reuse_gate_triggered` 持久落盘 |
| 评估正常 → 挂起后 Owner 裁决 | 同上 | 行为不变；无新落盘（recommended 不入 allowlist） |
| flag-off | 零遥测 | 零遥测（hook 不配置 → 无事件，T11 断言保持） |

## 5. Tests（结果见 §7 汇总）

- **T1**（评估成功无降级信号）：e2e recommended → sink 无 reuse_evaluation_* 行；emitter 层 recommended 不入 allowlist。
- **T2**（unavailable：CREATE 照常 + 事件存在 + reason 保留）：core intake 层（ledger_entry + reuseRecommendation.reason 逐字 + 账本语义不变）；e2e 真实 handler 层（critical-events.jsonl 存在、candidateId/reason 命中）；emitter 层（落盘 + 转发不变）。
- **T3**（账本不变量）：unavailable 前后 ledger 条目语义与普通 create 完全一致（core 块第一用例断言 entry text 与条目数）；e2e T3 既有用例（评估失败不写账本）保持绿。
- **T4**（Owner 决策不受影响）：e2e 中 evaluation unavailable（resolver throw）下 `--decide create` → consumed；`--decide reuse` → reuseEvidence +1。
- **T5**（多宿主共享行为）：双工作区隔离用例（两工作区各自 review，各自 sink 只含各自 candidateId——workspace-scoped 归属是多宿主正确性的机制本身）；wiring guard 锁定四命令同一 host-neutral emitter 装配。宿主中立性在 Phase 1 真机（OpenClaw/Codex 双宿主走同一 CLI 面）已验证。
- **装配守卫**：防"退回裸单例"复发（先例：evaluator-gate-wiring-guard）。

## 6. Complexity Audit

```
New durable source of truth: NO（critical-events.jsonl 是既有 sink；telemetry 仍非决策存储）
New persisted schema/state:  NO（jsonl 追加，无 DDL；reuseEvidence/reuseDecision 未动）
New subsystem/service/background process: NO（构造复用既有 emitter）
New public abstraction/interface: NO（可选参数 + 既有字段名；唯一新文件是构造工厂）
New runtime feature flag: NO
New cross-package dependency: NO（pd-cli→host-runtime 依赖已存在）
New host/platform-specific behavior: NO（workspace-scoped，宿主中立）
New external/network capability: NO
```

Complexity Delta = 全 NO。改动面：core 4 文件（全部为可选字段/可选参数/输出投影）+ pd-cli 6 文件（装配与透传）+ host-runtime 1 文件（allowlist 两行）+ 测试 5 文件。

## 7. Verification Results

| 套件 | 结果 |
| --- | --- |
| host-runtime：workspace-telemetry-reuse-events + artificer-l2（6 tests） | ✅ 6/6 |
| host-runtime：全量 | ✅ 全绿 |
| principles-core：reuse-decision-flow（含新 Option A 块，55 tests） | ✅ 55/55 |
| principles-core：bridge/shaper/intake/pain-to-principle 回归（91 tests） | ✅ 91/91 |
| principles-core：全量 | ✅ 全绿 |
| pd-cli：e2e reuse-evaluation-prod-validation（含新块，13 tests）+ wiring guard（7 tests） | ✅ 20/20 |
| pd-cli：pain-record/pain-retry/health/candidate-review/candidate-intake/config-doctor 回归 | ✅ 174/174 |
| eslint（11 个改动源文件） | ✅ 0 problem |
| `npm run verify:merge`（merge gate 全链） | ✅ **PASS，exit 0**（第 3 次运行；第 1 次缺 changeset 被发布意图守卫拦截 → 补 `@principles/core\|host-runtime\|pd-cli` patch 三包声明；第 2 次 pd-cli strict 构建暴露 health.ts `noUncheckedIndexedAccess` → 已修。两处均为门按设计工作） |

## 8. Risks

1. **输出 JSON 增量字段**：`candidateOutcomes[i].reuseRecommendation` / `intake.candidates[i].reuseRecommendation` / bridge 结果 `observabilityWarnings` 合并 —— 均为增量；严格 `toEqual` 断言的既有测试已全部通过。外部脚本若做整对象相等比较会看到新字段（按 cli-1 语义这是 documented result 的一部分，属增量兼容）。
2. **observabilityWarnings 合并顺序**：bridge 降级注记在前、observability 写入警告在后——两者皆为字符串数组，无消费方断言顺序（已核）。
3. **scope 外未接线**：codex-adapter worker（workspace-worker.ts:218）与 openclaw-plugin 的 bridge 调用仍用缺省单例——长进程事件本就可能持久（worker 侧另有 cycle emitter 覆盖 evaluator/artificer），bridge 事件在宿主自动路径仍会丢。**刻意留作 follow-up**（任务 Phase 2 只列四个 CLI）。
4. **allowlist 增长**：+2 事件，频率受 gate/评估失败率自然限制（每 pain 至多一条 gate_triggered、每候选至多一条 unavailable）。

## 9. Rollback

- 行为回退：`createBridgeTelemetryEventEmitter` 不传 sink / CLI 不构造工厂即回到实施前（选项参数皆可缺省）。
- 完整回退：revert 本分支单 commit。无数据迁移、无配置变更、无 flag 变更。

## 10. Merge Gate

`npm run verify:merge` 于本 worktree 三次运行后 **PASS（exit 0）**：发布意图守卫（changeset）、全部 check 守卫、三包构建、六项 typecheck、pipeline-contract、runtime-writers 全绿。分支提交：`d1d76a8d`（实施）→ `c514a0fe`（changeset）→ `43b30062`（health 类型守卫修复）。

## 11. Stop

按任务 Stop Condition：实施与测试完成后停止。未做 retry admission 收紧、未做 Codex ingestion、未做 evidence quality redesign——留给下一轮独立决策。
