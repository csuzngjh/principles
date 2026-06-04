# PD 项目路线图：2026-05 版

> **状态**: Active / **MVP-First Track**
> **更新日期**: 2026-06-02（v3.1 — MVP Track 进度同步）
> **基准代码**: `origin/main` = `b4444507`（PR #696 合并后）；2026-06-02 基于 Linear 完成工单同步
> **主决策**:
> - **[ADR-0014](../../adr/0014-mvp-first-strategy-and-product-pivot.md)（MVP-First Strategy）★ 当前主决策**
> - [ADR-0012](../../adr/0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md)（Runtime V2-only，仍生效）
> - [ADR-0013](../../adr/0013-attribution-pipeline-and-decision-observability.md)（已 Superseded by ADR-0014, deferred）
> **执行文档**: [`07-mvp-first-pivot.md`](./07-mvp-first-pivot.md)
> **被推迟工作的重启条件**: [`../post-mvp-conditional-roadmap.md`](../post-mvp-conditional-roadmap.md)

## 当前结论

PD 进入 **MVP-First 阶段**。所有架构演进暂停，目标是在 **4-6 周内邀请第一个真实种子客户**。

**产品定位重新校准**：PD 不治理工具级错误（这是 OpenClaw / Claude Code 的职责），PD 治理的是 **AI agent 的"行为品格"**——跨会话、跨任务的稳定性格性偏差。

**MVP 故事 A'**：把零散教训沉淀成稳定品格。演示链路覆盖三个已经实现且可观察的激活通道（prompt / RuleHost / defer_archive）。`skill` 为需求触发后的 stretch，不阻塞首次客户邀请。

## 文档导航

| 文档 | 用途 |
|------|------|
| [01-current-state.md](./01-current-state.md) | 当前已合并能力与残留负债 |
| [02-roadmap.md](./02-roadmap.md) | MVP Track 总图 + Phase 状态 |
| [03-linear-sync-plan.md](./03-linear-sync-plan.md) | Linear 工单同步（部分被 07 取代）|
| [04-risks-and-mitigations.md](./04-risks-and-mitigations.md) | 风险登记（含 MVP Track 风险）|
| [05-integrated-stability-and-refactoring-blueprint.md](./05-integrated-stability-and-refactoring-blueprint.md) | 稳定性基线参考 |
| ~~[06-ahe-informed-architecture-review.md](./06-ahe-informed-architecture-review.md)~~ | **Superseded by 07**；保留作历史档案 |
| **[07-mvp-first-pivot.md](./07-mvp-first-pivot.md) ★** | **MVP-First 当前执行文档** |
| **[09-plugin-slimming-and-sdk-hardening.md](./09-plugin-slimming-and-sdk-hardening.md)** | **插件瘦身、旧功能删除、SDK/Core 固化执行方案** |
| [`../post-mvp-conditional-roadmap.md`](../post-mvp-conditional-roadmap.md) ★ | 被推迟工作的重启条件清单 |

## 阶段状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 0: low-risk pipeline | Done | Pain → Activation 基础路径已验证 |
| Phase 1A: L2 / RuleHost safety | Done | RuleHostWriter / sandbox / approval 已落地 |
| Phase 1B P1: stability baseline | Done | PRI-200~225 完成 |
| Phase 1B P2: Nocturnal retirement | Done | PRI-227~231、PRI-119、PRI-242 已完成 |
| ~~Phase 1C: value loop closure~~ | Cancelled / Deferred | ADR-0014 取消；重启条件见 post-mvp §1 |
| ~~Phase 1D: lean foundations~~ | Cancelled / Deferred | 同上 |
| **MVP Track (Week 1-6)** | **Active** | **Week 1-4 完成，Week 5-6 部分完成，进入种子客户邀请阶段** |
| Phase 2+ (BALM/LRAS/GAP/MissionScheduler) | Hold | 准入门槛改为外部反馈驱动 |

## 立即执行顺序

1. ✅ ADR-0014 + post-mvp-conditional-roadmap + 07-mvp-first-pivot 已写
2. ✅ ADR-0013 / 06-评审 / SD-v2.0 顶部 Superseded 注记
3. ✅ 02-roadmap.md 修订（删除 Phase 1C/1D 主线）
4. ✅ README.md / AGENTS.md / 活跃架构索引由 PRI-252 纠偏
5. ✅ Linear: PRI-232~236 canceled，禁止从历史文档恢复
6. ✅ Linear: PRI-243 移出 critical path；PRI-240 改为 proven-channel baseline
7. ✅ PRI-239: feature flag contract 已实现并测试
8. ✅ PRI-240 / PRI-242: proven-channel baseline + legacy retirement 已完成
9. ✅ PRI-244/245/246: Console 审批 UI + 三页化 + Demo 已完成
10. ✅ PRI-247: pd-cli 一键安装已完成
11. ✅ PRI-253~296（排除 Canceled/Backlog）: MVP live pain / confirm-first / diagnostician / plugin 瘦身等已完成
12. ⏳ PRI-248: GETTING-STARTED 用户视角重写（Todo）
13. ⏳ PRI-249: 故事 A' 录屏（Backlog）
14. ⏳ PRI-251: 邀请第一个种子客户（Backlog）
15. ⏳ PRI-297: Secret redaction from telemetry（Todo）
16. ⏳ PRI-278~282: Codex CLI adapter 系列（Backlog）

## AI 执行纪律（v3.0 强化）

- 开工前读取 `AGENTS.md`、`CLAUDE.md`、`docs/ERROR_EXPERIENCE_HANDBOOK.md`、`ADR-0014`、`07-mvp-first-pivot.md`、`post-mvp-conditional-roadmap.md`。
- 任何 issue 引用 ADR-0013 / 06-评审 / SD-v2.0 / Phase 1C/1D 要求"现在实施"，必须停止并核对 ADR-0014 与 post-mvp-conditional-roadmap.md 的重启条件。
- 每个新 issue 必须答 **MVP 三问**：不做会怎样 / 怎么观察 / 怎么关闭。答不出 issue 拒收。
- `PRI-239` 合并前不新增功能面；允许修复、验证、文档和退役工作继续。`PRI-239` 合并并验证 loader 后，新增功能必须先在 `feature-flags.yaml` 注册。
- 任何"为未来 Phase 铺路"的抽象、"为完整性"添加的组件、"为优雅"做的重构，全部要求维护者本人确认。
- legacy retirement PR 只能按"切 caller → 验证 → 删除"顺序，不得先删除仍有生产引用的文件。
- 删除代码的 PR 必须同时删除无价值的重复测试，并说明保留哪些迁移/E2E/chaos tests。
