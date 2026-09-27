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

### 决策表

| Candidate | Existing? | Deterministic? | Changes per round? | Plugin available? | Shared available? | Chosen? |
|---|---:|---:|---:|---:|---:|---:|
| OpenClaw `ctx.runId`（UUID）→ FNV-1a32 | YES（hook ctx；PRI-750 lineage 字段；live 1431/1431 事件携带、868 个不同值） | YES（纯哈希，per-build 不可变事实） | YES——90% run 单次 build（779/868），run 间必变；同一 run 内多次 build 稳定（= 语义正确的"一轮"） | YES | N/A（本路由自有事实） | ✅ plugin-local |
| Codex `event.context.turnId` → FNV-1a32 | YES（HostEventContext.turnId；PRI-750 已统一映射 runId） | YES | YES（每 turn 新值） | N/A | YES（SessionStart 缺失→可观测降级 legacy） | ✅ host-shared |
| `nextUserTurnIndex()`（trajectory user turns） | YES（prompt.ts:124） | YES | 仅 user turn +1；heartbeat-only session 冻结 | YES | NO | ✗ |
| `event.messages` user-role 计数 | YES（event payload） | YES | 通常变化；上下文压缩可回退 | YES | NO（HostEvent 无 messages） | ✗ |
| trajectory assistant-turn 计数 | YES | YES | 每 LLM 响应 +1 | YES | NO | ✗ |
| `Date.now()` / `Math.random()` | — | NO | — | — | — | ✗ SPEC 禁止 |
| 新建持久化计数器 | NO（新状态） | — | — | — | — | ✗ SPEC 禁止 |

### 最终选择

```text
roundKey = roundKeyFromRunIdentity(host_run_identity)
plugin-local:  host_run_identity = ctx.runId          (OpenClaw hook context)
host-shared:   host_run_identity = event.context.turnId (Codex; SessionStart 无 → 不传 roundKey)
```

- file: `packages/principles-core/src/runtime-v2/activation/prompt-activation-reader-contract.ts`
- 函数: `roundKeyFromRunIdentity`（FNV-1a 32-bit，纯函数，`>>> 0` 无符号）
- why deterministic: 同一 run 身份字符串 → 同一整数；无时钟、无随机、无持久状态。
- why it changes: 生产 live 证据——8 个 events_*.jsonl 共 1431 条注入事件全部携带 runId，868 个不同值；OpenClaw 每个 protocol run 分配新 run id，90%（779/868）的 run 恰好一次 prompt build。同一 run 内多次重建 prompt（长工具循环）保持同一起点——一个 run = 一轮，语义正确且对 prompt cache 友好。
- plugin path availability: `handleBeforePromptBuild` 已解构 `ctx.runId`（缺 runId → 可观测降级 legacy policy）。
- shared path availability: `createProductionHostRuntime.beforePromptBuild` 持有 `event.context.turnId`（即 PRI-750 事件里写为 runId 的同一事实）。

### 覆盖语义（诚实声明）

纯函数层：连续 roundKey `k..k+N-1` → **确定性** ≤N 轮全覆盖（T2/AT-03）。
生产派生层：roundKey 来自 run 身份哈希，起点在 `[0,N)` 上近似均匀重抽，而非严格 +1 递进。因此 INV-F02 的"≤N 轮"上界在纯函数层严格成立；在生产派生层为概率性：每轮约 9/16 命中（当前 pack≈9/16），连续 16 轮仍缺席的概率 ≈ 1.8e-6，32 轮 ≈ 3e-12，随轮数指数趋零——**永久位置性饥饿被消除**（选择不再依赖固定前缀位置），但单条原则的首次入选时刻不是确定性上界。runId 缺失的 build 降级 legacy policy 并经 `selectionPolicy` 字段可观测（rc-9）。

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
- 每轮 ≤ 2000（0..99 连续 roundKey 全部断言）。

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
  "droppedActivationIds": ["act_prompt_10"],
  "oversizedActivationIds": []
}
```

- `droppedActivationIds` / `oversizedActivationIds` 硬上限 16（SPEC §10）。
- `truncated`（v2Truncated）语义：fair 模式下 = 至少一条非-oversized eligible 条目因预算未入选；oversized-only 不置位。legacy 模式 = 原语义（首不合 break）。
- 降级可观测：runId/turnId 缺失 → `selectionPolicy=legacy_fifo_prefix_v1`（无 rotationStartIndex）。

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

新增公共面：`roundKeyFromRunIdentity`（+ types `PromptSelectionPolicy`/`TrimToBudgetResult`）经 runtime-v2 barrel 导出（快照 1779→1780，PRI-775 意内更新流程）。SQL 变更仅 prompt 查询追加 `activation_id ASC` tie-break。

## 8. 回滚

- 行为回滚 = 不传 roundKey（等价回滚）或 revert 本 PR；无迁移、无 ledger/activation 数据改动、无 flag。
- legacy 分支保留为逐字节回滚基线（T1 钩子级+纯函数级双重特征化守护）。

## 9. 生产验证（PR 合并后、独立于本 PR）

合并并安装 runtime 后，仍需真实 `openclaw agent` canary：连续 ≤N（当前 16）个受控 prompt-build run 内观察到 target `present=true` 才算 PRI-904 P0 恢复。部署时间 = 新实验边界（SPEC R4）。
