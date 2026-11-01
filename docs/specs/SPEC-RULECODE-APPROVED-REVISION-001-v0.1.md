# SPEC-RULECODE-APPROVED-REVISION-001 v0.1

日期：2026-11-01。状态：Owner 已批准具体设计（本会话“同意修改”），实施中。源码核查基线：36c162e8c。关联 PRI-739（有限反馈修订）、PRI-1044（原生全生命周期验收）。

## 目标与边界

对已批准但仍处shadow、被当前上线安全检查拒绝的RuleCode，提供一次有明确反馈的官方修订操作。原pain/candidate/principle不变，复用既有内部化任务、版本化run/artifact、审批队列和Worker。旧工件、审批与影子记录全部保留；不直接改安装或生产数据库，不新增通用审批平台。

原对象：pain manual_1791868470372_8c47edyh；candidate52d98a96-65b9-4952-82c5-51ba2d853c53；principle ce2b7885-a9ea-4f6e-94da-b0e6c9b85110；artifact pi-rule-evaluator-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook-run_evaluator-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook_3。

## 已核实缺口

现有source-correct-once仅处理源材料停点且候选终身一次；原对象已经消费。Owner revise_once仅接needs_human_review任务。激活propose-revision仅支持prompt。run-rulehost按pain查询有多个dreamer，无candidate定点参数，不能安全替代此操作。

## 调用链与输入输出

Console现有RuleCode审阅页增加只读修订预览和“按反馈修订一次”；认证Owner请求→现有Console模型→core领域修订操作→既有SQLite任务/元数据事务→Worker Artificer→Evaluator→RolloutReviewer→新工件待审。复用现有修订反馈载体，不将反馈伪装原始Owner痛苦陈述。

请求须绑定 activationId、旧artifactId/digest、绑定revision、控制version、当前任务epoch、requestId以及明确反馈。服务从可信绑定解析candidate、principle、task血缘和actor；客户端不可指定任意Actor/原则。（v0.1 对齐实现：candidate 不作为请求字段——它由 activation→artifact→evaluator 血缘解析，并经旧工件 digest 与账本 identity receipt 双向校验；让客户端自证只会多一个可伪造的重复事实。）

反馈限于本规则原意：只读与PD状态/官方恢复操作必须安全可达，真实未批准的受管变更应拦截，真实已批准/无需批准正常开发放行；未知事实不伪装明确否决。不可按某个历史命令全文或当前pain ID写特例。

输出：结构化 started/already_started/refused，包含现有任务/run入口、原因及下一动作；预览零变更。

实施澄清：预览验证的是“此已批准 shadow 工件是否具备一次修订资格”，不另建一份上线失败裁决权威。修订必须由认证 Owner 明确提供反馈，不会因预览或上线检查失败而自动启动。现有上线检查仍独立决定新工件能否生效。

恢复操作语义由共享生产/回放输入构造器提供可选 `action.recoveryControl` 标识，复用已有恢复能力注册表，仅识别完整、无组合副作用的官方 CLI 调用。该标识不改变 `bashRisk` 的只读语义，不代替批准事实，也不自动跳过规则；生成规则仍按原则适用范围判断。未识别操作不能获得恢复豁免，旧代码仍须接受既有恢复组合检查。

## 额度、并发和历史

额度以“已批准旧工件的不可变digest＋Owner明确修订决定”为授权锚，一份旧工件只允许一轮；换requestId、重启或重新绑定不获得新额度。不能重置旧source-correction额度。回执复用现有任务元数据owner，小范围扩展并经正式schema/hydrator验证。

原子校验任务状态、活租约、digest、绑定及控制version，再按既有revision epoch机制准备受影响任务；失败整体零变更。所有旧run和工件不改写。并发/崩溃/重复请求幂等，不依赖模型路由或重试。实现前确认现有atomic family reopen的成员范围和后继seed机制，不能凭本文猜测直接改状态。

## 成本、失败、审批

不重跑诊断、Dreamer、Philosopher或无关候选；复用既有Scribe材料与可信requiredFacts。最多一轮正式修订任务，沿用已配置profile、各stage attempts/timeout及既有adversarial上限，不提高预算。失败有可审停点，不自动续轮。新代码仍须确定性质量/恢复组合检查及新审批，旧审批不迁移。未批准的新工件不得live；旧shadow保留，后续替换仅走既有正式生命周期。

## 验收与回滚

1. succeeded原链可精确修订；其他候选/宿主/原则不受影响。
2. stale digest、错绑定、活租约、超额均零变更；同一请求幂等、事务中断可恢复。
3. 新工件确由模型正式产生，非手改；含可行动not_approved、未知与历史变体，原错误代码被拒，新代码允许真实状态/恢复操作。
4. 官方design declaration绑定真实native会话、项目和SPEC；受控测试写入未批准时阻止、已批准时成功，只读成功，原始轨迹/文件变化与事件交叉证明；不得编造会话或批准事实。
5. 同新digest的shadow事件真实增长，满足既有阈值后通过Console新审批/上线；坏规则下仍能正式紧急恢复。native缺项不得以单测冒充。
6. 旧工件在完成修订之前仍被安全门禁拒绝，不能靠放宽检查实现可用。

回滚：revert源码；失败任务保留证据；规则使用既有暂停/停用控制。生产升级只走installer。代码交付不等于发布或现场通过。

Complexity Delta：新业务子系统/后台进程/feature flag/外部网络能力NO；既有任务元数据扩展及Console/core公开操作YES（真实缺失的已批准规则修订边界，不能由现有prompt修订或失败重试安全表达）；不得新增独立审批/修订账本。

---

## 实施补充 v0.2：版本化激活身份与原子替换（2026-11-01 Owner 授权）

本节是上文方案的**实施补充**，不改变已批准的意图、边界与验收口径，因此不需要就同一方案再次审批。

### 问题（真实复现）

隔离实验把原工件（evaluator run_3）修订为 run_4 并正式批准后，数据库出现**两条活动 shadow**：工件不同，`activation_id` 与 `target_ref` 相同。后果是链式的：

1. Console 审阅要求「恰好一条激活」→ 直接报错，Owner 无法审阅新版本；
2. 生产 gate 按 `target_ref` 分组，组内多于一条即记 `duplicate_active_activation` 并跳过整组 → 新规则根本不执行；
3. 新旧版本共用同一条控制状态（`activation_control_states` 主键是 `activation_id`）。

根因是**身份重复**，不是覆盖旧行：`activations` 表的唯一约束只在 `idempotency_key` 上，`activation_id` 非主键、非唯一，所以两个不同工件的行可以并列存在。已被推翻的「`INSERT OR REPLACE` 必然覆盖旧行」解释不再适用。

### A. 版本身份

- `RuleHostWriter` 的激活身份与执行实现身份由**不可变工件**派生：
  `activationId = act_code_${ruleId}_${sha256(artifactId)}`，`targetRef = impl://${ruleId}_${sha256(artifactId)}`。
  这一形式沿用 `PromptWriter` 早已采用的 `act_prompt_${principleId}_sha256(artifactId)` 约定，不新造方案。
- 同一工件重复审批/重试 → 同一身份（幂等）；不同工件 → 身份必不相同，不会因 `target_ref` 相同被合并、覆盖或判为重复目标。
- 身份只来自已有权威工件，不由客户端提供，不依赖时间或随机数；与 pain、candidate、命令全文均无特例绑定。

### B. 控制与历史

- 控制状态以 `activation_id` 为主键，因此新版本天然获得独立控制状态；替换事务在插入新激活行时**同时 seed** 该行（`eligible`, version 1）。缺少它会让 gate 以 `activation_control_state_invalid` 跳过新版本——这与身份重复是同一问题的两面。
- 旧版本的隔离原因、控制版本、影子统计、决策全部留在旧 `activation_id` 上，不迁移、不清洗。
- 替换复用既有 prompt 渠道 R-B3 的原子事务（`replaceActivationAtomically`，新增 `replaceRuleActivation` 入口）：**同一 `BEGIN IMMEDIATE` 内**依次完成「校验 → 插入新激活 → 追加不可变 `supersede` 决策 → 停用旧激活」，任何一步失败整体回滚到「只有旧版本」的状态，不存在先停旧再建新的空窗。
- 幂等由构造保证：重放走 `already_replaced`；`supersede` 决策按 `supersede-${channel}:新id:旧id` 去重。

### 替换目标探测（`detectRuleReplacementTarget`）

批准新工件时，服务端自行解析被替代版本，客户端不可指定：

- 只匹配**同一 evaluator 链**（`sourceTaskId` 相同）且满足既有 `isArtifactRevisionOf` 的新旧工件；
- 只处置 `code_tool_hook_shadow_activate`；目标是 **live** 时拒绝（`rule_replacement_target_is_live`），要求先走正式生命周期降级，绝不把 live 规则悄悄降为 shadow；
- 多于一条候选即拒绝（`ambiguous_rule_replacement`），要求人工停用陈旧版本，不做批量迁移。

### C. 既有约束保持不变

新工件仍独立验证、独立审批，不继承旧批准；恢复组合检查、影子阈值、事实准入、宿主资格与合同版本兼容要求一条未降；已消费的源修订额度不重置；`recoveryControl`、输入合同 v2、旧运行时拒绝不兼容工件的修复、`adversarialFeedback` 清理与 UI 修复均保留。规则代码本身不动。

### 本节验收矩阵

| 验收 | 证据 |
|---|---|
| 真实审批链：新版本唯一审阅、旧历史完整、控制状态不串 | 隔离工作区跑 `ApprovalsConsoleModel.approve` 真实 CAS：2 行激活、0 重复 id、live=1（新）、旧行 `deactivated_at` 非空、控制状态 2 条、`supersede` 决策 1 条；审阅按新 `activation_id` 唯一解析；重放 `already_decided` 且行数不变 |
| 生产 gate 真评估新工件 | 真实 `createProductionRuleHostGate` + 真实 VM 沙箱：`evaluations[].activationId` 为新 id、`hostKind=codex`；`not_approved` 下 `git commit` 记 `block`（shadow 不阻止实际动作）、只读与官方状态 `allow`、`approved` `allow` |
| 旧工件仍被拒 | 生产恢复组合检查对 run_3 仍 `ok:false`（`probe-pd-status`），新工件 `ok:true` |
| 并发与失败 | 两连接同时批准：一次 `activated`、一次 `already_decided`，0 重复；事务中断：失败回滚、旧行仍 live、0 `supersede` 决策、审批回 pending |
| 测试固化 | `activation/__tests__/rule-replacement.test.ts`（原子替换/幂等/回滚/冲突/探测）、`rule-host-writer.test.ts`（身份稳定与跨版本不同）、barrel 快照 |

### 未执行（NOT RUN）

生产发布与安装、native Codex 现场、真实 Owner 审批、shadow 事件随新 digest 增长的真实增长、Console 新审批上线与紧急恢复实操。这些不由本节替代。
