# PRI-904 Prompt Injection Fairness — Implementation Notes

> 实施记录（2026-09-27）。上游依据：`docs/audit/pri-904-activation-injection-root-cause.md`（根因审计）+ PD Prompt Principle Injection Fairness & Starvation Prevention SPEC v0.1。本文件记录 Reality Check 结论、轮次事实决策、旧行为特征化、16 轮 replay 实算数据、选择器 parity 与 Complexity Delta。
>
> **交付边界：Phase-1（Owner 裁定 Option 3）** —— 本 PR 只修复当前 live 的 **OpenClaw plugin-local** 路由饥饿，bounded 保证限定在**一个持续推进的 OpenClaw session 内**。跨 session / 跨 host / workspace 级 bounded fairness **仍是未完成的架构目标**，host-shared production 明确不宣称 fair rotation（见 §2 与文末「最终架构目标」）。

---

## 1. Reality（当前 main 实际调用路径，Phase 0 复核）

审计后 main 未漂移，全部事实在实改前重新核实：

| 事实 | 复核结果 |
|---|---|
| Route A（生产实际路径，plugin-local） | `packages/openclaw-plugin/src/hooks/prompt.ts` `handleBeforePromptBuild` → `PromptActivationReader` → legacy dedup → `trimToBudget(dedupedV2, 2000, escapeXml)`（原 :636）→ `recordRuntimeV2ActivationsInjected` 事件 |
| Route B（host-shared，`abstraction_layer_v1=false` 下不在生产注入路径） | `packages/host-runtime/src/active-principle-prompt.ts` `buildActivePrinciplePromptContext` 自有贪心循环（首不合即 break）；`packages/host-runtime/src/index.ts` `createProductionHostRuntime.beforePromptBuild` 调用并自带 `event.context.turnId → runId` 事件映射（PRI-750） |
| 排序 | `sqlite-activation-state-store.ts` prompt 查询显式 `ORDER BY activated_at ASC`，无 LIMIT、无二次排序、无 cap |
| Budget | `RUNTIME_V2_PRINCIPLE_BUDGET = 2000`（contract:3），未变 |
| Telemetry | 事件字段含 injectedCount/injectedCharCount/budget/v2Truncated/legacySelectedCount/crossBlockDuplicateIds/runId；**缺** eligibleCount/selectionPolicy/rotationStartIndex/dropped/oversized |
| fixture 保真 | live state.db 只读重提 16 条 entry 精确长度 `[208,150,223,226,143,147,290,216,249,210,256,186,219,202,286,259]`；断点 #10（210 > 余 107）、9 项、1893 字符——与审计 §5 与生产账本逐字节一致 |

无 Reality Check 停止条件触发。未发现 main 已有 fairness 修复。

## 2. Round Key（Phase 2 调查与决策）

### 决策表（首轮调查）

首轮曾把 `ctx.runId` / `turnId` 的 FNV 哈希选为 round key。评审轮复核判定其**只提供概率公平**（哈希不产生 bounded 推进），故重做审计，下方"最终选择"改用确定性 session 轮次序数。

| Candidate | Existing? | Deterministic? | Changes per round? | Plugin available? | Shared available? | Chosen? |
|---|---:|---:|---:|---:|---:|---:|
| OpenClaw `ctx.runId`（UUID）→ FNV-1a32 | YES（live 1431/1431 事件携带、868 个不同值） | YES（纯哈希） | 会变但**非推进**（随机身份） | YES | N/A | ✗ 评审轮否决 |
| Codex `event.context.turnId` → FNV-1a32 | YES | YES | 同上 | N/A | YES | ✗ 评审轮否决 |
| `nextUserTurnIndex()`（trajectory user turns） | YES（prompt.ts:124） | YES | 仅 user turn +1 | YES | NO（HostEvent 无 messages） | ✗ 载体不可达 |
| `event.messages` user-role 计数 | YES | YES | 通常变化；上下文压缩可回退 | YES | NO | ✗ |
| trajectory assistant-turn 计数 | YES | YES | 每 LLM 响应 +1 | YES | NO | ✗ |
| `Date.now()` / `Math.random()` | — | NO | — | — | — | ✗ SPEC 禁止 |
| 新建持久化计数器 | NO（新状态） | — | — | — | — | ✗ SPEC 禁止 |

### 最终选择（Phase-1 交付边界，Owner 裁定 Option 3）

```text
OpenClaw plugin-local（当前 live 路由）:
  roundKey = nextSessionTurnOrdinal(workspaceDir, sessionId)   // = max(user_turns.turn_index) + 1

host-shared production（含 Codex）:
  roundKey = 不存在 —— 不传
```

- file: `packages/principles-core/src/trajectory-store.ts`（**已登记的 core I/O seam**，registry 第 15–18 行）
- 函数: `nextSessionTurnOrdinal` — 只读打开 `{workspaceDir}/.state/trajectory.db`，走 `idx_user_turns_session_id` 做 `MAX(turn_index)` 聚合（live 实测 0ms）
- 数据来源: `user_turns.turn_index`——**已存在**的生产持久列，**唯一生产 writer 是 OpenClaw `TrajectoryDatabase.recordUserTurn`**
- 无新增状态: 只读既有表；**无新列、无新表、无新文件、无 cursor、无 module-global 可变状态**
- 库缺失/不可读 → 抛 `TrajectoryDbUnavailableError` → 降级 legacy policy，经 `selectionPolicy` 字段可观测（rc-9）

#### 时序与 off-by-one（如实记录）

```text
user prompt 到达
  → SignalCollectorHost.detectSync 同步写 user_turns   （prompt.ts:407，早于选择）
  → nextSessionTurnOrdinal 读 MAX(turn_index)+1          （prompt.ts:661）
  → trimToBudget                                        （prompt.ts:666）
```

选择时**本回合已被写入**，故 helper 返回的是**下一回合**的序号（off-by-one）。该偏移对公平性无影响——公平只依赖严格 +1 递进；此处记录真实语义而非掩盖。

#### host-shared production 为何不传 roundKey

`createProductionHostRuntime` 同时服务 Codex。Codex 的 ingestion 只写 `governance_*`（state.db），其生产夹具仅有 `sessions/tool_calls/pain_events`——**从不写 `user_turns`**。若在此读取 session 回合序号：库缺失→抛错降级；有库无表→query failed 降级；有表无该 session 行→**恒返回 1**，起点固定为 1（另一种位置性饥饿），而事件仍会声称 fair rotation + 轮次溯源。

故 shared production **不传 roundKey**，如实报告 `legacy_fifo_prefix_v1` 且不带任何 rotation provenance。selector 的 fair-rotation 能力保留，供确实持有合法推进权威的调用方使用。

### 覆盖语义（bounded，范围严格限定）

**Phase-1 契约（本 PR 交付）**：对稳定的 N 条 eligible Principle，在一个**持续推进 user turns 的 OpenClaw session** 内，N 个连续 session selection rounds 覆盖全部 N 个 rotation start positions，union opportunity coverage = N/N。

生产路径证明（不使用人为 key 搜索）：
- `T-PROD-01`：真实 `handleBeforePromptBuild` + 真实 trajectory.db 行推进，断言 16 轮 start 集合 == {0..15}、union 16/16、序数逐轮 +1；
- `T-PROD-02`：target(#14) 与 oldest(#1) 均在窗口内获得席位（无反向饥饿）；
- seam 层 `trajectory-store-round-ordinal.test.ts`：真实 SQLite 断言 +1 语义、per-session 隔离、非 1 起点（历史裁剪）、≤N 覆盖；
- `T6`：host-shared **production** dispatch 报 legacy 且无 provenance；
- `T7`：Codex **真实 dist/pd-hook.js** 可执行文件——注入仍工作，事件不虚假宣称 fair。

#### 明确不保证（Explicit Non-Claim）

- **不保证**跨 session 的 N 轮覆盖（「A:2 回合 / B:2 回合…」模式下起点只在 {1,2} 循环）；
- **不保证** Codex / host-shared production 的任何 bounded fairness；
- 「一轮」= 一个**记录的用户回合**；heartbeat/cron 等非用户触发构建不推进轮次；
- 新 session 序数从 1 重新开始。

### 最终架构目标（未被本 PR 降低）

```text
Workspace/runtime scoped bounded fairness remains an architectural target.

PR #1878 Phase-1 delivery:
Bounded fairness is guaranteed only within a continuously advancing OpenClaw
session on the currently live plugin-local route.

This Phase-1 contract does NOT satisfy final cross-session or cross-host
bounded fairness.

Host-shared production MUST NOT claim fair_rotation_v1 until a legitimate
shared advancing round authority exists.
```

跟进工单：见 Linear「[P2] Cross-host Principle Injection Fairness Clock」。


### 被否决的候选（保留审计痕迹）

| Candidate | Existing | Deterministically advancing | Plugin-local | Host-shared | Same semantics | New state | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| A. `ctx.runId` / `HostEventContext.turnId` 本身 | YES | **NO**（live 1474 条：1457 UUID + 17 `name:uuid:status` 复合串，无单调性） | YES | YES | YES | NO | **REJECT** — 随机身份，哈希后"会变"≠"推进" |
| B. `nextUserTurnIndex()`（trajectory 封装） | YES | YES（底层即 C） | YES | NO（HostEvent 无 messages） | 部分 | NO | REJECT（仅因载体不可达；语义采纳自 C） |
| C. `user_turns.turn_index`（core seam 只读） | YES | **YES**（live 297/297 session 严格单调、span==count 连续） | YES | YES | YES（同一函数） | **NO** | **CHOSEN** |
| D. `hash(runId)` 派生的 start（首版实现） | YES | **NO**（仅统计性） | YES | YES | YES | NO | **REJECT** — 无法证明 ≤N 轮上界 |


## 3. Old Behavior（特征化，T1）

16-entry fixture（live 长度）+ 无 roundKey（legacy policy）：

```text
selectedCount     = 9            (#1..#9 ASC 前缀)
injectedCharCount = 1893         (header 32 + Σentries 1852 + 9 换行)
truncated         = true         (#10 entry 210 > 余 107 → break)
target (#14)      = absent
dropped           = [act_prompt_10]
```

与生产 405+ 注入事件及审计 replay A 逐字节一致。该行为保留为 `roundKey === undefined` 分支（回滚基线），钩子级与纯函数级双重特征化。

## 4. New Behavior（16 轮 replay 实算，fixture + fair_rotation_v1）

| Round | Start | Selected IDs | Count | Chars | Target present |
|---:|---:|---|---:|---:|---:|
| 0 | 0 | 01,02,03,04,05,06,07,08,09 | 9 | 1893 | false |
| 1 | 1 | 02,03,04,05,06,07,08,09,10 | 9 | 1895 | false |
| 2 | 2 | 03,04,05,06,07,08,09,10,12 | 9 | 1931 | false |
| 3 | 3 | 04,05,06,07,08,09,10,11,12 | 9 | 1964 | false |
| 4 | 4 | 05,06,07,08,09,10,11,12,13 | 9 | 1957 | false |
| 5 | 5 | 06,07,08,09,10,11,12,13,02 | 9 | 1964 | false |
| 6 | 6 | 07,08,09,10,11,12,13,**14** | 8 | 1868 | **true** |
| 7 | 7 | 08,09,10,11,12,13,**14**,15 | 8 | 1864 | true |
| 8 | 8 | 09,10,11,12,13,**14**,15,16 | 8 | 1907 | true |
| 9 | 9 | 10,11,12,13,**14**,15,16,01 | 8 | 1866 | true |
| 10 | 10 | 11,12,13,**14**,15,16,01,02,05 | 9 | 1950 | true |
| 11 | 11 | 12,13,**14**,15,16,01,02,03,04 | 9 | **2000** | true |
| 12 | 12 | 13,**14**,15,16,01,02,03,04,05 | 9 | 1957 | true |
| 13 | 13 | **14**,15,16,01,02,03,04,05,06 | 9 | 1885 | true |
| 14 | 14 | 15,16,01,02,03,04,05,06,07 | 9 | 1973 | false |
| 15 | 15 | 16,01,02,03,04,05,06,07,08 | 9 | 1903 | false |

- **union coverage = 16/16**（每个位置都是某轮的起点→必入选）。
- target（#14）入选轮：6–13（8/16 轮在场）；oldest（#1）入选轮：0, 9–15（8/16 轮在场）——无反向饥饿。
- round 2/5 展示 continue-on-non-fit：装不下的长条目被跳过，更短的后继（12、02）仍入选。
- round 11 恰好 2000 字符压线——预算边界精确。
- 每轮 ≤ 2000（0..99 连续 roundKey 全部断言）。上表 roundKey = 该轮 session 序数；生产层由 `nextSessionTurnOrdinal` 提供（第 k 轮读数即 o+k-1，`start=(o+k-1) mod 16`），故 round k+1 的起点是 round k 的下一格。

## 5. Selector Parity（能力层，非生产接线）

两条路由的**选择器**实现同一策略语义（stable ASC base ring → roundKey mod N 起点 → circular scan → continue-on-non-fit → oversized 单列）：

- Route A（plugin-local）用 `trimToBudget(entries, 2000, escapeXml, roundKey)`（核心实现）。
- Route B（host-shared）在 `buildActivePrinciplePromptContext` 内实现同语义，成本用其真实序列化器（`renderPrinciplesToDirectives` 全量渲染增量）度量。
- T10 parity 测试：以 shared 路由真实渲染算术测出 per-entry block 成本与固定模板开销，构造等价成本的 plugin fixture 与等价预算，同 entries+budget+roundKey 下两选择器 **selected IDs / truncated / rotationStartIndex 全等**。
- 序列化差异（真实变体轴）：plugin 行条目 ~200c vs shared directive 块 ~350c+ 固定模板 ~700c——故 parity 前提是 INV-P01 的 "same serialization"，测试按此构造。

> ⚠️ **这是能力层 parity，不是生产接线 parity。** Phase-1 只有 Route A 获得 round authority；Route B 的 production caller（同时服务 Codex）**不传 roundKey**，故其生产行为是 `legacy_fifo_prefix_v1`。T6/T7 专门锁定这一事实。

## 6. Telemetry（仅扩展现有事件）

`runtime_v2_prompt_activations_injected` 新增 optional 字段（TypeBox schema 同步；旧 reader 可忽略）：

```json
{
  "selectionPolicy": "fair_rotation_v1",
  "eligibleCount": 16,
  "rotationStartIndex": 7,
  "selectionRoundOrdinal": 23,
  "selectionRoundSource": "session_user_turn_ordinal",
  "droppedActivationIds": ["act_prompt_10"],
  "oversizedActivationIds": []
}
```

- `droppedActivationIds` / `oversizedActivationIds` **schema 层** `maxItems: 16`（不只是 producer 约定，wire contract 强制）。
- 轮次溯源：`fair_rotation_v1` 必然伴随 `selectionRoundOrdinal` + `selectionRoundSource`——没有溯源的轮转选择不是合法事件（评审 P2-B）。
- `truncated`（v2Truncated）语义：fair 模式下 = 至少一条非-oversized eligible 条目因预算未入选；oversized-only 不置位。legacy 模式 = 原语义（首不合 break）。
- 降级可观测：sessionId 缺失或 trajectory 库不可读 → `selectionPolicy=legacy_fifo_prefix_v1`（无 rotationStartIndex/轮次溯源）。

## 7. Complexity Delta

```text
new SSOT:                    NO
new persisted schema/state:  NO
migration:                   NO
new subsystem:               NO
new background process:      NO
new feature flag:            NO
new cross-package dependency: NO（host-runtime/plugin 原有 @principles/core 依赖内新增 import）
new host-specific behavior:  NO（plugin-local 从既有 hook/session 事实取轮次，无宿主特判）
runtime behavior change:     YES —— prompt Principle 预算调度策略（FIFO 前缀 → 确定性公平轮转）
existing telemetry extension: YES —— 上述 5 个 optional 字段
```

新增公共面：types `PromptSelectionPolicy` / `TrimToBudgetResult` 经 runtime-v2 barrel 导出（快照 1779→1781，PRI-775 意内更新流程）。评审轮**删除**了首版的 `roundKeyFromRunIdentity` 导出（改造后无真实 consumer，不留 ghost API），新增 `nextSessionTurnOrdinal` 位于**既有已登记** trajectory-store seam 内（非 runtime-v2 barrel 新面）。SQL 变更仅 prompt 查询追加 `activation_id ASC` tie-break。

## 8. 回滚

- 行为回滚 = 不传 roundKey（等价回滚）或 revert 本 PR；无迁移、无 ledger/activation 数据改动、无 flag。
- legacy 分支保留为逐字节回滚基线（T1 钩子级+纯函数级双重特征化守护）。

## 9. 生产验证（PR 合并后、独立于本 PR）

合并并安装 runtime 后，仍需真实 `openclaw agent` canary：连续 ≤N（当前 16）个受控 prompt-build run 内观察到 target `present=true` 才算 PRI-904 P0 恢复。部署时间 = 新实验边界（SPEC R4）。
