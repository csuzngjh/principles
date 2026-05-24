# PD 项目路线图：2026-05 版

> **状态**: Active / realigned for Phase 1B retirement
> **更新日期**: 2026-05-23
> **基准代码**: `origin/main` = `6d8fa62e`（PRI-225 / PR #693 已合并）
> **决策修订**: [ADR-0012](../../adr/0012-runtime-v2-standalone-scheduling-and-legacy-retirement.md)

## 当前结论

PD 已不再处于“先证明 Runtime V2 是否可行”的阶段。已经完成的 baseline、live validation、repair、integrity 和 RuleHost 安全工作，足以把 Runtime V2 定为唯一前进路径。

本路线图现在聚焦两项目标：

1. **闭合真实价值循环**：补齐人工 rejection feedback，并持续用真实 workspace/UAT 验证 pain -> internalization -> activation/feedback。
2. **快速减少维护面**：停止保留重复的 OpenClaw Nocturnal/idle/night 执行链，先切断生产入口，再删除 legacy 实现和只保护该路径的测试。

## 决策变化：为什么现在要删除 legacy

旧策略将 `nocturnal-trinity.ts`、`nocturnal-arbiter.ts`、`nocturnal-service.ts` 标记为冻结，是为了在 Runtime V2 未证明前避免破坏唯一可能的运行路径。

现在证据改变了：

- Runtime V2 的核心 pipeline、synthetic baseline、live intake、repair/recovery 和安全守卫已落地。
- legacy 主执行文件仍约 4,800 行，并且 `EvolutionWorkerService` 与 Nocturnal 命令仍会造成第二控制平面。
- 双轨代码增加 CI 时间、评审范围和故障定位歧义。
- PD 没有需要长期兼容的外部用户；继续保留重复执行链的收益低于成本。
- OpenClaw 空闲/夜间触发不再是产品需求。PD 内置代理应由 PD 的配置、SDK、operator command 或未来 scheduler 驱动，而不是与 gateway idle 状态绑定。

因此，“冻结”现在只表示**不再向 legacy 增加功能**，不表示永久保留。退役工作本身是 Phase 1B 的主线。

## 文档导航

| 文档 | 用途 |
|------|------|
| [01-current-state.md](./01-current-state.md) | 当前已合并能力与残留负债 |
| [02-roadmap.md](./02-roadmap.md) | 新 Phase 顺序、依赖与退出标准 |
| [03-linear-sync-plan.md](./03-linear-sync-plan.md) | Linear 更新/新建/取消清单 |
| [04-risks-and-mitigations.md](./04-risks-and-mitigations.md) | 风险登记，部分 IdleTrigger 条目待按 ADR-0012 清理 |
| [05-integrated-stability-and-refactoring-blueprint.md](./05-integrated-stability-and-refactoring-blueprint.md) | 已完成稳定性基线及新退役策略 |

## 阶段状态

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase 0: low-risk pipeline | Done | Pain -> activation 的基础路径已验证 |
| Phase 1A: L2 / RuleHost safety | Functionally done | RuleHostWriter、sandbox/gate、approval UI/context、full trace/refiner 已落地 |
| Phase 1B: stability + runtime consolidation | In progress | 206-225 稳定性主线已完成；下一主线是 legacy/idle/plugin 退役 |
| Phase 1C: feedback loop | Partial | Approval UI 已完成；`PRI-148` RejectionFeedback 仍需实施 |
| Phase 2+ | Hold | 仅允许整理定义；在 Phase 1 价值闭环和退役完成前不扩建 |

## 立即执行顺序

1. `PRI-226`：路线图/ADR/Linear 对齐（本次文档工作）。
2. `PRI-148`：RejectionFeedback 闭环，确保人工拒绝能进入新一轮学习。
3. Runtime V2-only retirement sequence：显式调度/config boundary -> EvolutionWorker/Nocturnal cutover -> 历史读取隔离 -> 删除执行代码 -> 测试收缩。
4. `PRI-118`：更新为 trajectory evidence I/O boundary，支持唯一 Runtime V2 路径的可观测性。
5. `PRI-154`：更新为 Runtime V2 pipeline event logging，不再补 legacy evolution pipeline。

## AI 执行纪律

- 开工前读取 `AGENTS.md`、`CLAUDE.md`、`docs/ERROR_EXPERIENCE_HANDBOOK.md` 和 ADR-0012。
- 若 issue 提到新增 Nocturnal 执行、OpenClaw idle/night scheduling 或保留双轨，必须停止并要求修订 issue。
- legacy retirement PR 只能按“切 caller -> 验证 -> 删除”顺序，不得先删除仍有生产引用的文件。
- 删除代码的 PR 必须同时删除无价值的重复测试，并说明保留哪些迁移/E2E/chaos tests。
- 不将新的 host/workspace 发现逻辑塞入 plugin；配置/调度应向 PD-owned SDK/config boundary 收敛。
