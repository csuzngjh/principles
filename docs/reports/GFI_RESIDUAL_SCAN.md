# GFI 残留扫描表（Stage 8）

任务：GFI-COMPLETE-REMOVAL-001。扫描基线 `35d12815bc`（Stage 4 对照基线），分支 HEAD 为本次移除后的树。
匹配口径固定为区分大小写的词边界：`\bGFI\b|\bgfi\b|gfi_|Gfi|currentGfi`（避免 `logFilePath` 这类 camelCase 误报）。

## 1. 分层统计与处置

| 层 | 扫描口径 | 命中 | 处置 |
| --- | --- | --- | --- |
| L1 可执行生产代码 | `packages/**/src/**`，排除 `__tests__` | 40 处 / 12 文件 | 见 §2，全部为迁移器、墓碑或说明性注释；本轮改掉 1 处语义字符串 |
| L2 测试夹具 | `packages/**/tests/**` | 261 处 / 83 文件（修复前 303 / 84） | 保留：这些列/字段是"旧形状仍可被读取"的覆盖面 |
| L3 src 内测试 | `packages/**/src/**/__tests__/**` | 41 处 / 10 文件 | 保留：功能开关墓碑契约、trajectory 迁移、冻结 barrel 面 |
| L4 历史数据兼容读取 | 真实 `.state/trajectory.db` 隔离副本 | 23 表；`tool_calls` 16→14 列 | 保留 `migrateLegacyGfiSchema`（唯一写入方） |
| L5 文档/注释 | `docs/**` | 1257 处 / 67 文件 | 见 §3 分类 |
| L6 用户可见网站文档 | `packages/website/**/*.md` | 48 处 / 8 文件 | 待更新（见 §4 风险） |
| L7 开发脚本/探针 | `scripts/**` | 74 处 / 9 文件 | 保留（历史 schema 形状探针）；1 处提示文本待后续 |

## 2. L1 生产代码逐文件处置（12 文件 / 40 处）

| 文件 | 处数 | 性质 | 处置 |
| --- | --- | --- | --- |
| `packages/host-runtime/src/production-pain-evidence.ts` | 13 | 迁移调用、旧列判定、失败原因前缀 | 保留（P1 修复本体） |
| `packages/principles-core/src/runtime-v2/trajectory-schema.ts` | 9 | `migrateLegacyGfiSchema` 实现 | 保留（唯一 DDL 权威） |
| `packages/principles-core/src/runtime-v2/index.ts` | 1 | 迁移器 barrel 导出 | 保留（Owner 授权 b） |
| `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts` | 3 | `gfi` 开关墓碑 | 保留（防止旧配置复活） |
| `packages/principles-core/src/runtime-v2/feature-flags/feature-flag-lifecycle.ts` | 2 | 墓碑注释 | 保留 |
| `packages/create-principles-disciple/src/mvp-config.ts` | 3 | `MVP_GONE` 墓碑 | 保留 |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | 2 | 移除说明注释 | 保留 |
| `packages/openclaw-plugin/src/hooks/llm.ts` | 2 | 移除说明注释 | 保留 |
| `packages/openclaw-plugin/src/core/session-tracker.ts` | 2 | 移除说明注释 | 保留 |
| `packages/openclaw-plugin/src/commands/pain.ts` | 1 | SPEC §4.5 说明注释 | 保留 |
| `packages/host-runtime/src/governance-signal-admission.ts` | 1 | 关键词库退役说明注释 | 保留 |
| `packages/principles-core/src/runtime-v2/evidence-triage/source-descriptors.ts` | 2 → 1 | 1 条设计说明 + 1 条运行时 `reason` 文案 | 运行时文案改为 `Session health signal. Not sufficient for diagnosis on its own.`；设计说明保留为历史注记 |

结论：生产代码中不存在任何 GFI 打分、阈值、Mental Mode、fatigue、`currentGfi` 的可执行逻辑。

## 3. L5 文档分类

| 类别 | 示例 | 处置 |
| --- | --- | --- |
| 本任务的证据/报告 | `GFI_REGRESSION_LEDGER.md`、`GFI_BEHAVIOR_BASELINE.md`、`GFI_MIGRATION_EVIDENCE.md`、`GFI_COMPLETE_REMOVAL_SPEC.md` | 保留（历史证据，不重写） |
| 现役架构文档仍按现在时描述 GFI | `docs/architecture/COMPONENTS.md`(15)、`OBSERVABILITY_ARCHITECTURE.md`(7)、`feature-flag-governance.md`(9)、`PD_SYSTEM_ARCHITECTURE.md`(9) | 未改：属文档更新，超出本次代码移除；列为后续 |
| 运行手册 | `docs/runbooks/USER_GUIDE.md`(3)、`USER_GUIDE_ZH.md`(3) | 未改：同上，列为后续 |
| 历史审计/工单记录 | `docs/architecture/PRI-*` 系列 | 保留（历史记录） |

## 4. L6 用户可见网站文档（必须点名的缺口）

`packages/website/docs/slash-commands.md` 与 `packages/website/zh/docs/slash-commands.md` 各 19 处，仍在用现在时描述 `/pd-status` 的 GFI/疲劳输出与 `reset` 语义。该内容属于用户可见产品文档，本轮**未改**（只改代码与测试；改文档会引入与本任务无关的内容评审面）。
影响：已移除的能力仍被文档宣传。判断为文档滞后，不是能力存在。列为交付风险与后续项。

## 5. 看起来命中但必须保留

1. `tool_failure` 作为工具执行事实——不是 GFI 分数，仍被 EventLog/证据链消费。
2. EventLog 的 `empathy_rollback` 事件类型——历史事实，`/pd-rollback` 仍读取。
3. `signal_confirmations` 表与 `suggested_type='empathy'` 历史行——迁移只把 `pending` 置为 `abandoned/gfi_removal`，历史已完成行不动。
4. 功能开关 `gfi` 的墓碑——保留是为了让旧 `config` 中的该键不会重新启用任何未知行为。
5. `tool_calls` 的 `gfi_before/gfi_after` 旧列——迁移器的读取对象，迁移后消失。
6. 开发探针与历史 JSON 夹具中的 `gfi_*`——证明历史形状可被真实读取，不是生产路径。
7. **`/pd-rollback` 命令本身**——SPEC 未列入移除范围，仍是 EventLog 回滚路径；若 Owner 认为它属于 GFI 语义，需要单独裁定。
8. `empathy_engine` 配置面（`src/core/config.ts` 默认值与类型，无消费者）——旧配置文件兼容，保留不生效；建议后续清理。

## 6. 本层发现并已修复的陈旧测试（不在原 19 条清单内）

| 文件 | 失败 | 根因 | 处置 |
| --- | --- | --- | --- |
| `packages/openclaw-plugin/tests/core/session-tracker.test.ts` | 6 | 引用 `31a60e1e5` 删除的 `trackFriction/resetFriction/currentGfi/gfiBySource` | 删 5 条（b）；1 条持久化不变量改写为 `trackBlock`（c） |
| `packages/openclaw-plugin/tests/core/config.test.ts` | 3 | 引用 `c7ab619e9` 删除的 `thresholds.pain_trigger`/`scores`/`severity_thresholds` | 改用存活键 `thresholds.cognitive_paralysis_input`（c）；删 1 条重复项（a） |
| `packages/openclaw-plugin/tests/core/rulecode-replay-live-parity.test.ts` | 1 | 规则夹具读 `input.session.currentGfi`（`2bae37491` 删除，SPEC §3.8） | 迁到 `input.evolution.epTier`（c），parity 断言不变 |
| `packages/openclaw-plugin/tests/hooks/receipt-runid-binding.test.ts` | 4 | 引用 `fa86f0943` 删除的 `handleFrictionTracking*` | 迁到存活转发点 `recordToolCallFailure/Success`（`after-tool-call-helpers.ts:239/291`）（c） |
| `packages/openclaw-plugin/tests/hooks/triage-adapter.test.ts` | 2 | `gfi_threshold` / `isGfiTriggered` 已随 `972664050` 退场 | 删 2 条、删 1 条只验证已删 kind 的用例（b） |
| `packages/openclaw-plugin/tests/hooks/raw-observation-adapter.test.ts` | 2 | 同上 | 删 2 条（b） |
| `packages/principles-core/src/runtime-v2/__tests__/evidence-guards.test.ts` | 0（命名陈旧） | 样本串 `gfi_threshold` 已非有效 kind | 换成 `agent_on_owner_request`（b） |
| `packages/principles-core/src/runtime-v2/__tests__/fixtures/runtime-v2-barrel-surface.json` | 1 | 新增 `migrateLegacyGfiSchema` 导出（Owner 授权 b） | 冻结面 1957→1958，仅新增 1 名 |

## 7. 未随本次修复的环境性失败（有证据，不在本 PR 修）

| 现象 | 证据 | 判定 |
| --- | --- | --- |
| `tests/bdd/principle-application-ledger.steps.test.ts` 2 条 EPERM | 失败发生在 `afterEach` 的 `fs.rmSync`；该模块在本分支 diff 为 0 行 | Windows SQLite 句柄未释放导致的清理失败，非能力问题 |
| `rule-context-v2.perf.test.ts` / `gate-rule-host-perf-budget.test.ts` | 单独运行 2/2 通过；全量并行运行时 p95 超预算 | 并行负载导致的时延抖动 |
| `principle-compiler-core.test.ts` 1 条 | 单独运行 1/1 通过 | 并行/顺序性抖动，未复现 |
