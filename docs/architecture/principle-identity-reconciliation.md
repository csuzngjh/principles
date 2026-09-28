# PD Principle Identity Reconciliation — Phase 3 Design Audit

> **状态**：Design Draft for Owner Review（ADR 草稿）。**未修改任何 schema / migration / selector / injection / activation / production data。**
> **上游**：PR **#1851**（Phase 1 写入边界，已合并）→ Phase 2 Baseline Qualification（`docs/audit/principle-baseline-qualification-phase2.md`）
> **核心问题**：未来 PD 中，**什么东西代表"一条原则"？**
> **证据资产**：`D:/pd-probe-baseline/`（`lineage.cjs` / `identity-final.cjs` / `linkage*.cjs` / `records-final.json`）。所有数据结论均来自 `state.db` 字节副本（integrity ok），生产库从未打开。

---

## 0. 一页结论

1. 身份分裂**不是**"无法 join"——恰恰相反：**11/11 个 live activation 都能沿既有任务链 3 跳走回到 candidate**（scribe ← philosopher ← dreamer ← diag_router），且 artifact 的 `sourceTrace` 字段**自带**这条 lineage（11/11）。**修复不需要新 schema，只需要把已经存在的 lineage 变成"被强制携带的身份"。**
2. 分裂的**铸造点已精确定位**：`activation/low-risk-writers.ts:7-31 extractPrincipleId()` 是一条 **fail-open 兜底链**——`sourcePrincipleId` 缺失时依次回落到 `content.principleId` → `content.sourcePrincipleId` → **`principleDraft.title`**。11 个 live activation 全部落在最后一级（`source_principle_id` 命中 **0/11**），于是 **Philosopher 起的标题就成了持久身份**，被写进 `target_ref` 与 `principle_applications.principle_id`。
3. 这与 PR #1851 修掉的 `resolveRecommendationKind()` fail-open 是**同一个缺陷类**：在写入边界用"内容"冒充"身份"。PR1 修的是"未知 kind → principle"，本 Phase 的对应物是"无 principleId → title 变成身份"。
4. **推荐架构**：**Ledger 为 Canonical Identity（Option A）+ lineage 前向盖章（Option C 的机制）+ activation 边界 fail-closed（PR1 同款手法）**。迁移不需要任何 schema 变更：`pi_artifacts.source_principle_id` 字段**已经存在**，只是从未被写入（0/921 引用账本 id）。

---

## 1. Current State — Identity Inventory & Graph

### 1.1 五个身份面（字段级实测）

| 面 | 身份字段 | 值形态 | 规模 | 指向 |
|---|---|---|---|---|
| **Ledger** `_tree.principles` | `id` | **UUID** | 122 | `derivedFromPainIds[0]` → candidate_id（122/122，orphan=0） |
| **Candidate** `principle_candidates` | `candidate_id` | UUID | 138 | `artifact_id` → `artifacts` 表（138/138）；`task_id` → tasks |
| **Artifact（双空间）** | `artifacts.artifact_id`（诊断产物）/ `pi_artifacts.artifact_id`（内化链产物，形如 `pi-art-dreamer-<candidateId>-prompt-…`） | UUID / **内嵌 candidateId 的复合串** | 3507? / 921 | `pi_artifacts.source_task_id` → tasks；`source_principle_id` → **0/921 命中账本 id** |
| **Activation** `activations` | `activation_id` = `act_prompt_<identity>`；`target_ref` = `ledger://<identity>` | identity = **principleDraft.title 文本**（19/20）或 UUID（1）或 `impl://rule-…`（2） | 20（11 live） | `artifact_id` → **pi_artifacts**（20/20，≠ artifacts 表） |
| **Application** `principle_applications` | `principle_id` | 同上 identity 文本 | 1243 行 / 19 distinct | 与 activation 身份**大部分重合但不相等**（见 1.3） |

### 1.2 Current Identity Graph（实测，非推断）

```
Pain
 └─ candidate (candidate_id=UUID, task_id, artifact_id→artifacts, recommendation_kind, abstracted_principle)
     │  intake: LedgerPrincipleEntry.sourceRef = candidate://<id>；账本 derivedFromPainIds[0] = candidate_id
     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LedgerPrinciple  _tree.principles[id=UUID]  ← 122 条（治理面 SSOT）   │
│   text / status(candidate|active) / metrics(几乎全 0)                │
└──────────────┬───────────────────────────────────────────────────────┘
               │  seed: buildDreamerSeedFromCandidate → taskId = dreamer-<candidateId>-<channel>
               ▼
   dreamer task ── philosopher task ── scribe task        ← 任务链（pi_metadata.dependencyTaskIds / sourceTaskId）
               │
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ PIArtifact  pi_artifacts[artifact_id 内嵌 <candidateId>]              │
│   content_json: principleDraft{title, statement, rationale, …}        │
│                 + sourceTrace{dreamerArtifactId, philosopherArtifactId}│
│   source_principle_id:  ← ★ 应该是身份的字段，实际 0/921 指向账本      │
└──────────────┬───────────────────────────────────────────────────────┘
               │  ★ 身份铸造点 extractPrincipleId()（fail-open 兜底链）
               │     sourcePrincipleId → content.principleId → … → principleDraft.title
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ activations  target_ref = ledger://<title>   activation_id = act_prompt_<title> │
│ principle_applications  principle_id = <title>                        │
└──────────────────────────────────────────────────────────────────────┘   ← 行为面（11 live / 1243 行）
```

**两个平行群体**（Phase 2 已证，此处补齐机制解释）：
- **治理面**：intake 写入的 122 条 UUID 键账本条目；
- **行为面**：Philosopher 链产出、以 `principleDraft.title` 为身份的 11 条 live 原则。

### 1.3 身份集合不等（补充证据）

`activation identities`(20) 与 `application identities`(19) **重合但不相等**：`985c092e`/`2d23707d`（两个 UUID）只在其中一边出现；application 独有 `T-06 最简单干预`、`先以可观察证据验证系统状态` 等更早期身份。⇒ 断裂不止一处：**连行为面内部也在漂移**。

### 1.4 关键可行性证明（决定设计空间）

对 11 个 live activation 逐个做链路回溯（探针 `lineage.cjs`，BFS 走 `pi_metadata.dependencyTaskIds/sourceTaskId`，深度≤8）：

```
reached a candidate via task lineage: 11/11（ hops=3，确定性的 scribe←philosopher←dreamer←diag_router ）
```

且 artifact 的 `sourceTrace` **内部自带** `dreamerArtifactId`/`philosopherArtifactId`（11/11），而 `pi-art-dreamer-<candidateId>-…` 的 artifact id 本身就内嵌 candidateId。

⇒ **reconciliation 所需的全部边都已存在于数据中，只是没有被组织成"身份"。**

---

## 2. Problem Analysis — 为什么 join 不上（分类 A/B/C/D）

| # | 现象 | 归类 | 依据 |
|---|---|---|---|
| **F1** | `extractPrincipleId()` 兜底到 `principleDraft.title`，使**内容片段变成持久身份** | **B 设计缺陷**（主因） | `activation/low-risk-writers.ts:12-26` 是显式的多级 fallback；`principleDraft.title` 是 Philosopher 生成的**自然语言标题**，天然不稳定（改一个字就是新身份）。与 PR1 修掉的 `resolveRecommendationKind()` fail-open **同构**：边界处"用内容冒充身份/类型"。 |
| **F2** | `pi_artifacts.source_principle_id` 应承载身份却**从未被写**（0/921 指向账本 id；11 个 live artifact 中 **0/11**） | **C 数据迁移缺失** | 字段存在、消费方存在（`canActivate` 还会校验它），生产链路上游（scribe）却从不盖章。 |
| **F3** | 两个 artifact 空间（`artifacts` vs `pi_artifacts`）语义不同但都叫 artifact，`activations.artifact_id` 只指后者 | **B 设计缺陷**（命名/契约层） | 导致"activation 关联哪条原则"必须先分辨 artifact 空间——Phase 2 审计初版就因此得出错误的 `withActivation=0`。 |
| **F4** | 账本条目（intake）与链路产物（dreamer→philosopher）是**两条平行生产线**，产物从不回写账本 id | **A 历史演进 + C** | `_tree` 混合形态（ADR-0017）与 runtime-v2 链路是两个时代的产物；chain 侧从未实现"回指账本"这一步。 |
| **F5** | application 中存在比现役 activation 更早的身份（`T-06 最简单干预`） | **A 历史演进** | 前训练状态时代的文本键身份残留（Phase 2 §2）。 |
| **F6** | 账本条目存在但未被激活（113 candidate） | **D 正常生命周期** | "已记录未激活"本身合法。**但**因此导致的"账本有、行为面无"**不是**本次身份断裂的原因——断裂在 F1/F2。 |

**一句话**：**不是缺一条 join key，而是身份在铸造点被"降级成了内容"，且本应承载身份的字段从未被生产链盖章。**

---

## 3. Options（至少三案）

### Option A — Ledger 是 Canonical Identity

原则的唯一身份 = intake 时账本条目的 UUID。artifact/activation/application 全部携带它。

- 语义：`Pain → Understanding → Principle` 的"原则诞生点"是 **intake 写账本那一刻**。
- 现状差距：链路产物今天不携带它（F2），需要 scribe 链盖章 + activation fail-closed。

### Option B — Artifact 是 Canonical Identity

原则的身份 = Philosopher/Scribe 产物（`principleDraft`）的 id；账本降级为"治理投影"。

- 语义：原则诞生在"被理解成型"的那一刻（Philosopher draft），注入面消费的就是它。
- 现状差距：账本是 Owner 审批/生命周期/审计的 SSOT（ADR-0017），降级它等于重写治理面。

### Option C — 引入 Principle Entity（独立身份 + 多记录）

新增一等实体 `Principle(id)`，作为聚合根；LedgerRecords / Artifacts / Activations / Applications 都是它的从属记录。

- 语义：身份与任何单一存储解耦，"一条原则"是跨表的概念。
- 现状差距：需要新 SSOT + 新写路径 + 全消费者改造（P4 风险）。

### Option A′（推荐，详见 §5）— Ledger Canonical + Lineage Stamping + Fail-closed Activation

即：**A 的权威 + C 的机制**。身份仍是账本 UUID，但它的"携带"由链路强制（scribe 盖章 `source_principle_id`，activation 拒绝无身份产物），并用既有任务链做存量 reconciliation。

---

## 4. Evaluate Options（trade-off，不评分）

| Dimension | A：Ledger Canonical | B：Artifact Canonical | C：独立 Principle Entity | **A′：A + 盖章 + fail-closed** |
|---|---|---|---|---|
| **历史兼容** | 最好：账本 122 条已是 UUID 键，`source_principle_id` 字段现成 | 差：需要把账本降格为投影，122 条 UUID 身份要重解释 | 差：新实体意味着全部现存 id 都变成"引用" | 好：与 A 相同，且存量可用任务链回填，无 schema 变更 |
| **实现复杂度** | 低-中：改 scribe 盖章 + `extractPrincipleId` 收紧 + 一次回填 | 高：治理面重写（promote/disable/archive/rollback、Console 三模型、44 处 `loadLedger` 消费者） | **最高**：新 SSOT + 双写 + 全消费方迁移 | 中：比 A 多一个"回填桥"，但都是读侧推导 + 一次盖章 |
| **未来 Selector** | 好：Selector 直接按账本 UUID 选，注入面天然可 join（消除 Phase 2 的 F1 断裂） | 中：Selector 面向 artifact，但 Owner 治理面要反查账本，两套语义 | 好：实体中立 | 好：与 A 相同 |
| **Owner Governance** | **最好**：审批/激活/生命周期本来就以账本为准（P4 单一真相） | 弱：Owner 审批对象与消费对象错位 | 中：治理面要迁到新实体 | **最好**：与 A 相同 |
| **Rollback** | 好：盖章是加性字段；回滚=停盖章+清字段 | 差：治理面重构几乎不可逆 | **差**：引入新 SSOT 后撤回 = 双迁移 | 好：与 A 相同，且每阶段独立可退 |
| **Auditability** | 好：candidate→ledger→artifact→activation 单链可重放 | 中：账本成投影后，"这条原则从哪个 Pain 来"要跨两次投影 | 最好（理想情况下） | **好**：单链重放 + 既有 `sourceTrace` 互证（本次 11/11 实测） |
| **AI Evolution**（Resolver/复利） | 好：同质可比集合 + 稳定 id，`supersedesPrincipleId` 有落点 | 中：进化操作要落两个面 | 最好（理论上） | 好：与 A 相同，且 Phase 2 的 27 条高价值休眠原则可被 Selector 真正消费 |
| **PD 宪法契合** | P4 ✓ / P3 ✓ / P7 ✓（不新增 SSOT） | 与 P4 冲突（账本降格=第二真相反转） | P7 风险（0 实现的 speculative 实体） | P4 ✓ / P3 ✓ / P8 ✓（下一次变更变局部） |

---

## 5. Recommended Architecture — Target Identity Model

**裁决：Option A′。一条原则 = 账本在 intake 时刻铸造的 UUID；这个 UUID 必须被生产链"前向盖章"，并在 activation 边界 fail-closed 校验。**

### 5.1 定义（回答核心问题）

> **"一条原则"= Ledger 中的一条 `Principle` 记录（UUID 身份）。**
> Candidate 是它的**出生证明**（`derivedFromPainIds[0]`），Artifact 是它的**理解与成型记录**（`source_principle_id` 回指），Activation/Application 是它的**行为履历**（`target_ref`/`principle_id` 回指）。
> **任何以"标题/文本"充当身份的写入都是缺陷**（与本 PR1 之前的 "unknown→principle" 同类）。

### 5.2 与 PD 核心回路的对齐

```
Pain ──────────────► Understanding ─────────► Principle ────► Behavior Change ────► Feedback
(pain, evidence)      (candidate, diag/artifact)  (Ledger UUID ← intake 铸造)   (activation, application)   (principle_applications)
                            │                          │  ▲                            │
                            └── lineage spine ─────────┘  └──── 回指（source_principle_id / target_ref）┘
```

- 身份在 **Understanding→Principle** 的转换点铸造（intake），此前只有 candidate（还不是原则）；
- **Behavior Change**（activation）必须持有一个已铸造的身份——没有就拒绝；
- **Feedback**（application）引用同一身份，效果才能归因（Phase 2 发现 effect 行 93 条 `activation_id IS NULL` 不可归因，根因同源）。

### 5.3 三条不变量（Target Model 的硬约束）

1. **I1 身份只在账本铸造**：`principleId` 唯一合法来源是 `_tree.principles` 的键。
2. **I2 链路前向盖章**：dreamer/philosopher/scribe 产物必须携带 `source_principle_id`（字段已在，写入缺失——见 §6 Phase 1）。
3. **I3 activation 边界 fail-closed**：`extractPrincipleId()` 的 title 兜底**删除**；产物无已验证身份 ⇒ `canActivate` 返回 `no_principle_id_in_artifact`（该 reason 已存在！），**绝不以标题充当身份**。这是 PR1 `isPrincipleLedgerEligibleKind` 在 activation 边界的对称物。

---

## 6. Migration Strategy（仅设计，不执行）

> 原则：每阶段独立可回退；存量修复全部是**读侧推导**（lineage 已存在，无需人肉判断）；行数级影响先影子后切换。

| Phase | 内容 | 回退 |
|---|---|---|
| **Phase 0 — Snapshot** | 冻结五面快照（ledger + candidates + pi_artifacts + activations + principle_applications）+ sha256；产出 `identity-reconciliation-report`：对 20 个 activation / 19 个 application 身份逐个给出 lineage 推导结果（本次 11/11 已验证可行） | 只读 |
| **Phase 1 — Bridge（回填）** | 用任务链回溯（本报告 §1.4 的确定性 3 跳算法）为每个 pi_artifact 推导 `source_principle_id` 并**盖章**；推导失败的显式记为 `unresolved`（禁止猜）。同时修复 scribe 写路径，使**新**产物天然携带（F2 的止血） | 盖章是加性字段写；恢复快照即回滚 |
| **Phase 2 — Dual Read** | 消费方（Selector / pruning / lifecycle / Console / telemetry）同时接受 `id` 与"经 lineage 解析的身份"；application 归因改用解析后的 UUID（effect 行 `activation_id IS NULL` 的不可归因问题在此收口）；影子期比对双读一致性 | 双读无行为变更，停用即可 |
| **Phase 3 — Cutover** | `extractPrincipleId()` 删除 title 兜底 → **fail-closed**（I3）；`target_ref`/`principle_id` 只允许 UUID；旧文本身份在审计面保留为 `legacyIdentity` 别名（不删） | 函数 revert；别名保留故历史可读 |

**与 Phase 2 的衔接**：Phase 1 的 lineage 回溯同时就是 Phase 2 里 46 条 `review_required` 的"使用证据恢复器"——回填后，27 条高价值休眠原则是否真被使用，将第一次变得**可判定**。

---

## 7. Open Decisions（Owner 裁决项）

| # | 决策 | 影响 | 建议 |
|---|---|---|---|
| **OD1** | 采纳 A′（Ledger Canonical）还是 C（独立 Principle Entity） | 全部后续工程的地基 | 建议 A′：P4/P3/P7 全满足，且不需要新 SSOT |
| **OD2** | Phase 2 的 3 条"污染但 active"条目在 A′ 下的去向 | 是否阻塞 cutover | 建议：先按 `principle-purification` 类型边界迁到 Rule/Prompt 面（或仅打标），**不得**借机停用 activation |
| **OD3** | application 中 4 个"从activation 消失"的旧身份（如 `T-06 最简单干预`）如何处置 | 审计完整性 | 建议保留为 `legacyIdentity`，不参与 Selector |
| **OD4** | Phase 1 回填的失败阈值（多少条 `unresolved` 算不可接受） | cutover 放行门禁 | 建议：live activation 的 unresolved 必须为 0（本次实测 11/11 可解，预期为 0） |
| **OD5** | 是否把"`extractPrincipleId` 收紧"独立成一个 PR（先于 selector/injection 改动） | 变更面大小 | 建议独立：它是 PR1 同构的边界修复，可单独验收 |

---

## 8. 纪律声明

```
SCHEMA_MODIFIED        = NO
MIGRATION_EXECUTED     = NO
SELECTOR_MODIFIED      = NO
INJECTION_MODIFIED     = NO
ACTIVATION_MODIFIED    = NO
PRODUCTION_DATA_TOUCHED= NO   (state.db 仅字节副本)
CODE_MODIFIED          = NO
FILES_WRITTEN          = 本文档（docs/architecture/，未跟踪）
```

## 附录 — 证据清单

| 断言 | 证据 |
|---|---|
| 11/11 live activation 3 跳达 candidate | `D:/pd-probe-baseline/lineage.cjs` 输出 |
| `extractPrincipleId` fail-open 兜底链 | `packages/principles-core/src/runtime-v2/activation/low-risk-writers.ts:7-31`；`targetRef=ledger://${principleId}` 见 `:56` |
| live artifact `source_principle_id` 0/11、`sourceTrace` 11/11、`principleDraft.title` 11/11 | `identity-final.cjs` |
| 0/921 `pi_artifacts.source_principle_id` 指向账本 id；42/921 引用账本文本 | `linkage5.cjs` |
| activation/application 身份集合不等 | `identity-final.cjs`（activations 独有 5、applications 独有 4） |
| 账本 122 条仅 2 条有运行时足迹 | Phase 2 报告 §2 + `linkage4.cjs` |
| 注入路径不读账本 | `packages/host-runtime/src/active-principle-prompt.ts:76-82` |
