# Principle Ledger Write Boundary — PR1 Implementation Notes

> **SPEC**：PD Principle Ledger Write Boundary & Baseline Qualification v2.1
> **范围**：Phase 1 / PR1 — Candidate Principle Ledger Write Boundary
> **状态**：实施完成，等待 Owner Review
> **基线**：`origin/main` @ `14276dc1`
> **约束声明**：未执行 Phase 2、未修改历史 Ledger、未禁用 activation、未实现 Resolver、未引入 embedding。
> 所有结论来自当前仓库生产代码的只读调查（file:line 可复核），未依据旧文档或 SPEC 假设。

---

## Step 1 — Reality Investigation

### 1.1 Candidate 来源写入 Principle Ledger 的全部路径

**存在且唯一一个共享汇聚点**：`CandidateIntakeService.intake()`
（`packages/principles-core/src/runtime-v2/candidate-intake-service.ts:107`）

```
CandidateIntakeService.intake(candidateId)                       candidate-intake-service.ts:107
  └─ #ledgerAdapter.writeProbationEntry(entry)                   :220（原实现，step 6 无条件写入）
       └─ PrincipleTreeLedgerAdapter.writeProbationEntry()       adapter/principle-tree-ledger-adapter.ts:62
            └─ expandToLedgerPrincipleStatic()                   :20-46
                 └─ addPrincipleToLedger(stateDir, principle)    principle-tree-ledger.ts:440
```

**`intake()` 的全部生产调用点（6 处，均已逐个核对）**：

| # | 位置 | 用途 |
|---|---|---|
| 1 | `principles-core/src/runtime-v2/pain-signal-bridge.ts:808` | 自动路径（诊断完成后批量 intake） |
| 2 | `pd-cli/src/commands/diagnose.ts:563` | `pd diagnose --intake` |
| 3 | `pd-cli/src/commands/candidate.ts:594` | `pd candidate intake`（手动） |
| 4 | `pd-cli/src/commands/candidate.ts:804` | `pd candidate repair` |
| 5 | `pd-cli/src/commands/candidate.ts:1100` | `pd candidate internalization-backfill --confirm` |
| 6 | `pd-cli/src/commands/pain-retry.ts:779` | dead-letter 重试 |

> 注：`pain-flood-simulation-runner.ts:305` / `synthetic-baseline-runner.ts:202` 只是把 `intakeService`
> 作为依赖注入 `PainSignalBridge`，不直接消费返回值，因此自动走 #1 的边界。

**结论**：因为 6 个调用点全部经过 `intake()`，把闸门放在 `intake()` 内部即可覆盖所有
Candidate 来源写入，无需在 6 处重复实现（也避免「将来新增第 7 个调用点绕过闸门」）。

### 1.2 `recommendation_kind` 完整来源链

```
DB 列 principle_candidates.recommendation_kind        sqlite-connection.ts:363
  │  （TEXT NOT NULL DEFAULT 'principle'  ← fallback #1，schema 级）
  ↓
SqliteCandidateStore.mapRow()                          sqlite-candidate-store.ts:29
  │  recommendationKind = resolveRecommendationKind(r.recommendation_kind)
  ↓
resolveRecommendationKind()                            store/candidate/recommendation-kind-resolver.ts:11-16
  │  ← fallback #2：任何非法/缺失/非字符串值一律返回 'principle'（FAIL-OPEN）
  ↓
CandidateRecord.recommendationKind                     store/candidate/candidate-store.ts:15
  ↓
读消费方（admission-gate / pain-signal-bridge / diagnose.ts / Console …）
```

**确认存在三处「default principle」**：

1. **Schema 级**：`recommendation_kind TEXT NOT NULL DEFAULT 'principle'`（`sqlite-connection.ts:363`）。
2. **代码级（关键）**：`resolveRecommendationKind()` 的 `return 'principle'`（`recommendation-kind-resolver.ts:15`），
   并且该 fail-open 行为被单测**显式固化**（`__tests__/recommendation-kind-resolver.test.ts:14-26`：
   `'skill'→principle`、`''→principle`、`42→principle`、`{}→principle`、`[]→principle`）。
3. **Console 读取级**：`pd-console/src/server/utils/diagnostic-parser.ts:26` 同样回落 `'principle'`。

**⇒ 这是本 PR 的核心约束**：闸门**不能**读 `CandidateRecord.recommendationKind`（已被归一化，
无法区分「真 principle」与「垃圾值」）。必须读**原始持久化值**。
故新增 `CandidateRecord.rawRecommendationKind`（见 §3），闸门以它为准。

与既有 Phase-0 审计的一致性：`docs/specs/principle-purification.md` §3.3 RC-4 已独立记录同一事实，
其 R8/Q5 结论是「不改 `resolveRecommendationKind`，用闸门规避 fail-open」——本 PR 遵循该结论，
只新增 fail-closed 校验器，**不改动**既有 fail-open 函数（避免波及 `sqlite-candidate-store.ts:29` /
`sqlite-artifact-store.ts:48` 两处读取语义）。

### 1.3 现有状态模型：rule / prompt / implementation / defer 的实际处理

**类型路由链路已经存在，且不在账本写入路径上**：

| 常量 | 位置 | 内容 |
|---|---|---|
| `KIND_ROUTE_MAP` | `internalization/internalization-route.ts:43-48` | principle→principle-ledger；rule→rule-candidate；implementation→implementation-candidate；prompt→prompt-injection-candidate；defer→deferred |
| `CANDIDATE_KIND_TO_ROUTE` | `internalization/intake-to-internalization-bridge.ts:114-120` | 同上（供 bridge 使用） |
| `ROUTE_CHANNEL_MAP` | `:122-127` | principle-ledger→prompt；rule-candidate→code_tool_hook；implementation-candidate→**skill**；prompt-injection-candidate→prompt |
| `MVP_ENABLED_CHANNELS` | `:108-112` | `prompt` / `code_tool_hook` / `defer_archive`（**不含 `skill`**） |

**缺陷形状（写入与路由的时序）**：`intake()` 在**前**、`route` 在**后**，且 `intake()` 不看 kind。

- `pain-signal-bridge.ts:808`（intake）先于 `:813`（`CANDIDATE_KIND_TO_ROUTE[...]`）。
- `diagnose.ts:563`（intake）先于 `:605`（route）；且 `:601` 只是**跳过 `implementation`/`defer` 的 dreamer seed**，
  `:563` 早已把它们写进了账本。

⇒ 即 §RC-1「写入与路由解耦且写入在先」。本 PR 把 kind 判据补到**写入**这一步（而不是去动路由）。

`candidate.status` 取值只有 `'pending' | 'consumed' | 'expired'`（`candidate-store.ts:16`），
`principle_candidates` 表还有 `CHECK (status != 'consumed' OR consumed_at IS NOT NULL)`（`sqlite-connection.ts:370`）。

---

## Step 2 — 修改点

### 2.1 单一判据（fail-closed）

`store/candidate/recommendation-kind-resolver.ts`（新增，均加性）：

```ts
export const PRINCIPLE_LEDGER_KIND = 'principle';
export function validateRecommendationKind(raw: unknown): RecommendationKind | null  // 严格，非法→null
export function isPrincipleLedgerEligibleKind(raw: unknown): boolean                 // 仅 'principle'
```

`isPrincipleLedgerEligibleKind` 等价于既有路由式 `CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger'`，
由单测**双向钉死**（`__tests__/recommendation-kind-resolver.test.ts`：对 `CANDIDATE_KIND_TO_ROUTE`
的每个 key 断言两者一致，并断言只有 `principle` 映射到 `principle-ledger`），因此不会与路由表漂移。
（不在 store 层 import internalization 层，避免架构倒置与模块环。）

### 2.2 原始值暴露（provenance 锚点）

| 文件 | 变更 |
|---|---|
| `store/candidate/candidate-store.ts` | 新增必填 `rawRecommendationKind: string`（列值原样，未归一化） |
| `store/candidate/sqlite-candidate-store.ts` | `mapRow` 填 `rawRecommendationKind: r.recommendation_kind` |
| `store/artifact/sqlite-artifact-store.ts` | `getArtifactWithCandidates` 同样透传（保持两处读取面形状一致） |

### 2.3 共享写入边界闸门

`candidate-intake-service.ts`：

```ts
// 3b. ★ Principle Ledger write boundary（在加载 candidate 之后、构建 entry 与写入之前）
if (!isPrincipleLedgerEligibleKind(candidate.rawRecommendationKind)) {
  return { outcome: 'refused', reason, candidateId, rawRecommendationKind, message };
}
```

- 返回值由 `Promise<LedgerPrincipleEntry>` 改为**判别联合 `CandidateIntakeResult`**
  （`{ outcome:'ledger_entry', written, entry }` | `{ outcome:'refused', reason, … }`）。
  理由：拒绝必须**不可能被误认为成功**（rc-9-no-silent-fallback），且类型系统强制 6 个调用点显式处理。
- **不抛异常**：若在 `intake()` 抛错，`pain-signal-bridge` 的批量循环会被中断，
  违反 EP-03 / ERR-089「兄弟候选不受影响」的既有约定。
- `reason` 只有两种：`non_principle_kind`（合法但不指向账本）与 `unknown_kind`（缺失/非法/非字符串）。
- 闸门位于 `intake()` 内、`writeProbationEntry` 之**外**：写入层不放闸门，避免「候选已被 intake 消费但账本无条目」的
  语义混淆（沿用 `principle-purification.md` §7.3 的既有结论）。

### 2.4 调用点适配（6 处，保持既有 persistence / routing / defer 行为）

| 位置 | 处理 |
|---|---|
| `pain-signal-bridge.ts:808` | 仅在 `ledger_entry` 时记录 ledger id；拒绝时不写账本，**继续**走既有 kind 路由（rule/prompt 照常，implementation 照常落入 `notInternalizable`） |
| `diagnose.ts:563` | 仍标记 `consumed`（status 行为不变），仅 `ledgerEntryId` 缺省并额外输出 `ledgerWriteRefused`；seed 循环照旧 |
| `pain-retry.ts:779` | 同 diagnose |
| `candidate.ts:594` / `:804` | **手动**命令：拒绝即 `CandidateIntakeError(INPUT_INVALID)` 并 `exit(1)`（显式操作必须醒失败，不静默） |
| `candidate.ts:1100` | 拒绝作为正常 disposition 上报（复用既有 status `'deferred'` + `skipped`，**不**新增状态值，符合 SPEC §7） |

### 2.5 连带修正：bridge 结果状态不再误报 failed

`bridge-result-shaper.ts` 原判据是「admitted 且 ledgerEntryIds 为空 ⇒ **failed**」（`:98`）。
闸门生效后，一批**合法非 principle** 候选（例如全部 `implementation`）会被正确地拒绝写入，
从而「admitted 且 0 条账本」——按原判据会被误报为**失败**。

修正：新增输入 `ledgerEligibleCandidateCount`（= admitted 且 kind 恰为 `principle` 的候选数），
判据改为 `ledgerEligibleCandidateCount > 0 && ledgerEntryIds.length === 0`。
两个调用点（fresh / existing）都按**原始 kind** 计算。这样：
- 全部非 principle ⇒ 不再 failed（回落为既有 `degraded`/`succeeded`，与 routing 结论一致）；
- 确有 principle 候选却无账本条目 ⇒ 仍 failed（原语义保留）。

---

## Step 3 — 测试（打在真实入口）

`packages/principles-core/tests/runtime-v2/candidate-intake-service.test.ts`
（`CandidateIntakeService.intake()` 是 6 个调用点的共享入口）：

| Case | 输入 `rawRecommendationKind` | 断言 |
|---|---|---|
| 1 | `principle` | `outcome='ledger_entry'`、`written=true`、`writeProbationEntry` 被调用 |
| 2 | `rule` | `refused` / `non_principle_kind`、**未写账本**、未改 candidate 状态 |
| 3 | `prompt` | 同上 |
| 4 | `implementation` | 同上 |
| — | `defer` | 同上（SPEC §7 表中 defer 亦不入账本） |
| 5 | 缺失（`undefined`） | `refused` / `unknown_kind`、`rawRecommendationKind=null`、**未写账本** |
| 6 | `unknown_xyz` / `''` / `'PRINCIPLE'` / `'skill'` / `42` | `refused` / `unknown_kind`、**未写账本** |
| ★ | `recommendationKind='principle'` 但 `rawRecommendationKind='unknown_xyz'` | `refused`——**钉死「不得用归一化视图判闸门」** |

辅助/回归测试：
- `store/candidate/__tests__/recommendation-kind-resolver.test.ts`：严格校验器 + 与 `CANDIDATE_KIND_TO_ROUTE` 交叉一致性。
- `__tests__/bridge-result-shaper.test.ts`：新增「无 ledger-eligible 候选 ⇒ 不 failed」与「有 ledger-eligible ⇒ 仍 failed」。
- `runner/__tests__/pain-signal-bridge*.test.ts`、`__tests__/pain-*.test.ts`：真实 bridge 批处理路径。

---

## Step 4 — 回归

见 PR 描述「Verification」一节（含 commands 与结果）。要点：

- `principles-core` 全量、`pd-cli` 全量、两包 `tsc --noEmit` 全绿。
- 受影响面**均为测试替身适配新契约**，无生产行为回退。
- 未触碰：initialization / bootstrap / migration / evolution reducer（SPEC §3 明确这些非 Candidate 来源，不在本阶段范围）。

---

## 不改动 / 未决项（Out of Scope）

1. **不改 `resolveRecommendationKind` 的 fail-open**（保留读取/展示语义；闸门已使写入面 fail-closed）。
2. **不修改历史 Ledger 数据、不做 backfill、不做 baseline qualification**（Phase 2）。
3. **不启用/停用任何 activation**，**不移除 artifact**。
4. **不新增状态值、不新增错误码、不新增 telemetry event 类型**（§7 要求复用现有状态模型）。
5. **不新建 Rule / Prompt / Implementation registry**。
6. 待 Owner 决策（沿用 `principle-specification.md` §9 Rollout 的 D1–D3）：
   - `implementation` 候选归宿是否保持 `deferred`；
   - `candidate intake` 手动命令是否需要 `--force-legacy-intake` 逃生舱（本 PR **未**引入）；
   - Console 审批面在 `prompt` 候选不再产生 ledger 条目后的展示形态（R4）。
7. 观测新增（`ledger_intake_refused` telemetry）**未实现**：`TelemetryEvent.eventType` 受 schema 约束
   （`telemetry-event.ts` 校验），新增事件类型会扩大变更面；当前以既有 `notInternalizable` / candidate outcome 承载 disposition。
