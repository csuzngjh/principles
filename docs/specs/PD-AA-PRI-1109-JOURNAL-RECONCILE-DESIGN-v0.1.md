# PD-AA journal 保守对账设计 v0.1（PRI-1109 只读子范围）

日期：2026-11-05。基线：`08bc4e9244b65ae44d5b5238f0a8245dac955c1e`（origin/main，含 PR #2353 合并提交）。
状态：**NEEDS_OWNER — 尚无覆盖本方案的明确设计批准，本轮未写实现代码。**

## 0. 授权核实结论

- Linear：PRI-1109 处于 Backlog，被 PRI-1107（AA 02，Backlog）阻塞；工单正文要求"非简单编码须先完成 02 的 Owner 设计确认"。
- G0 方案（`docs/specs/PD-AA-G0-CORE-DESIGN-v0.1.md`，另一工作树）第 3、7 节只对"离线校验器 + 离线验证 CLI"给了条件批准，第 119 行明确 G0 尚未通过，稳定机会/请求身份仍待确认。
- PRI-1112 的批准只覆盖独立送达验证器；其评论明确 PRI-1109 "只完成共享四维记录校验，运行 journal 生产写入/对账接线仍未完成"。
- 仓库、Linear 评论与 `aa-handoff/` 检查点中未找到对本对账读模型的后续有效批准。方向性"先把能做的完成"不等于具体设计批准。

因此本文件是**待审方案**，不是已批准实现。

## 1. 范围声明

本方案只做 PRI-1109 的**只读对账子范围**：读取既有 EventLog JSONL，回答问题 (1) 有开始与终态、(2) 只有开始且当前范围内无可见终态、(3) 缺开始/身份不完整/记录无效、(4) 重复或冲突、(5) 当前证据能确认什么与仍有哪些未知。

不做：写 `reconciled` 记录、修写侧、建新表/新库/后台服务/队列、调用模型、改安装目录、改生产配置、改冻结包与审批记录、真实 Agent 实验。

## 2. 复用的现有能力（不建第二套真源）

| 能力 | 入口 | 复用于 |
|---|---|---|
| journal 唯一写入 | `packages/openclaw-plugin/src/core/event-log.ts` `recordAdaptiveDelivery`（144-150），先正式校验再 `record('adaptive_delivery','written')` | 定义被读事实；本方案只读 |
| open 写点 | `packages/openclaw-plugin/src/hooks/prompt.ts` `beginAdaptivePromptInvocation`（293-302） | `receiptState=open` 的字段集合 |
| 终态写点 | 同文件 1073-1084（仅当 `adaptiveInvocationId` 存在，终态带 `reason/addedTarget/nativeAdmissionId/targetBodySha256`） | `closed` 的字段集合与"终态只由写侧产生" |
| 记录校验器 | `packages/principles-core/src/runtime-v2/activation/adaptive-delivery-record.ts` `validateAdaptiveDeliveryRecord`（66-160） | 逐条判定"无效四维/缺身份/证据约束" |
| 保留期真源 | `packages/principles-core/src/runtime-v2/receipt-coverage.ts` `INTERVENTION_SHORT_SOURCE_RETENTION_DAYS = 7`（22）；写侧 41 行同源引用 | 时间窗口上限，不硬编码第二个 7 |
| 日志目录真源 | `packages/host-runtime/src/prompt-injection-budget-observation.ts` `RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS`（64） | `.pd/logs`、`.state/logs` 候选顺序 |
| 有界读取先例 | 同文件 77/87/95 行 `MAX_FILES=7`、`MAX_FILE_BYTES=4MiB`、`MAX_AGE_MS`，及 tail-read/containment/parseFailures 处理 | 读取上限与"不可读≠零"原则 |
| 同仓 JSONL 读法先例 | `packages/pd-cli/src/commands/runtime-activation.ts` `collectRuleCodeEventEntries`（127-153） | 候选目录优先级、完全相同行去重、不可读目录不计为健康零事件 |

写入文件命名：`getEventsFile`（event-log.ts 76-78）`<stateDir>/logs/events_<UTC日期>.jsonl`，追加写、按 UTC 日期切分，保留 7 天（cleanup，94-113）。读取以文件名为日期边界，不用 mtime 推断事件时间。

## 3. 方案（推荐的最小形态）

新增一个只读模块 + 一个只读 CLI 子命令：

- `packages/host-runtime/src/adaptive-journal-reconciliation.ts`：纯函数分类 + 有界读取；`reconcileAdaptiveJournal({ workspaceDir, since, until, host, limits })`；不打开 SQLite、不写文件、不建目录。
- `packages/host-runtime/src/index.ts`：一行导出（跨包消费所必需）。
- `packages/pd-cli/src/commands/runtime-activation.ts`：`pd activation journal`（沿用现有 `activation` 命令族与 `--workspace`/`resolveWorkspaceDir`）。
- 测试：`packages/host-runtime/tests/adaptive-journal-reconciliation.test.ts`、`packages/pd-cli/tests/commands/runtime-activation-journal.test.ts`。
- 不改 `packages/openclaw-plugin/**`、不改 core 校验器、不改安装目录。

替代形态（更小但无操作者入口）：只做 host-runtime 纯读模块，不注册 CLI。本方案推荐 CLI，因为 `mvp-q-2` 要求可观察；若 Owner 选择纯库，则删除 CLI 两项改动即可，其余不变。

## 4. 输入、范围与隔离

- `workspaceDir`：必填，经现有 `resolveWorkspaceDir` 解析为绝对路径；读取前 `realpath` 校验候选日志目录必须落在该工作区实路径内，逃逸即 `outside_workspace` 错误，不读。
- 宿主：默认且本轮只处理 `data.host === 'openclaw'`；其它值或缺失 → `host_identity_unknown`，单独计数，**绝不与 openclaw 合并**。
- 工作区：`data.workspaceDir` 规范化后必须等于本次请求工作区；不等 → `foreign_workspace`，排除并计数；缺失 → `workspace_identity_unknown`，归入 `workspaceDir:null` 分组，**不与已验证工作区分组合并**（覆盖"不同工作区恰好同号"）。
- 时间窗口：UTC ISO；默认 `until = now`、`since = now - retentionDays`；闭区间 `[start, end]`。`since` 早于保留边界时截断到保留边界并置 `clampedByRetention=true`；`until > now` 或 `end < start` 为参数错误（退出码 2）。事件时间用信封 `ts`，不用文件名或 mtime。
- 只读：输入文件前后 `sha256` 必须一致（测试断言），工作区目录列表前后不得新增文件。

## 5. 身份与配对规则

配对键：`(host, normalizedWorkspaceDir, sessionId, hookInvocationId)`。

- `hookInvocationId`：唯一调用关联符，必须非空字符串；缺失 → 归 `rejected`。
- `sessionId`：以信封 `sessionId` 为权威；`data.sessionId` 若存在且与信封不等 → `session_identity_mismatch`，该组判 `invalid`，不配对。`sessionId` 缺失 → 身份不完整，不与其他组配对。
- `runId`、`requestId` 只作投影展示，**不进入配对键**（二者均可缺失，不能成为隐式要求）。
- 跨文件同键允许配对；写入顺序不构成"及时性"证据，配对也不证明送达。

## 6. 分类与原因码（封闭集合）

`classification`：`paired_open_and_terminal` | `open_only` | `terminal_only` | `conflicted` | `invalid`。

原因码：

- `terminal_not_visible_in_range`：有 open、扫描范围内无终态。**只表示"当前范围内未找到终态"，不得表述为中断/超时/宿主 kill。**
- `terminal_after_window_end`：open 在窗口内且 `window.endIsNow=false`，终态可能落在窗口之后；与上一条同时出现。
- `start_not_visible_in_range`：有终态、范围内无 open；开始可能早于窗口或保留期，**未知，不是零开始**。
- `exact_duplicate_record`：同键同状态且数据逐字段相同（按规范化 JSON 比较）；计入副本数，只保留最早一条。
- `multiple_starts_conflict`：同键 ≥2 条不同的 open。
- `conflicting_terminal_states`：同键 ≥2 条不同终态（四维/原因/证据任一不同）；保留全部变体，不选胜者。
- `malformed_json`：行无法解析。
- `invalid_envelope`：非对象、缺/非法 `ts`、`type` 不等于 `adaptive_delivery`、`data` 非对象。
- `missing_hook_invocation_id`：记录无法归属到调用。
- `invalid_four_dimension_state`：`validateAdaptiveDeliveryRecord` 失败（枚举/开启终态约束/证据约束）。
- `session_identity_mismatch`、`workspace_identity_unknown`、`foreign_workspace`、`host_identity_unknown`。
- `record_before_coverage_start`：tail-read 截断导致更早行不可见，该组计数为下界。
- `output_truncated`：输出条数达到上限。

重复与冲突互斥处理：逐字段相同的重复只计数并去重；不同内容的多次开始/终态进 `conflicted`，同时保留全部变体。

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
    "truncatedFiles": ["<abs path>"],
    "errors": [{"logDir": ".state/logs", "file": "events_2026-11-05.jsonl",
                "code": "read_failed | stat_failed | outside_workspace", "message": "<bounded>"}]
  },
  "totals": {
    "linesRead": 10, "adaptiveRecords": 8, "malformedJsonLines": 1,
    "invalidEnvelopeRecords": 1, "invalidRecords": 2, "duplicatesExact": 1,
    "uniqueInvocations": 3, "countsAreLowerBounds": false
  },
  "invocations": [{
    "invocationId": "<hookInvocationId>",
    "identity": {"host": "openclaw", "workspaceDir": "<abs>", "workspaceVerified": true,
                 "sessionId": "<id|null>", "sessionIdSource": "envelope|data|both",
                 "runId": "<id|null>"},
    "classification": "paired_open_and_terminal | open_only | terminal_only | conflicted | invalid",
    "reasonCodes": ["<reason>"],
    "open": {"ts": "<ISO>", "receiptState": "open", "execution": "unknown", "payload": "unknown",
             "selection": "unavailable", "submission": "unknown", "selectionPending": true,
             "artifactId": "<id>", "activationId": "<id>", "requestId": null,
             "evidenceReferencePresent": false, "evidenceIndependentlyVerified": false,
             "hostKillConfirmed": false} | null,
    "terminal": {"ts": "<ISO>", "receiptState": "closed|reconciled", "execution": "<enum>",
                 "payload": "<enum>", "selection": "<enum>", "submission": "<enum>",
                 "selectionPending": false, "reason": "<string|null>",
                 "artifactId": "<id>", "activationId": "<id>", "requestId": null,
                 "evidenceReferencePresent": false, "evidenceIndependentlyVerified": false,
                 "hostKillConfirmed": false} | null,
    "terminalVariants": ["<同 terminal 投影，仅冲突时多于 1 条>"],
    "duplicates": {"open": 0, "terminal": 0},
    "window": {"openInWindow": true, "terminalInWindow": true, "terminalSearchComplete": true},
    "unknowns": ["<本条可确定的未知>"]
  }],
  "rejected": [{"reasonCode": "<reason>", "count": 1,
                "samples": [{"logDir": ".state/logs", "file": "<name>", "line": 12,
                             "hookInvocationId": null}]}],
  "outputTruncated": false,
  "omittedInvocations": 0,
  "answers": {
    "q1_open_and_terminal": {"count": 1, "invocationIds": ["<id>"]},
    "q2_open_without_visible_terminal": {"count": 1, "invocationIds": ["<id>"]},
    "q3_missing_start_or_identity_or_invalid": {"count": 2, "invocationIds": ["<id>"],
                                                "reasonCodes": ["<reason>"]},
    "q4_duplicate_or_conflicted": {"count": 1, "invocationIds": ["<id>"]},
    "q5": {"confirmedFacts": ["<仅扫描范围内可声明的事实>"],
           "unknowns": ["<不可声明为事实的部分>"],
           "notes": ["<重复/冲突/截断/覆盖下界>"]}
  },
  "nextAction": ["<可执行下一步>"]
}
```

当 `coverage.status = unavailable` 时，`countsAreLowerBounds=false`、四个 `count` 为 `null`，`q5.unknowns` 首条为"无可读日志目录 = 未知，不等于零调用"。
参数错误时 stdout 仍为单个 JSON：`{"schemaVersion","generatedAt","readOnly":true,"error":{"code","message","nextAction"}}`。

投影只暴露上列字段，不回显任意未知键（rc-8），不复制正文。

## 8. 去重、冲突、缺失与窗口截断

- 同目录同文件内逐字段相同的行：计 `duplicatesExact`，保留最早 `ts`。
- 跨候选目录完全相同的行：按 `.pd/logs` 优先去重（沿用 127-153 的语义），不把同一行算两次调用。
- 同键多终态/多开始：`conflicted`，`terminalVariants` 全量保留（受输出上限约束），不推断哪一个"真实"。
- 缺开始：`terminal_only`，`q5` 明确"start unknown"。
- 缺终态：`open_only`，措辞固定为"当前范围内未找到终态"。
- 窗口截断：文件超过 4 MiB 只读尾部，丢弃半行，记 `truncatedFiles`；受影响的组加 `record_before_coverage_start`，`countsAreLowerBounds=true`。
- 保留期：窗口不可能超过 7 天；早于保留期的记录已不可见，`clampedByRetention` 必须显式。

## 9. 读取上限、错误处理与成本

- 每候选目录最多 7 个文件、每文件最多 4 MiB，最坏 56 MiB；顺序读取，不并发、不重试。
- 目录不存在/不可读：`coverage.status` 降级并记错误；**不得把不可读当零事件**（ERR-002）。
- 单行错误不影响其余行；校验器异常已被其自身捕获，读取层不再抛。
- 输出上限：`invocations` 最多 1000 条、每个 `rejected.reasonCode` 样本最多 5 条；超出置 `outputTruncated=true` 与 `omittedInvocations`，并加原因码。
- 成本：零模型调用、零数据库、零新增依赖、零常驻进程；一次人工触发的有界文件扫描。

## 10. 验收与回滚

验收（隔离临时目录 + 真实 JSONL 行格式）：

1. 正常 open→closed 配对；2. 只有 open；3. 只有终态；4. 完全相同重复去重并计数；5. 冲突终态/多次开始；6. 非法 JSON、非法四维、缺身份、非法信封；7. open 在窗口内/终态在窗口外以及窗口截断；8. 跨工作区同 `hookInvocationId` 不合并、外工作区记录被排除；9. 跨宿主不合并；10. 目录/文件读取失败产生 `partial`/`unavailable` 且退出码非 0；11. 输入文件前后 `sha256` 相同、工作区无新增文件；12. CLI stdout 单个合法 JSON、诊断仅 stderr；退出码 0（完成，含异常发现）、2（参数错误）、3（partial/unavailable）；13. 源码不依赖 fs 写接口、SQLite、模型。
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
| `packages/pd-cli/src/commands/runtime-activation.ts`、`src/index.ts`（追加注册） | 本任务 | 其他 AA 工单不得同改；冲突时由集成者串行 |
| `packages/pd-cli/tests/commands/runtime-activation-journal.test.ts`（新） | 本任务 | 可并行 |
| `docs/specs/PD-AA-PRI-1109-JOURNAL-RECONCILE-DESIGN-v0.1.md` | 本任务 | 本设计文件唯一写者 |
| `docs/implementation-reports/aa-handoff/**` | 本任务追加 | 历史文件不覆盖 |

不触碰：`packages/openclaw-plugin/**`、core 校验器、`~/.pd/runtime/**`、安装/生产配置、数据库、冻结包与审批记录。

## 12. 本方案未覆盖的整票验收

- 生产写侧产生 `reconciled`、终态对账策略（超时/宿主 kill 需独立证据）；
- `submission` 的独立确认、真实请求正文证据、行动前/后时序；
- 统一证据读模型（PRI-1114）、配置身份（PRI-1110）、真实行为评价；
- 真实 Agent/模型实验、安装启用、Shadow/Live、发布；
- PRI-1109 整票关闭（仍被 PRI-1107 阻塞）。

## 13. 需要 Owner 决定

1. 是否批准本只读读模型与 `pd activation journal` 入口（推荐），或只批准 host-runtime 纯库形态。
2. 是否接受默认窗口 = 完整 7 天保留期（成本上限 56 MiB/次），还是改为默认 24 小时。
3. 是否接受输出条数上限 1000 + `outputTruncated` 标记（不静默丢弃）。
