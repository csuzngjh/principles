---
name: pd-control
description: 当 Owner 明确要求安装、初始化、停用、重新启用或修复 PD 宿主接入时使用。只使用当前宿主正式支持的管理入口；不直接改配置或业务状态。
disable-model-invocation: false
---

# PD Control

## 目标

通过正式安装器和宿主管理机制管理 PD 接入。本技能是受限路由入口，不复制安装器逻辑，也不改变原则、候选、任务或账本状态。

## OpenClaw 当前支持方式

### 安装或重新初始化

仅当 Owner 明确要求安装/初始化时，使用仓库公开的非交互式安装入口：

    npx create-principles-disciple --yes

执行前检查当前安装器的帮助和前置条件；不要在缺少授权、网络或依赖条件时声称安装成功。完成后用 `pd-cli-operator` 做只读健康检查。

### 停用

只有 Owner 明确要求停用时，执行：

    openclaw plugins disable principles-disciple

该命令通过 OpenClaw 正式插件管理入口更改启用状态，不会删除已安装文件。执行后检查 `openclaw plugins list --enabled --json`，确认 `principles-disciple` 不再处于启用列表。若 Gateway 正在运行，命令会通过 Gateway 应用状态变化；仍需区分“开关已关闭”和“此前已启动的任务已全部停止”。

### 启用或恢复

只有 Owner 明确要求启用时，执行：

    openclaw plugins enable principles-disciple

如果返回 capability consent、allowlist、denylist 或其他策略阻止信息，不要自动添加 `--accept-capabilities`，也不要手工改 `openclaw.json`。保留完整回执，向 Owner 说明需要作出的选择或策略问题；只有 Owner 明确同意相关 capability 后，才按 OpenClaw 返回的准确重试指令继续。

执行后先检查 `openclaw plugins list --enabled --json`，再运行 `openclaw plugins inspect principles-disciple --runtime --json` 检查当前插件注册的运行时能力。冷清单或 inspect 结果本身仍不能证明真实 Hook 已生效；需要时用一条安全的真实宿主事件核验。

## 成功判定

区分安装器执行成功、插件被宿主发现、Hook 实际运行和 PD 业务链路健康。每一步都需要对应的真实回执或运行证据。插件存在不等于已启用，安装成功也不等于 Runtime 健康。

## 禁止

- 不手工修改宿主配置或 PD 状态文件。
- 不覆盖用户配置，不删除业务数据来停用 PD。
- 不通过 CLI、脚本或其他技能批准、拒绝或激活原则。
- 不将未验证的宿主操作报告为成功。
