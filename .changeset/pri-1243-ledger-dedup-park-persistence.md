---
"@principles/core": minor
"@principles/pd-cli": minor
---

Ledger 写入安全与候选生命周期整改（PRI-1243，修复 2026-11-11 生产重复原则族的根因：park 不持久化 + 写层零查重 + create 裁决零审计）。

- **B1 Ledger 精确查重**：`addPrincipleToLedger` 在写入锁内做确定性查重（NFKC 等价折叠 + 空白折叠 + 标点保留 + 不折叠大小写；SHA-256 首比 + 规范化文本复比；仅对 candidate/probation/active）。命中不建新条目、返回既有原则；intake 将候选解析到既有原则并在锁外经 `appendReuseEvidence` 审计（`ai_owner/exact-dedupe-guard`），审计失败则整个 intake 失败（候选保持 pending）。并发写同一文本恰注册一条（跨进程测试）。
- **B2 持久化 Reuse Park + 自动幂等 + Owner 解除审计**：自动路径的 reuse park 统一由 intake service 持久化到候选 admission processing（`awaiting_owner/reuse_pending_owner`，唯一业务真源，telemetry 仅观察）。自动 intake 对已 park 候选直接重放既有 park（不重评 LLM、不写 Ledger、不改状态；同进程/重启/门禁关闭后均生效）。`pd candidate review --decide reuse|create` 是唯一解除通道：先落 append-only 解除审计（`reuse-park-release@1`，携带 ADR-0022 验证 Owner 身份/时间/理由/被解除 park 上下文），再清 park，后执行裁决；审计失败不静默成功，重试幂等。
- **B2.5 已解析候选种子拦截**：`reuse_selected`、`deduplicatedAgainst`、已 park 候选不再创建独立 Dreamer 学习链（diagnose 种子循环、Bridge 种子循环、review --decide create 种子、backfill 任务创建四处统一共享守卫，基于持久化身份 `principle_reuse` 与 admission processing 判定；读失败按 Rule 4 姿态 fail-open 且可观察）。正常新原则照常种子（负控制）。

Rule 2（uncertain→create）与 Rule 4（unavailable→create）策略未改；无新数据库、无新 Schema、无新 Feature Flag；存量数据零迁移。
