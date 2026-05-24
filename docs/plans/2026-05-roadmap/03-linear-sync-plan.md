# 03 - Linear 同步计划：MVP-First 可执行队列

> **更新日期**: 2026-05-24（PRI-252 control-plane convergence）
> **当前决策来源**: [ADR-0014](../../adr/0014-mvp-first-strategy-and-product-pivot.md)
> **执行路线**: [07-mvp-first-pivot.md](./07-mvp-first-pivot.md)
> **延后工作重启条件**: [post-mvp-conditional-roadmap.md](../post-mvp-conditional-roadmap.md)

## 1. 派工规则

本文件是 Linear 派工的当前入口。与本文件冲突的历史 Phase 1C / Phase 1D 模板不得用于创建或恢复 issue。

1. 当前目标是用已实现且可验证的 `prompt`、`code_tool_hook` / RuleHost、`defer_archive` 三个通道邀请首位种子客户。
2. `skill` / `SkillFileWriter` 为 stretch goal，除非有记录的客户需求或维护者明确决定，否则不派工。
3. Attribution / WorkspaceLearningSummary / Provenance / Probation / Pruning-via-Attribution / BALM / LRAS / GAP / MissionScheduler 均为 post-MVP conditional work。
4. `PRI-239` 合并之前，不能声称 feature flag 注册是已执行的 PR gate；此阶段允许 bugfix、验证、文档和 legacy retirement。

## 2. 已完成事实

| 能力 | 已完成 issues |
|------|---------------|
| L2 trace/refiner/sandbox/RuleHost 基础 | PRI-146、171、172、173、174、185、189-192 |
| Baseline/repair/chaos/live runtime stability | PRI-200、201、206-210、216-220、224、225 |
| Plugin inventory/anti-growth/first extraction | PRI-211、212、213、215 |
| CLI/read-model/lifecycle boundary slices | PRI-131、PRI-149 实际交付、PRI-198 |
| MVP strategy pivot | ADR-0014 / PR #696；由 PRI-252 纠正残留冲突 |

## 3. 当前可执行队列

| Issue | 范围 | 状态策略 | 执行者 |
|------|------|----------|--------|
| PRI-252 | MVP-First 文档、Linear 与 agent gate 纠偏 | 先完成；阻止旧路线误派工 | 强 AI |
| PRI-239 | 可加载、可测试的 feature flag contract | PRI-252 后执行；不得顺带新增功能 | 强 AI |
| PRI-240 | proven-channel synthetic baseline fixtures | 只验证三个已实现通道 | 强 AI 或严格范围 Symphony |
| PRI-227 / PRI-119 / PRI-162 / PRI-230 | Runtime V2 cutover 与 Nocturnal/idle/plugin 复杂度退役 | 属于减法，可在边界清晰时推进 | 强 AI |
| PRI-244 / PRI-245 / PRI-246 | 现有三通道的 operator UI 与 demo | baseline 可信后推进 | 强 AI |
| PRI-247~251 | 安装、指南、录屏、多环境验证、邀请客户 | demo 可运行后推进 | 文档小项可 Symphony |

## 4. 已取消 / 条件重启队列

| Issue | 当前状态 | 规则 |
|------|----------|------|
| PRI-232 Attribution Pipeline | Canceled | 不重开；仅在 post-MVP §1 条件满足后新建重启 issue |
| PRI-233 WorkspaceLearningSummary | Canceled | 同上，见 post-MVP §2 |
| PRI-234 Bundled vs Evolved provenance | Canceled | 同上；不因为旧 ADR 描述恢复 |
| PRI-235 Activation Probation Window | Canceled | 同上 |
| PRI-236 Pruning Action via Attribution | Canceled | 同上 |
| PRI-243 SkillFileWriter | Backlog / stretch | 不进入首次客户邀请 critical path；有需求证据后再评审 |

## 5. Runtime V2 退役工作约束

退役工作不等于重建新架构。对 PRI-227、119、162、230 适用：

- `Decision source`: ADR-0012 + ADR-0014。
- `Why now`: Runtime V2 已通过 baseline/live/chaos 验证，双轨和 OpenClaw idle/night 绑定增加故障与测试成本。
- `Retirement rule`: caller cutover before deletion; historical reading remains read-only only when仍有明确数据需求。
- `Not allowed`: no new idle/night/nocturnal features, no broad unrelated refactor, no host-specific I/O in `@principles/core`.

## 6. Linear issue 模板最小要求

每个新 issue 或重新激活 issue 必须写明：

1. MVP 三问：不做的影响、可观察路径、禁用/回退路径。
2. 是否属于 MVP-Core、MVP-Quiet、MVP-Gone 或 post-MVP conditional。
3. 依赖的真实已合并能力，不得引用 canceled issue 作为当前依赖。
4. 不允许范围，尤其是 Attribution/Phase 1C/1D 和未验证通道扩张。
5. 测试与 operator 验证路径。

## 7. 历史记录

PR #696 合并时，本文件曾保留要求创建 PRI-232~236 的 Phase 1C/1D 模板。该内容与同一 PR 引入的 ADR-0014 冲突，已由 PRI-252 删除。历史 Attribution 构思保留在 ADR-0013、06 review 和 System Dynamics 文档中，仅作为条件重启后的输入，不是当前执行计划。
