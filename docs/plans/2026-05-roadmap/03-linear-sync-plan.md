# 03 - Linear 同步计划：Phase 1B Runtime V2-only reset

> **更新日期**: 2026-05-23
> **原因**: ADR-0012 取消 OpenClaw idle/night scheduling 与 legacy parallel execution 的长期保留策略。

## 1. 已完成事实

以下工作已经合并，不应再次开同义实现任务：

| 能力 | 已完成 issues |
|------|---------------|
| L2 trace/refiner/sandbox/RuleHost 基础 | PRI-146、171、172、173、174、185、189-192 |
| Baseline/repair/chaos/live runtime stability | PRI-200、201、206-210、216-220、224、225 |
| Plugin inventory/anti-growth/first extraction | PRI-211、212、213、215 |
| CLI/read-model/lifecycle boundary slices | PRI-131、PRI-149 实际交付、PRI-198 |

## 2. 必须纠正的现有 issues

| Issue | 当前问题 | 同步动作 |
|------|----------|----------|
| PRI-149 Done | 标题声称删除 Nocturnal，但合并内容为 Tier 2 CLI boundary migration | 保持 Done；追加澄清评论，不将其视为 legacy 删除完成 |
| PRI-118 Backlog | 未提及 SourceTrace/FullTrace 已交付 | 更新为 remaining plugin trajectory I/O/evidence facade |
| PRI-119 Backlog | 过于保守，仍允许长期 legacy 并行 | 更新为 EvolutionWorker/Nocturnal live cutover |
| PRI-150 Backlog | bulk schema move 范围过大 | 更新为 inventory-first，小片迁移 |
| PRI-154 Backlog | 针对 legacy evolution JSONL | 更新为 Runtime V2 event visibility |
| PRI-162 Backlog | 描述可能令 core 读取 filesystem/env | 更新为 pure config contract + adapter-owned loading |
| PRI-183 Backlog | 文档已存在或已部分落地需先核查 | 改为文档对齐/验证任务 |
| PRI-184 Backlog | 旧描述偏向大规模占位测试 | 改为缺失 guard audit，优先退役/边界相关 invariants |
| PRI-175-181 Backlog | 围绕 legacy host/subagent/nocturnal workflow 扩建 | 取消或标记 superseded，必要能力重新归入 Runtime V2/SDK issue |

## 3. 新退役 issue 序列

| 顺序 | 标题 | 优先级 | 阻塞关系 | 执行者 |
|------|------|--------|----------|--------|
| 0 | Phase 1B reset: roadmap/ADR/Linear alignment | High | 无 | 本次 `PRI-226` |
| 1 | PD-owned runtime configuration and explicit scheduling SDK boundary | High | PRI-226 | 强 AI |
| 2 | Cut over EvolutionWorker and Nocturnal live execution to Runtime V2 | Urgent | 1，关联 PRI-119 | 强 AI |
| 3 | Isolate read-only historical Nocturnal artifact import/export | Medium | 2 | 强 AI 或严格限制的 Symphony |
| 4 | Delete Nocturnal execution modules, commands and obsolete compatibility surface | High | 2, 3 | 强 AI |
| 5 | Contract legacy tests and measure CI/runtime verification cost | Medium | 4 | Symphony 或强 AI |
| 6 | Replace plugin workspace discovery with PD configuration/SDK contract | High | 1，可与 2 并行 | 强 AI |

## 4. 价值闭环 issue

退役工作不替代产品价值工作：

| Issue | 状态动作 | 原因 |
|------|----------|------|
| PRI-148 RejectionFeedback Service | 提升为 Todo/High，尽快执行 | 关闭人工 reject -> 新学习循环缺口 |
| New: production rejection-to-feedback UAT | PRI-148 后创建/执行 | 证明真实价值闭环而非只验证结构 |

## 5. 禁止 dispatch 的描述

以下类型 issue 不应进入执行队列：

- 新增或完善 OpenClaw idle/night scheduling。
- 给 Nocturnal Trinity 新增行为、修复能力或新观察面，而非退役所需的最小修改。
- 把 host-specific workspace discovery 或文件/env loading 放进 `@principles/core`。
- 因历史文件存在而继续保留双轨执行。

## 6. Linear 评论标准

每个被修订或新建的 issue 必须写明：

- `Decision source`: ADR-0012。
- `Why now`: Runtime V2 已经通过 baseline/live/chaos 验证，双轨已从风险缓冲变为成本和故障来源。
- `Retirement rule`: caller cutover before deletion; historical reading read-only only.
- `Not allowed`: no new idle/night/nocturnal features, no broad unrelated refactor.
