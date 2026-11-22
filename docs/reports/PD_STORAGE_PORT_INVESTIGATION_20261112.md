# 存储收口调查报告：从散落的 SQLite 直接访问到 WorkspaceState 端口

- 报告日期：2026-11-12
- 调查对象：`origin/main` = `38ef59848a1b399900589134339c162b8dfe1b66`（PR #2560 之后）
- 调查方式：纯只读。测量全部通过 `git grep <pattern> origin/main` 与 `git archive origin/main` 快照完成，未改动工作树、未建分支、未提交。
- 本地工作副本 HEAD 为 `f15798cf1`（落后 origin/main 34 个提交左右），本文所有行号均指 **origin/main 内容**，不是本地磁盘上那份。

> 阅读顺序建议：第 1 节（数字）→ 第 2 节（聚类表）→ 第 3 节（三处危险）先看，这三节会改变决策；
> 第 4、5 节是实现方案，第 6 节是"不要动"的清单。

---

## 0. 结论摘要

1. **形态不是"散落 70 处"，而是"两套连接体系并存"**：`SqliteConnection`（state.db 的既有封装）已经在 55 个文件里用得很广，
   但另有 46 个文件绕过它，直接 `new Database(...)` 开 better-sqlite3 裸句柄——其中 24 个在 `packages/*/src`。
   收口的主要矛盾不是"没有端口"，而是**端口旁边有条不受管制的侧门**。
2. **两个数据库的边界是清楚的**（`.pd/state.db` 权威状态 / `.state/trajectory.db` 事件流），但**跨库无法共享事务**这件事
   在代码里是手工对账补偿的（`governance-signal-admission.ts:24-25` 自述），这是唯一一个"必须新增能力"而不是"搬家"的点。
3. **最危险的不是脏代码，是两个"失败当成功"的语义**：
   - RuleHost 判定读不到激活表 → `decision: 'allow'`（放行），用户看到"本该拦截的命令执行了"；
   - 控制台读不到 trajectory.db → 计数 0 且不打降级标记，用户看到"今天 0 次拦截、0 条证据"。
   这两个叠在一起会得到一个**界面完全正常、防护实际失效**的现场。
4. 因此端口的第一职责不是"封装 SQL"，而是**把"读不到"从"没有"里拆出来**。第 4.4 节列了现有 9 处具体的混淆点。
5. 建议顺序：只读消费者先行（控制台/CLI/遥测），再收单写者台账，最后才是多写者运行状态与跨库准入。
   迁移过程中**不新建接口抽象层**；直接用 `packages/principles-core/src/runtime/store/` 下已有的 per-aggregate 接口作为端口，
   只补 `WorkspaceState` 组合根与 `StorageResult`/`Fact` 两个类型。

---

## 1. 真实数字与清单（生产口径）

### 1.1 口径定义

**生产代码** = `packages/**`、`scripts/**`、`plugins/**` 下的 `.ts/.tsx/.js/.jsx/.mjs/.cjs`，且排除：

- 路径含 `/tests/`、`/test/`、`/__tests__/`
- 文件名匹配 `*.test.*`、`*.spec.*`
- `.md`、`.json`、`.yml`、`.sql`、`.txt`（文档、配置、DDL 样例文件）

**为什么不这样排除就会虚高**：不加测试过滤时，同一批模式命中 139 处 / 39 文件 / 67 条建表的量级；
测试夹具（`packages/principles-core/src/runtime/store/*.test.ts`、`packages/*/tests/**`）贡献了绝大部分噪音。

### 1.2 复现命令

```bash
# 0) 确认被测提交
git rev-parse origin/main            # 38ef59848a1b399900589134339c162b8dfe1b66

# 1) 取全量命中（含测试与文档，供人工核对）
git grep -n -F "new SqliteConnection(" origin/main
git grep -n -F "CREATE TABLE" origin/main
git grep -n -F "better-sqlite3" origin/main

# 2) 生产口径过滤（示例：new SqliteConnection）
git grep -n -F "new SqliteConnection(" origin/main \
  | grep -Ev '\.(test|spec)\.[tj]sx?:' \
  | grep -Ev '/(tests|test|__tests__)/' \
  | grep -Ev '\.(md|json|ya?ml|sql|txt):'
```

> 说明：`git grep <pattern> <rev>` 的输出带 `origin/main:` 前缀，按 `^origin/main:(path):(line):(text)$` 解析后再做上述过滤。
> 本次统计用同一套解析（Python）跑完三类模式，结果与逐条人工抽查的 12 个样本一致。

### 1.3 实测数字

| 指标 | `packages/*/src`（产品源码） | 全部生产代码（含 `packages/*/scripts`、`scripts/`、`plugins/`） |
|---|---:|---:|
| `new SqliteConnection(` | **69 处 / 44 文件** | **81 处 / 55 文件** |
| `new Database(`（better-sqlite3 裸句柄） | **48 处 / 24 文件** | **102 处 / 46 文件** |
| `import 'better-sqlite3'`（值导入） | 26 文件 | 41 文件 |
| `import type … from 'better-sqlite3'` | 10 文件 | 10 文件 |
| `CREATE TABLE`（语句） | **50 条 / 6 文件** | **73 条 / 16 文件** |
| 会打开连接的文件合计（以上两类并集） | 64 文件 | 94 文件 |
| 只接收句柄/只做类型标注、不自己打开 | 8 文件 | 8 文件 |

补充口径校正：

- `new SqliteConnection(` 的 82 处原始命中里，有 **1 处是 JSDoc 示例**（`sqlite-connection.ts:9`），实际调用 81 处。
- 值导入的"41 文件"是**字面 import** 口径。另有 5 个脚本通过 `loadSqlite()` / `nodeRequire('better-sqlite3')` 这类 helper 取得构造函数
  （如 `scripts/pri743/*.mjs`、`scripts/dev/principle-learning-lab/prr/lib/prr-readonly.mjs`），所以**真正能开出裸句柄的文件是 46 个**。
- `scripts/pri-815/build-sample-manifest.mjs`、`scripts/pri-815/freeze-inputs.mjs` 用的是 Node 内置 `node:sqlite` 的 `DatabaseSync`，
  属于第四种访问通道，只在 dev 脚本里出现，产品代码零使用。

按目录分布：

| 目录 | `new SqliteConnection` | `new Database`（裸句柄） | 打开连接的文件 |
|---|---:|---:|---:|
| `packages/pd-console/src` | 34 处 / 16 文件 | 4 处 / 3 文件 | 17 |
| `packages/pd-console/scripts` | 1 处 / 1 文件 | 1 处 / 1 文件 | 1 |
| `packages/host-runtime/src` | 14 处 / 9 文件 | 12 处 / 7 文件 | 15 |
| `packages/pd-cli/src` | 10 处 / 10 文件 | 6 处 / 5 文件 | 15 |
| `packages/pd-cli/scripts` | 1 处 / 1 文件 | 1 处 / 1 文件 | 2 |
| `packages/openclaw-plugin/src` | 7 处 / 6 文件 | 2 处 / 1 文件 | 7 |
| `packages/principles-core/src` | 4 处 / 3 文件 | 24 处 / 8 文件 | 10 |
| `plugins/` | 1 处 / 1 文件 | 0 | 1 |
| `scripts/` | 10 处 / 8 文件 | 52 处 / 20 文件 | 26 |
| **合计** | **81 处 / 55 文件** | **102 处 / 46 文件** | **94** |

> `principles-core/src` 只有 3 个文件用 `SqliteConnection`，却有 8 个文件直接 `new Database`——它同时是"端口所在地"和"最大旁路来源"，
> 其中 `internalization-integrity-remediation.ts` 一个文件就开了 14 个裸句柄。

`CREATE TABLE` 的 6 个产品源头（其余 10 个文件全在 `scripts/` 与 `plugins/`）：

| 文件 | 条数 | 表域 |
|---|---:|---|
| `packages/principles-core/src/runtime/store/sqlite-connection.ts` | 24 | state.db 全量 + 迁移 |
| `packages/principles-core/src/runtime/trajectory-schema.ts` | 15 | trajectory.db 基线 15 表 |
| `packages/host-runtime/src/governance-observation-store.ts` | 5 | governance_* 子域 |
| `packages/principles-core/src/runtime/store/intervention-evidence-schema.ts` | 3 | 干预证据台账 |
| `packages/host-runtime/src/governance-signal-admission.ts` | 2 | 准入标记 + 限流桶 |
| `packages/openclaw-plugin/src/service/correction-observer-service.ts` | 1 | 修正观测辅助表 |

### 1.4 与旧数字的差异

| 来源 | conn | files | CREATE TABLE | 说明 |
|---|---:|---:|---:|---|
| 旧口径（含测试） | 139 | 39 | 67 | 测试夹具贡献绝大部分 |
| 上一轮"生产口径"（本轮任务书） | 70 | 33 | 54 | — |
| 本轮实测：`packages/*/src` | 69 | 44 | 50 | 见 1.3 |
| 本轮实测：全部生产代码 | 81 | 55 | 73 | 见 1.3 |

逐项解释，不含"应该"：

- **70 处可以复现，但它的文件口径自相矛盾**：
  `pd-console/src` 34 + `pd-console/scripts/e2e-seed.ts` 1 + host-runtime 14 + `pd-cli/src` 10 + openclaw 7 + core 4 = **70**。
  也就是说它**把 console 的脚本算进去了，却把 cli 的脚本排除了**。这是一次性的计数偏差，不是规则。
- **"33 文件"无法用任何自然口径复现**。所有候选：`packages/*/src` = 44 文件、packages 全量 = 46 文件、
  全部生产代码 = 55 文件。33 既不等于其中任何一个，也不等于"其中排除 `*.test.ts` 后的子集"。
  建议后续不再引用 33，改用 44（源码）/ 55（全量）两个口径。
- **"54 条建表"最接近的是 53**（packages 全量：24+15+5+3+2+1+1+`scripts/e2e-seed.ts` 2 = 53），
  或 50（`src` only）。54 应是把某一条注释里的 `CREATE TABLE` 字样算成了语句
  （`trajectory-schema.ts:11` 的文件头注释里有 "CREATE TABLE/INDEX/VIEW statements"，`IntentPageModel.ts:133` 的注释里也有一处）。
- **趋势判断**：旧报告（`PD_ARCHITECTURE_COMPLEXITY_REVIEW_20261110.md`）记录 70 处 / 45 文件，
  现在 packages 全量是 71 处 / 46 文件——**两周净增 1 处 / 1 文件**。
  数量几乎没动，但 `new Database(` 侧门有 46 个文件、其中 24 个在产品源码里，这是旧报告没有单独度量的部分。

---

## 2. 按"同一概念"聚类

判断标准：**这些读写操作的是不是同一份状态**。同一张表算一个概念；同一个 `.db` 文件里的不同表不自动合并（例如 trajectory.db 里的
`governance_*` 来自另一个模块、有独立版本号，就不与事件流合并）。

### 2.0 存储全景

| 位置 | 载体 | 内容 | 现状 |
|---|---|---|---|
| `<ws>/.pd/state.db` | SQLite (WAL) | 权威状态：任务/运行/制品/审批/激活/台账 | `SqliteConnection` 封装 + 大量旁路 |
| `<ws>/.state/trajectory.db` | SQLite (WAL) | 事件流：会话/回合/工具调用/pain/gate + governance_* | plugin `TrajectoryDatabase` 主导，host-runtime/core 直接开 |
| `<ws>/.pd/config.yaml` | YAML | 配置 | 文件型，**不在 SQLite 收口范围** |
| `<ws>/.state/principle_training_state.json` | JSON | 原则树台账 | 文件型 |
| `<ws>/.state/*journal*` | JSON | 自适应投递日志 | 文件型 |
| worktree / lease / build-state | JSON + git admin | 工作区与租约 | 文件型 + git，**明确不做** |

路径权威目前是"三处各自硬编码"：`SqliteConnection` 里 `join(workspaceDir, '.pd', 'state.db')`（`sqlite-connection.ts:71-89`）、
`resolveTrajectoryDbPath` 里 `join(workspaceDir, '.state', 'trajectory.db')`（`trajectory-store.ts:68-70`），
以及 host-runtime/console 里 20+ 处重复的 `path.join(workspaceDir, '.pd', 'state.db')` 字面量。
本轮核对结论：**这些字面量与权威解析结果一致**（未发现路径漂移），所以这不是当前故障源，但它让"换路径"变成 20+ 处改动。

> 统计口径说明：下文的"写者数 / 读者数"是 grep 级近似（按 SQL 关键字 + 表名匹配，含注释与字符串误命中），
> 用途是判断"某个概念有几个 owner"，不是精确调用次数。逐条行号已列出，可复核。

### 2.1 配置

- 载体：`<ws>/.pd/config.yaml`（`loadPdConfig` / `loadPdConfigForPlugin`），**不是 SQLite**。
- 谁读：几乎所有包（host-runtime `pd-config.ts`、plugin `workspace-context.ts`、console `config/pd-config-store.ts`、cli `config-doctor.ts`）。
- 谁写：安装器、console 设置页、cli。
- 结论：**不进 WorkspaceState 端口**（见第 6 节）。端口只从配置里取两个参数：`busy_timeout_ms`、以及"是否允许 bootstrap 建库"。

### 2.2 运行状态（state.db：tasks / runs / artifacts / commits / lease / 死信 / 草稿）

| 表 | 生产写者数 | 写者 | 读者数 |
|---|---:|---|---:|
| `tasks` | 8 | `sqlite-task-store`、`lease-manager`、`recovery-sweep`、`sqlite-approved-rule-revision`、`sqlite-family-reopen`、`internalization-integrity-remediation`、`demo-story-a-runner`、`legacy-import` | 36 |
| `runs` | 5 | `sqlite-run-store`、`lease-manager`、`internalization-integrity-remediation`、`legacy-import`、`session-history-import` | 15 |
| `artifacts` | 1 | `diagnostician-committer` | 13 |
| `commits` | 1 | `diagnostician-committer` | 3 |
| `reconciliation_cursor` | 1 | `reconciliation-cursor-store` | 1 |
| `dead_letter_pains` | 1 | `sqlite-dead-letter-store` | 2 |
| `pending_agent_drafts` | 1 | `pending-agent-draft-store` | 1 |

- 并发/加锁：全部经 `SqliteConnection`（WAL + busy 5000）。`lease-manager` 的租约获取是 **deferred 事务里的 SELECT-then-UPDATE**
  （`lease-manager.ts:129-178`，读状态后 `UPDATE tasks … WHERE task_id = ?`，WHERE 不带状态条件），
  跨进程竞争时第二个写者会拿到 `SQLITE_BUSY_SNAPSHOT`（裸 `SqliteError`，不是 `PDRuntimeError`）。
  它是全仓少见的"把并发写集中在一个事务里"的写法，但**不是 CAS**——端口应改成单条条件 UPDATE。
- 隐患：`tasks` 有 8 个写者，其中 3 个（`lease-manager` / `recovery-sweep` / `sqlite-task-store`）都用 `UPDATE … WHERE status=?` 的 CAS，
  但 `internalization-integrity-remediation` 是**开裸句柄、无 pragma** 的修复路径（14 处 `new Database`），它绕过了 CAS。

### 2.3 轨迹/事件（trajectory.db 基线 15 表）

| 表 | 生产写者数 | 写者 | 读者数 |
|---|---:|---|---:|
| `sessions` | 3 | plugin `trajectory.ts`、`production-pain-evidence`、`pain-signal-observability` | 5 |
| `tool_calls` | 2（另有 3 处 ALTER） | plugin `trajectory.ts`、`production-pain-evidence` | 14 |
| `pain_events` | **4** | plugin `trajectory.ts`、`production-pain-evidence`、`pain-signal-observability`、`governance-signal-admission` | 26 |
| `user_turns` / `assistant_turns` / `gate_blocks` / `trust_changes` / `principle_events` / `task_outcomes` / `exports_audit` / `ingest_checkpoint` | 1 | plugin `trajectory.ts` | 1–7 |
| `correction_samples` / `sample_reviews` | 2 | plugin `trajectory.ts` + core `trajectory-store.ts` | 2–3 |
| `signal_confirmations` | 2 | plugin `trajectory.ts` + core `trajectory-schema.ts` | 2 |

- 建表权威是**单一**的：`trajectory-schema.ts`（15 条 DDL，两套入口 `applyTrajectorySchemaBase` / plugin `applyTrajectorySchema` 共用同一份文本）。
  这一点做得对，应保留。
- 但**表结构变更有三个入口**：`trajectory-schema.ts`（ALTER + 15 表）、`governance-signal-admission.ts:383-405`（对 `tool_calls` 连做 3 次 `ALTER TABLE`）、
  `production-pain-evidence.ts:276`（给 `tool_calls` 建索引）。也就是说 **`tool_calls` 的最终形状由三个模块共同决定**。
- 并发/加锁：各写者自带策略——plugin 走配置 `trajectory.busy_timeout_ms`；`governance-observation-store:396` 与
  `governance-signal-admission:425` 硬编码 5000；`production-pain-evidence:352,469` 硬编码 5000；`workspace-behavior-evidence:115` 设 **100**（读路径）。

### 2.4 台账/审计（state.db：只追加）

| 表 | 写者数 | 写者 | 幂等/唯一约束 |
|---|---:|---|---|
| `principle_applications` | 1 | plugin `principle-application-ledger` | 两条 partial unique index（presence / self_report 去重） |
| `intervention_evidence_records` | 1 | `sqlite-intervention-evidence-store` | 不可变触发器 + 批次幂等 |
| `intent_decisions` | 1 | `sqlite-intent-decision-store` | `(pain_id,intent_doc_hash,owner_action)` partial unique |
| `intent_doc_versions` | 1 | `sqlite-intent-doc-version-store` | — |
| `design_gate_declarations` | 1 | `sqlite-design-gate-store` | `(source_ref,revision)` unique + 不可变触发器 |
| `activation_evidence_snapshots` | 1 | `sqlite-activation-safety-store` | `snapshot_digest` unique + 不可变触发器 |
| `activation_decisions` | **2** | `sqlite-activation-state-store`、`sqlite-activation-safety-store` | `idempotency_key` unique + 不可变触发器 |
| `pain_diagnoses` | 1 | `sqlite-pain-diagnosis-store` | — |

- 这一类的写入纪律是全仓最好的：单写者 + 唯一约束 + 触发器兜底。
- 唯一例外是 `activation_decisions`：**两个 store 类都往同一张不可变表插入**（`sqlite-activation-state-store.ts:306`、
  `sqlite-activation-safety-store.ts:140,163,193,229,253,288,377,401`）。幂等键不同源，靠 DB 唯一约束兜底。

### 2.5 注册表/权威（state.db：读极多、写极少、唯一约束密集）

| 表 | 写者数 | 写者 | 读者数 |
|---|---:|---|---:|
| `pi_artifacts` | 2（+2 脚本） | `sqlite-pi-artifact-store`、`legacy-cleanup`（+`pd-cli/scripts/*`） | **32** |
| `activations` | **3** | `sqlite-activation-state-store`、`sqlite-activation-safety-store`、`legacy-cleanup` | **26** |
| `activation_control_states` | **2** | 同上两个 store | 6 |
| `global_rulecode_pauses` | **2** | `sqlite-activation-safety-store`、`ActivationsConsoleModel` | 5 |
| `approvals` | 2 | `sqlite-approval-store`、`legacy-cleanup` | 16 |
| `principle_candidates` | **3** | `sqlite-candidate-store`、`diagnostician-committer`、`candidate.ts`（CLI） | **30** |

- 这一簇是"同一份状态、两个 owner"最密集的地方：`activations` + `activation_control_states` + `activation_decisions` 三张表
  被 `sqlite-activation-state-store.ts`（生命周期：创建/停用/晋升）与 `sqlite-activation-safety-store.ts`（安全闸：隔离/全局暂停）同时写。
  两者的写法规约还不同：一个用 `INSERT OR IGNORE`（`state-store.ts:107,298`），另一个用 `INSERT` + `version = version + 1`（`safety-store.ts:257,411`）。
- 并发/加锁：`pi_artifacts` 的 `(source_task_id, artifact_kind, revision_epoch)` 唯一索引由 `migrateSchema()` 在**每次非只读打开时**检查并可能重建
  （`sqlite-connection.ts:873-889`）。两个进程同时打开同一个刚升级的 workspace，就会竞争 `DROP INDEX` + `CREATE UNIQUE INDEX`。

### 2.6 治理观测（trajectory.db 内的独立子域：7 张 governance_* 表）

- 写者：`governance-observation-store.ts`（5 张表）与 `governance-signal-admission.ts`（2 张表），**表不相交但版本语义分两套**
  （`governance_observation_schema_version` vs 无版本）。
- 读者：`governance-signal-admission.ts` 会跨模块读 `governance_observations` / `governance_pending_promotion_tails`。
- 唯一真正的"重复建表"在这里：`governance_*` 的 DDL 在 5 个 `scripts/dev/**` 探针里被复制了一遍
  （`codex-owner-journey-e2e.mjs`、`e2e-full-learning.mjs`、`e2e-governance-loop.mjs`、`verify-ptuf-admission-lab.mjs`、`codex-r1-installed-gate.mjs`）。
  产品代码内部没有重复建表，但**探针里的表形状会与产品漂移**（探针不读 `GOVERNANCE_OBSERVATION_SCHEMA_VERSION`）。

### 2.7 工作区 / worktree

- 载体：`.git` 管理信息 + `pd-worktree-mutation.lock` + `pd-dev-build-state.json` + workspace lease JSON（`scripts/dev/lib/*`）。
- 结论：**不是 SQLite，不进端口**。第 6 节给出理由。

### 2.8 其他

- 原则树台账（`principle_training_state.json`）：读 5 处（含 console 两个 model、telemetry）。
- 自适应投递日志：`adaptive-journal-reconciliation.ts` 只读对账。
- 生产烟雾脚本 `scripts/telemetry-production-smoke.mjs` 自己 `CREATE TABLE` 了 `activations` / `principle_applications` / `pain_events`
  ——属于脚本自造夹具，不是重复的产品建表点，但它会让"重复建表"的 grep 结果虚高。

### 2.9 "同一张表在两处以上被建表或读写"的完整清单

| 表 | 重复形态 | 位置 |
|---|---|---|
| `activations` | 2 个 store 都写；1 个 CLI 也写；脚本 e2e-seed / telemetry-smoke 也建 | 见 2.5 |
| `activation_control_states` | 2 个 store 都写，写法规约不同 | `state-store.ts:107,298` / `safety-store.ts:257,411` |
| `activation_decisions` | 2 个 store 都插（不可变表） | 见 2.4 |
| `tool_calls` | 1 处建表 + 3 处 ALTER + 2 处建索引 | `trajectory-schema.ts:184,247` / `governance-signal-admission.ts:386-405` / `production-pain-evidence.ts:276` |
| `pain_events` | 4 个产品写者 + 7 个脚本建表 | 见 2.3 |
| `schema_version` | **同名表存在于两个库**，类型与语义不同 | state.db：`TEXT` + `'000'/'001'/'002'`；trajectory.db：`INTEGER` + `TRAJECTORY_SCHEMA_VERSION=2` |
| `governance_*` | 产品 1 处、脚本 5 处复制 DDL | 见 2.6 |
| `artifacts` / `commits` / `pi_artifacts` | 脚本 `e2e-seed.ts` 直接 INSERT，绕过 store | `packages/pd-console/scripts/e2e-seed.ts` |

---

## 3. 最危险的三处

### 危险 1：RuleCode 判定"读不到规则"时直接放行，且降级信号不在用户视野内

**位置**：`packages/host-runtime/src/production-rulehost-gate.ts:787-796`

```ts
} catch (error: unknown) {
  addWarning(warnings, `activation_read_failed: …, 'inspect state.db schema and integrity');
  try { recordDegradedEnforcement(…) } catch { /* observability only */ }
  return { decision: 'allow', source: event.source, warnings, metadata: { evaluatedLiveRules: 0 } };
}
```

同样的 fail-open 还有 3 条路径：`activation_query_invalid`（:326-327 只加 warning 后继续）、
`artifact_content_size_invalid`（:332-333 直接 `return allow`）、`active_rule_limit_exceeded`（:328-329 直接 `return allow`）。

**具体故障（用户会看到什么）**：

1. 用户的 `state.db` 被上一个崩溃进程留下的 `state.db-wal` 或文件锁占住（Windows 上很常见），或 schema 被旧版本破坏；
2. 这一次工具调用本该被某条已激活的 RuleCode 拦住（比如"禁止直接改 main"），实际**直接执行成功**；
3. 用户看到的是命令正常跑完；PD 的告警只写进 `metadata.warnings`，由宿主 adapter 决定是否展示，
   而 `recordDegradedEnforcement` 写的是 workspace 外的标记文件——**打开控制台也看不出这次放行**；
4. 同一时刻，控制台"今日拦截数"显示 0（见危险 3），用户得到"PD 没拦是因为没有规则命中"的错误解释。

这不是"不优雅"，是防护静默失效。而且它是**故意这么设计的**（注释写明 "degrades enforcement to allow"），
所以修法不能简单改成 deny（会把数据库小故障放大成"所有工具调用被拒"），正确修法是让端口能区分
"确定为 0 条活跃规则" 与 "无法确定"，再让调用方按策略选 fail-open / fail-closed，并在**用户可见面**留下痕迹。

### 危险 2：state.db 与 trajectory.db 不能同事务，靠手工对账补偿

**位置**：`packages/host-runtime/src/governance-signal-admission.ts:21-25`（自述）

> one admitted pain → exactly one pending Diagnostician task …
> one narrow, idempotent reconciliation pass for the cross-store crash gaps (trajectory.db ↔ .pd/state.db cannot share a transaction)

**具体故障**：

1. Codex 一侧检测到用户强纠正（STRONG），`governance_signal_admissions` + `pain_events` 在 trajectory.db 的**一个事务**里提交成功；
2. 紧接着要在 state.db 建一条 pending Diagnostician 任务，进程在这中间被杀（hook 超时、用户 Ctrl-C、机器重启）；
3. 结果：**pain 已计入、诊断任务永远不存在**。控制台的治理队列显示"有候选但未进入评审阶段"（`GovernanceConsoleModel:426-431` 的分支），
   用户等一个永远不会来的诊断结论；或者反过来——重试后任务建了两次，用户看到同一个 pain 有两条诊断链；
4. 补偿手段是 `reconcilePendingAdmissions()` 的一遍扫描 + `reconciliation_cursor`（在 state.db 单库），
   但**没有人保证它会被调用**：它依赖 worker 再次启动且扫描到那条陈旧 admission。

这是唯一必须"新增能力"的点：端口不能假装跨库原子，而要提供**同库事务 + 可重放 outbox**。

### 危险 3：控制台把"读不到"渲染成"没有"

**位置**：`packages/pd-console/src/server/models/GovernanceConsoleModel.ts:441-507`

```ts
let evidenceInProgressCount = 0;
const trajectoryDbPath = path.join(this.workspaceDir, '.state', 'trajectory.db');
if (fs.existsSync(trajectoryDbPath)) { … try { … } catch { push degraded } }
// ← 没有 else：文件不存在 → 计数 0，且不 push degraded
…
let gateBlocksToday = 0;
if (fs.existsSync(trajectoryDbPath)) { … }   // 同样没有 else
```

**具体故障**：

1. 用户第一次在新机器上装 PD，`.state/trajectory.db` 还没被任何 hook 写过；
2. 打开治理页 → "行为证据 0 / 今日拦截 0" → 用户判断"PD 没在保护我"，实际是**没有数据源**；
3. 同一模式在 `EvidenceChainConsoleModel.ts:190`（有 else，做对了）与 `RuleCandidateBindingConsoleModel`（`new Database` 直开）之间不一致，
   所以同一个缺失状态在不同页面得到不同呈现：一页说"未记录"，一页悄悄显示 0。

这一条危险度低于前两条，但它是**用户唯一能看见 PD 的窗口**，所以它决定用户对前两条的认知。

---

## 4. 端口草案（只有签名）

### 4.1 设计约束

1. **不新建抽象层**：`packages/principles-core/src/runtime/store/` 下已有 12 个 per-aggregate 接口
   （`task-store.ts`、`run-store.ts`、`artifact-store.ts`、`candidate-store.ts`、`commit-store.ts`、`history-query.ts`、`design-gate`、`intent`、`pain`、`pain-diagnosis`、`source-trace-locator`、`intervention-evidence`）。
   它们是端口，缺的是**组合根**和一个**统一的失败类型**。
2. **裸句柄只允许出现在 `store/` 内部**。`packages/*/src` 里那 24 个 `new Database` 全部要沉到 `store/` 或 `trajectory-store.ts`。
3. **端口返回值必须能表达第三种状态**：`present` / `absent` / `unknown`。这是本报告第 1 优先级的产出。
4. **跨库原子性不假装存在**。

### 4.2 类型骨架

```ts
export type StorageUnavailableReason =
  | { kind: 'file_missing'; path: string }
  | { kind: 'locked'; path: string; waitedMs: number }
  | { kind: 'schema_missing'; path: string; table: string }
  | { kind: 'corrupt'; path: string; detail: string }
  | { kind: 'io_error'; path: string; detail: string }
  | { kind: 'not_initialized'; path: string };

export type StorageFailure = { ok: false; reason: StorageUnavailableReason; nextAction: string };
export type StorageResult<T> = { ok: true; value: T } | StorageFailure;

/** 三态：缺省 ≠ 空。absent 只能由"源可评估且确实没有"产生。 */
export type Fact<T> = { state: 'present'; value: T } | { state: 'absent' } | { state: 'unknown'; reason: StorageUnavailableReason };

/** 领域结果：失败原因是业务语义（不是存储不可用）。 */
export type DomainResult<T, E extends string> = { ok: true; value: T } | { ok: false; code: E; nextAction?: string };
```

约束（写进接口注释、由 lint 规则守护）：

- `Fact<T>` 的 `unknown` **不允许**被调用方折叠成 `absent`，除非显式写 `.defaultOnUnknown()`。
- `StorageResult` 的 `value` 里**不允许**再出现 `null` 表示"读不到"；`null` 只表示"该实体确定不存在"。

### 4.3 组合根

```ts
export interface WorkspaceState {
  readonly scope: WorkspaceScopeId;         // 唯一标识一个 workspace
  readonly paths: { stateDb: string; trajectoryDb: string };
  /** 只读会话：不建目录、不建库、不跑迁移。 */
  readState<T>(fn: (db: StateDbHandle) => T): StorageResult<T>;
  /** 写会话：单事务，default IMMEDIATE。 */
  writeState<T>(fn: (db: StateDbHandle) => T): StorageResult<T>;
  readTrajectory<T>(fn: (db: TrajectoryDbHandle) => T): StorageResult<T>;
  writeTrajectory<T>(fn: (db: TrajectoryDbHandle) => T): StorageResult<T>;
  /** 显式维护窗口：只给 runtime init / repair / retention 用。 */
  maintainState<T>(policy: MaintenancePolicy, fn: (db: StateDbHandle) => T): StorageResult<T>;
  maintainTrajectory<T>(policy: MaintenancePolicy, fn: (db: TrajectoryDbHandle) => T): StorageResult<T>;
  health(): WorkspaceStorageHealth;         // 复用 SqlitePragmaReport + 三张表的 schema 版本
  close(): Promise<void>;
}

export function openWorkspaceState(input: {
  workspaceDir: string;
  profile: 'hook' | 'cli' | 'console' | 'worker' | 'install';
  busyTimeoutMs?: number;   // 默认 5000；hook 写路径允许 0（要求调用方处理 locked）
  allowBootstrap?: boolean; // 默认 false。只有 init/install 为 true
}): Promise<StorageResult<WorkspaceState>>;
```

`profile` 是这次收口要补的关键参数：它把现在散在各处的"我要不要等锁、要不要建库"变成一个显式选择，
而不是靠每个调用点自己传 `readonly` / `bootstrapIfMissing` / `busyTimeoutMs` 三个布尔。

### 4.4 各概念的方法（只签名）

**运行状态（扩展现有 `TaskStore` / `RunStore`）**

```ts
interface RuntimeStatePort {
  getTask(taskId: TaskId): Promise<Fact<TaskRecord>>;
  listTasks(q: TaskQuery): Promise<StorageResult<{ items: TaskRecord[]; truncated: boolean }>>;
  /** 原子：CAS lease；必须返回失败原因而不是 null。 */
  claimTask(req: ClaimRequest): Promise<DomainResult<TaskRecord, 'not_found' | 'lease_held' | 'not_claimable' | 'storage_unavailable'>>;
  /** 原子：status + attempt_count 的 CAS。 */
  transitionTask(req: TransitionRequest): Promise<DomainResult<TaskRecord, 'stale_transition' | 'not_found' | 'storage_unavailable'>>;
  appendRun(run: RunRecord): Promise<StorageResult<RunRecord>>;
  finishRun(req: FinishRunRequest): Promise<DomainResult<RunRecord, 'stale_run' | 'not_found' | 'storage_unavailable'>>;
}
```

必须原子：`claimTask`、`transitionTask`。现状是 `lease-manager` 用 deferred 事务 + 无状态条件的 UPDATE（`lease-manager.ts:165-169`），
端口要把它变成 `UPDATE … WHERE task_id=? AND status IN ('pending','retry_wait')` 并在 `changes===0` 时返回 `not_claimable`，
把 SQLITE_BUSY 从"裸错误"变成 `storage_unavailable`。
必须事务边界：`appendRun + task.updated_at` 同步更新。

**轨迹/事件（新增 `TrajectoryPort`，替掉 4 个 pain 写者与 2 个 tool_calls 写者）**

```ts
interface TrajectoryPort {
  appendSession(s: SessionUpsert): Promise<StorageResult<void>>;
  appendTurn(t: TurnRecord): Promise<StorageResult<void>>;
  appendToolCall(t: ToolCallRecord): Promise<StorageResult<void>>;
  /** 依赖 unique(canonical_pain_id)：重复投递必须回 duplicate 而不是抛唯一约束错误。 */
  appendPainEvent(p: PainEventRecord): Promise<DomainResult<{ canonicalPainId: string }, 'duplicate' | 'storage_unavailable'>>;
  appendGateBlock(b: GateBlockRecord): Promise<StorageResult<void>>;
  appendPrincipleEvent(e: PrincipleEventRecord): Promise<StorageResult<void>>;

  listRecentPainEvents(q: PainQuery): Promise<Fact<PainEventRow[]>>;
  countPainEvents(q: PainCountQuery): Promise<Fact<number>>;          // 替换 GovernanceConsoleModel 的裸 COUNT
  countGateBlocksSince(iso: string): Promise<Fact<number>>;
  listRecentToolCalls(q: ToolCallQuery): Promise<Fact<ToolCallRow[]>>;
}
```

必须原子：`appendPainEvent`（唯一索引 + 插入同一语句）；`appendToolCall` 与 `sessions` 的 upsert 同批。
必须能给出失败原因：`countPainEvents` / `countGateBlocksSince` 是危险 3 的直接修复点——文件缺失必须返回 `unknown`。

**台账/审计（沿用现有 store，补 `Fact`）**

```ts
interface ReceiptLedgerPort {
  appendReceipt(r: PrincipleApplicationInput): Promise<DomainResult<{ id: number; deduped: boolean }, 'deduped' | 'storage_unavailable'>>;
  listReceipts(q: ReceiptQuery): Promise<Fact<ReceiptRow[]>>;
  sumByLevel(q: ReceiptQuery): Promise<Fact<{ presence: number; effect: number }>>;
}

interface EvidenceLedgerPort {
  appendBatch(batch: InterventionEvidenceBatch): Promise<DomainResult<AppendResult, EvidenceRejectionCode | 'storage_unavailable'>>;
  readScope(): Promise<Fact<EvidenceScope>>;
  getOccurrence(ref: ActivationOccurrenceRef): Promise<Fact<InterventionEvidenceRow>>;
}
```

必须事务边界：`appendBatch` 整批一个事务（现在是，别改）。
必须给原因：`readScope` 现在用 `null` 表示"没有 scope"，要拆成 `absent`（未初始化）/ `unknown`（读失败）。

**注册表/权威（合流 `activations` 的两个 owner）**

```ts
interface ArtifactRegistryPort {
  get(artifactId: ArtifactId): Promise<Fact<PIArtifactRecord>>;
  listActive(channel?: RuleChannel): Promise<Fact<PIArtifactRecord[]>>;
  /** 原子：revision_epoch 计算 + 插入同事务；冲突返回 code，不抛唯一约束。 */
  publishRevision(req: PublishRequest): Promise<DomainResult<{ artifactId: ArtifactId; revisionEpoch: number }, 'revision_conflict' | 'storage_unavailable'>>;
}

interface ActivationRegistryPort {
  /** 读失败必须 unknown；危险 1 的 fail-open 判断依赖它。 */
  listActiveForEnforcement(channel: 'code_tool_hook'): Promise<Fact<EnforcementActivation[]>>;
  activate(req: ActivateRequest): Promise<DomainResult<ActivationRecord, 'already_active' | 'artifact_missing' | 'storage_unavailable'>>;
  deactivate(req: DeactivateRequest): Promise<DomainResult<ActivationRecord, 'not_active' | 'storage_unavailable'>>;
  controlState(activationId: ActivationId): Promise<Fact<ActivationControlState>>;
  /** 原子：version CAS；两个 owner 必须走同一入口。 */
  applyControlState(req: ControlStateRequest): Promise<DomainResult<ActivationControlState, 'version_conflict' | 'storage_unavailable'>>;
}
```

必须原子：`publishRevision`、`applyControlState`、`activate`（activation 行 + control state 行必须同一事务——
现在正是"两处各写一半"的地方）。

**治理观测 / 跨库准入**

```ts
interface GovernanceObservationPort {
  ingestBatch(rows: GovernanceObservationInput[]): Promise<DomainResult<IngestResult, 'storage_unavailable'>>;
  readPromotionContext(ref: RolloutRef): Promise<Fact<PromotionContext>>;
  admit(signal: SignalInput): Promise<DomainResult<AdmissionOutcome, 'rate_limited' | 'duplicate' | 'storage_unavailable'>>;
  reconcilePendingAdmissions(): Promise<StorageResult<ReconcileReport>>;
}

/** 唯一允许跨库的表达方式：同库事务 + 可重放意图。 */
interface CrossStoreUnitOfWork {
  /** 与业务写入同一个事务提交；失败则整体回滚。 */
  enqueue(intent: OutboxIntent): Promise<StorageResult<OutboxId>>;
  /** 幂等重放；返回每条意图的终态。 */
  drain(limit: number): Promise<StorageResult<Array<{ id: OutboxId; state: 'done' | 'pending' | 'failed'; reason?: string }>>>;
}
```

### 4.5 现有代码里哪些"空结果"其实代表失败（端口必须区分）

| # | 位置 | 现在返回 | 真实含义 | 端口应返回 |
|---|---|---|---|---|
| 1 | `production-rulehost-gate.ts:787-796` | `decision:'allow'` | 无法读取活跃规则 | `Fact<EnforcementActivation[]>.unknown` → 调用方按 profile 决定 fail-open/closed |
| 2 | `production-rulehost-gate.ts:326-329` | `allow` + warning | 查询结果形状非法 / 规则数超限 | 同上，`unknown` |
| 3 | `GovernanceConsoleModel.ts:441-477` | `evidenceInProgressCount = 0` | trajectory.db 不存在或 COUNT 失败 | `unknown` + 页面显示"数据源不可用" |
| 4 | `GovernanceConsoleModel.ts:481-507` | `gateBlocksToday = 0` | 同上 | `unknown` |
| 5 | `sqlite-connection.ts:239-244` | `'000'` | 表不存在 / 库未初始化 / 真的 000 | `Fact<SchemaVersion>`：`absent` vs `unknown` |
| 6 | `active-principle-prompt.ts:209-215` | `principles: []` + warning | 读失败（锁/损坏），不是"没有激活" | `Fact<ActivatedPrinciple[]>`，让上层能区分"本轮不注入"与"没原则" |
| 7 | `intervention-evidence-ingress.ts:141-145` | `null` | 读失败 | `Fact<…>` 的 `unknown` |
| 8 | `workspace-behavior-evidence.ts:113-115` | 抛错（busy 100ms） | 可用但易失败 | 保留抛出，但把 `locked` 与 `file_missing` 分开 |
| 9 | `trajectory-schema.ts` / `sqlite-connection.ts` 的 `schemaInitWarnings` | 警告数组 | schema 未建成 | 端口 `health()` 必须让它变成可判定的失败 |

**已经是正确范本、应收编为通用能力的 4 处**：

- `milestone-readers.ts:16-48`：三态（true / false / null）+ "unreadable 不能编造成 false"——正是 `Fact<T>` 的语义。
- `trajectory-store.ts:79-109`：`TrajectoryDbUnavailableError` 带 path 与 reason，明确"missing database is NOT empty database"。
- `prompt-injection-status.ts:141-147`：`globalReason: 'activation_db_not_found: …; nextAction=…'`。
- `EvidenceChainConsoleModel.ts:234-237`：缺库时 push `degradedReasons`。

> 这 4 处证明团队已经有正确心智，只是**没有把它变成类型**。端口的第一价值就是把 `Fact<T>` 固化下来，
> 否则每新增一个读点就重新做一次"要不要打降级"的选择。

---

## 5. 分批迁移顺序

原则：先只读后写、先低风险后高风险；每批都能单独撤回（不依赖上一批的接口形态）。

### 批次 0（前置，无代码）：路径与连接参数单点化

- 内容：把 `state.db` / `trajectory.db` 的路径字面量全部换成一个已有函数（console 的 20+ 处 `path.join(..., '.pd', 'state.db')`）。
  **不改连接用法，只改路径来源。**
- 涉及文件：`packages/pd-console/src/server/models/*.ts`（6 处）、`packages/host-runtime/src/{active-principle-prompt,prompt-activation-deliverability,prompt-injection-status,production-rulehost-gate,workspace-behavior-evidence}.ts`、`packages/principles-core/src/storage-paths.ts`（新增导出）。
- 验收判据（机械可验）：
  `git grep -n "'.pd', 'state.db'" origin/main -- packages | wc -l` 结果为 0；
  `npm run typecheck --workspace=@principles/core` 与 `--workspace=@principles/pd-console` 通过。
- 撤回：单 commit revert，无行为变化（纯常量替换）。

### 批次 1（只读消费者）：控制台 + CLI 读路径

- 内容：把只读打开换成 `openWorkspaceState({profile:'console'})` + `Fact<T>`；先修危险 3 的两处 `if (existsSync)` 缺 else。
- 涉及文件（17 个 console 文件中以只读为主的那些，以及 5 个 CLI 读命令）：
  `GovernanceConsoleModel.ts`、`EvidenceChainConsoleModel.ts`、`ApprovalsGroupedConsoleModel.ts`、`ApprovalsConsoleModel.ts:173`、
  `GovernanceProjectionCollector.ts`、`OwnerDecisionViewModel.ts`、`PrincipleTrajectoryModel.ts`、`ReceiptsConsoleModel.ts`、
  `RuleCandidateBindingConsoleModel.ts`、`pd-console/src/server/routes/{failed-tasks,feedback-reports,evidence-outcomes}.ts`；
  `pd-cli/src/commands/{context,history,errors-list,principles-stats,trajectory}.ts`。
- 验收判据：
  1) 新增 fixture 测试：把 `state.db` / `trajectory.db` 移走后，每个受影响路由返回 `unknown` 态而不是 `0`/空数组；
     （机械形式：断言响应体含 `reason.kind === 'file_missing'`）；
  2) `git grep -n "new Database(" -- packages/pd-console/src packages/pd-cli/src` 从 10 处 / 8 文件降到 0；
  3) `npm test --workspace=@principles/pd-console` 通过。
- 撤回：`profile:'console'` 的 open 仍可退化为原 `new SqliteConnection(...)`；每文件独立 commit，可单文件 revert。

### 批次 2（单写者台账 + 单写者注册表只读侧）

- 内容：`ReceiptLedgerPort`、`EvidenceLedgerPort`、`DesignGate`、`IntentDecision`、`PainDiagnosis` 的读侧全部走端口；
  写侧不动（它们已经是单写者）。
- 涉及文件：`openclaw-plugin/src/core/{principle-application-ledger,principle-receipt-metadata,runtime-prompt-activation-reader}.ts`、
  `host-runtime/src/intervention-evidence-ingress.ts`（5 处 conn→端口）、`host-runtime/src/{production-rulehost-gate,product-telemetry/milestone-readers}.ts`、
  `principles-core/src/runtime/{activation-compatibility-read-model,internalization-chain-integrity-read-model,pruning-read-model,candidate-audit,schema-conformance-read-model}.ts`。
- 验收判据：
  1) `milestone-readers` 的三态测试保持全绿（它是回归基线）；
  2) 新增测试：`Fact` 的 `unknown` 不得被折叠为 `absent`（可用 lint 规则：禁止 `fact.state === 'unknown'` 后走无注释的 `return []`）；
  3) `npm run check:runtime-writers`、`npm run check:runtime-contract` 通过。
- 撤回：read-model 文件逐个 revert；端口只加不改。

### 批次 3（运行状态写侧）

- 内容：`internalization-integrity-remediation.ts`（14 处裸句柄）与 `legacy-import` / `session-history-import` 收进 `RuntimeStatePort`；
  统一 `claimTask` / `transitionTask` 的 CAS 入口。
- 涉及文件：`principles-core/src/runtime/internalization-integrity-remediation.ts`、`pd-cli/src/{legacy/legacy-import,legacy/session-history-import,commands/runtime-artifact-repair}.ts`、
  `principles-core/src/runtime/store/{task/sqlite-task-store,run/sqlite-run-store,lifecycle/lease-manager,lifecycle/recovery-sweep}.ts`（只允许它们写 tasks/runs）。
- 验收判据：
  1) `git grep -c "UPDATE tasks SET" -- packages | awk` 全部出现在上述 4 个 store 文件；
  2) `concurrent-lease.test.ts` / `sqlite-task-store-cas.test.ts` 保持全绿；
  3) 新增失败注入测试：busy 时 `claimTask` 返回 `locked` 而非抛裸 `SqliteError`。
- 撤回：remediation 是独立 CLI 入口，可整文件回退；其余按 store 逐个 revert。

### 批次 4（trajectory 写侧合流）——最高风险

- 内容：`pain_events` 的 4 个写者收敛到 `TrajectoryPort.appendPainEvent`；`tool_calls` 的 3 处 ALTER 收敛到
  `trajectory-schema.ts` 一个入口；`busy_timeout` 由 `profile` 决定，不再由各模块硬编码。
- 涉及文件：`host-runtime/src/{production-pain-evidence,governance-signal-admission,workspace-behavior-evidence,host-liveness-contract}.ts`、
  `principles-core/src/runtime/pain-signal-observability.ts`、`openclaw-plugin/src/core/trajectory.ts`、
  `principles-core/src/{trajectory-store,evolution-store}.ts`。
- 验收判据：
  1) `git grep -n "CREATE TABLE" -- packages/*/src` 只剩 6 个文件（本文 1.3 的表）；
  2) 并发测试：两个进程同时 `appendPainEvent` 同一 `canonicalPainId`，一个 `ok:true`、一个 `code:'duplicate'`，无 `SqliteError` 上抛；
  3) `packages/host-runtime/tests/trajectory-single-writer.test.ts` 扩一条"ALter 入口唯一"断言。
- 撤回：`appendPainEvent` 内部可临时回退为原 plugin 路径（保留两个实现并切换一个开关），但**开关必须默认走新路径**，否则等于没迁。

### 批次 5（跨库准入 + outbox）

- 内容：`CrossStoreUnitOfWork`（表放在 state.db：`outbox`），`governance-signal-admission` 的 admission→task 改为"同库事务写 intent + drain"。
- 涉及文件：`host-runtime/src/governance-signal-admission.ts`、`sqlite-connection.ts`（新增 outbox 表，走 schema_version '003'）、新 `store/outbox/`。
- 验收判据：
  1) 崩溃注入测试：在 admission 提交后、drain 前 kill 进程，重启后 `drain()` 恰好补出 1 条任务（不多不少）；
  2) `reconciliation_cursor` 的既有测试保持全绿（不删旧机制，先并行）。
- 撤回：outbox 是新增表 + 新增调用，去掉调用即回到现状（旧 reconciliation 未删）。

### 不要做的事

- 不要在第 1 批就动 `sqlite-activation-state-store` / `sqlite-activation-safety-store` 的合流——它是批次 4 之后、
  需要先有 `ActivationRegistryPort` 的 `applyControlState` 才能做。
- 不要在批次 2 之前改 `SqliteConnection` 的构造签名；它是 55 个文件的公共依赖，改签名会把"只读迁移"变成"全仓编译风暴"。

---

## 6. 明确不做

| 不做的事 | 理由 |
|---|---|
| **不收口 `trajectory-schema.ts` 的 DDL 文本** | 它已经是单一权威（15 表 + 索引 + 存档迁移），两套入口共用同一份文本。把它塞进端口只会让端口知道太多表结构，反而固化 schema。端口只暴露 `ensureSchema(profile)`。 |
| **不收口 SQLite 专有 pragma / WAL / busy_timeout 设置** | `busy_timeout` 是**每条连接**的属性（`sqlite-connection.ts:222-224` 的注释已经说清"Health is per-connection configuration"），`journal_mode` 是文件级但需要写锁。把 pragma 抽象成"存储无关"的接口没有意义，且会让人误以为可以换后端。端口只接受 `busyTimeoutMs` 参数，不改 pragma 序列。 |
| **不收口连接初始化里的调优** | `sqlite-connection.ts:127-170` 的"设置 + 回读校验 + 失败关闭"是正确做法，且 `getPragmaReport()` 已被健康检查使用。包进端口只会增加一层无测试覆盖的转发。 |
| **不收口 `pd runtime init` / `installer` 的建库路径** | 安装器需要 `allowBootstrap: true` 与"建目录 + 建库 + 迁移 + 种子"一体完成，`instances` 数十个表。把它塞进普通端口会让每个 hook 都有建库能力。保留 `maintainState(profile:'install')` 这一条显式通道即可。 |
| **不收口迁移器（`migrateSchema` / `migrateLegacyGfiSchema` / `internalization-integrity-remediation`）** | 迁移的逻辑是"检测形状 → 重建表 → 回填"，必须知道列名、索引名、旧表名。抽象成 port 方法只会得到 `runMigration(name)` 这种假抽象。要做的只是**把它的连接来源**换成 `maintain*`，不碰逻辑。 |
| **不收口配置（`.pd/config.yaml`）** | 不是 SQLite；`loadPdConfig` 的语义是"合并默认值 + 报错原因"，与存储无关。端口只消费 `busy_timeout_ms`。 |
| **不收口 worktree / lease / `.git` 相关状态** | 不是 SQLite，且当前有 `pd-worktree-mutation.lock` + git admin 的双重保护；`scripts/dev/lib/workspace-lease.mjs` 已经明确"refuse to remove when writer state cannot be established"。强行套存储端口会破坏它已有的 fail-closed 语义。 |
| **不收口测试夹具（`packages/*/tests/**`、`*.test.ts`、`scripts/dev/**` 探针）** | 夹具需要**故意**造畸形 schema/旧版本库来验证降级。收口后夹具将无法构造反例。本轮 73 条 `CREATE TABLE` 里 23 条在脚本层（`scripts/` 21 条 + `packages/*/scripts` 2 条），它们就是这类反例构造器。**建议改为：允许夹具建表，但禁止夹具出现在 `packages/*/src` 的 import 图里**（可加一条 lint）。 |
| **不收口 `node:sqlite` 的两个 dev 脚本** | 只读、开发期使用、无产品依赖。 |
| **不追求"一个 Database 只开一次"** | Codex hook 是 fresh subprocess（`governance-signal-admission.ts:18-20` 已说明），进程级连接缓存对它们无效。端口只保证"打开时策略一致"，不承诺"进程内单例"。 |

---

## 附录 A：94 个直接打开连接的生产文件

列含义：`conn` = `new SqliteConnection(` 次数；`newDb` = `new Database(` 次数；`DDL` = `CREATE TABLE` 条数。


**pd-console/src**（17 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/pd-console/src/server/models/ActivationsConsoleModel.ts` | 8 | 0 | 0 |
| `packages/pd-console/src/server/models/ApprovalsConsoleModel.ts` | 2 | 0 | 0 |
| `packages/pd-console/src/server/models/ApprovalsGroupedConsoleModel.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/models/EvidenceChainConsoleModel.ts` | 1 | 1 | 0 |
| `packages/pd-console/src/server/models/GovernanceConsoleModel.ts` | 1 | 2 | 0 |
| `packages/pd-console/src/server/models/GovernanceProjectionCollector.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/models/IntentDecisionModel.ts` | 6 | 0 | 0 |
| `packages/pd-console/src/server/models/IntentPageModel.ts` | 2 | 0 | 0 |
| `packages/pd-console/src/server/models/OwnerDecisionConsoleModel.ts` | 2 | 0 | 0 |
| `packages/pd-console/src/server/models/OwnerDecisionViewModel.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/models/PrincipleTrajectoryModel.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/models/ReceiptsConsoleModel.ts` | 3 | 0 | 0 |
| `packages/pd-console/src/server/models/RuleCandidateBindingConsoleModel.ts` | 0 | 1 | 0 |
| `packages/pd-console/src/server/routes/evidence-outcomes.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/routes/failed-tasks.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/routes/feedback-reports.ts` | 1 | 0 | 0 |
| `packages/pd-console/src/server/routes/principles.ts` | 2 | 0 | 0 |

**host-runtime/src**（15 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/host-runtime/src/active-principle-prompt.ts` | 1 | 0 | 0 |
| `packages/host-runtime/src/design-gate-facts.ts` | 1 | 0 | 0 |
| `packages/host-runtime/src/governance-observation-store.ts` | 0 | 1 | 5 |
| `packages/host-runtime/src/governance-signal-admission.ts` | 0 | 1 | 2 |
| `packages/host-runtime/src/host-liveness-contract.ts` | 0 | 1 | 0 |
| `packages/host-runtime/src/internalization-consumer-cycle.ts` | 1 | 0 | 0 |
| `packages/host-runtime/src/internalization-consumer-governance.ts` | 1 | 0 | 0 |
| `packages/host-runtime/src/intervention-evidence-ingress.ts` | 5 | 0 | 0 |
| `packages/host-runtime/src/product-telemetry/milestone-readers.ts` | 0 | 1 | 0 |
| `packages/host-runtime/src/production-pain-evidence.ts` | 0 | 2 | 0 |
| `packages/host-runtime/src/production-rulehost-gate.ts` | 1 | 0 | 0 |
| `packages/host-runtime/src/prompt-activation-deliverability.ts` | 2 | 0 | 0 |
| `packages/host-runtime/src/prompt-injection-status.ts` | 1 | 0 | 0 |
| `packages/host-runtime/src/trajectory-retention.ts` | 0 | 3 | 0 |
| `packages/host-runtime/src/workspace-behavior-evidence.ts` | 1 | 3 | 0 |

**pd-cli/src**（15 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/pd-cli/src/commands/build-trajectory-evidence.ts` | 0 | 2 | 0 |
| `packages/pd-cli/src/commands/context.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/errors-list.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/health-codex.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/history.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/legacy-import.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/pain-list.ts` | 0 | 1 | 0 |
| `packages/pd-cli/src/commands/principles-stats.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/runtime-artifact-repair.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/runtime-init.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/runtime-internalization-audit-artificer-evidence.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/commands/trajectory.ts` | 1 | 0 | 0 |
| `packages/pd-cli/src/legacy/session-history-import.ts` | 0 | 1 | 0 |
| `packages/pd-cli/src/services/config-doctor.ts` | 0 | 1 | 0 |
| `packages/pd-cli/src/services/quality-scorecard/data-extractor.ts` | 0 | 1 | 0 |

**openclaw-plugin/src**（7 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/openclaw-plugin/src/core/principle-application-ledger.ts` | 1 | 0 | 0 |
| `packages/openclaw-plugin/src/core/principle-receipt-metadata.ts` | 1 | 0 | 0 |
| `packages/openclaw-plugin/src/core/rule-host.ts` | 1 | 0 | 0 |
| `packages/openclaw-plugin/src/core/rulecode-safety-circuit.ts` | 2 | 0 | 0 |
| `packages/openclaw-plugin/src/core/runtime-prompt-activation-reader.ts` | 1 | 0 | 0 |
| `packages/openclaw-plugin/src/core/trajectory.ts` | 0 | 2 | 0 |
| `packages/openclaw-plugin/src/hooks/pain.ts` | 1 | 0 | 0 |

**principles-core/src**（10 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/principles-core/src/runtime/activation-compatibility-read-model.ts` | 1 | 0 | 0 |
| `packages/principles-core/src/runtime/candidate-audit.ts` | 0 | 1 | 0 |
| `packages/principles-core/src/runtime/internalization-chain-integrity-read-model.ts` | 0 | 1 | 0 |
| `packages/principles-core/src/runtime/internalization-integrity-remediation.ts` | 0 | 14 | 0 |
| `packages/principles-core/src/runtime/pain-signal-observability.ts` | 0 | 1 | 0 |
| `packages/principles-core/src/runtime/pain-signal-runtime-factory.ts` | 1 | 0 | 0 |
| `packages/principles-core/src/runtime/pruning-read-model.ts` | 0 | 2 | 0 |
| `packages/principles-core/src/runtime/schema-conformance-read-model.ts` | 0 | 1 | 0 |
| `packages/principles-core/src/runtime/store/sqlite-connection.ts` | 2 | 2 | 24 |
| `packages/principles-core/src/trajectory-store.ts` | 0 | 2 | 0 |

**pd-console/scripts**（1 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/pd-console/scripts/e2e-seed.ts` | 1 | 1 | 2 |

**pd-cli/scripts**（2 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `packages/pd-cli/scripts/migrate-illegal-expected-decision.ts` | 0 | 1 | 0 |
| `packages/pd-cli/scripts/prompt-capacity-measurement.mjs` | 1 | 0 | 0 |

**plugins**（1 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `plugins/principles-disciple/scripts/verify-pinned-runtime-capability.cjs` | 1 | 0 | 0 |

**scripts**（26 文件）

| 文件 | conn | newDb | DDL |
|---|---:|---:|---:|
| `scripts/cleanup-principle-baseline.mjs` | 0 | 2 | 0 |
| `scripts/dev/aa-controlled-admission/lib/presence-fixture.mjs` | 1 | 0 | 0 |
| `scripts/dev/aa-controlled-admission/lib/workspace-seed.mjs` | 2 | 0 | 0 |
| `scripts/dev/aa-selector/pri1105b-trim-replay.mjs` | 1 | 0 | 0 |
| `scripts/dev/aa-selector/pri1140-replay.mjs` | 1 | 0 | 0 |
| `scripts/dev/adaptive-selector-lab/fixture-workspace.mjs` | 2 | 0 | 0 |
| `scripts/dev/audit-diagnostician-dual-write.mjs` | 0 | 1 | 0 |
| `scripts/dev/codex-owner-journey-e2e.mjs` | 0 | 7 | 3 |
| `scripts/dev/codex-r1-installed-gate.mjs` | 0 | 2 | 0 |
| `scripts/dev/pain-real-llm-bdd/lib/chain-harness.mjs` | 1 | 1 | 0 |
| `scripts/dev/pain-real-llm-bdd/run-d6-pending.mjs` | 0 | 1 | 0 |
| `scripts/dev/pain-real-llm-bdd/run-fault-injection.mjs` | 0 | 2 | 0 |
| `scripts/dev/pain-real-llm-bdd/run-openclaw-host.mjs` | 0 | 2 | 0 |
| `scripts/dev/pipeline-evolution/collect-evidence.mjs` | 0 | 1 | 0 |
| `scripts/dev/principle-learning-lab/lib/challenge-openclaw-host.mjs` | 0 | 1 | 0 |
| `scripts/dev/principle-learning-lab/prr/lib/prr-readonly.mjs` | 0 | 3 | 1 |
| `scripts/dev/workbuddy-probe/e2e-full-learning.mjs` | 0 | 11 | 3 |
| `scripts/dev/workbuddy-probe/e2e-governance-loop.mjs` | 1 | 2 | 3 |
| `scripts/dev/workbuddy-probe/e2e-installed-full-learning.mjs` | 0 | 6 | 0 |
| `scripts/dev/workbuddy-probe/e2e-installed-product.mjs` | 1 | 0 | 0 |
| `scripts/dev/workbuddy-probe/verify-ptuf-admission-lab.mjs` | 0 | 3 | 3 |
| `scripts/e2e-story-a.mjs` | 0 | 2 | 0 |
| `scripts/pri743/audit-pain-data.mjs` | 0 | 1 | 0 |
| `scripts/pri743/dogfood-metrics.mjs` | 0 | 1 | 0 |
| `scripts/pri743/scan-workspaces.mjs` | 0 | 1 | 0 |
| `scripts/telemetry-production-smoke.mjs` | 0 | 2 | 4 |

---

## 附录 B：表格读写矩阵（节选）

只列存在 2 个以上写者、或读 20 个以上文件的概念。完整矩阵见调查过程脚本输出（未落库）。

| 表 | 写者数 | 读者数 | DDL 所有者 |
|---|---:|---:|---|
| `activations` | 3（+1 脚本） | 26 | `sqlite-connection.ts` |
| `activation_control_states` | 2 | 6 | `sqlite-connection.ts` |
| `activation_decisions` | 2 | 4 | `sqlite-connection.ts` |
| `pi_artifacts` | 2（+2 脚本） | 32 | `sqlite-connection.ts`（+`migrateSchema` ALTER） |
| `principle_candidates` | 3 | 30 | `sqlite-connection.ts`（+`migrateSchema` ALTER） |
| `tasks` | 8 | 36 | `sqlite-connection.ts` |
| `runs` | 5 | 15 | `sqlite-connection.ts` |
| `pain_events` | 4（+3 脚本） | 26 | `trajectory-schema.ts` |
| `tool_calls` | 2（+3 ALTER） | 14 | `trajectory-schema.ts` |
| `sessions` | 3 | 5 | `trajectory-schema.ts` |
| `governance_observations` | 1 | 7 | `governance-observation-store.ts` |
| `governance_signal_admissions` | 1（+1 脚本） | 9 | `governance-signal-admission.ts` |

---

## 附录 C：NOT RUN 清单

| 项 | 状态 | 卡在哪 |
|---|---|---|
| 多进程并发压测（真实 lock 冲突率） | **NOT RUN** | 需要起多个 `codex`/`claude` hook 进程同时打同一个 workspace；本报告只做静态证据。若需要数字，应在批次 3 前补一个 2 进程 × 1000 次的 `appendPainEvent` / `claimTask` 基准。 |
| 全量测试套件 | **NOT RUN** | 只读调查，且本地工作副本落后 origin/main（`f15798cf1` vs `38ef59848`）；在旧树上跑测试的结论会被污染。批次验收时应以 origin/main 的 CI 结果为准。 |
| 线上/真实工作区的 `storage_unavailable` 计数 | **NOT RUN** | 仓库内只有开发期的 `trajectory.db`，不代表用户工作区；也没有可用的遥测导出。 |
| `better-sqlite3` 在 Windows 上的 `SQLITE_BUSY` 复现 | **NOT RUN** | 同上，需要真实并发场景。 |
| 每个 store 接口的现有测试覆盖率 | **NOT RUN** | 需要 `vitest --coverage`，本轮未跑。迁移前建议按批次补测。 |
| `scripts/dev/**` 探针与产品 schema 的漂移差异 | **NOT RUN** | 已确认探针不读 `GOVERNANCE_OBSERVATION_SCHEMA_VERSION`，但未逐表比对列集合。 |
