# PD Pain Semantics & Detection Architecture v1.0
## Final Contract Closure (v0.3.1)

**Status:** Proposed — Owner Final Review（本文本身待 Owner 批准；其中 D5/D6 明确标记"待 Owner 最终批准"）
**Revision:** v0.3.1（v0.3 的最后一次实施前契约收口：PainIngress 执行顺序、Worker 总执行预算、D5/D6 Owner 决策、Pending Marker 保留策略、兼容性验收契约）
**Code Baseline:** 起草时 HEAD=`457bbf0fcd8df85c069b78ce60858acf742fe970`；origin/main 在本轮工作期间已前移至 `fd8fe301f`（版本发布提交），本轮承重函数一手读取均在 `457bbf0f` 上完成。fd8fe301f 相对本 SPEC 五项议题所涉函数（pain-ingress.ts / gsa 的 admitCorrection、insertCorrectionPain、ensureGovernanceDiagnosticianTask、isGovernanceTaskPayload、readGovernanceAdmissionCounts）无相关改动，结论有效；实施分支须另行基于最新 origin/main 创建。
**Evidence Base:**
- `docs/reviews/2026-11-02-pain-architecture-spec-v0.1-audit.md`
- `docs/reviews/2026-11-02-pain-architecture-v0.2-targeted-review.md`
- `docs/reviews/2026-11-02-pain-architecture-v0.3-final-closure.md`（随本文交付）
**Scope:** 与 v0.3 相同
**Priority:** Core Architecture
**Change Authority:** Owner

> **本文性质：** v0.3 的**增量收口**，不是独立规范。实施以 v0.3 为基础、以本文修订章节为准；未提及章节沿用 v0.3。v0.3 原文件保留不动。

---

## 0. 收口范围（不做全仓审计）

仅五项：① PainIngress 与 Pain Admission 的执行顺序（P0）；② Worker Stage-2 总执行预算（P1）；③ D5 / D6 两项 Owner 决策（明确待批）；④ Pending Marker 数据持久化与保留策略；⑤ `task_payload_json` 与 decision 新值的兼容性验收契约。

---

## 1. P0 — PainIngress 与 Pain Admission 的执行顺序（取代 v0.3 §4.4.3 顺序条款与 §5 排序含义；§5 字段映射不变）

### 1.1 现状核实（一手读取）

- `evaluatePainIngress`（principles-core/runtime-v2/pain-ingress.ts:157-239）是**纯函数**：模块头明示 no I/O / no persistence / no identity minting（pain-ingress.ts:21-23）。四种 action：submit / degrade / refuse / observation_only。
- 当前生产链路**不含** PainIngress：`ensureGovernanceDiagnosticianTask` 硬编码 `provenance:'host_context_bound'`（gsa:1269）；evaluatePainIngress 现有调用点仅为 openclaw-plugin/hooks/pain-ingress-adapter.ts:72 与 pd-cli pain-record——governance 路径的接入是 v0.3 §5 的**计划项**，不是现状。
- `admitCorrection` 单事务（gsa:790-818）：pain 去重探针 → 限流（`tryConsumeRateLimit`，RateLimitedSignal 回滚）→ `insertCorrectionPain` → marker INSERT（'admitted' 硬编码 :699-705）。
- `ensureGovernanceDiagnosticianTask`（gsa:1210-1318）：marker 探针幂等（:1217-1221）+ 确定性 task id（:1236）+ Case B 崩溃收敛（:1286-1297）；reconcile Case A/B（:1650-1657）只扫 `decision='admitted'`。

### 1.2 目标执行顺序（取代 v0.3 §4.4.3；v0.3 §5 的字段映射不变）

```
Stage-2 Classification（判定结果持久化进 payload）
→ Build PainIngressReport（按 v0.3 §5 字段映射）
→ evaluatePainIngress（纯函数：可重入、零副作用、零消耗）
→ Admission Decision 分支：
   ├─ submit / degrade → 准入事务（单事务，顺序固定）：
   │     ① marker CAS：UPDATE … SET decision='admitted', canonical_pain_id=?,
   │        rule_version=?, reason=?, task_payload_json=<预构建 task_payload 原样换入>, updated_at=?
   │        WHERE logical_observation_key=? AND decision='pending_llm_review'
   │        [changes=1 才继续；changes≠1 → 回滚退出，零副作用]
   │     ② pain 去重探针（既有 duplicate 语义，gsa:791-797）
   │     ③ tryConsumeRateLimit（既有桶；RateLimitedSignal → 整体回滚，
   │        行停留 pending，attempts 不计（非 LLM 失败），下一周期重试终态转换，TTL 兜底）
   │     ④ insertCorrectionPain（既有）
   │   事务提交 → ensureGovernanceDiagnosticianTask（既有幂等）→ Case A/B 恢复
   ├─ refuse            → pending marker → `abandoned(reasonCode)` 终态
   └─ observation_only  → pending marker → `abandoned(reasonCode)` 终态
```

硬性要求（对应任务书）：

- **evaluatePainIngress 必须在任何 Pain 创建、限流消耗及准入副作用之前执行**。它是纯函数，重复执行无副作用；refuse/observation_only 的 marker 终态转换是唯一允许的"evaluate 之后"动作。
- **Admission CAS 仍是并发竞争的最终仲裁**：evaluate 只是门前纯判定，不消耗额度、不产生记录；状态转换唯一仲裁是事务内 `changes=1` 检查。
- **Pain Event 与 marker 的事务原子性不变**：步骤 ①-④ 在同一 SQLite 事务中，任一失败整体回滚。
- **Diagnostic Task 继续通过既有 Case A/B 恢复**：marker 已 admitted 而 task link 缺失 → reconcile（:1650-1657）补链；任务已建而 link 未写 → Case B（:1286-1297）。

### 1.3 四种 action 的处置与 Pending marker 终态

| action | 处置 | marker 终态 | D6 数据最小化 |
|---|---|---|---|
| **submit** | 正常准入（CAS → 限流 → Pain Event → 任务） | 转为 `admitted`（无独立终态） | 不适用：payload 换入预构建 task_payload，与现行 admitted 完全一致 |
| **degrade** | 按 Owner 显式报告既有语义准入（诚实空证据 + warning 随任务携带） | 转为 `admitted` | 同上 |
| **refuse** | **零 Pain、零任务、零额度消耗** | `abandoned(reasonCode)`：reason 保留 reasonCode（如 `lineage_mismatch`） | 适用：payload 重写为最小化元数据 |
| **observation_only** | **零 Pain、零任务、零额度消耗** | `abandoned(reasonCode)`：reason 保留 reasonCode（如 `unbound`/`no_evidence`） | 适用：同上 |

注：degrade 语义仅适用于 Owner 显式报告（pain-ingress.ts:213-227）；自动纠正证据缺失走 observation_only（:198-207），不是 degrade。

### 1.4 为什么用 `abandoned(reasonCode)` 而不新增 decision 值

`abandoned` 在本状态机中统一表达"终态、未准入"，reason 字段承载精确原因（`lineage_mismatch` / `unbound` / `no_evidence` / `low_confidence` / `llm_error` / `ttl_expired` / `rate_limit` 仅阻塞不终态）。decision 列无 CHECK 约束（gsa:347-363 一手复核），现有值确实可表达全部情形，因此**不新增 decision 值**。"主动放弃"与"正确拒绝"的语义差由 reason 区分，审计元数据保留。

### 1.5 回归场景（新增，并入 v0.3 §8）

- **A.** submit → 恰好一个 Pain、一个 Task；无 warning。
- **B.** degrade → 一个 Pain、一个 Task，warning 保留并可观察。
- **B'.** degrade 仅适用于 Owner 显式报告；自动纠正证据缺失 → observation_only（pain-ingress.ts:198-207 既有语义），不是 degrade。
- **C.** refuse → 零 Pain、零 Task、零额度；marker → `abandoned(reasonCode)`；文本按 D6 最小化。
- **D.** observation_only → 零 Pain、零 Task、零额度；同上终态。
- **E.** CAS 竞争失败（changes≠1）→ 败方整体回滚，零重复副作用。
- **F.** Pain Event 创建失败 → 整个事务回滚，**marker 不得遗留 admitted**（原子性断言）。

---

## 2. P1 — Worker Stage-2 总执行预算（取代 v0.3 §4.4.7 的位置与预算条款）

### 2.1 问题确认

v0.3 允许"≤2 条/周期 × 单次 60s"→ 最坏 120s ≥ 周期 120s，会推迟下一周期并影响 liveness 判活观测（liveness 文件仅观测用，codex-worker.ts:117-124）。

### 2.2 定案

- **执行位置与优先级**：Stage-2 步骤位于**周期末尾**（诊断任务、reconcile、后处理全部完成后才执行）。现状周期顺序证据：Codex = catch-up(:281) → reconcile(:289) → diagnostician(:332-340)；WB = reconcile(:170) → sweep(:177) → diagnose(:207-215)。Stage-2 作为最后一步 append——结构性保证不抢占诊断。
- **Aggregate budget ≤ 60s/周期**：步骤开始取 monotonic 时钟；每个候选处理前检查剩余预算，耗尽即跳过剩余候选（下一周期继续）。
- **单次分类超时 60s 不变**（`timeoutMs` 每调用可覆盖，adapter:675 支持每调用传参）。
- **串行 + SQLite CAS 设计保留**（v0.3 §4.4.4/§4.4.5 不变；并发竞争唯一仲裁仍是事务内 changes=1）。
- **不允许 Stage-2 阻塞诊断**：tail 位置 + aggregate ≤60s → 最坏占用周期 50%，且发生在诊断完成之后。
- **liveness 声明的诚实形式**：现状代码没有 Stage-2，因此"liveness 不受影响"**现状下不成立也无从成立**；其最终证据是 Phase B §8 新增测试。实施完成前，该保证按 UNVERIFIED 对待——本 SPEC 不声称现状已保证。

### 2.3 测试（并入 v0.3 §8 Runtime Tests）

- 两条候选总执行时间 ≤ aggregate budget（60s）。
- 第一条超时（耗尽 60s）→ 第二条被跳过。
- 同周期诊断 / reconcile / 后处理结果不受 Stage-2 超时影响（诊断先完成断言）。
- 下一周期继续处理未完成候选（跨周期推进）。
- 无限重试与 Worker 堆积不存在（attempts≤5 + TTL + 周期预算三重上界断言）。

---

## 3. Owner Decisions D5 / D6（**均待 Owner 最终批准，本 SPEC 不视为已授权**）

### 3.1 D5 — PRI-788 G3 学习词直通机制的逆转

**建议：批准逆转。**

- 现行设计：学习词 TP≥3 且 FP=0 → `precision='high'`（gsa:167-178）→ 经 `projectLearnedStore` 投影即获 `collectSync` 确定性 STRONG 直通（`needsLlmConfirmation=false`）——PRI-788 G3 有意设计（v0.3 §3.2.3）。
- 逆转内容：学习词只能成为 **Stage-2 优先候选**（ambiguous 词表 + 免 discovery 预算），**不得仅凭 TP≥3、FP=0 直接成为 STRONG 直通**。
- 定性：**这是行为契约变更，不是普通代码优化**——它改变了 v0.3 §3.2 直通资格、§10 契约变更清单中的对应条目生效前提，并影响现行学习词行为与相关测试预期。
- 生效门：Phase B 的 P-2（学习词升级门）**以 D5 获 Owner 批准为前置**；未批准前，学习词现行行为不动。

### 3.2 D6 — Pending Marker 数据持久化与保留策略

**建议：有条件批准，条件如下（待 Owner 认可）。**

- **仅保存 Stage-2 必需数据**：pending 阶段 payload 持有 {触发文本（sanitizeString 界定后）、命中词、review 元数据（attempt/claimed_at/review_result/confidence）、以及**就地预构建的 `GovernanceTaskSubmissionPayload`**}。预构建形态取自现状 `taskSubmissionPayload`（gsa:635-668，一手复核），确认时原样换入——不重复持久化、无第二真相。
- **Pending 最长 72 小时**（TTL 自 `created_at` 起算；过期 → `abandoned(ttl_expired)`）。
- **resolved_none / abandoned → 数据最小化**：终态转换的同一 UPDATE 内将 payload 重写为最小化元数据（丢弃触发文本与分类明细，保留 reason/reasonCode/confidence/attempts/终态时间）。最小方案：终态 UPDATE 本就发生，payload 重写是同语句的附带 SET——零 DDL、零新表。
- **admitted 的正式证据以 Pain Event 为准**：确认时 payload 换入 `GovernanceTaskSubmissionPayload`（其文本字段经 `sanitizeString` 界定，与现行 admitted 行为完全一致——不新增任何留存范围）。
- **审计元数据保留**（终态时间、原因、attempts、confidence）。
- 若 Owner 对 72h TTL 或最小化范围有异议，仅需调整常量/重写字段清单，不需要架构变更。

---

## 4. 兼容性验收契约（任务书 §五 逐项，全部一手证据）

1. **`task_payload_json` 扩展字段 vs `isGovernanceTaskPayload`**：pending 审查元数据采用**独立形状** `{kind:'pending_llm_review', task_payload:<GovernanceTaskSubmissionPayload>, review:{...}}`。该形状**天然不通过** `isGovernanceTaskPayload`（gsa:1146-1180：painType 枚举/非空字符串/score 数字/hostKind 枚举/结构化 evidence 逐项校验）→ 若被误喂给 ensure，fail-loud 返回 `admission_task_payload_invalid`（:1232-1234），不会误读。确认时同事务换入内层 `task_payload`，ensure 所见即现行合法形态。
2. **Pending review metadata 与既有 GovernanceTaskPayload 隔离**：同一字段、双形状、按生命周期切换（pending 形状 → admitted 形状），validator 形状门 + fail-loud 兜底；不存在形状混用路径。
3. **新 decision 值不被旧消费者误读**：全部 10 个表访问点收敛于 gsa 单文件（全库 grep 复核）。按 canonical_pain_id 定位的读取（:719/:1217/:1380/:1484/:1519/:1696）对 pending 行天然惰性（该列 NULL）；健康计数两个 SUM 显式 `decision='admitted'`（:1736-1739）不受污染。
4. **全部 decision 读取点仍正确过滤 admitted**：唯一按 decision 过滤的两处——reconcile（:1650-1657）与健康计数（:1736-1739）——均只匹配 `'admitted'`，新值惰性。
5. **reconcile 只处理 admitted**：同上（:1651 谓词）。
6. **既有 Codex/WorkBuddy Pain Admission 行为不变**：pending 只写入"ambiguous 静默丢弃"路径（gsa:771-774）；STRONG+high 内联准入（:766-775）与显式 Owner Statement 免检准入（CR-07，:751-770）路径零改动。
7. **UNIQUE 语义不破坏**：pending 行占用 `UNIQUE(logical_observation_key)` 键，重交付由 v0.3 的 admitOne 预探 pending 守卫处理（返回 pending 重复语义，非空 id 的 already_admitted）；UNIQUE 继续防重复插入。

**唯一语义级注意点**：`readGovernanceAdmissionCounts` 的 `last_admission = MAX(created_at)`（:1739）统计全部行——pending 行会使该健康指标变为"最近 marker 创建时间"。处置：文档注明该语义（最小方案）；如 Owner 认为需要，可加一行 `decision='admitted'` 过滤（可选，不阻塞）。

---

## 5. 对 v0.3 的修订清单（实施以本文为准）

| v0.3 章节 | v0.3.1 处置 |
|---|---|
| §4.4.3 顺序（marker CAS → … → ensure） | **取代**：evaluatePainIngress 前置（本文 §1.2） |
| §4.4.3"复用 admitOne 准入路径"表述 | 维持 v0.3 已有修订（专用确认函数 + admitOne 预探 pending 守卫） |
| §4.4.7 位置与预算 | **取代**：周期末尾 + aggregate ≤60s（本文 §2.2） |
| §3.2.3 / §10 的 G3 逆转条目 | **加门**：以 D5 批准为前置（本文 §3.1） |
| §4.4 pending payload 内容 | **细化**：预构建 task_payload 内嵌 + review 元数据（本文 §3.2/§4.1） |
| §12 | **扩充**：新增 D5/D6（本文 §3），D1-D4 不变 |
| §8 | **扩充**：回归场景 A-F（本文 §1.5）与预算测试（本文 §2.3） |
| 其余章节 | 沿用 v0.3 |

---

## 6. 交叉检查结果（任务书要求）

- **SPEC 内部交叉引用**：v0.3.1 引用的 v0.3 章节号（§3.2.3/§4.4.x/§5/§8/§10/§12）逐一核对存在且语义对应。✓
- **状态机与准入顺序一致性**：refuse/observation_only 终态（abandoned+reasonCode）与 submit/degrade 准入路径在 §1.2 图与 §1.3 表中一致；CAS 仲裁唯一性在两处表述一致。✓
- **Worker 预算一致性**：§2.2 与 §2.3 测试数值一致（60s aggregate / 60s 单次 / ≤2 条 / 120s 周期）。✓
- **Owner Decision 完整性**：D1-D4（v0.3 §12）+ D5/D6（本文 §3）= 六项，全部标注建议与生效门。✓

---

## 7. 最终裁定与必答问题

### 裁定：**READY_WITH_OWNER_DECISIONS**

两项技术问题（执行顺序、总预算）已按源码证据解决；无实施阻塞；D1-D6 待 Owner 批准（其中 D5 为 G3 行为契约逆转的显式批准门，D6 为有条件批准建议）。

### 必答

1. **两项技术问题是否解决？** 是。执行顺序已定为 evaluatePainIngress 前置 + 四分支处置 + 六回归场景（§1）；总预算已定为周期末尾 + aggregate ≤60s + 五项测试（§2）。
2. **是否还存在实施阻塞？** 无。所有承重事实经一手复核；兼容性七项全部闭合；唯一注意点（last_admission 指标语义）有最小处置且不阻塞。
3. **D1-D6 哪些需要 Owner 批准？** 全部六项均为 Owner 决策门：D1（Tool Failure 退役时机）、D2（GFI 健康面去留）、D3（确认队列定位——推荐已给，批准即冻结）、D4（外部 RuleCode 只读扫描授权）、**D5（G3 逆转批准——行为契约变更）**、**D6（Pending 保留与最小化——有条件批准）**。D5/D6 未批准前，对应实施项（P-2、pending payload 保留策略）不得实施。
4. **Phase 0、B、A、C 是否可以进入实施？** Phase 0（Semantic/Paralysis 停写、Fatal Intercept/Sample Reject 下线、双键收敛、可选文件名小修）：**可立即实施**（不依赖任何 Owner 决策）。Phase B：待 D5/D6 批准后实施（D5 门=学习词条款；D6 门=pending 保留策略）。Phase A：以 Phase B 验收为前置（另有 D1 认可其时机）。Phase C 第一阶段可随 Phase A 后实施；**GFI 第二阶段（剩余面删除）必须等 D4 只读扫描**。
5. **哪些功能必须等 D4 只读扫描后才能实施？** 仅 GFI 第二阶段：健康观测面去留、剩余输入契约（`rule-host-contracts.ts:43`、`production-rulehost-gate.ts` 注入）的删除。Phase 0/B/A 与 Phase C 第一阶段（GFI Pain 触发删除+停写，健康面保留）均不依赖 D4。
