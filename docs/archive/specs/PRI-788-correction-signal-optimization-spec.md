# SPEC — 纠正信号检测优化：correction_detected 有效性 / 稳定性 / 可观测

> 工单：PRI-788（伞单）· 子单 PRI-789（G1）/ PRI-790（G2）/ PRI-791（G3）/ PRI-792（G4）
> 日期：2026-09-13/14 · 状态：Approved（Owner 2026-09-14 批准，含持久化选型与种子清单两项裁决）
> 上游事实来源：PRI-783 调查轮（Linear 证据评论）+ 本 SPEC 探查轮（全部结论带 文件:行号 复核）

## 1. 问题陈述

`user_turns.correction_detected` 是纠正信号检测的库表标志位，全库 595 条用户消息 **0 命中**（排除 API 故障因素）。它承担三层职责，全部空转：

1. **自动痛点触发器**：STRONG 命中 → `routeStrong` → `emitPainDetectedEvent(source='user_correction', score=70)` → 自动进 pain→diagnosis→candidate 管线（`openclaw-plugin/src/core/signal-collector-host.ts:315-360`）。
2. **诊断证据增强**：bound pain record 证据构建取"最后一条 correction_detected=1 的用户轮"作为 owner_message 证据（`pd-cli/src/commands/build-trajectory-evidence.ts:73`；`openclaw-plugin/src/hooks/trajectory-evidence.ts:67`）。
3. **质量闭环底座**：`correction_samples`（复核/导出训练样本）唯一写入者 `maybeCreateCorrectionSample` 依赖标志位=1（`openclaw-plugin/src/core/trajectory.ts:1735-1816`）→ 表恒 0 行。

## 2. 根因（代码级，全部已核验）

| # | 根因 | 位置 |
|---|---|---|
| R1 | 能点亮标志位的高精度词表实际仅 7 条：`HIGH_PRECISION_CORRECTION_OVERLAY` 3 条（这是错的/不要自作主张/不应该这么做）+ seed 权重 ≥0.7 的 4 条（搞错了/理解错了/你理解错了/you are wrong）。**学习词（source='llm'）被投影规则硬编码恒为 ambiguous**——学习器学出再好的词也永远无法 STRONG | `host-runtime/src/governance-signal-admission.ts:136-137`（投影）、`:104-108`（overlay）、`:171-180`（seed 权重映射） |
| R2 | Stage2 LLM 确认为 correction 后只触发 pain 事件，**不回写** `user_turns.correction_detected`（全仓无任何 `UPDATE user_turns` API；标志位只在 Stage1 写入一次） | `signal-collector-host.ts:186-218`（写入）、`:229-291`（异步确认后无回写） |
| R3 | Stage2 候选队列**纯内存**（`PendingSignal`）；LLM 不可用/超时/解析失败/调用失败四个分支直接丢弃——实测一天丢 64 条（`SIGNAL_LLM_DEGRADED`/`SIGNAL_LLM_TIMEOUT`/`SIGNAL_LLM_PARSE_FAIL`/`SIGNAL_LLM_FAILED`） | `signal-collector-host.ts:100,217`（内存队列）、`:250-276`（丢弃分支） |
| R4 | 检测健康度只进 `memory/logs/SYSTEM_*.log`（7 天滚动删除），无任何指标产物；停摆 5 天 409 次 `CORRECTION_OBSERVER_CYCLE_FAILED` 无人可见 | `openclaw-plugin/src/core/system-logger.ts:28` |
| R5 | 两个观察者的 `PiAiRuntimeAdapter` 构造不透传 profile 的 `maxTokens`/`timeoutMs`（signal-collector 硬编码 30s）→ 本地思考型模型（lmstudio qwen3.8）小 token 返回空、超时 | `signal-collector-host.ts:443-450`、`correction-observer-service.ts:62-69`、`principles-core/src/runtime-v2/adapter/pi-ai-runtime-adapter.ts:432` |
| R6 | Stage1 关键词为逐字包含匹配；Owner 实际纠正语料（"为什么你总是…"/"我都说了几遍"）与 31 条词库零交集 | `principles-core/src/runtime-v2/signal-collector/keyword-stage.ts:21-72` |

## 3. 目标 / 非目标

**目标**：命中率从 0 → 可用（有效性）；LLM 通道故障不丢信号（稳定性）；健康度一行可见（可观测）。

**非目标**：

- 不改 pain 管线与准入门语义（PRI-642 painIngress 契约不动）；
- 不新增 LLM 通道类型/后台进程（批量确认挂既有 CorrectionObserverService 15min 周期）；
- 不做 Console 集成（`pd config doctor` 已可观测；Console `/api/health` 块列为 follow-up）；
- 不改 STRONG 限流、`strongPainScore`、WEAK→trackFriction 等既有路由语义。

## 4. 契约

### G1 确认回写（PRI-789）

- `PendingSignal` SHALL 捕获 `userTurnRowid`（`recordUserTurn` 返回的 lastInsertRowid，`trajectory.ts:607-630`）。
- `TrajectoryDatabase` SHALL 新增 `markUserTurnCorrection(rowid: number, cue: string | null): void`：
  `UPDATE user_turns SET correction_detected = 1, correction_cue = ? WHERE id = ?`。
  这是该表的第一个更新 API；写权属仍在 plugin `trajectory.ts`（单一写入者，P4）。
- Stage2 确认为 correction 时 SHALL 同时：`routeStrong`（现状不变，含每 session 每小时限流）**并**回写标志。Stage1 已写 1 的轮次 SHALL NOT 重复写（rc-7：以 rowid 精确寻址，不重扫）。
- rowid 不存在（轮次已被清理）SHALL 静默跳过并记 `SIGNAL_WRITEBACK_MISS`（可观测，不阻塞路由）。
- 回写 SHALL 自动点亮下游：证据构建器、`maybeCreateCorrectionSample`、统计视图。

### G2 待确认队列持久化（PRI-790）

**载体（Owner 已裁决）**：trajectory.db 新表，不改 `correction_samples`（其语义为导出训练样本，需 recovery span/diff 等字段，塞 Stage2 候选属语义滥用）。

```sql
CREATE TABLE IF NOT EXISTS signal_confirmations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_turn_rowid INTEGER NOT NULL UNIQUE,
  occurrence_id TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  suggested_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','rejected','abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_signal_confirmations_status
  ON signal_confirmations(status, attempts);
```

（实施注：`occurrence_id` 为实施时新增列——批量确认补发 pain 必须复现 realtime 路径的同一 occurrence 身份，否则 canonical pain 去重失效，违反 ADR-0020 §11.4/rc-6。）

- DDL SHALL 双份同步：plugin `applyTrajectorySchema`（trajectory.ts）与 core `ensureTrajectorySchema`（pain-signal-observability.ts），照 correction_samples 双份纪律。
- **写入**：`detectAsyncAndRoute` 的四个丢弃分支（DEGRADED/TIMEOUT/PARSE_FAIL/FAILED）SHALL 改为入队（`INSERT OR IGNORE`，`UNIQUE(user_turn_rowid)` 幂等）；原 SystemLogger 事件保留，另加 `SIGNAL_CONFIRMATION_QUEUED`。
- **消费**：`CorrectionObserverService` 每轮新增 `batchConfirmPendingSignals(limit=20)`：
  - 取 pending（attempts ASC）→ 逐条过既有 Stage2 classifier（`createSignalLlmClassifierFromConfig` 同源，`resolveLlmClassificationPayload` 同款解析）；
  - `correction` → 回写 G1 + `routeStrong`（pain 事件照发，允许迟到；evidence 标注 `queued_late`，rc-9）→ status=`confirmed`；
  - `none` → status=`rejected`；
  - LLM 失败 → 仅 `attempts++`（照 dead_letter 语义，仍可重试）；`attempts>=5` → status=`abandoned`。
- **状态转移守卫**（照 principle_candidates 乐观锁模式）：`UPDATE ... SET status=?, resolved_at=? WHERE id=? AND status='pending'`——转移失败即跳过该条。
- 队列自身不设总量上限（UNIQUE 按 user_turn 去重，天然有界）；abandoned 保留供统计。

### G3 词库解锁与校准（PRI-791）

- **earned precision**：共享词库投影（`governance-signal-admission.ts:136-137`）SHALL 改为——
  `source='llm'` 默认仍 ambiguous；当该词 `truePositiveCount >= 3 && falsePositiveCount === 0` 时投影为 high（earned）；任一 FP>0 即降回 ambiguous。
  安全姿态不变（LLM 单次建议不能直接产生 STRONG），但打通学习词→STRONG 的唯一通道。唯一权威=投影规则；Observer 输出 SHALL NOT 增加 precision 字段（避免双门）。
- **种子扩充（Owner 已批清单）**：`HIGH_PRECISION_CORRECTION_OVERLAY` 增加
  `我说的是`(0.9) / `不是让你`(0.85) / `谁让你`(0.85) / `又搞错`(0.8) / `都说了`(0.8)，
  category=correction，precision='high'。
- **maxTokens 透传**：两处观察者 adapter 构造 SHALL 补 `maxTokens: cfg.maxTokens`（profile 字段已在 `pd-config-types.ts:85-108`，此前未消费）；`timeoutMs` 透传保持现有行为并在 SPEC 运维章节给出建议值。

### G4 健康度上浮（PRI-792）

- 新 `.state/signal-health.json`（`atomicWriteFileSync` 原子写，照 correction_keywords.json 模式；SignalCollectorHost 与 CorrectionObserverService 共同更新）：

```json
{
  "stage1Strong": 0, "stage2Confirmed": 0, "stage2Queued": 0,
  "stage2Dropped": 0, "pendingCount": 0,
  "lastStage2SuccessAt": null, "observerLastSuccessAt": null,
  "observerConsecutiveFailures": 0, "updatedAt": "…ISO…"
}
```

（当日计数在跨日首写时归零；时间戳为绝对值。）

- `pd config doctor` SHALL 新增 section「Signal detection health」：`DoctorOutput` 加 `signalHealth` 字段（`services/config-doctor.ts:92-115`），渲染插在 Provider health 之后（`commands/config-doctor.ts:105`）。判定：`observerConsecutiveFailures > 4`（≈1 小时无成功轮）或 pendingCount 较上次 doctor 采样持续增长 → `degraded` + nextAction（检查 observer profile/配额/`pd runtime probe`）；文件缺失/损坏 → `unknown` + nextAction，不 crash（rc-1）。

### Owner 侧运维配置（随 G3 生效的建议值）

```yaml
runtimeProfiles:
  pi-ai.<稳定通道>:
    type: pi-ai
    provider: <…>
    model: <…>
    apiKeyEnv: <…>
    timeoutMs: 300000     # 本地模型给足
    maxTokens: 16000      # 思考型模型小 token 回空
internalAgents:
  agents:
    signalCollector:   { enabled: true, runtimeProfile: pi-ai.<稳定通道> }
    correctionObserver: { enabled: true, runtimeProfile: pi-ai.<稳定通道> }
```

（ 是否加免费 fallback 由 Owner 按通道现状决定，SPEC 不强制。）

## 5. 实施切片与顺序

| Slice | 工单 | 内容 | 主要文件 |
|---|---|---|---|
| 0 | PRI-788 | 本 SPEC 入库 | docs/specs/ |
| 2 | PRI-789 | G1 回写 | signal-collector-host.ts、trajectory.ts、trajectory-types.ts |
| 3 | PRI-790 | G2 队列 | trajectory.ts、trajectory-types.ts、pain-signal-observability.ts（core 侧 DDL）、signal-collector-host.ts、correction-observer-service.ts |
| 4 | PRI-791 | G3 词库 | governance-signal-admission.ts、correction-types.ts、correction-observer.ts、两处 adapter 构造 |
| 5 | PRI-792 | G4 健康 | signal-collector-host.ts、correction-observer-service.ts、pd-cli services/commands config-doctor.ts |

切片串行（G2 依赖 G1 的回写方法；G4 统计 G2 的入队数），后片分支基于前片分支（stacked PR，按 2→3→4→5 顺序合并）。

## 6. 测试与验收

- 每 slice：目标套件全绿 + `npm run verify:merge` EXIT=0 + PR（不自动合并）。
- 关键测试面：
  - G1：回写后 evidence builder 可见；rowid 失配负例；Stage1 已置 1 不重复写。
  - G2：入队幂等（UNIQUE）；confirmed/rejected/abandoned 三态；attempts≥5 上限；守卫并发负例；plugin 写→core 读往返。
  - G3：earned 升/降级矩阵（TP/FP 组合）；新种子 STRONG 直判；maxTokens 透传断言；三包相关套件（host-runtime/openclaw-plugin/pd-cli，§19 跨包契约）。
  - G4：健康文件原子写与归零；doctor ok/degraded/unknown 三分支。
- 按仓宪 §14 Pass 2 跑 `npm run error:context`（本 SPEC 根因即 ERR-101 静默失败家族；handoff 时按 record-error 评估落册）。

## 7. Complexity Delta

- 新持久 schema：**YES**（`signal_confirmations`）。理由：Stage2 队列是稳定性核心，内存队列实证日丢 64 条；correction_samples 语义不符不可滥用（P4）。回滚：signal_collector flag off 即停写；表只增不改旧语义。
- 新公共抽象：NO（store 方法属既有 TrajectoryDatabase 深接口）。
- 新子系统/后台进程：NO（挂既有 15min cycle）。
- 新 feature flag：NO（复用 `signal_collector` / `correction_observer` 既有双闸）。
- 跨包依赖面：**YES**（G3 改 host-runtime 共享投影，plugin/CLI 同源消费——既有 seam，非新增依赖）。
- 预估规模：+约 400 行实现 / +约 500 行测试 / 0 删除。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 迟到 pain 事件（批量确认后补发） | routeStrong 既有 rate limit 兜底；evidence 标注 queued_late（rc-9）；诊断管线本就接受延迟输入 |
| earned precision 误升级 | TP≥3 且 FP=0 双门槛 + FP>0 即降；最坏退回现状（ambiguous+LLM 确认） |
| 新表对存量库 | `CREATE TABLE IF NOT EXISTS` 惰性建，无迁移脚本需求 |
| 回归波及 | 每 slice 独立 revert；总开关=既有双 flag；stacked PR 按序合并 |

## 9. 与既有契约的关系

- PRI-642 painIngress（submit/degrade/refuse 语义、painIngress.v1 payload）：不变。
- ADR-0020 §11.4（occurrence 去重身份）：G1/G2 均以 user_turn rowid 寻址，不引入第二身份源。
- PRI-737 退役的 evolution worker：不复活；批量确认挂在 CorrectionObserverService（活跃服务）。
