# GFI 彻底移除 — Stage 3 执行方案

基线：`origin/main` @ `35d12815b`
输入：`GFI_REMOVAL_AUDIT_20261104.md`（审计结论）、`GFI_COMPLETE_REMOVAL_SPEC.md`（设计目标）

## 0. 方案原则

1. 先建立非 GFI 行为基线（Stage 4），再动生产代码。
2. 按“底层契约 → 核心模块 → 插件运行时 → 宿主 → 观测面 → installer”的顺序推进，
   每一层完成后立即跑该层测试，避免一次性大爆炸。
3. 迁移与删除同步完成：不保留空列、空函数、兼容默认值、仅测试可用的假实现。
4. 不新增替代评分系统；新增代码仅限审计 §9 的 3 项。
5. 所有新增错误路径保持 `rc-9`（结构化日志 + reason + nextAction），不静默。

## 1. 层 1：核心契约与 schema

| 动作 | 目标 |
| --- | --- |
| 删除 | `packages/principles-core/src/runtime-v2/gfi/**`（含测试） |
| 删除 | `src/prompt-builder/attitude-directive.ts` 及 barrel 导出 |
| 删除 | `rule-host-contracts.ts` 中 `session.currentGfi` |
| 删除 | `types/event-types.ts`：`ToolCallEventData.gfi/gfiBefore/gfiAfter/consecutiveErrors`、`DailyStats.gfi`、`GfiStats/GfiStatsSchema`、`createEmptyDailyStats` 中的 gfi |
| 删除 | `trajectory-types.ts` 中 tool-call 的 GFI 字段 |
| 删除 | `feature-flags/feature-flag-contract.ts` + `feature-flag-lifecycle.ts` 的 `gfi` 条目 |
| 删除 | `evidence-triage` 的 `gfi_threshold` 来源、`isGfiTriggered` 分支、描述文案 |
| 删除 | `control-plane-triage` 的 `gfi_snapshot` 类别与 remediation |
| 删除 | `golden-trace.ts` 的 `currentGfi: 0` |
| 修改 | `operator-health-read-model.ts`：删 GFI 快照/健康判定/`readPersistedSessions`/`PersistedSession`，其余健康检查不动 |
| 修改 | `signal-collector/types.ts`：`KeywordCategory='correction'`、`SignalStrength='STRONG'`、`type='correction'\|null`；输出校验同步 |
| 修改 | `signal-collector` 关键词/LLM 阶段：删 empathy 分支；契约升为 `signal-classification-output-v2`，删除 v1 定义与 prompt 中 empathy 指令 |
| 修改 | `trajectory-schema.ts`：`TRAJECTORY_SCHEMA_VERSION=2`；DDL 删除两列；新增幂等 `migrateLegacyGfiSchema(db)`（drop 列 + 终态化 pending empathy 行 + 记 schema_version） |
| 修改 | `runtime-v2/index.ts`：删 GFI 导出 |
| 更新 | 架构回归 fixture（`fixtures/runtime-v2-barrel-surface.json`）与相关测试 |

验证：`packages/principles-core` 全量 vitest + `tsc -p .`。

## 2. 层 2：OpenClaw 插件运行时

| 动作 | 目标 |
| --- | --- |
| 新增 | `session-tracker.ts` `trackSessionControlActivity(sessionId)`（只更新 `lastActivityAt` 并持久化） |
| 删除 | `SessionState` GFI/日统计字段、`toGfiState`、`trackFriction`、`resetFriction`、`decayGfi`、`getGfiDecayElapsed`、`getDailySummary`、`resetDailyStats`、`listSessions` 的 gfi 克隆；保留 `trackBlock` 的 `blockedAttempts` |
| 修改 | `after-tool-call-helpers.ts`：删除两个 friction 处理；失败/成功路径调用活动函数；`recordToolCall` 去 GFI 字段；trajectory tool_call 去两列 |
| 修改 | `hooks/pain.ts`：删 `trackFriction` 与 `gfiBefore`，改为活动更新；其余 Pain 链路不动 |
| 修改 | `hooks/llm.ts`：删整段 GFI 自动 Pain（含 `painScore` 赋值、`isGfiTriggered`、triage/写入），删除仅为它的 import；保留 LLM 观测/Empathy/任务结果 |
| 修改 | `hooks/prompt.ts`：删手动清零与 heartbeat 衰减；保留 Intent Friction 等 |
| 修改 | `hooks/gate.ts`：删 `session.currentGfi` 与 enrichment |
| 删除 | `core/pain.ts`（`computePainScore` + 无消费者的 `trackPrincipleValue`）与专属测试 |
| 修改 | `core/event-log.ts`：删 `stats.gfi` 聚合与事件字段；载入旧 `daily-stats.json` 时丢弃 `gfi` 键 |
| 修改 | `core/config.ts` + `config/defaults/runtime.ts`：删 `gfi_gate`、`pain_trigger`、`severity_thresholds`、`tool_failure_friction` 与仅被 `computePainScore` 读取的 penalty 键 |
| 修改 | `core/signal-collector-host.ts`：删 empathy/`WEAK`/`routeWeak`/降级 WEAK 分支；pending 继续走原机制 |
| 修改 | `core/trajectory.ts`：INSERT/类型去两列；打开时调用 `migrateLegacyGfiSchema` |
| 修改 | `commands/pain.ts`（`/pd-status`）：删 GFI 条、Mental Mode、健康提示、`reset`；保留 empathy/data/引导 |
| 修改 | `commands/rollback.ts`：删 GFI 回退调用，保留 rollback 事件与独立行为 |
| 修改 | i18n 命令说明、`index.ts` 帮助文案、`gate-block-helper` 注释 |
| 更新 | 所有受影响测试：session-tracker / after-tool-call / pain / llm / prompt / gate / event-log / signal-collector-host / commands |

验证：`packages/openclaw-plugin` 全量 vitest（不只新增用例）。

## 3. 层 3：Host Runtime（Codex / WorkBuddy）

| 动作 | 目标 |
| --- | --- |
| 修改 | `production-pain-evidence.ts`：`REQUIRED_COLUMNS` 去两列、所有 INSERT 去两列、ensure 链调用 `migrateLegacyGfiSchema`，并保证“缺列 → 迁移后再判定” |
| 修改 | `production-rulehost-gate.ts`：删 `RuleInputEnrichment.currentGfi`、默认值、`_getCurrentGfi`、富化装配 |
| 修改 | `governance-signal-admission.ts`：删 `EMPATHY_SEED_OVERLAY`、empathy 类别；输出校验切 v2 |
| 修改 | Stage-2 worker/批量确认若引用 empathy 类型则同步收敛 |
| 更新 | host-runtime 全量测试与三宿主契约测试 |

验证：`packages/host-runtime` 全量 vitest + 真实 DB 迁移往返测试（临时库）。

## 4. 层 4：观测面（CLI / Console）

| 动作 | 目标 |
| --- | --- |
| 删除 | `pd-cli/src/commands/runtime-gfi-snapshot.ts` + 注册 + 测试 |
| 修改 | `runtime-health-snapshot.ts` 删除 GFI 段（JSON 契约保持单一对象） |
| 修改 | `runtime-canary.ts` 删除 `gfi_snapshot` 检查与相关 fixture/断言 |
| 修改 | `runtime-diagnostics-export.ts` 删除 GFI artifact |
| 修改 | `pd-console HealthCheckModel` 删除 `checkGfiHealth`；types 删除 GFI 字段；`enum-labels` 删除 gfi 标签 |
| 更新 | pd-cli / pd-console 全量测试 |

验证：`pd-cli` + `pd-console` vitest；`pd runtime health --json` 单对象可解析。

## 5. 层 5：Installer / 模板

| 动作 | 目标 |
| --- | --- |
| 修改 | `packages/create-principles-disciple/src/mvp-config.ts` 移除 `gfi` quiet flag |
| 检查 | 安装模板中的 `pain_settings.json` / config 模板移除 GFI 键（如存在） |
| 更新 | installer 测试 |

## 6. 迁移设计

`migrateLegacyGfiSchema(db)`（core，导出，幂等）：

1. 若 `tool_calls` 存在且包含 `gfi_before` → `ALTER TABLE tool_calls DROP COLUMN gfi_before`；
   同理 `gfi_after`。
2. `UPDATE signal_confirmations SET status='abandoned', resolved_at=… WHERE status='pending' AND suggested_type='empathy'`。
3. 更新 `schema_version.version = TRAJECTORY_SCHEMA_VERSION`。
4. 每步幂等；失败抛出结构化错误（不吞异常）。

调用点：
- `applyTrajectorySchemaBase`（所有 plugin/core 打开路径）。
- host-runtime `production-pain-evidence` ensure 链（Codex/WorkBuddy 不执行 base 的路径）。

回滚：迁移只删 GFI 两列与终态化 empathy pending；非 GFI 数据不动。回滚 = 恢复上一版运行时
（旧版会重新 CREATE 列；已删除的 GFI 样本不可恢复，但本任务不承诺恢复 GFI 历史）。

## 7. 验收门（与任务书 Stage 6–9 对齐）

1. Stage 6：受影响 5 个包原有测试全跑；Correction Detection 全场景；RuleHost 决策矩阵不缩减；
   EventLog/Health；迁移前后逐行比对（临时库）。
2. Stage 7：独立审查 15 问。
3. Stage 8：全仓残留扫描分类表（历史审计文档保留；无关同名符号保留）。
4. Stage 9：全仓 tsc/lint/build、SQLite 集成、三宿主回归、E2E、Verify Merge Gate、
   Release Build Parity、CI required checks。
5. Stage 10：基于最新 main 的独立分支 PR（不合并）。

## 8. 明确不做

- 不建替代评分系统。
- 不重构 Phase B 架构。
- 不恢复 Phase A 已退役机制。
- 不修改发布面（`runtime-version.json`、发布链）。
- 不重写或删除历史文档/历史审计记录。
- 不触碰 Owner 真实 `.state`/`.pd` 安装目录。
