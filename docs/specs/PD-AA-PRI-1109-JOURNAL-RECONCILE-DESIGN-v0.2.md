# PD-AA journal 保守对账设计 v0.2（PRI-1109 只读子范围）

日期：2026-11-05。基线：`08bc4e9244b65ae44d5b5238f0a8245dac955c1e`（origin/main，含 PR #2353 合并提交）。
状态：**NEEDS_OWNER — 尚无覆盖本方案的明确设计批准，本轮未写实现代码。**

修订说明：v0.2 在不改变只读范围的前提下，按 Owner 评审的五点意见修订；v0.1 保留为已合并历史文件，本文件取代其待审状态。三点范围选择（只读库 + 薄 CLI、默认最近 7 天、输出上限 1000 条）已定稿，不再并列其它形态。

## 0. 授权核实结论

- Linear：PRI-1109 在 2026-11-05T10:53Z 被外部置为 `Done`；这与"实现代码为零、设计未获批准"的事实冲突。**不把该状态当作设计批准或验收证据**，本文件仍按 `NEEDS_OWNER` 处理。
- PRI-1107（AA 02，Backlog）仍阻塞本票的开工许可；其验收条件"Owner 书面确认本轮非简单变更设计后才解除开发依赖"尚未满足（详见当轮检查点的独立核实）。
- G0 方案（`docs/specs/PD-AA-G0-CORE-DESIGN-v0.1.md`，另一工作树）第 3、7 节只对"离线校验器 + 离线验证 CLI"给了条件批准，第 119 行明确 G0 尚未通过，稳定机会/请求身份仍待确认。
- PRI-1112 的批准只覆盖独立送达验证器；其评论明确 PRI-1109 "只完成共享四维记录校验，运行 journal 生产写入/对账接线仍未完成"。
- 仓库、Linear 评论与 `aa-handoff/` 检查点中未找到对本对账读模型的后续有效批准。方向性"先把能做的完成"不等于具体设计批准。

因此本文件是**待审方案**，不是已批准实现。

## 1. 范围声明

本方案只做 PRI-1109 的**只读对账子范围**：读取既有 EventLog JSONL，回答问题 (1) 有开始与终态、(2) 只有开始且当前范围内无可见终态、(3) 缺开始/身份不完整/记录无效、(4) 重复或冲突、(5) 当前证据能确认什么与仍有哪些未知。

语义红线：`closed`/`reconciled` 不等于成功；`confirmed` 只是记录中的声明，读工具不重新认证；`submission` 默认 `unknown`；无日志 = 未知，不等于零调用；只有 open 只能表述为"当前范围内未找到终态"。

不做：写 `reconciled` 记录、修写侧、建新表/新库/后台服务/队列、调用模型、改安装目录、改生产配置、改冻结包与审批记录、真实 Agent 实验。

## 2. 复用的现有能力（不建第二套真源）

| 能力 | 入口 | 复用于 |
|---|---|---|
| journal 唯一写入 | `packages/openclaw-plugin/src/core/event-log.ts` `recordAdaptiveDelivery`（144-150），先正式校验再 `record('adaptive_delivery','written')` | 定义被读事实；本方案只读 |
| open 写点 | `packages/openclaw-plugin/src/hooks/prompt.ts` `beginAdaptivePromptInvocation`（293-302） | `receiptState=open` 的字段集合 |
| 终态写点 | 同文件 1073-1084（仅当 `adaptiveInvocationId` 存在，终态带 `reason/addedTarget/nativeAdmissionId/targetBodySha256`） | `closed` 的字段集合与"终态只由写侧产生" |
| 记录校验器 | `packages/principles-core/src/runtime-v2/activation/adaptive-delivery-record.ts` `validateAdaptiveDeliveryRecord`（66-161） | 逐条判定"无效四维/缺身份/证据约束"；**只校验 data 记录，不校验信封身份**，信封过滤由读取层完成 |
| 保留期真源 | `packages/principles-core/src/runtime-v2/receipt-coverage.ts` `INTERVENTION_SHORT_SOURCE_RETENTION_DAYS = 7`（22）；写侧 41 行同源引用 | 时间窗口上限，不硬编码第二个 7 |
| 日志目录真源 | `packages/host-runtime/src/prompt-injection-budget-observation.ts` `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS`（64） | `.pd/logs`、`.state/logs` 候选顺序 |
| 有界读取先例 | 同文件 77/87/95 行 `MAX_FILES=7`、`MAX_FILE_BYTES=4MiB`、`MAX_AGE_MS`，及 tail-read/containment/parseFailures 处理 | 读取上限与"不可读≠零"原则（文件数上限见 §9 的修正） |
| 同仓 JSONL 读法先例 | `packages/pd-cli/src/commands/runtime-activation.ts` `collectRuleCodeEventEntries`（127-153） | 候选目录优先级、完全相同行去重、不可读目录不计为健康零事件 |

写入文件命名：`getEventsFile`（event-log.ts 76-78）`<stateDir>/logs/events_<UTC日期>.jsonl`，追加写、按 UTC 日期切分；清理按 **mtime**（:106-107）且只在写入切换日期时触发（:89），因此"保留 7 天"是写入侧尽力而为，读侧不得据此假设文件一定存在或一定不存在。缓冲跨午夜会使 `date` 与文件名相差一天（真实样本：`events_2026-09-18.jsonl` 首行 `ts=2026-09-17T23:59:59.650Z`），读取一律以信封 `ts` 判定事件时间，文件选择按日期相交而非文件名计数。

## 3. 方案（最小形态已定稿）

新增一个只读模块 + 一个只读 CLI 子命令：

- `packages/host-runtime/src/adaptive-journal-reconciliation.ts`：纯函数分类 + 有界读取；`reconcileAdaptiveJournal({ workspaceDir, since, until, host, limits })`；不打开 SQLite、不写文件、不建目录。
- `packages/host-runtime/src/index.ts`：一行导出（跨包消费所必需）。
- `packages/pd-cli/src/commands/runtime-activation.ts`：`pd activation journal`（沿用现有 `activation` 命令族与 `--workspace`/`resolveWorkspaceDir`）。
- 测试：`packages/host-runtime/tests/adaptive-journal-reconciliation.test.ts`、`packages/pd-cli/tests/commands/runtime-activation-journal.test.ts`。
- 不改 `packages/openclaw-plugin/**`、不改 core 校验器、不改安装目录。

形态已定稿：**host-runtime 纯逻辑模块为主体，CLI 为极薄包装**。分类、配对、去重、窗口裁剪、目标一致性判定、截断判定与原因码生成全部在模块内完成并可直接单测；CLI 只做参数解析/校验、调用模块、把单一 JSON 写到 stdout、把诊断写到 stderr、设置退出码，**不得在 CLI 层实现任何分类语义**。不提供纯库或独立服务的并列方案。

## 4. 输入、范围与隔离

- `workspaceDir`：必填，经现有 `resolveWorkspaceDir` 解析为绝对路径；读取前 `realpath` 校验候选日志目录必须落在该工作区实路径内，逃逸即 `outside_workspace` 错误，不读。
- 宿主：默认且本轮只处理 `data.host === 'openclaw'`；其它值或缺失 → `host_identity_unknown`，单独计数，**绝不与 openclaw 合并**。
- 工作区：`data.workspaceDir` 规范化后必须等于本次请求工作区；不等 → `foreign_workspace`，排除并计数；缺失 → `workspace_identity_unknown`，归入 `workspaceDir:null` 分组，**不与已验证工作区分组合并**（覆盖"不同工作区恰好同号"）。
- 时间窗口：UTC ISO；默认 `until = now`、`since = now - retentionDays`（完整 7×24 小时，与 `INTERVENTION_SHORT_SOURCE_RETENTION_DAYS` 同源）；闭区间 `[start, end]`。`since` 早于保留边界时截断到保留边界并置 `clampedByRetention=true`；`until > now` 或 `end < start` 为参数错误（退出码 2）。窗口可由 `--since`/`--until` 显式指定，输出回显实际生效的 `start`/`end` 与 `requestedStart`。事件时间用信封 `ts`，不用文件名或 mtime。
- **默认 7 天而不是 24 小时的理由**：open 与终态可能跨午夜、跨工作时段；24 小时窗口会系统性排除仍可配对的记录，并把"实际有结尾"误报成"只有开头"（`open_only`），这是错误的保守结论。7 天与日志保留期一致，是当前证据的完整上界；成本上限见 §9。窗口不是证据完整性声明：保留期清理、文件缺失、tail 截断都会使结论成为下界，必须由 `coverage` 与 `countsAreLowerBounds` 表达。
- **日期文件覆盖**：7×24 小时闭区间最多与 **8 个 UTC 日期文件**相交（例如 start 10-29T10:00Z、end 11-05T10:00Z 对应 10-29…11-05）。EventLog 在 flush 时按当时日期选择文件、而记录的 `ts/date` 在创建时固定，因此缓冲跨午夜时窗口末尾的记录可能写入**次日**文件；候选集需追加 1 个溢出日期，共最多 **9 个**。读取按"文件名日期与窗口相交（含次日溢出）"选择文件，不按"最近 N 个文件"截断；事件是否纳入仍由信封 `ts` 判定。文件数上限与不足时的显式标记见 §9。
- 只读：输入文件前后 `sha256` 必须一致（测试断言），工作区目录列表前后不得新增文件。

## 5. 身份与配对规则

配对键：`(host, normalizedWorkspaceDir, sessionId, hookInvocationId)`。

- `hookInvocationId`：唯一调用关联符，必须非空字符串；缺失 → 归 `rejected`。
- `sessionId`：以信封 `sessionId` 为权威；`data.sessionId` 若存在且与信封不等 → `session_identity_mismatch`，该组判 `invalid`，不配对。`sessionId` 缺失 → 身份不完整，不与其他组配对。
- `runId`、`requestId` 只作投影展示，**不进入配对键**（二者均可缺失，不能成为隐式要求）。
- **目标一致性**：`hookInvocationId` 相同只是候选，不能直接判正常配对。open 与终态（含每个终态变体）的 `artifactId` 与 `activationId` 若**都存在且不同** → `conflicted`，原因码 `target_identity_mismatch`，不得判 `paired_open_and_terminal`，并保留全部变体。任一侧字段缺失 → 不判冲突，但该调用的 `unknowns` 必须写明"目标身份不可比对（artifactId/activationId 缺失）"。
- 跨文件同键允许配对；写入顺序不构成"及时性"证据，配对也不证明送达。

## 6. 分类与原因码（封闭集合）

`classification`：`paired_open_and_terminal` | `open_only` | `terminal_only` | `conflicted` | `invalid`。

原因码：

- `terminal_not_visible_in_range`：有 open、扫描范围内无终态。**只表示"当前范围内未找到终态"，不得表述为中断/超时/宿主 kill。**
- `window_end_explicit_not_now`：仅描述"窗口终点由 `--until` 显式指定、并非 now"，**不表示终态发生在窗口之后**；终态位置仍未知。与 `terminal_not_visible_in_range` 同时出现。选择该措辞的理由：`terminal_after_window_end` 会把"未观测"写成"已发生在窗口后"，与证据不符。
- `start_not_visible_in_range`：有终态、范围内无 open；开始可能早于窗口或保留期，**未知，不是零开始**。
- `exact_duplicate_record`：同键同状态且数据逐字段相同（按规范化 JSON 比较）；计入副本数，只保留最早一条。
- `multiple_starts_conflict`：同键 ≥2 条不同的 open。
- `conflicting_terminal_states`：同键 ≥2 条不同终态（四维/原因/证据任一不同）；保留全部变体，不选胜者。
- `target_identity_mismatch`：配对候选的 `artifactId`/`activationId` 都存在且不一致（见 §5）。
- `malformed_json`：行无法解析；无法归属到具体事件类型，只计入 `malformedJsonLines`，不计入 adaptive 的无效记录。
- `non_adaptive_event`：可解析对象且 `type` 缺失或不等于 `adaptive_delivery`。**视为不相关而非无效**：跳过、计入 `nonAdaptiveLines`，**不进 `rejected`、不计入任何无效/异常统计**，也不影响 q3。
- `invalid_envelope`：仅对 `type === 'adaptive_delivery'` 的行判定；非对象、缺/非法 `ts`、`data` 非对象。
- `missing_hook_invocation_id`：记录无法归属到调用。
- `invalid_four_dimension_state`：`validateAdaptiveDeliveryRecord` 失败（枚举/开启终态约束/证据约束）。
- `session_identity_mismatch`、`workspace_identity_unknown`、`foreign_workspace`、`host_identity_unknown`。
- `record_before_coverage_start`：tail-read 截断导致更早行不可见，该组计数为下界。
- `output_truncated`：输出条数或终态变体达到上限。
- `terminal_variants_truncated`：某调用的终态变体超过每调用上限，被省略；与 `output_truncated` 同时出现。

覆盖级限制不使用调用级原因码：`coverage.limitCode` 取 `coverage_file_limit_reached`（见 §9）。

重复与冲突互斥处理：逐字段相同的重复只计数并去重；不同内容的多次开始/终态进 `conflicted`，同时保留全部变体（受 §9 的输出上限约束，省略量必须显式）。

## 7. 输出 JSON（stdout 唯一内容）

```json
{
  "schemaVersion": "pd-aa-journal-reconciliation/v1",
  "generatedAt": "<UTC ISO>",
  "readOnly": true,
  "request": {
    "workspaceDir": "<abs>",
    "host": "openclaw",
    "window": {"start": "<ISO>", "end": "<ISO>", "inclusiveBounds": "[start,end]", "endIsNow": true,
               "requestedStart": "<ISO>", "clampedByRetention": false, "retentionDays": 7},
    "logDirs": [".pd/logs", ".state/logs"],
    "pairingKey": ["host", "workspaceDir", "sessionId", "hookInvocationId"]
  },
  "coverage": {
    "status": "complete | partial | unavailable",
    "sourceDirsFound": 1, "filesRead": 3, "filesSkipped": 0, "bytesRead": 1234,
    "dateFilesIntersecting": 3,
    "limitCode": null,
    "filesOmitted": [],
    "truncatedFiles": ["<abs path>"],
    "errors": [{"logDir": ".state/logs", "file": "events_2026-11-05.jsonl",
                "code": "read_failed | stat_failed | outside_workspace", "message": "<bounded>"}]
  },
  "totals": {
    "linesRead": 10, "adaptiveRecords": 8, "nonAdaptiveLines": 2,
    "malformedJsonLines": 1, "invalidEnvelopeRecords": 0, "invalidRecords": 2,
    "duplicatesExact": 1, "uniqueInvocations": 3, "countsAreLowerBounds": false
  },
  "invocations": [{
    "invocationId": "<hookInvocationId>",
    "identity": {"host": "openclaw", "workspaceDir": "<abs>", "workspaceVerified": true,
                 "sessionId": "<id|null>", "sessionIdSource": "envelope|data|both",
                 "runId": "<id|null>"},
    "targetConsistent": true,
    "classification": "paired_open_and_terminal | open_only | terminal_only | conflicted | invalid",
    "reasonCodes": ["<reason>"],
    "open": {"ts": "<ISO>", "receiptState": "open", "execution": "unknown", "payload": "unknown",
             "selection": "unavailable", "submission": "unknown", "selectionPending": true,
             "artifactId": "<id>", "activationId": "<id>", "requestId": null,
             "evidenceReferencePresent": false,
             "evidenceIndependentlyVerifiedAsRecorded": null,
             "hostKillConfirmedAsRecorded": null} | null,
    "terminal": {"ts": "<ISO>", "receiptState": "closed|reconciled", "execution": "<enum>",
                 "payload": "<enum>", "selection": "<enum>", "submission": "<enum>",
                 "selectionPending": false, "reason": "<string|null>",
                 "artifactId": "<id>", "activationId": "<id>", "requestId": null,
                 "evidenceReferencePresent": false,
                 "evidenceIndependentlyVerifiedAsRecorded": null,
                 "hostKillConfirmedAsRecorded": null} | null,
    "terminalVariants": ["<同 terminal 投影，仅冲突时多于 1 条>"],
    "terminalVariantsOmitted": 0,
    "duplicates": {"open": 0, "terminal": 0},
    "window": {"openInWindow": true, "terminalInWindow": true, "terminalSearchComplete": true},
    "unknowns": ["<本条可确定的未知>"]
  }],
  "rejected": [{"reasonCode": "<reason>", "count": 1,
                "samples": [{"logDir": ".state/logs", "file": "<name>", "line": 12,
                             "hookInvocationId": null}]}],
  "outputTruncated": false,
  "truncation": null,
  "answers": {
    "q1_open_and_terminal": {"count": 1, "countBasis": "exact", "invocationIds": ["<id>"]},
    "q2_open_without_visible_terminal": {"count": 1, "countBasis": "exact", "invocationIds": ["<id>"]},
    "q3_missing_start_or_identity_or_invalid": {"count": 2, "countBasis": "exact",
                                                "invocationIds": ["<id>"], "reasonCodes": ["<reason>"]},
    "q4_duplicate_or_conflicted": {"count": 1, "countBasis": "exact", "invocationIds": ["<id>"]},
    "q5": {"confirmedFacts": ["<仅扫描范围内可声明的事实>"],
           "unknowns": ["<不可声明为事实的部分>"],
           "notes": ["<重复/冲突/截断/覆盖下界>"]}
  },
  "nextAction": ["<可执行下一步>"]
}
```

`truncation` 非 null 时的形状：

```json
{
  "reason": "output_truncated",
  "limit": 1000,
  "included": 1000,
  "omitted": 3,
  "omittedByClassification": {"paired_open_and_terminal": 0, "open_only": 0, "terminal_only": 0,
                              "conflicted": 2, "invalid": 1},
  "variantLimitPerInvocation": 5,
  "terminalVariantsOmitted": 4,
  "coverageLimitCode": null,
  "suggestions": ["缩小窗口：--since/--until", "按 host 或 session 分片"]
}
```

当 `coverage.status = unavailable` 时，`countsAreLowerBounds=false`、四个 `count` 为 `null`、`countBasis="null"`，`q5.unknowns` 首条为"无可读日志目录 = 未知，不等于零调用"。

参数错误时 stdout 仍为单个 JSON：`{"schemaVersion","generatedAt","readOnly":true,"error":{"code","message","nextAction"}}`。

投影只暴露上列字段，不回显任意未知键（rc-8），不复制正文。

**证据字段的语义**：`evidenceReferencePresent`、`evidenceIndependentlyVerifiedAsRecorded`、`hostKillConfirmedAsRecorded` 都是**记录声明的原样转录**（`true|false|null`，`null` = 原记录未提供该字段）。读工具不重新认证、不推断、不因这些字段把 `payload=confirmed` 当作成功；该判定仍属于写侧和独立证据流程。

**普通事件不进入输出**：`non_adaptive_event` 只以 `totals.nonAdaptiveLines` 体现，不出现在 `rejected`、`invocations` 或 q3 计数中。

## 8. 去重、冲突、缺失与窗口截断

- 同目录同文件内逐字段相同的行：计 `duplicatesExact`，保留最早 `ts`。
- 跨候选目录完全相同的行：按 `.pd/logs` 优先去重（沿用 127-153 的语义），不把同一行算两次调用。
- 同键多终态/多开始：`conflicted`，`terminalVariants` 保留至每调用上限（见 §9），省略量计入 `terminalVariantsOmitted`，不推断哪一个"真实"。
- 缺开始：`terminal_only`，`q5` 明确"start unknown"。
- 缺终态：`open_only`，措辞固定为"当前范围内未找到终态"。
- 目标不一致：`conflicted` + `target_identity_mismatch`，保留 open 与全部终态变体。
- 窗口截断：文件超过 4 MiB 只读尾部，丢弃半行，记 `truncatedFiles`；受影响的组加 `record_before_coverage_start`，`countsAreLowerBounds=true`。
- 保留期：窗口不可能超过 7 天；早于保留期的记录已不可见，`clampedByRetention` 必须显式。保留期清理只在写入时发生，读侧看到的文件集可能比常量推定的更旧，`coverage` 必须按实际文件记录。
- 普通事件：`type` 缺失或不等于 `adaptive_delivery` → `non_adaptive_event`，跳过并计入 `nonAdaptiveLines`；**不得计入无效/异常统计**。
- 日期文件：读取全部与窗口相交的日期文件（默认 7×24h 最多 8 个），并追加窗口终点次日的溢出文件作为候选（最多 9 个）；超出每目录上限时按 §9 显式标记覆盖不完整。

## 9. 读取上限、错误处理与成本

- 文件选择：按文件名日期与窗口相交（含终点次日溢出）选取，**默认窗口最多 9 个日期文件/候选目录**；每文件最多 4 MiB；两个候选目录最坏 9 × 2 × 4 MiB = **72 MiB**；顺序读取，不并发、不重试。
- 文件数上限：若候选文件数超过每目录上限（默认 9），读取最新的上限数量，置 `coverage.status="partial"`、`coverage.limitCode="coverage_file_limit_reached"`、`filesOmitted` 列出被跳过文件、`countsAreLowerBounds=true`。**不得静默截断**。
- 目录不存在/不可读：`coverage.status` 降级并记错误；**不得把不可读当零事件**（ERR-002）。
- 单行错误不影响其余行；校验器异常已被其自身捕获，读取层不再抛。
- 输出上限：`invocations` 最多 1000 条；每个调用的终态变体最多 5 条（`terminal` + `terminalVariants` 合计），超出部分计入 `terminalVariantsOmitted`。任何截断都必须显式：
  - `outputTruncated=true`，`truncation` 对象按 §7 输出；
  - `countsAreLowerBounds=true`；
  - `q1..q4` 的 `countBasis` 改为 `lower_bound`（`count` 仍为已观察数，但不得呈现为完整口径）；
  - `q5.notes` 首条说明"输出被截断，结论仅为已输出子集"；
  - `truncation.omittedByClassification.conflicted` 必须保留冲突结论的遗漏量；
  - `nextAction` 必须包含缩小窗口或按 host/session 分片的提示。
- 禁止静默截断：没有 `truncation` 对象而 `invocations` 恰好 1000 条，或终态变体超过 5 条却无 `terminalVariantsOmitted`，视为实现缺陷。
- 成本：零模型调用、零数据库、零新增依赖、零常驻进程；一次人工触发的有界文件扫描（最坏 72 MiB）。

## 10. 验收与回滚

验收（隔离临时目录 + 真实 JSONL 行格式）：

1. 正常 open→closed 配对；2. 只有 open；3. 只有终态；4. 完全相同重复去重并计数；5. 冲突终态/多次开始；6. 非法 JSON、非法四维、缺身份、非法信封；7. open 在窗口内/终态在窗口外（只允许 `window_end_explicit_not_now` + `terminal_not_visible_in_range`，不得出现"终态发生在窗口后"的结论或旧原因码）；8. 跨工作区同 `hookInvocationId` 不合并、外工作区记录被排除；9. 跨宿主不合并；10. 目录/文件读取失败产生 `partial`/`unavailable` 且退出码非 0；11. 输入文件前后 `sha256` 相同、工作区无新增文件；12. CLI stdout 单个合法 JSON、诊断仅 stderr；退出码 0（完成，含异常发现）、2（参数错误）、3（partial/unavailable）；13. 源码不依赖 fs 写接口、SQLite、模型；14. **同一文件混有普通事件**：`nonAdaptiveLines` 计数，`invalidEnvelopeRecords=0`，q3 不受影响；15. **默认 7×24h：8 个相交日期文件 + 1 个次日溢出候选（共 9 个）**：全部读取；人为把上限降到 8 时置 `partial` + `coverage_file_limit_reached` + `filesOmitted`；16. **同一 `hookInvocationId` 但 `artifactId`/`activationId` 不同**：`conflicted` + `target_identity_mismatch`，不得判正常配对；17. **超过 1000 条调用**：`outputTruncated=true`、`truncation.limit=1000`、`omitted>0`、`omittedByClassification.conflicted` 可读、`countBasis=lower_bound`、`nextAction` 含缩小窗口/分片提示；18. **某调用 6 个以上终态变体**：只输出 5 个，`terminalVariantsOmitted>0`，`classification` 仍为 `conflicted`；19. **证据字段**：原记录有 `evidence.independentlyVerified=true` 时输出 `evidenceIndependentlyVerifiedAsRecorded=true`，且 q5 不得写成"已独立验证/已送达"。

验证命令：上述两个 vitest 文件、`npm run build`、`npm run lint`，以及按改动适用的仓库门禁。

回滚：整提交 revert。无持久状态、无迁移、无缓存需要修复；不需要新特性开关（只读、无运行时行为改变，`mvp-q-3`）。

`mvp-q-1`（不做会怎样）：历史调用无法从现有证据区分"范围外无终态""缺开始""重复/冲突"，操作者容易把缺失误读为零或把 closed 误读为成功。
`mvp-q-4`（情绪价值）：降低"日志看起来有记录但我不知道它是否完整"的不确定感；不制造"已成功"的安心感。

## 11. 文件归属与并行

| 路径 | 归属 | 并行约束 |
|---|---|---|
| `packages/host-runtime/src/adaptive-journal-reconciliation.ts`（新） | 本任务唯一写者 | PRI-1110/1112 只读依赖，不写此文件 |
| `packages/host-runtime/src/index.ts`（+1 行导出） | 本任务 | barrel 共享，若有并行改动先串行整合 |
| `packages/host-runtime/tests/adaptive-journal-reconciliation.test.ts`（新） | 本任务 | 可并行 |
| `packages/pd-cli/src/commands/runtime-activation.ts`、`src/index.ts`（追加注册） | 本任务 | CLI 仅注册 + 委托；其他 AA 工单不得同改；冲突时由集成者串行 |
| `packages/pd-cli/tests/commands/runtime-activation-journal.test.ts`（新） | 本任务 | 可并行 |
| `docs/specs/PD-AA-PRI-1109-JOURNAL-RECONCILE-DESIGN-v0.2.md` | 本任务 | 本设计文件唯一写者 |
| `docs/implementation-reports/aa-handoff/**` | 本任务追加 | 历史文件不覆盖 |

不触碰：`packages/openclaw-plugin/**`、core 校验器、`~/.pd/runtime/**`、安装/生产配置、数据库、冻结包与审批记录。

## 12. 本方案未覆盖的整票验收

- 生产写侧产生 `reconciled`、终态对账策略（超时/宿主 kill 需独立证据）；
- `submission` 的独立确认、真实请求正文证据、行动前/后时序；
- 统一证据读模型（PRI-1114）、配置身份（PRI-1110）、真实行为评价；
- 真实 Agent/模型实验、安装启用、Shadow/Live、发布；
- PRI-1109 整票关闭（仍被 PRI-1107 阻塞；Linear 状态不构成验收证据）。

## 13. 待 Owner 批准的范围（已定稿）

1. 形态：host-runtime 只读逻辑模块 + 极薄 CLI（`pd activation journal`）；不提供纯库或独立服务并列方案。
2. 窗口：默认最近 7×24 小时（与 `INTERVENTION_SHORT_SOURCE_RETENTION_DAYS` 同源），可由 `--since`/`--until` 显式覆盖；7×24h 最多跨 8 个相交日期文件，外加 1 个次日溢出候选（共 9 个）。
3. 输出上限：1000 条调用 + 每调用最多 5 个终态变体；截断必须显式并保留冲突结论、遗漏量与覆盖限制信息。

仍需 Owner：明确批准本修订稿 v0.2（含上述范围与五点修订）；批准来源与版本写入检查点。批准前不写实现代码。

## 14. v0.1 → v0.2 修订对照

| 评审点 | v0.1 位置 | 判定 | v0.2 修改 |
|---|---|---|---|
| 1 普通日志 | §6:78 `invalid_envelope` 含 `type != adaptive_delivery`；§7 totals 无普通事件计数 | 属实 | §6 新增 `non_adaptive_event`；§7 新增 `nonAdaptiveLines`；§8 明确不计入无效/异常 |
| 2 7 天跨 8 文件 | §4:53 默认 7×24h；§9:173 每目录最多 7 文件；§2:34 文件名为日期边界 | 属实 | §4 增加 8 文件相交说明；§9 改为 8 文件/64 MiB + `coverage_file_limit_reached` + `filesOmitted`；§2 修正文件名/ts 与 mtime 清理 |
| 3 目标一致 | §5:58 配对键仅四元组；§6:76 冲突定义未含目标 | 属实 | §5 增加 `artifactId`/`activationId` 一致性；§6 新增 `target_identity_mismatch`；§7 新增 `targetConsistent` |
| 4 1000 条覆盖变体 | §7:132 `terminalVariants` 无界；§8:165 "受输出上限约束"未定义；§9:176 只限调用数 | 属实 | §7 新增每调用 5 变体上限、`terminalVariantsOmitted`、`truncation` 对象；§8/§9 明确省略与冲突结论保留；§10 新增反例 |
| 5a 未找到终态措辞 | §6:71 已正确；§6:72 `terminal_after_window_end` 越界 | 部分属实 | §6:71 保留；§6:72 改为 `window_end_explicit_not_now` 并写明理由 |
| 5b 证据标志 | §7:124/130 `evidenceIndependentlyVerified` 直接投影 | 部分属实 | 改名为 `...AsRecorded`（三态）；§7/§10 明确读工具不重新认证 |

另外把已定稿的三项范围选择写实：§3 删除替代形态并明确 CLI 薄包装；§4 写入默认 7 天理由；§9 写入 1000 条与显式截断语义；§13 改为待批准的范围声明。
