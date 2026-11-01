# PRI-739：已批准 shadow RuleCode 的有限反馈修订

## 问题与范围

2026-11-01，Owner 批准 SPEC-RULECODE-APPROVED-REVISION-001 v0.1。原规则已批准为 shadow，但恢复组合检查发现其在明确未批准场景下会阻断官方状态查询。现有源材料修正、人工复核重试、prompt 修订和按 pain 重跑均不能安全修订这份已成功工件。

本轮复用现有任务、工件、审批、绑定账本和工作进程，仅增加已批准 shadow 工件的一次反馈修订。代码交付、正式安装、真实审批、native 效果分别验收，不互相替代。

## 权威与实际接线

- 绑定权威仍为现有原则账本；其跨进程锁覆盖 SQLite 校验和写入。
- SQLite 同一事务校验旧激活、批准摘要、工件原文、控制版本和四阶段任务快照，并仅重开 Artificer。
- 已有 revision epoch 后继机制续接 Evaluator、RolloutReviewer；不重跑诊断、Dreamer、Philosopher、Scribe。
- 原任务元数据保存一次修订回执和反馈，旧源材料修正额度、运行记录、工件、批准和 shadow 状态保持原样。
- Console 身份由认证服务端提供；预览只读，重复请求返回已有回执。反馈与原始痛苦陈述分开。
- 恢复标识由共享输入构造器根据既有注册表精确生成，不把停用操作假称只读，不给任意 `pd` 前缀豁免。

## 验证计划与进展

已通过：真实 SQLite 的跨连接竞争、CAS、活租约、事务中断、账本锁、历史保留及 epoch 续接；真实 HTTP→模型→账本锁→SQLite；恢复标识近似命令负控、参数伪造、生产/回放一致性；Console UI 构建与类型检查。

原数据验证使用对生产数据库的只读备份，副本位于本任务 worktree 的 `.tmp`。真实原52d工件的预览已返回 ready，权威候选、原则、旧批准摘要及任务 epoch 可解析；此结果仅证明修订资格，未声明新代码已生成或生产已改变。

完整门禁、真实模型单轮结果、独立复核和远端交付状态在执行后补充。

## 风险与回滚

新工件不继承旧批准。新代码须经既有质量验证、恢复组合检查和新的审批。生产安装只走 installer；新运行时与旧 Codex 私有运行时不能混用后宣称生效。OpenClaw 历史版本的实际执行能力不能由新版 Console 单独证明。

回滚源码可 revert 本轮变更；已生成治理历史不删除。规则停用、暂停和后续替换复用正式生命周期。

## Complexity Delta

- New durable source of truth: NO。
- New persisted schema/state: YES，既有任务元数据增加严格校验的修订回执，不新增表或独立账本；与任务重开同一事务提交，避免单独状态对账。
- New subsystem/service/background process: NO。
- New public abstraction/interface: YES，Console 需要调用预览和有界领域操作；通过小接口隐藏血缘、锁与事务，不能由 prompt 修订替代。
- New runtime feature flag: NO。
- New cross-package dependency: NO。
- New host/platform-specific behavior: YES，现有 Codex/WorkBuddy 输入合同资格检查扩展兼容版本，防止缺少新输入语义的旧宿主误执行。
- New external/network capability: NO，真实模型验证沿用已有 profile。

## Error Experience / Task Risk Contract

EP-01/08：输入、摘要、回执严格校验，身份服务端解析。EP-02/09：真实 HTTP、SQLite 与共享输入构造器测试，避免只测内部帮助函数。EP-03：失败返回明确 reason/nextAction。EP-05/06：本轮 cause、epoch、旧工件和反馈绑定，保留旧额度与历史。EP-11：新增文案双语。EP-13：复用既有组件/样式，不新增主题规则。EP-04：本轮不增加 CLI 变更入口。独立评审记录和最终 diff 路由在提交前复核。
