# 03 - Linear 同步计划：MVP-First 可执行队列

> **更新日期**: 2026-06-02（MVP Track 进度同步）
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
| MVP 控制面纠偏 + feature flags + proven-channel baseline | PRI-252、PRI-239、PRI-240 |
| Nocturnal / idle-trigger 全链路退役 | PRI-227、228、229、230、231、119、242 |
| Console 审批 UI + 三页化 + Demo | PRI-244、245、246 |
| pd-cli 一键安装 | PRI-247 |
| MVP live pain 信号质量门控 | PRI-253、255、256、257 |
| Confirm-first gate 持久化与清理 | PRI-266、270、286、287 |
| Diagnostician 弱模型鲁棒性 | PRI-271、272 |
| Runtime V2 prompt activation 绑定 | PRI-261、295 |
| Console 审批后端 + activation 修复 | PRI-260、262、263、264、265 |
| SchemaPromptAdapter | PRI-283 |
| MVP seed 反馈通道 | PRI-285 |
| Plugin surface 清理与瘦身 | PRI-288、289、290、291、292、293、294、296 |
| PD-owned workspace config | PRI-259 |
| E2E Story A' 验证 | PRI-273 |
| MVP 输入信号充分性 | PRI-274、277 |
| PRUNING_PIPELINE 文档 | PRI-183 |

## 3. 当前可执行队列

| Issue | 范围 | 状态策略 | 执行者 |
|------|------|----------|--------|
| PRI-252 | MVP-First 文档、Linear 与 agent gate 纠偏 | ✅ Done | — |
| PRI-239 | 可加载、可测试的 feature flag contract | ✅ Done | — |
| PRI-240 | proven-channel synthetic baseline fixtures | ✅ Done | — |
| PRI-227 / PRI-119 / PRI-162 / PRI-228 / PRI-229 / PRI-230 / PRI-231 | Runtime V2 cutover 与 Nocturnal/idle/plugin 复杂度退役 | ✅ Done | — |
| PRI-244 / PRI-245 / PRI-246 | 现有三通道的 operator UI 与 demo | ✅ Done | — |
| PRI-247 | pd-cli 一键安装 | ✅ Done | — |
| PRI-253/254/255/256/257 | MVP release gate + live pain 信号质量门控与证据保留 | ✅ Done | — |
| PRI-259 | PD-owned workspace config | ✅ Done | — |
| PRI-260/262/263/264/265 | Console 审批后端 + activation 修复 | ✅ Done | — |
| PRI-261/295 | Runtime V2 prompt activation 绑定 + activation reader contract | ✅ Done | — |
| PRI-266/270/286/287 | Confirm-first gate 持久化与清理 | ✅ Done | — |
| PRI-271/272 | Diagnostician 弱模型鲁棒性 | ✅ Done | — |
| PRI-273 | E2E Story A' 验证 | ✅ Done | — |
| PRI-274/277 | MVP 输入信号充分性 | ✅ Done | — |
| PRI-283 | SchemaPromptAdapter | ✅ Done | — |
| PRI-285 | MVP seed 反馈通道 | ✅ Done | — |
| PRI-288/289/290/291/292/293/294/296 | Plugin surface 清理与瘦身 | ✅ Done | — |
| PRI-248 | GETTING-STARTED 用户视角重写 | ⏳ Todo | 强 AI 或文档 |
| PRI-249 | 故事 A' 录屏 | ⏳ Backlog | 内容产出 |
| PRI-251 | 邀请第一个种子客户 | ⏳ Backlog | 沟通 |
| PRI-297 | Secret redaction from telemetry | ⏳ Todo | 强 AI |
| PRI-278~282 | Codex CLI adapter 系列 | ⏳ Backlog | 强 AI |

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
