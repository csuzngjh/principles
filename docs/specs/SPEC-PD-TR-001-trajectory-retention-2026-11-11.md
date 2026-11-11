# SPEC-PD-TR-001 — 轨迹库有界保留与在线瘦身（Trajectory Retention & Self-Slimming）

- **Status**: Draft — 待评审
- **Date**: 2026-11-11
- **Owner**: Owner
- **Type**: 设计 SPEC（本文档不含实现）
- **范围**: `<workspace>/.state/trajectory.db`（对话/工具轨迹库）的保留策略、清扫执行模型、查询修复、磁盘回收
- **明确不在范围**: `state.db`、任何业务语义数据、任何 UI 改版

---

## 0. 结论先行

Owner 决策：**PD 定期自行瘦身**，且**瘦身本身不得成为新的卡顿源**。

本 SPEC 定义两件事，并同时把它们变成可测数字：

1. **有界增长**：`tool_calls` / `assistant_turns` / `user_turns` / 已脱敏的 `governance_observations` 默认保留 **90 天**，到期由 PD 自己的常驻 worker 分批删除；稳态体积从「线性增长」变成「90 天窗口 + 可复用空闲页」。
2. **瘦身不制造卡顿**：清扫**永不进入 hook 热路径**；单次运行墙钟 ≤ 3 s、单批 ≤ 250 ms；遇到 `SQLITE_BUSY` **让路而不是重试**；被抢占时最多损失 250 ms，而不是占用用户请求的写锁。

---

## 1. 现状证据（2026-11-11 只读实测）

调查脚本：`.tmp/trajectory-growth-audit/`（`better-sqlite3` 只读连接，无写、无 VACUUM）。

| 工作区 | 文件大小 | `tool_calls` 行数 | 时间跨度 | 日均 |
|---|---|---|---|---|
| `~/.codex/pd-workspace` | 32.4 MB | 19,271 | 2026-09-30 → 11-11（42 天） | **0.79 MB/天，约 457 行/天** |
| `~/.workbuddy/pd-workspace` | 12.7 MB | 11,128 | 2026-10-15 → 11-11（27 天） | **0.49 MB/天，约 415 行/天** |
| `~/.openclaw/workspace` | 1.1 MB | 576 | 2026-09-17 → 09-18（已停写） | 停写后数据原样保留 |

- 空间构成（Codex）：`tool_calls` 19.46 MB + 其索引 3.11 MB + `governance_observations` 7.67 MB + 其索引 0.92 MB ≈ 全库 95%。
- 现状清理路径：**无**。全仓生产代码没有对轨迹表执行 `DELETE` / 归档 / `VACUUM`；只有 blob 文件级清理（`trajectory.ts` 的 `pruneUnreferencedBlobs`）。
- 唯一已有保留期范式：[principle-application-ledger.ts#L42-L71](file:///d:/Code/principles/packages/openclaw-plugin/src/core/principle-application-ledger.ts#L42-L71) —— 90 天、每进程每小时最多扫一次、best-effort `DELETE ... WHERE created_at < ?`。
- 磁盘：4 个库 `freelist_count = 0`（从未删过行，所以也从未产生空闲页）。

**判断**：这不是"可能有问题"，而是已经按 0.5–0.8 MB/天 稳定增长，且没有任何刹车。

---

## 2. 范围与不做的部分

### 2.1 纳入保留策略的表

| 表 | 保留 | 时间字段 | 理由 |
|---|---|---|---|
| `tool_calls` | **90 天** | `created_at` | 占本机轨迹库 57%–83%，每次工具调用必增一行；是唯一"高频 + 大字段"的表 |
| `assistant_turns` | **90 天** | `created_at` | 正文可能很大（OpenClaw 主路径不截断），且外置 blob 文件随行存在 |
| `user_turns` | **90 天** | `created_at` | 与 assistant 对称；会话证据的时间窗口应与工具事实一致 |
| `governance_observations` | **90 天**，但仅 `retention_class IN ('expired','rolled_back')` | `expired_at` | 正文在 7 天/32 轮时已被置 NULL（[governance-observation-store.ts#L453-L513](file:///d:/Code/principles/packages/host-runtime/src/governance-observation-store.ts#L453-L513)），剩的是元数据行；只删"已脱敏且已过期"的行，`operational` / `promoted` / `quarantined` **永不删除** |

### 2.2 明确不纳入（v1）

| 表 / 对象 | 处理 | 理由 |
|---|---|---|
| `pain_events` | **不删** | 产品核心证据。本机 17 行，删除直接摧毁诊断输入；体积可忽略 |
| `sessions` | **不删** | 42 天仅 109 行（约 65 B/天），删除收益为零；且删除需要检查四张子表是否有孤儿引用，引入误删风险。设 tripwire：> 50,000 行或 > 20 MB 时再评估"仅删孤儿会话" |
| `principle_events` / `gate_blocks` / `trust_changes` / `task_outcomes` | **不删** | 治理审计事实，体积小（本机合计 < 100 行），不可再生成 |
| `correction_samples` / `sample_reviews` / `signal_confirmations` / `exports_audit` | **不删** | 学习/评审证据，且 `sample_reviews` 可能引用 `correction_samples`；本机 0 行，无增长证据 |
| `governance_rollouts` | **不删** | 130 行，rollout 血缘；未来单列 SPEC |
| `state.db` 全部表 | **完全不动** | 已有自己的 90 天清扫（`principle_applications`）与插入期保留闸；跨库清理会把两个 SSoT 混在一起 |
| 正文/摘要降级 | **v1 不做** | 见 §8 被否方案 D：对 `tool_calls` 置空 `params_json` 省不了多少空间，却让诊断失去可读性 |

**边界声明**：本 SPEC 只让"宿主对话轨迹"有界，不承诺"整个 PD 有界"。

---

## 3. 保留策略语义

### 3.1 参数

新增 `.pd/config.yaml` 顶层可选段（与 `promptBudget`、`contextInjection` 同构，见 [pd-config-types.ts#L358-L384](file:///d:/Code/principles/packages/principles-core/src/runtime/config/pd-config-types.ts#L358-L384)）：

```yaml
trajectoryRetention:
  enabled: true          # 默认 true；false = 停止清扫，已有数据原样保留
  retentionDays: 90      # 默认 90，对齐 RECEIPT_RETENTION_POLICY_DAYS
  intervalHours: 6       # 两次运行的最小间隔
  batchSize: 2000        # 每批删除行数
  runBudgetMs: 3000      # 单次运行墙钟预算
```

- **单一配置源**：只读 `.pd/config.yaml`，**不**在 `.pd/pain_settings.json` 复制第二份。`.pd/config.yaml` 是 Codex / WorkBuddy / OpenClaw 工作区共有且由 `loadPdConfigForPlugin` 加载的那一份。
- **非法值 fail closed**：由 `validatePdConfig` 返回 `path / reason / nextAction`（rc-3、rc-9）。
  - `retentionDays = 0` ⇒ **保留策略停用**（不是"删光"）。
  - `1..6` ⇒ 拒绝，回落 90，写入 `degraded` 原因，**本次不删任何行**。
  - `> 3650` ⇒ 拒绝，回落 3650，同上。
  - `batchSize ∉ [100, 10000]`、`runBudgetMs ∉ [500, 10000]`、`intervalHours ∉ [1, 168]` ⇒ 同上。
  - `enabled` 非布尔 ⇒ 视为 `false`（宁可不动数据）。
- **优先级**：配置非法 > 不做；配置缺失 > 用默认值；配置合法 > 按配置执行。任何情况下都不会"因为配置坏了就按默认删"。

### 3.2 过期判定

- 统一使用 `created_at`（ISO-8601 UTC 字符串，字典序 = 时间序）；`governance_observations` 用 `expired_at`。
- 判定：`created_at < now - retentionDays × 24h`，**严格小于**。恰好等于边界的行保留，直到下一次运行。
- 保留窗口语义："最近 90 天内产生的行一定还在"；第 91 天起进入删除候选，不承诺具体删除时刻（取决于 worker 是否在跑）。

### 3.3 时钟异常

删除不可逆，因此**宁可少删**：

- 维护文件中持久化 `lastCutoff`（上次实际使用的截止时间）与 `lastRunAt`。
- 计算 `computedCutoff = now - retentionDays`，然后
  `effectiveCutoff = min(computedCutoff, lastCutoff + 7d)`。
  即：**截止线每次最多前进 7 天**，一次时钟前跳不可能清空多年数据。
- `lastCutoff` 缺失（首次运行 **或** marker 丢失/损坏）时，基线取**库内最早记录时间**：
  `lastCutoff = MIN(时间列)`。首次运行因此同样受 7 天/次约束（积压按每轮 7 天收敛），
  marker 丢失也不会一次删掉 `retentionDays` 以外的大段历史。库为空时无数据可删。
- **收敛时间**：每轮最多前进 7 天，默认 `intervalHours = 6`（最多 4 轮/天），即约 28 天历史/天。
  两年老库（约 730 天）需要清理约 640 天历史 ⇒ 约 92 轮 ≈ **三周多**才收敛到 90 天窗口。
  期间文件大小是**逐步下降**的，不是装上就瘦。
- 系统时间后跳（`now < lastRunAt - 1h`）⇒ 本次跳过，记录 `clock_backwards`，不动数据。
- 系统时间前跳超过 `intervalHours × 2 + 7d`（相对 `lastRunAt`）⇒ 本次跳过，记录 `clock_forward_anomaly`，不动数据。
- 任何**时钟类跳过**都要把 `lastRunAt` 推进到 `now`（`lastCutoff` 不动）：
  否则关机/休假超过 7.5 天后每轮都会跳过，只能人工删 marker 才恢复。
- marker 中不可解析的时间字段在读取时归一化为 `null`（不保留坏字符串），保证下一轮可恢复。
- `effectiveCutoff` 取 `max(lastCutoff, ...)`：截止线单调不回退。

---

## 4. 瘦身执行模型（本 SPEC 的重点）

### 4.1 触发时机：复用已有常驻 worker，不新建调度器

仓库里已经有两个长期存在的执行者，无需发明后台子系统：

| 宿主 | 执行者 | 触发 |
|---|---|---|
| Codex | `pd codex worker` 连续模式，120 s 一个 cycle（[codex-worker.ts#L29](file:///d:/Code/principles/packages/pd-cli/src/commands/codex-worker.ts#L29)），由 Companion 监督、install manifest 注册 | 每个 cycle 检查 `now - lastRunAt >= intervalHours`，到期则在本 cycle 内跑一次（预算 ≤ 3 s，远小于 cycle 的 5–10 min stage deadline，[workspace-worker.ts#L134-L139](file:///d:/Code/principles/packages/codex-adapter/src/worker/workspace-worker.ts#L134-L139)） |
| WorkBuddy | `pd workbuddy worker` 连续模式，同样 120 s cycle（[workbuddy-worker.ts#L33](file:///d:/Code/principles/packages/pd-cli/src/commands/workbuddy-worker.ts#L33)） | 同上 |
| OpenClaw | 插件 gateway 常驻服务 | `setInterval(intervalHours ± 10 min jitter).unref()`；到期且无进行中 cycle 时运行 |
| 任意 | `pd trajectory maintain --workspace <dir>` | 手动 / 排障 / 无 worker 的兜底 |

**硬性约束**：

- 维护**不注册任何 hook**。`before_prompt_build` / `user_prompt_submit` / `llm_output` 里不得出现清扫调用、DB 打开或 marker 写入。
- Codex/WorkBuddy 的 `turn_complete` 也**不**触发清扫（它仍是 hook 进程，可能被宿主在 5 s 内杀死）。
- 若 worker 未运行（`pd codex worker status` = `manual_action_required`），不派生子进程、不改 hook；只由用户显式跑 CLI。**不做 detached spawn**，见 §10 被否方案 B。

### 4.2 单次运行流程

```
acquire maintenance lock  (失败 → exit 0, skipped:locked)
  ↓
读 marker（lastRunAt / lastCutoff / backoffUntil）
  ↓ 未到期 → exit 0, skipped:not_due
读 config（校验失败 → exit 0, degraded:config_invalid，不删）
  ↓
打开 DB：删除写路径 `busy_timeout=100`（A8 要求 ≤300 ms 让路；SQLite busy handler 会多睡一个步长，250 ms 实测约 355 ms）；索引 DDL 单独用 `busy_timeout=5000`（不是热路径）。只读校验 journal_mode 必须已是 wal，绝不执行 journal_mode=WAL
  ↓
preCount = COUNT(*) WHERE <cutoff>          （只读快照）
  ↓
loop（受 runBudgetMs 与 batchSize 约束）:
    BEGIN IMMEDIATE
      DELETE ... WHERE id IN (SELECT id FROM t WHERE <cutoff> ORDER BY id LIMIT batchSize)
    COMMIT                                     ← 每批独立提交
    累计 changes()
  ↓
postCount = COUNT(*) WHERE <cutoff>
校验 preCount - postCount == Σ changes() ；不等 → 记录不变量违例，停止，不继续删
  ↓
写 marker（lastRunAt / lastCutoff=effectiveCutoff / 统计 / partial 标志）
释放 lock
```

要点：

- **`BEGIN IMMEDIATE`**：一开始就拿写锁，避免读完再升级写锁时立刻 `SQLITE_BUSY`（这正是今天踩到的锁升级失败形态）。不使用 `BEGIN DEFERRED`。
- **不切换 `journal_mode`**：`PRAGMA journal_mode = WAL` 是一个需要独占锁的模式切换点（[trajectory.ts#L302](file:///d:/Code/principles/packages/openclaw-plugin/src/core/trajectory.ts#L302) 目前每次构造都执行它）。维护进程只读该值做 assert；不是 `wal` 就跳过本次并记录 `journal_mode_not_wal`，绝不替用户切模式。
- **不改 `synchronous` / 不跑 `PRAGMA optimize` / 不跑 `VACUUM`**。
- 维护连接**不参与**写业务数据；它只删行。

### 4.3 分批与时间预算

| 参数 | 值 | 依据 |
|---|---|---|
| 每批行数 | 2,000 | 90 天窗口下最坏一次要删约 5–20 万行；2,000 行/批在实测 1.2 KB/行下约 2.4 MB，单批通常在 20–80 ms |
| 单批墙钟上限 | 250 ms | 超过即视为异常，本批提交后立即停止（不是中止事务） |
| 单次运行墙钟上限 | 3,000 ms | 即使触发 12 批也能在 worker 的一个 cycle 内结束 |
| 删不完 | 持久化 `partial: true`，**下一轮从同一判据继续** | 判据是 `created_at < cutoff`，天然幂等，不需要游标 |

`runBudgetMs` 是硬预算：每批开始前检查剩余预算，不足 250 ms 就停止，不赌"这一批应该很快"。

### 4.4 并发安全与 `SQLITE_BUSY`

背景：本仓库 2026-11-11 已实际出现 `journal_mode` 切换 / 写事务并发下的 `SQLITE_BUSY` 锁升级失败；`host-runtime` 打开轨迹库的写入路径甚至没有设置 `busy_timeout`（[production-pain-evidence.ts](file:///d:/Code/principles/packages/host-runtime/src/production-pain-evidence.ts)）。因此维护进程必须"最礼貌"：

| 场景 | 行为 |
|---|---|
| 维护开始前已有写事务 | `BEGIN IMMEDIATE` 在 `busy_timeout=100` 内等待；仍失败 → **让路**：回滚、释放锁、写 `deferred:busy` |
| 删除单批时遇到 busy | 不重试当前批；已提交的批保留；本次运行结束 |
| 让路后如何保证最终继续 | `backoffUntil = now + 30 min`（连续 busy 指数退避 30 min → 1 h → 2 h → 6 h 封顶）。worker 每 cycle 读取 marker，到点自然重试；marker 与数据同库不同文件，不依赖 DB 可写 |
| 用户写入 vs 维护 | 维护只持有单批写锁（≤ 250 ms），WAL 下读不阻塞；用户写入的 `busy_timeout=5000` 足以跨过单批 |
| 重试上限 | 单次运行内对同一批最多尝试 1 次；**不做 3 次连击重试**，避免把瞬时争用放大成持续争用 |

### 4.5 中断与幂等

- 每批独立 `COMMIT` ⇒ 进程被杀只丢失"当前批"，已提交批次不丢。
- 因为没有游标，重跑时判据不变：已删的行不再匹配；未过期行永远不匹配 ⇒ **不重复删、不误删**。
- marker 只在 `postCount` 校验通过后写；进程在"删完但没写 marker"时被杀 ⇒ 下次重跑 `preCount` 已为 0，直接写 marker 结束（可解释状态）。
- 若 `preCount - postCount != Σ changes()` ⇒ 视为不变量违例：停止本次运行、保留 marker 的 `lastRunAt` 不变（即下一轮仍会尝试）、写结构化错误 `retention_invariant_violation`，不静默继续。

### 4.6 单实例保证

- 锁文件：`<workspace>/.state/trajectory-retention.lock`，内容 `{ runId, host, pid, startedAt }`。
- 获取方式复用仓库既有锁文件契约（`fs.openSync(path, 'wx')` 独占创建 + 过期接管，见 [file-lock.ts#L239-L317](file:///d:/Code/principles/packages/openclaw-plugin/src/utils/file-lock.ts#L239-L317)），**stale TTL = 10 分钟**（远大于 3 s 预算）。
- 已有未过期锁 ⇒ 直接退出 `skipped:locked`，不等待、不删除别人的锁。
- 锁文件损坏/不可解析 ⇒ 视为"已被占用"（fail closed），记录 `lock_corrupt`，本轮不删。
- 这是协作式信号，不是权限系统：人类可以随时删除该文件，与仓库既有 lease 语义一致。
- 说明：Codex/WorkBuddy 的 worker 本身通常只有一个实例，但用户可能同时跑手动 CLI、或两个宿主指向同一工作区，所以锁必须存在，不能只依赖"worker 唯一"。

### 4.7 可观测性

不新增表（避免第二个 SSoT）。每次运行写：

- marker：`<workspace>/.state/trajectory-retention.json`
  `{ lastRunAt, lastCutoff, lastOutcome, deletedByTable, durationMs, totalDurationMs, partial, backoffUntil, consecutiveBusy, reason }`
  （`durationMs` 只是批引擎耗时；`totalDurationMs` 覆盖打开 DB、WAL 断言、索引 DDL 与 marker 写入，A1 用它度量）
- 一行结构化日志（复用现有 logger）：`trajectory_retention { outcome, deleted, durationMs, cutoff }`
- CLI：`pd trajectory retention status [--json]` 只读输出上述内容 + 当前各表过期行数。

---

## 5. 不能拖慢查询

### 5.1 已定位的三处历史性全表扫及其修法

| # | 位置 | 现状 | 修法 |
|---|---|---|---|
| 1 | `TrajectoryDatabase` 构造即调用 `pruneUnreferencedBlobs`，内部 `SELECT blob_ref FROM assistant_turns UNION ... user_turns`，无 WHERE（[trajectory.ts#L1770-L1808](file:///d:/Code/principles/packages/openclaw-plugin/src/core/trajectory.ts#L1770-L1808)） | 每次打开轨迹库都全表扫两张表 | (a) 加**部分索引** `... (blob_ref) WHERE blob_ref IS NOT NULL`；(b) 构造函数不再无条件执行，改由 marker 节流（24 h 一次），且只在本进程确实写过 blob 时才排期 |
| 2 | `build-trajectory-evidence` 把某会话全部 `user_turns` / `assistant_turns` 读进内存再 `slice(-3)`（[build-trajectory-evidence.ts#L126-L167](file:///d:/Code/principles/packages/pd-cli/src/commands/build-trajectory-evidence.ts#L126-L167)） | 成本随会话长度线性增长，内存峰值与 DB 无关 | 改成 SQL 侧 `ORDER BY id DESC LIMIT 3`（assistant）/ `LIMIT 1`（最近纠错），彻底不物化全量 |
| 3 | `getDataStats` 对 4 张表求 `MAX(created_at)` | `user_turns`、`pain_events` **没有时间索引** ⇒ 每次全表扫 | 新增 `idx_user_turns_created_at`、`idx_pain_events_created_at`；`MAX()` 走索引尾，O(log n) |

补充：`COUNT(*)` 本身仍是 O(n)（SQLite 无元数据计数），但它会被保留策略**限制在 90 天窗口**（约 4.1 万行 `tool_calls`），不会随历史无限增长。

### 5.2 索引创建不能发生在 hook 热路径

- DDL 仍集中定义在 [trajectory-schema.ts](file:///d:/Code/principles/packages/principles-core/src/runtime/trajectory-schema.ts)（保持单一 schema 源），但**由维护入口显式调用** `ensureRetentionIndexes(db)`，不塞进每次构造都跑的 `initSchema`。
- 首次创建索引在 3.2 万行库上预计 < 300 ms；在百万行历史库上可能数秒 —— 正是不能放在 hook 打开路径的原因。若用户从未跑过维护，查询退化为现状（扫表），不会更慢，只是不会变快。
- 索引全部 `CREATE INDEX IF NOT EXISTS`，可重复执行；回滚 = `DROP INDEX`。

### 5.3 瘦身之后查询还随历史增长吗？

| 查询 | 瘦身前 | 瘦身后 |
|---|---|---|
| 按时间范围查 `tool_calls` | O(log n + 命中行)，索引已有 | 不变，n 被限制在 90 天 |
| `getDataStats` 的 `MAX` | O(n)（两张表无索引） | O(log n) |
| `pruneUnreferencedBlobs` | O(两张表行数)，每次打开 | O(#blob 行) 且 24 h 一次 |
| `build-trajectory-evidence` | O(会话行数) 内存物化 | O(3) / O(1) |
| `COUNT(*)` 统计 | O(n) 且 n 无上限 | O(n)，n ≤ 90 天窗口 |

结论：**瘦身解决"n 无上限"，索引与查询改写解决"每次都要扫 n"**。两者缺一不可，不能只用瘦身掩盖查询问题。

---

## 6. 磁盘回收（VACUUM）

### 6.1 策略

- **只由用户显式触发**：`pd trajectory vacuum --workspace <dir>`（默认 dry-run，打印现状与所需空间；`--yes` 才执行）。后台/worker **永不**自动 VACUUM。
- 理由：VACUUM 需要**独占锁且不可中断**；在用户发消息期间执行会直接违反"瘦身不制造卡顿"。磁盘回收是"用户主动维护动作"，不是"后台服务"。

### 6.2 前置条件与失败处理

| 项 | 规则 |
|---|---|
| 空闲空间 | 执行前检查同目录可用空间 ≥ `2 × 文件大小 + 10%`；不足则拒绝，输出还差多少字节 |
| 锁 | `busy_timeout = 5000`；拿不到独占锁就退出并提示"关闭宿主后重试"，不排队死等 |
| 持续时间 | 目标：≤ 200 MB 的库 ≤ 15 s（**本地无法证明，见 §9**） |
| 中断/失败 | SQLite VACUUM 是原子的：失败时原库不变，临时文件由 SQLite 清理；用户可重试 |
| 磁盘满 | VACUUM 失败并保留原库；不产生半成品 |
| 与维护的关系 | 先 `maintain` 再 `vacuum`；VACUUM 不改数据，只搬页 |

### 6.3 不 VACUUM 时的稳态

删除后的页进入 freelist，会被**后续写入复用**。因此：

- **逻辑上**：体积有界（90 天窗口）。
- **物理上**：文件先停止增长，随后在一个"历史峰值附近"平台化；不 VACUUM 不会自动缩小。
- 这可接受：用户要的是"不再无限吃盘"，不是"文件必须马上变小"。需要立刻缩小时跑显式 VACUUM。

---

## 7. 可测的验收标准（全部为数字）

测试夹具：用脚本生成 270 天、按实测速率（500 行 `tool_calls`/天、1.2 KB/行 + `assistant_turns` 5%/天）的合成库，约 300 MB；Windows 本机；介质为本地 SSD。

| ID | 断言 | 阈值 | 方法 |
|---|---|---|---|
| A1 | 单次维护墙钟 | p95 ≤ **3,000 ms**；最坏 ≤ 3,500 ms | 20 次运行，记录 marker `durationMs` |
| A2 | 单批墙钟 | p95 ≤ **250 ms**；最坏 ≤ 400 ms | 每批埋点 |
| A3 | hook 路径额外延迟 | `before_prompt_build` p95 增加 ≤ **15 ms**，且**打开轨迹库次数 = 0** | 对 200 次 hook 调用计时；spy `new Database` / `new TrajectoryDatabase` |
| A4 | 三个关键查询不劣化 | 同数据集、同机器，100 个样本/查询；p95 劣化 ≤ **+5%** 且绝对值 ≤ **+10 ms** | 瘦身前/后各跑一次；`EXPLAIN QUERY PLAN` 必须显示 `USING INDEX` |
| A5 | 删除行数一致 | `preCount − postCount == Σ changes()`，误差 **0 行** | 运行内断言；不一致即失败并保留现场 |
| A6 | 中断重跑 | 注入式在第 1 批后 kill -9；重跑后：未过期行 **0 删除**、过期行 **恰好删完**、总删除数 == 预置过期数 | 预置 10,000 过期 + 1,000 未过期；3 组重复 |
| A7 | 文件缩小 | 删除 2/3 行 + VACUUM 后，`size_after ≤ 0.40 × size_before`；`freelist_count` 回到 ≤ 1% 页数 | 300 MB 夹具 |
| A8 | busy 让路 | 另一连接持有写事务 3 s 时，维护在 ≤ **300 ms** 内退出 `deferred:busy`，该批 0 行删除；其后第 1 次重试成功 | 双连接测试 |
| A9 | 时钟异常 | +400 天：删除 **0 行**、记录 `clock_forward_anomaly`；−400 天：删除 **0 行**；恢复正常后按正常速率删 | 注入 clock |
| A10 | 非法配置 | `retentionDays: 0` ⇒ 完全不删；`3` / `99999` / `batchSize: 10` ⇒ 删除 **0 行** 且 `degraded` 原因可读 | 配置矩阵 |
| A11 | 稳态 | 连续 7 天模拟写入（500 行/天）后，文件大小波动 ≤ **±10%**，不再单调上升 | 模拟时钟 + 写入器 |
| A12 | CLI 契约 | `--json` stdout 恰好一个 JSON 对象；失败路径含 `reason` + `nextAction`；退出码非 0 | 真实命令注册测试（cli-1 / cli-6 / cli-7） |

**测量方法统一**：每个阈值记录 20 次（查询类 100 次）样本，取 p95；冷/热缓存分开记录，验收以热缓存为准，冷启动另报参考值。任何一项不达标即视为未完成，不用"整体可接受"替代。

---

## 8. 回滚与数据安全

### 8.1 误删后果

- 删除**不可恢复**：没有软删除、没有回收站。恢复只能依赖用户自己的备份（Time Machine / 云同步 / 手动拷贝）。
- 因此默认值必须保守（90 天），且首轮删除前留痕。

### 8.2 拟删集合（默认开启，不含正文）

- 每次实际删除前，把**本批拟删行**的 `{table, id, created_at}` 写入 `<workspace>/.state/exports/trajectory-retention-<yyyy-mm-dd>.jsonl`（该目录已是既有导出目录，[paths.ts#L55](file:///d:/Code/principles/packages/openclaw-plugin/src/core/paths.ts#L55)）。
- 这是**拟删集合，不是精确的已删清单**：台账在删除事务之前整批写入（事务内不做事，避免持锁做文件 I/O），所以"台账有、实际未删"是允许的方向——候选批次回滚、进程在提交前被杀时，id 会留在文件里。**宁可多记，不可无痕**；精确计数以 marker 的 `deletedByTable` 为准。
- 每行约 60 B，10 万行约 6 MB；只含标识与时间，**不含对话正文/工具参数**，避免制造第二份敏感数据。
- 作用：可审计"这一轮打算删什么、规模多大"；不提供内容恢复，也不作为精确删除数。
- **fail closed**：拟删集合写入失败 ⇒ 该批**不删除**，原因写入 marker（`audit_failed:<reason>`）并可观察。
- **引用断裂**：`correction_samples` 永不删除，但它引用的 `assistant_turns` / `user_turns` 会在 90 天后被删。导出改用 `LEFT JOIN`：样本仍然导出，正文为空，并写入 `metadata.source_turns_purged: true` —— 即"90 天后只保留样本元数据"，不静默丢样本。
- 需要完整内容备份的用户，可先跑 `pd trajectory export --out <path>`（可选命令，默认不执行）；是否提供由评审决定，v1 只保证"清单"。

### 8.3 极端配置保护

- `retentionDays = 0` ⇒ 停用（不删任何行）。
- `1..6` ⇒ 拒绝并回落 90，**本次删除 0 行**。
- 截止线每次最多前进 7 天（§3.3），即使配置被误改为 7 天，也要分多轮才会清历史，给人工发现留出时间窗。
- 配置解析失败 ⇒ 不删（fail closed），不是"按默认删"。

### 8.4 整体回滚

| 层级 | 动作 | 效果 |
|---|---|---|
| 停止瘦身 | `.pd/config.yaml` 设 `enabled: false` | 不再删任何行；已有数据保持 |
| 撤销索引 | `DROP INDEX ...` | 查询退回扫表，功能不受损 |
| 撤销代码 | 回滚本 SPEC 的实现 PR | 无 schema 迁移、无新表 ⇒ 无需数据迁移 |
| 已删数据 | 只能从用户备份恢复 | 因此默认 90 天 + 7 天/轮截止线前进 |

---

## 9. 本地无法证明、只能上线观测的项

1. **多宿主真实并发**：本机只有单用户单会话，无法复现"两个 Codex 会话 + 一个 WorkBuddy worker + 手动 CLI 同时写"的争用分布；A8 是受控替身，不是生产。
2. **VACUUM 在真实 300 MB+ 库上的耗时与锁窗口**：本机最大 32 MB，无法外推。
3. **杀进程的真实时机**：宿主可能在任意点终止 worker/hook；A6 只覆盖"批间被杀"，不覆盖"SQLite 提交过程中被强杀"（后者依赖 SQLite 自身原子性，需上线观察 journal 恢复）。
4. **Windows 杀毒/索引器干扰**：文件锁与 rename 在 AV 扫描下可能变慢；本机未开启企业级 AV 策略。
5. **网络盘/同步盘上的工作区**：SQLite + 文件锁 + 云同步的交互无法本地覆盖，需明确"不支持"或上线观察。
6. **磁盘满 / 配额受限**：只能注入模拟，真实 NTFS 配额行为需观测。
7. **用户感知延迟**：A3 只测 hook 进程内耗时，不测宿主 UI 端到端；宿主自身调度开销不可控。
8. **长期时钟漂移**：本机无法跑 90 天真实时钟，A9/A11 均为注入。

---

## 10. 被否掉的方案（为什么不是它们）

| 方案 | 否决理由 |
|---|---|
| **A. 照搬 ledger：写路径内联清扫**（`recordXxx` 里先 `sweepRetention`） | 违反 Owner 约束：在用户发消息的那一刻拿写锁；且 hook 是短命进程，`lastRetentionSweepAt` 的"每进程每小时"节流在短命进程里等于**每次都扫** |
| **B. hook 里 detached spawn 维护子进程** | 引入新的后台进程形态，Windows 上 spawn 成本 80–200 ms 直接吃掉 A3 预算；hook 被宿主杀死时子进程状态不可控 |
| **C. 安装时注册 OS 定时任务**（schtasks / launchd / systemd） | 新外部能力 + 安装器所有权 + 企业策略与 AV 拦截；跨平台成本高，且仓库已有常驻 worker，没必要 |
| **D. 软删除 + 后台物理删除** | 双倍存储、每个读者都要加 `WHERE deleted_at IS NULL`，把"有界"问题变成"处处记得过滤"问题 |
| **E. 触发器/级联删除** | 把删除成本藏进普通写入，正是"用户发消息时卡一下"的成因 |
| **F. 只删正文、保留行** | `tool_calls` 的主体就是 `params_json`，置空后诊断价值大减而空间收益有限；`governance_observations` 已经在做（且行仍在） |
| **G. 按文件大小裁剪优先** | 用户体验不可预测（"我上周的记录突然没了"）；时间语义更可解释。体积上限作为**后续安全阀**另议 |
| **H. 在 `initSchema` 里加索引** | 首次索引创建可能数秒，正好落在 hook 打开路径上 |

---

## 11. 复杂度增量（Complexity Delta）

| 项 | 是否 | 说明 |
|---|---|---|
| 新的持久化真相源 | **NO** | 配置是配置；marker 是可重建的运行状态，不是业务真相 |
| 新的持久化 schema/状态 | **YES（有限）** | 2 个时间索引 + 1 个 marker 文件 + 1 个 lock 文件；无新表、无迁移。回滚：删文件 / `DROP INDEX` |
| 新的子系统/服务/后台进程 | **NO** | 复用 `pd codex worker` / `pd workbuddy worker` / OpenClaw gateway timer |
| 新的公共抽象 | **YES（1 个）** | core 内一个纯函数 `runTrajectoryRetention(db, policy, ctx)` + 一个 CLI 命令；不新增可插拔接口 |
| 新的运行时开关 | **NO** | 复用 `.pd/config.yaml` 的 `trajectoryRetention.enabled` |
| 新的跨包依赖 | **NO** | 依赖方向不变（adapters → core / host-runtime） |
| 新的宿主特化行为 | **YES** | 三个宿主的"由谁定时"不同；这是真实差异轴，不是投机接口 |
| 新外部/网络能力 | **NO** | 无 |

---

## 12. MVP 四问

- **mvp-q-1（不做会怎样）**：每个宿主每年 +290 MB（Codex）/ +180 MB（WorkBuddy）；`user_turns`、`pain_events` 的全表 `MAX` 随行数线性变慢；备份与云同步持续变大。已在 §1 实测，不是假设。
- **mvp-q-2（怎么观察）**：`pd trajectory retention status --json`、marker 文件、每次运行一行结构化日志、`freelist_count` 与文件大小变化；§7 的 A1–A12 全部可自动断言。
- **mvp-q-3（怎么关）**：`trajectoryRetention.enabled: false` 即停；无 schema 迁移可回滚；已删数据由保守默认值（90 天 + 7 天/轮）与删除清单兜底。
- **mvp-q-4（情绪价值）**：消除"这东西是不是在偷偷吃我硬盘/越用越慢"的不确定感；Owner 能看到一个有界、可解释、可审计的存储，而不是一个只涨不落的黑盒。

---

## 13. 实施顺序建议（供评审，不含代码）

1. 先做**查询修复 + 索引**（§5）：零删除风险，单独可验收 A3/A4。
2. 再做**保留清扫**（§3/§4），默认 `enabled: false` 灰度一个版本，仅 CLI 可跑，验收 A1/A2/A5/A6/A8。
3. 打开 worker 定时（`enabled: true`），验收 A11。
4. 最后提供显式 `vacuum`（§6），验收 A7。
5. `status` / 日志 / 删除清单随第 2 步一起交付。

任何一步不达标都停在该步，不向下叠加。
