# PD-AA 行为证据关联设计 v0.1（PRI-1114）

日期：2026-11-06
基线：`953d12f5b59c3c05d1bba530b6c99f3d38d3b4e0`（origin/main，已合并 PR #2370）
状态：**NEEDS_OWNER — 未找到覆盖本实现范围的 Owner 设计批准；本轮只做调查与方案，未写任何生产行为代码。**

## 0. 授权与现场核实结论

逐项独立核实（不采信转述）：

| 事实 | 核实方式 | 结论 |
|---|---|---|
| PR #2370 已合并 | `gh pr view 2370`（state=MERGED, merge commit `953d12f5b`）+ `git merge-base --is-ancestor 47b617734 origin/main` 返回 0 | 已在 main；但**主检出本地 HEAD 是旧提交**，`47b617734` 上的 `adaptive-config-identity.ts` 在旧 HEAD 不存在。所有工作必须在新建任务工作树内进行。 |
| #2370 提供配置身份快照 | `git diff --name-only 953d12f5b^1 953d12f5b` 显示新增 `packages/openclaw-plugin/src/core/adaptive-config-identity.ts`，并被 `prompt.ts:311/324` 调用 | 快照已写入 `adaptive_delivery` journal 事实，不需要本任务重造。 |
| PRI-1109 子契约已交付 | PR #2362 合入 `adaptive-journal-reconciliation.ts` + `pd activation journal`；读 `runtime-activation.ts:1896-1990` | 只读对账子范围可用、可复用；整票仍未完成。 |
| PRI-1109 剩余阻塞 | Linear：PRI-1109 `In Progress`，被 PRI-1107（`In Review`）阻塞 | 真实存在，不删除 blocker、不绕过 start 守卫。 |
| PRI-1114 状态 | Linear：`Backlog`，blocked by PRI-1109；验收字面要求“复用 901 读模型/本票行为读模型” | 本轮不得将整票标为完成。 |
| PRI-901 状态 | Linear：`Backlog`，无 blocker；仓库中无对应已合并读模型 | **不能当作已实现组件**。 |
| PRI-1107 设计批准边界 | Linear：`In Review`；`docs/specs/PD-AA-PRI-1109-JOURNAL-RECONCILE-DESIGN-v0.2.md` §0 记录 G0 未通过、稳定机会/请求身份仍待确认 | 未覆盖“干预↔行为关联”的实现批准。 |
| 本范围批准 | 检索 `docs/specs/`、`docs/implementation-reports/aa-handoff/`、Linear 评论 | **无覆盖本设计的明确批准** → 本轮交付方案。 |

方向性“先把能做的完成”不构成具体设计批准；设计文档合并不等于代码实现批准。

## 1. 范围声明

本方案只定义 PRI-1114 的**只读关联读模型**：把一次原则注入机会（`hookInvocationId`）与其后**可观测**的首个行动、后续纠正、产物与任务结果，按可核实身份做关联，并把不可核实部分保留为未知。

语义红线（与 SPEC v0.6 C05/C08 一致）：

- `returned`、`confirmed`、`遵循原则`、`任务改善` 是四个独立结论，本读模型不合并、不互推；
- 无独立证据时输出 `unknown`，绝不由 Agent 自述、receipt 或时间邻近补齐；
- 后来的纠正不覆盖、不删除第一次行动；
- 同一 Session、相近时间、相同原则 ID 都不构成“同一请求”的充分证据；
- 不持久化请求正文与无关私人会话；
- **不新增任何生产写入**（尤其不写 `reconciled`），不做模型调用。

不做：新建通用 Behavior Engine / Evaluation Platform / 数据库 / worker / 第二套事件读取框架；改 core 校验器；改安装目录；Shadow/Live；真实 Agent 回合。PRI-1115 的统计聚合也不在本方案内，本方案只交付它可消费的关联结果。

## 2. 现有能力事实表

事实优先级：生产代码 > schema > 生产接线 > 测试。行号基于基线 `953d12f5b`。

| # | 所需事实 | 当前生产者 | 可用身份字段 | 现有读取入口 | 现有消费者 | 状态 |
|---|---|---|---|---|---|---|
| F1 | 某次注入机会存在（open） | `prompt.ts:320-333` `beginAdaptivePromptInvocation` → `recordAdaptiveDelivery` | `hookInvocationId`, sessionId, runId, artifactId, activationId, host | `reconcileAdaptiveJournal`（host-runtime）；`pd activation journal` | CLI 操作者 | **已有** |
| F2 | 注入正文摘要与终态 | `prompt.ts:1111-1123`（closed，含 `targetBodySha256`/`nativeAdmissionId`/`reason`） | 同上 + `targetBodySha256` | 同上 | CLI 操作者 | **已有** |
| F3 | 本次请求的注入集合 | `prompt.ts:828-841` `recordRuntimeV2ActivationsInjected` | `hookInvocationId`（可选）, `eventId`, `runId`, `sessionId`, workspaceDir, activationIds/artifactIds/principleIds | `readInjectionEventEvidence`（按 workspace+activation 聚合，不含请求粒度）；`principles-stats`（按 turn 读） | CLI/stats | **已有事实，未接通到行为** |
| F4 | 配置身份快照 | #2370 `adaptive-config-identity.ts`，经 `prompt.ts:311/324` 写入 journal 事实 | host/pluginVersion/effectiveHookSetFingerprint/evidenceCoverage/configIdentityCoverage | journal report 的 invocation 事实 | CLI 操作者 | **已有**（仅存活在 journal 内） |
| F5 | 首次行动（工具调用） | `production-pain-evidence.ts:555` 写 `tool_calls`；EventLog `tool_call`（`runId`+`toolCallId`） | 表侧：sessionId、`tool_use_id`、project_dir、host_kind、created_at；事件侧：runId、toolCallId | 直接 SQLite（`workspace-behavior-evidence.ts:60` 等 readonly 先例） | 行为证据端口、rule context provider | **已有事实，无 `hookInvocationId` 外键** |
| F6 | 后续纠正 | `trajectory.ts:402-410` `recordUserTurn`（`correction_detected`/`references_assistant_turn_id`）；`correction_samples`（`trajectory.ts:1714-1735`） | turn id、被引用 assistant turn id、sessionId | 直接 SQLite | 样本导出/评审 | **已有，但 sample 的 `principle_ids_json` 为空、recovery span 为会话级** |
| F7 | 产物 | `tool_calls.params_json`（file_path/command）、project_dir、`result_preview`、exit_code | 同上（F5） | 直接 SQLite | 行为证据端口 | **已有事实，无干预身份** |
| F8 | 任务结果 | `llm.ts:216-224`（PRI-768）→ `trajectory.ts:589-599` `task_outcomes` | `task_id` = host `runId`；`principle_ids_json` = 会话级注入集合 | 直接 SQLite | 仅 `intervention-evidence-recorder.ts` 与测试 | **已有，会话/运行级，非请求级** |
| F9 | 模型身份 | `trajectory.ts:379-385` `assistant_turns.provider/model` + `run_id` | runId、provider、model | 直接 SQLite | stats/导出 | **已有** |
| F10 | 应用/效果（gate 干预） | `intervention-evidence-recorder.ts` → `principle_receipt_ledger`（flag 控制） | native refs：hostKind/sessionId/runId/toolCallId；activationRef | `intervention-evidence-ingress.ts`（readonly） | 控制台 Phase 1 | **已有，但语义是 gate 干预，不是 prompt 注入**；本任务不复用其写侧 |
| F11 | 请求身份 `requestId` | 无生产者 | — | — | — | **缺失**：`hookInvocationId` 是唯一的请求粒度身份，不另造 `requestId` |
| F12 | 行动 ↔ 注入的现成连接 | 无 | — | — | — | **缺失（核心缺口）** |

### 2.1 关键缺口（只列真实缺口，不重复造能力）

- **G1（未接通）**：`hookInvocationId` 存在于 F1/F2/F3，但 `tool_calls`、`user_turns`、`task_outcomes` 都不携带它；没有读模型做连接。
- **G2（弱身份）**：`tool_calls` 表无 `run_id`；run 绑定只存在于 EventLog `tool_call` 事件（`runId`+`toolCallId`）与 `assistant_turns.run_id`。跨源必须在同一 run 内按 `runId` 对齐，不能按 session/时间臆断。
- **G3（汇总级）**：`task_outcomes.principle_ids_json` 是会话级注入集合；当一次 run 有多次注入时不能归属到单次请求。
- **G4（缺原则绑定）**：`correction_samples.principle_ids_json` 恒为空；recovery span 取会话最近调用，非本轮行动。
- **G5（覆盖不可见）**：JSONL（journal/injection）与 SQLite（trajectory）两个源各自的读取预算，没有统一覆盖结论；预算耗尽时容易被误读为“没有行为”。

**结论**：不缺失“行为事实本身”，缺失的是**以 `hookInvocationId`/`runId` 为骨架的只读连接层**。PRI-901 与 PRI-1114 不得各写一套：本方案建议 PRI-1114 独占“干预↔行为关联读模型”，PRI-901 只在其上做统计/聚合（见 §9 A5）。

## 3. 关联模型

### 3.1 机会身份（唯一入口）

以 `reconcileAdaptiveJournal` 的输出为主键来源：一个 `hookInvocationId` = 一次注入机会。附带：

- `runId`（若 open/injected 事件提供）；
- `sessionId`、`host`、`workspaceDir`（隔离边界，不跨 workspace/session 合并）；
- 目标：`artifactId` + `activationId`（target 一致性由既有对账报告保证）；
- 正文摘要：`targetBodySha256`（不读取正文）；
- 配置快照：`configIdentity`（F4）；
- 终态：`closed/未找到终态/冲突/重复`（沿用既有分类，不重新判定成功）。

### 3.2 三类关联强度

| 级别 | 规则 | 可支撑的结论 |
|---|---|---|
| **strong（run-scoped）** | 行动/轮次/结果与注入**同 `runId`**，且该 `runId` 在机会集合中**只对应一个 `hookInvocationId`**；`toolCallId` 在 `tool_calls` 表内唯一 | “该机会所在 run 内发生了这个行动/结果”。仍不等于“遵循原则”。 |
| **weak（候选）** | 仅同 sessionId + 时间在注入之后且窗口内；或同 principle/activation ID | 只能标 `candidate`，`verified=false`，**不得升级**为 strong |
| **unlinked / unknown** | 缺 runId、缺事件、跨 session/workspace、读取预算耗尽 | 输出 `unknown` + 原因码 |

`runId` 唯一性必须显式计算：同一 run 出现多个 `hookInvocationId` 时，全部降级为 `ambiguous`，不做多数投票、不按时间选优。

### 3.3 各事实的取法

| 事实 | 取法 | 强度 |
|---|---|---|
| 首次行动 | EventLog `tool_call`（`runId`+`toolCallId`）→ 用 `(sessionId, toolCallId)` 匹配 `tool_calls` 行（`tool_use_id` 唯一索引 `trajectory-schema.ts:216`） | strong（run 唯一）/ weak |
| 后续纠正 | `user_turns.references_assistant_turn_id` → `assistant_turns.run_id`；`correction_detected=1` | strong（run 唯一）/ weak |
| 产物 | `tool_calls.params_json.file_path` / `command` + `project_dir`；只投影路径与命令，不读文件内容 | 与行动同强度 |
| 任务结果 | `task_outcomes.task_id == runId`，且 run 唯一 | strong；若 `principle_ids_json` 与本次注入集合不一致 → 输出 `conflict`，不覆盖 |
| 行动先于干预 | 行动 `created_at` 早于机会 `open.ts` → `pre_action`，不计入首次行动 | 明确反例 |
| 纠正掩盖首次行动 | 首次行动与纠正分开列；纠正只记录“后续”，不回写首次行动 | 明确反例 |

不持久化请求正文；只投影摘要 hash 与计数。

### 3.4 呈现规则

对每个机会输出：

- `intervention`: 身份、目标、摘要 hash、配置快照、终态（多维，不合并）；
- `evidence.strong[]`: 每个条目含 `factKind`（action/correction/artifact/outcome）、源表/事件、行键、时间、强度依据；
- `evidence.weakCandidates[]`: 明确标注 `candidate` 与命中原因；
- `unknowns[]`: 原因码 + 缺失的具体事实；
- `conflicts[]`: 重复终态、目标不一致、任务结果原则集合不一致、行动早于干预；
- `counts`: 各事实数量；`coverage`: 双源窗口、文件数、行数、是否截断、`complete=false` 的原因。

一次机会 → 多次行动/多条纠正/多次结果全部保留；同一 `hookInvocationId` 的重复记录保留并标 `duplicate`；冲突不做裁决。

### 3.5 有界与降级

| 项 | 上限 | 超限行为 |
|---|---|---|
| 时间窗口 | 默认 7×24h（与 `INTERVENTION_SHORT_SOURCE_RETENTION_DAYS` 同源，可由 `--since/--until` 覆盖） | 窗口被保留期截断 → `clampedByRetention` |
| 机会数 | 1000（沿用 journal） | `outputTruncated=true`，计数为下界 |
| 每机会关联行 | 行动 200 / 纠正 50 / 结果 20 | `omitted` + 按事实类型报告 |
| SQLite 总扫描 | 5000 行 | `coverage.rowLimitReached=true` |
| JSONL | 沿用 journal：每目录 8 文件、每文件 4 MiB、每机会 5 终态变体 | 由 journal report 原样透出 |

任一上限命中都必须在 `coverage.incompleteReasons[]` 出现；`unknown ≠ 0`。读取 SQLite 一律 `readonly`（复用 `principles-core/src/trajectory-store.ts:96 openTrajectoryDbReadonly`），DB 不存在 → `unavailable`，不是空结果。单行解析失败计入 `parseFailures`，不猜测。

## 4. 最小接线方案（待批准后才实现）

新增 1 个只读模块 + 1 个只读 CLI 子命令：

- `packages/host-runtime/src/adaptive-behavior-linkage.ts`
  `linkAdaptiveBehaviorEvidence({ workspaceDir, since, until, host, limits }) → { ok: true, report } | { ok: false, error: {code,message,nextAction} }`
  内部顺序：`reconcileAdaptiveJournal(...)` 取机会 → `openTrajectoryDbReadonly` 取行为 → 纯函数归类。**不重写 JSONL 读取、不重写四维校验、不开新表。**
- `packages/host-runtime/src/index.ts`：一行导出。
- `packages/pd-cli/src/commands/runtime-activation.ts`：新增 `link` 子命令（`pd activation link`），与 `journal` 同构的薄包装：stdout 单个 JSON 文档，诊断到 stderr，`--json` 严格（cli-1/2）。
  不复用 `journal` 命令输出，避免破坏 v0.2 已定稿契约。
- 测试：`packages/host-runtime/tests/adaptive-behavior-linkage.test.ts`（确定性 fixture：临时 JSONL + 临时 SQLite）、`packages/pd-cli/tests/commands/runtime-activation-link.test.ts`（命令注册与 stdout/exit 契约）。

真实消费者：**PRI-1115 的统计聚合**与操作者 CLI。控制台本轮不接（避免 Owner 界面出现未批准语义）。

写入者：本任务唯一写者，仅上述文件。不触碰 `packages/openclaw-plugin/**` 写侧、core 校验器、安装目录、生产配置。

## 5. 失败、缺证、冲突与覆盖反例（验收必须覆盖）

1. 跨请求/跨 Session 的相同原则 ID → 不建立 strong。
2. 弱时间关联 → 只输出 candidate。
3. 一次机会对多次行动/多次纠正 → 全保留，不折叠。
4. 重复终态与冲突终态 → 保留并标 duplicate/conflict。
5. 行动先于干预 → `pre_action`。
6. 后续纠正掩盖首次行动 → 首次行动仍在 strong/weak 中。
7. 缺终态 / 缺任务结果 → `unknown`，不是 `0`/失败。
8. 配置身份变化（`effectiveHookSetFingerprint` 不同）→ 旧成功不能充当新配置证据；输出 `config_changed`。
9. 读取预算耗尽 → `coverage.incompleteReasons`，计数为下界。
10. run 内多次注入 → 全部 `ambiguous`。
11. SQLite 不存在 / 表结构缺列 → `unavailable`，不建库、不迁移。
12. `task_outcomes.principle_ids_json` 与本次注入不一致 → `conflict`。

## 6. 测试与真实消费路径

- 单测：临时目录内构造 JSONL（open/closed/重复/冲突/缺 runId）+ 临时 `trajectory.db`（session/assistant_turns/tool_calls/user_turns/task_outcomes），逐条覆盖 §5 反例；断言 `readonly`（运行前后文件 mtime 与 hash 不变）。
- 契约：`pd activation link --json` 的 stdout 必须是单个可解析对象；缺 DB 时 exitCode≠0 且 stdout 仍有结构化 `error.nextAction`。
- 真实消费路径：CLI 注册测试调用真实 parser/handler（不是只测内部函数），并验证顺序（`journal` 输出不受影响）。

不运行完整 `verify:merge`；合并前跑相关包测试与快速 pre-push 检查。

## 7. 复杂度增量

| 项 | 结论 |
|---|---|
| 新持久化真源 | NO（只读投影） |
| 新持久化 schema/状态 | NO（不建表、不写 reconciled） |
| 新子系统/服务/后台进程 | NO |
| 新公共抽象/接口 | **YES**：1 个只读模块 + 1 个 CLI 子命令。理由：现有 journal 只能回答“干预发生了什么”，行为侧只有散表；没有现成入口能完成关联，且该边界是 PRI-1115 的唯一输入 |
| 新特性开关 | NO（只读、可整提交 revert；`mvp-q-3`） |
| 新跨包依赖 | YES：pd-cli → host-runtime（既有依赖方向的延续） |
| 新 host 专属行为 | NO（以 host 字段隔离，不新增宿主分支） |
| 新外部/网络能力 | NO |

`mvp-q-1`（不做会怎样）：无法回答“这次原则是否伴随行动改善”，PRI-1115 只能用会话级计数，容易把“有注入”当成“有效果”。
`mvp-q-4`（情绪价值）：降低“我知道注入了，但不知道后来发生了什么”的不确定感；不制造“已证明有效”的安心感。

## 8. 验收与回滚

验收（实现后）：

1. 12 条反例全部有确定性测试并通过；
2. 输出不含正文、不含模型生成内容；
3. `strong` 只在 run 唯一时出现，且报告强度依据；
4. 双源预算耗尽时报告 `coverage.complete=false` 与原因；
5. 运行不修改任何文件（hash/mtime 不变）；
6. `pd activation link` 严格 JSON 契约；
7. `pd activation journal` 输出与现有测试不变；
8. 不新增生产写入（可用测试断言 DB/日志无变化）。

回滚：整提交 revert；无持久状态、无迁移、无缓存。

## 9. 待 Owner 批准的具体事项

- **A1 形态**：批准新增只读 `adaptive-behavior-linkage.ts` + `pd activation link`，作为 PRI-1114 的唯一实现入口；不提供并列服务/纯库形态。
- **A2 关联强度规则**：批准 §3.2 的 `strong = 同 runId 且 run 内注入唯一`；同 session/时间/同原则一律只作 weak candidate；一次 run 多注入全部 ambiguous。
- **A3 读取预算**：批准 §3.5 的 7 天 / 1000 机会 / 200-50-20 关联行 / 5000 SQLite 行，全部超限必须显式降级。
- **A4 写侧红线**：批准本方案不新增任何生产写入（不写 reconciled、不补 task outcome、不改 correction sample）。
- **A5 与 PRI-901 的唯一归属**：建议 PRI-1114 独占“干预↔行为关联读模型”，PRI-901 只做聚合/统计；避免两个代理各写一套。需 Owner 确认。
- **A6 依赖解锁**：PRI-1114 被 PRI-1109（其本身被 PRI-1107）阻塞。请 Owner 决定：是在阻塞解除前授权按本设计并行实现（只读、无写侧接触），还是维持完全阻塞、仅保留设计。
- **A7 是否需要控制台入口**：本方案默认不接控制台；若 Owner 需要，另立子范围。

在 A1–A6 获得明确批准前，不写实现代码。本文件不是代码实现批准。
