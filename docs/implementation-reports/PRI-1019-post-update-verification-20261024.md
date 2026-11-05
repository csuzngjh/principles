# PRI-1019 更新后复验（2026-10-24）

结论：新原信号RuleCode已真实生成，但质量FAIL，内部Evaluator漏检；未激活。

主安装2.3.11：core1.296.0 / host-runtime0.13.0 / adapter0.5.13。
Codex principles私有安装及源码pins仍1.295.0 / 0.11.0 / 0.5.9；另有adhoc旧目录，官方status报告plugin_data_ambiguous:2。
旧worker从10月22日运行；确认空闲与精确命令后仅重启该用户级进程。官方retry唯一原任务，不重新提交痛苦，不修改安装文件/DB。

Artificer run_artificer-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook_4：2026-10-24T14:12:52.991Z至14:15:55.904Z，succeeded。
新代码SHA256 e41eb3eb7eee24427afb9b1720885a248e5d97ecfedacacba5148f061b27f964。
Evaluator run_evaluator-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook_1：14:16:53.637Z至14:18:02.753Z，approved/adversarialResult.passed=true。

当前安装core对新代码独立回放：18合法输入13通过5失败，7坏输入被validator拒绝。
失败：holdout-different-operation-unapproved（应block却allow）；holdout-unknown、holdout-missing-fact、new-unknown-native-session、new-missing-design-gate-fact（应allow却block）。这些是代码本体回放，不是生产实际工具行为；新gate对unknown另有隔离保护。
旧已合格fixture用新core18通过/7拒绝，用旧插件core接受25输入但出现3失败。

已核实漏检：evaluator-runner.ts:2841要求Owner负例含not_approved/requiresApproval设计事实才能派生命令反例；本次Owner样例含该事实数0，所以必需反例未生成。仅有旧历史样例不能证明所有受管动作或approved/unknown分支正确。

新validated rule：pi-rule-evaluator-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook-run_evaluator-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook_1。
source_principle_id=null；contract为Codex/V2/design_approval。该工件审批0、激活0；全库审批7、激活5未新增。未推进406f分支。

后续最小修复点：插件发布pins/安装链；按必需事实生成确定性语义矩阵（明确是反事实，禁止冒充历史批准），缺必需矩阵不得validated；正式原则身份关联。沿原修订链纠正，不盲目重复生成、不绕过门禁。
