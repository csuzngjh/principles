# 01 - 当前状态实证审计

> **更新日期**: 2026-06-02
> **审计基准**: `origin/main` = `6d8fa62e`（初始）；2026-06-02 基于 Linear 完成工单同步
> **架构决策**: ADR-0012 将 Runtime V2 设为唯一 forward execution path，并退役 OpenClaw-coupled Nocturnal/idle 调度；ADR-0014 MVP-First Strategy

## 1. 已交付能力

### Runtime V2 与 L2/RuleHost

| 能力 | 交付 issue / PR |
|------|-----------------|
| Runtime V2 runners 与 successor dispatch | PRI-87 至 PRI-111 系列 |
| Source trace / fullTrace / deterministic refiner / shadow agent | PRI-171、PRI-189、PRI-190、PRI-191、PRI-192 |
| Refiner sandbox 与 RuleHost gate | PRI-172、PRI-173 |
| RuleHostWriter、approval context、live auto-correction safety | PRI-146、PRI-174、PRI-185、PRI-210 |
| ApprovalQueue 与 UI | PRI-145、PRI-147 |
| RuntimeState lifecycle facade | PRI-198 |

### 稳定性与真实链路验证

| 能力 | 交付 issue / PR |
|------|-----------------|
| Structured output repair/evidence contract | PRI-200、PRI-201 |
| Synthetic baseline 与 architecture guard | PRI-206、PRI-215 |
| Chaos JSON / pain dedupe/context budget / broken artifact / OOB defense | PRI-207、PRI-208、PRI-209、PRI-210 |
| Live pain intake 验证与 CLI 自动 intake | PRI-216、PRI-217 |
| Successor enqueue/backfill/provider timeout | PRI-218、PRI-219、PRI-220 |
| Release build 与 malformed metadata integrity | PRI-224、PRI-225 |

### MVP Track 交付（ADR-0014 后）

| 能力 | 交付 issue / PR |
|------|-----------------|
| MVP 控制面纠偏 + feature flag registry + proven-channel baseline | PRI-252、PRI-239、PRI-240 |
| Nocturnal / idle-trigger 退役（全链路 caller cutover + 删除） | PRI-227、PRI-228、PRI-229、PRI-230、PRI-231、PRI-119、PRI-242 |
| pd-console proven-channel 审批 UI + 三页化 + Demo workspace | PRI-244、PRI-245、PRI-246 |
| pd-cli 一键安装 + 多环境冒烟 | PRI-247、PRI-250 |
| MVP live pain 信号质量门控与证据保留 | PRI-253、PRI-255、PRI-256、PRI-257 |
| Confirm-first gate 持久化与指令状态清理 | PRI-266、PRI-270、PRI-286、PRI-287 |
| Diagnostician 弱模型鲁棒性 + taskId lineage 修正 | PRI-271、PRI-272 |
| Runtime V2 prompt activation 绑定 + activation reader contract | PRI-261、PRI-295 |
| Console 审批后端 API + activation record 修复 | PRI-260、PRI-262、PRI-263、PRI-264、PRI-265 |
| SchemaPromptAdapter（schema 驱动 prompt 生成） | PRI-283 |
| MVP seed 反馈通道（隐私保护） | PRI-285 |
| Plugin surface 清理与瘦身 | PRI-288、PRI-289、PRI-290、PRI-291、PRI-292、PRI-293、PRI-294、PRI-296 |
| PD-owned workspace config + OpenClaw hook workspace 绑定 | PRI-259 |
| E2E trap-task 驱动的 Story A' 验证 | PRI-273 |
| MVP 输入信号充分性（empathy 信号 + owner message） | PRI-274、PRI-277 |
| PRUNING_PIPELINE 架构文档 | PRI-183 |

### Plugin boundary 已完成的第一步

| 能力 | 交付 issue / PR |
|------|-----------------|
| Plugin core inventory | PRI-211 |
| Anti-growth guard | PRI-212 |
| 首批纯 utility 抽取到 core | PRI-213 |
| CLI/read model facade slices | PRI-131、PRI-149 实际交付、PRI-198 |

## 2. 已发现的架构事实

### Runtime V2 已可作为唯一前进路径

现有交付已覆盖：

- pain/candidate/internalization 的 synthetic 与 live validation；
- output repair、integrity remediation、provider timeout 分类；
- RuleHost sandbox/gate 和路径安全；
- operator CLI 与 canary/health 检查。

因此，不再需要保留第二套 Nocturnal 业务执行路径来“以防 Runtime V2 不可用”。

### Legacy 执行入口已切断（PRI-227~231、PRI-119、PRI-242 已完成）

Legacy Nocturnal/idle 执行入口已全部切断。以下 caller cutover 已完成：

| 已切断的路径 | 执行 issue |
|-------------|-----------|
| EvolutionWorker 切换到 Runtime V2 | PRI-119 |
| Plugin workspace discovery 替换为 PD-owned config | PRI-228 |
| OpenClaw idle/night 执行入口删除 | PRI-230 |
| Nocturnal legacy pipeline 删除 | PRI-230、PRI-242 |
| Legacy entrypoint census + no-new-caller guard | PRI-227 |
| CI 收缩（legacy 删除后测试收缩） | PRI-231 |
| EvolutionWorkerService 隔离到 MVP feature flag 后 | PRI-288 |
| Plugin hooks/services 缩减到 MVP surface | PRI-289、PRI-290、PRI-291、PRI-294 |

### Legacy 成本已大幅降低（退役进行中）

Legacy 代码已通过 PRI-227~231、PRI-119、PRI-242、PRI-288/289/290/291/292/293/294/296 大幅削减。剩余代码量需根据最新 main 分支重新评估。

`evolution-worker.ts` 与 `trajectory.ts` 仍是后续边界治理重点，但优先级已降低（MVP 期减法优先）。

## 3. 决策修订

### 原策略（已废止部分）

- 保留 OpenClaw idle/night trigger 以唤起 Runtime V2。
- 将 legacy files 冻结为长期保留资产。

### 当前策略

- Runtime V2 是唯一 forward execution path。
- OpenClaw 只作为可选 host adapter/event source，不作为 PD scheduler。
- 删除 idle/night-mode requirement；不再实现或扩展 `IdleTrigger` 宿主适配。
- workspace/runtime/model 配置向 PD-owned config/SDK boundary 收敛。
- legacy data 如确有存在，只允许 read-only import/export adapter；不以历史数据为由保留业务执行链。

## 4. 尚未完成的关键工作

| 主题 | 当前状态 | 下一动作 |
|------|----------|----------|
| Human rejection feedback | PRI-148 仍在 Backlog | MVP 用 Approval reject 简单路径；完整反馈闭环待外部需求 |
| Trajectory evidence boundary | PRI-118 仍在 Backlog | 降级为 backlog；trajectory facade 仍有 long-term 价值 |
| GETTING-STARTED 用户视角重写 | PRI-248 仍在 Todo | 执行中 |
| Story A' 录屏 | PRI-249 仍在 Backlog | 需完成 |
| 邀请种子客户 | PRI-251 仍在 Backlog | 需完成 |
| Codex CLI adapter | PRI-278~282 在 Backlog | 新增 host adapter 方向 |
| Secret redaction from telemetry | PRI-297 在 Todo | 执行中 |
| Schema/config ownership | PRI-150 已 Canceled | MVP 后再评估 |
| Runtime V2 event visibility | PRI-154 已 Canceled | MVP 后再评估 |

## 5. 不应继续执行的旧描述

- `PRI-149` 的标题仍称删除 Nocturnal，但已合并 PR 实际是 CLI Tier 2 boundary migration；Nocturnal 退役已由 PRI-227~231、PRI-119、PRI-242 完成。
- `PRI-143` 的 IdleTrigger 方向已被 ADR-0012 取代；代码已在退役 PR 中删除。
- `PRI-175` 至 `PRI-181` 中以 legacy subagent/nocturnal workflow 为中心的 host 扩展已全部 Canceled。
- 任何要求建立 OpenClaw idle/night scheduling 的 Phase 2 spec 均需修订。
- `PRI-258`（MVP evidence source）已 Canceled，不应恢复。
- `PRI-267`/`268`（Confirm-first gate 变体）已 Canceled，功能已由 PRI-266/270/286 覆盖。
- `PRI-275`/`276`（E2E 修复）已 Canceled，E2E 验证已由 PRI-273 重新实现。
- `PRI-120`（FocusHistory thin-adapter cleanup）已 Canceled，legacy 退役后不再适用。
