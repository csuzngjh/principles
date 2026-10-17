# SPEC-PD-PRR-001 — Gate B 最小真实数据实验方案（v1.0，2026-10-17）

| 项目 | 值 |
|---|---|
| 状态 | **PLAN_READY / EXECUTION BLOCKED** — 方案设计完成；真实数据执行须经 Owner 批准 Owner Decision Card（D-01～D-05）|
| 上游 | `docs/specs/SPEC-PD-PRR-001-principle-pain-recall-v1.3.md`（§2 Gate B、§10.1 F 表）；Gate A 审计报告（基线 702d9223） |
| 目的 | **只回答一个问题**：授权 workspace 的真实历史数据里，有多少"选定资格"的有效原则能够找到**可信、正确归属、经过授权且只读可恢复**的原始 Pain 与轨迹证据 |
| 明确不做 | 不全库扫描、不跨 workspace、不向外部模型发送原始证据（默认 0 次）、不写入任何 SQLite/WAL、不做 Recall 实现、不做 Gate C/D |

> 本方案可在无真实数据授权的情况下先用**合成夹具**验证可执行性（本轮 Status：夹具预演=NOT_RUN，待方案随 PR 评审后按 D-01 结果决定）。真实测量从未开始：所有真实数据指标初始值均为 `NOT_MEASURED`。

---

## 1. 数据范围（A）

| 维度 | 首个实验边界 |
|---|---|
| Workspace | **恰好 1 个**，Owner 在 D-01 显式命名（如 PD 自身 workspace）；禁止跨 workspace 检索 |
| 宿主 | **恰好 1 个**：D-05 裁决的 Pilot 宿主（Gate A 建议：Codex 首选 / OpenClaw 次选 / WorkBuddy 暂缓） |
| 原则数量 | 少量：建议起点 **≤10 条**，按 §2 资格规则从该 workspace 有效性投影选出；不做全库遍历 |
| 记录资格 | 仅纳入**identity 与来源明确**的记录：canonical Ledger ID 可由 `resolveLedgerActivationId` 解析、`derivedFromPainIds`/`reuseEvidence` 可交叉核验的条目；身份歧义条目计入歧义指标而非样本身份 |
| 证据类型 | 仅授权披露的摘要级证据（Pain 结构化摘要、诊断摘要、Correction 摘录按 D-01 裁决）；**Raw 原文不在本轮读取范围**（即便宿主持有 rowid） |
| 禁止 | 全库 `pain_events`/`user_turns` 全表扫描；`limit` 之外的横向遍历；跨宿主数据库合并读取 |

## 2. 指标（B）

五项最小指标（每个 workspace × 宿主组合单独计数；同一原则/Pain 去重）：

| # | 指标 | 定义 | 分母来源 |
|---|---|---|---|
| M1 | Eligible Principle Count | 符合 D-02 资格规则的原则数（候选资格集合 ∩ D-02 裁决集合；已停用/撤回/从未有效激活原则按 D-02 裁决计或排除） | `readPromptActivationCandidates` + `resolveLedgerActivationId` + Ledger 生命周期 |
| M2 | Traceable Count | M1 中能沿 `derivedFromPainIds`(candidateId)→任务 seed `sourcePainId` 或 `reuseEvidence` 交叉核验定位**至少一个 canonical Pain** 的原则数 | PainChainReadModel 类既有链 + 任务/seed 受信 lineage |
| M3 | Complete Evidence Count | M2 中具备该 painId 可读摘要 + 来源标注 + `evidenceQuality ∈ {exact, excerpt_only}` 全部齐备的原则数（Correction/Diagnosis 缺失按 unavailable 记录，不算 fail 也算不 complete） | 授权读取的投影 |
| M4 | Ambiguous Attribution Count | 双匹配冲突计数：同一 candidateId 在多个 principle 条目、derivedFrom 与 reuse 交叉、一个 ID 命中多个来源的**显式判定次数**（**不得沿用 Map last-write-wins**） | `buildCandidateToLedgerEntryMap` 语义替代实现（显式化输出） |
| M5 | Unauthorized/Unavailable Count | 因未授权（D-01 未覆盖字段）、不可读（journal/schema 缺失）、过期/隔离（retention_class ∉ {operational, promoted}，正文置 NULL）、blob 过期（7 天孤儿宽限后 rowid 失效）而不可用的条目数 | `readLedgerFileState` availability + retention/blob 语义 |

**值语义规则（F-09 分栏，硬约束）**：

- 每个指标必须标注其证据类型：`SCHEMA_CAPABILITY`（静态可达）/ `FIXTURE_ONLY` / `AUTHORIZED_REAL_SAMPLE`；
- "没有数据"（真零：记录过且确认为 0）、"未授权"（分母未知）、`NOT_MEASURED`（未测量）三态**不得互换**；首实验前全部真实指标为 `NOT_MEASURED`，不是 0；
- 不输出任何未经验证的百分比、命中率或"覆盖率"单值汇总。

## 3. 安全约束（C）

1. **外发**：默认将原始证据发送到外部模型 **0 次**；只生成本机脱敏统计与允许披露的诊断结论。若 Owner 在 D-01 批准任何外发，逐字段生效并保留撤回方式，否则一律本地。
2. **日志**：不向任何日志/console/报告输出私密 Tool Call 参数、Raw 原文、Owner 原话全文；只允许聚合计数、ID 哈希或 D-01 明确许可的脱敏摘要。
3. **只读**：全部 SQLite 经 `SqliteConnection({readonly:true, bootstrapIfMissing:false})` 或 `openTrajectoryDbReadonly`/`createWorkspaceBehaviorEvidencePort` 同族策略（v1.3 §5.2 六条只读合同逐条适用）；禁止 bootstrap、schema migration/ensure、journal_mode 写入、checkpoint；Ledger 只经 `readLedgerFileState`。
4. **状态不变验收**：实验脚本必须自证——退出后对 `.pd`/`.state` 目录做前后快照比较（文件集、文件大小、journal mode），一致才视为运行成功；任何差异即为失败并 STOP 报告。
5. **边界**：所有读取限定 D-01 授权 workspace 路径；进程内拒绝任何指向该路径外的打开请求（fail-loud typed error，不静默降级）。
6. **产物**：脱敏统计输出到轮次临时目录（`.tmp/<topic>/`），绝不写入 `docs/` 原样；进入 PR 的只有聚合级结果。

## 4. 对照验证（D）

| 对照 | 内容 | 判定材料 |
|---|---|---|
| V1 双匹配冲突 | 同一 candidateId 归属一个 vs 多个 principle 的真实频率；显式 ambiguous 输出 vs Map last-write-wins 的差异 | M4 + 合成夹具先行验证判定逻辑 |
| V2 资格差异 | D-02 两种候选边界（有效激活集合 vs 注入集合）在真实数据中的差集大小；已停用/撤回原则的行为差异 | M1 两种口径分别计数 |
| V3 失效语义 | `ok_but_empty_ledger`（结构坏损归空）、`unreadable`、expired/quarantined 正文 NULL、blob 过期、pending observation（tails 未完成）横向读取拒绝 | M5 分类计数 + reasonCode 覆盖 |
| V4 Port 充分性 | PR #2048 `createWorkspaceBehaviorEvidencePort` 能否提供 M3 所需全部字段；不能则列缺口（单条精确只读查询的最小缺口清单） | Port 输出 vs M3 字段集 diff |
| V5 宿主差异 | Codex（observation/correctionEvidence 为主）vs OpenClaw（canonical Pain/user_turns）证据完整性差异 | M2/M3/M5 分宿主计数；**能力不对等如实呈现，不得对等推定** |

## 5. 执行顺序与门禁

```text
方案评审（本文档随 PR）
→ Owner 批准 D-01～D-05（决策卡）
→ B0 预注册冻结（任务样本身份、字段清单、评分口径、预算、STOP 条件）
→ 合成夹具预演（FIXTURE_ONLY，验证 V1~V5 判定逻辑 + 状态不变断言）
→ 真实只读测量（仅 D-01 授权范围）
→ 脱敏统计报告 + M1~M5 + V1~V5
→ Owner 复核：GATE_B_CONDITIONAL_GO / UNPROVEN / STOP
```

- 步骤"合成夹具预演"可在无真实授权下先行——但**不得**在预演中接触任何真实 workspace 路径。
- 真实测量开始即受 v1.3 §2 Gate B "准入/退出/失败/回滚" 四条约束约束；越权读取、写副作用、敏感泄露三者任一发生 → 立即 STOP 并回滚。
- 结果聚合报告回填 `docs/implementation-reports/`（新轮次文件），并按 F-15 在 Linear 工单留脱敏评论。

## 6. 与既有文档的关系

- 任务分类仍属 SPEC v1.3 §2 Gate B；本文件只细化"数据侧可执行计划"，不改变 A/C 组别定义、控制要求与停止规则；
- PRI-1000（A4 汇总）与 Recall 实现的启动依然需要 Owner 显式授权，本方案的 READY 不构成任何 Gate B 执行授权。

**Gate B 实验方案 v1.0 END**
