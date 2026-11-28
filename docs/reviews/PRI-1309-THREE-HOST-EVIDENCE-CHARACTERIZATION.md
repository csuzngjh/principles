# PRI-1309 — Three-Host Evidence Characterization

> 状态：characterization 记录，不是生产修复方案。
> 审查基线：`86c5662810179c18ad9c80fab675e5902982c07b`（`origin/main`）
> 前置交付：PR #2821 / PRI-1308 BehaviorHistory outcome & ordering characterization（创建本文时仍为 OPEN）
> 权威契约：`docs/reviews/PD-CAE-STAGE0-REALITY-AUDIT.md`、`docs/reviews/PD-CAE-STAGE0-OWNER-DECISION.md`、`docs/reviews/PD-CAE-STAGE1A-REPLAY-CONTRACT.md`
> 实施边界：仅新增/修改测试与本文档；未修改生产源码、生产 schema、生产 DB、宿主 adapter、RuleContext ABI、RuleCode、RuleHost gate 或 Service Host。

---

## 1. 结论摘要

1. **三个宿主的证据能力不相同，不能用同一个“工具调用历史”抽象抹平。** Codex 的调用身份最强；WorkBuddy 的身份可选但读取侧 attribution 最严格；OpenClaw 原生事件有身份，却在 shared trajectory lane 丢失。
2. **OpenClaw native `after_tool_call` 可携带 `toolCallId`/`runId`，但当前 adapter 不把它们传入 normalized `HostEventContext`。** shared writer 最终持久化 `tool_calls.tool_use_id=NULL`；`runId` 也没有被映射为 `turnId` 或任何其他 lineage 字段。
3. **OpenClaw pain receipt fallback 是另一条 native-aware lane。** 它能读取 native `toolCallId`/`runId` 做 receipt recovery；这不证明 shared trajectory writer 收到了同样身份。
4. **OpenClaw 的 content-shape dedupe 不能解释为物理调用计数。** distinct native ids 通常通过 enrichment `eventId` 间接使两行分开；无 native id 的 exact repeat 会折叠为 1 行；same native id + changed content 也会分裂为多行。SQLite 行数本身对“真实发生了几次调用”只能是 UNKNOWN / INCONCLUSIVE。
5. **Codex provider 当前读取侧不传 `hostKind`。** 同一 session/project/cutoff 下 foreign-host row 与 unattributed legacy row 都可能进入 Codex history window。这是已冻结的不对称事实，不是本工单修复对象。
6. **WorkBuddy provider 严格 attribution。** foreign row 是 `workbuddy_history_attribution_conflict`；legacy/unattributed row 即使与 proven rows 混合也是 `workbuddy_history_attribution_unprovable`；NULL project scope 是 `trajectory_project_scope_incomplete`。
7. **OpenClaw facts degradation 与 Codex/WorkBuddy 不一致。** truncated、execute 或 other 参与窗口时，OpenClaw 仍可能输出 assembled `priorReadOfTarget='no'` 和精确整数计数；该 `no` 是 pseudo-no。Codex/WorkBuddy 在同类窗口保守降级为 `unknown/null`。
8. **`normalizedPath` 非空只代表 mechanical gate entry，不代表资源归因。** direct structured path、synthetic target、opaque command、first-token shell capture、multi-target collapse、no-target 与 attribution-unprovable 必须分开。
9. **Codex `apply_patch` 在普通 RuleHost action 中当前是 `<tool:apply_patch>` synthetic target。** 单文件、多文件、legacy carrier 都不会在 `action.normalizedPath` 中变成真实文件路径；design-gate patch-target 解析是另一条事实通道。
10. **outcome provenance 强度宿主相关。** Codex text-only shell response 是 `unknown/text_only_response`；Codex transcript verified upgrade 只被 Codex ingestion 证实。WorkBuddy 的 PostToolUse/PostToolUseFailure 是 channel contract；OpenClaw adapter-wrapped object/array shape success 只是 `live-envelope-shape-inferred`，甚至 missing native result 也会因外层 envelope 是 object 而推断为 success，弱于显式 error、exit code 或 verified transcript。
11. **`requireApproval` 不是宿主暂停。** ruleDecision、shared gate decision、adapter-native host effect 必须分开。OpenClaw 只记录并继续；Codex/WorkBuddy encoder 也不把 approval metadata 变成阻断输出。
12. **WorkBuddy deny channel 的证据等级最高，但不能外推。** WorkBuddy 有真实 probe evidence；Codex 当前最高只能称 `contract-only`（更精确地是 permission-decision-encoded）；OpenClaw deny/approval 的真实宿主执行效果仍是 contract-only/unverified。

---

## 2. 证据范围与方法

本文综合三类证据：

1. 当前生产源码；
2. 本工单新增/扩展的 characterization tests；
3. PRI-1308 已冻结的 BehaviorHistory outcome/ordering 事实。

测试原则：

- 优先调用真实 production adapter、provider、writer、assembler、gate、encoder 或真实 RuleCode implementation runtime；
- fixture 手工 SQL 只用于构造生产可存储输入，不复制被测逻辑；
- positive control 证明链路确实工作；negative control 证明测试不是 vacuous；
- `UNKNOWN` / `INCONCLUSIVE` / unavailable 是一等结果，不得被统计成 positive 或 negative evidence；
- fixture oracle truth（causal position、resource identity、occurrence time）不进入 production input；
- 不新增 `occurredAt`，不把 rowid/`created_at` 当因果证据。

---

## 3. 三宿主身份能力矩阵

| 能力 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| 原生调用身份 | native event/context 可有 `toolCallId`、`runId` | `tool_use_id` required | `call_id` / `tool_use_id` optional |
| normalized shared identity | **当前丢失**：`context.toolCallId=undefined`；无 `runId` 字段 | `tool_use_id → context.toolCallId` | `call_id` 优先，`tool_use_id` fallback；两者缺失则 `undefined` |
| 是否允许合成身份 | 不允许；测试确认未合成 | decoder fail-loud requiring identity | 不合成 |
| persisted `tool_use_id` | OpenClaw shared lane 当前为 `NULL` | host-authoritative id | 有 id 时持久化；无 id 时 `NULL` |
| `runId` 语义 | 不是 turn id；未进入 shared trajectory lane | 不适用 | 不适用 |
| writer `host_kind` | `openclaw` | `codex` | `workbuddy` |
| identity dedupe | 不能走 `(session_id, tool_use_id, host_kind)` host-authoritative dedupe，因为 `tool_use_id=NULL` | 可走 identity dedupe | 有 id 时可走 |
| content-shape dedupe | 是主要 fallback；受 enrichment `eventId` 间接影响 | 有身份时不是主要路径 | 有身份时不是主要路径；无身份时可能 fallback |
| verified outcome join | `tool_use_id=NULL` 使当前 verified join 无法匹配 live row | Codex transcript ingestion 已证实 | 未证实有 transcript verified upgrade 生产链 |
| provider attribution | OpenClaw assembler 只按 `session_id` 读取；不按 `hostKind`/project 过滤，也无 cutoff/current-id exclusion | 写侧强、读侧未传 `hostKind` | 读写 attribution 最严格 |

### 3.1 OpenClaw identity chain 的实际测量

新增测试 `packages/openclaw-plugin/tests/host-runtime/openclaw-host-runtime-identity.test.ts` 通过真实 adapter + shared production writer 测量：

- native `event.toolCallId`、`ctx.toolCallId`、`runId` 均存在；
- normalized `HostEvent.context.toolCallId` 仍为 `undefined`；
- normalized context 没有 `runId`；
- `turnId` 也未被伪造；
- durable row 的 `tool_use_id` 为 `NULL`；
- `host_kind='openclaw'`，`project_dir` 为 resolved workspace path。

`packages/openclaw-plugin/tests/hooks/phase-a-default-production-path.test.ts` 的 registered-plugin durable-output characterization 进一步确认：即使走真实注册链路，最终结果仍是 `tool_use_id=NULL`。

### 3.2 OpenClaw dedupe 的实际测量

同一个 session 中 same-shape 调用：

| 场景 | duplicate statuses | SQLite rows | 解释 |
|---|---:|---:|---|
| distinct native `toolCallId` | `[false,false]` | 2 | enrichment `eventId` 间接进入 canonical preview，使两行分开；这不是 host-authoritative identity |
| 无 native id，exact repeat | `[false,true]` | 1 | content-shape fallback collapse |
| same native id exact repeat | second duplicate | 1（前两次） | 内容与 enrichment 均相同 |
| same native id changed content | `[false,true,false]` | 2 | changed content 改变 derived preview/eventId；说明当前机制仍是 content/enrichment identity，不是真正 physical-call identity |

因此：

- 不能因 2 行就断言发生了 2 次物理调用；
- 也不能因 1 行就断言只发生了 1 次物理调用；
- 正确结论保持 **UNKNOWN / INCONCLUSIVE**；
- `runId` 不参与该 writer 的 identity、dedupe 或 persisted row。

### 3.3 WorkBuddy identity 细节

`call_id` 是 primary，`tool_use_id` 是 fallback；两者皆缺时 `toolCallId` 为 `undefined`，不合成。当前实现还有一个已冻结细节：如果两者同时存在但不同，`call_id` 静默胜出，没有 conflict rejection。本工单只表征，不改变契约。

生产链路还证明：

- missing ids → PostToolUse row `tool_use_id=NULL`、`host_kind='workbuddy'`；
- 下一个同样缺 id 的 PreToolUse 因 empty current id 变成 `workbuddy_pre_tool_scope_mismatch`；
- `tool_use_id` fallback 写入后，后续带新 current id 的 PreToolUse 可以合法使用该历史行。

---

## 4. Host attribution / history window

### 4.1 Codex 当前读侧不对称

`createCodexRuleContextProvider` 调用 `readWorkspaceRuleContextRowsBefore` 时没有传 `hostKind`。因此：

- same session/project/cutoff 的 `host_kind='workbuddy'` row 可以进入 Codex history；
- baseline 名称（如 `read_file`/`write_file`）的 foreign rows 不只造成 `other` degradation，还可以真实影响 canonical kind、facts 与 counts；
- unattributed legacy rows 也可进入并计数；
- foreign row 若在其他 project，则被 exact project scope 排除。

这不是“foreign evidence 被证明为 Codex evidence”；它是当前读取行为缺少 host attribution 分隔。测试将其作为 defect/limits 冻结。

### 4.2 读取边界事实

Codex/WorkBuddy 共用 reader 的关键语义：

- `created_at < cutoff` 是严格小于；exact cutoff 排除；
- current id exclusion 独立于 cutoff；
- `tool_use_id IS NULL` 的 row 永远无法作为 current call 被排除，因为 SQL NULL 不等于 current id；
- exact `project_dir` 匹配；
- newest `limit` rows 保留后 reverse；
- 这只是 write/insertion visibility order，不是 causal order（PRI-1308）。

### 4.3 WorkBuddy strict attribution

WorkBuddy provider 当前语义：

| 场景 | 当前结果 |
|---|---|
| 全是 proven WorkBuddy rows | available，可计算 facts |
| 任一 foreign-host row | `workbuddy_history_attribution_conflict` |
| 全是 legacy/unattributed rows | `workbuddy_history_attribution_unprovable` |
| proven rows + 任一行 legacy/unattributed row | `workbuddy_history_attribution_unprovable`，不允许 partial count |
| legacy schema 无 `host_kind` column | `workbuddy_history_attribution_unprovable` |
| same-session NULL project row | `trajectory_project_scope_incomplete` |
| empty current call identity | `workbuddy_pre_tool_scope_mismatch` |

---

## 5. Facts degradation 矩阵

| 场景 | OpenClaw assembled facts | OpenClaw epistemic meaning | Codex | WorkBuddy |
|---|---|---|---|---|
| 完整窗口、确无 target read | `priorReadOfTarget='no'`，counts 精确 | 仅在 fixture 明确 complete-window 假设下可为 no | 同 conservative 规则下可精确 | 同 conservative 规则下可精确 |
| truncated、窗口内未见 target read | 当前仍输出 pseudo-`no` 与可见行整数计数 | **unknown** | `unknown` + all counts `null` | `unknown` + all counts `null` |
| execute 参与、未见 target read | 当前仍输出 pseudo-`no` 与可见行整数计数 | **unknown** | `unknown` + all counts `null` | `unknown` + all counts `null` |
| other 参与、未见 target read | 当前仍输出 pseudo-`no` 与可见行整数计数 | **unknown** | `unknown` + all counts `null` | `unknown` + all counts `null` |
| 真实 target read 可见 | `yes` | 可作为该 target read 的正证据（不证明完整因果） | `yes` | `yes` |
| unavailable history | `unknown/null` | 不得解释为 no/0 | 同左 | 同左 |

另一个跨宿主事实：`sameActionBlockCount` 在 OpenClaw assembler、Codex provider 和 WorkBuddy provider 的当前生产路径中都保持 `null`，因为三者都没有实现该计数；`null` 不是“没有 consecutive same-action block”的证据。

OpenClaw 的 pseudo-no 是已知缺陷，不是修复后的语义。必须区分：

- `assembledPriorReadOfTarget`：当前 assembler 输出；
- `epistemicPriorReadOfTarget`：在证据完整性下真正可宣称的认知结论。

---

## 6. 六类 target attribution

当前 production 没有显式 target-attribution 类型。`RuleHostInput.action.normalizedPath` 是单字符串；因此六类是证据分析维度，不是 runtime 已建模事实。

| 分类 | 当前机械行为 | 语义结论 |
|---|---|---|
| resource-attributed | direct `file_path/path/file/target` 提取并 normalize | 最强，但仍只是单一 lexical path；不证明所有副作用 |
| synthetic-target | pathless write / Codex apply_patch → `<tool:name>` | 非资源；可机械进入 gate，不可做同目标判断 |
| opaque-command | execute 无 recognized mutation target → 完整 command string | 非资源；相同 command 字符串不证明相同资源 |
| no-target | 无提取值 → `''` | gate skipped-before-evaluation；不得伪造目标 |
| attribution-unprovable | shell mutation regex 只捕 first token，如 `cp src dst→src`、`mv old new→old` | 可能误归因；不得把捕获 token 当真实/完整 mutation surface |
| multi-target | multi-file patch collapse 为 synthetic；`rm a b` 只保留 `a` | 多资源在当前 action 中不可见，不得压缩成一个可信资源 |

### 6.1 direct field 优先级与负控制

测试确认 direct extraction 只识别：

1. `file_path`
2. `path`
3. `file`
4. `target`

`filepath`、`filename` 等相似键不提供 direct resource evidence。

### 6.2 Codex apply_patch

真实/legacy carrier：

- `{ command: "*** Begin Patch…" }`
- `{ input: … }`
- `{ patch: … }`

在 `canonicalKind='write'` 下都不会被当作 shell command 解析；普通 RuleHost action 当前均为：

```text
<tool:apply_patch>
```

多文件 patch 也同样 collapse。不得虚构直接 `file_path`，也不得把第一个 `*** Update File:` header 当作单一资源。

### 6.3 Mechanical Gate Funnel vs Semantically-Attributable Funnel

生产边界矩阵测试使用真实 `createProductionHostRuntime`、SQLite activation state 和真实 Node RuleCode implementation runtime。probe rule 通过 `requireApproval` 回报实际收到的 action；这只是一种生产契约内 instrumentation，不代表 approval 有宿主暂停效果。

结果：

- direct structured write path → evaluated，resource-attributed；
- apply_patch / multi-file patch → evaluated，但 synthetic-target；
- `git status` → evaluated，但 opaque-command；
- `cp/mv/rm` → evaluated，但 first-token/multi-target attribution-unprovable；
- execute missing command、pathless agent → skipped-before-evaluation；
- read even with direct path → non-evaluable-kind skip。

---

## 7. OpenClaw early-skip telemetry contamination

真实 OpenClaw host-runtime/gate/adapter 链路表征显示：

- non-evaluable read with structured path；
- evaluable agent without target；
- evaluable exec without command；

这些 shared gate early-skip 场景仍会触发 adapter fallback 的 `rulehost_evaluated decision='allow'` 持久化调用。positive control 中，真正进入 initialized empty store 的 evaluable write 记录的是 `no_rules_armed`，不是 fallback allow。

含义：

- 不能把 persisted `rulehost_evaluated allow` 简单解释为 RuleCode engine 真的评估过该调用；
- coverage denominator 必须区分 hook reached、evaluable kind、has target、actually evaluated、early skip fallback telemetry；
- 本测试证明到 EventLog persistence invocation 层；物理 JSONL flush 未在本工单重新证明。

---

## 8. Outcome provenance 矩阵

| Host / shape | 当前 outcome | provenance class | 强度 |
|---|---|---|---|
| Codex shell text-only `tool_response` | `unknown` / `text_only_response` | `none-unknown` | 无证据 |
| Codex transcript integer exit code 0 | `success` | `verified-transcript-upgrade` | 强，但只证实 Codex ingestion |
| Codex transcript integer exit code ≠0 | `failure` | `verified-transcript-upgrade` | 强，但只证实 Codex ingestion |
| WorkBuddy PostToolUse string completion | `success` | `live-channel-contract` | 强：channel contract |
| WorkBuddy PostToolUse `is_error` | `failure` | `live-envelope-error` / channel contract | 强 |
| WorkBuddy PostToolUse integer exit/error | `failure` with real exit code | `live-exit-code` + envelope | 强 |
| WorkBuddy PostToolUseFailure thrown error | `failure` | distinct failure channel | 强 |
| OpenClaw explicit `{error,result}` envelope | `failure` | `live-envelope-error` | 强 |
| OpenClaw integer exitCode 0/非0 | `success`/`failure` | `live-exit-code` | 强 |
| OpenClaw text-only result | `unknown` / `text_only_response` | `none-unknown` | 无证据 |
| OpenClaw adapter-wrapped object/array without explicit completion evidence | `success` | `live-envelope-shape-inferred` | **弱**，不能单独支持 YES |
| OpenClaw adapter-wrapped missing native result | `success` | `live-envelope-shape-inferred` | **最弱**：没有 result/error/exit/text 证据 |

限制：

- outcome enum 相同不代表证据来源相同；
- `live-envelope-shape-inferred success` 不得与 WorkBuddy channel-contract success 或 Codex verified success 等强度合并；
- OpenClaw production adapter 总是把 native result 包进外层 `{error,result,durationMs}` envelope；因此 object/array success 本质上不是“宿主证明完成”，甚至 missing/null native result 也会因外层 object envelope 被推断为 success；当前 writer 的 stable preview serializer 还会把该 fallback envelope 中 undefined 的 `error`/`result` 字段序列化为字符串 `"undefined"`，进一步证明 preview 不是可信完成证据；
- 当前没有证据证明 WorkBuddy/OpenClaw 拥有 Codex transcript verified upgrade 的同等生产链路；
- outcome-provenance 测试中的 OpenClaw-style normalized events 明确不携带 `toolCallId`/`turnId`，因为真实 adapter 当前在 writer boundary 前丢弃它们。

---

## 9. Host effect 验证等级

必须区分四层：

1. `ruleDecision`：RuleCode merged live decision；
2. `gateDecision` / shared `HostEventResult.decision`；
3. adapter-native output；
4. `hostEffect` evidence level。

| 场景 | OpenClaw | Codex | WorkBuddy |
|---|---|---|---|
| live `block` | adapter 返回 `{block:true,blockReason}`；真实宿主执行 unverified | exact PreToolUse `permissionDecision:'deny'`；证据等级 `contract-only`（permission-decision-encoded） | exact whitelisted deny stdout；probe-verified deny channel |
| `requireApproval` | 记录 telemetry，native continuation `undefined`；无 pause/block | metadata 不影响输出；neutral PreToolUse JSON | metadata 不影响输出；`null` = empty stdout |
| invalid RuleCode output normalized to `requireApproval` | contract-only decision encoding（contract 上 fail-closed），但宿主操作仍非阻断 | 同左 | 同左 |
| shadow block | 不 enforcement | 不 enforcement | 不 enforcement |
| auto_correct | OpenClaw 可有 params mutation path；非本矩阵重点 | encoder rejects modifiedInput | encoder rejects modifiedInput |

验证等级定义：

- `probe-verified`：真实宿主 probe 证明过该通道效果；当前仅 WorkBuddy deny/empty-neutral evidence 达到该级别；
- `contract-only`：生产代码返回/记录符合 adapter contract，但宿主真实效果未验证；当前 OpenClaw block/auto-correct 部分路径属于此级。Codex 的 `permission-decision-encoded` 是 `contract-only` 的更精确子类型：证明 PD 正确编码了宿主 permission decision，但未证明真实宿主已执行暂停；
- `unverifiable`：当前没有足够证据判断宿主真实执行效果。

**结论：`requireApproval` 在任何宿主都不能被报告为“工具已被暂停”。**

---

## 10. 缺陷与限制登记

本工单只登记，不修复。

| ID | 缺陷/限制 | 影响 |
|---|---|---|
| D1309-01 | OpenClaw adapter 未把 native `toolCallId` 传入 shared `HostEventContext` | `tool_use_id=NULL`，host-authoritative dedupe/verified join 不可用 |
| D1309-02 | shared HostEventContext 无 `runId` 字段；OpenClaw `runId` 未进入 trajectory lane | run/session 相关性不能作为 trajectory identity 证据 |
| D1309-03 | OpenClaw content/enrichment identity 与 physical-call identity 混淆 | repeated-call count UNKNOWN/INCONCLUSIVE |
| D1309-04 | OpenClaw facts 不因 truncated/execute/other conservative degradation | pseudo-`no` 与伪精确 counts |
| D1309-05 | Codex provider 读侧未传 `hostKind` | foreign/unattributed rows 可进入 Codex history/facts |
| D1309-06 | WorkBuddy `call_id` 与 `tool_use_id` 冲突时当前 `call_id` 静默胜出 | identity conflict 不可见 |
| D1309-07 | `normalizedPath` 单字符串承载 mechanical target，不代表 resource identity | coverage/evaluation 易混淆机械进入与语义归因 |
| D1309-08 | shell mutation regex 只捕 first token；`cp/mv` 还可能捕错资源 | attribution-unprovable/mis-attribution |
| D1309-09 | multi-file patch/multi-target shell 无逐资源表示 | multi-target invisible 或 collapsed |
| D1309-10 | OpenClaw early-skip fallback 可持久化 ordinary-looking `rulehost_evaluated allow` | coverage denominator 被污染 |
| D1309-11 | `requireApproval` aggregate 在 OpenClaw enforced telemetry 中可能缺 winner attribution | 审批遥测不能可靠回溯到唯一 rule/principle |
| D1309-12 | outcome evidence strength 宿主不均；OpenClaw envelope-shape-inferred success 很弱，missing native result 也可 success | 跨宿主统计不能直接合并，shape-inferred success 不能支持肯定行为结论 |
| D1309-13 | verified outcome upgrade 当前只证实 Codex transcript ingestion | 不得推广到 WorkBuddy/OpenClaw |
| D1309-14 | 无 occurrence time/causal identity；rowid/created_at 只是 insertion/write evidence | repeated-failure YES 仍非法 |
| D1309-15 | OpenClaw/Codex host execution effect 缺 WorkBuddy 同级真实 probe | hostEffect 只能按各自证据等级报告 |
| D1309-16 | 三宿主当前均未实现 `sameActionBlockCount`，生产 facts 恒为 `null` | repeated/block-pattern 判断不能把它当 negative evidence |
| D1309-17 | OpenClaw RuleContext reader 只按 `session_id` 取最近 rows；无 `hostKind`/project/time cutoff/current-id exclusion | OpenClaw history window 可能比 Codex/WorkBuddy 更不安全，项目/宿主/时点归因不可证明 |

### 10.1 本工单未覆盖或只部分覆盖的边界

1. OpenClaw early-skip fallback telemetry 只证明到 EventLog persistence invocation 层；未重新证明物理 JSONL flush。
2. 未进行新的真实宿主安装/运行 probe；WorkBuddy deny 的 probe-verified 结论来自既有冻结证据，Codex/OpenClaw 不能继承该等级。
3. OpenClaw native `toolCallId` 的长期稳定性、跨 restart 唯一性和宿主 redelivery 语义未被完全证明；本工单只证明当前 adapter 不传递它。
4. 高并发写、跨 session id collision、跨 workspace project collision 的 dedupe/attribution 压力测试未完整覆盖。
5. `apply_patch` 的真实逐文件 mutation surface 未归因；design-gate patch target extraction 不提升普通 RuleHost action 的证据等级。
6. 本工单没有证明 SQLite row 的物理发生次数、发生时间或因果顺序；这些仍是 PRI-1310+ 的显式未知。
7. Outcome matrix 的 OpenClaw cases 使用 faithful adapter-shaped normalized envelope 驱动 shared writer boundary；identity/drop 事实由真实 OpenClaw adapter tests 证明，但每个 outcome shape 没有逐一走完整 registered plugin route。

---

## 11. Characterization test → source evidence 映射

### 11.1 OpenClaw identity / dedupe / facts

| Test | 生产源码证据 |
|---|---|
| `openclaw-host-runtime-identity.test.ts` — `A: direct normalized-event capture…` | `openclaw-host-runtime.ts` context construction/dispatch；core `HostEventContext` contract；`production-pain-evidence.ts` writer |
| 同文件 — `B: distinct native toolCallIds yield two rows…` | `production-pain-evidence.ts` content-shape dedupe/canonical event id；`pain.ts` pain enrichment provider |
| 同文件 — `B-control: without a native toolCallId an exact repeat collapses…` | `production-pain-evidence.ts` content-shape fallback |
| 同文件 — `C: same native toolCallId folds identical content but changed content splits…` | `production-pain-evidence.ts` canonical hash/result_preview/dedupe |
| `phase-a-default-production-path.test.ts` — registered-route durable-output inference | registered plugin route → shared writer |
| `pain-receipt-fallback.test.ts` — ctx-only native toolCallId receipt-lane distinction | `pain-receipt-fallback.ts` native id fallback；`openclaw-run-turn-correlation.ts` |
| `rule-context-assembler.test.ts` — complete/no-read case | `rule-context-assembler.ts` + `computeBehaviorFacts` |
| 同文件 — truncated/no-visible-read pseudo-no case | `rule-context-assembler.ts` lack of truncated degradation |
| 同文件 — execute-present pseudo-no case | `rule-context-assembler.ts` lack of execute degradation |
| 同文件 — other-present pseudo-no case | `rule-context-assembler.ts` lack of other degradation |
| 同文件 — real target read positive control | `computeBehaviorFacts` exact normalized-path matching |
| 同文件 — session-only reader foreign-host/other-project row can determine target facts | `trajectory.ts getRuleHostContextRows` 只按 `session_id` SELECT/ORDER/LIMIT；无 host/project/time/current-id predicate |

### 11.2 Codex / WorkBuddy identity, attribution, facts

| Test | 生产源码证据 |
|---|---|
| `codex-rule-context-provider.test.ts` — foreign-host baseline-named rows visible | `codex-rule-context-provider.ts` hostKind omission；`workspace-behavior-evidence.ts` plain reader |
| 同文件 — unattributed legacy rows visible/countable | 同上 |
| 同文件 — independent current-id vs exact-cutoff exclusion | `workspace-behavior-evidence.ts` strict cutoff + id predicate |
| 同文件 — persisted outcome `unknown` invalidates window | `behavior-history.ts` outcome ABI validation（PRI-1308） |
| `codex-rule-context-live-history.test.ts` — text-only shell persists unknown and next window unavailable | Codex input decoder；shared writer `normalizeOutcome`；provider/assembler |
| `workbuddy-rule-context-provider.test.ts` — mixed proven+legacy unprovable | `workbuddy-rule-context-provider.ts` unattributed branch |
| 同文件 — empty current identity scope mismatch | `workbuddy-rule-context-provider.ts` current id validation |
| 同文件 — NULL project scope incomplete | `workspace-behavior-evidence.ts` unscoped row detector |
| 同文件 — exact project scope exclusion | `workspace-behavior-evidence.ts` project predicate |
| 同文件 — NULL stored tool_use_id enters later window | reader `(tool_use_id IS NULL OR tool_use_id <> ?)` |
| 同文件 — independent current-id vs exact-cutoff exclusion | 同 reader |
| 同文件 — execute full conservative facts posture | `workbuddy-rule-context-provider.ts` factsIncomplete |
| 同文件 — other full conservative facts posture | 同上 |
| 同文件 — truncation newest-100 + full unknown/null posture | reader truncation + provider degradation |
| `host-contract.test.ts` — fallback id/missing id/conflict/malformed id | `workbuddy-adapter/src/codec/input-decoder.ts` |
| `pd-hook-production.test.ts` — missing ids persist NULL/cannot scope; fallback id valid | WorkBuddy hook wiring + provider + writer |

### 11.3 Target attribution / gate entry

| Test | 生产源码证据 |
|---|---|
| `rule-host-input-builder.test.ts` — direct structured path positive/negative controls | `extractFilePathFromParams` direct fields |
| 同文件 — pathless write synthetic target | pathless write fallback |
| 同文件 — native/legacy apply_patch carriers synthetic | `canonicalKind` authority + no shell interpretation |
| 同文件 — multi-file patch collapse | 同上 |
| 同文件 — opaque `git status` | execute full-command fallback |
| 同文件 — no-target cases | extraction null/empty |
| 同文件 — `cp/mv/rm` first-token characterization | shell mutation regex |
| `codex-payload-action-parity.test.ts` — production/replay apply_patch parity | `buildRuleHostAction` + Codex semantics |
| `rulehost-target-attribution.test.ts` — 10-case production-boundary matrix | `production-rulehost-gate.ts` kind routing, action construction, normalizedPath skip；real RuleCode runtime |
| `gate-rule-host-pipeline.test.ts` — early-skip fallback telemetry 3 cases + positive control | OpenClaw adapter fallback persistence path |

### 11.4 Outcome provenance / host effect

| Test | 生产源码证据 |
|---|---|
| `three-host-outcome-provenance.test.ts` — Codex text-only unknown + verified primitive upgrade | Codex decoder；`normalizeOutcome`；`recordVerifiedToolOutcomes` |
| 同文件 — WorkBuddy string/is_error/exit/PostToolUseFailure cases | WorkBuddy decoder channel contract + shared writer |
| 同文件 — OpenClaw adapter-shaped error/exit/text/object/array/missing-result cases | `openclaw-host-runtime.ts` outer `{error,result,durationMs}` adapter envelope；shared writer `normalizeOutcome` shape precedence；fixture deliberately omits dropped ids |
| `gate-rule-host-pipeline.test.ts` — production requireApproval no pause | `production-rulehost-gate.ts` metadata/decision mapping；`openclaw-plugin/src/hooks/gate.ts` requireApproval branch |
| `codex-adapter/tests/host-adapter.test.ts` — permission-decision-encoded cases | `codex-adapter/src/codec/output-encoder.ts` |
| `workbuddy-adapter/tests/output-whitelist.test.ts` — probe-verified deny/empty neutral cases | `workbuddy-adapter/src/codec/output-encoder.ts` + frozen probe contract |

---

## 12. 对 PRI-1310 / PRI-1311 / PRI-1312 的输入约束

### PRI-1310

1. 不得把 `normalizedPath` 当 resource identity；Golden Trace/fixture 必须显式区分六类 attribution。
2. 不得把 insertion order、rowid 或 `created_at` 当 causal order；继续使用 PRI-1308 的 UNKNOWN/INCONCLUSIVE/neutral 规则。
3. evidence-fidelity 模式下 repeated-failure 不得输出 YES；rule-logic-isolated 必须列明 assumptionGrants。
4. OpenClaw dedupe/identity 不足以证明重复物理调用；fixture 不能把 row count 当 truth。
5. OpenClaw truncated/execute/other pseudo-no 不得作为完整窗口 NO evidence。
6. `sameActionBlockCount=null` 不得被解释为无 same-action block；三宿主当前都没有该计数的生产证据。

### PRI-1311

1. 修复 OpenClaw identity 前必须先确认 native `toolCallId` 的稳定性和 redelivery 语义；不得把 `runId` 当 turn id。
2. 若设计 shared `runId`，它是独立 lineage 字段，不是 `toolCallId` 替代品。
3. dedupe 修复必须区分 host-authoritative identity、enrichment identity、content idempotency。
4. facts degradation 修复要跨宿主一致决定是否将 `agent` 也视为 incomplete；不得只做 OpenClaw 局部隐性行为变化。
5. Codex hostKind read-side filtering 是独立行为变化，需考虑 legacy/unattributed rows 的 fail-closed 语义。

### PRI-1312

1. host effect 不得统一报告为“已暂停/已阻断”；必须携带 `probe-verified` / `contract-only` / `unverifiable` 等级；Codex 可在 `contract-only` 内进一步注明 permission-decision-encoded。
2. WorkBuddy probe evidence 不能外推给 Codex/OpenClaw。
3. outcome provenance 必须保留来源强度；不得只按 final enum 合并统计；OpenClaw envelope-shape-inferred success（包括 missing native result 也可 success）不得作为肯定完成证据。
4. coverage metrics 必须排除或单独分类 early-skip fallback telemetry、non-evaluable kinds、no-target、synthetic、opaque、attribution-unprovable 和 multi-target。
5. 任何 target-attribution 修复都必须先解决 multi-target 表示；不得用 first-file 或 first-token 假装完整归因。

---

## 13. 当前验证记录

本节记录本工单最终实际执行结果。原则是：未运行就写未运行；失败就写失败；不得把无关失败或环境失败写成 PASS。

### 13.1 子代理 targeted slice 记录

- OpenClaw slice（Agent A）：4 files / 69 tests PASS（identity 4、assembler 27、phase-a 7、pain receipt fallback 31），27.01s。
- Target attribution / host effect slice（Agent C）：
  - core target/parity：2 files / 107 tests PASS；
  - host-runtime target matrix：1 file / 10 tests PASS；
  - OpenClaw gate pipeline：1 file / 13 tests PASS；
  - Codex host adapter：1 file / 15 tests PASS；
  - WorkBuddy output whitelist：1 file / 14 tests PASS。
- Codex/WorkBuddy slice（Agent B）：
  - Codex provider/live-history：2 files / 13 tests PASS；
  - WorkBuddy provider：18/18 PASS；
  - outcome provenance + host-contract combined targeted run：outcome matrix 11/11 PASS（此为后续 adapter-shaped envelope refinement 前的历史 slice 结果；最终 12-case 结果见 §13.2）；
  - WorkBuddy identity focused tests：4 passed / 37 skipped（focused run）；
  - WorkBuddy production missing-id test：1 passed / 18 skipped，约 115.72s。
- 主代理独立复跑：host-runtime target matrix + outcome provenance 2 files / 21 tests PASS（该复跑发生在 adapter-shaped envelope refinement 前；最终 12-case 修正后结果见 §13.2）。

### 13.2 最终 targeted / build / full-suite 记录

#### Final targeted tests

- OpenClaw targeted command（5 files）：`tests/host-runtime/openclaw-host-runtime-identity.test.ts`、`tests/core/rule-context-assembler.test.ts`、`tests/hooks/phase-a-default-production-path.test.ts`、`tests/hooks/pain-receipt-fallback.test.ts`、`tests/hooks/gate-rule-host-pipeline.test.ts` → **5 files / 82 tests PASS**，35.65s（当时 assembler 为 27 tests）；后续新增 session-only reader characterization 后，`tests/core/rule-context-assembler.test.ts` 单独最终复跑 → **28/28 PASS**，19.65s。
- Core targeted command（2 files）：`rule-host-input-builder.test.ts`、`codex-payload-action-parity.test.ts` → **2 files / 107 tests PASS**，2.38s。
- Host-runtime target matrix slice：`tests/semantics/rulehost-target-attribution.test.ts` 在 targeted combined run 中 **10/10 PASS**；同一 run 还包含当时 11-case outcome matrix 与 WorkBuddy provider。
- Host-runtime final post-refinement slice：`tests/three-host-outcome-provenance.test.ts` + `tests/workbuddy-rule-context-provider.test.ts` → **2 files / 30 tests PASS**，48.91s；其中 outcome matrix 为最终 **12/12 PASS**，WorkBuddy provider 为 **18/18 PASS**。
- Codex targeted command（3 files）：`codex-rule-context-provider.test.ts`、`codex-rule-context-live-history.test.ts`、`host-adapter.test.ts` → **3 files / 28 tests PASS**，33.90s。
- WorkBuddy targeted commands：
  - `tests/output-whitelist.test.ts` → **14/14 PASS**；
  - `tests/host-contract.test.ts -t 'tool_use_id is the fallback|both ids are present|malformed fallback'` → **4 passed / 37 skipped**，1.11s；skip 是 Vitest focused-filter 结果，不是缺失覆盖；
  - `tests/pd-hook-production.test.ts -t 'missing ids persist NULL'` → **1 passed / 18 skipped**，133.48s；skip 同样是 focused-filter 结果。

#### Workspace build

`npm run build`（root build，覆盖 `@principles/core`、`@principles/host-runtime`、`@principles/codex-adapter`、`@principles/workbuddy-adapter`、`principles-disciple` 及其余 workspace）在最终 test/docs 状态下重新执行 → **PASS / exit 0**；dist hygiene checks 均通过，无 compiled test artifacts。

#### Full-suite methodology note

第一次把五个受影响 workspace full suites 并行启动，造成大量 subprocess timeout、dist/build contention 与性能测试噪声；该并行运行**不作为有效验收结果**。随后改为每次只运行一个 workspace 的 sequential full-suite。sequential 结果、失败隔离与环境归因如下。

#### Sequential full-suite results and isolation

以下结果全部来自 sequential full-suite（每次只运行一个 workspace）。这些 full suites **不是 green**，本节不把它们描述成 PASS；关键是：本 diff 的 PRI-1309 目标测试在 full suite 内全部通过，剩余失败集中在未修改的 legacy/e2e/perf/platform-sensitive 文件，并且 production diff 为零。

| workspace | sequential full-suite 结果 | PRI-1309 目标证据在 full suite 内 | 失败文件低并发独立重跑 | 归因 |
|---|---|---|---|---|
| `@principles/core` | **FAIL**：564 files / 10230 tests；22 files failed、535 passed、7 skipped；38 failed、10186 passed、3 skipped、3 todo；303.29s | `codex-payload-action-parity` **11/11 PASS**；`rule-host-input-builder` 在 full 中 95/96（1 个既有 Golden Trace import timeout），低并发重跑 **96/96 PASS** | 22 个失败文件以 `--maxWorkers=3` 重跑：**18 files passed / 4 failed，745 passed / 4 failed**，113.90s。剩余 4 个失败为：barrel dynamic import timeout ×2、pi-ai transport import/test timeout ×1、`pd-credentials` POSIX mode 0777 vs 0600 ×1 | 大多数 full-run 失败是 worker/import 资源争用；剩余失败是 `/mnt/d` POSIX permission 语义与 WSL import/timeout 环境敏感。失败文件均未由本 diff 修改，且无 production source diff。 |
| `@principles/host-runtime` | **FAIL**：102 files / 1216 tests；5 files failed、97 passed；9 failed、1206 passed、1 skipped；1873.99s | `workbuddy-rule-context-provider` **18/18 PASS**；`three-host-outcome-provenance` **12/12 PASS**；`semantics/rulehost-target-attribution` **10/10 PASS** | 5 个失败文件以 `--maxWorkers=2` 重跑：**5 files failed，10 failed / 75 passed / 1 skipped**，191.28s。失败仍是 `intervention-evidence-ingress`、`product-telemetry-control-state-concurrency`、`product-telemetry-units`、`prompt-budget-model-aware`、`prompt-injection-projection-perf` | 这些文件未修改，且在 PRI-1308 的 host-runtime full/isolated run 中已经以同类方式失败；`product-telemetry-units` 与 core permission failure 都体现 `/mnt/d` 不支持预期 0600 POSIX mode。不是本 diff 引入，也不是全量并发噪声。 |
| `@principles/codex-adapter` | **FAIL**：38 files / 524 tests；12 files failed、26 passed；65 failed、452 passed、7 skipped；832.91s | `host-adapter` **15/15 PASS**；`codex-rule-context-provider` **11/11 PASS**；`codex-rule-context-live-history` **2/2 PASS** | 12 个失败文件以 `--maxWorkers=3` 重跑：**2 files passed / 10 failed，188 passed / 64 failed / 7 skipped**，985.67s；`pd-hook-adaptive` 与 `pd-hook` 转为 PASS。逐条失败账本是 67 entries：64 个 failed tests + 3 个 hook/suite-level entries。64 个 failed tests 中，46 个是 harness 已明确标注为 environmental 的 subprocess SIGTERM，14 个是 test timeout，1 个是既有 ingestion fixture helper 在非 ASCII worktree path 下使用 percent-encoded `.pathname` 导致 ENOENT，3 个其他失败分别是 `codex-plugin-bundle` 的 `expected null to be +0` subprocess-status assertion 与 2 个 `pd-hook-entry-belt` stderr/EPIPE cases；3 个 hook/suite-level entries 是 2 个 hook timeout + 1 个 `spawnSync /usr/bin/node ETIMEDOUT` | 大部分失败是真实 subprocess harness 在 `/mnt/d`+WSL 下的 spawn/timing 环境失败；ingestion ENOENT 是既有测试 helper 的非 ASCII path portability 缺陷。失败文件均未修改，production diff 为零，因此不是本 diff 引入。 |
| `@principles/workbuddy-adapter` | **FAIL**：24 files / 354 tests；12 files failed、12 passed；125 failed、229 passed；412.93s | `output-whitelist` **14/14 PASS**；新增/修改的 host-contract identity tests **4/4 PASS**；`pd-hook-production` 的 missing-id characterization **PASS**（full 中 60.323s） | 12 个失败文件以 `--maxWorkers=3` 重跑：**12 files failed，123 failed / 51 passed**，669.12s。目标测试仍 PASS。主导失败类型为 65 个 `pd-hook entry spawn failed: spawnSync /usr/bin/node ETIMEDOUT`；`host-contract` 20 个失败是冻结真实 Windows-cwd fixtures 在 POSIX 下不是 absolute path；`model-context-propagation` 同样卡在 cwd shape；`workspace-resolution` 的 unreadable-config case 在 `/mnt/d` permission 语义下仍可读 | 主要为 subprocess timing、POSIX/Windows path 与 permission portability 环境失败。`host-contract`/`pd-hook-production` 的本 diff 只增加或修正 identity characterization，失败主体是未修改 legacy cases；production diff 为零。 |
| `principles-disciple` / OpenClaw | **FAIL**：219 files / 2504 tests；12 files failed、207 passed、9 skipped；22 failed、2473 passed、9 skipped；272.53s | `openclaw-host-runtime-identity` **4/4 PASS**；`rule-context-assembler` **28/28 PASS**；`phase-a-default-production-path` **7/7 PASS**；`pain-receipt-fallback` **31/31 PASS**；`gate-rule-host-pipeline` **13/13 PASS** | 12 个失败文件以 `--maxWorkers=3` 重跑：**9 files passed / 3 failed，89 passed / 2 failed**，108.32s；另有 published-bundle afterAll hook timeout。剩余为 `prompt-intent-injection` beforeEach hook timeout、`mcp-launcher-workspace-isolation` real launcher 30s timeout、published bundle cleanup hook timeout | 大多数 full-run 失败是 import/spawn 资源争用，低并发后消失；剩余是真实 launcher/cleanup/perf timeout。失败文件未修改，production diff 为零。 |

结论：full-suite 状态必须报告为 **FAIL with pre-existing/environmental unrelated failures**，不能报告为 PASS。相反，所有 PRI-1309 新增或修改的 characterization 目标测试均在 targeted evidence、全量套件或低并发隔离重跑中获得正向证据；没有任何失败指向本次 test-only diff。
