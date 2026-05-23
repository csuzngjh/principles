# 01 - 当前状态实证审计

> **更新日期**: 2026-05-23
> **审计基准**: `origin/main` = `6d8fa62e`
> **架构决策**: ADR-0012 将 Runtime V2 设为唯一 forward execution path，并退役 OpenClaw-coupled Nocturnal/idle 调度

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

### Legacy 执行仍在实际入口上

不能直接 `rm` 文件的原因不是要长期保留它，而是必须先改 caller：

| 仍在引用的路径 | 证据 |
|----------------|------|
| Plugin 注册/启动 `EvolutionWorkerService` | `packages/openclaw-plugin/src/index.ts` |
| EvolutionWorker 引用 `OpenClawTrinityRuntimeAdapter` 与 Nocturnal workflow | `packages/openclaw-plugin/src/service/evolution-worker.ts` |
| Nocturnal review/train/rollout 命令仍注册 | `packages/openclaw-plugin/src/index.ts`, `src/commands/nocturnal-*.ts` |

### Legacy 成本已经高于保留价值

| 文件 | 当前约行数 | 目标 |
|------|-----------:|------|
| `openclaw-plugin/src/core/nocturnal-trinity.ts` | 2,541 | 删除重复执行代码 |
| `openclaw-plugin/src/core/nocturnal-arbiter.ts` | 647 | 删除被 Runtime V2 validators 取代的执行合同 |
| `openclaw-plugin/src/service/nocturnal-service.ts` | 1,679 | 删除反思编排；不保留 idle/night trigger |
| **合计** | **4,867** | 显著减少代码及重复测试 |

`evolution-worker.ts` 与 `trajectory.ts` 仍是后续边界治理重点，但应先切断 legacy execution，再决定剩余拆分。

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
| Human rejection feedback | Approval UI 有了，反馈闭环未实现 | 优先执行 PRI-148 |
| Legacy runtime retirement | 仍有真实 caller | 以 ADR-0012 下的新退役 issue 序列执行 |
| Trajectory evidence boundary | SourceTrace core contract 已完成，plugin I/O god class 未收敛 | 重写并执行 PRI-118 |
| Runtime V2 event visibility | PRI-154 描述仍指 legacy evolution | 重写为 Runtime V2 telemetry/event log |
| Schema/config ownership | PRI-150/162 范围陈旧或违反纯 core 约束 | 拆小并重写后再做 |
| Test/CI cost | 双轨及重复合同仍增加测试量 | legacy 删除后执行测试收缩 issue |

## 5. 不应继续执行的旧描述

- `PRI-149` 的标题仍称删除 Nocturnal，但已合并 PR 实际是 CLI Tier 2 boundary migration；它不能被视为删除完成。
- `PRI-143` 的 IdleTrigger 方向已被 ADR-0012 取代；代码可在退役 PR 中删除或停止引用，不新增使用方。
- `PRI-175` 至 `PRI-181` 中以 legacy subagent/nocturnal workflow 为中心的 host 扩展必须先重新分类，不能原样开发。
- 任何要求建立 OpenClaw idle/night scheduling 的 Phase 2 spec 均需修订。
