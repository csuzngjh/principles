# PD-AA 行为证据关联设计 v0.2（PRI-1114）

日期：2026-11-06
基线：`953d12f5b59c3c05d1bba530b6c99f3d38d3b4e0`（origin/main，已合并 PR #2370）
状态：**APPROVED_SCOPE — Owner 已批准“只读模块 + CLI”实现范围；设计 v0.1 被本文件取代。**
批准边界：不建表、不写生产库、不调模型、暂不接控制台（见 §0）。

## 0. 批准记录与范围

Owner 于 2026-11-06 批准：PRI-1114 的只读模块 + CLI 实现范围，并给出六条语义修正（§3）与五条新增反例（§8 O1–O5）。

本范围只做**只读关联投影**：

- 允许：读 journal JSONL、读 EventLog JSONL、只读打开轨迹 SQLite、输出 JSON；
- 禁止：任何生产写入（含 `reconciled`）、建表/迁移、模型调用、控制台接线、真实 Agent 回合、付费调用、部署、合并；
- 唯一写者：PRI-1114（本任务）。PRI-901 不重复实现本连接层，见 §13。

## 1. 问题与最小缺口

PD 能证明“原则被注入”，但不能把一次注入机会与其后的行动、纠正、产物、任务结果关联。现有事实都在，缺的是**以 `hookInvocationId`/`runId` 为骨架的只读连接层**；不是行为事实本身。

不做：通用 Behavior Engine、Evaluation Platform、新数据库、worker、第二套事件读取框架、任何“补造写侧”。

## 2. 事实表（当前生产代码，基线 953d12f5b）

| # | 事实 | 生产者 | 身份字段 | 现有读取入口 | 语义限制 | 状态 |
|---|---|---|---|---|---|---|
| F1 | 注入机会 open | `prompt.ts:320-333`（`recordAdaptiveDelivery`） | `hookInvocationId`, runId, sessionId, artifactId/activationId, host | `reconcileAdaptiveJournal` | open ≠ 已送达 | 已有 |
| F2 | 终态/正文摘要 | `prompt.ts:1111-1123` | 同上 + `targetBodySha256` | 同上 | 摘要 hash，非正文 | 已有 |
| F3 | 配置身份快照 | #2370，`prompt.ts:311/324` | host/hostVersion/pluginVersion/effectiveHookSetFingerprint/evidenceCoverage | journal report | 仅描述调用配置 | 已有 |
| F4 | 行动（运行级） | `after-tool-call-helpers.ts:239-250,291-298` → `event-log.ts:115-118` | **runId + toolCallId**（PRI-750）, toolName, filePath, error/exitCode | EventLog `tool_call`（新模块有界读取） | 只说明“调用发生”，不是产物 | 已有事实，未接通 |
| F5 | 行动结果（表侧） | `after-tool-call-helpers.ts:252-262,281-289` → `trajectory.ts:445-456` | sessionId, toolName, outcome, exitCode, params_json, result_preview | 轨迹 SQLite | **无 run_id、无 tool_use_id**（OpenClaw 路径） | 已有事实，仅弱候选 |
| F6 | 后续纠正 | `trajectory.ts:402-410`（user_turns）；`correction_samples` | turn id、`references_assistant_turn_id`、sessionId | 轨迹 SQLite | sample 的 principle_ids 为空、recovery span 为会话级 | 已有，需按 turn.runId 判定 |
| F7 | 任务结果 | `llm.ts:216-224` → `trajectory.ts:589-599` | `task_id` = host runId；`completed`；`principle_ids_json`（会话级） | 轨迹 SQLite | **completed 只是模型输出完成记录** | 已有，语义需降级 |
| F8 | 申请/送达时间 | 无独立“送达”事件 | — | — | open 时间不是送达时间 | **缺失** |
| F9 | 产物有效性 | 无独立产物证据 | — | — | 文件路径/命令只是调用目标 | **缺失** |
| F10 | 请求级身份 | 无 `requestId` 生产者 | `hookInvocationId` 是唯一请求粒度身份 | journal | 不再造第二身份 | 缺失（不补） |

**缺口**：G1 无连接层；G2 表侧行动无 run_id/tool_use_id，只能与事件侧做弱配对；G3 任务结果原则集合为会话级；G4 纠正样本无原则绑定；G5 双源预算没有统一覆盖结论。

## 3. 六条修正的落点（Owner 原文 → 本设计位置）

| 修正 | 落点 |
|---|---|
| 一、同一 run 只能确认运行级归属 | §4.2：运行级强关联的四个必要条件；请求级/遵循/改善不可由 run 推出 |
| 二、调用开始 ≠ 真实送达 | §4.3：open 不是送达；先后关系缺独立送达时间时一律 `unknown` |
| 三、保留事实来源，不升级证据 | §4.4：`completed` 仅模型完成；路径/命令仅为调用目标；不补造写侧 |
| 四、读取与隐私边界 | §5：EventLog `tool_call` 有界路径；SQLite 查询/解析工作量上限；JSONL 9 文件边界；默认不输出原始 command/params/preview/正文 |
| 五、唯一归属 | §13：PRI-1114 唯一写者；PRI-901 只去重、保留未覆盖验收项，不改造成统计任务 |
| 六、允许只读子范围并行 | §14：Linear 登记可独立子范围；不删 blocker、不关闭 PRI-1109/PRI-1107 |

## 4. 关联模型

### 4.1 身份骨架

一个 `hookInvocationId` = 一次注入机会（不是“请求”，也不承诺送达）。机会携带：`runId`（可为空）、sessionId、host、workspaceDir、目标 artifact/activation、`targetBodySha256`、配置快照、终态分类。

`runId` 是**运行级**归属键，不是请求键；同 run 可包含多次请求/多次注入。

### 4.2 运行级强关联（`strong_run`）的四个必要条件

同时满足才允许标注：

1. **范围完整**：journal 扫描未截断（无 file/byte/invocation 上限命中、无解析失败丢弃），且该 run 的 open 与终态都落在请求窗口内；
2. **身份有效**：`runId` 非空且来自同一 workspace/session；`workspaceVerified=true`；
3. **无冲突**：该机会无 duplicate/conflict 终态，目标 artifact 一致；
4. **注入唯一已证明**：在**完整范围**内，该 `runId` 只对应一个 `hookInvocationId`。

任一条件不满足：

- 截断/预算耗尽 → `unknown`（**不得因为“只看到一个”就判定唯一**）；
- 同 run 多注入 → `ambiguous`；
- 身份缺失 → `unknown`；
- 冲突 → `conflict`。

即使 `strong_run` 成立，也只表示“该 run 内发生了该事实”，**不表示同一次模型请求**，更不表示遵循原则或行为改善。输出必须用 `evidenceLayers` 显式区分四层：运行级关联、请求级关联、原则遵循、因果改善；后三层在缺少独立送达/遵循/结果证据时固定为 `unknown`。

### 4.3 调用开始 vs 真实送达

- `open.ts` 是 journal 写入时间，不是“原则进入模型请求”的时间；
- 行动晚于 `open` **不能**确认“干预先于行动”；
- 当前没有独立送达时间（F8）→ 先后关系一律 `ordering: 'unknown'`；
- 只有当未来出现独立的送达事实时，才允许解除 `unknown`；本任务不造。

### 4.4 事实语义（不升级证据）

| 事实 | 允许的表述 | 禁止的表述 |
|---|---|---|
| `task_outcomes.completed` | “模型侧输出完成记录” | 任务成功、问题解决、质量改善 |
| 工具 `filePath` / 命令 | “调用声明目标” | 文件已修改、产物已生成、结果有效 |
| `trajectory.tool_calls.outcome=success` | “宿主报告该调用未失败” | 产物有效、任务达成 |
| 纠正后的再次调用 | “后续行动” | 覆盖/抹除第一次行动 |
| 原则被注入 | “已返回给调用上下文” | 已确认、已遵循 |
| `principle_ids_json` | “该会话注入集合的记录”（会话级） | 本次 run 注入一致、本次请求唯一 |

`principle_ids_json` 只有会话级容器，没有 principleId ↔ `artifactId` 连接键；
因此本任务只能输出 `principleBinding='session_level_unknown'`（空数组为 `absent`），
**不得**把“无法比对”写成 `conflict`。

独立结果证据缺失 → `unknown`。本任务**不补造写侧**。

### 4.5 弱候选

同 session/toolName/时间接近的轨迹行、同原则 ID、同 run 但唯一性未证明的行动，只能进入 `weakCandidates`，`verified=false`，必须带命中原因；**永不升级**为 `strong_run`。

### 4.6 输出结构

```text
{
  invocations: [{
    intervention: { hookInvocationId, runId, sessionId, host, artifactId, activationId,
                    targetBodySha256, configIdentity, terminal: {state, variants} },
    association: 'strong_run' | 'weak' | 'ambiguous' | 'unknown' | 'conflict',
    associationReasons: string[],
    evidenceLayers: {
      runAssociation:    'strong_run' | 'weak' | 'ambiguous' | 'unknown' | 'conflict',
      requestAssociation:'unknown',
      principleAdherence: 'unknown',
      behaviorImprovement:'unknown'
    },
    facts: {
      actions:   [{ source:'event_log.tool_call', toolName, outcome, exitCode, errorType,
                    ts, ordering:'unknown'|'after_open_only', strength }],
      corrections: [{ source:'trajectory.user_turns', referencedRunId, strength }],
      outcomes:  [{ source:'trajectory.task_outcomes', completed, semantics:'model_completion_only', strength }],
      artifacts: { declaredTargetCount, confirmedCount: 0, confirmation:'unknown' }
    },
    weakCandidates: [...],
    unknowns: [{ fact, reasonCode }],
    conflicts: [...]
  }],
  coverage: { complete, window, filesRead, rowsRead, truncated, incompleteReasons[] },
  totals, host, generatedAt
}
```

## 5. 读取路径、预算与隐私

### 5.1 EventLog `tool_call` 有界路径（新增明确路径）

- 目录候选沿用 journal：`<workspace>/.pd/logs`、`<workspace>/.state/logs`；
- **最多 9 个日期文件/目录**（沿用 `ADAPTIVE_JOURNAL_MAX_DATE_FILES_PER_DIR = 9`，不得退回 8）；
- 每文件最多 4 MiB（`ADAPTIVE_JOURNAL_MAX_FILE_BYTES`），尾部读取；
- 只解析 `type === 'tool_call'` 且 `ts` 在窗口内的行；命中上限后停止读取并标记截断；
- 只允许字段：`ts`、`sessionId`、`data.toolName`、`data.runId`、`data.toolCallId`、`data.error`（截断 200 字符）、`data.errorType`、`data.exitCode`、`data.filePath` 仅在内部用于计数，不输出原文；
- 解析失败计数，不猜测；journal 对账结果**不能替代**工具事件；
- 日期文件被省略（`omittedFiles>0`）视为截断；读取失败（`errors>0`）与目录缺失（`dirsFound=0`）必须显式报告为覆盖不完整。

### 5.2 SQLite 有界查询（限制查询与解析工作量，不只限制输出）

- 只读打开：`openTrajectoryDbReadonly(workspaceDir)`；
- 每次查询必须带 `WHERE` 与 `LIMIT`，只选允许列；禁止 `SELECT *`、禁止全表扫描；
- 总查询行上限 5000；每机会行动 200 / 纠正 50 / 结果 20；
- 必须显式设置 `PRAGMA query_only=ON`（只读连接双保险）；
- 按既有索引：`idx_tool_calls_session_tool_use_id`、session/time 列；
- 命中上限 → `coverage.complete=false` + 对应 `incompleteReasons`（`action_limit_reached` / `correction_limit_reached` / `outcome_limit_reached` / `weak_candidate_limit_reached` / `trajectory_row_limit_reached` / `session_query_limit_reached` / `session_rows_truncated`），计数为下界。`session_rows_truncated` 表示单会话分类查询（纠正/任务结果/弱候选）在窗口内被截断；按 run 过滤后出现的空结果必须按它降级，不能读作“确实没有”。

### 5.3 JSONL 预算

沿用当前实现：9 文件/目录、4 MiB/文件、journal 1000 机会/5 终态变体；新增 EventLog 解析事件上限（默认 20000 行），超限即截断。**不得把已修复的 9 文件边界退回 8。**

### 5.4 隐私投影（默认拒绝）

默认不输出：原始 `command`、`params_json`、`result_preview`、会话/用户正文、文件内容、绝对路径。

允许输出：工具名、宿主报告的 outcome/exitCode/errorType、时间戳、行键（log 文件 basename + 行序号 / 表主键）、计数、hash。

需要更强定位时，只给“安全引用”（如 `toolCallId` 前 8 位 + hash），不给原文。

## 6. 失败、缺证、冲突与覆盖

- 任一源不可用：`unknown` + 原因码（`journal_unavailable` / `event_log_unavailable` / `trajectory_unavailable`），不是空结果；
- 无终态、无 runId、无任务结果 → `unknown`；
- duplicate/conflict 终态 → 全部保留并进入 `conflicts`；
- 预算/窗口截断 → `coverage.complete=false` + `incompleteReasons`；
- **唯一性举证必须建立在“无丢弃”之上**：journal 扫描只要出现 `malformedJsonLines`、`invalidEnvelopeRecords` 或 `invalidRecords`，`strong_run` 一律降为 `unknown`（被丢弃的记录可能属于同一 run）；
- **EventLog 的省略不等于不存在**：日期文件被预算省略、解析失败、读取失败、目录缺失，以及每机会行动/纠正/结果/弱候选上限命中，都必须进入 `incompleteReasons` 并使 `coverage.complete=false`；
- **身份缺失的工具事件必须计数**：`data.runId`/`sessionId` 缺失的 `tool_call` 行不计入任何 run，但必须输出 `unattributedToolCalls`，不得被读成“没有行动”；
- 配置身份变化（fingerprint 不同）→ `config_changed`，旧结果不得充当新配置证据；
- 行动早于 open → `pre_open`，不计为“之后”；先后关系仍 `unknown`。

## 7. 实现（本轮）

1. `packages/host-runtime/src/adaptive-behavior-linkage.ts`（新，唯一实现入口）
   `linkAdaptiveBehaviorEvidence({ workspaceDir, since, until, host?, limits? })`
   流程：`reconcileAdaptiveJournal` → EventLog 有界读 → 轨迹只读查询 → 纯函数归类。
2. `packages/host-runtime/src/index.ts`：导出模块。
3. `packages/pd-cli/src/commands/runtime-activation.ts`：新增 `pd activation link`（只读薄包装；`--json` 严格单文档；失败带 `reason` + `nextAction`）。
4. 测试：`packages/host-runtime/tests/adaptive-behavior-linkage.test.ts`、CLI 命令注册/输出契约测试。

不修改 `journal` 命令契约（只对其只读投影追加两个安全字段：`targetBodySha256`、`configIdentity`）；不新增运行时 feature flag；`link` 子命令自带只读预算参数；不写任何存储。

## 8. 反例（验收条件；先失败后通过）

既有反例：

1. 跨请求/跨 Session 的相同原则 ID → 不建立强关联。
2. 弱时间关联 → 仅 candidate。
3. 一次机会对多次行动/多次纠正 → 全保留。
4. 重复/冲突终态 → 保留并标注。
5. 行动先于干预 → `pre_open`。
6. 后续纠正掩盖首次行动 → 首次行动仍保留。
7. 缺终态/缺任务结果 → `unknown`。
8. 配置身份变化 → `config_changed`。
9. 预算耗尽 → `coverage.incompleteReasons`。
10. run 内多次注入 → `ambiguous`。
11. SQLite 不存在/缺列 → `unavailable`，不建库不迁移。
12. `principle_ids_json` 无法与本次注入比对（无连接键）→ 输出 `principleBinding='session_level_unknown'`，不臆造 `conflict`；空数组 → `absent`。

**新增（Owner 指定，O1–O5）**：

- **O1 截断后假唯一**：窗口被截断但只读到一个注入 → 必须不是 `strong_run`（`unknown`）。
- **O2 同 run 多次请求**：同 run 存在两个 `hookInvocationId` → 两者都 `ambiguous`，不是请求级关联。
- **O3 行动晚于 open、但早于实际送达**：无独立送达时间 → `ordering='unknown'`，不得推断“干预先于行动”。
- **O4 `completed` 但任务实际失败**：只能输出 `model_completion_only`，不得计为成功。
- **O5 工具声明写文件但无有效产物**：`artifacts.confirmedCount=0`、`confirmation='unknown'`，不得计为产物已产生。

**评审补强（R1–R8，本轮新增并已先失败后通过）**：

- **R1 journal 有丢弃 → 不得假唯一**：同一文件出现 malformed / invalid envelope / invalid record 时，`strong_run` 降为 `unknown`，并输出 `coverage.journal.malformedLines` / `invalidRecords`。
- **R2 EventLog 解析失败 → 覆盖不完整**：`parseErrors>0` 必须进入 `incompleteReasons`，不得静默当作“没有行动”。
- **R3 EventLog 日期文件被省略 → 截断**：`omittedFiles>0` 必须置 `eventLog.truncated=true` 并报告 `event_log_files_omitted`。
- **R4 每机会上限 → 覆盖不完整**：`action/correction/outcome/weak_candidate` 上限命中必须使 `coverage.complete=false`。
- **R5 四层必须可区分**：每个机会输出 `evidenceLayers`；只有 `runAssociation` 可非 unknown。
- **R6 半合法 principle ID 数组 → 不可比对**：任一元非非空字符串时返回 `session_level_unknown`，不得降级为 `absent`。
- **R7 工具事件缺身份 → 计数而非丢弃**：输出 `coverage.eventLog.unattributedToolCalls`，不得读成“没有行动”。
- **R8 EventLog 目录缺失 → 显式不可用**：`dirsFound=0` 必须报告 `event_log_unavailable`，不得输出空事实并宣称完整。

## 9. 测试计划

- 确定性 fixture：临时目录构造 `events_*.jsonl`（adaptive + tool_call）与临时 `trajectory.db`（session/assistant_turns/tool_calls/user_turns/task_outcomes）。
- O1–O5 每条**先写失败断言**（RED），实现后转绿；既有 12 条同样覆盖。
- 读取边界测试：第 10 个日期文件不被读取；超 4 MiB 尾部截断计数；`LIMIT` 生效（用远超上限的行数验证查询/解析工作量有界）。
- 只读测试：运行前后 DB 与 JSONL 的 mtime/哈希不变。
- 隐私测试：输出 JSON 不含原始 command/params/preview/正文。
- CLI 契约测试：真实 parser/注册路径；`--json` stdout 单对象；失败 exitCode≠0 且带 `nextAction`。

## 10. 复杂度增量

| 项 | 结论 |
|---|---|
| 新持久化真源 / schema / 状态 | NO |
| 新子系统 / 服务 / 后台进程 | NO |
| 新公共抽象 | YES：1 个只读模块 + 1 个 CLI 子命令（PRI-1115 的唯一输入） |
| 新 flag | NO（只读，整提交 revert） |
| 新跨包依赖 | YES：pd-cli → host-runtime（既有方向） |
| 新 host 专属行为 | NO（按 host 字段隔离） |
| 新外部/网络能力 | NO |

`mvp-q-1`：不做则 PRI-1115 只能按会话计数，可能把“有注入”当成“有效果”。
`mvp-q-3`：revert 提交即可，无迁移、无缓存。
`mvp-q-4`：N/A（内部工程）——不制造“已证明有效”的安心感。

## 11. 验收标准

1. 25 条反例（12 既有 + O1–O5 + R1–R8）全部有确定性测试且通过；其中第 12 条按 §4.4 的“不可比对 → unknown”实现，不伪造 conflict；
2. `strong_run` 仅在实际满足 §4.2 四条件时出现，并输出理由；
3. O1/O2 下绝不出现 `strong_run`；
4. 所有“完成/成功/产物”结论按 §4.4 降级，无一处升级；
5. 输出无原始 command/params/preview/正文；
6. 读取不改变任何文件（哈希/mtime 不变）；
7. `pd activation link --json` 严格单文档；失败带 `reason` + `nextAction`；
8. `pd activation journal` 既有测试不变；
9. 无新增生产写入。

## 12. 回滚

整提交 revert；无持久状态、无迁移、无缓存、无开关。

## 13. 唯一归属

- PRI-1114：本连接能力的**唯一写者**（模块、CLI、测试）。
- PRI-901：按其实际覆盖范围去重，保留其未覆盖的验收项；**不**把 PRI-901 改成与 PRI-1115 重复的统计任务。若 PRI-901 也需要行为读取，应消费本模块结果，不再写第二套扫描。

## 14. Linear 与依赖

- 在 PRI-1114 登记可独立执行的只读子范围（设计、模块、CLI、测试），并注明本 PR；
- **不删除**父票 blocker，**不关闭** PRI-1109 / PRI-1107，不绕过 start 守卫；
- 不提前关闭整张 PRI-1114。
