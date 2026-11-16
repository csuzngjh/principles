---
"@principles/core": minor
"@principles/pd-cli": minor
"principles-disciple": patch
---

Ledger 写入安全与候选生命周期整改（PRI-1243，修复 2026-11-11 生产重复原则族的根因：park 不持久化 + 写层零查重 + create 裁决零审计）。

- **B1 Ledger 精确查重**：`addPrincipleToLedger` 在写入锁内做确定性查重（NFKC 等价折叠 + 空白折叠 + 标点保留 + 不折叠大小写；SHA-256 首比 + 规范化文本复比；仅对 candidate/probation/active）。命中不建新条目、返回既有原则；intake 将候选解析到既有原则并在锁外经 `appendReuseEvidence` 审计（`ai_owner/exact-dedupe-guard`），审计失败则整个 intake 失败（候选保持 pending）。并发写同一文本恰注册一条（跨进程测试）。
- **P2-01 并发查重自我证据区分**：适配器在锁内以存活原则的 `derivedFromPainIds` 判定归属（`exactDedupResolution.survivorAlreadyDerivedFromThisCandidate`）——同一候选的并发/重试写落到自己的原则上是幂等重放（绝不给自己追加 reuseEvidence），不同候选命中才是需要审计的复用；跨进程子进程 + 起跑栅栏验证。
- **B2 持久化 Reuse Park + 自动幂等 + Owner 解除审计**：自动路径的 reuse park 统一由 intake service 持久化到候选 admission processing（`awaiting_owner/reuse_pending_owner`，唯一业务真源，telemetry 仅观察）。自动 intake 对已 park 候选直接重放既有 park（不重评 LLM、不写 Ledger、不改状态；同进程/重启/门禁关闭后均生效）。
- **P1-01 可恢复 Owner 决策生命周期**：`pd candidate review --decide` 改为三阶段——Phase A 持久化类型化决策意图（admission `ownerDecisions`，`executionStatus: pending`，稳定 decisionId，park 不清除；同一裁决重跑=resume，不同裁决仅在旧意图可证未执行时允许 supersede）；Phase B 经 intake 的持久化决策执行通道执行（锁内复验记录、INV-R08 对当前提案复验、appendReuseEvidence 幂等且携带 decisionId）；Phase C 单事务写齐 applied + 解除审计（`reuse-park-release@1`）+ processing complete。每个崩溃窗口（意图后/证据后/Ledger 后/完成响应丢失）重跑同一裁决即恢复，Owner 无需重新选择；自动路径遇 pending 决策一律拒绝（`owner_decision_pending`，不覆盖）。
- **P1-02 候选级跨进程协调锁**：锁原语抽为 core 内部模块 `ledger-file-lock.ts`（公共导出面不变）；文件适配器提供 `withCandidateCoordination`（`<stateDir>/candidate-coordination/` 按候选隔离，O_EXCL + PID 存活清理，候选锁→Ledger 锁固定顺序，锁内禁 LLM/网络）。intake 的 re-check→write 竞态窗口（含 park 创建）全部收进锁内闭合：并发双 intake 恰一写入、评估期间对方 park 则锁内拒绝、死持有者可回收、活持有者 fail-loud 不绕过。
- **P1-03 Park 优先级与通道收紧**：裸 `reuseDecision` 回调不再豁免 park（注入回调≠Owner 授权，仅持久化 pending 决策可跨 park）；Bridge 全分支复核——pending 决策候选不消费、不种子、不 complete，经 reuseReviewRequired 通道上报并给出 resume nextAction；种子抑制守卫新增 `owner_decision_pending` 维度。
- **B2.5 已解析候选种子拦截**：`reuse_selected`、`deduplicatedAgainst`、已 park、pending 决策候选不再创建独立 Dreamer 学习链（diagnose 种子循环、Bridge 种子循环、review --decide create 种子、backfill 任务创建统一共享守卫，基于持久化事实判定；读失败按 Rule 4 姿态 fail-open 且可观察）。正常新原则照常种子（负控制）。
- **P2-02 Bootstrap 迁移使用存活 ID**：T-NN 迁移改用 `addPrincipleToLedger` 返回的存活者——命中同文本既有原则时训练行按 legacy 形态要求（key===principleId）重键到 canonical id 并保留全部训练数据（多重汇聚显式合并计数并告警，绝不静默丢行），选择按 canonical 去重；重跑幂等；不再出现 `Principle T-NN not found in ledger tree`。
- **B1 审计 painId 回退**：pain 诊断持久化是开关量（`pain_diagnosis_persistence`），关闭的工作区里查重审计原本必然失败——Bridge 现将其权威 pain 上下文作为 `painIdHint` 回退传入（存储行优先），修复了 codex-adapter workspace-worker 积压测试所确定性复现的整周期退化。

Rule 2（uncertain→create）与 Rule 4（unavailable→create）策略未改；无新数据库、无新 Schema、无新 Feature Flag；存量 admission 文档零迁移（`ownerDecisions` 为可选字段，旧文档照常解析）。
