# Codex 用户级 PD 管道现场验证（2026-09-30）

## 结论

Dreamer 本身没有坏。Codex Marketplace setup 初始化了用户工作区和插件私有运行时，却遗漏了后台工作区登记。安装清单只有 `openclaw`，且不包含 `C:\Users\Administrator\.codex\pd-workspace`；现场 PD Companion 也没有运行。因此痛苦信号可以入库，诊断可以手动执行，但排队后的 Dreamer 没有进程领取。

本次修复后，真实痛苦信号的 prompt 管道已经完成，Console 已批准并激活，新开的真实 Codex 会话自动读到了完整原则正文。未证明 RuleCode 生成与拦截管道已经跑通，也未证明新的痛苦信号经过全程无人干预后台处理。

## 代码因果链

1. `plugins/principles-disciple/scripts/pd-setup.cjs` 原来只有私有 runtime 安装、`pd runtime init`、观察授权和 hook trust 提示；没有登记后台工作区。
2. `packages/create-principles-disciple/src/installers/codex-host-installer.ts` 已退休旧全局 hook 安装路径。完整 installer 的清单写入在 host install 成功后；现在不能依靠旧 Codex 安装路径完成登记。
3. `packages/pd-companion/src/main/main.ts:270` 的 `manifestCodexWorkspaces()` 明确要求清单 `hosts` 包含 `codex`，再读取 `workspaces`。缺少任一项就不能发现该用户工作区。
4. Companion 启动 `pd codex worker`。`packages/codex-adapter/src/worker/workspace-worker.ts` 调用现有 PainSignalBridge 和 shared `runInternalizationConsumerCycle`，与 OpenClaw 使用同一后续执行器；不依赖 OpenClaw gateway 执行模型调用。
5. Scribe 正式产物出现后，既有 canonical ledger identity 绑定自动建立，Console 原先的 `lineage_not_available` 随之消失。没有修补治理投影或伪造数据库行。

## 修复

- Marketplace setup 在现有 canonical installation 上登记 `codex` 和选定工作区，复用 `@principles/install-layout` 的解析和工作区合并，保留其他 host、workspaces、更新字段。
- 损坏清单失败退出并保留原文；缺少 canonical installation 明示 `manual_action_required`，不宣称后台工作完成。
- setup 区分「已登记」与「后台正在运行」，提示保持 Companion 运行。
- CLI 定位优先使用 installer-owned canonical CLI，避免只查 npm 全局包导致健康的安装被误报为不可用。
- 通过 setup 正式安装路径完成现场清单登记，并通过 Codex plugin 命令刷新缓存。未手工改写 installed runtime 文件。更改尚未发布为正式产品版本。

## 真实链路证据

- workspace：`C:\Users\Administrator\.codex\pd-workspace`。
- pain：`manual_1790730755732_noiy60j6`，官方 `pd pain list --json` 确认 `host=codex`。
- 原始反馈：「你和我交流的方式有问题，很难理解你说的话。」
- candidate：`af07fe73-35be-4c49-ba20-2a288174de6d`。
- ledger principle：`9a97c7db-43f0-4292-8707-5f99e4e42fd6`。
- 真实 Codex worker 单周期分别报告 Dreamer、Philosopher、Scribe、Rollout Reviewer `runStatus=succeeded`，持久任务表确认所有阶段 succeeded。
- Console 由 `lineage_not_available` 变为 `needs_owner_decision`；根据 Owner 先前明确授权，使用 Console 按钮「批准」和「确认」执行审批。
- approvals 状态为 `approved`；activations 为 `channel=prompt`、`action=prompt_activate`、`deactivated_at=null`。
- 安装后的 hook 收到 `UserPromptSubmit`，返回正确 `hookSpecificOutput.additionalContext` 和完整沟通原则，exit=0、stderr 为空。
- 新开真实 `codex exec` 只读临时会话；请求仅检查既有上下文，没有提供原则标题或正文，也禁止读文件与工具。模型逐字输出了自动注入的 directive id 和 MANDATORY 正文。因此验证不止是直接调用 hook 或手工读取原则文件。
- Companion 日志 `2026-09-30T10:28:33.200Z workspace_worker_started` 指向 Codex 用户工作区；现场确认其子进程正在使用 canonical CLI 服务该目录。
- 控制台临时端口冲突已消除：Companion 管理的 Console 在 3100 正常启动，Codex 用户工作区审查 Console 在 3101。

## 验证与限制

- 新增 4 项真实子进程回归测试覆盖登记、幂等与设置保留、损坏清单无写入、无 canonical installation 明示手动处理、canonical CLI 定位。
- 相关 3 个测试文件共 41 项通过，未跳过；之前用户作用域及 host-runtime 的 105 项验证仍有效，本轮未重跑全部旧套件。
- 测试结束时有一个隔离临时目录因 Windows EPERM 留存；没有影响测试结果，没有删除用户数据。
- `check:error-handbook` 通过。本次 ERR-024 recurrence 已经通过官方 writer 记录，带实际回归测试 guard；`error:hotspots` 仍报告一个此前已存在的 baseline inventory/count guard 治理项，属于另一任务，本次未处理。
- `codex_conversation_ingestion` 仍关闭；共享原则注入的授权不等于跨项目对话采集的授权。
- 本条反馈语义适合 prompt，不是确定性工具拦截 RuleCode；未制造规则去伪装 RuleCode 验收完成。
- 当前桌面会话在批准之前开始。新 Codex 会话自动注入已经验证，当前这轮看到的正文来自验证工具结果；不冒充已经追溯修改了本轮最初的输入上下文。
- 后台运行依赖 Companion 保持运行；清单登记并不是进程存活证明。后续全自动处理新信号仍需真实新增信号验证，本次没有制造新痛苦事件或开启未经授权的全量采集。
- 停止影响：Console 中「停止此执行方式今后的影响」可以撤销本条 prompt activation；现有 `$pd-disable` 可以暂停 Codex 用户工作区。

## Complexity Delta

| 项目 | 结果 |
| --- | --- |
| New durable source of truth | NO |
| New persisted schema/state | NO |
| New subsystem/service/background process | NO（启动现有 Companion/worker） |
| New public abstraction/interface | NO |
| New runtime feature flag | NO |
| New cross-package dependency | YES（setup 消费已安装 install-layout 的现有解析和合并能力） |
| New host/platform-specific behavior | YES（Codex Marketplace setup 接入现有 worker 清单） |
| New external/network capability | NO |

两个 YES 都是连接现有能力：Companion 只消费 canonical manifest，而旧 Codex installer 已退休；不连接 Marketplace setup 就仍然无法自动发现工作区。复用现有清单和解析器避免第二份状态及新调度器。真实入口回归测试与现场进程证据验证该连接；撤销代码变更即可恢复旧 setup 行为，既有证据、审批和激活数据保留。

Emotional value：减少「显示安装成功却一直不工作」的不确定性；让 Owner 明确分辨登记、运行、审批、注入及尚未验证的 RuleCode。

## 提交前复核（独立工作树，最新 origin/main）

- 基于 `d76bc1dc` 的独立工作树重新构建全部主包成功。
- Codex hook、Marketplace bundle、版本 pin、用户工作区及 worker 登记：5 个文件 59 项通过。
- host-runtime 四个生产入口套件：原 64 项通过；随后新增 live/replay 身份一致性回归，pain evidence 文件 18 项通过（原 17 项）。
- Codex shared-runtime / signal-admission BDD 对应的 production 与 slice-b 两个文件 24 项通过，未修改或跳过 scenario。
- 审查发现项目 cwd 不应改变 canonical pain 身份；撤回 evidence sanitizer/risk 的项目根替换，仅门禁解析工具路径使用项目 cwd。真实 runtime 写入结果与 replay identity 对照，以及新 runtime 重复投递，均保持同一条痛苦信号。
- 本 PR 不提供纯 Codex 新机器 canonical bootstrap；缺少 canonical runtime 时继续明确报告手动处理，不伪装成完整安装成功。
