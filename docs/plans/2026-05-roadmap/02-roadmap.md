# 02 - 路线图：Runtime V2 收敛与价值闭环

> **更新日期**: 2026-05-23
> **基准**: `origin/main` = `6d8fa62e`
> **主决策**: [ADR-0012](../../adr/0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md)

## 1. Phase 状态

| Phase | 状态 | 当前结论 |
|-------|------|----------|
| Phase 0: low-risk E2E | Done | 已打通并有真实/合成验证 |
| Phase 1A: L2 / RuleHost safety | Done for implementation | 保留运行验证，不继续扩展基础设施 |
| Phase 1B: stability and consolidation | In progress | 稳定性/chaos 交付完成大部；转入 legacy/idle/plugin 退役 |
| Phase 1C: human feedback | Partial | UI 已有；RejectionFeedback 未闭环 |
| Phase 2+ | Paused | 待 Phase 1 的单一路径与真实价值闭环成立 |

## 2. Phase 1B 新主线：删除重复执行系统

目标不是“把 legacy 优雅保养好”，而是**尽快只剩一条可诊断的 Runtime V2 路径**。

```text
ADR / backlog alignment (PRI-226)
        |
        +--> PD config + SDK/operator scheduling boundary
        |           |
        |           v
        +--> EvolutionWorker / NocturnalWorkflow cutover
                    |
          +---------+---------+
          v                   v
 historical read/export   commands and execution retirement
 isolation                     |
                               v
                       test/CI contraction
```

### 2.1 必须执行的退役切片

| 顺序 | 工作 | 目的 | 执行风险 |
|------|------|------|----------|
| 1 | PRI-226 roadmap/ADR/Linear alignment | 防止代理按旧设计继续造 idle/nocturnal 功能 | Docs only |
| 2 | PD-owned config/SDK scheduling boundary | 允许显式调度，不依赖 OpenClaw idle | High |
| 3 | EvolutionWorker/Nocturnal workflow cutover | 删除 live legacy caller | High |
| 4 | Historical Nocturnal read/export isolation | 保留确有数据价值的只读能力 | Medium |
| 5 | Delete legacy execution and commands | 删除 Trinity/Arbiter/Service/Artificer 重复执行路径 | High |
| 6 | Contract/test/CI contraction | 删除只保护已退役路径的测试并量化 CI 改善 | Medium |

### 2.2 退出标准

- OpenClaw plugin 不再启动 Nocturnal business execution 或 idle/night scheduler。
- Runtime V2 可通过 PD-owned config/SDK/operator entrypoint 启动、排队、恢复和观察。
- `nocturnal-trinity.ts`、`nocturnal-arbiter.ts`、`nocturnal-artificer.ts`、`nocturnal-service.ts` 的重复执行逻辑已删除。
- 历史读取如保留，模块为 read-only、有限、独立且有数据存在证据。
- 删除对应 obsolete tests 后，保留的 Runtime V2 E2E/chaos/migration tests 全部通过，并记录 CI 时间变化。

## 3. Phase 1C：必须并行推进的价值闭环

`PRI-148` 不因 legacy retirement 而失去优先级。没有 rejection feedback，系统即使成功生成规则，也无法从用户否决中学习。

| 工作 | 依赖 | 结果 |
|------|------|------|
| PRI-148 RejectionFeedback Service | 已有 ApprovalQueue/UI 与 RuleHost 基础 | reject -> structured feedback -> new Dreamer task / unresolvable outcome |
| Production feedback-loop UAT（待创建） | PRI-148 | 在真实 workspace 证明 rejection 反馈链 |

## 4. 保留但必须重写范围的旧 issues

| Issue | 处理 |
|-------|------|
| PRI-118 | 保留；对齐 SourceTrace/FullTrace 已完成事实，只负责 plugin trajectory I/O facade / evidence boundary |
| PRI-119 | 改为执行 cutover，不再仅 inventory 或“保持用户行为不变”地长期保留双轨 |
| PRI-120 | 后置；FocusHistory 不阻塞 legacy execution 退役 |
| PRI-150 | 拆分为 schema inventory + 小规模迁移，不做 bulk move |
| PRI-154 | 改为 Runtime V2 pipeline event visibility，不再补充 legacy evolution 事件 |
| PRI-162 | 改为 pure config contract + adapter loading；禁止 core 读 YAML/env/filesystem |
| PRI-184 | 改为退役和关键 contract 的 missing guard audit；不增加无意义占位测试 |

## 5. 明确取消/取代

| 项目 | 理由 |
|------|------|
| OpenClaw IdleTrigger/night-mode 继续开发 | 产品不再需要，且增加插件耦合与复杂状态 |
| PRI-149 旧标题所表达的“已完成删除” | 交付内容实际为 CLI boundary migration，删除仍需新的 cutover 序列 |
| PRI-175 至 PRI-181 原样实施 | 大多围绕即将退役的 legacy workflow；需取消或重定义 |
| Phase 2 MissionScheduler 基于 IdleTrigger 的描述 | 调度器应 PD-owned 且 host-agnostic，不能以 idle trigger 为入口 |

## 6. Issue 分配建议

手工强 AI：

- PRI-148。
- 配置/SDK 调度 boundary。
- EvolutionWorker/Nocturnal workflow cutover。
- legacy execution 删除与真实 workspace smoke。

Symphony 可处理：

- Docs/ADR 对齐后续检查。
- 静态 forbidden-import guards。
- 退役后 CI/test inventory 与删除候选报告。
- PRI-183 文档修订（先更新其描述）。
