---
name: pd-cli-operator
description: 当需要只读检查 PD 运行健康、查询痛苦/任务/运行/候选/工件，或追踪痛苦到原则的证据链时使用。用于 PD CLI 与 Runtime 排障；不用于登记痛苦、Owner 治理审阅或宿主管理。
disable-model-invocation: false
---

# PD CLI Operator

通过现有 PD CLI 查询事实、定位链路断点，并给出基于证据的结论。本技能只负责操作路由，不实现第二套业务逻辑。

## 工作流程

1. **确认工作区。** 使用当前 OpenClaw 宿主/插件上下文提供的权威工作区。命令要求 `--workspace` 时传入已确认的绝对路径。无法确定工作区就先报告阻塞，不要从当前目录、最近目录或其他宿主猜测。
2. **发现真实命令。** 先检查 `pd --help`，再检查目标命令的 `--help`。命令名和参数以当前安装版本为准。
3. **优先只读检查。** 按问题选择最少的查询命令，不遍历无关工作区。
4. **逐段追踪。** 分别核实痛苦登记、诊断任务、运行结果、候选、准入和 Owner 治理结果，不由单个状态字段推断整条链路已完成。
5. **报告证据。** 说明已确认事实、未知部分、阻塞层和下一步；区分命令成功与业务目标成功。

## 常用只读命令

先确认当前 CLI 支持这些命令，再按需执行：

- 健康检查：`pd health --workspace "<workspace>" --json`
- Runtime 探针：`pd runtime probe --runtime pi-ai --workspace "<workspace>" --json`
- 流程策略：`pd runtime flow show --workspace "<workspace>" --json`
- 痛苦列表与准入证据：`pd pain list --workspace "<workspace>" --json`、`pd pain evidence --workspace "<workspace>" --json`
- 痛苦到原则的追踪：`pd runtime trace show --pain-id "<painId>" --workspace "<workspace>" --json`
- 任务与运行：`pd task show "<taskId>" --workspace "<workspace>" --json`、`pd run show "<runId>" --workspace "<workspace>"`
- 候选与工件：`pd candidate list --task-id "<taskId>" --workspace "<workspace>" --json`、`pd candidate show "<candidateId>" --workspace "<workspace>" --json`、`pd artifact show "<artifactId>" --workspace "<workspace>" --json`

OpenClaw 的 `/pd-status` 主要展示 GFI/Pain 词典等宿主状态，不应代替 Runtime 健康检查或具体任务追踪。

## 按需召回原则的历史痛苦

当原则文本本身不够用——不确定它为何存在、触发边界是什么、或当前情况是否与当初的失败相似——使用 `pd pain recall`。原则已经清楚或任务与其历史无关时不要调用，那只会增加延迟。

- 带疑问召回：`pd pain recall --principle-id "<规范原则 ID>" --context "<当前疑问>" --limit 3 --workspace "<workspace>" --json`
- 查看指定痛苦：`pd pain recall --principle-id "<规范原则 ID>" --pain-id "<painId>" --workspace "<workspace>" --json`

结果判读：

- 必须传规范账本原则 ID（UUID）；显示标题和提示词渲染 ID 无法解析。
- 先看顶层 `status`。`ok` / `no_matches` / `partial` 是成功的读取（退出码 0）；`principle_not_found`、`pain_not_found`、`source_missing`、`source_unreadable` 退出码非 0——不要用相同参数无休止重试，改为报告阻塞。
- 每条结果区分三类信息：痛苦记录（`pain.reason`、`pain.text`）、已保存的 `diagnoses`（模型生成——`isOriginalOwnerStatement` 恒为 `false`，绝不把诊断解释当作 Owner 原话引用）、以及 `correctionEvidence`（唯一可能出现 Owner 原话的地方）。
- `--pain-id` 只在该原则已验证的关联集合内筛选；candidateId/taskId/artifactId 永远不是 painId。
- 每条结果的 `availability` 区分 `not_recorded`（确实没有记录）与 `unreadable`（无法读取）；顶层 `partial` 表示部分来源不可用——如实说明缺口，不要猜测。
- 召回的历史是背景，不是权威：不得用它覆盖当前任务的直接证据。

## 结果判定

- `painId` 只证明痛苦登记有回执。
- 任务创建不等于诊断完成。
- 候选生成不等于通过准入；必须检查实际 admission 决策及对应账本证据。
- 准入成功不等于 Owner 已批准或原则已激活；打开 Console 也不等于完成治理决定。

## 写操作与失败

本技能默认只读。若需要重试、恢复、修复或其他有副作用的操作，先确认用户意图、命令帮助、资格条件和影响范围；支持时先 dry-run，执行后读回真实状态。不要盲目重试可能产生副作用的命令。

CLI 不可用时，保留真实错误并区分未安装、工作区未初始化、权限不足与 Runtime 故障。需要安装、初始化、停用或恢复宿主接入时转交 `pd-control`。

## 禁止

- 不直接修改数据库、账本、配置或内部工件。
- 不写 `.state/.pain_flag`，不调用 legacy `write_pain_flag`。
- 不伪造运行证据或把推测写成已确认根因。
- 不通过 CLI、脚本或其他技能批准、拒绝或激活原则。
- 不将命令退出码为 0 自动等同于业务成功。
