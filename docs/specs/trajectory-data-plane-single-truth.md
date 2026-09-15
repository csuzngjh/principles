# SPEC — trajectory 数据面单一事实收敛（建表定义正本合一；Profile 化等价守卫）

- Linear：PRI-774（parent：PRI-751「PD 瘦身与架构收敛」伞单）
- 状态：**设计稿 v2 —— 按 Owner 评审意见修订，目标 IMPLEMENTATION READY**；本 SPEC 不实现代码
- 依据：源码核对（origin/main 工作树，撰写基线 `70d824c4` 后、实施时 Step 1 重核）+ PRI-753 既有决策（PR #1627，"保持双库分层"）+ 三视角评审（实施者 / 架构边界 / 数据完整性）+ Owner 修订指令
- **范围声明（置顶）**：本 SPEC **不废除任何数据通路**。trajectory.db 的三条写入通路（插件运行时 / `pd runtime init` / core SDK pain-record）与全部读取通路原样保留。收敛对象只有一个：**建表定义（DDL）文本的份数**——从两份手抄副本收敛为一份正本，两条建表通路改用同一正本，建出的表结构逐列不变。

---

## 0. Owner 已拍板方向（不再重新讨论）

1. **DDL authority 移至 principles-core**：canonical trajectory schema definition 唯一宿主在 core；openclaw-plugin 与 core pain-record 路径**复用**；不再允许 plugin DDL + core 手抄 DDL 并存。
2. **类型定义单一宿主在 core**：trajectory 共享类型迁移至 core；plugin 保留兼容 shim / re-export；core 既有 `trajectory-store` / `evolution-store` 对外 API 不得破坏。
3. **不删除任何现有数据通路**：OpenClaw TrajectoryDatabase、`pd runtime init`、core SDK pain-record、correction sample 读写、production pain evidence、CLI readers、Console readers、historical evolution readers——全部保留。
4. **`memory/evolution.jsonl` 移出本单**：其读者盘点从实施前置降级为 follow-up。实施 PR 不删除、不修改、不迁移、不因它阻塞 DDL 收敛。
5. Connection Before Creation；实施单独开 PR。

---

## 1. Current topology（基线事实，实施时 Step 1 重核）

### 1.1 两份建表定义副本

| | 副本 A：插件侧（当前权威） | 副本 B：core 侧（镜像） |
|---|---|---|
| 文件:函数 | `openclaw-plugin/src/core/trajectory.ts` `applyTrajectorySchema()` | `principles-core/src/runtime-v2/pain-signal-observability.ts` `ensureTrajectorySchema()` |
| 调用方 | `TrajectoryDatabase.initSchema()`（trajectory.ts ~:1708-1722）+ `initTrajectorySchema()`（:473-504，供 `pd runtime init`，runtime-init.ts:265） | 仅 `recordTrajectoryPainEvent()`（pain-signal-observability.ts:413，返回值被丢弃） |
| 表（**15 张**，fresh schema） | schema_version、ingest_checkpoint、sessions、assistant_turns、user_turns、tool_calls、pain_events、gate_blocks、trust_changes、principle_events、task_outcomes、correction_samples、sample_reviews、signal_confirmations、exports_audit | 相同 15 张，逐列一致（当前无 DDL 漂移） |
| 列迁移 / backfill | pain_events 4 列 + turns/tool_calls 增强（:340-384）+ evolution_tasks 6 列条件 backfill（:398-429，`tableExists` 门） | 相同（:287-377） |
| 索引 | 9 + UNIQUE idx_pain_events_canonical_pain_id（partial：`WHERE canonical_pain_id IS NOT NULL`） | 相同 |
| views | `applyTrajectorySchema` 建 3 个（v_error_clusters / v_principle_effectiveness / v_sample_queue，:431-446）；**另有** `TrajectoryDatabase.initSchema → migrateSchema()` 维护 `v_daily_metrics`（:1726-1757，读者 :1766-1768） | 无 views（有意省略） |
| schema_version | 写入并 UPDATE 至 `SCHEMA_VERSION = 1` | 建表但**从不读写**（版本门对其不可见） |
| tables 声明数组 | :175-182（15 项，含 signal_confirmations） | :127-132（**已过时：漏 signal_confirmations**；且为死代码——调用方 :413 丢弃返回值） |

第三 schema 所有者：host-runtime `governance-observation-store.ts`（governance_* 5 表，自带 `governance_observation_schema_version` v3，additive-only）——与两条 canonical 路径共居同一 trajectory.db 文件但不由它们创建；两条 canonical 路径均不触碰 governance 表，等价性守卫不受影响。

### 1.2 Schema Profiles 现状映射（今天的三层真实结构）

| Profile | 组成 | 今天的实现 |
|---|---|---|
| **A — Canonical Base** | 15 表 + 列 + 索引 + 列迁移/backfill | 副本 A 与副本 B 的并集（当前一致） |
| **B — runtime-init** | A + 3 views（v_error_clusters / v_principle_effectiveness / v_sample_queue） | `initTrajectorySchema()` |
| **C — TrajectoryDatabase runtime** | B + `v_daily_metrics`（migrateSchema 维护，读者 `dailyMetrics()`/`exportAnalytics()`） | `TrajectoryDatabase.initSchema()`（applyTrajectorySchema + migrateSchema） |

若实施时 Reality Audit 发现其他 runtime-only view，以当时 main 为准并入 Profile C 清单。

### 1.3 写入方清单（全部保留，零删除）

`TrajectoryDatabase`（插件长连接 + 文件锁）、`recordTrajectoryPainEvent`（core SDK，pain-record 路径）、`reviewCorrectionSample`（core trajectory-store）、production-pain-evidence handler（host-runtime，canonical_pain_id 去重）、governance stores（host-runtime）。另有脚本写入退化形状 DB（telemetry-production-smoke / codex-owner-journey-e2e / codex-r1-installed-gate）——显式 scope out，读者已具备三层降级。

### 1.4 读取方约束（收敛前后逐列不变）

pd-cli quality-scorecard（pain_events 6 列 / evolution_tasks 历史行 / principle_events / gate_blocks）、pd-cli evolution tasks list/show（core evolution-store，sqlite_master 存在门）、core trajectory-store（correction_samples 12 列读写 + sessions upsert + pain_events 写）、pd-console EvidenceChain（pain_events 12 列，三层降级）/ Governance（COUNT + 降级）、pd-cli build-trajectory-evidence（user_turns/assistant_turns/tool_calls）。website/D1 与 trajectory.db 零依赖。trajectory.db 无 `DELETE FROM`/retention sweep（blob 清理为文件级）。

---

## 2. Failure windows（人工同步机制的失效证据，修正版）

| # | 窗口 | 后果 | 证据（已核实） |
|---|---|---|---|
| 1 | **三份硬编码清单漂移**：signal_confirmations 加入时，DDL 本体在同一提交（`5acc62d8`）双侧同步落地——**DDL 未漂移**；漂移的是三份报告清单（plugin tables 数组、pd-cli runtime-init skipped 清单、runtime-init 测试期望），`e6a0d0ff` 修复了其中两份 | 清单与真实 schema 不符，误导 AI 与测试 | `e6a0d0ff` diff；core 侧数组至今仍过时（:127-132） |
| 2 | schema_version 对 core pain-record 路径不可见 | 未来版本升迁时该路径无感知 | B 建表不读写版本值 |
| 3 | 复制类型漂移风险 | core 手抄类型（trajectory-store.ts:20-37、evolution-store.ts:29-50）无机械对账 | "do NOT import from openclaw-plugin" 头注释 |
| 4 | 陈旧指针 | trajectory-store.ts:9 指向不存在的 `trajectory-db.ts` | 全仓零命中 |
| 5 | `v_daily_metrics` 未被任何"单一事实"叙述覆盖 | 插件运行时 DB 实际有 4 个 views，文档与守卫若只看 3 个则认证了不完整 schema | trajectory.ts:1726-1757 |

**根因**：不是"DDL 会漂移"（同 commit 双侧落地的纪律目前有效），而是**同一事实存在 N 份手抄副本（DDL×2 + 清单×3 + 类型×2）**——副本数量就是事故概率。

---

## 3. Canonical 方案

### 3.1 DDL 正本模块（`principles-core/src/runtime-v2/trajectory-schema.ts`）

**职责边界（精确表述）**：

- does：对**调用方传入的 Database handle** 执行 schema 操作（建表/列迁移/backfill/索引/views），导出 schema 常量与 Profile 声明。
- does NOT：resolve 路径、创建目录、打开数据库、关闭数据库、管理连接生命周期、拥有 WAL/pragmas（这些留在既有调用方）。
- 句柄类型经 **`import type Database from 'better-sqlite3'`** 引入（type-only，满足 eslint I/O 限制与 arch guard，不触发 seam 注册义务）。

**公开导出面（public path 固定为 `@principles/core/runtime-v2`；具体命名实施 Agent 可按仓库风格调整）**：

- `applyTrajectorySchemaBase(db, opts)` — 应用 Canonical Base（Profile A）；`opts.views` 控制是否附建 runtime-init views（Profile B 用）。
- `TRAJECTORY_SCHEMA_VERSION` — 常量（数值保持现值 1；不改任何版本语义）。
- `TRAJECTORY_TABLES` — 由正本派生的表清单。消费方：两条建表路径的清单声明、`pd runtime init` 的 dry-run trajectory tables 报告（runtime-init.ts skipped 分支）及其测试期望（runtime-init-empty-workspace 的 EXPECTED_TRAJECTORY_TABLES）——**全部硬编码 trajectory 清单由此消灭**（state.db 清单不在本单范围）。
- Profile 类型/常量（Profile B/C 的 views 清单声明）。

**不选**"把正本塞进 pain-signal-observability.ts"：该模块运行时依赖 fs/path/better-sqlite3 与 bridge/sanitizer，会让插件建表路径耦合 I/O 模块；独立纯文件是更小的接口面。

### 3.2 类型单一宿主（`@principles/core/trajectory-types`）

- 新建 `principles-core/src/trajectory-types.ts`：现 plugin `trajectory-types.ts` 全部类型迁入（已核实 **313 行零 import**——纯声明，可整体搬迁）。
- `principles-core/package.json` `exports` 显式子路径 map **新增 `"./trajectory-types"`**。
- plugin `trajectory-types.ts` 保留为 `export type { ... } from '@principles/core/trajectory-types'` 兼容 shim（现有 4 个插件 importer 与 trajectory.ts re-export 面零改动）。
- 既有 public API 兼容：`@principles/core/trajectory-store` / `evolution-store` 的导入与导出（含 root barrel 的 `CorrectionSampleRecord`、`CorrectionSampleReviewStatus`）继续工作；新增 public barrel/subpath export 兼容回归测试。
- 顺带修正 trajectory-store.ts:9 陈旧指针（指向不存在的 trajectory-db.ts）。

### 3.3 三 sink 角色声明（本 SPEC 只声明，不动行为）

| Sink | 角色 |
|---|---|
| trajectory.db `pain_events` | 唯一 durable canonical（canonical_pain_id UNIQUE 去重）；EvidenceChain/Governance/quality-scorecard 三个读取方已核实读此表 |
| `.state/logs/events_<date>.jsonl` | debug 级事件日志 |
| `memory/evolution.jsonl` | **follow-up（Owner 已裁定移出本单）**：不删除、不修改、不迁移、不阻塞 DDL 收敛 |

---

## 4. Schema Profiles 与等价性守卫

### 4.1 Profiles 定义（规范级，实施以此为准）

- **Profile A — Canonical Base**（唯一 canonical authority）：15 表 + 列 + 索引（含 partial UNIQUE）+ 既有列迁移/backfill 行为 + schema_version 表结构。**不含任何 view**。
- **Profile B — runtime-init**：A + views `{v_error_clusters, v_principle_effectiveness, v_sample_queue}`。
- **Profile C — TrajectoryDatabase runtime**：B + `{v_daily_metrics}`（migrateSchema 维护；实施时 Reality Audit 若发现其他 runtime-only view 一并并入 C 清单）。

### 4.2 测试设计（不做裸 sqlite_master 全量 diff）

- **Test 1（Base equality）**：两个内存空库分别经插件路径与 core 路径应用 Profile A → diff 表名 / `PRAGMA table_info`（含 pk/notnull/类型，覆盖列级 UNIQUE 与 CHECK）/ 索引（名称 + **normalized SQL 全文**，覆盖 partial index WHERE）/ `sqlite_master.sql` 规范化文本。Base 任何差异 = CI FAIL。
- **Test 2（Profile expectations）**：Profile B 库断言 views 集合恰等于 B 清单；Profile C 库断言 views 集合恰等于 B ∪ {v_daily_metrics}（或实施时 Reality Audit 的完整 C 清单）。**有意的 view 差异是契约，不是漂移。**
- diff 排序按 (type, name) 归一化，避免建表顺序造成的假阳性。

### 4.3 Fixtures（三腿）

- **Fixture A — Fresh DB**：两入口从空库应用 → Canonical Base 完全一致。
- **Fixture B — Historical evolution_tasks**：构造缺 6 个 nullable 列（task_kind/priority/retry_count/max_retries/last_error/result_ref）的旧 evolution_tasks → 两路径应用 → backfill 列补齐且**两路径结果一致**、历史行不丢失。
- **Fixture C — Populated DB**：预置 sessions / pain_events（含 canonical_pain_id 唯一行）/ tool_calls / correction_samples 数据 → 两路径应用 → 行数、行值不变，canonical_pain_id 唯一性保持；成本允许时覆盖 signal_confirmations。
- 迁移代码说明：全新空库上 ALTER 均为重复列 no-op——**Fixture B/C 是迁移逻辑唯一的实际执行载体**，不可省略。

### 4.4 Harness 事项

- `applyTrajectorySchema`（trajectory.ts:173）与 `ensureTrajectorySchema`（pain-signal-observability.ts:125）当前均为模块私有 → 实施时导出 canonical applier（§3.1 公开面）供测试驱动，或经共享函数注入测试；两包装函数的接线由 Profile 测试覆盖。
- verify:merge 链不含 principles-core vitest → 等价性/Profile 测试置于 `src/runtime-v2/__tests__/`（`npm test --workspace` 覆盖），blocking 门槛进 verify:merge 由 `check:telemetry-events --strict` 同款模式在 PR-2 之后的独立步骤评估（或直接依赖 CI Test principles-core job——实施 PR 定，倾向后者：测试已在 CI Test job 内常驻）。
- 内存库（`:memory:`）对 `applyTrajectorySchema` 安全（无 pragma/mkdir/文件路径依赖，先例：receipt-runid-emission.test.ts）。

---

## 5. schema_version 契约（本轮最小；不做版本治理重设计）

**PRI-774 只收敛 DDL authority，不重新设计 trajectory schema-version governance。**

- Canonical module 定义并导出 `TRAJECTORY_SCHEMA_VERSION`（数值 = 现值 1），供两个既有 version owner 采用；导出该常量**不改变任何现有运行时版本语义**。
- `TrajectoryDatabase.initSchema`：继续拥有 read current version → migrateSchema() → write/update current version（现状不变；`migrateSchema` 的版本参数现状忽略也维持现状）。
- `initTrajectorySchema`：继续 apply schema → write/update current version（现状不变）。
- **core pain-record ensure 路径：本轮不获得任何 version row 读写权**——继续只应用 Canonical Base schema，不读写 schema_version row，不新增 mismatch policy。future / old / corrupt version 的治理全部**另立工单**（Gate Review v2 P1-A 裁定：若未来要让 core 路径写版本，必须作为 intentional behavior change 单独评审，并删除本 SPEC 的"零语义变化"承诺、补对应兼容测试）。
- Future/old version 的完整迁移兼容策略：如需要，**另立工单**，PRI-774 不承担。

---

## 6. Non-goals（PRI-774 一律不做）

writer consolidation；reader consolidation；database merge；sink removal；`memory/evolution.jsonl` retirement；schema migration framework；state.db / trajectory.db 合并；governance store 合并；telemetry 系统重构；trajectory 语义重设计；新表 / 新列；超出既有迁移行为的数据 backfill；schema-version governance 重设计（future-version 策略另立工单）。

---

## 7. Migration / Implementation Plan

- **Step 1 — Reality Check**：基于最新 main diff 两份 DDL、清点 tables/indexes/views、确认 historical migration 与 package exports；若 main 已漂移：先更新本 SPEC implementation notes，**不改变 Owner 已拍板方向**。
- **Step 2 — Extract Canonical Base**：建 `trajectory-schema.ts`，只提取 tables/columns/indexes/既有 ALTER/backfill 行为；不得加入新 schema。
- **Step 3 — Rewire Existing Entry Points**：plugin `applyTrajectorySchema` 与 core `ensureTrajectorySchema` 改调 canonical module；保留既有 view 行为、连接生命周期、WAL/pragmas、schema version owner；**`pd runtime init` 的 dry-run trajectory tables 清单改消费 `TRAJECTORY_TABLES`（或同一 canonical helper），对应测试期望同源自派生**（关闭 Failure Window #1 的 pd-cli 清单分支；state.db 清单不在本单范围）。
- **Step 4 — Types Convergence**：建 `@principles/core/trajectory-types` subpath + plugin shim；删 core 手抄 type definitions；保持 public API compatibility（含兼容回归测试）。
- **Step 5 — Mechanical Guards**：fresh base parity / historical migration parity（Fixture B）/ populated DB no-data-change（Fixture C）/ view profile tests / public exports snapshot。
- **Step 6 — Full Regression**：至少 principles-core、openclaw-plugin、pd-cli、trajectory round-trip、runtime init、pain record、correction samples、quality scorecard、evolution historical reader、verify:merge。

---

## 8. 实施完成标准（实施 PR 的 Done 条件）

**Schema**：canonical base schema 只有一个 authority；plugin/core 不再存在重复 DDL 文本；tables list 从 canonical definition 派生；deliberate views 差异有 profile contract；**`pd runtime init` dry-run 的 trajectory tables 输出与测试期望同源自 `TRAJECTORY_TABLES`**。

**Compatibility**：existing DB 无业务数据变化；fresh DB schema 不变化；historical evolution DB 仍可读；public import paths（`trajectory-store`/`evolution-store`/root barrel 既有符号）不破坏。

**Behavior**：以下路径行为不变——OpenClaw runtime trajectory、`pd runtime init`、`pd pain record`、correction samples、quality scorecard、trajectory evidence、historical evolution readers。

**Architecture**：不新增第二套 schema abstraction / migration engine / registry / writer / database。

---

## 9. 修订记录

- v1（初版）→ v2（本版，按 Owner 评审指令修订）：
  1. **P1-1 修正**：引入 Schema Profiles A/B/C，等价性测试改为 Test 1（Base equality）+ Test 2（Profile view expectations），消除"views 差异 vs 全量 diff 红屏"的自相矛盾；`v_daily_metrics` 补录（Profile C）。
  2. **P1-2 修正**：schema_version 收缩为最小契约（仅"结构损坏→fail loud"；空表=采用并写入；不做 future-version 策略），版本治理另立工单。
  3. **P1-3 修正**：公开导出契约明确（`@principles/core/runtime-v2` 的 canonical applier/常量/清单 + `@principles/core/trajectory-types` 子路径 + 兼容回归测试）。
  4. **P1-4 修正**：Fixtures A/B/C 三腿（fresh / historical evolution_tasks / populated），迁移逻辑获得实际执行载体。
  5. **事实修正**：16 表 → **15 表**；"零 I/O"改为精确的职责边界表述（不拥有连接/路径/生命周期，只在传入句柄上执行）；删除"逐字节复制"承诺（改为"结构与迁移结果等价"）；§2 窗口 1 叙事修正（DDL 未漂移、漂移的是三份清单；core 清单仍过时）；补 `import type` 约束、pd-cli 第四份清单、plugin 侧注释同步项、`import type Database` 等评审发现。
