# PRI-1018 原痛苦 RuleCode 恢复与来源核验

## 现场结论

原信号：`manual_1791868470372_8c47edyh`；仅恢复 52d98a96 与 406f6131 两个代码分支，不重提信号，不批准或激活规则。

本机 canonical runtime 为 core 1.295.0 / codex-adapter 0.5.9 / host-runtime 0.11.0 / CLI 1.158.3。已启用的 Codex 插件实际从 plugin-private runtime 加载 core 1.291.5 / adapter 0.5.3。更新 canonical 并不等于更新 Hook。初始配置显式关闭 host.codex、Philosopher、Evaluator；Owner 本轮允许只开启验证必需项。通过现有 Console 配置服务开启 Philosopher 与 Evaluator，仍使用原 pd.default（zai/glm-5.3-flash）；旧 Hook 未重新开启，其他代理与观测同意不改。

## 已执行的原任务恢复

1. 只读 SQLite backup 与原配置备份先行，暂存主项目 `.tmp/pri-1015-rulecode-recovery-20261021/`，不提交数据库、配置或凭据。
2. 官方 `runtime recovery failed-task` 对两个精确任务分别 dry-run，再 `--confirm --reset-budget`；保留历史并记录原 attempts=3、恢复审计。两任务退出 failed。
3. 调用当前生产共享 preflight 对这两个精确任务检查，避免通用 worker 执行其他痛苦。使用真实 state handle、workspace telemetry、行为证据 assembler，不直写数据库。首次进入 owner_behavior_examples_required，attempt=0、零模型调用。
4. 复核真实轨迹：5371 为原受质疑功能的提交，5300 为搜索测试/配置，5368 为 Git/资源锁状态查询。按 Owner 早前委托的判断权限选择其为一负两正例，经官方 evidence attach dry-run/confirm、digest 校验与 evidence resume 推进。操作来源明确记录为 codex-owner-delegated-example-review，不冒充人工逐例标注，也不把标签当设计批准事实。期望明确保留已批准 SPEC 内开发应放行，不能泛化为禁止所有提交。这三例本身还不能证明批准状态辨别正确。
5. 两分支真实 assembler 均 ready，但旧 Scribe 缺 executionConditions，进入明确的 intent_unverified/execution_conditions_missing，未执行 Artificer。
6. 仅 52d 分支通过现有 orchestrator.reopenTaskForRevision 的稳定 revisionCauseId 修订原 Scribe，再通过官方 run-once（真实 pi-ai、180秒期限、禁止自动播种后继）重跑；事前验证无其他待跑 Scribe。真实 GLM 两次新运行均 succeeded，新草案声明 design_approval required:true。第二次是针对实际 textual_basis_unanchored 反馈的最后一次有界修订，未手改工件。
7. 当前生产 52d Artificer 停在 intent_unverified/textual_basis_unanchored；406f 保持 execution_conditions_missing。两者 needs_human_review、attempt=0；没有 Artificer 模型调用、新 RuleCode、审批或激活。

## Reality Audit：已存在的能力与真实断线

Scribe 已通过 `resolveFormationContext` 读取诊断源证据，提示词要求 executionConditions.textualBasis 源自同一 Owner 归因材料。当前核验的共享 `collectUpstreamNormalisedText` 却只读取 Philosopher 的 thesis/principleCandidate/risks/analysis，另加 Scribe 合同及 statement，没有对应原始诊断材料。

对本轮原产物使用真实 resolver、与 Scribe 相同的 task lookup 投影，只读复验：归一化前缀“非简单行为变更先调查现状”在 formationContext 的 Owner 原文引用中存在，在 Philosopher 中不存在。故不能把本轮失败确定归为模型捏造引用或模型太弱。这是生产者可见依据与消费者允许依据不一致。

修复须复用现有可信血缘和共享 resolver，补接可归因的源意图；不得把 recommendations/候选设计提案变成 Owner 要求。前置门和 Runner 防御镜像必须一致；没有设计批准事实 provider 时仍应 unsupported，不得自动生成或批准。

另有独立交付断线：官方 pd-setup 只按插件包 runtime-version.json 安装。repo pins 和安装 cache pins 都旧，因此单纯再次执行 setup 也不会得到 canonical 新版本。需要验证已发布新 pins 并经正规插件安装渠道交付，不能手补生产安装文件。

## 边界与复杂度

修复目标是消除误拒和补齐已存在安装路径的版本选择，不创建开发审批平台、通用输出修复器、重试平台或新治理权威。源码验证、候选包验证、正式发布、当前本机安装和真实 Hook 执行分别报告。当前尚不能宣称原原则已产生可执行 RuleCode，更不能宣称长期行为改善。

| Complexity Delta | 结果 | 说明 |
|---|---|---|
| New durable source of truth | NO | 复用原任务血缘、诊断、工件和配置权威 |
| New persisted schema/state | NO | 既有恢复审计/verification 元数据，无新表列或生命周期 |
| New subsystem/service/background process | NO | 没有新审批平台、更新器或重试服务 |
| New public abstraction/interface | NO | 扩充现有包内共享 collector 输入；未增加包级导出，两个真实调用方共用 |
| New runtime feature flag | NO | 原 host.codex 与规则治理控制保持 |
| New cross-package dependency | NO | 既有 resolver/store 协作 |
| New host/platform-specific behavior | YES | Codex 插件 pins 与缓存版本更新；canonical updater 不拥有 plugin-data。用原 setup 隐藏安装复杂度，比新建同步器更小；已发布包实装/Owner-control probe/真实 setup 测试验证，可用原停用和插件版本回退 |
| New external/network capability | NO | 沿用已有 npm 安装机制，无新端点或模型调用路径 |

沿用已有关闭开关、逐规则停用和源码 revert；正式发布前不覆盖安装目录。

Emotional value：减少“更新后仍不知哪个阶段失败”的不确定性，保持可查的原因和 Owner 控制权。没有新增 Owner 交互流程。

## 实现与验证分层

代码只补接匹配 Scribe/Philosopher Dreamer artifact ID、匹配 canonical pain 的原诊断 evidence.note。recommendations 不纳入；明确 ID/pain 冲突整体失效，不能退回到恰好含相同文字的 Philosopher 材料。前置门与 Artificer Runner 防御镜像共用同一 collector；没有改变任何 fact 满足条件。

原生产 Scribe run3 的只读对照：已安装 core 返回 textual_basis_unanchored；新源码构建返回 unsupported/trusted_fact_provider_absent。该对照不调用模型、不写生产状态，不能把它描述为生产任务已进入 unsupported 或已生成代码。原任务仍停在各自 needs_human_review，等待正规更新和后续事实能力。

Codex pins 更新到已发布基线 adapter 0.5.9 / host-runtime 0.11.0 / core 1.295.0，manifest 0.1.1 用于新缓存身份。这份 core pin **不包含本 PR 尚未发布的源意图修复**；后者由 core patch changeset 进入后续 canonical 发版。S1–S5 在临时 npm 实装包上全部通过，首次 setup 与打包隔离测试通过，不能据此声称本机缓存已更新。

定点意图/Runner 102/102；插件完整 bundle 32/32、pin/worker-registration 11/11、first-run 1/1。测试已固定子进程继承隔离 CODEX_HOME/HOME/USERPROFILE，默认命令不再依赖调用者预先隔离；修复后对真实配置 SHA256 前后比较相同。初次未隔离验证曾访问真实工作区；与操作前备份做完整语义比较，仅存在 Owner 授权的 Philosopher/Evaluator enabled 两处改变，没有其他配置变化。

当前源码全量 core：8629 passed / 6 skipped / 3 todo（7 文件 skipped）；host-runtime 570 passed；codex-adapter 303 passed / 1 skipped；pd-cli 1974 passed / 2 skipped。四包构建通过；远端检查尚待本 PR head 验证。Codex 首轮全量出现一次 Windows Vitest 子进程异常退出，未把未完成项记为通过；随后限定并发重跑，不修改业务断言或提高超时。

ERR 官方 writer：P-ERR-024（Owner source producer/consumer parity，P1）、P-ERR-089（已发布宿主修复进入 plugin-private delivery，P2）。handbook 校验通过；本轮无新触发的 enforcement decision。仓库既存 EP-02 baseline-inventory 热点不在本次修改范围。Pass2 HIGH EP-03/05/09：分别由精确任务官方操作及原因输出、有界真实修订与零调用停点、旧版本会误拒的真实血缘反例和原产物对照验证；EP-01/02/06 则由 runtime guards/同一共享 collector/真实打包与 npm 安装验证。没有批量修复邻近问题。
