# PRI-904 Prompt Injection Fairness — Implementation Notes

> 实施记录（2026-09-27）。上游依据：`docs/audit/pri-904-activation-injection-root-cause.md`（根因审计）+ PD Prompt Principle Injection Fairness & Starvation Prevention SPEC v0.1。本文件记录 Reality Check 结论、roundKey 决策、旧行为特征化、16 轮 replay 实算数据、路由 parity 与 Complexity Delta。

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

### 最终选择（评审轮修订：hash(runId) → 确定性 session 轮次序数）

```text
roundKey = nextSessionTurnOrdinal(workspaceDir, sessionId)   // = max(user_turns.turn_index) + 1
plugin-local:  同一函数（handleBeforePromptBuild 持 workspaceDir + sessionId）
host-shared:   同一函数（beforePromptBuild 持 event.context.{workspaceDir,sessionId}）
```

- file: `packages/principles-core/src/trajectory-store.ts`（**已登记的 core I/O seam**，registry 第 15–18 行）
- 函数: `nextSessionTurnOrdinal` — 只读打开 `{workspaceDir}/.state/trajectory.db`，走 `idx_user_turns_session_id` 索引做 `MAX(turn_index)` 聚合（live 实测 0ms）
- 数据来源: `user_turns.turn_index`——**已存在**的生产持久列，由 openclaw-plugin `TrajectoryDatabase.recordUserTurn` 写入（live: 1045 行 / 297 个 session），也是纠正流水线锚定所用的同一事实
- why deterministic: 同一 session 的 max(turn_index) 单调递增，+1 精确
- why it advances: 每次记录一个用户回合 → 序数 +1
- 无新增状态: 只读既有表；**无新列、无新表、无新文件、无 cursor、无 module-global 可变状态**
- 库缺失/不可读: 抛 `TrajectoryDbUnavailableError` → 两路由均降级 legacy policy，经 `selectionPolicy` 字段可观测（rc-9）

### 覆盖语义（bounded，可证明）

生产层直接成立：对同一 eligible ring（N 条），同一 session 连续 N 个用户回合的序数为 o, o+1, …, o+N−1，
`start = ordinal mod N` 恰好遍历全部 N 个位置各一次 —— **≤N 轮全覆盖，确定性，非概率**。

生产路径证明（不使用人为 key 搜索）：
- plugin-local：`T-PROD-01` 用真实 `handleBeforePromptBuild` + 真实 trajectory.db 行推进，断言 16 轮的 start 集合等于 {0..15}、union=16/16、序数逐轮 +1；
- host-shared：`T-PROD-02` 断言连续 roundKey 1..N 的 start = round % N 且全部位置被覆盖；
- seam 层：`trajectory-store-round-ordinal.test.ts` 对真实 SQLite 断言 +1 语义、per-session 隔离、非 1 起点（历史裁剪）与 ≤N 覆盖。

边界语义（诚实声明）：
- "一轮" = 该 session 记录的一个用户回合。heartbeat/cron 等非用户触发的 prompt build 不推进轮次（沿用上一次的起点），不构成位置性饥饿——下一次用户回合即推进。
- 新 session 序数从 1 重新开始，因此 bounded 保证是**每 session 内**的；多 session 交错只会增加多样性。
- turn_index 可因历史保留策略从 >1 开始（live 实测存在此类 session），不影响 +1 与 mod N 语义。

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

## 5. Route Parity

两条路由共享同一策略语义（stable ASC base ring → roundKey mod N 起点 → circular scan → continue-on-non-fit → oversized 单列）：

- Route A 用 `trimToBudget(entries, 2000, escapeXml, roundKey)`（核心实现）。
- Route B 在 `buildActivePrinciplePromptContext` 内实现同语义，成本用其真实序列化器（`renderPrinciplesToDirectives` 全量渲染增量）度量。
- T10 parity 测试：以 shared 路由真实渲染算术测出 per-entry block 成本与固定模板开销，构造等价成本的 plugin fixture 与等价预算，同 entries+budget+roundKey 下两路由 **selected IDs / truncated / rotationStartIndex 全等**（`packages/host-runtime/tests/active-principle-prompt-fair-rotation.test.ts`）。
- 序列化差异（真实变体轴）：plugin 行条目 ~200c vs shared directive 块 ~350c+ 固定模板 ~700c——故 parity 前提是 INV-P01 的"same serialization"，测试按此构造。

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
new host-specific behavior:  NO（两路由各自从既有 hook 事实取 round 身份，无宿主特判）
runtime behavior change:     YES —— prompt Principle 预算调度策略（FIFO 前缀 → 确定性公平轮转）
existing telemetry extension: YES —— 上述 5 个 optional 字段
```

新增公共面：types `PromptSelectionPolicy` / `TrimToBudgetResult` 经 runtime-v2 barrel 导出（快照 1779→1781，PRI-775 意内更新流程）。评审轮**删除**了首版的 `roundKeyFromRunIdentity` 导出（改造后无真实 consumer，不留 ghost API），新增 `nextSessionTurnOrdinal` 位于**既有已登记** trajectory-store seam 内（非 runtime-v2 barrel 新面）。SQL 变更仅 prompt 查询追加 `activation_id ASC` tie-break。

## 8. 回滚

- 行为回滚 = 不传 roundKey（等价回滚）或 revert 本 PR；无迁移、无 ledger/activation 数据改动、无 flag。
- legacy 分支保留为逐字节回滚基线（T1 钩子级+纯函数级双重特征化守护）。

## 9. 生产验证（PR 合并后、独立于本 PR）

合并并安装 runtime 后，仍需真实 `openclaw agent` canary：连续 ≤N（当前 16）个受控 prompt-build run 内观察到 target `present=true` 才算 PRI-904 P0 恢复。部署时间 = 新实验边界（SPEC R4）。
