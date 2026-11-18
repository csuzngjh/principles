# PD-Lab v0.3 T0 现实映射报告（Reality Map）

| 属性 | 内容 |
| --- | --- |
| 工单 | PRI-1251 [R0]（HANDOFF T0） |
| 核验基线 | worktree `ai/PRI-1251-r0-blob-snapshot`，基于 `origin/main` `9dd5b01f9dcdb6b50258d850443051aadd480443`（2026-11-17） |
| 性质 | 只读审计报告 + 术语同步；不改任何代码或数据 |
| 上游 | TECH-PD-LAB-EXPERIMENT-INTEGRATION-001 v0.3 §2.2 三项"未核验，T0 必须补齐" |

## 1. 实验工作区运行是否触发轨迹保留清扫（仍成立 → 结论：不触发）

### 1.1 被核验的两个命令

- `pd diagnose run`：`packages/pd-cli/src/commands/diagnose.ts:1-44`。该文件的 import 集合（`RuntimeStateManager`、`SqliteContextAssembler`、`SqliteTrajectoryLocator`、`SplitDiagnosticianRunner` 等）中**没有任何保留清扫入口**；全文无 `retention` 引用（`grep -n "retention" diagnose.ts` 零命中）。
- `pd runtime internalization run-once`：`packages/pd-cli/src/commands/runtime-internalization-run-once.ts:1-45`。import 集合只含内化编排（`InternalizationOrchestrator`、各 Peer Runner、`PrincipleTreeLedgerAdapter` 等）；全文无 `retention` 引用。
- 佐证（同一命令族）：`pd pain record`（`packages/pd-cli/src/commands/pain-record.ts`）同样零 `retention` 引用——实验 harness 的三步链（pain record → diagnose run → run-once）整体不触碰保留引擎。

### 1.2 保留清扫的真实触发面（全部生产调用方）

核心引擎 `runTrajectoryRetentionBatches` 与策略解析在 `packages/principles-core/src/runtime/trajectory-retention.ts`（纯逻辑，`TRAJECTORY_RETENTION_DEFAULTS` 于 25-31 行：默认 `enabled: true, retentionDays: 90`）；I/O 边界在 `packages/host-runtime/src/trajectory-retention.ts`（`runTrajectoryRetention` 403 行起、`scheduleTrajectoryRetention` 793-839 行）。生产调用方只有四类：

| 触发方 | 源码位置 | 触发方式 |
| --- | --- | --- |
| Codex 常驻 worker | `packages/pd-cli/src/commands/codex-worker.ts:38-60`（`runRetentionAfterCycle` 调 `runTrajectoryRetention({trigger:'worker'})`），209/226 行调用 | 每个周期结束后 |
| WorkBuddy 常驻 worker | `packages/pd-cli/src/commands/workbuddy-worker.ts:41-43, 196, 210` | 同上 |
| 手动 CLI | `packages/pd-cli/src/commands/trajectory-retention.ts:105`（`trigger:'manual'`） | 显式执行 |
| OpenClaw 网关进程内调度 | `packages/openclaw-plugin/src/index.ts:634` → `core/trajectory-retention-trigger.ts:17-21` → `scheduleTrajectoryRetention` | 插件初始化后 60 秒首跑，之后按 `intervalHours`（默认 6h ± 5min 抖动） |

引擎侧亦有防线：核心文件头注释（trajectory-retention.ts:9-11）明确索引创建"never called from a hook/open path"；host-runtime 调度器（793-839 行）刻意不在调度时刻同步执行清扫。

### 1.3 结论与配置关闭键

**结论：仍成立（对实验工作区无威胁的准确表述是——`pd diagnose run` / `pd runtime internalization run-once` / `pd pain record` 不会触发清扫）。** 只有在实验工作区里启动 `pd codex-worker` / `pd workbuddy-worker` 常驻进程，或在该工作区初始化 OpenClaw 插件（`scheduleTrajectoryRetentionForWorkspace`），清扫才会发生；PD-Lab harness（`ab-run.mjs` 链）不属于任何一种。

尽管如此，实验工作区从生产模板派生配置时，`trajectoryRetention` 段会被一并继承（默认 `enabled: true`）。为防御性关闭（TECH §4.3 第 2 步允许在派生配置声明该段），准确关闭键以 `resolveTrajectoryRetentionPolicy`（`packages/principles-core/src/runtime/trajectory-retention.ts:107-202`）为准，二选一：

1. `trajectoryRetention.enabled: false`（121-125 行读取，436-444 行在 host 侧以 `retention_disabled` 跳过）；
2. `trajectoryRetention.retentionDays: 0`（131-134 行：`enabled` 置 false 并标记 `disabledByZeroDays: true`，语义是"Owner 明确要求不清扫"，跳过原因为 `retention_days_zero`）。

注意两点 fail-closed 语义（不适用于关闭场景但易误读）：配置段含未知键/非法值时 `degradedReason` 置位、清扫删除 0 行（112-119 行等）；`.pd/config.yaml` 整体加载失败时同样跳过且不删除（`packages/host-runtime/src/trajectory-retention.ts:414-423`）。`retentionDays` 合法范围 7–3650（34-35 行），**不存在**一个合法的正数天数值能表达"关闭"；只有上述两个键。生产保留策略本票未做任何修改。

## 2. Codex / WorkBuddy 采集路径的保存方式与上限（对照 500 字符预览、16KB Blob 外置）

### 2.1 OpenClaw 路径（对照基准，已核验）

- 长轮次外置：`packages/openclaw-plugin/src/core/trajectory.ts:83` `DEFAULT_INLINE_THRESHOLD = 16 * 1024`；`storeRawText`（1888 行起）：超过 16KB 的正文写入 `<workspace>/.state/blobs/<kind>-<sha256>.txt`（blob 目录由 `resolvePdPath(workspaceDir,'TRAJECTORY_BLOBS_DIR')` 解析，`packages/openclaw-plugin/src/core/paths.ts:54` 定义为 `.state/blobs`），库内 `assistant_turns`/`user_turns` 只留 `blob_ref` 与 ≤200 字符 `raw_excerpt`（1889 行 `text.slice(0,197)+'...'`；插入语句 413-417、442-446 行）。**事实仍成立。**
- 工具返回预览：`packages/openclaw-plugin/src/hooks/after-tool-call-helpers.ts:27` `RESULT_PREVIEW_MAX_LENGTH = 500`；57-58、77-78 行超过 500 字符截断并以 `...` 结尾。库里只存预览，**事实仍成立**。
- 引申事实（快照设计输入）：orphan blob 清扫（`pruneUnreferencedBlobs`）的"被引用"集合只取 `assistant_turns` ∪ `user_turns` 的 `blob_ref`（同一文件内 UNION 查询），孤儿宽限 7 天（85 行 `DEFAULT_ORPHAN_BLOB_GRACE_DAYS`）；清扫仅在本次进程确实写过 blob 后按间隔触发（`maybePruneUnreferencedBlobs`，364 行调用）。

### 2.2 Codex 路径（结论：无 500/16KB 机制，正文上限由文本策略与工具事实 JSON 决定，全文留在宿主自己的 rollout 文件）

- 会话源文件：Codex 自己的 rollout JSONL。根目录解析 `packages/codex-adapter/src/ingestion/codex-home.ts:33-47`（`CODEX_HOME` 或 `~/.codex`）；按精确 uuid 定位、绝不扫描其他会话文件（`transcript-source.ts:45-60`、`catch-up.ts:4-14`）。PD **不复制**该文件，全文保真由宿主负责。
- 读取上限：每次调用单窗口最多 1 MiB（`packages/host-runtime/src/conversation-ingestion/source.ts:25-26` `CONVERSATION_INGESTION_MAX_BATCH_BYTES = 1024*1024`）；catch-up 默认每次最多 8 个 rollout（`catch-up.ts:31`）。
- 落库方式：解码为 **governance observations**（`governance_observations` 表，与 `pain_events` 同在 `<workspace>/.state/trajectory.db`，见 `packages/host-runtime/src/governance-observation-store.ts:19, 388`）。**不写** `assistant_turns`/`user_turns`/`tool_calls`（这两个表只有 openclaw-plugin 与 legacy 导入写）。
- 长轮次上限：`visible_text` 按同意分层文本策略截断——`packages/host-runtime/src/conversation-ingestion/text-policy.ts:26-27`：bounded 层 200 字符（默认，带 `___TRUNCATED___` 后缀实际最长 215）；full 层 20,000 字符，仅当宿主同意记录为 `granted` 且披露版本不低于当前版本时可达（65-77 行）。策略经 `pipeline.ts:243-246` 传入 store。
- 工具返回：`CommandExecution` 记录存进 `toolFacts`（`packages/codex-adapter/src/ingestion/transcript-decoder.ts:378-413`）：`command` 数组最多保留 8 段（405 行 `slice(0,8)`）；`stdout`/`stderr` 按 rollout 记录原样进 `toolFacts`（391-407 行），随后整个 `toolFacts` 被 JSON 列上限 8,000 字符约束（`governance-observation-store.ts:46` `MAX_JSON_COLUMN = 8_000`，194-212 行超限降级为 `{"truncated":true,"preview":...}`）。
- 隐私边界：reasoning 的 `encrypted_content` 永不读取，只存可选明文 `summary`（transcript-decoder.ts:180-197）。

**与 OpenClaw 的对照结论：Codex 路径不存在 500 字符工具预览、不存在 16KB blob 外置；PD 侧观测文本上限是 200（默认）/20,000（同意 full 层）字符 + 工具事实 JSON 8,000 字符。完整原文在 Codex rollout 文件里，PD 不持有。**

### 2.3 WorkBuddy 路径（结论：与 Codex 同构，另有 Owner 话语的结构化边界提取）

- 会话源文件：`<home>/.workbuddy/projects/<encodeCwd(cwd)>/<sessionId>.jsonl`（`packages/workbuddy-adapter/src/ingestion/transcript-path.ts:12, 57-59`；路径授权校验 70-92 行：必须在 projects 根内、主会话文件名契约 `<sessionId>.jsonl`）。PD 同样不复制原文。
- 读取上限：与 Codex 共用同一 conversation-ingestion seam（1 MiB 窗口；同 2.2）。
- 落库方式：同样写 `governance_observations`（同 2.2）。
- Owner 话语（user_turn）：只信宿主显式 `<user_query>` 结构边界；无该边界的用户记录（典型为 ~15KB `<system-reminder>` 宿主上下文包）fail-closed 落为 `partial`、不存 `visibleText`、告警可见（`packages/workbuddy-adapter/src/ingestion/transcript-decoder.ts:130-211`，rc-9）。
- 工具返回：`function_call_result` 只提取 `output.text` 或纯字符串作为结果预览（92-97 行 `resultOutputPreview`）进 `toolFacts`，随后同样受 200/20,000 文本策略与 8,000 JSON 列上限约束（同 2.2）；调用参数 `arguments` 原样进 `toolFacts`（400-432 行）。
- 长轮次上限：同 2.2 的文本策略；**不存在 16KB blob 外置**。

**综合对照结论（TECH §2.2 未核验项 #2）：500 字符预览与 16KB blob 外置是 OpenClaw 路径独有事实；Codex/WorkBuddy 路径的完整轨迹权威在宿主自己的会话文件（rollout / projects JSONL），PD 只存有界 governance observations。完整轨迹数据集若要覆盖 Codex/WorkBuddy 样本，快照对象必须扩展到宿主会话文件或其授权投影——当前 T1 快照工具只覆盖 PD 工作区两库 + blob，这一点是已知边界。**

## 3. OpenClaw 原生会话文件与 `session_id` ↔ `pain_events` 关联

- PD 侧权威：`pain_events.session_id TEXT NOT NULL`（`packages/principles-core/src/runtime/trajectory-schema.ts:185`）；同库 `sessions`（`session_id` 主键，`packages/openclaw-plugin/src/core/trajectory.ts:400-405` upsert）、`user_turns`/`assistant_turns`/`tool_calls` 均以 `session_id` 关联。**库内按 `session_id` 关联 pain_events 与轮次是机械可复算的，仍成立。**
- 保留方式对关联的影响：保留清扫只删 `tool_calls`/`assistant_turns`/`user_turns`（+满足条件的 `governance_observations`），**不删 `pain_events`、不删 `sessions`**（`packages/principles-core/src/runtime/trajectory-retention.ts:468-477` `TRAJECTORY_RETENTION_TABLES`）。后果：90 天后 Pain 行仍在、`session_id` 仍可解析，但对应轮次可能已被删除——"能关联"退化为"只剩 Pain 行"。这正是快照节奏（≤30 天）存在的原因。
- 原生会话文件（宿主自己维护的 transcript，如 OpenClaw 进程的会话存储）：**PD 仓库不拥有、不读取、也不记录其布局与保留策略**——PD 对"OpenClaw 会话历史"的唯一内部视图就是上述工作区 `.state/trajectory.db`（旁证：`packages/pd-cli/src/legacy/session-history-import.ts:1-14` 明言它读取的就是 OpenClaw trajectory.db 而非宿主私有文件）。原生会话文件的确切位置与保留期限**需生产机器核实**（在安装了 OpenClaw 的机器上检查 `~/.openclaw/` 下宿主自有会话存储；PD 仓库内无权威依据，不猜）。

## 4. 术语同步与历史来源值兼容性（T0 第 4 项）

- `docs/architecture/GLOSSARY.md` Pain Signal 条目已由"结构化失败事件"同步为 SPEC §2.1 的"相对行为偏差信号"表述（见本 PR 的 GLOSSARY diff）。
- 消费者兼容性核验：`source` 字段的生产者（`packages/host-runtime/src/governance-signal-admission.ts:589-991`（`user_frustration`/`tool_failure`）、`packages/openclaw-plugin/src/core/evolution-reducer.ts:51, 219`（四种 `painType`）、`packages/openclaw-plugin/src/commands/pain.ts:296, 316`）只把 `source` 当捕获来源标签使用；`PainSignal` schema 名、`painId`、severity 派生均未受术语修正影响。**本票未改任何代码、任何历史数据**；`source=tool_failure` 等历史值原样保留，仅其语义解释从"失败事件"转为"来源为工具失败路径的偏差信号"。
- 遗留：除 GLOSSARY 外仍有约 9 份历史文档含旧表述"结构化失败"（INTERNALIZATION_PIPELINE.md、CREDENTIAL_GOVERNANCE_DECISION.md、EXAMINER_V0101_END_TO_END_ACCEPTANCE.md、CNB_CLOUD_WORKER.md、SPEC-PD-AGENT-PAIN-INGRESS-001-TECHNICAL-DESIGN.md、PD-AA-PRI-1110-HOST-PROFILE-SOURCE-MAP.md、superpowers/onboarding 设计稿、1 条 ERR 记录；SPEC v0.3 自身为引用旧词典而保留该词）。按 P3 最小变更面，本票只改术语所属文档（GLOSSARY），其余列为后续项。

## 5. 结论总表

| # | 未核验项（TECH §2.2） | 结论 | 关键证据（路径:行号） |
| --- | --- | --- | --- |
| 1 | 实验工作区运行 diagnose/run-once 是否触发保留清扫 | **不触发**（仍成立的部分：harness 命令链零 retention 引用；清扫触发面是两类常驻 worker、手动 CLI、OpenClaw 网关调度）。防御性关闭键：`trajectoryRetention.enabled: false` 或 `trajectoryRetention.retentionDays: 0` | 见 §1 |
| 2 | Codex/WorkBuddy 工具返回与长轮次的存储方式与上限 | **已核验**：两路径均无 500 预览/16KB 外置；PD 存 governance observations（200/20,000 文本策略 + 8,000 工具事实 JSON + 1 MiB 读窗）；全文在宿主自有会话文件，PD 不持有 | 见 §2.2/§2.3 |
| 3 | OpenClaw 原生会话文件位置、保留方式、能否按 session_id 关联 pain_events | **部分已核验**：库内 `session_id` 关联机械可复算；清扫不删 pain_events/sessions 但删轮次（关联会退化为仅 Pain 行）；宿主原生会话文件布局与保留**需生产机器核实** | 见 §3 |

未核验且本地无法证实的生产行为均已按 HANDOFF T0 失败条件标注"需生产机器核实"，未做猜测。
