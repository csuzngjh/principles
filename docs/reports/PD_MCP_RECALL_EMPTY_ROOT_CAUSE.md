# PD MCP 召回工具在真实工作区返回空 — 根因报告

- 日期：2026-11-05
- 调查对象：`pd_recall_principle_pains`（MCP 只读工具）在真实工作区 `~/.workbuddy/pd-workspace`
- 调查方式：全部在隔离副本中运行（`%TEMP%\pd-recall-*`），未写入 `~/.workbuddy`、`~/.openclaw`、`~/.pd` 的任何文件；只读断言见 §5
- 基线：`origin/main` = `60aabc8cf8b7cfa9049c960418457f7175a14506`
- 已安装运行时（只读核对）：`~/.pd/runtime/core` 版本 `3.0.0`，`~/.pd/runtime/pd-mcp-server` 版本 `0.2.1`（与任务描述中的 `0.2.2` 不一致，记录事实，不做推断）

## 0. 结论先行

**两条既有断点只解释了一半，真正的直接原因是第三条。**

1. `[PD-READ]` **直接原因**：反解链 `candidate → task → tasks.input_ref` 拿到了 `diagnosis_<painId>`，但读侧把 `input_ref` **原样当作 canonical pain id** 去查 `trajectory.db.pain_events`，没有剥离 `diagnosis_` 前缀。结果是查 `diagnosis_pain_host_xxx`，而库里只有 `pain_host_xxx`，所以**所有**经过分流管线生成的候选都返回空——包括痛事件明明存在的那两条。
2. `[PD-READ]` 输出契约：`status=partial / results=[] / error=null / warnings=[] / nextAction=null`，即使关联确实解析失败，也没有任何可行动信息。
3. `[PD-WRITE]` CLI 桥接登记（无绑定 session）的痛**只进 `state.db`，不进 `trajectory.db.pain_events`**，所以 Owner 手工那条 `manual_1792226109787_ye92vtko` 即使前缀修好也召不回；读侧现在用独立原因码明确说明这一点。

对既有两条断点的复核结论：

| 既有断言 | 复核结果 | 反证 |
|---|---|---|
| `derivedFromPainIds` 里装的是 candidate_id | **成立**（写入侧有意为之） | adapter `derivedFromPainIds: [candidateId]`；SPEC 明确写成 candidate IDs |
| 召回工具按 pain id 直接查表、**不做** candidate→task→pain 反解 | **不成立** | 修复前副本里 unresolved 的 `painId` 是 `diagnosis_pain_host_...`，不是 candidate id；证明 candidate→task 已经解析过，失败点在 `input_ref` 归一化 |
| CLI 桥接的痛不进 `trajectory.db.pain_events` | **成立** | 副本中 `manual_1792226109787_ye92vtko` 在 `trajectory.db` 里 0 命中；但**不是**另外两条失败的原因（它们有 pain_events 行） |

## 1. 现象（实测）

真实工作区账本有 3 条原则，分别是：

| 原则（全 ID） | 短 ID | `derivedFromPainIds` | `state.db` 候选的 `task_id` | `tasks.input_ref` | `trajectory.db` 是否有痛 |
|---|---|---|---|---|---|
| `de43bc49-1fe1-468c-8221-05ea5145f101` | de43bc49 | `7e1b060f-a3cc-4c2e-8356-33e26450cb29` | `diag_router-diagnosis_pain_host_0103aa…` | `diagnosis_pain_host_0103aa…` | 有（`pain_host_0103aa…`） |
| `7b2a556c-39af-488c-ab3b-e543721c5c34` | 7b2a556c | `d3c82d07-9dc6-43e1-aae4-9c3307ebf1e8` | `diag_router-diagnosis_manual_1792226109787_ye92vtko` | `diagnosis_manual_1792226109787_ye92vtko` | **无** |
| `038c442b-1bcb-45cf-9fee-e486c7f288de` | 038c442b | `b1b824e4-714e-415e-b079-3b049c48a251` | `diag_router-diagnosis_pain_host_21289e…` | `diagnosis_pain_host_21289e…` | 有（`pain_host_21289e…`） |

修复前在隔离副本上运行（真实跑，非推断）：

```text
PRINCIPLE de43bc49… → status=partial returned=0 unresolved=[{painId:"diagnosis_pain_host_0103aa…",reason:"pain_event_not_found"}]
PRINCIPLE 7b2a556c… → status=partial returned=0 unresolved=[{painId:"diagnosis_manual_1792226109787_ye92vtko",reason:"pain_event_not_found"}]
PRINCIPLE 038c442b… → status=partial returned=0 unresolved=[{painId:"diagnosis_pain_host_21289e…",reason:"pain_event_not_found"}]
MCP envelope: status=partial, warnings=[], error=null, nextAction=null
```

这与 Owner 现场看到的结果一致（三个原则全部 `results: []`、`pain_event_not_found`）。

## 2. 根因（按归属分组）

图例：每条都回答三问——① 证据；② 为什么不是另外几类；③ 修完后用户实际看到什么变化。

### 2.1 `[PD-READ]` R1 — `input_ref` 的 `diagnosis_` 前缀被当成 canonical pain id（直接影响全部 3 条）

**证据**

- 生产候选的 `task_id` 形状：`packages/principles-core/src/runtime-v2/internalization/split-diagnostician-runner.ts:172`
  为 `diag_router-${parentTaskId}`；`candidate_id, artifact_id, task_id …` 写入见
  `packages/principles-core/src/runtime-v2/store/commit/diagnostician-committer.ts:187-208`（`task_id = input.taskId`）。
  真实副本中 3/3 候选都是 `diag_router-diagnosis_…`。
- 分流管线的 sub-task `input_ref` 是**父诊断任务 id**：真实副本 `tasks.input_ref = diagnosis_<painId>`。
- 修复前读侧把 `input_ref` 原样使用：
  `origin/main` `packages/principles-core/src/runtime-v2/pain-recall-read-model.ts:641-644`
  （`painId = inputRef;`），仅在 `input_ref` 为空且 `candidate.task_id` 本身以 `diagnosis_` 开头时才剥离前缀（`:648-650`）。
  `diag_router-diagnosis_…` 不匹配该 fallback。
  已安装构建同一个缺陷：`~/.pd/runtime/core/dist/runtime-v2/pain-recall-read-model.js:498-505`。
- 因此查询键是 `diagnosis_<pain>`；`pain_events` 只有 `canonical_pain_id = <pain>`，于是 `pain_event_not_found`（`origin/main:684`）。

**为什么不是 [PD-WRITE]/[HOST]/[MODEL]/[ENV]**

- 不是 `[PD-WRITE]`：写入侧的 `choice`（`derivedFromPainIds` 存 candidate id）是有契约的行为；即使写入侧完全正确，读侧把 `diagnosis_…` 当 pain id 仍会让**每条链路都失败**。反证：`de43bc49` 与 `038c442b` 的痛事件在 `trajectory.db` 中真实存在，仍然返回空。
- 不是 `[HOST]`：宿主成功拉起 MCP、成功绑定 WorkBuddy 工作区、成功把工具结果原样传回（把 OpenClaw 原则 ID 传进来时正确返回 `not_found`）。
- 不是 `[MODEL]`：模型传入的是账本里真实存在的完整原则 ID（见 §1 表），工具侧 `identityStatus=resolved`；模型没有传错 ID。
- 不是 `[ENV]`：缺陷在源码与已安装构建里都能复现，与网络/路径/额度无关。

**修完后用户看到什么**

在对话里直接看到自己登记过的痛原文（例如 de43bc49 返回“这是隔离验收信号，请勿将实验登记说成真实用户失误”），而不是空列表。

### 2.2 `[PD-READ]` R2 — 空结果没有任何可行动信息（输出契约）

**证据**

- 修复前能力层把 `warnings` 固定为 `[]`、`nextAction` 固定为 `null`：
  `origin/main` `packages/principles-core/src/runtime-v2/pain-recall-capability.ts:261-263`（另一处 fail-closed 壳 `:398-400`）。
- Owner 现场返回原文：`status=partial / error=null / warnings=[] / nextAction=null / unresolvedAssociations=[pain_event_not_found]`。
- **这 100% 是 PD 输出契约的问题，不是模型问题**：模型确实调用了工具、也确实把返回贴出来了，宿主也把结果完整传递下来；链条没有断，断在返回内容本身没有“为什么”和“下一步”。

**为什么不是 [MODEL]/[HOST]**

模型的职责是调用并转述；它已经正确完成。宿主的职责是传输；它已经正确完成。把“返回为空且无解释”归因给模型或宿主，会掩盖真正的契约缺陷。

**修完后用户看到什么**

即使召回仍为空，也会看到 `warnings`（说明 `derivedFromPainIds` 是 candidate ID 语义、已尝试反解）和 `nextAction`（明确指向 `pd trace` 或重新绑定 session 登记），而不是三件套全空。

### 2.3 `[PD-READ]` R3 — `state.db` 形态被错误归入 `pain_event_not_found`

**证据**

- CLI 桥接写入的痛没有 `pain_events` 行（见 2.4 W2），但读侧对所有缺失行统一报 `pain_event_not_found`
  （`origin/main:684`、`:699`），这会让“关联已验证、只是痛事件未落 trajectory”与“根本没有关联”混为一谈。
- 修复前三个原则全部落到同一原因码，用户无法区分。

**为什么不是 [PD-WRITE]**

这是**读侧分类**错误：写入侧确实按 SPEC §7.4 有意跳过未绑定 session 的 trajectory 投影；读侧应当据此给出不同语义，而不是把两类缺失合并。

**修完后用户看到什么**

CLI 桥接那条会明确显示 `pain_event_only_in_state_db`（“关联已验证，但痛只存在工作区状态库、未进入 `trajectory.db`”），并给出 `nextAction`。

### 2.4 `[PD-WRITE]` W1 — `derivedFromPainIds` 字段名与语义不一致（**有意设计，不是 bug**）

**证据**

- 写入点：`packages/principles-core/src/runtime-v2/adapter/principle-tree-ledger-adapter.ts:55`
  `derivedFromPainIds: [candidateId]`；调用链
  `candidate-intake-service.ts:810` → `writeProbationEntry` → `expandToLedgerPrincipleStatic(entry, candidateId)`（`:132-140`）。
- 账本自身的其他消费方也按 candidateId 使用：`principle-tree-ledger.ts:974-975`（`for (const candidateId of principle.derivedFromPainIds)`）。
- 规范原文：`docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md:456`（`derivedFromPainIds(candidate IDs)`）、`:484`
  （“每个元素需作为 candidateId 验证；可通过原始任务 seed 的 `sourcePainId` 或现有受信 lineage 找真实 Pain”）。
- 结论：**写入侧是有意存 candidate，名字是历史包袱**；不是“应该存 pain id 而写错了”。

**为什么不是 [PD-READ]**

读侧已经按 candidate 语义反解（`origin/main:619-644`），说明契约两侧是对齐的；真正错的是反解后的 `input_ref` 归一化（R1）。把 W1 当读侧 bug 会误导修复方向。

**修完后用户看到什么**

无直接变化（字段名不改、历史数据不动）；收益通过读侧兼容体现。

### 2.5 `[PD-WRITE]` W2 — 未绑定 session 的 CLI 登记痛不进 `trajectory.db`

**证据**

- `pd pain record` 在无 `--session` 时生成 `manual_…` 且 `recordObservability=false`：
  `packages/pd-cli/src/commands/pain-record.ts:394`、`:430`、`:478`。
- 服务层据此跳过投影：`packages/principles-core/src/runtime-v2/pain-to-principle-service.ts:210`、`:255`。
- 唯一的生产 `pain_events` 写入点在 `packages/principles-core/src/runtime-v2/pain-signal-observability.ts:150`。
- 真实副本中 `manual_1792226109787_ye92vtko` 在 `trajectory.db` 全库检索 0 命中；但 `state.db` 的 `diagnosis_manual_…`
  任务里保留了 `sourcePainId`、`reasonSummary`、`correctionEvidence.text`。

**为什么不是 [HOST]**

CLI 桥接是用户主动的本地登记，不经过宿主 hook；缺失 `pain_events` 行是 PD 自己的投影策略（SPEC §7.4），不是宿主没传。

**修完后用户看到什么**

历史那条仍不会返回原文（历史数据不动），但会得到可判读的 `pain_event_only_in_state_db` 与下一步动作；**未来**若要让它进入 trajectory，需要单独决定是否改写入策略（见 §6 方案 C）。

### 2.6 `[PD-WRITE]` W3 — 旧工作区的 lineage 记录已丢失（OpenClaw 实测）

**证据**

- `~/.openclaw/principle_training_state.json`：9 条原则，9 个 `derivedFromPainIds` 引用；
- `~/.openclaw/workspace/.pd/state.db`：`principle_candidates` = **0 行**；
- `~/.openclaw/trajectory.db`：`pain_events` = 3 行，其中 2 行 `canonical_pain_id = NULL`，1 行 `llm_1781876524242`；
- 9 个引用在 `candidate` 表与 `pain_events` 中都 0 命中。

**为什么不是 [PD-READ]**

读侧无法凭空恢复已被删除/迁移掉的候选与痛记录；这是历史数据丢失，不是查询逻辑可修的。读侧能做的是把它报成 `candidate_not_found` 并给出可行动信息（本次已做）。

**修完后用户看到什么**

该工作区仍然召不回那 9 条原则（数据已不存在），但用户会看到明确原因与下一步，而不是“静默空”。

### 2.7 `[HOST]` — 0 条

宿主行为正确：MCP server 由 `mcp/launcher.cjs` 拉起，WorkBuddy 工作区绑定正确（传 OpenClaw 原则 ID 返回 `principle_not_found`），工具返回被完整传递。**不修，不属于本次范围。**

### 2.8 `[MODEL]` — 0 条

模型调用参数正确（3 个完整原则 ID 均存在），没有截断/幻觉/额度错误。**不修，不属于本次范围。**

### 2.9 `[ENV]` — 1 条（部署状态，非代码缺陷）

已安装 `~/.pd/runtime/pd-mcp-server` 版本 `0.2.1`、`core` `3.0.0`，其 `dist` 中仍是修复前逻辑
（`~/.pd/runtime/core/dist/runtime-v2/pain-recall-read-model.js:498-505`）。这意味着**修复要真正到达用户，需要正常的发版/安装流程**；本次按要求不部署、不发布、不改已安装运行时。**不修，不属于本次代码 PR 范围。**

### 2.10 `[UNKNOWN]` — 1 条

“已安装用户里有多少比例的工作区会命中”**无法从本机证据得出**：缺少安装群/工作区总量数据。可以确定的是机制与默认配置（见 §5）；若要定量，需要安装侧遥测或对每个工作区的账本做 `candidate.task_id` 前缀扫描。归为 `[UNKNOWN]`，不编造比例。

## 3. 两种数据形态实测（真实运行输出）

隔离副本：`%TEMP%\pd-recall-repro`，由 `~/.workbuddy/pd-workspace` 的 `.state/`、`.pd/` 只读复制而来。

### 形态 ①：hook 前缀路径（痛在 `trajectory.db.pain_events`）

- 数据特征：`candidate → task.input_ref = diagnosis_pain_host_<id>`；`pain_events.canonical_pain_id = pain_host_<id>`。
- 修复前：`status=partial returned=0`，phantom id `diagnosis_pain_host_…`，`pain_event_not_found`。
- 修复后：`status=ok returned=1`，返回真实痛原文与诊断纠错摘要。

真实性说明：这两条的痛事件**本来就在库里**，修复前失败纯粹因为前缀未归一化。

### 形态 ②：CLI 桥接路径（痛只在 `state.db`）

- 数据特征：`candidate → task.input_ref = diagnosis_manual_<id>`；`trajectory.db` 无对应 `canonical_pain_id`；
  `state.db.diagnosis_manual_<id>` 保留 `sourcePainId` + `correctionEvidence.text`。
- 修复前：`status=partial returned=0`，`pain_event_not_found`，`warnings=[]`，`nextAction=null`。
- 修复后：`status=partial returned=0`，`unresolvedAssociations=[{painId:"manual_1792226109787_ye92vtko", reason:"pain_event_only_in_state_db"}]`，
  `warnings` 含 `derived_from_candidate_ids` 与 `pain_event_only_in_state_db`，`nextAction.code=inspect_state_db_pain_diagnosis`。

### 只读断言

运行前后对 `.state/trajectory.db`、`.pd/state.db`、`.state/principle_training_state.json` 做 SHA-256：

```text
before = 3 个哈希
after  = 同 3 个哈希
unchanged = true
```

Owner 数据目录未被写入（副本中 SQLite 只读打开产生的 `-shm`/`-wal` 也只存在于 `%TEMP%`）。

## 4. 修复内容（本 PR）

### 4.1 读侧归一化（R1）

`packages/principles-core/src/runtime-v2/pain-recall-read-model.ts`

- 新增 `canonicalPainIdFromTaskRef()`（`:271`）：只剥离**一层** `diagnosis_` 前缀；剩余为空或以 `diagnosis_` 开头则保持原样（避免歧义）。
- 应用点（`:681`）：`painId = canonicalPainIdFromTaskRef(inputRef)`。
- task-id fallback 同时支持 `diagnosis_<pain>` 与 `diag_router-diagnosis_<pain>`（`:685-693`）。

### 4.2 state.db 形态语义（R3）

- 新增 `stateDbHoldsPainDiagnosis()`（`:287`）：当 `trajectory.db` 无行时，检查 `state.db` 的 `diagnosis_<painId>` 任务
  且 `diagnostic_json.sourcePainId === painId`。
- 原 `pain_event_not_found` 拆成：
  - `pain_event_only_in_state_db`（关联已验证、痛在 state.db、未投影到 trajectory）
  - `pain_event_not_found`（确实没有可核验的痛）
  （`:727-728`；`--pain-id` 过滤同语义 `:743-744`）

### 4.3 输出契约（R2）

`packages/principles-core/src/runtime-v2/pain-recall-capability.ts`

- `warningsFor()`（`:220`）：未解析时至少一条；说明 `derivedFromPainIds` 是 candidate ID 语义、已尝试反解；
  `pain_event_only_in_state_db` 时追加一条来源说明。
- `nextActionFor()`（`:251`）：`unresolvedAssociations` 非空时**永不为 null**；
  state.db 形态给 `inspect_state_db_pain_diagnosis`，其余给 `inspect_unresolved_associations`，均指向 `pd trace` / 重新带 `--session` 登记。
- 接线：`:319-321`。

### 4.4 测试

- `pain-recall-service.test.ts` 新增：
  - assoc-12：`diag_router-diagnosis_<pain>` + `input_ref=diagnosis_<pain>` → 解析出 canonical pain；
  - assoc-13：只有 `state.db` 诊断任务、无 `pain_events` 行 → `pain_event_only_in_state_db`，且 `results=[]`、`status=partial`。
- `pain-recall-capability.test.ts`：
  - 未解析召回必须带 `warnings` 与 `nextAction`；
  - 字段树快照新增 `warnings[].code/message`、`nextAction.code/message`——这些叶子**原本就在**冻结的 `od-a-v1` 白名单中，没有新增路径。

## 5. 影响面（实测 + 机制）

1. **默认分流管线是开的**：`packages/principles-core/src/runtime-v2/feature-flags/feature-flag-contract.ts:265`
   `diagnostician_split_pipeline: enabled: true (since 2026-06-11)`。默认情况下候选 `task_id` 都是 `diag_router-…`，
   因此**默认管线生成的所有原则**都会命中 R1。
2. **WorkBuddy 真实工作区**：3/3 原则失败（2 条痛在 trajectory、1 条只在 state.db）。
3. **OpenClaw 真实工作区**：9/9 原则失败（另有历史 lineage 丢失，W3）。
4. 因此“**只有用 CLI 桥接登记过痛的工作区失效**”**不成立**：hook 路径的两条同样失败；正确表述是
   “**使用默认分流管线生成原则的工作区，召回整体失效**；其中 CLI 桥接登记的痛即使修好前缀也无法返回原文”。
5. 已安装用户占比：`[UNKNOWN]`（见 2.10），不编造数字。

## 6. 修法方案与代价

| 方案 | 内容 | 代价 / 风险 | 状态 |
|---|---|---|---|
| **A（已实现）** | 读侧归一层 `diagnosis_` 前缀 + 区分 `pain_event_only_in_state_db` + 输出契约（warnings/nextAction 非空） | 最小；不改历史数据；不改状态枚举；新增 1 个原因码值。风险：仅覆盖能反解出 canonical id 的链路 | ✅ 本 PR |
| **B（未实现）** | 读侧把 `state.db` 诊断任务合成为“仅有摘要”的召回条目（text 来自 `correctionEvidence`） | 需要重新定义 `availability.painEvent` 语义（trajectory 权威 vs state.db 来源）；CLI 可返回文本，但 MCP OD-A 白名单仍只暴露 availability，用户看不到原文；契约变更需 Owner 决定 | ⏸ 待 Owner |
| **C（未实现，不建议）** | 写侧为未绑定 session 的 CLI 痛补写 `pain_events` | 改动 `recordObservability=false` 的既定策略（SPEC §7.4）；需要回填历史数据；有重复/伪造 session 风险 | ⏸ 待 Owner |
| **D（不可行）** | 恢复 OpenClaw 已删除的 candidate/pain 行 | 原始记录已不存在；不能凭标题/时间相似度重建（SPEC v1.3:484 明令禁止） | ❌ |

## 7. 契约影响

- `warnings[]` 与 `nextAction` 的叶子路径**已在**冻结白名单 `od-a-v1` 中；本次只是从“恒为空”变为“未解析时填充”，**未扩大允许路径**。
- `status` 顶层枚举未改：`partial` 的语义是“部分交付”，本次在该状态下补足可判读原因与下一步。
  Owner 若要求为 `pain_event_only_in_state_db` 新增顶层状态，需要契约版本升级（v0.5 的 status 表），属于后续独立决策。
- 新增原因码 `pain_event_only_in_state_db` 是 `unresolvedAssociations[].reason` 值层面的扩展；原文档写“5 个稳定原因码”，本次变为 6 个，需在文档/后续 SPEC 中同步（本 PR 不改规范正文）。

## 8. 未解 / 不属于本次范围

- `[PD-WRITE]` 历史数据回填、未绑定 CLI 痛的 trajectory 投影策略：**不修**（方案 C，需 Owner 决策）。
- `[PD-WRITE]` OpenClaw 已丢失的 lineage：**不可恢复**。
- `[PD-READ]` state.db 形态的原文返回：**不在本 PR**（方案 B，需 Owner 决策）。
- `[ENV]` 已安装运行时 `0.2.1/core 3.0.0` 仍是旧逻辑：**不部署、不发版**；本 PR 保持 OPEN。
- `[HOST]` / `[MODEL]`：经核对无缺陷，**不修**。

## 9. 归属计数

| 归属 | 条数 | 条目 |
|---|---|---|
| `[PD-READ]` | 3 | R1 前缀未归一化（直接原因）、R2 输出契约、R3 state.db 形态分类 |
| `[PD-WRITE]` | 3 | W1 candidate ID 语义（有意）、W2 CLI 无 session 不投影、W3 旧工作区 lineage 丢失 |
| `[HOST]` | 0 | — |
| `[MODEL]` | 0 | — |
| `[ENV]` | 1 | 已安装运行时版本落后（部署状态，非本次代码范围） |
| `[UNKNOWN]` | 1 | 已安装用户命中比例（缺安装群数据） |
