# PD Constrained Action Environment v1.0 — 最新主干代码复审报告

- 日期：2026-11-28
- 来源：`csuzngjh/principles` 当前 `main`，HEAD `e30202366f53df60ccaf7589f7988cf445a52fba`
- 对比基础：早前代码审查使用的 `38862c6252aa03ab9652b15b58e6d344afdc0ae4`，到当前 HEAD **98 提交**
- 性质：只读静态审查，不改仓库、不运行测试、不验证生产状态
- 最终建议：**REVISE BEFORE IMPLEMENTATION**。战略方向保留，实施路径必须收敛，详见配套 v1.1 SPEC。

## 结论

原 SPEC 试图将一次工具调用的 RuleHost 升级为行为轨迹治理，这是正确方向。但在最新 PD 架构中，以“增加时间戳字段 + 处理历史数组 + 两条轨迹规则”开始实施存在较大误判风险，尤其没有解决证据结果、排序、保留、宿主能力和后台所有权的边界。

## 关键问题与处理

| 优先级 | 发现 | 相关生产代码 | 建议 |
|---|---|---|---|
| P0 | `requireApproval` 只是规则决策，OpenClaw 当前适配层记录事件后返回，不能证明工具暂停；Codex / WorkBuddy 只编码 deny | `openclaw-plugin/src/hooks/gate.ts`, `codex-adapter/src/codec/output-encoder.ts`, `workbuddy-adapter/src/codec/output-encoder.ts` | 轨迹 Pilot 只用可验证 Allow/Block；审批严格限制说明 |
| P0 | `tool_calls` 生产可写 `unknown`，但 `assembleBehaviorHistory` 验证只接受三态 | `host-runtime/src/production-pain-evidence.ts`, `host-runtime/src/behavior-history.ts` | 先真实负控；禁止直接过滤或伪造结果 |
| P0 | 结果可被后补、补缺时按补记时刻写入，DB ID/时间不是天然因果顺序 | `recordVerifiedToolOutcomes` | 不直接将 `created_at` 作为 occurredAt 用于时间先后 |
| P1 | Gate 只评估部分工具类，目标路径为空时提前 Allow | `host-runtime/src/production-rulehost-gate.ts` | 当前范围观测，不宣称所有跨工具行为都受治理 |
| P1 | `computeBehaviorFacts` 对可见窗口可输出 `priorReadOfTarget='no'`；OpenClaw 截断场景须单独证明 | `rule-context-v2.ts`, `openclaw-plugin/src/core/rule-context-assembler.ts` | 建负控；不可把“没看到”当“没发生” |
| P1 | 90 天默认 trajectory retention、governance observation 独立 7 天和同意边界 | `trajectory-retention.ts`, `governance-observation-store.ts` | 不混数据源；不能证明历史完全不存在 |
| P1 | PR #2810 已收敛为 Service Host 唯一后台调度，旧 Consumer 架构退役 | 合并 `2a5d707...` | 不新增或复活后台 RuleHost 轮询 |
| P1 | Codex、WorkBuddy 及 OpenClaw 的历史来源和缺失处理不一致 | 各宿主 context provider / assembler | 单宿主先行，不声称三宿主已具备完全等价的轨迹能力 |
| P2 | 原 Stage 1 直接加 `occurredAt` 是“先扩 ABI，后补证据” | `RuleToolCallRecord` 公共 ABI | 改为 Stage 0 审计、Stage 1 无 ABI 离线回放 |
| P2 | “两个复杂规则同时落地”范围太宽 | 原 v1.0 Stage 2 | 先一条 Shadow 轨迹规则，验证真实增量价值 |

## 应保留的决策

- `RuleContextV2` 和 `ToolSemanticRegistry` 作为现有复用基础。
- `RuleCode.evaluate(input, helpers)`、现有沙箱、Golden Trace 与对抗测试。
- Owner Approval、Shadow-first、Live 有条件晋阶和可停用。
- 基于行为事实，而非工具名称关键词决定原则是否适用。
- 不引入新 Agent、Policy DSL、Temporal DB、Capability Broker 或工作流引擎。

## v1.1 的设计收敛

1. v1.1 **暂不实现时间窗口判断**；先证明宿主原生行为发生时间与数据补记关系。
2. Stage 0 必须先证明 `unknown`、异步补记、截断与留存窗口的语义。
3. 先用现有历史数组做离线 Shadow 对照，不立即更改公共 ABI。
4. 限定在一个宿主、一个明确可解释的资源/动作场景。
5. 只在需要的狭窄位置修复现有上下文数据契约，不创建新系统。
6. 真实效果以“可核实有效机会、误拦、漏拦、正常任务完成、恢复能力”为准；不能只看拦截数。

## 输出文件

- `PD-CAE-SPEC-v1.1-20261128.md`：可作为后续架构评审和 Stage 0 的正式候选 SPEC。

## 来源（固定版本）

- [生产 Gate](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/production-rulehost-gate.ts)
- [行为历史构建](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/behavior-history.ts)
- [生产工具结果](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/production-pain-evidence.ts)
- [RuleContextV2](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/principles-core/src/runtime/internalization/rule-context-v2.ts)
- [Workspace History](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/host-runtime/src/workspace-behavior-evidence.ts)
- [数据保留](https://github.com/csuzngjh/principles/blob/e30202366f53df60ccaf7589f7988cf445a52fba/packages/principles-core/src/runtime/trajectory-retention.ts)
- [Service Host-only](https://github.com/csuzngjh/principles/commit/2a5d707704e310cdda88a5ac188312a27687a86d)

> 本报告没有执行 E2E 或读取用户本地 `D:\Code\principles` 的生产数据；不能将“存在源码路径”表述为所有宿主的生产行为已经可靠。
