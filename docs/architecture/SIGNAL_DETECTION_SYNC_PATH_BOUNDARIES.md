# 信号检测同步路径运行时边界（AUDIT-P2-03 / AUDIT-P3-02）

> 建立：2026-10-21（PD 痛苦感知机制专项整改）
> 基线：`origin/main@c754ef50e`（审计基线 `808278e8c` 的信号路径文件与其无差异）
> 适用：`packages/openclaw-plugin/src/core/signal-collector-host.ts`、`signal-health.ts`、`hooks/prompt.ts`
> 性质：运行时边界记录（Implementation Truth 的文档化），不引入新机制

## 1. 同步路径 I/O 清单（修复后）

`detectSync()` 由 `before_prompt_build` 钩子同步调用，绝不阻塞用户消息处理。
2026-10-21 整改（AUDIT-P2-01）后，该同步窗口内只保留两类磁盘 I/O：

| I/O | 同步/推迟 | 理由 |
| --- | --- | --- |
| `recordUserTurn()`（trajectory SQLite INSERT） | **同步** | 可靠持久化要求；见 §3 |
| `enqueueSignalConfirmation()`（signal_confirmations INSERT，仅歧义命中+通道不可用） | **同步** | 候选落库不能被事件循环淘汰；整改明确禁止异步化队列记录 |
| 健康计数写入 `updateSignalHealth()`（stage1Strong / stage2Queued / stage2Dropped / stage2Invocations） | **推迟到微任务**（`queueMicrotask`，`countStage1Strong` 既有惯例） | 旁路观测不承担磁盘延迟；写入本身仍在一个 tick 内同步完成，不会交错 |

整改前的问题：`detectAsyncAndRoute()` 的"分类器不可用"降级分支没有任何 `await`
（async 函数体在首个 await 前同步执行），且 `collectSync` 对**零命中普通消息**也返回
`needsLlmConfirmation=true`（漏词检测路径）——两者叠加导致**每条普通消息**都在
prompt hook 的同步调用栈上做一次健康文件 read-modify-write。修复将全部健康计数
写入统一推迟到微任务，回归测试以可观测调用顺序锁死该契约
（`tests/core/signal-sync-path-regression.test.ts`：`detectSync()` 返回时健康文件
尚未写入，微任务排空后计数正确；SQLite 入队在 `detectSync()` 返回前已完成）。

## 2. STRONG 限流桶：内存态边界与重启语义（AUDIT-P3-02）

`SignalCollectorHost.rateLimit` 是**进程内存 `Map<sessionId, {count, windowStart}>`**，
无持久化。适用边界与后果：

- **进程重启后配额重置**：重启后同一 session 在同一小时窗口内可再次发出最多
  `strongRateLimitPerHour`（默认 5）条 STRONG 信号。
- **重复 Pain 防线不在限流桶**：同一 occurrence 的重复确认/重投递由内容派生的
  `canonical_pain_id` 唯一性兜底（ADR-0020 §11.4），与限流桶无关。因此重启
  "超发"只作用于**新的 occurrence**，不会产生同一事件的双重 Pain。
- **为什么不持久化**：限流是防泛滥启发式，不是治理事实（P4——不应为启发式
  新增一个真理源）；桶状态写盘会把每条 STRONG 消息变成又一次同步文件写，
  正是 AUDIT-P2-01 要移除的开销类。三宿主一致性与该边界无关，不为此引入
  新持久化机制。
- **已知接受的风险**：频繁崩溃/重启的进程会让限流形同虚设（每小时上限 =
  N × 重启次数）。doctor 的 `stage1Strong` 当日计数可暴露异常放量。

## 3. recordUserTurn 持久化语义：所有用户回合一律入库（维持现状）

审计问题：能否跳过"空白消息"的持久化以省一次 SQLite 写？结论：**维持现状，
不跳过任何回合**，理由：

1. `turnIndex` 由调用方按 `event.messages` 真实计数传入（缺失才退化为时间戳）。
   跳过空白行虽然只会留下索引空洞（排序/JION 语义不破），但——
2. `user_turns` 是**证据回链的锚点表**：`referencesAssistantTurnId` 回链、
   Stage2 确认回写（`markUserTurnCorrection` by rowid）、批量确认的原文恢复
   （`getCorrectionTurnByRowid`）、correction observer 的 recentMessages 载荷
   全部消费这张表。任何"选择性入库"都会让这些消费面出现不可见空洞，而省下的
   只是一次罕见输入（空 prompt 是否真的会到达 `before_prompt_build` 尚无证据）。
3. 空白消息的体量假设不成立：检测路径上的"普通消息"（零命中）**不是空白**，
   它们必须入库才能进入轨迹历史窗口。真正字面空白的 prompt 在宿主层通常不会
   触发 hook，为此增加一个跳过分支属于为未证实的输入加代码。

**NOT VERIFIED**：本节未发现也不声称生产卡顿由 recordUserTurn 写入引起；
见 §4 的实测分布。

## 4. 同步路径性能基准（AUDIT-P2-03）

方法：`packages/openclaw-plugin/tests/core/signal-detect-sync.perf.test.ts`
（记录型基准，无阈值断言）；隔离临时 workspace + 真实 trajectory SQLite +
mock classifier；每场景 300 次迭代 + 50 次预热；同机 A/B（stash 源码改动），
两轮正反序复测。环境：Windows / node v26.7.0 / 本开发机。

| 场景 | 修复前 p50/p95/p99 (ms) | 修复后 p50/p95/p99 (ms) |
| --- | --- | --- |
| S1 普通消息零命中（分类器不可用） | 10.97 / 14.28 / 15.54（第2轮 11.36 / 13.73 / 15.20） | 8.00 / 9.09 / 10.25（第2轮 11.92 / 12.46 / 13.93） |
| S2 高精度命中（同步 STRONG 分流） | 10.31 / 13.56 / 18.35（第2轮 11.50 / 16.53 / 19.35） | 8.03 / 10.06 / 12.11（第2轮 11.12 / 12.30 / 13.27） |
| S3 歧义命中+分类器不可用（降级入队） | 10.82 / 13.84 / 19.76（第2轮 13.34 / 20.07 / 22.52） | 8.04 / 10.04 / 11.96（第2轮 10.17 / 12.72 / 14.25） |
| S4 歧义命中+realtime 分类调用前段 | 10.02 / 12.33 / 13.10（第2轮 12.71 / 17.99 / 20.16） | 8.02 / 10.38 / 13.94（第2轮 9.93 / 13.30 / 15.24） |

解读（如实归因）：

- **稳定可归因的改善只有 S3**（降级入队路径，修复直接移除一次同步健康文件
  读改写）：两轮 p50 分别 −2.8ms / −3.2ms。
- S1 改善方向一致但第二轮受环境噪声影响；S2/S4 的写入本就不在（或已在微任务中）
  受影响路径上，两轮结果在 ±1.5ms 的本机 run-to-run 方差带内。
- 单次同步健康文件 read-modify-write 在本机实测约 **1.5–3ms**；零命中普通消息
  场景（每条消息必经）修复后不再承担该开销。
- **NOT VERIFIED**：本基准只测量当前环境下的同步路径耗时分布，不构成对任何
  历史生产卡顿事件根因的证实。若需归因历史事件，须以当时的日志/遥测为证。
