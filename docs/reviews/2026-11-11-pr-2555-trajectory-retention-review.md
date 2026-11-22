# PR #2555 独立代码评审 — 轨迹保留期（SPEC-PD-TR-001）

- PR：<https://github.com/csuzngjh/principles/pull/2555>（OPEN）
- head：`ai/adhoc-20261111-trajectory-retention-ccf091` @ `06bbb26b7`
- base：`main` @ `c6cd0baa1`
- 评审时间：2026-11-11
- 方法：逐个条款读实现 → 在 `os.tmpdir()` 造合成库跑真实入口 → 对核心引擎做 5 个变异，验证测试是否真的变红。全程未打开 `~/.codex`、`~/.workbuddy`、`~/.openclaw` 下任何真实库，未改动/推送 PR 分支。

---

## 结论

**不可合（当前形态）。**

两个合并前必修项：

| ID | 级别 | 问题 |
|---|---|---|
| F1 | P1（不可逆数据丢失） | marker 里一个**可解析但在未来**的 `lastCutoff` 会让下一次运行把**保留窗口内的新数据**一并删掉；系统时钟走快数天再校正就能走到这条路径 |
| F2 | P1（宿主卡顿） | 每次运行都会执行的索引 DDL 在“索引缺失 + 有并发写”时同步阻塞 **5.7 s**，直接违反 PR 自己写的 A8（≤300 ms）和 A1（≤3 s），且 DDL 失败后每轮重试、每轮再卡 5.7 s |

修掉 F1、F2 后可重新评审；F3–F4 属于“失败能不能被发现”，建议同一轮修；其余为跟进项或文档一致性问题。

PR 描述里“marker 损坏时以库内最早记录为基线，不会一次删掉大段历史”只对**缺失/不可解析**的 marker 成立，对“可解析但不可信”的 marker 不成立；A8 的 ≤300 ms 只在索引已存在时成立。这两条是本次评审最主要的待核实主张，均被证伪。

---

## 一、硬问题（会丢数据 / 会让宿主卡住）

### F1 [P1｜会删掉不该删的数据] 未来的 `lastCutoff` 被当成可信下界，导致删除保留窗口内的数据

**位置**

- `packages/principles-core/src/runtime/trajectory-retention.ts:388-399`：`effectiveCutoff = min(computed, lastCutoff + 7d)` 之后又执行 `max(lastCutoff, ...)`，对 `lastCutoff` 只有“可解析”校验，没有“不得晚于 `computedCutoff` / 不得晚于现在”的可信性校验。
- `packages/host-runtime/src/trajectory-retention.ts:499-506`：只有 `lastCutoff === null` 才回落到库内最早记录。
- `packages/host-runtime/src/trajectory-retention.ts:515-529`：时钟类跳过只把 `lastRunAt` 推进到 `now`，**故意保留** `lastCutoff`——这正是把危险值保留到下一轮的地方（代码注释把它当成修复，实际是放大了风险）。
- `packages/principles-core/src/runtime/trajectory-retention.ts:248-257`：marker 字段只做 `Date.parse` 校验，未来时间戳被视为合法。

**影响**

任一条成立即删除 4 张表的**全部历史（含 1 天前的行）**，不可恢复：

1. marker 被外部编辑/从别的机器或备份恢复，`lastCutoff` 是未来时间；
2. 系统时钟被设到未来若干天并持续跑过几轮维护，`lastCutoff` 随之前进；时钟校正后第一次是 `clock_backwards`（只修 `lastRunAt`），**下一次运行**用未来的 `lastCutoff` 删除。

**证明（合成库，真实 `runTrajectoryRetention` 入口）**

- 探针 P1：90 天策略，预置 200 天前 / 100 天前 / **1 天前**各一行；marker 为合法 JSON，`lastCutoff = now + 3650d`，`lastRunAt = now - 8h`。一次 `trigger: 'manual'` 的结果：`outcome=completed`，`deleted.tool_calls=3`，剩余 **0** 行——1 天前的行被删。
- 探针 P1b（更现实的时钟路径）：`lastRunAt = now + 5d`、`lastCutoff = now + 3650d`。第 1 次：`skipped / clock_backwards`，marker 里 `lastRunAt` 被改成 `now`、`lastCutoff` 仍是未来；第 2 次（+1h）：删除 2 行，剩余 0。

**与 SPEC 的关系**

SPEC §3.3 把 `effectiveCutoff 取 max(lastCutoff, ...)` 写成了设计（“单调不回退”），但没有给 `lastCutoff` 设可信上界；§7 A9 只测“单次 +400 天 / −400 天各跳一次”，没有覆盖“时钟走快一段时间后再校正”。所以这不是单纯实现跑偏，而是 **SPEC 与实现共同的设计漏洞**——但删除是不可逆的，不能靠“marker 一般不会坏”兜底。

**建议修法（小改）**

- 读取 marker 时：`lastCutoff > computedCutoff`（或 `> now`）一律视为不可信 → 丢弃 `lastCutoff`，回落到 `oldestStoredTimestamp`（与“marker 丢失”同一条保守路径）；
- 或在 `computeRetentionCutoff` 里把 `effectiveCutoffMs` 再夹一次：`effectiveCutoffMs = Math.min(effectiveCutoffMs, computedCutoffMs)`；
- 补测试：未来 `lastCutoff`、`lastRunAt` 未来 + `lastCutoff` 未来、`lastCutoff` 超前于 `computedCutoff` 三种输入都断言“只删 7 天推进量 / 或 0 行”。

---

### F2 [P1｜会卡住宿主] 缺索引时 DDL 在争用下同步阻塞 5.7 s，且每轮重试；违反 A8/A1

**位置**

- `packages/host-runtime/src/trajectory-retention.ts:541-555`：先 `busy_timeout = 5000` 跑 `ensureRetentionIndexes`，再恢复 100 ms。
- `packages/host-runtime/src/trajectory-retention.ts:64-70`：常量 `TRAJECTORY_RETENTION_WRITE_LOCK_WAIT_MS = 100`、`TRAJECTORY_RETENTION_DDL_BUSY_TIMEOUT_MS = 5000`；注释假设“DDL 每个表只跑一次”，但**失败时索引不会创建**，下一轮还会再跑。
- 调用点同进程同步执行：`packages/pd-cli/src/commands/codex-worker.ts:38-61`、`packages/pd-cli/src/commands/workbuddy-worker.ts:39-62`、`packages/host-runtime/src/trajectory-retention.ts:755-780`（OpenClaw gateway 的 `setInterval` tick）。OpenClaw 下这是阻塞 gateway 事件循环。

**影响**

- 工作区第一次清扫（索引尚不存在），或 DDL 因任何原因失败后，只要此时有另一个写事务占着锁，维护进程在 DDL 阶段最多等 5 s；等完失败，继续用 100 ms 去删（通常立即 `deferred:busy`），整轮 0 行删除但已经卡了 5.7 s。
- 因为没有“DDL 失败退避”，每 120 s 的 worker cycle / 每 6 h 的 gateway tick 都会重试并再次卡 5.7 s（实测连续两次）。
- `totalDurationMs` 不受 `runBudgetMs` 约束（预算只在批引擎里检查），所以 A1 的 3 s 也被突破。

**证明（合成库）**

- 探针 P5a（索引已存在 + 另一连接持有 `BEGIN IMMEDIATE`）：`deferred:busy`，0 行删除，**165 ms**——A8 成立。
- 探针 P5b（索引缺失 + 同一把写锁）：第 1 轮 **5694 ms**、第 2 轮 **5726 ms**，`indexesError = "database is locked"`，两轮都 0 行删除。`totalDurationMs` 同为 5.7 s 量级。
- 现有测试抓不到：core 的 busy 测试直接调 `runTrajectoryRetentionBatches`，绕过了 DDL；host 测试没有任何 busy 用例；CLI 测试只测注册。**A8 在测试里实际上没有被覆盖。**

**建议修法**

- DDL 前先查 `sqlite_master`：本次要建的索引都已存在 → 完全跳过，不进入写事务；
- DDL 等待上限降到与预算同量级（例如 250–500 ms），或把“DDL 失败”持久化到 marker 并退避（失败后 6 h 内不再重试）；
- 把 DDL 耗时计入 `totalDurationMs` 的硬预算，超预算直接 `partial` 退出；
- 增加 host 级用例：索引缺失 + 持锁 3 s → 断言 ≤300 ms 且 0 行删除（与 A8 原文一致）。

---

### F3 [P2｜失败不可见] `config_invalid` / `degraded` 在所有后台路径完全静默

**位置**

- `packages/host-runtime/src/trajectory-retention.ts:355-378`：配置非法/降级 → `outcome: 'skipped'`，不删任何行。
- `packages/host-runtime/src/trajectory-retention.ts:706-719`：`retentionWarning` 的 `persistent` 列表**不包含** `config_invalid:` 与 `degraded:`，因此返回 `null`。
- `packages/pd-cli/src/commands/codex-worker.ts:50`、`packages/pd-cli/src/commands/workbuddy-worker.ts:51`、`packages/host-runtime/src/trajectory-retention.ts:766`：`skipped` 且删除 0 行 → 直接 `return`，不写日志。

**影响**

`.pd/config.yaml` 里一个拼写错误（例如 `retentionDays: "ninety"`）就会让保留期**永久关闭且没有任何日志**；磁盘继续增长，Owner 无从发现。CLI 手动执行会退出 1（`retentionExitCode` 已覆盖这两个前缀），所以不一致在于“后台路径静默、前台路径报错”。

**证明**：探针 P7a —— `config_invalid: ...` → `retentionWarning(report) === null`。

**建议修法**：把 `config_invalid:`、`degraded:` 加进 `persistent`（它们在 CLI 的失败前缀表里已经有，属于明显遗漏）。

---

### F4 [P2｜误导性观测] `status` 的 “Expired now” 用的不是实际截止线

**位置**

- `packages/host-runtime/src/trajectory-retention.ts:804+`（`readTrajectoryRetentionStatus`）用 `now - retentionDays` 统计各表“过期行数”，忽略 `lastCutoff` / 7 天推进上限；
- `packages/pd-cli/src/commands/trajectory-retention.ts:139-144` 原样打印为 `Expired now`。

**影响**：首轮/重建 marker 后，status 可能显示 3 行“已过期”，而下一轮实际只删 1 行甚至 0 行（探针 P7b：status=3，实际删除=1，cutoff 只推进到 `oldest+7d`）。另外配置降级时仍按默认 90 天统计，会给出“有积压”的假象。不涉及数据安全，但会让 Owner 误判进度。

**建议**：status 明确区分 “eligible under policy” 与 “deletable at the next effective cutoff”，或直接复用 `computeRetentionCutoff` 计算。

---

### F5 [P3｜语义漂移] 不变量违例后 `lastRunAt` 被推进，与 SPEC §4.5 相反

**位置**：`packages/host-runtime/src/trajectory-retention.ts:592-595`（`busyOutcome ? marker.lastRunAt : now`）；SPEC §4.5 第 202 行明确要求“保留 marker 的 `lastRunAt` 不变（即下一轮仍会尝试）”。

**影响**：worker 模式下不变量违例后的重试要等一个 `intervalHours`（默认 6 h），而不是下一个 120 s cycle。`partial` / `deadline` 推进 `lastRunAt` 是设计如此，但 `invariant_violation` 不是。要么改代码，要么改 SPEC。

---

### F6 [正面结论] 已正确 fail closed 的路径

以下路径经实测/读码确认不会“静默当成成功”：

- 审计清单写失败 → 该批不删、`partial`、`reason=audit_failed:...`（探针 P6：导出目录是普通文件时 0 行删除，1 行保留）；
- marker 缺失 / 不可解析 → 回落 `oldestStoredTimestamp`，首轮 7 天封顶（探针 P3：400 天基线 → cutoff=393 天，只删 395 天行与 400 天 governance 行）；
- 截止线严格 `<`、边界行保留（探针 P2：恰好 90 天的行保留，早 1 ms 的行删除）；
- governance 只看 `expired_at` 且只删 `expired` / `rolled_back`（探针 P4：`operational` / `promoted` / `quarantined` / 新鲜 `expired` / `expired_at IS NULL` 全部保留）；
- 批内 `pre - post === changes()` 校验、违例回滚（变异测试见下）；
- 锁已被占用/损坏 → 本轮不删（`tryAcquireExclusiveLockSync` 失败即 `skipped:locked`）。

---

## 二、测试有效性（变异验证）

基线：三套相关测试本地全绿 —— core 28/28、host-runtime 23/23、pd-cli 8/8。

把实现改坏后重跑对应测试（只改临时副本，不动 PR 分支）：

| 变异 | 改法 | 结果 | 是否抓到 |
|---|---|---|---|
| 边界比较 | `created_at < ?` → `<= ?` | 1 个用例红（“keeps the row exactly on the cutoff...”） | 是 |
| 谓词 | 删除 `extraPredicate` | 1 个用例红（“never touches governance_observations outside expired/rolled_back”） | 是 |
| 推进上限 | `capped = lastCutoff + 7d` → `MAX_SAFE_INTEGER` | 1 个用例红（“advances the cutoff at most 7 days per run”） | 是 |
| 不变量 | `if (pre - post !== changes)` → `if (false)` | 1 个用例红（“rolls the batch back...”） | 是 |
| 配置降级 | 去掉 `retentionDays < 7` 的拒绝 | 1 个用例红（“degrades ... below the accepted minimum”） | 是 |

结论：**核心引擎的测试是有效的**，不是“看起来覆盖了”。但仍有三个真实缺口：

1. **DDL + 争用** 没有任何用例（F2 就是这么漏出去的）；
2. **未来/不可信 `lastCutoff`** 没有用例（host 测试反而用 “recovers from a long clock gap ...” 固化了“保留 stale cutoff”的行为，但 stale 取的是 150 天前，不是未来）；
3. **A3（hook ≤15 ms、0 次 DB 打开）、A4（查询 p95）** 可本地断言却没有测试；A6（kill -9）、A11（稳态）按 SPEC §9 列出为不可本地证明，可接受，但 A3/A4 不应该缺。

---

## 三、SPEC 与代码逐条对照

| SPEC 条款 | SPEC 承诺 | 代码实际 | 结论 |
|---|---|---|---|
| §3.2 | `created_at < cutoff`，严格小于 | 严格 `<` | 一致（已实测边界） |
| §3.3 | 截止线每轮最多前进 7 天 | `lastCutoff + 7d` 封顶 | 一致（已实测） |
| §3.3 | marker 缺失/损坏 → `MIN(时间列)` 基线 | `lastCutoff === null` → `oldestStoredTimestamp` | 一致，但“损坏”仅指不可解析（见 F1） |
| §3.3 | `effectiveCutoff = max(lastCutoff, ...)` | 同 | 一致，但正是 F1 的来源 |
| §4.2 | 运行级 `preCount` / `postCount` 校验 | 改为**每个事务内** pre/post | 不一致（更强，但 SPEC 未更新） |
| §4.4 | 删除写路径 `busy_timeout=100`；DDL 单独 5000 | 一致 | 一致；但 DDL 时间不进预算，A8 在缺索引时不成立 |
| §4.4 | “`production-pain-evidence.ts` 打开轨迹库没有 busy_timeout” | 实际已在 `:352`、`:469` 设为 5000 | SPEC 过时（对实现有利） |
| §4.5 | 不变量违例后保留 `lastRunAt` | 推进 `lastRunAt` | 不一致（见 F5） |
| §4.5 | marker 只在 postCount 校验通过后写 | 任何 outcome 都写 marker（`lastCutoff` 仅 completed 推进） | 不一致（实现更合理，SPEC 需改） |
| §4.6 | 锁内容 `{runId,host,pid,startedAt}`；损坏 → `lock_corrupt` | 实际为 `"<pid> <token> <createdAt>"`；损坏只报 `locked` | 措辞不一致（低） |
| §5.2 | DDL 集中定义在 `trajectory-schema.ts` | 分散在 core `trajectory-retention.ts:452-457` + host `:74-77` | 不一致（低） |
| §6.2 | 空间 ≥2×+10%、`busy_timeout=5000`、默认 dry-run、`--yes` 才执行 | 一致 | 一致 |
| §7 A1 | 单次运行 p95 ≤3 s / 最坏 ≤3.5 s | 缺索引 + 争用时 5.7 s | **不达标** |
| §7 A5 | 运行级 `pre−post == Σchanges` | 每批内断言（语义等价/更强） | 需改 SPEC |
| §7 A8 | 争用 3 s 时 ≤300 ms 让路 | 索引已存在 165 ms；缺索引 5.7 s | **不达标** |
| §7 A9 | 单次时钟跳变删 0 行 | 单跳成立；“走快一段时间再校正”未覆盖且会删光 | 用例设计缺口（F1） |
| §7 A3/A4 | hook 延迟 / 查询 p95 | 无测试 | 未验证 |
| §7 A6/A11 | kill -9 / 稳态 | 无测试 | SPEC §9 已声明不可本地证明 |
| §8.2 | 审计 fail closed；`correction_samples` 用 LEFT JOIN | 一致 | 一致 |
| §13 | 第 2 步“默认 `enabled: false` 灰度一个版本” | `TRAJECTORY_RETENTION_DEFAULTS.enabled = true`（core:26） | 与 §3.1（默认 true）自相矛盾；实现选了更激进的一侧 |
| §13 | 分 4 步交付 | 一个 PR 全量交付 | 与 SPEC 的实施顺序不一致，需 Owner 明确接受 |

---

## 四、非阻塞问题（写法 / 观测 / 残留）

1. `signal_confirmations.user_turn_rowid` 指向 `user_turns` 的 rowid；保留期会删除 90 天前的 turn，留下悬空 id。目前没有消费者按该 id 回读正文（`excerpt` 已冗余存储），所以不是活 bug，但 SPEC §8.2 只写了 `correction_samples` 的引用断裂，建议补一句或在后续 PR 处理。
2. 保留期删除 `assistant_turns` 会让对应 blob 文件变成孤儿；blob 清理被 `blobWrittenInProcess` 门控（`openclaw-plugin/src/core/trajectory.ts:1808-1810`）且 24 h 节流。正常写 blob 的进程会回收，但“已停写”的工作区不会——属于磁盘残留，不是数据丢失。
3. `skipReport` 的 `deletedByTable` 固定返回 4 个 0（host:288-290、325），而成功路径只返回实际存在的表；`--json` 的 shape 在 skipped/completed 之间不一致，脚本消费方要兼容两种形状。
4. 插件测试 `packages/openclaw-plugin/tests/core/trajectory.test.ts` 里 `exportCorrections ... sample-live` 这个用例先把样本的 turns 删掉再断言，实际只覆盖“已 purge”路径，名字容易让人以为覆盖了“live”路径。建议补一个 live 样本断言（正文非空、`source_turns_purged=false`）。
5. `pd-cli/src/index.ts` 新增的 `invokedDirectly` 用 `pathToFileURL(path.resolve(argv[1])).href === import.meta.url` 判断入口。Windows 下 URL 比较大小写敏感，若宿主用不同大小写的盘符/路径调用，可能静默不解析命令。建议加一个 Windows 冒烟测试，或改用大小写不敏感比较。
6. `oldestStoredTimestamp` 在 `ensureRetentionIndexes` **之前**执行（host:503-506 vs 541-546），首轮 `MIN(created_at)` 用不上本次要建的索引；大库上是可省的一次全表扫。
7. `retentionWarning` 的去重表按 workspace 记“最后一次原因”，原因在两个持久错误之间来回切换时可能吞掉一次提示。低风险。

---

## 五、证据与边界

- 所有实验都在 `os.tmpdir()/pd-review-2555-*` 的全新合成库里完成；探针只调用公开入口 `runTrajectoryRetention` / `readTrajectoryRetentionStatus`，没有打开任何真实用户库。
- 变异测试使用核心模块的临时副本（`.tmp/review-2555/`），未修改 PR worktree 的受版本控制文件；评审后已删除。
- 未合并、未推送、未 force push、未改动 `ai/adhoc-20261111-trajectory-retention-ccf091`。
- 基线：core 28/28、host-runtime 23/23、pd-cli 8/8 全绿；5/5 变异被对应测试抓到。
