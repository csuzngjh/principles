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
- 请求不单独回传 candidate：它由 activation → artifact → evaluator 血缘解析，并经旧工件 digest 与账本 identity receipt 双向校验；让客户端再自证一个候选只是重复事实，且会多一个可被伪造的输入。

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

### 评审修正（CodeRabbit，2026-11-01 第二轮）

七条意见里五条成立并已修，两条按下述理由未照做：

- **官方恢复探针只覆盖规范命令**：`identifyRecoveryControl` 接受尾部 `-w`/`--workspace <path>` 与任意合法 activation id，而探针只有规范字符串——只豁免规范写法的规则会通过探针却拦住真实调用。现每个 CLI 恢复面生成规范、`-w`、`--workspace` 三种探针，停用命令再加一条不同合法 id（共 7 条）。
- **修订轮会重放上一修复轮的指令**：已批准工件可能来自评估器修复轮，其 `repairPayload` 仍在元数据里，runner 会把它渲染进提示词，并在 `diagnosticReplay` 记录失败时去解析旧证据（解析不到直接 throw）。现保留结构字段（`repairIteration`/`sourceEvaluatorTaskId` 关系完成分支与恢复计数），把 `requiredChanges`/`concerns`/`diagnosticReplay`/`failureAttribution` 换成本轮语义。
  评审建议「清空 `requiredChanges`」不可行：`isValidRepairPayload` 要求该数组非空，清空会使整条元数据校验失败、任务根本无法启动。
- **预览每次都读整张 `tasks` 表**：改为按 `taskKind` 的两次过滤查询，交互不变（仍随面板加载，保住可发现性）。
- **Console 两个交互缺陷**：成功提交先 `toast.success` 再 `onChanged()`（父级重载会卸载面板，面板内的确认会随之消失）；提交失败后输入框不再锁死——改反馈即作废旧 `requestId` 重发，不改则复用同一 `requestId` 重试，服务端额度锚是工件 digest＋回执，换 id 不会多消耗一轮。
- **规范与实现不一致**：SPEC v0.1 第 19 行原本把 `candidate` 列为客户端必须绑定的字段，实现里它由服务端从激活血缘解析。已按实现修订该行并注明理由。
- 未采纳一：要求官方恢复探针额外断言 `matched:false`。安全影响为零（仍是 allow），只是 shadow 统计口径；而 `GoldenTraceCase` 的 TypeBox schema 目前没有 `matched` 期望字段，补齐要扩既有 golden trace 契约并影响所有已存工件——记 follow-up。
- 未采纳二：要求补「真实 Worker 入口执行修订后任务」的单测。现有真实模型两轮已证明 Artificer 重开后被真实执行并产出新工件、Evaluator 消费了它；单测层的 Worker 化改造属独立工作，记 follow-up。

增量重审又提三条，均成立并已修：

- **残留 `adversarialFeedback`**：来自后续对抗轮的失败用例会被渲染成 PRIOR ADVERSARIAL FAILURES 要求模型处理，与本轮「不携带旧对抗结果」的约定冲突，可能让模型改动已批准代码。修订覆盖项里一并清除。
- **拒绝后刷新失败仍留可提交的旧表单**：`refused` 现在直接用服务端结论替换本地预览，刷新再失败也不会留下过期的可提交表单。
- **`already_started` 被当成成功**：核心不比较 requestId 或反馈内容，若首次成功响应丢失、Owner 改完反馈重发，新反馈不会被记录。现在单独显示中性提示（不显示"已排队"、不置 submitted），并补中英双语 key。

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

## P1 补丁（2026-11-01 晚）：版本化激活身份与原子替换

独立评审在隔离工作区批准新工件后，数据库出现两条活动 shadow（工件不同，`activation_id` 与 `target_ref` 相同），Console 审阅直接报「requires exactly one RuleCode activation」，生产 gate 按 `target_ref` 分组后跳过整组。根因是身份重复，不是覆盖旧行。证据见同目录 `REPORT` 之外的隔离复现：审批 1 次 → 2 行激活、0 行 `supersede`、控制状态仍 1 条。

### 改动

- `rule-host-writer.ts`：身份由不可变工件派生 `act_code_${ruleId}_${sha256(artifactId)}` / `impl://${ruleId}_${sha256(artifactId)}`，沿用 `PromptWriter` 既有约定；同工件幂等、跨版本必不同。
- `sqlite-activation-state-store.ts`：`replacePromptActivation` 与新增的 `replaceRuleActivation` 共用同一原子事务实现；插入新激活行时**同时 seed 控制状态**（否则 gate 以 `activation_control_state_invalid` 跳过新版本——与身份问题同源）；停用语句按渠道参数化。
- `rule-replacement.ts`（新）：`detectRuleReplacementTarget` 只认同一 evaluator 链的 shadow，目标为 live 或候选多于一条即拒绝。
- `activation-dispatcher.ts`：code_tool_hook 也走替换分支（首次激活 + `already_activated` 恢复），替换失败把原因透传到 `nextAction`，不再吞掉。
- `ApprovalsConsoleModel.ts`：审批时对 code_tool_hook 同样探测 supersede 目标；`activation_failed` 透传 dispatcher 的 `nextAction`；新增 `rule_replacement_refused` 错误分支与路由映射。

### 真实验收（隔离工作区，生产库零改动）

| 项 | 结果 |
|---|---|
| 基线 | 1 条 live shadow（run_3）+ 1 条 pending 审批（真实模型产物 run_4） |
| 真实 `ApprovalsConsoleModel.approve`（带 CAS 审阅） | `activated`，`supersededActivationId` 指向 run_3 |
| 激活表 | 2 行：run_3 已停用、run_4 live；**0 个重复 `activation_id`** |
| 控制状态 | 2 条，各自 `eligible` / version 1 |
| `supersede` 决策 | 1 条 |
| Console 审阅 | 按新 `activation_id` 唯一解析，无「exactly one」报错 |
| 重放同一审批 | `already_decided`，激活行数不变 |
| 生产 gate（真实 VM 沙箱） | `evaluations` 中 `activationId` = 新 id、`hostKind=codex`；`not_approved` 下 `git commit` 记 **block**（shadow 不阻止实际动作），只读与 `pd activation list --json` **allow**，`approved` **allow**；无 `duplicate_active_activation`、无 `activation_control_state_invalid` |
| 旧工件 | 生产恢复组合检查对 run_3 仍 `ok:false`（`probe-pd-status`），新工件 `ok:true` |
| 两连接同时批准 | 一次 `activated` + 一次 `already_decided`；0 重复；`supersede` 决策 1 条 |
| 替换事务中断 | `rule_replacement_failed` 且审批回 pending；激活表只剩 run_3 且**未停用**；0 `supersede` 决策 |

`unknown` 事实走既有 required-fact 契约：`rule_required_fact_unavailable` 记账并跳过评估，实际动作放行（中性），未把未知当作否决。

### 固化测试

`activation/__tests__/rule-replacement.test.ts`（原子替换、幂等重放、失败回滚、同身份拒绝、探测只认同链且拒绝 live）；`rule-host-writer.test.ts` 改为断言版本化身份并新增「同工件稳定 / 跨版本不同」；barrel 快照同步。

### 仍未执行（NOT RUN）

生产发布与安装、native Codex 现场、真实 Owner 审批、shadow 事件随新 digest 的真实增长、Console 新审批上线与紧急恢复实操。安装后的验收步骤：在目标 workspace 批准修订工件 → 确认 `activations` 中只有一条 `deactivated_at IS NULL` 且 `artifact_id` 为新工件 → 触发一次受管写入，确认 gate `evaluations[].activationId` 为新 id 且判定为 block（shadow 不拦）→ 旧 `activation_id` 无新增证据。
