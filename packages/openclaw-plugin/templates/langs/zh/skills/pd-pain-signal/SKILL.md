---
name: pd-pain-signal
description: 当 Owner 明确要求记录智能体行为问题、登记痛苦信号，或追踪某次反馈是否进入诊断管线时使用。自动痛苦检测仍由现有 Hook、宿主入口和 Runtime 负责。
disable-model-invocation: false
---

# PD Pain Signal

## 目标

把 Owner 的真实行为反馈交给现有 PD 痛苦登记与诊断管线，并保留原始陈述、来源和可用的会话证据。本技能不重写检测、去重、准入或诊断逻辑。

## 执行步骤

1. **先检查是否已登记。** 当前消息可能已经由 Hook 或宿主入口处理。若有真实回执，复用 pain/task 标识，不要重复提交。无法观测是否登记时，不得声称成功，也不要盲目重复写入。
2. **保留 Owner 原话。** 只记录 Owner 明确提供的陈述；不要补写技术根因、评分或工具失败事实。引用、工具输出和模型转述不能伪装成新的 Owner 提交。
3. **使用可信的宿主入口。**
   - 在发生问题的 OpenClaw 会话中，若 Owner 明确要求登记，使用宿主命令 `/pd-pain <问题描述>`。该命令由 OpenClaw 绑定真实当前会话。
   - 在会话外使用 CLI 时，只能绑定已知且已验证的会话：`pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --session "<session-id>" --json`。
4. **禁止猜测 session ID。** 不得猜测身份、扫描数据库、选择“最新”会话或用其他宿主的 ID 冒充当前会话。缺少必要会话标识时停止该 CLI 路径并说明原因。
5. **核验回执。** 只有实际回执证明登记成功，才能报告已登记；没有回执只能说尚未确认。

## 证据与成功标准

- 有真实 pain ID 只代表登记有回执，不代表诊断完成。
- 诊断产生候选，不代表候选通过准入。
- 必须查看 `admissionResults` / `candidateOutcomes` 中的实际 `admitted` 决策及对应的非空 `ledgerEntryIds`；不能只凭 `candidateIds` 非空宣布成功。
- `needs_evidence`、`deferred` 或明确的准入拒绝必须如实报告。不要绕过准入门，也不要为提高置信度而伪造轨迹。
- 原始 Owner 陈述、宿主轨迹、模型诊断、准入结果、Owner 审批和激活状态是不同类型的证据，不能混为一谈。

## 失败处理

- 登记失败：保留真实错误和宿主提供的下一步操作。
- 重复登记风险：先核对已有回执与幂等结果。
- 会话不存在或身份不可信：停止，不得猜测。
- CLI/Hook 不可用：转交 `pd-cli-operator` 检查状态；需要修复安装时转交 `pd-control`。
- Owner 要求查看后续候选：使用 `pd-review` 打开 Console；不要重新登记同一反馈。

## 禁止

- 不写 `.state/.pain_flag`，不调用 legacy `write_pain_flag`。
- 不伪造 Owner 原话、session ID、turn ID 或工具失败。
- 不重复提交已确认登记的事件。
- 不直接修改痛苦数据库、候选账本或准入状态。
- 不批准、激活或修改原则。
