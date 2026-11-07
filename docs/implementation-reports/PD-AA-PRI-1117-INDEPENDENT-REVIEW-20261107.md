# PD Adaptive Activation — PRI-1117 独立审查报告

- 审查日期：2026-11-07
- 审查人：Trae（独立任务工作树 `ai/PRI-1117-aa-independent-review`）
- PR：https://github.com/csuzngjh/principles/pull/2402（OPEN，不合并）
- Base：`9c07876207655b4ac9757fb3510a69f3bb9dfa30`（最新 `origin/main`）
- 审查范围：PRI-1118 受控准入设计/实现、真实宿主运行证据、PRI-1115 汇总、PRI-1116 C01–C09 矩阵、C08 已知案例复核、隔离事故与污染排除记录
- 非范围：不重做架构评审、不重新实现已完成组件、不启动新宿主回合、不调用模型、不写生产库、不改安装目录、不合并 PR

> **2026-11-07 后续修订（不改变原 CONDITIONAL 结论）**
>
> 1. [M2 离线调查](PD-AA-PRI-1117-M2-OFFLINE-INVESTIGATION-20261107.md)：在现有 1258 资产上，`call1` / `call_1` 的“同一调用”已由参数逐字节、工具名、全对话唯一性、结果内容与时间链支持（高置信）；ID 字符串相等**不成立**，记 `idEquality: not_proven`。顺序可信但限于同机时钟、无共享 request ID。B1 因此从“事实缺口”改为“门禁取证缺口”，可在离线闭合，无需新宿主回合。
> 2. [1258 事后只读生产库审计](PD-AA-PRI-1117-POST-RUN-AUDIT-20261107.md)：三表 + `runs` 辅助表全列/全量扫描，8 类标记命中 0；结论为“**本次检索范围内未发现**”，不是“已证明不存在”；“零生产写入”仍为 `unknown`。审计前后库 size/mtime/sha256 一致。
> 3. [正例/对照臂成功与停止判据](PD-AA-PRI-1117-STOP-CRITERIA-20261107.md)：按臂拆分判据，修正“control 无准入”与“必须消费准入”的冲突；对照臂按 10 项独立判定，准入缺席是定义而非失败。
>
> 本修订未新增宿主回合、未调用模型、未重跑 positive、未写生产库、未改预算/冻结证据/历史判定。

---

## Owner Review Card

1. **Problem**
   当前实现与证据是否足以进入下一阶段；真正阻断项是什么。

2. **Before**
   受控准入已接入但仍保留证据缺口；原始在线运行在 positive 阶段失败，control 臂从未执行；端点用户消息摘要与冻结输入不同；请求与关键行动缺少被门禁/读模型承认的固定身份顺序。

3. **After**
   本轮给出 CONDITIONAL 结论：可进入**有界**下一阶段（离线补齐 M2 + 剩余预算内 control-only + 限域声明），但不能宣告 G1/C04 通过，也不能启动新 positive 宿主运行或 PRI-1119/Native 试用。

4. **Existing mechanism reused**
   复用现有受控准入、`composeAdaptiveIntervention` 回退、隔离 launcher/env 隔离、门禁与读模型；未新增架构层、未新增持久化源、未新增公共接口。

5. **Complexity Delta**
   - New durable source of truth: NO
   - New persisted schema/state: NO
   - New subsystem/service/background process: NO
   - New public abstraction/interface: NO
   - New runtime feature flag: NO
   - New cross-package dependency: NO
   - New host/platform-specific behavior: NO
   - New external/network capability: NO
   本轮仅新增审查文档与检查点。

6. **Design reason**
   最小缺口是“证据身份/顺序”而不是新架构：M2 可在现有原始证据上离线补齐；M3 是授权与执行路径问题；M1 是声明边界问题。

7. **Verification**
   - `npx vitest run scripts/__tests__/aa-controlled-admission.test.mjs` → 34/34 passed
   - 原始运行资产只读复核：输入/宿主 transcript/端点摘要/工具调用 ID/时间戳
   - 隔离环境、P0 inspect、config、MCP 开关只读复核
   - 未运行新宿主回合、未调用模型、未写生产库

8. **Risk**
   - 若把“离线 13/13 通过”当作 G1 通过，会重复抬高验收边界。
   - 若未补齐 M2 的 request↔action 固定身份，任何“timely”结论仍不可复核。
   - 若直接复用旧 G1 卡片“无工具/已批准”，会与本次实际 1 个只读工具冲突。
   - 1258 运行缺少事后生产库只读审计，“未搜到 runId”不能单独证明未越界写入。

9. **Rollback / recovery**
   本轮为文档交付，无运行时回滚需求。下一阶段若启用，停用方式是移除 admission 文件/停止宿主进程，插件自动回到 Native；不写生产配置。

10. **Follow-ups**
    - 将宿主/插件/config 身份从 `plan.json` 传播到读模型（当前 `hostVersion=unknown`）。
    - 明确场景 marker 的长期配置化方式（当前硬编码）。
    - 修复旧 `PD-AA-REAL-HOST-EVIDENCE-CARD-20261106.md` 的过时 B2/Q3 描述。

---

## 0. 结论

**CONDITIONAL（有条件进入下一阶段）**

可进入的“下一阶段”仅限：

1. 在**现有 1258 原始证据**上离线补齐 request↔action 固定身份与顺序校验（不新增宿主调用）；
2. 在**剩余预算**（1 host turn / 1 HTTP / 0 tool call）内执行 control-only，需 Owner 单独授权；
3. 以“target body present + run-level association + 限域声明”报告 positive，**不得**宣称 C04/G1 完整通过、request-level 送达或行为收益。

不可进入：

- 新 positive 宿主运行（需要 1 host turn / 2 HTTP / 1 tool call，已超出剩余预算；必须新预算授权）；
- 任何“逐字节同一输入/同一请求正文”结论（M1 未解释）；
- PRI-1119/Native 真实使用窗口（本审查不授权，且依赖 G1 结论）。

**真正阻断它的最小缺口**：M2——端点工具调用 ID `call1` 与宿主事件日志 `call_1` 不一致，门禁/读模型没有固定身份与顺序校验；该缺口可在现有原始证据上离线补齐，不需要新宿主回合。

---

## 1. 事实核实

### 1.1 合并状态与主线

| PR | 状态 | Merge SHA | Head SHA |
|---|---|---|---|
| #2389 | MERGED 2026-11-06T13:43:49Z | `0508343b73486ecbb8a3608fcba5855be5f0914a` | `c6d1dc8d8ffb961a831142152fd600673b299259` |
| #2393 | MERGED 2026-11-06T13:58:12Z | `d689cb0e803e547354f33e565e12a8f1eb5a1a0e` | `596d8ae3776151a7aac71213b5e66bf3a1e7d5dd` |
| #2396 | MERGED 2026-11-07T00:57:34Z | `1046ac7d1f29eef244e43b114ab9b901c6422d83` | `2a48145532f15c5a929d4361d1387502c5d6d1e4` |
| #2399 | MERGED 2026-11-07T01:07:57Z | `0db84deff355cec629da3368c9afc5977c4d0c95` | `b63b5893ceabdb00e3cbbcc5464db58657082b43` |

- 最新 `origin/main`：`9c07876207655b4ac9757fb3510a69f3bb9dfa30`
- 审查工作树从该主线建立；未修改其他工作树。
- 与审查 head `c6d1dc8d8` 相比，当前主要差异是 `runtime-v2` → `runtime` 重命名；受控准入/门禁/读模型逻辑实质未变。

### 1.2 证据分层

- **当前代码事实**：本轮工作树源码、`git`、`gh`。
- **历史测试**：仓库内既有报告声称的 34/34、13/13 等。
- **独立原始证据**：`aa-run-20261106T1258Z` 及 `aa-run-20261106T1105Z` 原始资产（只读，位于 PRI-1118 工作树）。
- **派生报告**：`PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md`、`OWNER-BRIEF-20261106.md`、`PD-AA-PRI-1116-OFFLINE-ACCEPTANCE-20261107.md`、`PD-AA-C08-KNOWN-CASE-REVIEW-20261107.md`。
- **不可复核**：原始请求正文（fake endpoint 只存摘要）、`linkage-1258.json` 原始文件、1258 事后生产库审计。

---

## 2. 问题一：治理与正常工作是否受保护

**结论：PASS（有授权/文档条件，无硬阻断）**

### 2.1 受控准入不是普通任务的身份绕过入口

- 仅当进程环境同时提供 `PD_AA_ADMISSION_FILE` 与 `PD_AA_EXPERIMENT_ROOT` 时启用；否则 `readControlledAdmissionEnvironment()` 返回不可用，插件走普通 Native。[controlled-admission.ts](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/packages/openclaw-plugin/src/hooks/controlled-admission.ts#L15-L20)
- 必须同时满足：scene marker `[PD-AA:delivery-review:v1]`、输入字节哈希、session 绑定、manifest/target/activation、expires、一次性消费、路径在 experiment root 内。
- native identity 与 admission 同时存在 → `ambiguous_admission` 明确拒绝，不静默择一。[adaptive-principle-intervention.ts](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/packages/principles-core/src/runtime/activation/adaptive-principle-intervention.ts#L60-L64)
- 普通任务只带 marker 不足以启用；没有 operator 级 env/file 控制，无法构造 admission。故不是普通任务可用的通用绕过入口。

### 2.2 授权重验、目标撤销、预算、默认关闭、停用恢复 Native、软截止、异常回退

| 机制 | 代码/证据 | 裁定 |
|---|---|---|
| 默认关闭 | `readAdaptiveActivationConfig()` 缺失/非法返回 `null`，走普通 Native | PASS |
| 授权重验 | `composeAdaptiveIntervention` 返回前 `await deps.revalidate(...)`；失败 → `target_changed` | PASS |
| 目标撤销 | 晚期 `revalidateAdaptivePrinciple` + `restore(adaptiveSafeFallback)` | PASS |
| 预算 | prompt budget 裁剪；`invalid_budget` 回退；无付费调用 | PASS |
| 软截止 | `deadlineAt = min(start + softTimeoutMs, expiresAtMs)`；`deadline` 回退 | PASS |
| 异常回退 | 所有依赖异常 → `dependency_failed`；回退为 native text，不写空 prompt | PASS |
| 停用恢复 Native | config `disabled` / 无 config → 不调用组合；组合失败 → native text | PASS |
| 场景约束 | `scene_not_matched` 回退；marker 硬编码 | PASS（试验范围；长期配置化属后续） |

代码位点：[adaptive-principle-intervention.ts](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/packages/principles-core/src/runtime/activation/adaptive-principle-intervention.ts#L107-L158)、[prompt.ts](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/packages/openclaw-plugin/src/hooks/prompt.ts#L800-L845)

### 2.3 需要 Owner 注意的治理条件

1. 旧 `PD-AA-G1-CONTROLLED-ADMISSION-CARD.md` 写“无工具”，而 1258 实际使用 1 个只读 `read` 工具（`plan.json` / `config.json`）。新执行卡必须明确授权“1 个只读工具”或改为“无工具”，不能沿用旧表述。
2. 旧卡片中的“Owner 已确认”是历史授权，不覆盖本次新运行；新执行卡必须重新取得 Owner 授权。
3. 场景 marker 当前硬编码；不影响普通任务（回退 Native），但不应被解读为通用功能已开放。

---

## 3. 问题二：隔离事故是否得到实质修复

**结论：机制已实质修复；1258 的“零生产写入”主张仍缺事后审计，属结论限制，不是机制阻断。**

### 3.1 事故与排除记录

- 事故环境：继承的生产 `PD_WORKSPACE_DIR` 指向 `D:\.openclaw\workspace`，导致宿主回合把 PD 数据写到生产库。
- v4 污染排除审计：`D:\Code\_worktrees\principles\PRI-1118-controlled-admission-impl\.tmp\incident\pollution-exclusion-2026-11-06-v4.json`
  - `generatedAt`：2026-11-06T12:37:14Z
  - 事故窗口：09:35Z–10:20Z
  - 排除：14 条 `principle_applications`（rowid 48870–48883，09:43:40Z，session `f2090ec8-…`）、14 条 evidence、6 条 capability declarations
  - `productionWrites`：`none`（生产库只读打开，未删除/更新/标注）
- **关键限制**：v4 生成于 12:37Z，**早于** 1258 运行（12:58Z）；它不能证明 1258 未写生产。仓库内没有 1258 事后生产库只读审计。

### 3.2 修复链路（launcher → 子进程环境 → workspace/config/state → 插件/MCP）

| 层级 | 事实 | 证据 |
|---|---|---|
| launcher | `assertPlanInsideExperimentRoot` 在任何写入/spawn 前执行；`buildIsolatedHostEnv` 用于 P0 与 execute | `run-experiment.mjs#L529,L641,L692`；`p0-preflight.mjs#L183,L189` |
| 子进程环境 | 先移除所有可覆盖 key（含 `PD_WORKSPACE_DIR`、`OPENCLAW_WORKSPACE_DIR`、`OPENCLAW_HOME`、`OPENCLAW_STATE_DIR` 等），再显式设置隔离值 | [env-isolation.mjs](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/scripts/dev/aa-controlled-admission/lib/env-isolation.mjs#L2-L35) |
| 路径越界 | 所有 resolved 路径必须 inside experiment root；越界 hard refusal | [env-isolation.mjs](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/scripts/dev/aa-controlled-admission/lib/env-isolation.mjs#L156-L175) |
| workspace/config/state | 1258 environment 证据：`PD_WORKSPACE_DIR` 从 parent 移除并显式改为隔离 workspace；`insideExperimentRoot=true` | `aa-run-20261106T1258Z/evidence/positive.environment.json` |
| 插件解析 | P0 inspect：plugin `source` = 隔离工作树 bundle，`origin=config`，`workspaceDir` = 隔离 workspace，trust registry inside run root | `aa-run-20261106T1258Z/p0-inspect.json` |
| MCP 解析 | `config.json`：`mcp.servers.pd-recall.enabled=false`；`tools.allow=["read"]`；P0 检查 MCP binding 路径与 allowlist | `aa-run-20261106T1258Z/config.json#L34-L46`；`p0-preflight.mjs#L343-L380,L529-L562` |
| 宿主身份 | 隔离 OpenClaw `2026.11.1`，cli sha `469e60c9…`，host identity sha `b62b2e28…`；plugin bundle sha / config sha 固定 | `aa-run-20261106T1258Z/plan.json` |

### 3.3 裁定

- **机制**：继承环境、路径越界、默认回退、插件/MCP 解析四条链路均有代码与运行证据；事故根因已被移除。PASS。
- **1258 零写入主张**：只有 v4（事故窗口）和生产库“未搜到 runId”的观察，没有 1258 事后只读审计；**不能单独证明 1258 未越界写入**。下一阶段证据包必须包含运行前后生产库只读快照/审计。该缺失只限制“零写入”结论，不否定隔离机制本身。

---

## 4. 问题三：M1/M2/M3 逐项裁定

### M1 — 端点用户消息摘要与冻结输入不同

**已知事实**

- 冻结输入 `input.txt` 字节 SHA-256 = `458dac4f7d14ebd159c38c27783e6d26ba553686b26f89343e1ca491da02cef7`。
- 宿主 transcript（`transcript_events` row 5）用户消息内容 SHA-256 = **同一** `458dac4f…`，`EQUAL true`。
- 端点 `userMessageSha256` = `77f64517a091…`，与冻结输入**不同**。
- 差异不是换行/尾随空格归一化：CRLF、trim、trim+NL 等候选哈希均不匹配。
- 原始请求正文未保留（fake provider 只存摘要）。

**可能解释**

- 宿主在把用户消息送入模型请求前注入了包装（sender metadata / conversation info / turn 前缀），导致端点取到的 `messages[0]` 与原始用户正文不同。
- 也可能是端点取到的首条 user message 不是本次输入，而是宿主注入的上下文消息。

**仍未知**

- 包装的确切字节与代码路径；端点 `messages[0]` 是否包含冻结输入。
- 因此不能证明“逐字节同一输入传输”，也不能证明 request-level 同一请求正文。

**影响的具体主张**

- 阻断：任何“逐字节相同输入 / 同一请求正文 / request-level C04”主张。
- 不阻断：target body 在请求中出现（端点已观察）；run-level association（admissionConsumed + hook invocation）。
- 对“timely”的影响：M1 不是顺序问题；顺序由 M2 决定。

**裁定：只限制结论，不阻断限域 positive；若试用范围要求字节级同一输入，则必须先补原始请求/包装证据。**

---

### M2 — 缺请求与关键行动的可信顺序

**已知事实**

- `http-003`（含原则正文）receivedAt `13:00:06.313Z`；`finishReason=tool_calls`；`toolCallAttempts` 为空。
- 唯一只读工具执行事件 `13:00:06.671Z`，宿主事件日志 `toolCallId=call_1`，`toolCallIdRef=74196fe72e4c`。
- `74196fe72e4c` = `sha256("call_1")` 前 12 位。
- 端点 `http-004` 的 assistant 工具调用 `toolCallId=call1`；run-record 同为 `call1`，recordedAt `13:00:06.713Z`；工具结果在 `http-004`，`toolResultContainsFixture=true`。
- `call1` ≠ `call_1`：端点/run-record 与宿主事件日志没有共享的固定工具调用 ID。
- 门禁 13 项检查**没有** ordering/时间先后检查；读模型 `ordering` 硬编码 `unknown`，`requestAssociation` 硬编码 `unknown`。[adaptive-behavior-linkage.ts](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/packages/host-runtime/src/adaptive-behavior-linkage.ts#L118-L132,L198-L209)、[gate.mjs](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/scripts/dev/aa-controlled-admission/lib/gate.mjs#L177-L290)

**可能解释**

- 宿主内部把 OpenAI `call1` 规范化为 `call_1`（或反向）；事件日志与端点各自记录一侧，缺少显式映射。
- 时间戳接近且 run/session/name 一致，说明很可能是同一行动；但没有固定 ID 绑定，不能升级为“可信顺序”。

**仍未知**

- `call1` 与 `call_1` 是否确为同一调用（需要显式映射/端点响应体）；
- 端点请求与宿主 hook 是否有同一 request ID 绑定。

**影响的具体主张**

- 阻断：G1 “timely”（请求先于关键行动）的签收；C04 “行动顺序” confirmed。
- 不阻断：target body 在请求中出现；工具确实执行并包含夹具结果。
- 最小可行修复：把 `call1`/`call_1` 的映射作为**显式证据**记录（保留两侧原值），并在门禁增加“含 target 的请求 receivedAt < 工具事件 ts < 下一请求 receivedAt”的检查；用现有 1258 原始证据离线复核，预计无需新宿主调用。

**裁定：阻断 G1 timely 签收，但可在现有证据上离线补齐；当前版本不能直接宣告 timely。**

---

### M3 — 原协议对照未执行

**已知事实**

- 原始在线运行在 positive 阶段失败（`tool-invocation`、`admission-identity`），control 从未运行。
- 事后修正门禁在原始证据上离线复核 13/13 PASS；这不改变原始失败判定。
- 预算：caps `4 host / 5 HTTP / 2 tool / 0 paid`；used `3 / 4 / 2 / 0`；remaining `1 / 1 / 0 / 0`。
- control 臂预算：`1 host / 1 HTTP / 0 tool`，**恰好落在剩余预算内**。
- launcher `runPositiveThenControl` 总是先 positive 后 control；没有 `--arm control` / resume 路径；在现有 run 上重新执行会先重跑 positive。

**可能解释**

- 原始 positive 失败是门禁/身份缺陷，不是协议设计错误；修正门禁后 positive 事实成立。
- control 未跑是 stop-on-positive-fail 的设计结果，不是预算不足。

**仍未知**

- control 臂的实际返回内容与“无原则”对照差异；
- 是否能在不重跑 positive 的前提下安全地执行 control-only。

**影响的具体主张**

- 阻断：完整协议/paired 结论；C04 的“control 只取 returned”；任何“正例 vs 对照”的因果主张。
- 不阻断：positive-only 的“target body present + run-level action”观察。
- 最小可行修复：增加 control-only 执行路径（小范围 CLI/orchestration，不改预算、不改冻结证据），并在剩余预算内由 Owner 授权执行；或 Owner 明确接受 M3 永久未执行并限制结论。

**裁定：阻断完整协议/C04 control 主张；不阻断 positive-only 观察。控制臂在预算上可行，但当前 launcher 没有 arm-only 路径，且必须重新授权。**

---

### M1/M2/M3 裁定汇总

| 项 | 已知事实 | 影响的主张 | 是否阻断限域 positive | 最小验收 |
|---|---|---|---|---|
| M1 | 宿主 transcript = 冻结输入；端点 user message 不同；无原始正文 | 字节级/同一请求 C04 | 否（声明边界） | 保留 unknown；如需字节级，补原始请求/包装证据 |
| M2 | 请求 13:00:06.313 含 target；工具 13:00:06.671 `call_1`；端点 `call1`；门禁无顺序检查 | G1 timely/C04 顺序 | 是（G1 签收） | 显式 ID 映射 + 顺序检查 + 离线复核 |
| M3 | control 未跑；原始 positive 失败；剩余预算 1/1/0 | 完整协议/C04 control | 否（positive-only） | control-only 路径 + Owner 授权，或明确接受限制 |

---

## 5. 问题四：验收边界是否被重复抬高

**结论：未发现重复抬高；C08 已知案例复核符合 SPEC；T/V/O/D 的 unknown 只限制覆盖率，不否定已确认运行事实。**

- SPEC 明确允许 C08 先用已知案例验证评分区分能力；真实行为效果属于 G2/G3。[SPEC v0.6](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/docs/specs/PD%20Adaptive%20Activation%20SPEC%20v0.6.md)
- `PD-AA-C08-KNOWN-CASE-REVIEW-20261107.md` 只声明已知案例/离线分类，不宣称 C08 通过或行为收益；边界正确。
- 1258 的 `admissionConsumed=confirmed`、`targetBody=confirmed` 与 `T/V/O/D=unknown` 分开记录；T/V/O/D 没有机会普查，不能把调用当分母。[OWNER-BRIEF-20261106.md](file:///D:/Code/_worktrees/principles/PRI-1117-aa-independent-review/docs/implementation-reports/pri-1115/OWNER-BRIEF-20261106.md)
- 原始在线失败、事后离线复核、接线事实、完整实验、行为收益在报告与审计 JSON 中分开；未用文档合并或 CI 通过替代实际效果。
- 需避免的唯一“抬高”风险：把 `controlAdmission` 接线或离线 13/13 当作 G1/C04 已通过。报告已明确否定。

---

## 6. 最小阻断清单（最多三项）

| # | 阻断 | 触发条件 | 影响 | 位置 | 最小验收 |
|---|---|---|---|---|---|
| B1 | M2 请求↔行动固定身份/顺序未编码 | 任何 G1 timely / C04 顺序结论 | 无法证明“先送达后行动”；读模型仍 unknown | `adaptive-behavior-linkage.ts#L118-L132,L198-L209`；`gate.mjs#L177-L290`；原始 1258 | 记录 `call1`↔`call_1` 显式映射；门禁增加 request receivedAt < tool ts < next request；用 1258 离线复核；无需新宿主调用 |
| B2 | M3 control 未执行且无 control-only 路径 | 任何完整协议/C04 control 结论 | 无法给出对照/因果；原协议不完整 | `runPositiveThenControl`（`gate.mjs#L491`）；`plan.json` control 预算 1/1/0 | 增加 control-only 执行路径（不改预算/冻结证据）；Owner 授权后在剩余预算内执行；或明确接受限制 |
| B3 | M1 字节级输入身份未解释 | 任何“逐字节同输入/同一请求正文”结论 | 只能保留 unknown；不能升级为 request-level C04 | 端点 `77f64517a091` vs 冻结 `458dac4f7d14`；原始请求正文缺失 | 采集模型可见首条 user message/原始请求并注明宿主包装；否则保持 unknown、缩小声明 |

**非阻断条件（执行卡必须包含）**

- 1258 事后生产库只读审计（运行前后快照）；“未搜到 runId”不能单独证明零写入。
- 宿主/插件/config 身份从 `plan.json` 传播到读模型（当前 `hostVersion=unknown`；原始 plan 已固定 `2026.11.1` 与哈希）。
- 明确“1 个只读工具”授权，消除旧 G1 卡片“无工具”冲突。
- 旧 G1 卡片的“Owner 已确认”不覆盖新运行，必须重新授权。

---

## 7. 测试与未验证项

### 已运行

- `npx vitest run scripts/__tests__/aa-controlled-admission.test.mjs` → **34/34 passed**
- 原始资产只读哈希复核：
  - `input.txt` = `458dac…`
  - 宿主 transcript row 5 = `458dac…`（EQUAL true）
  - 端点 user message = `77f64517a091…`（different）
  - `toolCallIdRef 74196fe72e4c` = `sha256("call_1")[:12]`
- 隔离只读复核：`config.json`、`p0-inspect.json`、`positive.environment.json`、`plan.json`
- 生产污染审计只读复核：v4 `productionWrites=none`，窗口 09:35–10:20Z，14 条排除

### 未运行（NOT RUN）

| 项 | 原因 | 影响 |
|---|---|---|
| 新宿主回合 / positive 重跑 | 无新预算；本轮禁止 | 无法补齐 M1 原始请求/字节级身份 |
| control 臂 | 无 arm-only 路径；需 Owner 授权 | M3 仍未执行 |
| 模型调用 | 本轮禁止 | 无行为收益数据 |
| 1258 事后生产库审计 | 本轮只读审查，未新增审计 | 1258 零写入未独立证明 |
| 完整 G1/C04 签收 | 受 M1/M2/M3 限制 | 不能宣告通过 |

---

## 8. 最终结论与适用范围

**CONDITIONAL**

- **可进入**：基于现有 1258 证据的离线 M2 补齐；剩余预算内 control-only（需授权）；限域 positive 报告。
- **不可进入**：新 positive 宿主运行（需新预算/授权）；字节级同一输入/request-level C04；G1/C04 完整通过；PRI-1119/Native 试用。
- **审查通过 ≠ Owner 已批准试用**；本报告不启动 G2，不启动任何宿主回合。

---

## 9. Owner 需要决定的最小事项

1. **选择范围 A 或 B**：
   - A（最小、无新 positive）：批准 B1 离线补齐 + B2 control-only（剩余 1/1/0 预算）；接受 M1 永久 unknown 或仅在后续运行解决。
   - B（完整 C04/G1）：批准**新预算**与一次新 positive（含原始请求/首条 user message 捕获、显式工具 ID 映射），再跑 positive+control。
2. **明确工具授权**：本次下一阶段是否允许 1 个只读 `read` 工具（与旧 G1 卡片“无工具”冲突）。
3. **明确生产库证据口径**：是否要求 1258 及后续运行前后生产库只读审计；若不同意，则不得宣称“零生产写入”。

若 Owner 选择 A，下一张可直接执行的工单是：

> **PRI-1117-A：离线补齐 M2 固定身份/顺序校验，并获授权在剩余预算内执行 control-only；输出限域报告，不宣称 G1/C04 通过。**

---

## 附录：关键证据路径

- 原始 1258 运行：`D:\Code\_worktrees\principles\PRI-1118-controlled-admission-impl\artifacts\aa-controlled-admission\aa-run-20261106T1258Z\`
  - `input.txt`、`control-input.txt`、`plan.json`、`config.json`、`run-record.json`、`failure.json`、`independent-audit-codex.json`
  - `evidence/positive.endpoint-requests.json`、`evidence/positive.environment.json`、`evidence/admission-consumed.json`
  - `p0-inspect.json`
  - `state/positive/agents/main/agent/openclaw-agent.sqlite`（只读）
- 原始 1105 运行：`…\aa-run-20261106T1105Z\`
- 污染排除 v4：`…\.tmp\incident\pollution-exclusion-2026-11-06-v4.json`
- 派生报告：`docs/implementation-reports/PD-AA-PRI-1118-INDEPENDENT-AUDIT-20261106.md`、`docs/implementation-reports/PD-AA-PRI-1116-OFFLINE-ACCEPTANCE-20261107.md`、`docs/implementation-reports/pri-1115/OWNER-BRIEF-20261106.md`、`docs/implementation-reports/PD-AA-C08-KNOWN-CASE-REVIEW-20261107.md`
