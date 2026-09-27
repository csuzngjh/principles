# Principle Baseline Qualification — Phase 2 Audit（只读）

> **状态**：已完成，等待 Owner Review。**未修改任何生产数据。**
> **上游**：PR **#1851**（Principle Ledger Write Boundary / Phase 1，已合并 `f6e30b1b`）
> **姊妹交付**：`docs/audit/principle-baseline-proposal.json`（逐条 122 条的分类建议清单）
> **约束声明**：本任务全程只读。Ledger / candidate / artifact / activation / principle_applications **零写入、零删除、零归档、零 activation 变更**；`cleanup-principle-baseline.mjs` 未被执行（连 `--dry-run` 都未再跑，直接用只读探针）。
> **探针资产**：`D:/pd-probe-baseline/`（`audit-final.cjs` / `linkage2-6.cjs` / `records-final.json` / `snapshot-final.json`）；数据源为 `state.db` 的**字节副本**（副本上 `PRAGMA integrity_check = ok`），生产库从未被打开。

---

## 0. 一页结论

| 问题 | 答案 |
|---|---|
| **Q1 哪些应继续作为 Active Principle Baseline？** | **6 条**（全部 `status=active`、类型为 principle、经 Owner 激活）。**但必须先读 §2 的关键发现**：这 6 条并不是当前 Agent 实际注入的那批原则——今天的"事实 Active Baseline"是 `activations + pi_artifacts`（11 个 live activation），与 ledger 是**两套不相交的身份空间**。 |
| **Q2 哪些应退出主动 Principle 消费？** | **70 条**可确定性建议退出（类型证据：源候选 `recommendation_kind ∈ {rule, prompt, implementation}`，且无任何生命周期/使用信号）。另有 **46 条必须 Owner 判断**：43 条 principle 型休眠条目 + **3 条"类型污染但已被 Owner 激活"的高危项**。 |
| **Q3 如何保证不丢证据 / 不破坏 activation / 可恢复？** | 见 §7。三点成立的前提都已实测：① 不删数据，只加**读取侧**标记；② **prompt 注入路径不读 ledger**（`active-principle-prompt.ts:76-82` 走 activation+pi_artifact，已核实源码），因此 `baselineExcluded` 不可能停掉任何注入；③ 标记是**加性可空字段**，回滚 = 移除字段 + 恢复快照。 |

**分类结果**：`keep 6 / review_required 46 / exclude_candidate 70`（合计 122，与快照逐条对账）。

---

## 1. Current Baseline Snapshot（Step 1）

数据源：`D:/.openclaw/workspace/.state/principle_training_state.json`
（sha256 `1af3e926…c9ace`，`lastUpdated 2026-09-22T16:04:09.594Z`——**PR #1851 合并后账本未再变化**，本审计即基于该冻结面）
+ `D:/.openclaw/workspace/.pd/state.db` 副本（15,417,344 B，`integrity_check = ok`）。

| Metric | Value |
|---|---|
| Total Ledger Entries（`_tree.principles`） | **122** |
| `recommendation_kind` 分布（经 `derivedFromPainIds[0]` 反查候选，orphan = **0**） | principle **49**（40.2%）· rule **40**（32.8%）· prompt **17**（13.9%）· implementation **16**（13.1%） |
| active entries（ledger `status=active`） | **9** |
| excluded candidates（本轮建议 `exclude_candidate`） | **70** |
| linked activation（`activations.target_ref = ledger://<id>` 精确命中） | **1** 条账本条目（已停用）；live activation 全局 11 个，**无一**指向这 122 条 |
| linked artifacts | 候选的 `artifact_id` → `artifacts` 表：**122/122 存在**；`pi_artifacts`（内化链产物）引用任一账本条目文本：**93/122**；`pi_artifacts` 引用任一账本 **id**：**0/921** |
| recent usage（`principle_applications`） | 近 7 天 **772** / 近 14 天 **1087** / 近 30 天 **1243**（= 全部）；presence **1150** / effect **93**；最后一条 `2026-09-23T01:19` |
| 可归因到这 122 条的使用 | **仅 1 条**（`2d23707d`，1 条 application）；按任何链接方式（id / activation / 精确文本 / 归一化包含）有运行时足迹的条目共 **2/122** |
| approvals | 42（approved 10 / rejected 2 / pending 30）；其 `artifact_id` 全部落在 `pi_artifacts` 空间（42/42），经 `source_principle_id` 可归因到账本的仅 **5** |

> 账本 `createdAt` 范围 `2026-09-01 → 2026-09-22`；candidate 138 条（含 16 条未入账本）。

---

## 2. ⚠️ 关键发现（F1）：账本与运行时消费面是两套不相交的身份空间

这是本审计最重要的产出，它**改变了 Step 3C 的方法学**，也改变了 Q1 的含义。

**证据链（全部只读实测，探针 `linkage2..6.cjs`）**：

1. `activations.target_ref` 的形态是 `ledger://<identity>`（20 条中 19 条），但该 identity **只有 1 个**是 `_tree.principles` 的键。11 个 live activation 的 target 全部形如
   `ledger://意图缺口即风险信号：方向性产出前先澄清并以小样验证` ——**即原则文本本身**，而非 UUID。
2. `principle_applications.principle_id` 共 19 个 distinct 值：**1 个**命中 `_tree` 键，**18 个**悬空；既不匹配账本 id，也不匹配账本**文本**（精确 / 前 40 字 / 归一化包含均 0）。
3. 这 22 个运行时身份同样不匹配 `principle_candidates` 的任何文本字段（`abstracted_principle` / `description` / `title`，**0/22**）。
4. 对应的 `pi_artifacts`（11 个 live activation 背后）是 **Philosopher 链产物**（`principleDraft` / `intentContract` / `sourcePhilosopherArtifactId`），不是 intake 写入的账本条目；全库 **0/921** 个 `pi_artifacts` 引用任何 `_tree` id。
5. 反向验证：122 条账本条目中，能通过**任何**方式（精确 id / activation target / 文本包含）找到运行时足迹的只有 **2 条**（`2d23707d`、`985c092e`，均为 2026-09-15 的"基线锚定"对，`status=active`）。

**结论**：当前 Agent 真正注入的原则（11 个 live activation、1243 条 application、678 次的 `Model-Evidence-Reversibility-Verification Loop`）来自 **Philosopher→Scribe→activation 链**，其身份是"原则草案文本"；而 `_tree.principles` 这 122 条是 **Diagnostician→intake 管线**写下的另一套记录，**几乎不被注入面消费**。

**对本任务的直接影响**：

- **Step 3C（Usage Evidence）对这 122 条基本不可用**。"没有使用记录"不等于"没有价值"——它首先是身份空间断裂的结果。因此本轮**拒绝**把"无使用"用作排除依据（这正是 §5 False Negative 风险的来源）。
- **它反而强化了 Q3 的安全性**：既然注入不读账本，对账本条目做 `baselineExcluded` **不可能改变任何 Agent 行为**——这正是 SPEC v2.1 §8 要求的"不影响 activation"。
- **它暴露了一个必须由 Owner 先裁决的定义问题（D1）**：「Active Principle Baseline」到底指
  (a) ledger 的 `status=active` 子集（治理面），还是
  (b) 实际注入的 activation+artifact 集合（行为面）？
  今天 (a) 有 9 条、(b) 有 11 条，且**交集≈0**。不先回答这个问题，"建立原则资产目录"就会在错误的对象上建立。

---

## 3. Classification Matrix（Step 2）

每条账本条目建立 `Principle Qualification Record`（完整 122 条见 `principle-baseline-proposal.json`），字段与任务书一致，并补充了审计所需的可复核字段：

```yaml
id:                    # _tree.principles 键（UUID）
text:                  # 账本条目正文
sourceCandidateId:     # derivedFromPainIds[0]（122/122 可反查，orphan=0）
rawRecommendationKind: # principle_candidates.recommendation_kind 原始列值（未归一化）
artifactExists:        # 候选 artifact_id 是否仍存在于 artifacts 表
activationExists:      # 是否有 target_ref=ledger://<id> 的 activation（含 live 子标记）
lastUsed:              # 可归因 application 的最后时间（多为 null，见 §2）
painCount:             # derivedFromPainIds.length
applicationCount:      # 可归因 application 数 / effectCount
ownerApproved:         # 经 pi_artifacts.source_principle_id 可归因的 approved 审批
ledgerStatus:          # candidate | active
candidateDiscriminator:# abstracted_principle / trigger_pattern / action（类型交叉校验）
priorAuditCategory:    # 前轮 A/B/C 审计的归类（交叉证据）
semantic:              # domainBoundCode / toolWorkaround / transferableForm
classification:        # keep | review_required | exclude_candidate
reason / confidence
```

## 4. Classification Rules（Step 3 — 四类证据，非单一规则）

| # | 证据 | 在本轮的实际权重 |
|---|---|---|
| **A. Type** | `rawRecommendationKind`（原始列值）+ 候选判别字段交叉校验 | **主导**。判定器与 `principle-purification.md` §4.3 一致且经全量验证：`abstracted_principle` 非空 ⟺ principle（54/54 精确）、`trigger_pattern`+`action` 双非空 ⟺ rule（45/45）。本轮再验证：70 条 `exclude_candidate` 中**0 条**携带 `abstracted_principle`，即类型证据与判别器零冲突。 |
| **B. Semantic** | 文本形态启发式（`transferableForm` / `domainBoundCode` / `toolWorkaround`），并交叉引用前轮 A/B/C 审计 | **只用于 review 档的子理由与 FN/FP 风险标注，绝不用作排除的唯一依据**（启发式不具裁决力）。 |
| **C. Usage** | activation（`target_ref` 精确命中）、application（`principle_id` 精确命中） | **因 F1 基本不可用**（仅 2/122 有足迹）。因此"无使用"不产生任何排除结论。 |
| **D. Risk** | ledger `status=active`、live activation、owner approval、application>0 | **一票否决排除**：任何带 Owner 生命周期信号的条目，即使类型污染，也只进 `review_required`，绝不自动排除。 |

**规则（确定性，可重放）**：

```
R1  kind ∈ {rule,prompt,implementation} ∧ 有 Owner 生命周期信号 → review_required  (high)
R2  kind ∈ {rule,prompt,implementation} ∧ 无任何信号             → exclude_candidate (high)
R3  kind 未知                                                   → review_required  (medium)
R4  kind = principle ∧ (status=active ∨ live activation ∨ application ∨ approval) → keep (high)
R5  kind = principle ∧ 其余（休眠）                              → review_required  (low/medium)
```

---

## 5. Proposed Classification（Step 4）

| 档 | 条数 | 构成 |
|---|---|---|
| **Keep** | **6** | 全部 `status=active` 且类型为 principle（`985c092e` / `52a5a168` / `7b5bb4e2` / `bb0a4303` / `cf422443` / `6522447f`）。其中 `985c092e` 另有 owner_approved 证据，`2d23707d`（见下）因类型污染被降档。 |
| **Review Required** | **46** | ① **43 条 principle 型休眠条目**（无任何可归因使用——但见 §2，这是身份空间断裂所致，**不是**价值判断）；② **3 条高危项**：类型污染但 `status=active`（见下）。 |
| **Exclude Candidate** | **70** | 类型确定性污染（rule 40 / prompt 17 / implementation 16 中未带任何生命周期信号者），且 0/70 携带 `abstracted_principle`。 |

### ⚠️ 最高风险子集：3 条"类型污染但已被 Owner 激活"

这三条是整个账本里**唯一同时具备"错误类型"与"真实 Owner 生命周期"**的条目，必须 Owner 亲自裁决（本轮拒绝自动排除）：

| id | kind | 现状 | 文本摘录 |
|---|---|---|---|
| `2d23707d` | **rule** | active + 1 application + owner_approved | "在用户已确认基线版本后，任何继续修改产物的请求应先触发基线固化与对比验收流程。" |
| `6d2f3fe6` | **prompt** | active | "在系统提示中加入变更纪律指令：任何有后果的配置修改前必须先全局搜索引用点…" |
| `643884a7` | **prompt** | active | "在面向 Owner 的汇报提示中增加硬要求：每个事实性结论必须能追溯到命令输出…" |

按 `principle-purification.md` 的类型边界矩阵，它们本应分别落在 Rule 面（`_tree.rules`）与激活面（`activations(channel='prompt')`）。**注意**：即便 Owner 最终接受排除，依 SPEC v2.1 G4 也不得借机停用其 activation。

---

## 6. Boundary Samples — False Positive / False Negative（Step 5）

### False Positive Risk（可能被误伤的真原则）

**2 / 70**。`exclude_candidate` 中形态上完全像可迁移原则、且无任何代码/工具痕迹的只有 2 条（均为 `implementation` 型）：

- `c7a71408`："将 Owner 纠正中给出的小改动汇报格式（改了哪、验证了没、要不要重启）固化为持久、可解析的汇报规则…"
- `e618e858`："将两段式管线代码级串联为单一入口脚本，并把媒体基准图纳入版本追踪…"

两条都带明确"实现/脚本"语义，且候选判别字段与 kind 零冲突 ⇒ 误伤概率低。**结论：类型证据驱动的排除，FP 风险可控。**

### False Negative Risk（可能被留下的噪声）

**27 / 43**。休眠 principle 型条目中，形态上"像可迁移原则"的有 27 条——例如：

- `038d5eb1`："确立一条通用原则：任何诊断或结论必须以可观察、可验证的证据为前提…"（前轮 A 类）
- `f4a93bec`："将'先核查既有资产再执行变更'抽象为通用原则，适用于任何涉及既有系统修改的场景…"
- `5612a49a`："将'先验证机制链路，再断言根因'固化为通用原则…"

**这 27 条恰恰是账本里最有价值的一批**（它们像真正的原则资产），却因为身份空间断裂而**无法证明自己在被使用**。把它们归入 `review_required` 而非 `exclude_candidate`，是本分类最保守也最正确的一步；它们的最终去向取决于 Owner 对 §2-D1 的裁决与后续身份空间的修复，而不是本轮的启发式。

（对照：休眠 principle 型中 0 条呈"域绑定/工具型"形态——即语义启发式没有产生任何支持排除的信号，进一步支持"全部留在 review"。）

### 与前轮 A/B/C 审计的交叉验证

| 前轮归类 | → keep | → review_required | → exclude_candidate |
|---|---|---|---|
| A（29，建议保留） | 4 | 25 | **0** |
| B（40，转 Rule） | 0 | 1 | **39** |
| C（53，归档） | 2 | 20 | **31** |

两轮**零冲突**：前轮 A 类无一条落入本轮排除；前轮 B 类几乎全部落入排除。差异只在 A 类：前轮按**语义价值**判"值得保留"，本轮要求**生命周期证据**才能进 Keep——25 条因此落在 review。这个差异不是矛盾，而是"资产目录"与"在用资产"的差别（见 §2-D1）。

---

## 7. Consumer Impact Audit（Step 6）

生产代码消费面（当前 main + PR #1851 合并后，`loadLedger()` 非 dist/非测试调用点，21 个文件）：

| Consumer | Reads Ledger? | Should respect baseline? | 说明 |
|---|---|---|---|
| **Prompt Injection**（`host-runtime/src/active-principle-prompt.ts:76-82`） | **否** —— 只读 `activations` + `pi_artifacts`（`artifactStore.getArtifactById(activation.artifactId)`） | **无影响** | **`baselineExcluded` 不可能影响注入**。已源码核实 + 数据印证（§2：0/921 artifact 引用账本 id）。这是 Q3"不破坏 activation"的硬保证。 |
| Principle Selector / L2 读取器（`runtime-v2/build-l2-principle-reader.ts`） | 是 | **是** | Dreamer 上下文来源；应过滤 `baselineExcluded`。 |
| Pruning / 生命周期读模型（`runtime-v2/pruning-read-model.ts`） | 是 | **是** | watch/review 信号源；应过滤（但不得把标记当"无效"做淘汰）。 |
| Lifecycle 服务（`openclaw-plugin/.../principle-lifecycle-service.ts`、`filesystem-lifecycle-datasource.ts`） | 是 | **是** | 晋升/弃用流转；`baselineExcluded` 应阻塞自动晋升。 |
| Console 治理面（`PrinciplesConsoleModel` / `ApprovalsGroupedConsoleModel` / `ConsoleLifecycleDatasource`） | 是 | **是（展示过滤）** | Owner 看的"原则列表"应默认只显示未排除项 + 显式的"已排除"分组；**审计分组保留全量**。 |
| Owner 命令面（`promote/disable/archive/rollback-impl.ts`） | 是 | **是** | 对已排除条目，命令应要求显式确认。 |
| **Audit / 取证面**（`runtime-v2/pain-chain-read-model.ts`、`candidate-audit.ts`、`replay-engine.ts`、`reflection-context.ts`） | 是 | **否——必须保留全量** | 历史证据与链路重建不得被 baseline 过滤，否则违反"不丢历史证据"。 |
| 内化消费循环（`host-runtime/src/internalization-consumer-cycle.ts`） | 是 | **是** | 驱动内化链；不应再为已排除条目启动链路。 |
| 遥测（`product-telemetry/milestone-readers.ts`） | 是 | 否 | 只读统计。 |
| 其他（`bootstrap-rules.ts`、`ledger-registrar.ts`、`principle-training-state.ts`、`runtime-adapter-resolver.ts`、`adapter/principle-tree-ledger-adapter.ts`） | 是 | 逐个评审 | 属写入器/适配器/引导逻辑，M4 阶段逐面给出"过滤 or 保留"判定。 |

**`baselineExcluded` 是否会影响 activation？——不会，且必须保持不会。** 依据有二：(1) 注入路径不读 ledger（上表第一行）；(2) SPEC v2.1 §8 明确其语义只作用于 Principle Selector / Lifecycle 分析 / 未来 Resolver 输入。若未来任何消费者试图用该标记停用 activation，即违反 P4/G4，应在 code review 层拒绝。

---

## 8. Migration Proposal（Step 7 — 仅设计，不执行）

**前置决策（Owner 必须先答，且比迁移本身更优先）**：

- **D1**：「Active Principle Baseline」的定义对象——ledger `status=active`（治理面）还是 `activations+pi_artifacts`（行为面）？二者今天交集≈0（§2）。**在 D1 落定前，任何 apply 都为时过早。**
- **D2**：3 条"污染但 active"条目的去向：先迁到 Rule/Prompt 正确面（`_tree.rules` 当前无生产写入面——见 `principle-purification.md` RC-5），还是仅打标？
- **D3**：43 条休眠 principle 型条目是否需要一条"Owner 批量复核"通道（例如 Console 分组审批），而不是逐条裁决。

**若未来 apply，执行序（每步独立可回退）**：

| 步骤 | 内容 | 回退方式 |
|---|---|---|
| **M0 快照** | 复制 ledger → `principle_training_state.legacy-<date>.json` + 导出 candidate 证据面（`candidate_id, recommendation_kind, abstracted_principle, trigger_pattern, action`）+ 双 sha256 留档 | 只读，无需回退 |
| **M1 字段** | `LedgerPrinciple` 增加加性可空 `baselineExcluded?: boolean` + `baselineExcludedReason?: string`。codec 的 `{...value}` 展开天然保留未知字段（`principle-purification.md` §7.4 已验证），**无 schema 迁移** | 删字段即回滚 |
| **M2 报告** | 从本 proposal 生成确定性 apply 计划；**门禁：三类合计 = 122 且与快照逐条 id 对账，`unclassified = 0`** | 不落盘即无副作用 |
| **M3 打标** | 仅写 `baselineExcluded`/`Reason` 两个加性字段；**每批 ≤10 条，逐批校验条目总数仍为 122、既有字段零变化**；必须走 `principle-tree-ledger` 的 SSOT mutator（自带跨进程文件锁 + 原子重命名），**永不手写账本文件** | 从 M0 快照恢复 |
| **M4 消费面收口** | 按 §7 表逐面实施过滤；审计面（pain-chain / replay / candidate-audit）**明确不过滤** | 逐面 revert |

**不变量（apply 的验收判据）**：

1. 条目总数不变（122）；
2. 既有 23 个字段零变化（只有新增两个可空字段）；
3. `activations` / `pi_artifacts` / `principle_applications` / `principle_candidates` **零变化**；
4. 注入行为零变化（可由 apply 前后各抓一次 `active-principle-prompt` 输出比对证明）；
5. 每条被排除条目在 proposal 中有 `reason` + `confidence`，且 70/70 的类型证据可由候选行重放验证。

**明确不做**：删除、归档、`cleanup --apply`、activation 变更、Resolver。

---

## 9. 纪律声明

```
LEDGER_MODIFIED             = NO
CANDIDATE_ROWS_MODIFIED     = NO
ACTIVATION_MODIFIED         = NO
ARTIFACT_MODIFIED           = NO
APPLICATION_ROWS_MODIFIED   = NO
CLEANUP_SCRIPT_APPLIED      = NO   (连 --dry-run 都未执行)
DATA_DELETED                = NO
PRODUCTION_DB_OPENED        = NO   (仅字节副本, 副本上 integrity_check=ok)
RESOLVER_IMPLEMENTED        = NO
NEW_SSOT_INTRODUCED         = NO
FILES_WRITTEN               = 本报告 + proposal.json（均在 docs/audit/，未跟踪）
```

## 附录 A — 证据资产

| 资产 | 位置 |
|---|---|
| 探针脚本 | `D:/pd-probe-baseline/{audit-final,linkage2..6,extract,snapshot2}.cjs` |
| 逐条记录（122） | `D:/pd-probe-baseline/records-final.json` |
| 快照指标 | `D:/pd-probe-baseline/snapshot-final.json` |
| state.db 副本（只读分析用） | `D:/pd-probe-baseline/state.db` |
| 前轮分类（交叉证据） | `D:/pd-probe-evo/final-classification.tsv` |
| 上游文档 | `docs/specs/principle-purification.md` · `docs/audit/principle-evolution-audit.md` · `docs/audit/principle-baseline-reset.md` |

## 附录 B — 本报告与前轮审计的关系

`principle-evolution-audit`（为什么会有 122 条）→ `principle-purification`（类型边界与闸门设计 → **PR #1851 已落地闸门**）→ `principle-baseline-reset`（逐条价值判定与清理机制设计）→ **本报告（Phase 2：资产目录 + 消费面影响 + 迁移设计）**。

本轮新增的、前轮未发现的事实是 **§2 的身份空间断裂**：它把"建立原则资产目录"从一次数据整理，升级为一次**定义裁决（D1）+ 身份空间修复**的前置工程。在这两件事完成之前，`Existing Principle Search → Reuse → Extend → Create` 的"原则复利"闭环缺少可 join 的键——这应是 Phase 2 之后的第一个工程立项。
