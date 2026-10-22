---
name: pd-review
description: 当 Owner 要查看 PD 诊断结果、原则候选或治理状态，或提出批准、拒绝、激活等治理请求时使用。所有 Owner 决策必须由 Owner 在正式 Web Console 中完成。
disable-model-invocation: false
---

# PD Review

## 目标

帮助 Owner 查看真实证据并进入 PD 正式治理界面。技能可以查询、解释和打开 Console，但不能代替 Owner 决策。

## 流程

1. 确认目标是 PD 的痛苦、诊断、候选或原则治理，而不是普通代码评审。
2. 使用 `pd-cli-operator` 或已有真实回执核对状态。区分 Owner 原话、宿主轨迹、模型诊断、准入决定和已发生的治理动作。
3. 使用当前 OpenClaw 宿主确认的工作区打开 Console：`pd console open --workspace "<workspace>"`。不要猜测工作区。
4. 只有命令真实返回成功时才报告 Console 已启动。若失败，保留错误并转交 `pd-control` 排查宿主安装。
5. 告知 Owner 在 Console 中查看证据并亲自完成批准、拒绝或其他治理操作。

## 状态边界

- 候选存在不代表已批准。
- 打开 Console 不代表已批准。
- Owner 表达了“批准”意图，不代表 Console 中的审批动作已经完成。
- 批准、激活和后续行为差异是不同阶段，必须分别核实。

## 强制禁止

- 不通过 CLI、脚本、数据库、文件或其他技能批准、拒绝或激活原则。
- Console 不可用时，不得切换到 CLI 审批作为备用方案。
- 不伪造 Owner 决策，不将候选生成或准入结果描述成已激活。
