# PRI-739：已批准 shadow RuleCode 的有限反馈修订

## 问题与范围

2026-11-01，Owner 批准 SPEC-RULECODE-APPROVED-REVISION-001 v0.1。原规则已批准为 shadow，但恢复组合检查发现其在明确未批准场景下会阻断官方状态查询。现有源材料修正、人工复核重试、prompt 修订和按 pain 重跑均不能安全修订这份已成功工件。

本轮复用现有任务、工件、审批、绑定账本和工作进程，仅增加已批准 shadow 工件的一次反馈修订。代码交付、正式安装、真实审批、native 效果分别验收，不互相替代。

## 权威与实际接线

- 绑定权威仍为现有原则账本；其跨进程锁覆盖 SQLite 校验和写入。
- SQLite 同一事务校验旧激活、批准摘要、工件原文、控制版本和四阶段任务快照，并仅重开 Artificer。
- 已有 revision epoch 后继机制续接 Evaluator、RolloutReviewer；不重跑诊断、Dreamer、Philosopher、Scribe。
- 原任务元数据保存一次修订回执和反馈，旧源材料修正额度、运行记录、工件、批准和 shadow 状态保持原样。
- 修订反馈携带旧工件的代码契约投影（规则实现与意图），不携带可再生的 trace/对抗结果；上限在预览与提交共用的目标解析中校验。
- Console 身份由认证服务端提供；预览只读，重复请求返回已有回执。反馈与原始痛苦陈述分开。
- 恢复标识由共享输入构造器根据既有注册表精确生成，不把停用操作假称只读，不给任意 `pd` 前缀豁免。
- 评估义务表按同一注册表增加官方恢复探针，使“会拦住官方状态/停用”的规则无法通过评估，不必等到上线检查才发现。

## 验证计划与进展

已通过：真实 SQLite 的跨连接竞争、CAS、活租约、事务中断、账本锁、历史保留及 epoch 续接；真实 HTTP→模型→账本锁→SQLite；恢复标识近似命令负控、参数伪造、生产/回放一致性；Console UI 构建与类型检查。

### 真实模型两轮（原 52d 工件，只读快照副本，生产库零改动）

**第 1 轮（`2f0966c4c` + 本次修正前）：修订成功，产物不合格。**
预览 ready → 修订 started（epoch 4）→ Artificer 427s → Evaluator 68s `approved`（79/79 契约反例）→ RolloutReviewer `approve_rollout`，新审批入队。新工件 `..._4` 携带 `ruleHostInputContract.version=2`，旧审批/旧工件/激活行未变。
但把该工件送进既有生产恢复组合门禁，返回 `ok:false, probe=probe-pd-status, reason=recovery probe would be blocked`：新代码用 `derived.bashRisk !== 'safe'` 判门面，而 `pd activation list --json` 的风险分类是 `unknown`，在 `not_approved` 下仍被拦。产品缺陷没被修好。

**根因两处，均已修：**

1. 修订反馈把旧工件 `contentJson` 整包（真实 129,802 字符，其中 `goldenTrace` 68k、模型生成的 cases 各 23k）塞进 prompt，并有一条 `> 64000` 的硬上限——预览不检查、提交才检查，导致这个入口对真实目标“预览 ready、点击被拒”。现改为携带旧工件的**代码契约投影**（`implementationCode`/`intentContract`/`affectedTools`/`ruleHostInputContract`/`painReasonSummary`，实测 ~2.1KB），生成物明确提示 trace/对抗结果不随附、须重新推导；上限校验移入共享目标解析，预览与提交结论一致。
2. 评估链没有“官方恢复可达”的义务，于是一个会拦 `pd activation list --json` 的规则能拿 79/79 并获批。现按 `RECOVERY_CONTROL_SURFACES`（真实注册面）在确定性义务表加入 `official-pd_status`、`official-rulecode_deactivate` 两条硬编码探针，并新增判别性测试：忽略 `action.recoveryControl` 的实现被拒，消费该 marker 的实现通过。仓内两处“合规规则”夹具（vslice、L2 工具契约）随之修正——它们此前正是这一缺陷的形状。

**第 2 轮（修正后，快照 `-2`，同一原工件、同一轮额度）：产物合格。**
Artificer 850s → Evaluator `approved`，契约反例 81/81（79 + 2 项官方恢复）→ RolloutReviewer `approve_rollout`，新审批 `pending`。新代码首行即消费 `action.recoveryControl`，其余门面逻辑不变。
生产恢复组合门禁对同一工件返回 `ok:true`（旧 approved 工件仍 `ok:false`）。逐规则矩阵（`not_approved` / `unknown` / `absent` / `approved` / `not_required` × 官方状态、官方停用、未批准提交、只读）：

- `pd activation list --json`、`pd activation deactivate --activation-id …`：旧规则 `not_approved` 下 **block**，新规则 **allow**，其余事实态双方均 allow；
- `git commit -m …`（真实未批准受管变更）：两版在 `not_approved` 下均 **block**；
- 未知/缺失事实：两版均中性 allow，未把未知伪装成否决。

### 门禁与噪音

`lint` 0 error（仅既有 warning）；`typecheck:pd-console`、`build:ui` 通过；`@principles/core` 构建通过；core 全量 8761+ 项通过，host-runtime 625 项通过，pd-console 3062 项通过。
并行跑全量时出现 `principle-tree-ledger.atomic-write`、`reuse-shortlist`、`restart-safety.e2e`、console 的 owner-review/governance 若干超时与 Windows `EBUSY`，均已单独复跑通过（耗时下降一半以上），属本机并行负载噪音，非本次改动引入。

satellite bundle 体积预算随之超限（`rulehost-evidence.js` dev 559,348 > 旧上限 553,489，因为该 satellite 打包共享 runtime）。按门禁自身要求在同一 PR 内重定基到 baseline 452,000 / max 565,000，注释记录实测值与后续方向（修订操作只服务 Console，barrel 收窄可回收这部分字节）。

### 未证明（不得由本轮冒充）

原生宿主现场（真实 Codex 会话里的 design declaration、受控测试写入、shadow 事件随新 digest 增长、Console 新审批/上线、紧急恢复实操）未执行；生产安装、真实 Owner 审批、现场效果均无结论。原生版本混装风险仍存在：旧 Codex 运行时缺 `recoveryControl` 会按合同版本拒绝执行新工件（fail-closed、可见 warning），但不会替 Owner 报告“该工件在你当前运行时不被执行”，这是已知残余。

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
- New verification obligation: YES，既有评估义务表新增两条官方恢复探针，把 SPEC 的“恢复组合检查”落到评估阶段；不改评估器结构、不新增子系统。
- New external/network capability: NO，真实模型验证沿用已有 profile。

## Error Experience / Task Risk Contract

EP-01/08：输入、摘要、回执严格校验，身份服务端解析。EP-02/09：真实 HTTP、SQLite 与共享输入构造器测试，避免只测内部帮助函数。EP-03：失败返回明确 reason/nextAction。EP-05/06：本轮 cause、epoch、旧工件和反馈绑定，保留旧额度与历史。EP-11：新增文案双语。EP-13：复用既有组件/样式，不新增主题规则。EP-04：本轮不增加 CLI 变更入口。独立评审记录和最终 diff 路由在提交前复核。
