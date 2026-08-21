# PRI-554 / PRI-556 / PRI-555 修复报告

- **日期**: 2026-08-21
- **代码基线**: `D:\Code\principles` @ `10432224`（分支 `fix/codex-e2e-onboarding-artificer-retry`，未提交）
- **前置审计**: `docs/audit/pri-554-555-556-verification.md`（三 Bug 均 Confirmed，本次不重查）
- **状态总览**:

| Issue | 状态 | 一句话结论 |
|---|---|---|
| PRI-554 | **Fixed** | auto-consumer 每周期 finally 接线安全 recovery sweep，死租约自动回收 |
| PRI-556 | **Fixed** | Console degraded 信号加 7 天时间窗 + bounded 结构化摘要 |
| PRI-555 | **Migration ready**（等待 Owner 确认） | dry-run 工具完成；生产 plan 已生成：**63/63 全部为 Rule-2 重建提案**，0 re-key；未执行任何数据迁移 |

---

## 1. PRI-554 — 死租约无自动回收（EP-02 生产路径接线缺失）

### Root cause

`DefaultRecoverySweep` 实现与单测齐全，但唯一调用方是手动 CLI（`pd runtime recovery-sweep`）。auto-consumer 的 `finally` 只做 succeeded-transition reconciliation，漏掉 leased-crashed 窗口；`findCandidates` 只扫 pending/retry_wait，过期 `leased` 任务对 consumer 永久不可见。

### 变更（最小修改）

`packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts`：

1. `runConsumerCycle` 的 `finally` 中、reconciliation 之前、`handle.close()` 之前，调用 `safeRunRecoverySweep()`。以 `handle`（而非 `orchestrator`）为门槛——orchestrator 构造抛错时 sweep 仍执行（ERR-024：枚举资源打开与 finally 步骤之间的所有早退路径）。
2. 新增 `safeRunRecoverySweep()` 封装，与 `runReconciliationBudget` 同级：
   - sweep 失败不阻塞周期（下轮再试），结构化留痕 `INTERNALIZATION_CONSUMER_RECOVER_FAILED`（rc-9）；
   - 有实际恢复/逐任务错误时记录 recovered/failed 计数（`INTERNALIZATION_CONSUMER_RECOVERED`）；
   - 不重复发遥测——sweep 自身对每个恢复任务已发 `task_retried`/`task_failed`。

行为随 `internalization_auto_consumer` flag 自然启停，回滚 = PR revert（mvp-q-3）。未改 runtime state machine、未改 recovery sweep 本体。

### 测试（`tests/internalization-auto-consumer-service.test.ts` 新增 3 例，7/7 通过）

1. **Case 1**: 过期租约任务（`lease_expires_at` 在过去）→ 一个 consumer cycle → `status=retry_wait`、`last_error=lease_expired`、`lease_owner=NULL`，且周期自身发出 `INTERNALIZATION_CONSUMER_RECOVERED`（`retry_wait + lease_expired` 唯一标识 sweep 路径——in-process 崩溃兜底写的是 `execution_failed`，EP-09）。
2. **Case 2**: `runRecoverySweep` 抛异常 → 周期正常完成（runner 主工作完成、`INTERNALIZATION_CONSUMER_RECOVER_FAILED` 留痕、后续 reconciliation 仍执行）。
3. **Case 3**: 活跃（未过期）租约 → 不被回收（status/owner/expiry 原样、无 RECOVERED 事件）。

### 风险

低。sweep 幂等、事务化、既有单测齐全；接线点与既有 reconciliation 预算同构。已知相邻缺口（不属本 Bug，审计 §2.2）：diag-kind 的 `retry_wait` 任务因 consumer 不扫描该 kind 仍会滞留，post-MVP 登记项。

---

## 2. PRI-556 — Console 历史失败污染治理状态

### Before

`GovernanceConsoleModel` 对 5 个 internalization kind 全量扫描：任何历史 `failed`/`retry_wait`（终态、无清除路径）永远驱动首页 degraded——修复底层问题后信号永不消零。degraded reason 是 N 条 `kind: error` 的无界拼接（生产 66 条 ≈ 1.7KB）。

### After（`packages/pd-console/src/server/models/GovernanceConsoleModel.ts`）

1. **7 天时间窗**（`DEGRADED_SIGNAL_WINDOW_MS`）：`failed`/`retry_wait` 仅当 `updated_at ≥ now-7d` 时参与首页 degraded 判定。历史记录不删除，详情页照常可查；`hasInternalizationTasks`（驱动 in_progress）仍统计全部任务。malformed `updated_at` 落在窗外（rc-1，与 stagnation 信号的 NaN 处理一致）。
2. **Bounded 结构化摘要**（`task_failed` 与 `task_retry_wait` 两个同源分支同步修，EP-03）：
   - `reason` = `"20 internalization failures require attention: artificer#<短id> (input_invalid); …; +15 more"`——计数 + 最多 5 条 `kind#短taskId (reason)` + 溢出指示；
   - `DegradedSignal.failureSummary`（新增可选字段）= `{ summary, count, details[{kind, taskId(短), reason}] }`，机器可读；前端 validator 会忽略未知字段，纯增量、无破坏。
3. 状态优先级不变：`owner_review_ready` > `degraded` > `in_progress` > `none`。

### UI 行为变化

- 8-14 的 3 条陈旧 `output_invalid` 不再触发 degraded（修复 555 前当前 degraded 即由 63 条 8-20 级联 + 这 3 条构成；时间窗内仍会如实显示）。
- 首页 degraded 横幅文本从无限拼接变为 bounded 摘要；每条失败可归因到 kind + 任务短码。
- 未改前端组件与 i18n（reasonCode 契约不变，超范围）。

### 测试（`tests/models/governance-console-model.test.ts` 新增 5 例，18/18 通过）

1. 8 天前 failed + retry_wait → 不触发 degraded（状态为 in_progress，无 degradedSignals）；
2. 2 天前 failed → 仍触发 degraded，failureSummary.count=1；
3. pending approval + 近期 failed → `owner_review_ready` 优先，degraded signal 并列报告；
4. 20 条近期 failed → reason < 1000 字符、含 `+15 more`、failureSummary.count=20、details≤5、短 id ≤12 字符；
5. 时间窗对 retry_wait 同样生效：旧 failed + 新 retry_wait → 仅 1 条 retry 信号。

### 风险

低，纯展示层聚合。注意：时间窗只影响"首页信号"，任务明细页与数据本身不变。

---

## 3. PRI-555 — Artifact identity drift 迁移（phase 1: dry-run only）

### 交付物

新命令 `pd runtime artifact-repair`（`packages/pd-cli/src/commands/runtime-artifact-repair.ts` + `src/index.ts` 注册）：

- **默认且本阶段唯一模式 = dry-run**：readonly 连接（`bootstrapIfMissing: false`，state.db 缺失即报错，绝不顺手建库，ERR-023）；唯一写入物是 `migration-plan.json`（`--out` 可指定，默认 cwd）。
- `--confirm` **拒绝执行**（exit 1 + 结构化 reason/nextAction）——apply 阶段是 Owner 批准后的独立交付。
- `--dry-run`/`--confirm` 互斥；`--json` 输出恰一个可解析 JSON 对象（cli-1/2/4/5/6 全对齐）。
- 无 mutation 证据：测试对 state.db 做 SHA-256 前后比对比对，字节一致。

### Repair 规则（保守，无 fuzzy matching）

- **Rule 1（remap, high）**: 存在 `principle` artifact，其 source_task_id 与依赖任务 id 的 **normalized role chain + 完整 UUID + trailing channel token 三者全部精确相等**（如 channel 重复次数漂移变体）。唯一命中才提案 re-key；多命中 → needs_human_review；**角色链不等（同链下游阶段的 `artificer-…`/`evaluator-…` key）绝不 re-key**。
- **Rule 2（reconstruct, medium）**: 无任何可匹配 artifact，但依赖任务有 succeeded run 且 `output_payload` 非空 → 提案从 payload 重建 `principle` artifact（`validation_status='pending'`，走正常验证链）。
- 依赖检查覆盖全部 4 个产出角色（dreamer/philosopher/scribe/artificer）；无法确定 → `needs_human_review`，绝不猜测。diagnostic_json 全程按 untrusted 解析（rc-1/3/4/5）。

### 生产 dry-run 结果（2026-08-21，`D:\.openclaw\workspace`，只读）

Plan 文件: `docs/fix/migration-plan.json`

| 项 | 数值 |
|---|---|
| 扫描 failed input_invalid 任务 | 63（philosopher 25 / scribe 16 / artificer 18 / evaluator 4——与审计完全一致） |
| Rule-1 remap | **0** |
| Rule-2 reconstruct | **63** |
| needs_human_review | 0 |

每条提案均指向依赖任务自身的 succeeded run（例：`philosopher-086a9a75-…` ← `run_dreamer-086a9a75-…_3` 的 output_payload）。

### ⚠️ 对审计方案的一处事实修正（Owner 决策前必读）

审计 §6 设想"优先把 2 条旧 key artifact re-key 给当前 scribe id"。对生产数据逐条核验后，该前提**不成立**：

- 6 月数据中 `artificer-scribe-philosopher-dreamer-<uuid>-<chan>×4` 形式的 key 是**当月 artificer 任务自身的合法键**（b6fbadcd 链全套 artifact 均在现行命名下），不是 scribe 产物的"旧命名变体"；
- 那 2 条候选（9e9081a2 的 kind=**rule**、d650b0c7 的 principle）与 8 月 evaluator 的 principle 是**同链下游阶段的产物**。re-key 它们等于把 evaluator/artificer 的输出倒灌进 scribe 槽位（循环喂养）；
- 工具的 role-chain 检查正是为此设计（有回归测试钉死：`downstream-stage artifact … is NOT a Rule-1 match`）。结论：**全部 63 条走 Rule-2 从依赖自身 run payload 重建**，语义上取的是"该 producer 当时的真实输出"，比 re-key 更安全。

因此原定"先人工确认 2 条旧 key 链"的验证切片不再适用；等价替代：**任选 2 条 Rule-2 链**（建议 1 条 artificer-on-scribe + 1 条 philosopher-on-dreamer），apply 后验证依赖解析恢复 → 任务转 succeeded/进入验证链。

### Apply 阶段（未实现，待授权）需做的事

1. 备份 state.db；
2. 按 plan 为 63 个依赖从 run `output_payload` 构造 `pi_artifacts`（`artifact_kind='principle'`, `validation_status='pending'`；content 构造需对照 scribe-runner 的 contentJson 契约）；
3. 将 63 个 failed 任务置回 `pending`（attempt 归零）；
4. 让 auto-consumer 自然重跑，抽验链路到 evaluator。

### 未解决风险

- Rule-2 confidence 为 medium：payload → artifact 的 content 形状在 apply 阶段实现时需逐 runner 对照契约；`validation_status='pending'` 保证下游验证链兜底。
- post-MVP 登记项（本次不做，防 antipattern-prep-next-phase）：artifact `contract_version` 列、resolver fallback、content-addressed key。
- `needs_human_review` 当前为 0 是数据事实，不是工具保证；apply 前重跑一次 dry-run 确认无漂移。

---

## 4. 测试与验证汇总

| 命令 | 结果 |
|---|---|
| `openclaw-plugin: vitest run tests/internalization-auto-consumer-service.test.ts` | 7/7 通过（4 既有 + 3 新增） |
| `pd-console: vitest run`（全量） | 2035 passed / 1 expected fail（套件自设计） |
| `openclaw-plugin: vitest run`（全量） | 全绿（首轮 4 个 perf-budget 本机负载 flake，复跑通过；与改动无关） |
| `pd-cli: vitest run`（全量） | 1514 passed；1 失败 = `console-open.test.ts` 的 `[::1]` IPv6 环回探测，已知本机环境限制（本机 IPv6 禁用、CI Linux 不受影响，测试注释自证） |
| `pd-cli: vitest run runtime-artifact-repair*` | 15/15 通过（11 规则/契约 + 1 下游陷阱回归 + 3 parser） |
| `tsc`（三包） | 通过（期间一次报错为根 lint 构建链的 openclaw-plugin dist 中间态，重建后消失） |
| `npm run lint`（根） | 0 error / 0 warning |
| 生产 dry-run | 63/63 Rule-2，state.db 字节级未变（SHA-256 前后一致，测试内证） |

## 5. Handbook Gate — ERR 对照

- **ERR-024 / EP-02**（组件存在但未接线 / finally 预算早退枚举）: PRI-554 即该 pattern 的修复；sweep 门槛用 `handle` 而非 `orchestrator`，覆盖 orchestrator 构造失败路径。测试断言周期自身发 RECOVERED 事件（接线证明，非仅单测 helper）。
- **ERR-002 / ERR-079 / EP-03**（degradation 不可观测/语义错位）: PRI-556 把"曾经失败=当前降级"改为窗口内可行动失败；sweep 失败留痕；`task_retry_wait` 与 `task_failed` 两个同源分支同步修。
- **ERR-023 / EP-04**（dry-run 打开可写连接）: artifact-repair readonly + `bootstrapIfMissing:false`，并有"不建库"断言。
- **ERR-088 / ERR-025 / EP-09**（非唯一测试信号）: Case 1 用 `lease_expired` + RECOVERED 事件双重唯一标识；无 mutation 用 SHA-256 字节比对；cli-7 parser 测试镜像真实注册。
- **ERR-078 / EP-10**（"pre-existing" 须验证）: 两处失败（plugin perf flake、IPv6 环回）均经复跑/记忆库既有记录核实为与改动无关，非凭印象归类。

## 6. 变更文件清单

**PRI-554**
- `packages/openclaw-plugin/src/service/internalization-auto-consumer-service.ts`（finally 接线 + safeRunRecoverySweep）
- `packages/openclaw-plugin/tests/internalization-auto-consumer-service.test.ts`（+3）

**PRI-556**
- `packages/pd-console/src/server/models/GovernanceConsoleModel.ts`（时间窗 + bounded summary + failureSummary 字段）
- `packages/pd-console/tests/models/governance-console-model.test.ts`（+5）

**PRI-555**
- `packages/pd-cli/src/commands/runtime-artifact-repair.ts`（新增）
- `packages/pd-cli/src/index.ts`（命令注册）
- `packages/pd-cli/tests/commands/runtime-artifact-repair.test.ts`（新增）
- `packages/pd-cli/tests/commands/runtime-artifact-repair-registration.test.ts`（新增，cli-7）
- `docs/fix/migration-plan.json`（生产 dry-run 输出，Owner 审阅用）

**未提交、未建 PR、未动生产 state.db。**

## 7. 等待 Owner 决定

1. 三个修复的合并安排（可拆 3 个 PR：554 / 556 / 555-tool）。
2. PRI-555 apply 授权：确认改用"任选 2 条 Rule-2 链"验证切片（原"2 条旧 key 链"前提已被数据推翻，见 §3 修正）；apply 工具在授权后另行实现（备份 → 重建 → requeue → 抽验）。
