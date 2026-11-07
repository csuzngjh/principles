# PD Pain Semantics & Detection Architecture v1.0
## Final Contract Closure (v0.3.1)

**Status:** IMPLEMENTED (code + unit/integration) — FINAL ACCEPTANCE PENDING. D5/D6: `OWNER_APPROVED / IMPLEMENTATION_ACCEPTED`（Owner 2026-11-07）。Phase B 整体仍为 **PARTIALLY_IMPLEMENTED**（真实 LLM BDD 与三宿主最终验收未完成）。
**Revision:** v0.3.1（v0.3 的最后一次实施前契约收口）+ 2026-11-07 Implementation Closure + 2026-11-07 Owner Decision Closure（仅追加状态与证据，不改设计条款）
**Code Baseline:** 起草时 HEAD=`457bbf0fcd8df85c069b78ce60858acf742fe970`；2026-11-07 最终收敛基线 `origin/main@9c07876207655b4ac9757fb3510a69f3bb9dfa30`（PRI-1136 已把 `runtime-v2/` 改名为 `runtime/`；本文相关代码路径按当前路径复核）。
**Implementation Evidence:** 见 §8 与 `docs/reports/PAIN_ARCHITECTURE_FINAL_CLOSURE_2026-11-07.md`。
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

> **历史说明（2026-11-07）：** 以下"现状"是 v0.3.1 起草时的基线（`457bbf0f`），
> 不是 2026-11-07 的实现状态。Phase B 已把 PainIngress 接入治理准入链；
> 当前状态、PR 与测试证据见 §11。保留本节用于追溯设计前提。

- `evaluatePainIngress`（principles-core/src/runtime/pain-ingress.ts）是**纯函数**：模块头明示 no I/O / no persistence / no identity minting（pain-ingress.ts:21-23）。四种 action：submit / degrade / refuse / observation_only。
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

---

## 8. Implementation Closure（2026-11-07）

> 本节只追加**实现状态、证据与剩余工作**，不改变 v0.3/v0.3.1 的设计条款。
> 完整逐项「SPEC 要求 → 实际代码 → 测试证据 → 真实运行证据 → 裁定」矩阵见
> `docs/reports/PAIN_ARCHITECTURE_FINAL_CLOSURE_2026-11-07.md`。

### 8.1 基线

- 代码基线：`origin/main@9c07876207655b4ac9757fb3510a69f3bb9dfa30`（PR #2401 rebase 后基线）。
- 路径变更：PRI-1136 已把 `packages/principles-core/src/runtime-v2/` 改名为
  `packages/principles-core/src/runtime/`；本文与报告中的现行路径均按新目录。
- 生产代码未在本轮修改；本轮只做事实核查、状态裁定与文档校准。

### 8.2 Phase 状态（实施 ≠ 最终验收）

| Phase | 状态 | 已交付 | 未完成 / 不计入 |
| --- | --- | --- | --- |
| Phase 0 — Safe Cleanup | **IMPLEMENTED** | PR #2296；`llm-pain-source-retirement` 套件通过 | 无 |
| Phase A — Legacy Retirement | **IMPLEMENTED** | PR #2316；`phase-a-default-production-path` 套件通过；RuleHost Block / Tool Failure / Repeated Failure 自动 Pain 已退役；Owner 显式入口保留 | 无 |
| Phase B — Shared Correction Detection | **PARTIALLY_IMPLEMENTED**（整体）；代码/单测/集成 **COMPLETE**；D5/D6 `OWNER_APPROVED / IMPLEMENTATION_ACCEPTED` | PR #2308、#2347；core 546 passed、host-runtime 89 passed、openclaw-plugin 19 passed（本轮实跑，见 §8.6） | 真实 LLM BDD（PRI-1147）；三宿主最终验收与 startsWith 判定（PRI-1148） |
| Phase C — GFI Complete Removal | **PARTIALLY_IMPLEMENTED** | PR #2332：GFI 生产逻辑、SQLite 列、CLI/Console 表面、指标与命令已移除；纯防御性 `gfi` `gone` 墓碑经 Owner 批准保留（DC-01 方案 A） | 历史 workspace JSON 迁移（SPEC §6.2/§6.3，PRI-1149） |

**结论：** 不得把 Phase B 整体标为 COMPLETE；也不得把 Phase C 标为完整 IMPLEMENTED。
代码实施、单元/集成测试、真实 LLM BDD、三宿主最终验收是四个独立层。

### 8.3 关键代码与测试映射

| 契约 | 现行代码 | 测试证据 |
| --- | --- | --- |
| PainIngress 纯函数与四 action | `packages/principles-core/src/runtime/pain-ingress.ts` | `pain-ingress-spec-matrix.test.ts`（属 core 套件，本轮合计 546 passed） |
| P-1 引用/转述/第三人称/否定防护 | `runtime/signal-collector/keyword-stage.ts` | `keyword-stage.test.ts` |
| 学习词 P-2 门（不再 STRONG 直通） | `runtime/signal-collector/keyword-stage.ts` + `correction-types.ts` | `keyword-stage.test.ts`、`pain-ingress-shared-semantics.test.ts` |
| 置信度门 / pending 状态机 | `runtime/signal-collector/confidence-gate.ts` | `confidence-gate.test.ts`、`governance-signal-admission.pending.test.ts` |
| Stage-2 分类与周期预算 | `host-runtime/src/signal-stage2-cycle.ts` | `signal-stage2-cycle.test.ts` |
| 治理准入 + Diagnostician 单写点 | `host-runtime/src/governance-signal-admission.ts` | `governance-signal-admission.test.ts` |
| Owner 显式 Pain（OpenClaw/CLI） | `openclaw-plugin/src/hooks/pain-ingress-adapter.ts`、`pd-cli` pain record | `phase-a-default-production-path.test.ts` 等 |
| Codex / WorkBuddy worker Stage-2 接入 | `codex-adapter`、`workbuddy-adapter`、`pd-cli workbuddy-worker` | `signal-stage2-cycle.test.ts`、`workbuddy-worker-registration.test.ts` |
| no evidence → observation_only（不写 Pain） | `governance-signal-admission.ts` 的 `persistedBehaviorTraceEvidence` + `evaluatePainIngress` | `governance-signal-admission.workbuddy-live.test.ts` |
| GFI 无生产逻辑 | 全仓 `packages/**/src/**/*.ts` 扫描：仅 `feature-flag-contract.ts` 的 `gfi` gone 墓碑与迁移防御 | `architecture-regression.test.ts`、`feature-flag-lifecycle.test.ts` |

### 8.4 WorkBuddy 边界（正式）

1. **自动关键词 Pain 识别 / 自动准入：明确不支持**（Owner 2026-11-05 决定）。
   - `feature-flag-contract.ts` 的 `workbuddy_live_keyword_pain` 描述已改为
     "UNSUPPORTED ... manual explicit prefix only"；默认 `false`。
   - 安装器对新建与已有 governance 配置均写入 `workbuddy_live_keyword_pain: false`，
     不再默认启用。
   - 即使手工打开 flag，WorkBuddy ingress 没有持久化 observation writer，
     自动候选恒为 `observation_only` → abandoned marker，不写 `pain_events`。
   - 不得通过修改默认 flag 重新把自动识别描述为已交付能力。
2. **支持范围：** 插件安装、显式插件启用、Owner 手动入口 `PD记录痛苦：`、
   以及该入口之后由实际代码支持的 Pain 准入/后续治理。
3. **不支持范围：** 自动关键词 Pain、自动 Pain Admission、"自动识别已交付"的陈述。
4. OpenClaw / Codex 的自动能力边界单独描述；三宿主共享代码不等于能力完全一致。

### 8.5 剩余工作（独立跟踪）

- **PRI-1147**：支持宿主（OpenClaw/Codex）真实 LLM BDD（未完成）。
- **PRI-1148**：三宿主最终验收（OpenClaw/Codex 自动 + WorkBuddy 手动）与
  startsWith 退役判定（未完成）。
- **PRI-1149**：GFI 历史 workspace JSON 数据迁移（未完成）。
- **DC-01**：**已批准**（方案 A：保留纯防御性 `gone` 墓碑）；SPEC §5.1 已同步。
- **DC-02（D5/D6）**：**已批准**（Owner 2026-11-07）；无剩余审批动作。

### 8.7 Owner Decision Closure（2026-11-07）

| 决策 | 结论 | 状态 | 影响 |
| --- | --- | --- | --- |
| D5 — Learning Phrase Admission | 历史精度高的学习词不得直接获得 STRONG 准入；只能作为 Stage 2 优先候选，必须经 Correction Detection 与语境判断 | `OWNER_APPROVED / IMPLEMENTATION_ACCEPTED` | 现有代码/测试即最终接受实现，不改代码 |
| D6 — Pending Marker Persistence | Payload 最小化、TTL 72h、保留次数限制与终态清理；已为 audit/recovery 保留必要证据 | `OWNER_APPROVED / IMPLEMENTATION_ACCEPTED` | 不扩大 Pending 状态机范围 |
| DC-01 — GFI Defensive Tombstone | 方案 A：保留纯防御性 `gone` tombstone | `OWNER_APPROVED / SPEC_ALIGNMENT_REQUIRED` → 本轮已对齐 | 墓碑无执行能力、不可被启用；测试需证明 |

**Phase B 整体仍为 PARTIALLY_IMPLEMENTED**：D5/D6 获批不改变真实 LLM BDD
与三宿主最终验收尚未完成的事实。

### 8.8 本轮验证命令

```text
packages/principles-core: npx vitest run pain-ingress-spec-matrix / pain-ingress-workbuddy /
  pain-ingress-shared-semantics / keyword-stage / architecture-regression /
  feature-flag-lifecycle  -> 546 passed
packages/host-runtime: npx vitest run signal-stage2-cycle /
  governance-signal-admission.pending / governance-signal-admission.workbuddy-live /
  governance-signal-admission -> 89 passed
packages/openclaw-plugin: npx vitest run phase-a-default-production-path /
  llm-pain-source-retirement / gate-b-only-runtime-guard -> 19 passed
packages/create-principles-disciple: workbuddy-host-installer /
  workbuddy-governance-chain / install-status-three-state / install-summary -> passed
packages/workbuddy-adapter: live-keyword-pain / explicit-owner-statement -> passed
packages/pd-cli: workbuddy-worker-registration -> passed
```

真实 LLM 调用、真实三宿主验收、`verify:merge` 全链不因本轮文档收敛而视为已运行；
未执行项在最终报告中标记 NOT RUN。
