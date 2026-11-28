# PRI-1308 — BehaviorHistory Outcome & Ordering Characterization

> 状态：characterization 记录，不是生产修复方案。  
> 审查基线：`df00d15549b8994550bbf0699f43f8cf222e41fe`（`origin/main`，含 PRI-1307 契约冻结 PR #2820）  
> 权威契约：`docs/reviews/PD-CAE-STAGE1A-REPLAY-CONTRACT.md`  
> 实施边界：仅新增/修改测试与本文档；未修改生产源码、生产 schema、生产 DB、宿主 adapter、RuleContextV2、RuleCode、RuleHost 或 Service Host。

---

## 1. 结论摘要

1. **生产 live evidence writer 可以合法写入 `unknown`，但 `unknown` 不是合法 `RuleToolOutcome`。** shared live `normalizeOutcome` 侧 outcome 是 `success | failure | unknown`；RuleContextV2/BehaviorHistory 侧是 `success | failure | blocked`。完整分层词汇见 §3.1；SQLite 存储层本身没有 outcome CHECK constraint。
2. **任意一行 `unknown` 进入 `assembleBehaviorHistory` 都会使整个 history window `unavailable`。** 不保留前序有效行，不跳过问题行，也不产生部分窗口。
3. **`unknown` 可以通过 Codex transcript verified outcome 路径升级为 `success` 或 `failure`，但该能力当前只被 Codex 生产 ingestion 调用。** 不得推广为 WorkBuddy/OpenClaw 已具备同能力。
4. **verified UPDATE 是原地改写。** 它只更新 `outcome` / `exit_code` / `result_preview`；`id`、`created_at`、`project_dir`、`params_json`、`tool_use_id`、`host_kind` 等保持不变。
5. **verified INSERT 是晚到的补记行。** 它产生新 rowid，`created_at` 是 verified ingestion/write batch 时间；当前 INSERT 列清单不含 `project_dir`，因此在 canonical schema 中该列为 `NULL`。
6. **`sequenceId` 就是 `tool_calls.id`（SQLite insertion row identity）。** 它不是 agent 行为序号、真实发生时间或因果顺序。
7. **`created_at` 是行写入/补记时间，不是 action occurredAt。** 当前 `tool_calls → BehaviorHistory → RuleContextV2` 链路没有 occurrence time。
8. **RuleContext reader 使用 `ORDER BY created_at DESC, id DESC` 后 reverse。** 这是数据库可见顺序，不是因果顺序；BehaviorExamplePack 读取路径另按 `id DESC` 后 reverse，二者不是同一 ordering contract。
9. **verified INSERT 的 `project_dir=NULL` 会触发 `unscopedPriorRows`，Codex provider 因此返回 `trajectory_project_scope_incomplete`。** 这不是“可见但顺序反转”，而是项目范围完整性失败导致整窗不可用。
10. **verified UPDATE 会造成 hindsight leakage 风险。** 因为 outcome 被原地覆盖而 `created_at` 不变，使用同一决策 cutoff 在升级后读取，会看到决策时实际尚不可知的 final outcome。
11. **仅凭 rowid 或 `created_at` 不能证明 repeated failure。** 当前 BehaviorHistory/facts 不产生 causal-order 或 repeated-failure 结论；缺少可信因果证据时，离线评估必须保持 UNKNOWN / INCONCLUSIVE / neutral。
12. 审计额外确认两个生产实现缺陷：**verified writer 的 legacy `project_dir` migration gap**，以及 **transaction rollback 后 JS 返回状态可能不真实的 accounting defect**。本工单只登记并用测试冻结，不修复。

---

## 2. 证据范围与方法

本记录综合三类证据：

1. 生产源码：`behavior-history.ts`、`production-pain-evidence.ts`、`workspace-behavior-evidence.ts`、`rule-context-v2.ts`、`codex-adapter/src/ingestion/ingestion.ts`；
2. 本工单新增/扩展的 characterization tests；
3. 既有测试：live outcome 三值分类、host attribution、schema migration、provider degradation、Codex verified ingestion orchestration。

测试均调用真实生产入口或生产纯函数：

- `assembleBehaviorHistory`
- `computeBehaviorFacts`
- `validateRuleContextV2`
- `createProductionHostRuntime().dispatch`
- `recordVerifiedToolOutcomes`
- `readWorkspaceRuleContextRowsBefore`
- `createCodexRuleContextProvider`
- `createWorkspaceBehaviorEvidencePort`

测试中的手工 SQL 只用于构造输入状态与显式 fault injection（例如 legacy row、排序 fixture、手动 seeded `blocked`、强制 abort 的 trigger），不复制被测生产逻辑。

---

## 3. BehaviorHistory outcome characterization

### 3.1 outcome 词汇必须按层区分

这不是一个干净的“两套枚举”问题。当前真实分层如下：

| 层 | 当前类型/约束 | 当前已观察写入事实 | 证据 |
|---|---|---|---|
| shared live `normalizeOutcome` / production evidence writer | `success \| failure \| unknown` | live hook row 可写入三者之一 | `production-pain-evidence.ts` 的 `ToolOutcomeClassification` 与 `normalizeOutcome` |
| legacy `TrajectoryToolCallInput` 类型 | `success \| failure \| blocked` | 本工单审计的当前调用点只观察到 success/failure；未发现生产 writer 经该类型写入 blocked | `trajectory-types.ts` |
| verified outcome writer | 无独立 outcome 枚举；整数 `exitCode` 映射为 `success` 或 `failure` | verified UPDATE/INSERT 只写 success/failure | `recordVerifiedToolOutcomes` |
| raw SQLite `tool_calls.outcome` 存储 | `TEXT NOT NULL`，无 CHECK constraint | 技术上可保存任意非空字符串；assembler 再把非法值作为 row fault | `trajectory-schema.ts` |
| RuleContextV2 / BehaviorHistory ABI | `success \| failure \| blocked` | exact `unknown` 或其他非法字符串会使整窗 unavailable | `rule-context-v2.ts`；`behavior-history.ts` |

`normalizeOutcome` 只根据结构化事实分类：错误字段、整数 exit code、结构化 object/array result。纯文本 tool response 不会被关键词猜成 success/failure，而是写入 `unknown`。生产注释明确说明 Codex shell PostToolUse 的 live response 可以是纯字符串，exit code 只在 transcript `CommandExecution` 中发布，因此 live row 可合法先为 `unknown`。

### 3.2 `success` / `failure` / `blocked` 可进入 available history

新增测试：`packages/host-runtime/tests/behavior-history.test.ts` 中 `accepts the current RuleToolOutcome contract value %s`。

- 三个 ABI 值分别作为单行输入调用真实 `assembleBehaviorHistory`；
- 结果均为 `status='available'`；
- `blocked` 只被冻结为当前类型/装配契约可接受值。

重要边界：**未发现任何当前生产 writer 会写入 `tool_calls.outcome='blocked'`。** OpenClaw 的真实阻断记录进入 `gate_blocks`；shared live writer 只产生 success/failure/unknown；verified writer 只产生 success/failure。手动 seeded `blocked` 测试不能解释为宿主已经产生 blocked outcome。

### 3.3 exact `unknown` 使整窗 unavailable

新增测试：`behavior-history.test.ts` 中 `makes the whole window unavailable when an exact production-writer unknown outcome is %s`。

覆盖位置：

- unknown 在窗口开头；
- unknown 在窗口中间；
- unknown 在窗口末尾。

每个 case 均包含合法 success/failure 邻行。实际行为：

- `status='unavailable'`；
- `calls=[]`；
- `truncated=false`；
- `unavailableReason='row id=<id>: outcome "unknown" is not a valid RuleToolOutcome'`；
- 不保留 unknown 之前的部分记录；
- 不跳过 unknown 后继续计算。

这与 `assembleBehaviorHistory` 的逐行 immediate return 实现一致。额外表征：即使调用方传入 `truncated=true`，invalid-row unavailable 结果也硬编码返回 `truncated=false`；也就是说当前 ABI 不保留“输入窗口本已截断”的元数据。新增测试 `drops truncation metadata when an invalid outcome makes the window unavailable` 冻结这一事实。本工单不判断这是否是理想设计，只登记为 evidence-quality 限制。

### 3.4 unavailable 不会变成否定证据

新增测试：`behavior-history.test.ts` 中 `keeps unavailable facts unknown/null instead of converting missing history to negative evidence`。

当同一 unknown-poisoned window 输入真实 `computeBehaviorFacts`：

- `priorReadOfTarget='unknown'`；
- `readCount=null`；
- `writeCount=null`；
- `uniqueWritePathCount=null`；
- `sameActionBlockCount=null`。

同一 context 通过真实 `validateRuleContextV2` 校验。这验证的是生产不变量：**history unavailable 不得被解释为 `priorReadOfTarget='no'` 或 0 计数。**

---

## 4. Verified outcome 的真实证据来源

### 4.1 Codex-only 生产调用点

当前唯一生产调用链：

1. Codex transcript decoder 从 `event_msg item_completed CommandExecution` 读取：
   - `item.id` → `toolUseId`；
   - `item.exit_code` → `exitCode`；
   - `item.command` → params 来源；
   - stdout/stderr → outputPreview 来源。
2. `collectVerifiedToolOutcomes` 只接受带 `toolUseId` 且 `exitCode` 为整数的 `tool_call` observation。
3. `codexVerifiedOutcomesPreIngest` 调用 `recordVerifiedToolOutcomes(..., hostKind:'codex')`。
4. 该调用发生在 transcript ingestion checkpoint 推进前；pre-ingest 失败会阻止 checkpoint advance。
5. transcript ingestion 受 host/ingestion flags 与 consent gate 限制。

这不是 WorkBuddy/OpenClaw 的通用能力。审计未发现 WorkBuddy/OpenClaw 生产代码调用 `recordVerifiedToolOutcomes`。

### 4.2 时间边界

verified outcome 的证据较强的是 **outcome/exit-code**，不是时间：

- transcript 的 `item_completed` 外层记录携带 `started_at_ms` / `completed_at_ms`；它们不是当前 decoder 投影到 `CommandExecution` item 内的字段；
- 但 `VerifiedToolOutcomeInput` 没有任何 occurredAt/timestamp 字段；
- 因此这些时间不会进入 `tool_calls`；
- verified `created_at` 是 PD 执行 backfill/write 的当前时间。

---

## 5. Verified upgrade 条件矩阵

| 情况 | 当前真实行为 | 测试证据 |
|---|---|---|
| 匹配 unknown row，`exitCode=0` | UPDATE 为 `success`，`exit_code=0` | `upgrades exitCode zero to success and preserves the live result_preview...` |
| 匹配 unknown row，`exitCode!=0` | UPDATE 为 `failure`，写入真实 exit code | 既有 `upgrades an unknown live row...` |
| 匹配 success row | `skipped_final` / `outcome_already_final`，不覆盖 | 既有 structured-live-fact 测试 |
| 匹配 failure row | `skipped_final` / `outcome_already_final`，不覆盖 | 新增 `never overwrites an already-final failure...` |
| 匹配 blocked row | 按当前实现也是 `skipped_final`，不覆盖 | 新增 `treats a pre-existing blocked row as final...` |
| 没有匹配 row | INSERT 新 verified row | 既有 insert 测试 + 新增 full-shape 测试 |
| live row 没有 `tool_use_id` | SQL 等值无法匹配 NULL；verified outcome 插入为独立行，原 unknown 不升级 | 新增 `cannot upgrade a live row that has no host tool-use identity...` |
| DB 不存在 | 每个 outcome 返回 `unavailable/trajectory_db_not_found` | 既有测试 |
| 同一 verified outcome 重复提交 | 第二次通常因 row 已 final 而 `skipped_final`，不 duplicate | 既有 idempotency 测试 |
| verified `exitCode` 非整数 | 生产代码直接跳过且不产生状态项 | 源码事实；Codex collector 也预先过滤 |

补充源码事实：skip 分支没有 outcome whitelist。任何非 `unknown` 字符串（包括非法 outcome）在当前实现下都会走 `skipped_final`；这不是对非法数据合法性的背书，而是当前实现细节。

Host scoping：

- 调用方传入 `hostKind` 时，lookup 要求 `session_id + tool_use_id + host_kind` 同时匹配；
- foreign-host row 与 host_kind NULL 的 legacy row 不会被该 host claim；
- 不传 `hostKind` 是历史 match-any 兼容路径，不代表推荐语义。

---

## 6. UPDATE 与 INSERT 的真实差异

### 6.1 verified UPDATE

生产 SQL：

```sql
UPDATE tool_calls
SET outcome = ?, exit_code = ?, result_preview = COALESCE(?, result_preview)
WHERE id = ? AND outcome = 'unknown'
```

新增测试：`preserves row identity and write time during an unknown-to-known UPDATE`。

已冻结不变量：

- `id` 不变；
- `created_at` 不变；
- `session_id` 不变；
- `tool_name` 不变；
- `duration_ms` 不变；
- `error_type` / `error_message` 不变；
- `params_json` 不变；
- `tool_use_id` 不变；
- `project_dir` 不变；
- `host_kind` 不变；
- 不产生 `occurredAt` / `occurred_at`。

`result_preview` 的当前语义：

- verified `outputPreview` 为非空字符串时，最多按 500 UTF-16 code units 截断并覆盖原值；
- 未提供或为空时，`COALESCE` 保留原 live preview；
- verified preview 本身不经过与 live params/result 相同的 sanitizer，只受长度限制（源码事实，见 §11 缺陷/风险登记）。

关键结论：**结果确认时间不是原始工具调用发生时间；UPDATE 也没有记录确认时间。** 当前行只留下原始 live-write `created_at` 和最终 outcome。

### 6.2 verified INSERT

生产 INSERT 列清单：

```text
session_id, tool_name, outcome, duration_ms, exit_code,
error_type, error_message, params_json, result_preview,
created_at, tool_use_id, host_kind
```

新增测试：`writes the current verified INSERT shape as a late backfill row without project_dir`。

已冻结字段形状：

- `id` 由 SQLite AUTOINCREMENT 新分配；
- `created_at` 是 verified writer batch 当前时间；
- `outcome` 只可能是 success/failure；
- `duration_ms=null`；
- `error_type=null`；
- `error_message=null`；
- `params_json` 是 `sanitizeToolParams` 后的 stable serialization；
- `result_preview` 是 bounded outputPreview 或 null；
- `tool_use_id` 写入；
- `host_kind` 按调用方写入（Codex 生产路径为 `codex`）；
- **`project_dir` 不在列清单中，因此 canonical schema 下保持 NULL**；
- 不产生 occurredAt。

同批 INSERT 共享同一个 `createdAt`。session upsert 只在 missing-row INSERT 路径执行；update-only 或 skip-only 不创建 session row。

### 6.3 transaction status accounting defect

新增测试：`characterizes the current transaction-status accounting defect when a later verified insert aborts the batch`。

测试构造两个 verified inserts：第一个可写，第二个由测试 trigger 强制 abort。实际结果：

- SQLite transaction 回滚，最终 `tool_calls` 行数为 0；
- 但第一个 JS-side 状态仍是 `{status:'inserted', id:<number>}`；
- 第二个状态为 `unavailable/trajectory_write_failed:*`。

因此当前返回值不能被解释为逐行 durable commit truth。若 commit failure 发生在所有 input 都已 push success 状态之后，生产代码甚至可能返回全 success-like 状态。由于 Codex pre-ingest 以“无 unavailable”作为成功并允许 checkpoint 前进，这是生产可靠性缺陷。本工单不修复。

---

## 7. rowid、`sequenceId` 与 `created_at`

### 7.1 `sequenceId`

`assembleBehaviorHistory` 直接执行：

```ts
sequenceId: row.id
```

新增测试：`copies database row identity into sequenceId without turning it into causal ordering evidence`。

结论：

- `sequenceId` 是数据库 rowid 的逐值复制；
- assembler 不重编号、不验证单调性、不补充时间或因果信息；
- 输入 row 顺序原样保留；
- `RuleToolCallRecord` 没有 occurredAt/orderingEvidence/causalOrder 字段。

### 7.2 `created_at`

已冻结事实：

- live INSERT：shared writer 在处理 after-tool event 时取 `new Date().toISOString()`；
- verified UPDATE：不改变 `created_at`；
- verified INSERT：backfill batch 开始时取一次当前时间并写入；
- schema 中 `created_at` 只是 `TEXT NOT NULL`，生产 reader 按文本比较；
- 正常生产 writers 使用 ISO UTC，但 schema 不强制历史/外部行格式。

因此 `created_at` 是 write/backfill time，不是真实 action occurrence time。

---

## 8. 历史读取器的真实排序与过滤

### 8.1 RuleContext reader SQL

`readWorkspaceRuleContextRowsBefore` 的主查询：

```sql
WHERE session_id = ?
  AND project_dir = ?
  AND created_at < ?
  AND (tool_use_id IS NULL OR tool_use_id <> ?)
ORDER BY created_at DESC, id DESC
LIMIT ?
```

实际语义：

- project scope 是 `project_dir` 精确相等；
- cutoff 是严格小于；
- 当前 toolUseId 被排除，`tool_use_id IS NULL` 的行不排除；
- 先取 `limit+1`，再 slice/reverse；
- 返回窗口是按 `created_at` 升序视角；同一 `created_at` 内因 reverse 表现为 `id` 升序；
- `truncated` 表示存在因窗口上限未返回的更老 visible rows；
- 不过滤 outcome，unknown/invalid outcome 都会进入 assembler。

新增测试：`orders the reader-level visible window by created_at with id as tie-breaker, while separately detecting unscoped null rows`。

测试构造 rowid 顺序与 `created_at` 顺序反向、相同 timestamp tie、exact-cutoff row、foreign project row、NULL project row。实际 reader-level 可见 id 顺序为 `[11,12,13,10]`，证明：

- `created_at` 优先于 rowid；
- tie 使用 id tie-breaker；
- exact cutoff row被排除；
- foreign project row被排除；
- NULL project row不进入 `rows`，但使 `unscopedPriorRows=true`。

该测试故意在同一 fixture 中包含 NULL-scope row，因此它表征的是 reader-level visibility/ordering；这些 rows 不会被真实 Codex provider 当作可用 history，因为 provider 会因 scope incomplete fail closed。provider-usable ordering 与 unscoped probe 不应混为一谈。

### 8.2 BehaviorExamplePack 是另一套 ordering

`workspace-behavior-evidence.ts` 的 behavior-example-pack 数据源使用：

```sql
WHERE session_id = ? AND id < ?
ORDER BY id DESC
```

再 reverse。它不按 `created_at`，也不按 project_dir/hostKind 过滤。

本工单将既有 evidence-port fixture 的 row 1/2 `created_at` 故意反转，同时保留期望 `sequenceId=[1,2]`，从而冻结：**example-pack 路径按 insertion rowid 排序**。该路径的 ordering 不得与 RuleContext provider 路径混用。

---

## 9. Backfill ordering / visibility negative controls

### 9.1 verified INSERT：顺序反转 + project scope 不可见

新增测试：`freezes late verified INSERT inversion and its project-scope invisibility`。

场景 oracle（仅测试真值，不写入生产证据）：

1. 工具调用 A 在真实世界先发生，但 live hook 未记录；
2. 工具调用 B 后发生并被 live writer 正常记录；
3. transcript verified ingestion 后来补记 A。

实际生产结果：

- B 先获得 rowid 和 live-write `created_at`；
- A 后获得更大 rowid 和 verified-write `created_at`；
- A 的 `project_dir=NULL`；
- 数据库可见顺序/写入顺序不是 oracle 中真实动作顺序；
- project-scoped reader 的 `rows` 只含 B，不含 A；
- `unscopedPriorRows=true`；
- 真实 Codex provider 返回 `trajectory_project_scope_incomplete`，facts 保持 `unknown/null`。

结论：**verified INSERT 当前不是“以错误顺序可见”，而是因缺少 project scope 使整窗 fail closed。** 这比单纯 ordering degradation 更严重。

### 9.2 legacy schema migration gap

新增测试：`freezes the legacy verified-writer project_dir migration gap that makes the scoped reader fail`。

对 pre-`project_dir` legacy `tool_calls`：

- verified writer 会补 `tool_use_id` 与 `host_kind`；
- 不补 `project_dir`；
- verified INSERT 仍可成功；
- scoped reader SQL 引用 `project_dir`，随后因 `no such column` 失败。

这与 R6 相关但性质不同：R6 是 canonical schema 中 INSERT 不写 project scope；该缺陷是 legacy schema 根本没有该列且 verified writer 不迁移。

### 9.3 verified UPDATE：as-of-decision hindsight leakage

新增测试：`freezes verified UPDATE in place and exposes later knowledge behind an earlier decision cutoff`。

该测试是 component-level assembly characterization：它调用真实 production reader 与 assembler，但二者之间的组合由测试完成；它没有声称覆盖完整 provider orchestration。provider-level scope-incomplete 行为由 §9.1 的真实 `createCodexRuleContextProvider` 测试单独冻结。

时间线：

1. `t1` live row A 写入 `unknown`；
2. `t2` live row B 写入 success；
3. `t cutoff` 位于 t2 之后、verified upgrade 之前；
4. `t3` verified UPDATE 将 A 原地升级为 failure。

升级前读取 cutoff 窗口：`unknown` 使 BehaviorHistory unavailable。  
升级后用**同一个 cutoff**再读：

- rowid 集合不变；
- A 的 `created_at` 仍是 t1；
- A 的 outcome 已是 failure；
- assembled history 变为 available；
- cutoff 虽然早于 t3 verification write，仍看到 post-upgrade failure。

结论：当前数据库最终状态不能单独还原“决策时 outcome 是 unknown”。离线 replay 必须使用 PRI-1307 契约的 `currentInvocation` / `cutoffAt` / `preUpdateOutcome` / as-of-decision projection；不得把最终 DB 状态当作决策时点事实。

### 9.4 repeated-failure 负控

新增测试：`does not manufacture causal-order or repeated-failure facts from row id and created_at`。

构造两个 failure rows，且 rowid 与 `created_at` 可见顺序反向。实际输出：

- reader 只给出数据库可见顺序；
- assembler 只复制 rowid 到 `sequenceId`；
- record keys 不含 `occurredAt`、`causalOrder`、`orderingEvidence`；
- `computeBehaviorFacts` 对正序/反序输入产生相同 facts；
- facts 中没有 repeated-failure 结论字段。

这不是说 repeated-failure 被证明为 NO；而是说**当前生产证据链根本不产生可合法支持 YES 的因果证据**。在 evidence-fidelity 模式下，任何仅依赖 rowid/created_at 的 repeated-failure YES 都是伪造证据；正确结果只能是 UNKNOWN / INCONCLUSIVE / neutral。若后续要测试规则逻辑本身，必须使用 PRI-1307 §5.5 的 `rule-logic-isolated` 模式，并显式标记 ordering assumption grant。

---

## 10. 对 PRI-1310 fixture pack 的硬性输入

1. fixture envelope 必须区分 writer outcome 与 RuleToolOutcome，不得把 `unknown` 静默转换或过滤。
2. `writerOperation='verified_insert'` 的生产真实行必须是 `project_dir=null`；手工给它补 project scope 的 fixture 不是 production-faithful。
3. verified UPDATE 场景必须由 fixture oracle 显式保存 pre-update outcome、decision cutoff、verification/backfill 相对时间；生产 DB 不会替 replay 保存。
4. 正常 live-only 场景最高也只是 `insertion-only` ordering evidence；backfill 场景为 conflicted/unprovable。
5. repeated-failure YES 在 evidence-fidelity 模式下不得出现；只能在 isolated rule-logic 模式中作为 assumption-driven rule test。
6. RuleContext reader 与 BehaviorExamplePack ordering contract 不同，fixture 不得混用。
7. Codex verified outcome 能力不得推广到 WorkBuddy/OpenClaw；三宿主证据能力必须分别建模。

---

## 11. 生产缺陷与风险登记

| # | 类型 | 问题与证据 | 影响 | 复现/表征测试 | 建议归属 |
|---|---|---|---|---|---|
| D1 | 已确认生产缺陷（R6） | verified INSERT 列清单不含 `project_dir`；`production-pain-evidence.ts` INSERT SQL 无该列 | backfill row 不进入 project-scoped rows，并触发 `trajectory_project_scope_incomplete`，整窗不可用 | `freezes late verified INSERT inversion...`；`writes the current verified INSERT shape...` | 新建 production hardening follow-up；PRI-1310 只消费 characterization，不修复 |
| D2 | 已确认生产缺陷 | verified writer 只确保 `tool_use_id`/`host_kind`，不确保 legacy `project_dir` 列 | pre-PRI-1015 DB 可写 verified rows，但 scoped reader 因缺列失败 | `freezes the legacy verified-writer project_dir migration gap...` | 与 D1 同一 production hardening follow-up 或单列 migration correctness ticket |
| D3 | 已确认生产缺陷 | transaction rollback 后 JS-side success statuses 不回滚；极端 commit failure 可返回全 success-like | Codex pre-ingest 可能误认为 verified writes durable，从而允许 checkpoint advance，造成 verified facts 丢失 | `characterizes the current transaction-status accounting defect...` | 新建 production reliability follow-up，优先级高；不属于 PRI-1308 修复范围 |
| D4 | 证据能力缺陷 | verified UPDATE 原地覆盖 outcome，无 pre-update outcome、verified_at 或 immutable audit lineage | 无法从最终 DB 还原 as-of-decision 状态；hindsight leakage | `freezes verified UPDATE in place...` | 后续 evidence-model 设计工单；PRI-1310 先用 fixture oracle 投影规避 |
| D5 | 证据能力缺陷 | `tool_calls` / RuleContext 链路没有 occurredAt；transcript 时间未传入 verified input | 因果顺序、真实发生时间、并发关系均不可证 | ordering negative controls | 后续 occurrence-time evidence contract；禁止在本阶段伪造字段 |
| D6 | host attribution 不对称 | Codex provider 不传 `hostKind`；WorkBuddy provider 严格分区 | 同 session/project foreign rows 可进入 Codex history；跨宿主归因边界不一致 | 既有 WorkBuddy attribution tests + 源码审计 | 后续 host-attribution hardening ticket；PRI-1310 必须按宿主分别建模 |
| D7 | 潜在隐私风险 | verified `outputPreview` 只长度截断，未经过 live result 的 sanitizer | transcript stdout/stderr 中的路径/敏感串可能进入 `result_preview` | 源码事实；未在本工单做安全回归测试 | 安全/隐私审查 follow-up |
| D8 | 已知边界 | OpenClaw toolCallId/runId 未透传，content-shape dedupe 可折叠真实重复 | 次数/重复/顺序命题不可证 | 既有 production-pain-evidence tests；契约 R5 | PRI-1309 |
| D9 | 契约事实，非缺陷 | `blocked` assembler 合法但当前无生产 writer；真实 gate block 存 `gate_blocks` | 不能把 blocked fixture 当作宿主真实观测 | `accepts the current RuleToolOutcome contract value blocked`；`treats a pre-existing blocked row...` | 文档事实；无需修复 |
| D10 | 未解决证据边界 | transcript toolName/callId 依赖 FIFO pairing；subagent root session lineage 未完全表征 | parallel/mixed/subagent 场景可能错配 tool metadata 或混入同 session | 静态审计；本工单未构造 fixture | PRI-1310 fixture pack 或后续 Codex ingestion characterization |
| D11 | 已确认可靠性风险 | `recordVerifiedToolOutcomes` 对非整数 `exitCode` 直接 `continue`，不返回 per-input unavailable/skipped 状态；Codex collector 也会预先过滤缺 identity/integer exit 的 observation | pre-ingest checkpoint gate 只看显式 unavailable；被静默丢弃的 verified outcome 不可能阻止 checkpoint advance，缺失不可观察 | `silently drops a non-integer verified exit code without any per-input status` | production reliability/observability follow-up；不属于 PRI-1308 修复范围 |

---

## 12. 测试清单与执行结果

### 12.1 本工单新增/扩展的 characterization tests

`packages/host-runtime/tests/behavior-history.test.ts`

- 三个合法 RuleToolOutcome 值可进入 available history；
- exact unknown 位于开头/中间/末尾均整窗 unavailable；
- invalid-row unavailable 丢弃输入 truncation metadata（硬编码 `truncated=false`）；
- sequenceId 是 rowid 复制且不含 occurredAt；
- unavailable facts 保持 unknown/null 并通过 validator。

`packages/host-runtime/tests/production-pain-evidence-outcome-contract.test.ts`

- failure final row 不被 verified success 覆盖；
- unknown→failure UPDATE 的 rowid/created_at/params/project/host 等字段不变；
- unknown→success UPDATE 且在无 verified preview 时保留原 preview；
- verified INSERT full shape，包括 batch created_at 与 `project_dir=null`；
- pre-existing blocked row 被当前实现视为 final；
- 无 tool_use_id 的 live row 不可升级，verified fact 独立插入；
- 非整数 verified exitCode 被静默丢弃且无 per-input status；
- transaction rollback 后 JS status accounting 缺陷表征。

`packages/host-runtime/tests/workspace-behavior-evidence.test.ts`

- RuleContext reader 的 created_at/id ordering、tie、cutoff、project scope、unscoped NULL probe；
- verified INSERT late-backfill inversion 与 Codex provider scope-incomplete；
- verified UPDATE in-place hindsight leakage；
- legacy verified writer project_dir migration gap；
- rowid/created_at 不产生 causal-order 或 repeated-failure facts；
- BehaviorExamplePack fixture 故意反转 id/created_at，冻结其 rowid ordering。

### 12.2 最终执行记录

> 以下为 PR 前最终实际执行结果；若后续修订测试，本节必须同步更新。

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm test --workspace=@principles/host-runtime -- tests/behavior-history.test.ts tests/production-pain-evidence-outcome-contract.test.ts tests/production-pain-evidence.test.ts tests/workspace-behavior-evidence.test.ts tests/trajectory-single-writer.test.ts` | PASS | 用户指定目标集合：5 files / 86 tests，86/86 passed，约 99.0s；无失败 |
| `npm test --workspace=@principles/host-runtime` | FAIL（8 个与本 diff 无关的失败） | 100 files / 1208 tests：95 files passed、5 files failed；1199 passed、8 failed、1 skipped；duration 1627.54s。失败文件：`intervention-evidence-ingress`（worker timeout）、`product-telemetry-control-state-concurrency`（4 个 lock/timing failures）、`product-telemetry-units`（`/mnt/d` 上 secret file mode 为 0777 而非 0600）、`prompt-budget-model-aware`（5s test timeout）、`prompt-injection-projection-perf`（5s test timeout）。这些文件未被本 diff 修改；本 diff 不含 production source 变更。五个失败文件随后被单独重跑，结果仍是同样 8 failures / 77 passed / 1 skipped（duration 342.64s），因此不是全量并发噪声造成，也不是本 characterization diff 引入。 |
| `npm run build --workspace=@principles/host-runtime` | PASS | 生产包 build 成功 |

中间开发执行记录：三个重点文件（behavior-history / outcome-contract / workspace-behavior-evidence）在执行过新增 failure-skip 前版本中为 3 files / 51 tests PASS。最终新增 transaction 与 legacy migration tests 后，本文件最终计数以最终执行为准。

测试数量口径：

- 新增 characterization tests：22 个（behavior-history +9；outcome-contract +8；workspace-behavior-evidence +5）。
- 修改/扩展的既有测试文件：3 个。
- 新增或修改 production source 文件：0 个。
- 目标集合中既有测试复用：64 个（86 个总数减 22 个新增）。

### 12.3 复用而非重复的既有覆盖

- live writer success/failure/unknown 三值分类：`production-pain-evidence-outcome-contract.test.ts` 既有 CR-01 tests；
- host attribution 与 foreign/legacy row 不 claim：`recovery-dedup-host-attribution.test.ts`、`pain-evidence-host-dedup.test.ts`；
- schema convergence/migration failure：`production-pain-evidence.test.ts`、`trajectory-single-writer.test.ts`；
- provider disabled/mismatch/truncated/execute/other degradation：`codex-rule-context-provider.test.ts`、`workbuddy-rule-context-provider.test.ts`；
- Codex transcript verified ingestion orchestration、checkpoint retry、consent/flag：`codex-adapter/tests/ingestion/verified-outcome-upgrade.test.ts` 及 ingestion tests。

### 12.4 独立 adversarial review 记录

Agent C 初判为 **NOT-READY**，主要 blocking findings 与处置：

1. **B1：最终执行记录仍是占位符。** 已在 §12.2 填入最终 target/full/build 实测结果；不得再用中间 51-test 结果作为最终证据。
2. **B2：outcome taxonomy 过度简化。** 已在 §3.1 改为五层矩阵：shared live normalizer、legacy trajectory input type、verified writer、raw SQLite TEXT、RuleContextV2/BehaviorHistory ABI。

Non-blocking findings 的处置：

- verified INSERT oracle 对比已改为 rowid 写入顺序 `[B,A]` 对测试 oracle `[A,B]` 的直接证据，不再使用基数不同导致的空泛 `not.toEqual`；
- reader-level ordering 与 provider-usable history 已在测试名、注释和 §8.1 明确区分；
- final-failure upgrade test 已改为 Codex host-attributed composition；
- hindsight test 已明确标记为 component-level assembly characterization，provider-level scope-incomplete 由 §9.1 单独覆盖；
- 非整数 verified exitCode 静默丢弃已新增 characterization test，并登记为 D11；
- “Codex live outcome 频率”表述已改成结构性能力陈述，不做未测量频率 claim；
- invalid-row unavailable 丢弃 truncation metadata 已新增测试并在 §3.3 登记；
- repeated-failure fixture 的 failure rows 已使用非零 exit code；
- transcript 时间字段位置已修正为 `item_completed` 外层记录；
- 手工 SQL 的表述已改为 fixture construction + explicit fault injection。

---

## 13. 尚未解决的问题

1. 是否需要为 `tool_calls` 或独立 evidence lineage 增加真实 occurrence/verification 时间，是生产证据模型决策，不属于本工单。
2. 是否修复 D1/D2/D3，以及修复优先级，需要 Owner/后续生产工单决定；本工单只冻结事实。
3. Codex hostKind scoped read 是否应与 WorkBuddy 对齐，需要独立架构决策。
4. transcript FIFO pairing、parallel completion、subagent root session lineage 尚无充分 characterization；不得在 PRI-1310 中默认其可靠。
5. OpenClaw execute/truncated facts 的非保守降级属于 PRI-1309 范围，本工单未扩展该 surface。
6. 当前测试冻结的是 baseline 的真实行为，不代表这些行为都是理想语义；尤其 D1/D3 是明确缺陷而非应保留设计。

---

## 14. 最终判断

PRI-1308 的成功标准不是证明 PD 已能理解历史行为，而是准确冻结当前能力边界。当前证据表明：

- PD 能观察 live tool outcome，但 Codex shell live PostToolUse 在结构上可以合法缺少 exit-code fact，从而写入 `unknown`；
- Codex transcript 可在 Stop/ingestion 后补充 verified exit-code outcome；
- UPDATE 能让后续窗口可用，但不可还原决策时点认知状态；
- INSERT 能保留 missing live hook 的 verified outcome，但当前缺 project scope并毒化后续 scoped context；
- rowid/created_at 只能描述数据库写入与可见顺序；
- 当前生产证据不能合法支持 repeated-failure 的确定性因果结论。

因此，PRI-1310 的 Golden Trace fixture pack 必须把 UNKNOWN、scope-incomplete、hindsight-sensitive UPDATE 和 insertion-only ordering 作为一等输入事实，而不是为了让测试通过而补造生产系统没有的证据。
