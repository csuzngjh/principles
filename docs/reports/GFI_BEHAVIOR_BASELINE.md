# GFI 移除 —— Stage 4 行为基线（基线提交 `35d12815bc`）

> 目的：在改动后的任何一层，都能用同一组可执行观测判断「PD 核心能力是否退化」。
> 基线源码：`git archive 35d12815bc08e509c6e54fd908d0ae22b1395d2a` 解压到
> `.tmp/gfi-removal/baseline-35d12815bc`（与实施 worktree 完全隔离，不新增 worktree）。
> 本文所有数字均为**基线副本实跑输出**，不是预期值。

---

## 0. 基线与隔离方法（照做即可复现）

```powershell
$wt   = 'D:\Code\_worktrees\principles\adhoc-20261104-gfi-complete-removal-9da3dd'
$base = "$wt\.tmp\gfi-removal\baseline-35d12815bc"
New-Item -ItemType Directory -Force $base | Out-Null
git -C $wt archive 35d12815bc | tar -x -C $base
```

在该副本内：

```powershell
npm ci --prefer-offline --no-audit --no-fund        # 实测：added 965 packages in 22s
npm run build --workspace=@principles/core `
              --workspace=@principles/install-layout `
              --workspace=@principles/host-runtime `
              --workspace=principles-disciple        # 实测：4 个 workspace 全部 build 成功
```

**关键隔离动作（必做）**：`git archive` 不含 `.git`，而部分守护测试用
`findRepoRoot(process.cwd())` 向上找 `.git`。不加标记时它会逃出基线副本、读到
**实施 worktree 里已改过的 `src/`**，产生假失败：

```powershell
New-Item -ItemType Directory -Force "$base\.git" | Out-Null
```

实测证据：未加 `.git` 标记时，
`tests/hooks/gate-b-only-runtime-guard.test.ts > Owner-driven paths still reach the TriggerController`
失败（读到了 worktree 里已被 `dcf53fba1` 修改的 `llm.ts`，其中已无
`evaluateTriggerController`）；加标记后同一测试 11/11 通过，且基线源码
`packages/openclaw-plugin/src/hooks/llm.ts:10,323` 确有 `evaluateTriggerController`。
→ 这是**守护脚本泄漏**，不是基线缺陷；后续每层对照都必须先加 `.git` 标记。

---

## 1. 不变量清单（行为 A 在条件 B 下必须产生结果 C）

以下 8 条是本次移除的验收边界。每条都写成「行为—条件—结果」，可直接照做验证。

| ID | 不变量（行为 A / 条件 B / 结果 C） |
| --- | --- |
| I1 | **Owner 手动 Pain 正向路径**。<br>A：Owner 用 `/pd-pain` 或 Pain Tool 手动上报（`sourceKind=owner_reported`）。<br>B：无论是否带 session。<br>C：跳过 triage 与冷却直接准入（`outcome=manual_owner_admitted`），写入 Pain 记录；不带 session 时仍记录，但标注 `context_unbound` 并给出重跑建议。 |
| I2 | **TriggerController 触发与去重**。<br>A：同一来源在冷却窗口内重复产生信号。<br>B：非 Owner 路径、冷却未过期。<br>C：重复信号被去重/拒绝，不产生第二次准入；Owner 路径不受冷却限制。 |
| I3 | **轨迹/观测落库**。<br>A：发生一次工具调用。<br>B：成功或失败均可。<br>C：`tool_calls` 落一行，`session_id/tool_use_id/tool_name/outcome/params_json/created_at` 非空；发生 gate block 时 `gate_blocks` 落一行。 |
| I4 | **RuleCode 安全断路器（`consecutiveErrors` 的另一半语义）**。<br>A：PD 任务 job 连续失败。<br>B：`job.state.consecutiveErrors >= 3` 且错误不是 timeout。<br>C：任务被自动禁用，`meta.autoDisabled=true` 且 `autoDisabledReason="consecutiveErrors=N"`；timeout 错误改为指数退避并清零计数。该状态与 Session 的 GFI 计数完全独立。 |
| I5 | **历史 Pain 记录读取兼容**。<br>A：读取既有 `pain_events` / 链路数据。<br>B：旧库、旧行（含迁移前后）。<br>C：read model、recall、signal-bridge 仍能读出并参与诊断；迁移不得删行、不得改其他列。 |
| I6 | **EventLog 写入与 `gate_blocks` / `tool_calls` 仍然记录**。<br>A：发生 gate block 或工具调用。<br>B：正常/降级路径。<br>C：EventLog 写入对应事件，轨迹行仍可查；`stats.tools/pain/principle/hooks/evolution` 聚合保持不变（基线另有 `stats.gfi`，本次移除对象）。 |
| I7 | **工具失败作为「事实」仍被记录，但不产生自动 Pain**。<br>A：工具失败 / 生命周期致命错误 / RuleHost block / GFI 健康度下降。<br>B：Gate B-only 运行时路径。<br>C：轨迹写入失败事实（`outcome`、`error_type` 等字符串保留），但**不**进入 Pain 准入、不自动生成 Pain/Diagnosis/Receipt。 |
| I8 | **Context 注入与压缩前后的工作记忆处理**。<br>A：原则/反思/工作区上下文注入，以及上下文压缩前后。<br>B：真实 store 或 mock 工作区。<br>C：上下文仍可组装、注入清单与 receipt 仍正确；压缩后工作记忆处理不丢失既有语义。 |

---

## 2. 对照观测方法（可执行，无「人工检查」）

所有命令都在**基线副本**内、对应 package 目录运行；先执行第 0 节的 `.git` 标记。

```powershell
$base = 'D:\Code\_worktrees\principles\adhoc-20261104-gfi-complete-removal-9da3dd\.tmp\gfi-removal\baseline-35d12815bc'
```

| ID | 跑什么（cwd + 命令） | 看什么（断言点 / 日志 / DB 列） | 怎么判失败 |
| --- | --- | --- | --- |
| I1 | `cd packages/openclaw-plugin`；`npx vitest run tests/hooks/pain.test.ts tests/hooks/pain-funnel-ingress.test.ts tests/commands/samples-reject-no-pain.test.ts` | 3 个文件全绿；syslog 出现 `TRIGGER_DECISION {"outcome":"manual_owner_admitted"...}`；无 session 用例出现 `PAIN_INGRESS_DEGRADED` 且 `reason=context_unbound` | 任一用例失败，或手动上报未产生 `manual_owner_admitted`，或出现 Gate A 准入 |
| I2 | `cd packages/principles-core`；`npx vitest run src/runtime-v2/evidence-triage/__tests__/trigger-controller.test.ts`<br>`cd packages/openclaw-plugin`；`npx vitest run tests/hooks/trigger-cooldown-tracker.test.ts tests/internalization-auto-consumer-gate.test.ts` | 冷却窗口内重复信号得到去重/拒绝；Owner 路径 `bypasses triage and cooldown` | 出现重复准入；或 Owner 路径被冷却拦截 |
| I3 | core：`npx vitest run src/runtime-v2/__tests__/trajectory-store.test.ts src/runtime-v2/__tests__/trajectory-schema.test.ts`<br>plugin：`npx vitest run tests/core/trajectory.test.ts tests/core/trajectory-store-round-trip.test.ts tests/hooks/trajectory-collector.test.ts` | 落库/回读断言；`pragma_table_info('tool_calls')` 必含 `session_id,tool_use_id,tool_name,outcome,params_json,created_at`；`gate_blocks` 必含 `session_id,tool_name,file_path,reason,created_at` | 行未落库、必需列缺失、round-trip 读回不一致 |
| I4 | `cd packages/openclaw-plugin`；`npx vitest run tests/core/pd-task-reconciler.test.ts` | `consecutiveErrors>=3 && !timeout` → `autoDisabled` + `autoDisabledReason=consecutiveErrors=N`；timeout → `timeoutSeconds` 翻倍且清零 | 连续失败不自动禁用，或 timeout 未退避，或删除/改名该状态 |
| I5 | `cd packages/principles-core`；`npx vitest run src/runtime-v2/__tests__/pain-chain-read-model.test.ts src/runtime-v2/__tests__/pain-recall-*.test.ts src/runtime-v2/runner/__tests__/pain-signal-bridge-*.test.ts src/runtime-v2/__tests__/pain-signal-bridge-*.test.ts` | 旧行仍被 read model / recall / bridge 读出；迁移前后行数一致 | 任一读取兼容用例失败，或迁移后旧行消失/其他列被改 |
| I6 | plugin：`npx vitest run tests/core/event-log.test.ts tests/hooks/gate-block-trajectory-persistence.test.ts tests/hooks/gate-legacy-contract-compatibility.test.ts`<br>core：`npx vitest run src/runtime-v2/__tests__/append-event-log-line.test.ts` | gate_block 事件与 `gate_blocks` 行同时存在；`gate_blocks` 可按 Focus 页 SQL 查询；EventLog 降级不丢轨迹行 | 事件或轨迹行缺一；`stats.tools/pain/...` 聚合被破坏 |
| I7 | `cd packages/openclaw-plugin`；`npx vitest run tests/hooks/gate-b-only-runtime-guard.test.ts tests/hooks/lifecycle-fatal-intercept-no-pain.test.ts tests/hooks/llm-pain-source-retirement.test.ts` | `after-tool-call-helpers.ts`、`gate-block-helper.ts` 不得引用 `evaluateTriggerController`/`evaluatePainAdmissionForToolCall`/`emitPainDetectedEvent`；失败事实仍在轨迹；Pain/Receipt 计数为 0 | 失败事实丢失，或失败路径产生 Pain |
| I8 | plugin：`npx vitest run tests/core/reflection-context.test.ts tests/core/rule-context-assembler.test.ts tests/core/workspace-context.test.ts tests/core/workspace-context-factory.test.ts tests/core/workspace-context-state-dir.integration.test.ts tests/bdd/pd-context-receipt.steps.test.ts`<br>core：`npx vitest run src/runtime-v2/store/context/resilient-context-assembler.test.ts src/runtime-v2/store/context/sqlite-context-assembler.test.ts src/runtime-v2/config/__tests__/pd-config-context-injection.test.ts` | 注入项/receipt 断言；压缩后 assembly 不丢项 | 任一注入或 receipt 用例失败 |

**补充 DB 探针（I3/I6 的实际值证据，可选但推荐每层都跑）**：

```powershell
cd $base
node probe-baseline-schema.mjs
```

判据：`tool_calls` 必需列齐全、写入行可回读、`gate_blocks` 列齐全。
（基线版本该探针还会打印 `gfi_before/gfi_after`，两列在基线存在、值为 `null`；
移除完成后应打印 **count=0**，即两列消失。）

---

## 3. 基线真实结果快照（实测，非预期）

运行环境：Windows / PowerShell 7，Node `v26.12.1`，npm `11.20.0`，vitest `5.0.0`。
基线副本：`35d12815bc`，自带 `node_modules`（965 packages），已 build
`@principles/core`、`@principles/install-layout`、`@principles/host-runtime`、`principles-disciple`。

| ID | 实际命令（cwd=package） | 文件数 | 用例数 | 结果 |
| --- | --- | --- | --- | --- |
| I1 | plugin: `tests/hooks/pain.test.ts` `tests/hooks/pain-funnel-ingress.test.ts` `tests/commands/samples-reject-no-pain.test.ts` | 3 | 46 | **46 passed / 0 failed** |
| I2 | core: `src/runtime-v2/evidence-triage/__tests__/trigger-controller.test.ts` | 1 | 25 | **25 passed** |
| I2 | plugin: `tests/hooks/trigger-cooldown-tracker.test.ts` `tests/internalization-auto-consumer-gate.test.ts`（实际路径是 `tests/`，不是 `tests/hooks/`） | 2 | 10 | **10 passed** |
| I3 | core: `src/runtime-v2/__tests__/trajectory-store.test.ts` `trajectory-schema.test.ts` | 2 | 17 | **17 passed** |
| I3 | plugin: `tests/core/trajectory.test.ts` `trajectory-store-round-trip.test.ts` `tests/hooks/trajectory-collector.test.ts` | 3 | 77 | **77 passed** |
| I4 | plugin: `tests/core/pd-task-reconciler.test.ts` | 1 | 10 | **10 passed** |
| I5 | core: `pain-chain-read-model` + 4×`pain-recall-*` + 6×`pain-signal-bridge-*` + 2×`runner/__tests__/pain-signal-bridge-*` | 12 | 175 | **175 passed** |
| I6 | plugin: `tests/core/event-log.test.ts` `tests/hooks/gate-block-trajectory-persistence.test.ts` `tests/hooks/gate-legacy-contract-compatibility.test.ts` | 3 | 48 | **48 passed** |
| I6 | core: `src/runtime-v2/__tests__/append-event-log-line.test.ts` | 1 | 2 | **2 passed** |
| I7 | plugin: `tests/hooks/gate-b-only-runtime-guard.test.ts` `tests/hooks/lifecycle-fatal-intercept-no-pain.test.ts` `tests/hooks/llm-pain-source-retirement.test.ts` | 3 | 21 | **21 passed**（加 `.git` 标记后） |
| I8 | plugin: `reflection-context` `rule-context-assembler` `workspace-context{,-factory,-state-dir.integration}` `bdd/pd-context-receipt.steps` | 6 | 60 | **60 passed** |
| I8 | core: `store/context/resilient-context-assembler` `sqlite-context-assembler` `config/__tests__/pd-config-context-injection` | 3 | 80 | **80 passed** |
| **合计** | — | **40** | **571** | **571 passed / 0 failed** |

关键断言的**实际值**（非测试名转述）：

- 手动 Pain syslog 实值：
  `TRIGGER_DECISION {"outcome":"manual_owner_admitted","sourceKind":"owner_reported","reason":"Owner explicit manual pain. Bypasses triage and cooldown.","nextAction":"create_diagnostic_task","painId":"pain_manual_nosess","score":100}`
  无 session 用例：`PAIN_INGRESS_DEGRADED {"painId":"pain_manual_nosess","warnings":["context_unbound: no session bound ..."]}`
- 轨迹 schema 探针实值（基线 `TRAJECTORY_SCHEMA_VERSION=1`）：
  - `tool_calls columns: id,session_id!,tool_name!,outcome!,duration_ms,exit_code,error_type,error_message,gfi_before,gfi_after,params_json!,result_preview,created_at!,project_dir,host_kind,tool_use_id`
  - `gfi columns present: gfi_before,gfi_after (count=2)`
  - `gate_blocks columns: id,session_id,tool_name,file_path,reason,created_at`
  - 插入一行后 `gfi_before=null gfi_after=null`，`tool_calls row count=1`
- 安全断路器实值（`packages/openclaw-plugin/src/core/pd-task-reconciler.ts:295,312,327`）：
  `errors >= 3 && !isTimeout && !autoDisabled` → `autoDisabled=true`、
  `reason="consecutiveErrors=" + errors`；timeout 分支把 `timeoutSeconds` 按 2× 增长（上限 1800）并清零计数。
- EventLog 的 GFI 聚合只在 `stats.gfi`（`packages/openclaw-plugin/src/core/event-log.ts:393-397`）；
  `stats.tools/pain/principle/hooks/evolution` 为独立分支，删除 `stats.gfi` 不触碰它们。

### 本轮 NOT_RUN（明确未跑，不算通过）

| 项 | 原因 |
| --- | --- |
| `npm test --workspace=@principles/openclaw-plugin`（全量） | 本块只需 8 类不变量覆盖；全量约 2200 用例，放入 Stage 6 独立回归统一跑 |
| `npm run verify:merge` | 只读基线副本用途是行为对照，全量合并门禁属 Stage 9 |
| 三宿主真实 E2E / 真实 `.state` 观测 | 硬边界禁止触碰真实 `.state`、`~/.pd`、`~/.openclaw` |
| `pd-console` / `pd-cli` 的构建与测试 | 不承载本 8 类不变量；由 Stage 9 全仓校验覆盖 |

### 观测到的基线测试侧效应（记录，不处理）

`tests/core/workspace-context.test.ts` 会以 mock 工作区路径写
`D:\mock\workspace\.state\pain_settings.json`（基线自身行为，非本次改动）。
按 git-4 不对未知目录做删除。

---

## 4. 每层对照规则

- 后续每层改动后，**用同一组命令、在同一隔离副本重建**（保持 `.git` 标记）。
- 记录：层 → 命令 → 实际数字 → 与基线逐条比较 → 通过/不通过，写入
  `docs/reports/GFI_REGRESSION_LEDGER.md` 与 `.tmp/gfi-removal/HANDOFF.md`。
- **任一不变量不通过即停在该层，禁止叠加下一层改动。**
- 允许的差异只有两类：① 移除对象本身的断言（如 `gfi_before/gfi_after` 列、`stats.gfi`）；
  ② 已记录的既有环境失败。其他任何数字变化都按退化处理。
