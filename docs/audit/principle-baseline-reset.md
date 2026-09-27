# Principle Knowledge Baseline Reset — Reality Audit + Cleanup Plan

> **状态**：Draft for Owner Review
> **类型**：Reality Audit + Cleanup Plan（Phase 0，只读）
> **上游**：`docs/audit/principle-evolution-audit.md` → `docs/specs/principle-purification.md` → 本文
> **日期**：2026-09-23
> **配套工具（设计产物，未执行）**：`scripts/cleanup-principle-baseline.mjs`
> **数据来源（只读）**：`<ws>/.state/principle_training_state.json`（124,868 B，sha256 `1af3e9269a9f00583fa94e4f05b9dd39116263435096f3b52f0a57bac97c9ace`）+ 只读副本 `D:/pd-probe-evo/state.db`
>
> **约束遵守声明**：未修改生产数据 · 未删除任何文件 · 未执行 migration · 未创建 PR · 未创建 Linear 工单 · 未引入 embedding · 未实现 Resolver · 未触碰 `~/.pd`、`~/.openclaw/extensions`、`<ws>/.pd`。
> 工具仅以 `--dry-run`（默认）对生产工作区验证过，**未加 `--apply`**；验证后原账本 mtime 与 sha256 均未变化，且未产生任何 backup/archive 文件。

---

# Executive Summary

## 结论

**122 条 ledger 条目中，真正的 Principle 资产是 29 条（23.8%）。新基线规模 = 33 条（含 4 条因正在注入而暂缓处理的条目）。**

| 分类 | 数量 | 占比 | 动作 |
|---|---|---|---|
| **A — Keep（真 Principle）** | **29** | 23.8% | 进入新基线 |
| **B — Move to Rule** | **40** | 32.8% | 退出原则账本（规则素材已在候选池完整保留） |
| **C — Archive** | **53** | 43.4% | 标记归档，不参与 injection / resolver / lifecycle |
| **D — Delete** | **0** | 0% | **无** |
| 合计 | 122 | 100% | 零删除 |

**新基线：122 → 33（−73%）**；4 条 live 条目完成阶段性停用后 → **29（−76%）**。

## 三个必须提请 Owner 注意的审计发现

### 发现 1（最重要）：**清理是零数据损失的 —— 122/122 可精确重建**

对 122 条逐一验证：其 `text` 是否等于 `principle_candidates` 中对应候选的 `description`。

```
ledger entries reconstructible from candidate.description (EXACT) : 122/122
ledger entries NOT reconstructible                                 : 0/122
ledger entries with no candidate row                               : 0/122
```

⇒ **账本里没有任何「只存在于账本」的信息。** 候选池（`principle_candidates`，含 `title` / `description` / `trigger_pattern` / `action` / `abstracted_principle` / `source_recommendation_json`，138/138 非空）是全部 122 条内容的完整来源。
这从根本上把 cleanup 从「有损操作」降级为「派生视图的重新划界」。

### 发现 2：**账本里没有「测试垃圾」—— D = 0**

任务书预期存在「明显测试数据 / duplicate test data / invalid artifacts」可删。**四类检查全部为空：**

| 检查 | 结果 |
|---|---|
| 文本/动作中的测试痕迹（`测试/调试/test/e2e/smoke/demo/fixture/占位/TODO/TBD`） | **0/122** |
| schema 必需字段缺失 | **0/122** |
| 完全相同的 `text` 重复 | **0 组** |
| 无候选来源（orphan） | **0/122** |
| 非 UUID 形态的 painId | **0/122**（122 个全为合法 UUID） |
| 空文本 / 过短文本（<12 字符） | **0/122** |

**但测试噪声确实存在 —— 它不在账本里，而在遥测面：**

| `principle_applications` 的 session 类别 | 行数 | 占比 |
|---|---|---|
| 正常 UUID 会话 | 804 | 64.7% |
| **`internal-session-effects-skill-workshop-review_*`（内部测试 harness）** | **288** | **23.2%** |
| **`pd-runtime-<uuid>`（runtime 冒烟）** | **25** | **2.0%** |
| **`e2e-glm-fix-check`** | **1** | **0.1%** |
| 其他 | 125 | 10.1% |
| 合计 | 1243 | 100% |

**⇒ 314/1243 = 25.3% 的行为遥测来自测试会话。** 清理的重点应从「账本」转向「遥测归因」。这一点直接否决了「删除账本条目」的方案必要性。

### 发现 3：**4 条被归档候选正在被注入 —— 归档会立即改变运行时行为**

11 条条目当前有 live activation（`activations.deactivated_at IS NULL`）。按分类规则，其中 4 条落入 Archive：

| id | kind | status | 文本 |
|---|---|---|---|
| `56010589` | prompt | candidate | 在系统/会话提示中加入持久化指令：凡是 Owner 明确表达"以后务必/不要忘记"类约定… |
| `df6155a1` | principle | candidate | 将 Owner 明确表达且对连续性重要的约定持久化到瞬时上下文之外… |
| `6d2f3fe6` | prompt | active | 在系统提示中加入变更纪律指令：任何有后果的配置修改前必须先全局搜索引用点… |
| `bb0a4303` | principle | active | 将生成类任务的输出校验与约束护栏作为通用原则落地… |

⇒ 工具**默认不处理**这 4 条（`deferred-live`），必须在 Owner 显式授权（`--include-live`）或先执行阶段性停用后才能归档。**归档一条正在注入的原则 = 静默改变 Agent 行为**，不属于「清理」范畴。

## AC-1 速答（详见 Acceptance Criteria）

**保留 29（+4 暂缓）／转 Rule 40／Archive 53／Delete 0。**

---

# Current Data State

## 1.1 Principle Ledger

**位置**：`<ws>/.state/principle_training_state.json` → `_tree.principles`（SSOT，`principle-tree-ledger.ts:1-14`，PRI-459 跨进程文件锁）

| 维度 | 实测 |
|---|---|
| 总数量 | **122** |
| `status` 分布 | `candidate` **113** / `active` **9** ；无 `probation` / `deprecated` / `archived` |
| 来源 `recommendation_kind` | `principle` 49 / `rule` 40 / `prompt` 17 / `implementation` 16 |
| `createdAt` 范围 | 2026-09-01 → 2026-09-22（22 天） |
| `painId` | 122 条 `derivedFromPainIds`，**共 122 个 distinct 值，长度恒为 1**，全为合法 UUID |
| 字段在位率 | `ruleIds` 0/122 · `conflictsWithPrincipleIds` 0/122 · `supersedesPrincipleId` 0/122 · `lastTriggeredAt` 0/122 · `coreAxiomId` 0/122 · `domain` 0/122 · `abstractedPrinciple` 0/122 |
| `action` 为空 | **78/122** |

**逐日新增**：

| 日期 | 09-01 | 09-03 | 09-04 | 09-05 | 09-09 | 09-13 | 09-14 | 09-15 | 09-17 | 09-18 | 09-19 | 09-20 | 09-21 | 09-22 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 新增 | 7 | 10 | 4 | 6 | 2 | 5 | 2 | 6 | 8 | 2 | 9 | 8 | **25** | **28** |

最后两天 53 条 = 全量 43%，曲线在加速（与 `internalization_full_chain: enabled: true` 生效时间吻合）。

## 1.2 激活与使用状态

| 指标 | 实测 |
|---|---|
| 有任一 activation 行的条目 | **17/122** |
| **当前 live（`deactivated_at IS NULL`）** | **11/122** |
| 有 `prompt_injected` 记录的条目 | 15/122 |
| **有 effect 级记录的条目** | **0/122** |
| `activations` 总量 | 20（18 `prompt` + 2 `code_tool_hook`，code 通道均已停用） |

**effect 级遥测无法归因（关键）**：

```
principle_applications 总行数            = 1243
其中 activation_id IS NULL               = 93
  └ level='effect' ∧ kind='self_reported'  = 92
  └ level='effect' ∧ kind='rule_blocked'   = 1
```

**93 条 effect 记录全部没有 `activation_id`**，因此无法回指任何原则。这就是「有 effect 记录的条目 = 0/122」的真实原因 —— **不是没有效果信号，而是效果信号不可归因**。任何「按效果筛选高价值原则」的方案在当前数据下不可实现。

**注入分布（Top 6，按 `prompt_injected` 行数）**：

| 注入次数 | live | kind | 文本（截断） |
|---|---|---|---|
| 610 | 否 | prompt | Prompt 指令：在系统提示词中明确要求——当任务涉及文件创建或修改时… |
| 56 | 是 | principle | 选择内容素材时以受众语境与 Owner 真实意图为准… |
| 56 | 是 | principle | 交付前应以受众视角验证产出物可被独立理解… |
| 56 | 是 | prompt | 在系统/会话提示中加入持久化指令… |
| 56 | 是 | principle | 将 Owner 明确表达且对连续性重要的约定持久化… |
| 53 | 否 | principle | 主任务未完成前不得推进次要议题… |

**注意**：注入次数最高（610）的条目 root 是 `prompt` 类型 —— 一个 Prompt 指令占据了最多的注入预算。

## 1.3 Candidate Pool

**位置**：`<ws>/.pd/state.db` → `principle_candidates`（138 行）

| `recommendation_kind` | n | `abstracted_principle` | `trigger_pattern` | `action` |
|---|---|---|---|---|
| `principle` | 54 | **54 (100%)** | 0 | 0 |
| `rule` | 45 | 0 | **45 (100%)** | **45 (100%)** |
| `implementation` | 18 | 0 | 0 | 4 |
| `prompt` | 20 | 0 | 1 | 2 |
| `defer` | 1 | 0 | 0 | 0 |
| 合计 | **138** | 54 | 46 | 51 |

**是否进入 ledger**：

| | 数量 |
|---|---|
| 已进入 ledger（`status='consumed'`） | **122**（principle 49 / rule 40 / prompt 17 / implementation 16） |
| **未进入 ledger（`status='pending'`）** | **16**（principle 5 / rule 5 / prompt 3 / implementation 2 / defer 1） |

**未消费原因**：全部 16 条均为 `pending`（从未被 `intake()` 处理），而非被拒绝。其中有 1 条 `defer` 候选自带拒绝理由（原文）：

> `本次证据强度弱（owner_reported无认证host trace，conversationWindow无可用行为证据）…`

⇒ `defer` 候选被 admission gate 正确拦下（`admission-gate.ts:43-50`），这是唯一类型正确的拦截。

**可重建性（0 号安全属性）**：**122/122 条 ledger 条目的 `text` 与其候选 `description` 逐字符相等。** 候选池另含 `source_recommendation_json`（138/138 非空）作为原始建议全文。

## 1.4 Artifacts

**位置**：`<ws>/.pd/state.db` → `pi_artifacts`（921 行）

| `artifact_kind` | 数量 |
|---|---|
| `principle` | **917** |
| `rule` | **4** |
| `skill` / `patch` | 0 / 0 |

按阶段：`diagnostician` 163 · `scribe` 140 · `artificer` 118 · `evaluator` 112 · `dreamer` 108 · `philosopher` 108 · `other` 92 · `rollout_reviewer` 76（全部 `artifact_kind='principle'`）；`rule` 制品 4 条来自 `other`(3) 与 `evaluator`(1)。

**关键事实**：`PI_ARTIFACT_KINDS` 枚举为 `principle | rule | skill | patch`（`peer-runner-contracts.ts:220-225`）—— **枚举中没有 `prompt` / `implementation`**，而内部化链路所有阶段产物统一记为 `principle`。⇒ **artifact 面既无法区分语义类型，也无法承载 prompt/implementation 类建议。** 因此 artifact 面**不能**作为归档目标。

---

# Classification Method

## 3.1 判定顺序（确定性，零 LLM、零人工标注）

```
① 来源类型判据（权威）
   entry.derivedFromPainIds[0] → principle_candidates.recommendation_kind
   （orphan = 0，122/122 可解析；且 122/122 text 与 candidate.description 逐字符一致）

② 语义归属判据
   kind=rule             → B
   kind=prompt / impl    → C
   kind=principle        → 进入 ③

③ principle 型的三重质量过滤
   ③a 域过拟合   → C     域探测器命中 MEDIA 或 PD_INTERNAL
   ③b 自指       → C     指向 PD 自身机制
   ③c 语义重叠   → C     与同簇条目 char-bigram Jaccard ≥ 0.15（连通分量）
   以上皆否       → A

④ 安全闸门（不可跳过）
   planned ∈ {C} 且该条目当前 live 注入 → deferred-live（默认不处理）
```

## 3.2 为什么以 `recommendation_kind` 为权威

字段判别器只能覆盖 71.7%：`abstracted_principle` 非空 ⟺ principle（54/54 精确）、`trigger_pattern`+`action` 双非空 ⟺ rule（45/45 精确）；但 **prompt(20) / implementation(18) / defer(1) 无正字段判别器**，三者字段画像高度相似（prompt: tp 1 / act 2；implementation: tp 0 / act 4）。

⇒ 类型只能以 Diagnostician 的原始 `recommendation_kind` 为准。**这是一个必须显式承认的依赖：纯化正确性受 `recommendation_kind` 自身准确性约束**（上游已知噪声：4/18 implementation 带 action、1/20 prompt 带 rule 字段）。

## 3.3 域过拟合与自指的判据（可审计的启发式）

| 标签 | 含义 | 探测器覆盖的典型特征 |
|---|---|---|
| `MEDIA` | 过度绑定某一媒体生产项目 | 成片/字幕/镜头/对白/音轨/分镜/特效/素材/`hud_gen.py`/`gpt_hud_key.py`/HUD/Episode/镜头切换/主体一致性… |
| `PD_INTERNAL` | 指向 PD 自身机制（自指） | 疼痛报告/会话绑定/跟踪可用性/Gate A|B/毕业验证/hook执行日志/RuleCode/内化/`intentTension`/`source-of-truth`… |

**这两种条目的问题不是「错」，而是「抽象层级不足」**：它们描述的是某个具体项目的工作流或 PD 自己的开发过程，无法迁移到其他场景。按任务书的 Knowledge Compression 原则（`大量经验 → 模式抽象 → 少量高价值原则`），它们应停在 Archive 而非 Principle Baseline。

**注意**：这是**启发式**，不是判别器。工具支持 `--overrides <json>`（`forceKeep` / `forceExclude`）让 Owner 逐条推翻，且每条判定都输出命中标签。

## 3.4 语义重叠聚类

char-bigram Jaccard ≥ 0.15 的连通分量。实测形成多个同语义簇，例如：

```
[既有资产核查]  f4a93bec(principle) · ca35226d(rule) · 0cf0e94a(prompt) · fc0656d2(impl) · 453ef845(rule) · 89ed1bed(principle)
[脚本编码契约]  778f40d9(rule) · be22fffd(rule) · 5292e588(prompt) · 19fe5301(prompt) · ba41069b(impl) · 5a6e5d0b(principle) · e2dea2f8(principle)
[源文件 mtime] 2785f12c(rule) · badd3df5(impl) · a4b7dfc6(impl) · bf34cc40(rule) · 24326b7a(prompt) · 3824d083(principle)
[完成声明]     3858722f(rule) · b504beff(rule) · b224d5c6(rule) · db1372e1(principle) · 231e4fb3(principle)
```

**同簇内的 principle 型条目 → C**（理由：该语义已有其他条目承载，重复保留会稀释基线）。
**注意**：**不用 ≥0.10 阈值** —— 该阈值下会出现 46 条成员的链式大簇（transitive chaining 误伤）。

---

# Keep Candidates

## 4.1 Category A — Keep（29 条）

**判据（全部满足）**：`kind=principle` ∧ 无 `MEDIA`/`PD_INTERNAL` 标签 ∧ 不落入任何语义重叠簇。

| # | id | status | 原则（截断至 66 字） |
|---|---|---|---|
| 1 | `038d5eb1` | candidate | 确立一条通用原则：任何诊断或结论必须以可观察、可验证的证据为前提；当证据缺失时… |
| 2 | `f4a93bec` | candidate | 将'先核查既有资产再执行变更'抽象为通用原则，适用于任何涉及既有系统修改的场景… |
| 3 | `e09e626c` | candidate | 将关键验证步骤抽象为可自动化的规则化检查而非依赖人工判断… |
| 4 | `7ce15486` | candidate | 将'交付的定义必须内含主动验证'确立为跨场景交付类工作流（代码、文档、内容生产等）的原则… |
| 5 | `2c2677c3` | candidate | 确立「校验先于有后果变更、并由机制强制」为通用原则（scope=general）… |
| 6 | `d1629051` | candidate | 贯彻核心原则：人工精修成果与自动化生成管线并存时必须保持同步… |
| 7 | `ada4bf68` | candidate | 将 Owner 已确认的正确输出视为不可回退的基准：先持久化已验收结果… |
| 8 | `9c977511` | candidate | 持续行动必须有可观察状态作为依据：当环境已表明目标达成或无需继续时… |
| 9 | `9269d7b3` | candidate | 交付前应以受众视角验证产出物可被独立理解… |
| 10 | `18ba6e6d` | candidate | 采用蒸馏器产出的抽象原则：任何诊断或干预建议前，必须先以可观察证据确认系统实际状态… |
| 11 | `836e759a` | candidate | 采纳蒸馏所得抽象原则：在关键前提不明确时先核实再作答… |
| 12 | `d03f6c64` | candidate | 面对模糊指令（如"精简"、"优化"、"改进"），先确认意图边界或选择最保守的解读… |
| 13 | `af687faf` | candidate | 任何涉及已有约束性资产（参考图、模板、规范）的生成任务，必须先核实资产已加载为输入… |
| 14 | `b0a6c433` | candidate | 采纳普适性原则：在有后果的动作前后以可观察证据核对对象与结果，而非依赖推断。 |
| 15 | `561e78d5` | candidate | 将 Owner 声明的不可协商约束编码为可校验护栏，并在交付前对照验证实际产出… |
| 16 | `391b20e3` | candidate | 将"证据归因、最小验证、必要才升级复杂度、状态与最新决策同步"作为默认失败处理原则… |
| 17 | `c305b5b2` | candidate | 将"举证缺席时，显式声明未查验优于用推断填补空缺"沉淀为通用输出原则… |
| 18 | `c2e844d4` | candidate | 确立原则：汇报详尽程度必须与变更规模和风险成比例… |
| 19 | `c2ea1dce` | candidate | 将 Owner 的交付形态偏好（成品交付优先于代码构建）作为持久化原则沉淀… |
| 20 | `37f819a6` | candidate | 建立通用原则：写入可验证的外部事实前，先以可观察证据核实来源… |
| 21 | `ef83f362` | candidate | 采用"使用输入资源前先核实其是否为最新权威版本，并将纠正反馈转化为例行核对习惯"的原则。 |
| 22 | `0969cc05` | candidate | 确立『面向接收者传达』原则：结论与解释应以对方的理解水平和真实意图为基准来组织… |
| 23 | `99b60115` | candidate | 将'使用多版本产物前核实最新状态'作为通用原则采纳… |
| 24 | `52a5a168` | **active** | 确立跨场景复用原则：基于既有资产产出成果前，必须先以可核验的单一事实来源确认资产的当前状态… |
| 25 | `7b5bb4e2` | **active** | 将「关键流程知识与验收纪律必须固化为可独立执行的持久化护栏」确立为通用原则… |
| 26 | `cf422443` | **active** | 确立通用原则：完成的标准是实际结果符合预期，而非动作已执行… |
| 27 | `6522447f` | **active** | 将状态持久化与时效性校验作为固有工作流程：上下文可能过期时，先以当前可观察世界状态为准… |
| 28 | `89ed1bed` | candidate | 将抽象原则固化为通用行为指引：在执行有后果的创作类任务前，先加载并遵循已定稿权威素材（大纲/项目进展）与 Owner 既定意图…（**边界样本**：含「创作类/大纲」域词汇但语义通用，建议 Owner 复核） |
| 29 | `a2ac2b93` | candidate | 选择内容素材时以受众语境与 Owner 真实意图为准，而非默认采用自身知识圈内最易得的例子…（**边界样本**：域探测器未命中但含「素材」，建议 Owner 复核） |

> **第 28/29 条是分类器与人工判断最可能分歧的边界样本**，工具支持 `--overrides {"forceKeep":[…],"forceExclude":[…]}` 逐条推翻，并在 dry-run 中列出每条命中的标签与理由。
> 完整 29 条（含 id 排序与判定理由）见 `D:/pd-probe-evo/final-classification.tsv`，`category=A` 的 29 行。

## 4.2 Keep 的质量画像（诚实评估）

**必须说明**：29 条中**没有一条**具备完整的可用证据：

| 支撑 | 实测 |
|---|---|
| 有 effect 级效果证据 | **0/29**（全域 0/122，因 effect 不可归因） |
| 有 Owner 显式认可（approvals `approved`） | 未逐条建立（`approvals` 40 条中 10 approved，与 ledger 无稳定外键） |
| 有 `abstractedPrinciple` / `coreAxiomId` / `domain` | **0/29** |
| 有 live 注入（说明被实际选用） | 7/29 |
| 有清晰 pain 来源 | **29/29**（`derivedFromPainIds` 长度恒 1） |

⇒ **29 条目前是「语义合格但效果未验证」的集合。** 这不影响它们作为 Baseline 的价值 —— 但必须明确：**Baseline 的成立依据是语义同质性，不是效果证明。** 效果验证仍依赖 `principle_applications` 归因修复（见 Risks R6）。

---

# Rule Candidates

## 5.1 Category B — Move to Rule（40 条）

**判据**：`recommendation_kind='rule'`。**40/40 携带完整的 `triggerPattern` + `action`**（机械可判定），符合 `internalization-route.ts:98-118` 的 rule readiness 契约。

## 5.2 关键澄清：「Move to Rule Registry」在当前架构下意味着什么

任务书设想 `Principle Ledger → Rule Registry`。**实测：没有可用的 Rule Registry 写入面。**

| 检查 | 结果 |
|---|---|
| `_tree.rules` | **0 条** |
| `tree.rules` 的唯一写入者 | `openclaw-plugin/src/core/principle-compiler/ledger-registrar.ts:78`（`createRule`） |
| 该写入者的消费链 | `principle-compiler/index.ts` ← `evolution-reducer.ts:25` |
| 该链路是否启用 | **否** —— `evolution_worker: enabled: false`（`config.yaml:42-44`） |
| `pi_artifacts` kind=`rule` | **4 条**（枚举支持，但几乎无产出） |

⇒ **「移入 Rule Registry」今天无法执行**（目标面缺位，与 `docs/specs/principle-purification.md` §8.2 Option A 的结论一致）。

**但这不是问题，因为规则素材已经完整存在于候选池**：40 条 rule 候选在 `principle_candidates` 中均具备 `trigger_pattern` + `action` + `title` + `description` + `source_recommendation_json`。

⇒ **B 的正确动作不是「移动到新库」，而是「移出原则账本」** —— 规则素材的权威副本本就在候选池，账本里的 40 条是**冗余副本**。零数据损失。

## 5.3 B 的内部切分（供 Owner 决定 Rule Registry 优先级的依据）

| 子类 | 数量 | 说明 | 示例 |
|---|---|---|---|
| **B1 — 通用可迁移规则** | **18** | 与具体项目无关，抽象层级足以跨场景复用 | `7e1c2798`（重启建议前先验服务状态）· `b504beff`（完成声明前须给产物证据）· `b224d5c6`（报告输出前拦截高确定性结论）· `cd1942a0`（数值/方向变更前先复述）· `81bea94d`（归档/提交前验证拦截）· `6fcd64c3`（失败/pivot 前最小验证门） |
| **B2 — 域绑定规则** | **22** | 绑定媒体生产或 PD 开发过程 | `6fbc11b8`（`hud_gen.py → gpt_hud_key.py` 重跑）· `9bcf7cd4`（镜头切换时长校验）· `60b67b94`（角色-台词映射）· `de39f8ed`（CLIP 角色约束）· `91bbb023`（跟踪可用性门控）· `8b1ae362`（Gate 毕业验证）· `9f0a1834`（诊断机制链路验证门控） |

**建议**：Rule Registry 若立项，应优先承接 **B1 的 18 条**；B2 的 22 条与 C 类同属「域绑定的项目资产」，优先级应低于 B1。

---

# Archive Candidates

## 6.1 Category C — Archive（53 条）

| 子类 | 数量 | 判据 |
|---|---|---|
| **C1 — prompt 型** | **17** | `kind=prompt`：指令注入，不是行为认知。**其中 2 条当前 live 注入** |
| **C2 — implementation 型** | **16** | `kind=implementation`：工程实现建议。**16/16 从未产生任何 artifact** —— 它们根本没走链路 |
| **C3 — principle 型 · 域过拟合** | **7** | `kind=principle` ∧ (`MEDIA` ∨ `PD_INTERNAL`)（含 1 条同时语义重叠） |
| **C4 — principle 型 · 语义重叠** | **14** | `kind=principle` ∧ 落入 bigram Jaccard ≥ 0.15 连通簇（含 1 条同时域过拟合） |
| 合计 | **53** | C3 + C4 = 7 + 14 − 1（重叠）= 20 条 principle 型；20 + 17 + 16 = 53 ✓ |

其中 **4 条为 live（C\*）**：`56010589`(prompt) · `6d2f3fe6`(prompt) · `df6155a1`(principle) · `bb0a4303`(principle)。
⇒ **可立即标记 = 53 − 4 = 49 条**；4 条需先做阶段性停用。

C3 的典型样本（**这些不是「垃圾」，而是「这个项目的知识」**）：

```
7b949728  通用原则：在任何多元素时序编排（镜头、字幕、音频、动画等）中，输出前必须对关键要素的时序与覆盖关系做一致性校验…
58334305  采纳泛化原则：生成含多属性内容（如角色-台词、字段-来源）时，先持久化元素与关键约束的映射…
26a37266  凡执行有损或有后果的转换（如媒体处理、合成、导出），完成后必须以可观察证据核对关键内容是否完好…
3f7fb0c7  将"创意空白处不自行决策"确立为核心原则：凡属主观/审美性强的关键决策（特效、台词用词、结尾构图）…
```

C4 的典型样本（**注意：同语义冗余簇是跨类型的**；下表列出簇的全部成员，其中只有 `principle` 型成员会实际落入 C4，其余成员分别落入 B/C1/C2）：

```
5612a49a(principle→C4) 0ef41732(prompt→C1) 9f0a1834(rule→B)   → 「机制链路验证」三写
3824d083(principle→C4) 2785f12c(rule→B) badd3df5(impl→C2) a4b7dfc6(impl→C2)  → 「源文件 mtime+哈希为准」四写
87b83680 / 7f336b7c     → 「主任务优先」两写（principle + rule）
2e42ef1b / cd1942a0     → 「先复述确认」两写（principle + rule）
985c092e / 2d23707d / b3dd8099 / ada4bf68 → 「基线锚定」四写（2 principle + 2 rule，其中 2 条 active）
```

> 这个跨类型冗余现象本身是「类型污染」的副产品：同一个语义被 Diagnostician 以不同 `recommendation_kind` 重复提出，而账本把它们当作 4 条独立条目照单全收。

## 6.2 归档的语义（必须精确）

**Archive ≠ 删除，Archive = 标记 + 退出消费面。**

| 维度 | Archive 后的状态 |
|---|---|
| 数据 | **原位保留**在 `_tree.principles`，字段完整 |
| 注入（injection） | **排除** |
| Resolver（未来） | **排除** |
| Lifecycle（prune / deprecated-readiness） | **排除** |
| Console 原则列表 | 默认隐藏（可按标记展开） |
| 可恢复性 | 单字段回退（`baselineExcluded: false`）或从 backup 整体恢复 |

**为什么不能「物理移出到一个归档命名空间」**：
`ledger-codec.ts:142-151` 的 `parseTree()` **只重建 5 个已知键**（`principles` / `rules` / `implementations` / `metrics` / `lastUpdated`）。任何新增的 `_tree` 子键会在下一次「读-改-写」时被**静默丢弃**。
⇒ 归档只能通过**条目级标记**实现；归档导出必须落**独立文件**（工具的 `principle-baseline-archive-<ts>.json`），且该文件是**恢复工件**，不是第二真相。

---

# Delete Candidates

## 7.1 Category D — Delete：**0 条**

**逐项检查结果：**

| 检查项 | 命中 | 说明 |
|---|---|---|
| 测试/调试痕迹（文本或动作） | **0** | `测试|调试|test|e2e|smoke|demo|fixture|placeholder|占位|TODO|TBD` 全无命中 |
| schema 必需字段缺失 | **0** | `id/version/text/status/evaluability/priority/scope/createdAt` 全在位 |
| 空文本 /  <12 字符 | **0** | 全部为完整中文陈述句 |
| 完全相同的 `text` | **0 组** | 无逐字重复 |
| orphan（无候选来源） | **0** | 122/122 可解析 |
| 非 UUID painId | **0** | 全为合法 UUID |
| 来源候选缺失 | **0** | — |

## 7.2 为什么 D 为空 —— 以及这意味着什么

**任务书假设「存在大量非 principle 类型 + 部分来自测试/调试/管道修复阶段的数据」。审计结果部分证实、部分证伪：**

| 假设 | 结论 |
|---|---|
| 「大量非 principle 类型」 | ✅ **证实**：73/122 = 59.8% |
| 「部分来自测试、调试、管道修复阶段」 | ❌ **在账本中不成立**：0 条测试痕迹 |

**测试噪声的真实位置是遥测面**（`principle_applications` 中 314/1243 = 25.3% 来自 `internal-session-effects-skill-workshop-review_*` / `pd-runtime-*` / `e2e-glm-fix-check`）。

**这个发现直接改变了清理方案**：账本里没有可删的垃圾；有噪声的是**行为遥测的归因面**。

## 7.3 对「Delete」通道的保留设计

工具**永不含删除逻辑**。若 Owner 判定某条必须物理移除，流程为：

1. 工具标记为 `baselineExit='invalid'`（当前 0 条）
2. 从 `principle-baseline-archive-<ts>.json` 独立核验内容已在别处保留
3. **由 Owner 单独授权**的一次显式移除操作（不在本工具范围内）

⇒ **本工具的存在前提是「零删除也能达成目标」**，而 122/122 可重建性证明了这一点成立。

---

# New Baseline Proposal

## 8.1 基线定义

> **Principle Knowledge Baseline** = 满足以下全部条件的账本条目集合：
> ① `recommendation_kind = 'principle'`
> ② 无域过拟合标签（`MEDIA` / `PD_INTERNAL`）
> ③ 不落入语义重叠簇（bigram Jaccard ≥ 0.15 连通分量）
> ④ 未被标记 `baselineExcluded`

## 8.2 基线规模

| 阶段 | 规模 | 变化 |
|---|---|---|
| 现状 | 122 | — |
| 标记执行后（默认，不含 live） | **33** | **−73%** |
| 4 条 live 完成阶段性停用后 | **29** | **−76%** |

**33 = 29 (A) + 4 (deferred-live，暂缓而非保留)**

## 8.3 基线的类型纯度

| 阶段 | kind=principle | kind=prompt | 纯度 |
|---|---|---|---|
| 标记执行后（33） | 31 | **2**（`56010589` / `6d2f3fe6`，因 live 而暂缓） | 93.9% |
| live 停用后（29） | 29 | 0 | **100%** |

**⇒ 「100% principle semantics」的达成路径是明确的两步**：标记（33，93.9%）→ live 阶段性停用（29，100%）。

## 8.4 基线不追求固定数量

按任务书要求，**数量由价值判断决定，不设目标值**。当前 29 条是判据的**结果**，不是**目标**。
若 Owner 通过 `--overrides` 将边界样本（如 `2cae5647` / `96608bec`）移出，基线自然降至 27；若认为 4 条 live 中 2 条 principle 型（`df6155a1` / `bb0a4303`）应保留，基线升至 31。**判据稳定，数量随判断浮动。**

## 8.5 基线与既有能力的关系

| 能力 | 与基线的关系 |
|---|---|
| `PruningReadModel` | 现因前置条件 `derivedPainCount === 0` 与数据（恒 1）冲突而恒空。基线建立后该前置条件仍未修复 —— **基线不修复剪枝能力** |
| L1 hard cap = 12 | 基线 29 > cap 12。**接通 cap 后基线仍需进一步压缩**（属 Phase 2，不在本次范围） |
| Resolver（未来） | 基线是 Resolver 的**必要前提**（同质可比集合），仍缺语义表征与行为指纹 2 个依赖 |

---

# Risks

| # | 风险 | 等级 | 触发条件 | 缓解 |
|---|---|---|---|---|
| **R1** | **归档 live 条目导致运行时行为静默改变** | **高** | `--include-live` 在未停用激活的情况下使用 | 工具默认拒绝处理 4 条 live 条目；提示先做阶段性停用并观察；`--include-live` 为显式 opt-in |
| **R2** | **归档误伤高价值原则**（域探测器为启发式） | **高** | 某条原则文本恰好含域词汇但语义通用 | 工具输出每条命中标签与理由 + `--overrides` 逐条推翻；建议 Owner 先审 dry-run 全量清单（工具会列出全部 89 条） |
| **R3** | **`_tree` 额外命名空间被静默丢弃** | **高** | 实现者把归档条目移到 `_tree.archived` | 已在工具中规避（标记 + 独立归档文件）；设计理由写入 §6.2 |
| **R4** | **effect 不可归因使「效果验证」永远无法完成** | **高** | `principle_applications.activation_id` 持续为 NULL（实测 93/93 effect 行） | 属独立缺陷，需单独立项；**基线不应声称「已验证效果」** |
| **R5** | **`recommendation_kind` 自身噪声传导** | 中 | Diagnostician 类型判定不准（4/18 impl 带 action、1/20 prompt 带 rule 字段） | 已知并记录；工具以 kind 为权威并输出交叉检查差异 |
| **R6** | **清理后误以为 Resolver 可建** | 中 | 读者只看「基线很干净」 | §8.5 与 AC-4 显式声明：基线只是必要前提 |
| **R7** | **Rule Registry 缺位导致 B 类素材「无处可去」的错觉** | 中 | 认为「转 Rule」需要新建库 | §5.2 澄清：素材已在候选池，动作是「移出账本」而非「移入新库」 |
| **R8** | **工具误写安装目录** | 中 | `--out-dir` 指向 `.pd` / `.openclaw` | 工具内置 `assertNotForbidden()` 前缀拦截；且**永不手写账本文件**，只经 `saveLedger()`（含 PRI-459 文件锁 + 原子重命名） |
| **R9** | **并发写入者造成丢失更新** | 中 | 清理期间有内化链在写账本 | 复用 `saveLedger()` 的跨进程锁；建议在链路静默窗口执行 |
| **R10** | **标记字段被下游误读为「条目无效」** | 中 | 下游按 `baselineExcluded` 做删除/跳过 | 命名避免 `invalid`；文档声明「标记 ≠ 删除」；字段为加性可空，codec `{...value}` 天然保留 |
| **R11** | **基线 29 > L1 cap 12** | 中 | 未来接通 cap 时批量淘汰 | 属 Phase 2；本次不处理，但需在计划中预告 |
| **R12** | **遥测面测试噪声未清理** | 低-中 | 25.3% 行数来自测试会话 | 建议独立小任务：按 session 前缀隔离/排除测试会话统计；**不在本工具范围** |

---

# Rollback Plan

## 10.1 三层回退

| 层 | 手段 | 粒度 | 命令 |
|---|---|---|---|
| **L1 — 单条字段回退** | 将 `baselineExcluded` 置回 `false`（或删除该字段） | 单条 | 手工编辑或 `--overrides { forceKeep: [id] }` 重跑 |
| **L2 — 整体回退** | 从备份覆盖账本 | 全量 | `cp "<stateDir>/principle_training_state.backup-<ts>.json" "<stateDir>/principle_training_state.json"` |
| **L3 — 内容重建** | 从候选池重建（**0 号安全属性**） | 全量/任意子集 | 122/122 条目的 `text` 与 `principle_candidates.description` 逐字符一致，可脚本重建 |

## 10.2 备份与归档工件（`--apply` 强制产出）

| 工件 | 路径 | 用途 | 校验 |
|---|---|---|---|
| 账本快照 | `<outDir>/principle_training_state.backup-<ts>.json` | L2 整体回退 | **sha256 与源文件比对，不一致则中止** |
| 候选池导出 | `<outDir>/principle-candidates-<ts>.json` | 保证分类依据可复现（防候选表被清理） | 138 行全字段 |
| 归档导出 | `<outDir>/principle-baseline-archive-<ts>.json` | 被排除条目的完整副本 + 分类理由 + 候选记录 | 仅恢复工件，非真相 |

**`--apply` 的强制顺序**（工具内置，不可跳过）：`快照 → sha256 校验 → 归档导出 → 标记写入 → 校验`。

## 10.3 校验（工具 P5 自动执行）

```
INV-1  条目总数不变（122 → 122）                    ← 证明零删除
INV-2  被标记集合 == 计划集合
INV-3  不可变字段未被改动：text / status / derivedFromPainIds / ruleIds / createdAt
INV-4  备份 sha256 == 源文件 sha256
INV-5  幂等：重复运行不产生新的标记
INV-6  D 类（无法分类）非空时拒绝 apply
```

**任一失败**：工具以非零码退出，打印回退命令，不继续。

---

# Future Protection（Step 5 — 防回归）

**目标**：`recommendation_kind !== 'principle'` 不得再进入 Principle Ledger。**不重新设计 Router**（Router 已存在，见 `docs/specs/principle-purification.md` §2.3）。

## 11.1 最小插入点（已逐一核实）

**单一判据**（复用现成常量，不新增概念）：

```ts
const isLedgerEligible = (kind: string) =>
  CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger';
```

`CANDIDATE_KIND_TO_ROUTE`（`intake-to-internalization-bridge.ts:114-120`）的 5 个 kind 中只有 `principle` 映射到 `principle-ledger`。
未知 kind → `undefined` ≠ `'principle-ledger'` ⇒ **fail-closed**（顺带收敛 `resolveRecommendationKind` 的 fail-open 到 principle）。

**必须加在 `intake()` 之前的 4 类位置（共 6 处调用点）**：

| # | 文件 | 插入位置 | 现状 | 目标 |
|---|---|---|---|---|
| 1 | `principles-core/src/runtime-v2/pain-signal-bridge.ts` | `:808` 之前（`:803` admission 判定的同一 continue 块内） | 只判 `admitted` | `admitted && isLedgerEligible(kind)` |
| 2 | `pd-cli/src/commands/diagnose.ts` | `:562` 之前（`checkAdmissionGate` 之后） | 只判 admission | `+ isLedgerEligible(kind)` |
| 3-5 | `pd-cli/src/commands/candidate.ts` | `:594` / `:804` / `:1100` | 只判 admission | 同上；`candidate intake` 手动命令建议保留 `--force-legacy-intake` 逃生舱 |
| 6 | `pd-cli/src/commands/pain-retry.ts` | `:616`（经 `PainSignalBridge`） | 随 #1 自动生效 | — |

**为什么必须在 `intake()` 之前而不是 `writeProbationEntry` 之内**：
`LedgerAdapter`（`candidate-intake.ts:275-309`）的既有错误码全部是 `*_NOT_FOUND` / `*_FAILED` / `INPUT_INVALID`，没有「类型不该来」这一类；在适配器内拒写会污染错误语义，并留下「候选已被 `intake()` 消费但账本无条目」的不一致窗口。

## 11.2 防回归的验证判据

| 判据 | 验证方式 |
|---|---|
| 5 类 kind 各造一个 `admitted` 候选 → 只有 `principle` 产生账本条目 | 单测 |
| `recommendationKind` 为 `undefined`/`null`/`'unknown_xyz'` → **不产生**账本条目 | fail-closed 回归测试 |
| 账本新增条目 100% 为 `kind='principle'` | 生产遥测断言 |
| 被拒候选有显式 disposition（不静默消失） | 守恒等式（见 `principle-purification.md` AC-3） |

## 11.3 状态说明

**防回归目前尚未实施。** `docs/specs/principle-purification.md` 与本节均为**待 Owner 批准的方案**；在门禁上线前，账本仍会被继续污染（当前已有 16 条 `pending` 候选处于待处理状态）。

---

# Acceptance Criteria

## AC-1 — 122 条中：保留？转 Rule？Archive？Delete？

| 分类 | 数量 | 占比 | 处置 |
|---|---|---|---|
| **A — 保留（Keep）** | **29** | 23.8% | 进入新基线 |
| **B — 转 Rule** | **40** | 32.8% | 移出原则账本（规则素材已在候选池完整保留；B1 通用 18 / B2 域绑定 22） |
| **C — Archive** | **53** | 43.4% | 标记 `baselineExcluded`，退出 injection / resolver / lifecycle（其中 **4 条因 live 暂缓**） |
| **D — Delete** | **0** | 0% | **无可删条目**（见 §7） |
| 合计 | **122** | 100% | 零删除 |

## AC-2 — 新 Principle Baseline 的大小？

**33 条**（= 29 真 Principle + 4 条 live 暂缓）；4 条 live 完成阶段性停用后 → **29 条**。

- 压缩率：**122 → 33（−73%）**，最终 **29（−76%）**
- **不追求固定数量**：29 是判据的结果而非目标。判据为「kind=principle ∧ 无域过拟合 ∧ 无语义重叠 ∧ 未标记排除」。Owner 通过 `--overrides` 调整边界样本时，数量在 27–31 区间自然浮动。

## AC-3 — 清理后 Principle Ledger 是否满足「100% principle semantics」？

**必须分两个边界回答，不能笼统说「满足」：**

| 边界 | 标记执行后 | live 停用后 | 说明 |
|---|---|---|---|
| **存储边界**（账本文件里有什么） | **否**（122 条，33 条属基线） | **否** | 不删除 ⇒ 物理纯度不可能达成。**这是有意的设计选择**，不是未完成项 |
| **消费边界**（injection / resolver / lifecycle 实际读什么） | **93.9%**（31/33 为 principle-kind；2 条 prompt-kind 因 live 暂缓保留） | **100%**（29/29 全为 principle-kind） | **这才是「100% principle semantics」的可达成定义** |

⇒ **结论：可达成的目标是「消费边界 100%」，路径为「标记（93.9%）→ live 阶段性停用（100%）」。**
物理上的「存储边界 100%」需要删除数据，与本任务硬约束冲突，**明确不在范围内**。

## AC-4 — 未来新数据是否还能污染？

| 问题 | 答案 |
|---|---|
| 现在是否已受保护？ | **没有。** 门禁尚未实施（方案见 §11 与 `docs/specs/principle-purification.md`） |
| 门禁实施后是否还能污染？ | **不能。** 判据 `CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger'`，未知 kind 天然 fail-closed |
| 最小插入点是否已核实？ | **是**，6 处调用点已逐一给出 file:line（§11.1） |
| 是否重新设计了 Router？ | **没有**。Router 已存在（`internalization-route.ts` + `intake-to-internalization-bridge.ts`），只需在写入前调用其判据 |
| 残余风险 | `recommendation_kind` 自身噪声（R5）；门禁拒写后候选的 disposition 必须落遥测，否则从「污染」变成「静默丢失」（R2/守恒等式） |

---

# Open Questions

| # | 问题 | 影响 | 需要 |
|---|---|---|---|
| **Q1** | 4 条 live 条目（`56010589` / `df6155a1` / `6d2f3fe6` / `bb0a4303`）是「阶段性停用后归档」还是「提升为 A 保留」？ | 决定基线是 29 还是 31 | Owner 决策 |
| **Q2** | 边界样本如何取舍？A 侧偏宽（`89ed1bed` 含「创作类/大纲」、`a2ac2b93` 含「素材」，均未命中域探测器）；C 侧偏严（`2cae5647` 因命中 `PD_INTERNAL` 落入 C3、`96608bec` 因重复簇落入 C4，但语义均可复用） | ±4 条基线 | Owner 逐条判断（dry-run 清单已列全部标签与理由） |
| **Q3** | B2 的 22 条域绑定规则是否值得进 Rule Registry？ | Rule Registry 优先级 | Owner 判断 |
| **Q4** | `principle_applications` 中 25.3% 的测试会话噪声是否单独清理？ | 效果指标可信度 | 独立小任务 |
| **Q5** | `principle_applications.activation_id` 为 NULL（93 条 effect）何时修复？ | 决定基线能否做效果验证 | 独立缺陷立项 |
| **Q6** | 49 条 principle 型条目的账本 `action` 为何全为空串（78/122 空）？ | 影响 Principle 判据表述 | 需查 `candidate-intake-service.ts:196-207` 与候选表 reconcile |
| **Q7** | 16 条 `pending` 候选为何从未被消费？ | 可能另有链路缺口 | 需查 auto-consumer 的处理窗口 |

---

# 附录 A — 交付物与证据资产

| 资产 | 位置 |
|---|---|
| 本报告 | `docs/audit/principle-baseline-reset.md` |
| 清理工具（设计产物，**未 apply**） | `scripts/cleanup-principle-baseline.mjs` |
| 分类全量清单 | `D:/pd-probe-evo/final-classification.tsv`（122 行，含 category / live / dup / domain / text） |
| 122 条原文 | `D:/pd-probe-evo/all122.tsv` |
| 探针脚本 | `D:/pd-probe-evo/{inventory,inv2,classify,final,recheck,testsess}.cjs` |
| 上游审计 | `docs/audit/principle-evolution-audit.md` |
| 上游 SPEC | `docs/specs/principle-purification.md` |

# 附录 B — 工具调用面（`scripts/cleanup-principle-baseline.mjs`）

```
# 只读盘点（默认，零写入）
node scripts/cleanup-principle-baseline.mjs --workspace <ws>
node scripts/cleanup-principle-baseline.mjs --workspace <ws> --json

# 真正执行（强制先快照 + sha256 校验 + 归档导出）
node scripts/cleanup-principle-baseline.mjs --workspace <ws> --apply

# 连同 live 条目一起处理（需 Owner 显式授权；建议先做阶段性停用）
node scripts/cleanup-principle-baseline.mjs --workspace <ws> --apply --include-live

# 逐条推翻分类
node scripts/cleanup-principle-baseline.mjs --workspace <ws> --overrides overrides.json
#   overrides.json = { "forceKeep": ["<id>"], "forceExclude": ["<id>"] }
```

**本机已执行**：仅 `--workspace "D:/.openclaw/workspace"`（dry-run）。执行后账本 mtime `2026-09-23 00:04:09` 与 sha256 `1af3e926…c9ace` 均未变化，未产生 backup/archive 文件。

# 附录 C — 纪律声明

```
PRODUCTION_DATA_MODIFIED   = NO
FILE_DELETED               = NO
MIGRATION_EXECUTED         = NO
PR_CREATED                 = NO
LINEAR_ISSUE_CREATED       = NO
EMBEDDING_INTRODUCED       = NO
RESOLVER_IMPLEMENTED       = NO
INSTALL_DIR_MODIFIED       = NO   (~/.pd · ~/.openclaw/extensions · <ws>/.pd 均未触碰)
LEDGER_WRITTEN             = NO   (仅 dry-run；未调用 saveLedger)
SCRIPT_APPLIED             = NO   (工具为设计产物，默认 --dry-run)
```
