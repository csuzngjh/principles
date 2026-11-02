# SPEC-PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE v0.2 定点证伪审查报告

**日期:** 2026-11-02
**性质:** 只读定点审查（非全仓审计）+ SPEC 修订依据
**基线:** `main@457bbf0fcd8df85c069b78ce60858acf742fe970`（== origin/main，交付时复核无漂移；与 v0.2 声明基线一致）
**方法:** 亲读承重代码（pain-ingress.ts 全文 239 行、gsa 的 INSERT/admitOne/ensureGovernanceDiagnosticianTask/限流事务区）+ 3 个并行子代理（OpenClaw 兜底链与生产 DB 只读查询 / 种子词表与 Worker 调度 / Diagnostician 上下文与 llm.ts 分支与 transcript 范围）。全部结论带 文件:行号；生产数据经只读 SQLite 查询获得。

---

## Part 1 — 裁定

v0.2 的核心设计与方向**成立**；本轮发现 2 处 v0.2 事实性错误、2 处 v0.2 内部矛盾/设计缺陷、1 处遗漏契约缺口、1 处阶段重叠，全部已在 v0.3 修复。v0.1 审计报告有两处结论被本轮证据修正（按纪律不回改原文，以本报告为准）。

---

## Part 2 — 六项重点审查结果

### P0-1 Pending 状态机完整性 → 已定案（v0.3 §4.4.1）

**证实的 v0.2 矛盾**：§3.2 P-3"低置信度降级为待确认候选" vs §4.4"resolved_none = 判定 NONE **或低置信度**后的终态"——低置信度被同时定义为 pending 与终态。

**修复**：v0.3 §4.4.1 状态机：`pending_llm_review` →（CORRECTION≥θ_confirm）`admitted`｜（NONE≥θ_none）`resolved_none`｜（低置信度/LLM 超时/异常）attempts+1 回 pending →（≥5 或 TTL）`abandoned`。低置信度永不终态；超时永不记 NONE；不确定性不伪装为否定；上限 5 次防无限 LLM 调用；终态保留原因与证据。零新增人工审核。

### P0-2 持久化/幂等/事务 → 已定案（v0.3 §4.4.2-4.4.6）

一手复核事实：

- CREATE TABLE（gsa:347-363）：`decision TEXT NOT NULL` **无 CHECK**；`task_payload_json TEXT` 真实存在（既有 payload 载体，`isGovernanceTaskPayload` 校验于 :1232）；索引 `(decision, diagnostician_task_id)` :364-365。
- decision 全部写入点：仅 `insertAdmissionMarker` :699-705（硬编码 `'admitted'`）；无 UPDATE decision 的现存代码（仅 :1299-1300 UPDATE task link）。
- `logical_observation_key` 生成：Codex `codex|<rollout>|<turn>|user`（admission.ts:48）；WB `['workbuddy',session,generation]|user`（gsa:1126-1135）；UNIQUE 约束即全表全局（:362）。
- `admitOne`（:947-980）：**marker 预探 :952-963 对任何已存 key 返回 `already_admitted`，pending 行会返回空 canonical id** → 场景 A 不能复用 admitOne；并发 redelivery 冲突走 `convergeOnAdmittedMarker`（:718-732，要求 pain_events 行存在才收敛）。
- `admitCorrection` 事务（:789-818）：单事务 = pain 去重探针 + 限流消费（RateLimitedSignal 回滚）+ `insertCorrectionPain` + marker 插入。canonical id 由宿主身份事实派生（:777-785），与 LLM 结果无关 → pending→admitted 派生一致性成立。
- `ensureGovernanceDiagnosticianTask`（:1210-1318）：幂等（marker task-link 探针 :1217-1221）；确定性 task id；Case B 崩溃收敛（:1286-1297）；**provenance 硬编码 :1269**。
- reconcile Case A/B（:1650-1657）只扫 `decision='admitted'` → 新决策值惰性；同时为场景 C 的"marker 已 admitted 无 task link"提供现成恢复。

四场景处置（v0.3 §4.4.3-4.4.6）：A=专用确认函数（事务内 marker CAS UPDATE 先行，changes=1 才继续）；B=认领 CAS（载荷全文比对）+ 终态 CAS，双 worker 并发真实可能（**无 OS 级单实例锁**，手动 `pd-cli <host> worker` 可与 companion 并发）；C=LLM 结果先写 payload（崩溃后零 LLM 重做）+ 认领 TTL + 既有 reconcile/Case B；D=attempts 仅在完成 LLM 审查时计数（限流重试不计）、MAX=5、TTL=72h 自 created_at、内存过滤不要求 SQL 级。

**静默契约变更**：现行 ambiguous = "no pain, no task, no quota, and no marker"（gsa:772-774，§18 scenario 6）。pending marker 是对该契约的显式变更——v0.3 §4.4.8/§10 已如实声明。

### P1-3 OpenClaw 兜底 → 事实修正 + 诚实边界（v0.3 §3.5/§4.1）

**修正上轮审计（与本轮之前结论）**：确认消费**并非**由 correction_observer（默认 OFF）门控停止——双 flag 解耦，`signal_collector`（默认 ON）即以 confirmation-consumer-only mode 运行 15min 周期，周期先跑 `batchConfirmPendingSignals`（correction-observer-service.ts:237-242, 409-428）。生产 DB 只读复核：15 行 = confirmed 2 / rejected 7 / abandoned 6、**pending 0**、最新 09-28——无积压，机制在运行。

真实能力边界（v0.3 如实定义为 best-effort fallback）：

1. 入队条件：仅 ambiguous 且命中词非空；classifier 抛错与返回 null 同样入队（reason 区分 llm_classifier_threw / llm_result_unavailable，host:301-318）；入队 SQLite 写刻意保留在 before_prompt_build 同步栈（:326-330）。
2. **无行级 TTL**（schema 无过期列）；configured-but-down → 5 周期(~75min) attempts≥5 转 abandoned（信号丢失可查）；**unconfigured → 整批跳过且不计 attempts，永久 pending**（:94-102）。
3. 无周期外触发：pd-cli/openclaw-plugin/host-runtime 均无 signals/confirmations 命令；唯一消费者是插件进程内周期。
4. 可观察性充分：signal-health.json（pendingCount 等）、`pd config doctor`、SystemLogger 事件（7 天滚动）。
5. confirm 成功路径与实时路径共享同一限流 Map 实例（per-workspace 单例 host）。

v0.3 不改 flag 默认值、不加触发机制；§8 新增现状钉住测试（unconfigured 不计 attempts 等）。

### P1-4 词表与引用防护 → 逐词裁定 + 七类规则（v0.3 §3.2）

词表为代码内 SSoT：high overlay 8 词（gsa:113-123）+ CORRECTION_SEED_KEYWORDS 16 词（correction-types.ts:60-79，≥0.7→high）+ empathy overlay（:126-128）。裸子串 includes，零引号/否定/人称处理（keyword-stage.ts:22-31）。

关键事实：

- **Codex 子串路径零负向测试**：引用/转述/否定仅在 WB 路径有测试（workbuddy-live:92-118）；`他说这是错的` 在 Codex 路径**当前就是 STRONG**——实现+测试双缺口。
- `startsWith` 只是句首提示词闸门：前缀词与命中词可以不同（"搞什么…这是错的"→matched），非逐词防线。
- 学习词 TP≥3/FP=0 升 high 即直通是 **PRI-788 G3 有意设计**（gsa:167-178 + projectLearnedStore :191-197）→ v0.3 P-2 是显式逆转，已列入契约变更。
- "引用 Agent 原话 + 明确纠正、引号外无提示词"（任务书示例句不含词表词）→ 两路径均 not_a_signal：属检测覆盖边界，OpenClaw 可经 discovery 预算达 Stage 2，v0.3 如实声明不虚构解决。

v0.3 逐词裁定：降 high→ambiguous：`我说的是`/`都说了`；保留 high 加守卫：`这是错的`（位置）、`不是让你`/`谁让你`（否定前置）、`又搞错`/`搞错了`/`理解错了`（第三人称前置，矩阵不达标再降）；无条件保留：`不要自作主张`/`不应该这么做`/`你理解错了`/`you are wrong`。七类输入走向表见 v0.3 §3.2.2。

### P1-5 跨宿主语义一致性 + Diagnostician 现实 → 已修订（v0.3 §4.5/§4.6/§8）

v0.2 §4.5/§8 的"同一结果"表述改为：**统一语义契约与准入规则；相同输入+相同有效上下文→相同契约结果；上下文差异→置信度差异与保守降级是允许结果**。

Diagnostician 真实上下文（沿 executePendingDiagnosis→runner→assembler→builder 一手链路核实）：

- ✅ 可用：reasonSummary/source/severity/evidence[]、correctionEvidence（进 PHASE 1.5 专属块，bridge:408-432→assembler:404-425→builder:186-200）、10 条固定核心公理（core-axiom-block.ts:1-16）。
- ⚠️ 部分：conversationWindow（需 trajectoryTurnReader，仅 OpenClaw 注入；codex/wb worker 未注入→首轮恒空）、fullTrace（同 sourcePainId 的 state.db 任务，常不可用）、INTENT.md（`intent_engineering` 默认 false + 仅 OpenClaw 接线）。
- ❌ 不可用（未来方向）：Goal / Task Intent / **Owner ledger 原则（注入的是固定公理，非 Owner 原则——修正上轮审计 Part 4 表述）** / 跨任务历史 / 历史 Correction 汇总。

### P1-6 GFI 阶段重叠 → 已去重（v0.3 §6.4/§9）

分支事实：semantic(:247-260)/PARALYSIS(:284-292)/GFI(:296-307) 共享局部变量 painScore 且有求值顺序依赖（PARALYSIS 条件含 `painScore<paralysisScore`；GFI 仅在 painScore<30 时生效），但可独立删除（删前两者、painScore 置 0）。写行在 triage 前：eventLog :312-317 + trajectory.recordPainEvent :323-331。**GFI 分支不喂 trackFriction**（GFI 生产者在 host:724 / after-tool-call:251 / pain:545，属健康侧）。assistant_turn(:208-224)/task_outcome(:233-244) 与检测零耦合。

v0.3：Phase 0 = Semantic+Paralysis（检测+两处写行）；Phase C = GFI 触发与写入的唯一责任区。

---

## Part 3 — 四项次要优化结果

1. **Codex Transcript**：`.zst`/延迟建档仅 catch-up（flag-gated）与只读 CLI 消费 → 移出范围，定为"未来开启 ingestion 的前置条件"。**例外**：`parseRolloutFileName`（:34-44）被 `validateCodexTranscriptPath` ← `explicit-owner-statement.ts:96` 使用且**不受 flag 门控**——revert 格式文件名会使该会话上的显式 Owner 声明路径校验失败。处置：Phase 0 可选小修复或独立 follow-up。
2. **Worker 调度边界**：pd-companion 每 workspace spawn 单子进程，120s 周期（DEFAULT_INTERVAL_MS=120_000）；无 OS 锁；每周期恰 1 诊断任务、候选检查上限 5、后处理 LIMIT 2、RECONCILIATION_BUDGET=5；LLM 默认超时 300s（adapter:675，可每调用覆盖）、maxRetries:0；诊断串行；executePendingDiagnosis 幂等、lease 在 runner 内、重试预算 n=3、失败不耗 attemptCount。→ v0.3 §4.4.7：Stage-2 ≤2 条/周期 + 60s 短超时 + 认领 TTL + 墙钟守卫 + 串行步骤开闭纪律。
3. **PainIngress 字段映射**：`evaluatePainIngress` 四种 action 语义一手核实（pain-ingress.ts:157-239）：refuse=lineage 违例；automatic+unbound/无证据→observation_only（无任务无 LLM）；Owner+bound+无证据→degrade（诚实空证据提交）；其余 submit。provenance 由 `deriveProvenanceFromIngressFacts` 派生。完整映射表与**两个新发现缺口**（`PainIngressCorrelationV1` 无 workbuddy 变体 pain-ingress-payload.ts:44-55；装配器丢 workbuddy hostKind assembler:453-456）→ v0.3 §5 + §10。关键约束：映射必须让自动纠正至少携带触发文本 evidence 条目，否则 observation_only 会造成现有 Codex 准入能力回退。
4. **RuleHost 错误阻断**：v0.2 §1.4 三分保留；v0.3 补明"Gate Block 事实本身不得自动创建 Pain"（Phase A 删除 gate-block-helper.ts:198-275 自动路径）且不新增 RuleHost 独立检测器。

---

## Part 4 — UNVERIFIED 清单

1. Stage-2 分类在 60s 超时下的实际时延与 θ 阈值精度——实现期常量，须以 §8 矩阵实测（SPEC 将可观察性而非常量值定为验收对象）。
2. 双 worker 并发在同一 pending 行上的实际触发频率（机制已由 CAS 保证正确性；频率无生产数据）。
3. OpenClaw 用户态 correction_keywords.json 的实际内容与 seed 的偏离度（每工作区不同，未逐一读取）。
4. 已部署外部 RuleCode 对 `currentGfi` 的依赖（D4 只读扫描前置，未执行）。
5. `pd-cli <host> worker` 手动运行与 companion 并发的真实发生概率（无守卫是事实，发生史未知）。

## Part 5 — 对 v0.1 审计报告的修正声明

1. "消费者 flag correction_observer 默认 OFF → 队列停摆"——门控主体实为 signal_collector，消费周期在生产正常运行；"停摆"应表述为"低流量 + classifier 曾不可用导致的 6 行 abandoned"。
2. "Owner Principles 由 Diagnostician 上下文装配读 ledger"——实际注入固定 10 条公理，ledger 仅诊断后使用。

v0.1 报告按任务纪律不回改；v0.3 及本报告为权威表述。
