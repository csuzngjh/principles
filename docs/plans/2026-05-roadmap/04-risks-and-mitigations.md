# 04 - 风险登记册 + 应对措施

> **生成日期**: 2026-05-18
> **风险评级**: P0=阻塞性，P1=高，P2=中，P3=低
> **配套文档**: [02-roadmap.md](./02-roadmap.md)

---

## 风险全表

| ID | 风险 | 评级 | 触发可能性 | 影响 | 应对状态 |
|----|------|------|-----------|------|---------|
| R-1 | AI 助手在不读 ADR 的情况下重做已完成的工作 | P1 | 高 | 工时浪费 + 代码冗余 | 已建 PRI-182 + 标准 11 段模板 |
| R-2 | 文档与代码双源真相分歧 | P1 | 高 | 误导 AI 决策 → 级联错误 | 已建 PRI-182 |
| R-3 | L1 容量随系统运转扩张压垮 LLM | P1 | 中 | LLM 行为退化 | 已通过 PRI-139 LRU 兜底；Pruning Action MVP 在 Phase 3 |
| R-4 | RuleHostWriter 实现错误造成生产 false positive | P0 | 中 | 误杀真实工具调用 | Shadow Mode 30 天 + GoldenTrace replay 强制 |
| R-5 | RejectionFeedback 死循环造成 token 失控 | P1 | 中 | 计费失控 | 已通过 PRI-141 三振机制兜底 |
| R-6 | Phase 2 BALM/LRAS/GAP 实施时偏离 ADR | P1 | 高 | 架构倒退 | PRI-184 + Pre-Implementation Check 段落 |
| R-7 | PRI-172 与现有 replay-adapter 重复实现 | P2 | 高 | 双倍维护 + 行为分歧 | 03-linear-sync-plan §3 中已标注，需先决议 |
| R-8 | pd-console Approvals UI 字段需求 PIArtifact 不产出 | P1 | 中 | UI 上线后字段缺失 | PRI-147/148 必须先调整 prompt schema |
| R-9 | Linear 工单描述漂移导致 AI 助手误判 | P1 | 已发生（PRI-170）| 重做工作 | 强制 Pre-Implementation Check + 取消机制 |
| R-10 | Symphony 工作区越界（PD 源码被 agent 改动）| P0 | 中 | 源码污染 + 不可信 commit | Project S 的 PRI-152 已 In Review |
| R-11 | SQLite 多进程并发死锁 | P1 | 低（已应对）| 流水线停摆 | 已通过 PRI-140 WAL + busy_timeout；ADR-0012 删除 IdleTrigger 依赖 |
| R-12 | Phase 2 启动过早导致 Phase 1 返工 | P1 | 中 | 双倍工作 | 02-roadmap §5 明确依赖关系 |
| R-13 | 架构守护测试无法覆盖 invariants 编号 | P2 | 中 | 不变量违反不报错 | 已建 PRI-184 |
| R-14 | TrainingExporter 双人审批被绕过 | P0 | 低 | PII 泄漏 / 模型污染 | hardcoded `requires_second_confirmation = true`，配置不可覆盖 |
| R-15 | 多 RuntimeAdapter 行为不一致 | P2 | 中 | 内部代理产出质量分裂 | BALM AgentManifest 强制声明 capability + 版本化评估 |

---

## R-1 — AI 助手重做已完成工作（PRI-170 是案例）

**症状**：AI 助手读了 issue 描述就开始写代码，没有先 grep 看文件是否已存在。PRI-170 要求"创建 GoldenTrace 域模型"，但 PRI-113 已经完成。

**根因**：
1. issue 描述只写"目标"，没写"现状"
2. 没有强制 AI 助手在动手前做事实核查的机制

**应对**：
- **每个 issue 强制包含 `Pre-Implementation Check` 段落**：列出需要 grep 验证的文件 + 假设
- **AI 助手如果发现现状与描述冲突，必须先停下评论而不是继续写代码**（已写入 [03-linear-sync-plan.md](./03-linear-sync-plan.md) §9）
- **Linear 维护者在审查 PR 时检查"是否使用了已存在的代码"**

---

## R-2 — 文档与代码双源真相分歧（IdleTrigger / retirement 案例）

**症状**：旧文档先将 IdleTrigger 写在 plugin，后又记录 core 策略实现；ADR-0012 进一步决定整个 idle/night scheduling 不再是产品目标。若不标注取代关系，AI 助手会继续实现已退役设计。

**根因**：
1. 文档作为"意图"被冻结，但代码实施时做了不同的选择
2. 没有定期审计机制

**应对**：
- **PRI-182 已建**：审计所有"组件应在 X 路径"的描述并修订
- **建立长期机制**：每个迁移类 PR 必须同步更新 `COMPONENTS.md` 和 `PD_SYSTEM_ARCHITECTURE.md`
- **架构守护测试增加 path assertions**（PRI-184 范畴）

---

## R-3 — L1 容量增长压垮 LLM

**症状**：Pruning Action 排到 Phase 3（约 5 个月后），期间 active principles 持续增长。

**根因**：剪枝是高风险操作，必须有人审批 + 回滚机制，所以排得晚。

**应对**：
- **已实施**：PRI-139 LRU 硬上限（默认 12，强制）+ defer_archive 通道（PRI-144 的一部分）已经构成兜底
- **观测**：用 `pd canary` 输出的 `active principles count`，超过 8（soft limit）时报 warning
- **Phase 3 加速**：如果 LRU 频繁触发，提前启动 Phase 3 第 4 个工单（Pruning Action MVP）

---

## R-4 — RuleHostWriter 误杀生产工具调用

**症状**：L2 通道激活后，RuleHost 误判一个正常的 `git status` 为危险操作并 block。

**根因**：LLM 生成的规则代码可能在边界情况上出错。

**应对（已设计在 PRI-146 中）**：
1. **Shadow Mode 30 天 Offline Replay**：必须在历史轨迹上跑过，false positive rate < 5%
2. **GoldenTrace 强制**：每条 rule 必须有正/负样本，否则 fail-closed
3. **forbidden patterns check**：硬编码的危险模式黑名单（已存在）
4. **shadow mode 期间监控误杀率**：超过阈值自动 deactivate
5. **Auto-promotion 限制**：只有 non-destructive scope 才能 confidence>=0.95 跳过审批（PRI-145 已实施）

---

## R-5 — RejectionFeedback 死循环

**症状**：人工拒绝 → AI 重新生成 → 又被拒绝 → 又重新生成 → token 烧光。

**应对（已实施 + 在 PRI-148 中强化）**：
1. **PRI-141 已实施**：`rejection_count >= 3` 触发 UNRESOLVABLE，停止再生
2. **PRI-148 强化**：`recordAndRequeue` 必须在创建新 Dreamer 任务前检查 rejection_count
3. **观测**：`pd canary` 输出 `unresolvable_task_count`

---

## R-6 — Phase 2 实施时偏离 ADR

**症状**：BALM 实施时把 AgentManifest 加载逻辑放到 plugin（应该在 core），或者 LRAS 直接在 core 里用 setInterval。

**应对**：
1. **PRI-184**：架构守护测试覆盖 BALM-1/2/3, LRAS-1/2/3, GAP-1, SCHED-1/2 等不变量（先用 it.todo 占位，等子系统落地后填实）
2. **每个 Phase 2 工单的 Forbidden 段落必须列出层级禁忌**
3. **Pre-Implementation Check 必须包含"读 ADR-0008/0009/0010/0011 至少一遍"的指令**

---

## R-7 — PRI-172 与现有 replay-adapter 重复

**症状**：`golden-trace-replay-adapter.ts` 已经做了 sandbox 注入（注释明确说"keep core free of node:vm imports"），但 PRI-172 又要新建 SandboxEvaluator。

**应对**：
- **必须先做 RFC 决议**（在 PRI-172 启动前）：
  - 选项 A：扩展现有 replay-adapter 支持 refiner 错误捕获 → 推荐
  - 选项 B：保留独立 SandboxEvaluator，明确二者职责差异
- **维护者在派发 PRI-172 给 AI 助手前必须先决议**
- 详见 [`02-roadmap.md`](./02-roadmap.md) §9

---

## R-8 — Approvals UI 字段缺失

**症状**：UI 设计要求 `summary / triggerReason / confidenceLabel / effectDescription / rejectionEffect` 5 个字段，但 PIArtifact 当前 schema 不产出这些字段。

**应对**：
- **必须先扩展 prompt schema**：让 LLM 在生成 PIArtifact 时同步产生 5 个字段
- **影响范围**：Diagnostician prompt + Compiler prompt 都要改
- **建议顺序**：PRI-147 启动前必须先有一个"扩展 PIArtifact schema with user-facing fields"的子工单或 PR

---

## R-9 — Linear 工单描述漂移

**症状**：PRI-170 已经发生过这种情况。

**应对**：
1. **本次同步计划解决一次性问题**（[03-linear-sync-plan.md](./03-linear-sync-plan.md)）
2. **建立长期流程**：每个 cycle 开始前对比 origin/main 重新审视 backlog 中的 issue 描述

---

## R-10 — Symphony agent 越界改 PD 源码

**症状**：Symphony 调度 ACPX/Claude 在 `D:\Code\principles` 而非 `D:\Code\principles-workspaces\<issue>` 工作（已在 PRI-151 smoke 中发生）。

**应对**：
- **PRI-152 In Review**：Symphony 强制 worker workspace boundary
- **不属于 PD 路线图的工作，但对 PD 安全至关重要**
- 在 PRI-152 合并前，禁止 Symphony 自动派发任何 PD 实施类工单

---

## R-11 — SQLite 多进程并发死锁

**已应对**（PRI-140 已合并）：
- WAL 模式
- `busy_timeout = 5000`
- 不再依赖 IdleTrigger；显式 Runtime V2 scheduling boundary 必须保留 SQLite 并发安全

**残留风险**：中。架构守护测试 PRI-184 应保留 WAL-1，并新增禁止新 OpenClaw idle/night/Nocturnal execution caller 的不变量；Jitter-1 不再适用。

---

## R-12 — Phase 2 启动过早

**症状**：Phase 1 还没完成就开始 BALM 实施，BALM 改 Peer Runner 的同时 PRI-146 也在改 RuleHostWriter，merge conflict 不可避免。

**应对**：
- **02-roadmap §5 明确依赖**：Phase 2A 不在 Phase 1A 完成前启动
- **触发条件**：Phase 1A 完成 + Phase 1B 完成 60% + L2 通道有至少 1 个 rule 跑通

---

## R-13 — 架构守护无法覆盖 invariants

**症状**：文档里有 AC-1 到 AC-12 等编号约束，但代码层面没有对应测试。

**应对**：
- **PRI-184 已建**：扩展 architecture-regression.test.ts，每个 AC-* 有对应 describe
- **Phase 2 子系统**：先用 `it.todo()` 占位（不变量在子系统落地前不可证伪）

---

## R-14 — TrainingExporter 双人审批被绕过

**应对（在 Phase 3 工单中预设）**：
- `requires_second_confirmation = true` 硬编码，config 不可覆盖（AC-3 不变量）
- `cooldown_hours = 24` 硬编码，config 不可覆盖（AC-5 不变量）
- 第二审批人必须不同于第一审批人（AC-4 不变量）
- 测试覆盖：尝试单人完成双重审批必须失败

---

## R-15 — 多 RuntimeAdapter 行为不一致

**应对**：
- **BALM AgentManifest** 强制声明 `preferred_runtimes` 和 `capabilities`
- **每个 Adapter 必须通过 conformance test suite**（在 BALM 实施时一并建立）
- **AgentVersioning 服务**：每个 adapter 切换前跑 sample 评估，对比基准 score

---

## 风险监控建议

| 监控项 | 监控方式 | 阈值 |
|--------|---------|------|
| L1 active principles count | `pd canary` | warning > 8, critical > 12 |
| `unresolvable_task_count` | `pd canary` | warning > 5, critical > 20 |
| ApprovalQueue pending count | `pd canary` | warning > 10, critical > 30 |
| Shadow mode false positive rate | per-rule eval | warning > 3%, critical > 5% |
| 文档 vs 代码 drift | 每月手工 review | 0 容忍 |
| 架构守护测试覆盖率 | CI 输出 | 目标 100% AC-* + Phase 2 todo |

---

## 风险升级路径

1. **P3 风险**：在本登记册记录，每月 review
2. **P2 风险**：本登记册 + 团队 sync 提及
3. **P1 风险**：本登记册 + 团队 sync 提及 + 在 issue 中明确标注
4. **P0 风险**：触发后立即停止当前阶段，专门 issue 处理
