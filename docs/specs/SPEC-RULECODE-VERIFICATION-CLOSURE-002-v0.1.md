# SPEC-RULECODE-VERIFICATION-CLOSURE-002 v0.1

日期：2026-10-24。PRI-1041。Owner已授权实施两项修复，并要求深入分析且不能对单一痛苦过拟合；随后明确委托助手自行决定技术细节、补齐验证，使RuleCode正常工作。本文件记录所采用的技术方案；未授权生产批准/激活。

## 原因与目标

原52d Artificer run4坏代码SHA256 e41eb3eb7eee24427afb9b1720885a248e5d97ecfedacacba5148f061b27f964，Evaluator approved且validated；独立18合法案中5失败。原Owner历史例缺designGate，生成指令却同时要求原样block与禁止unknown变否决；评审知识与关键反例又按被检样例字段启用。需修复声明→系统验证义务→实际执行→工件资格的连接，而非重建生成器/评审器或靠换模型。

## 不可变边界

- 原则的Owner意图与适用范围为业务判据；任何外部新增偏好不得倒灌为规则缺陷。
- 不给所有原则套设计审批判词。不规定read/search永远allow或execute永远block。
- Owner历史原文、caseId、标签、字段、摘要不变；不伪造历史审批/任务/SPEC/scope事实。
- 不新增事实平台、调度器、通用插件registry、逐工具LLM调用或提高现有模型预算。只消费已支持事实；未知kind明确停点，装配不得静默丢弃。

## 通用机制

1. 从真实Scribe executionConditions及既有能力声明提取必需义务，非从模型golden字段存在性决定检查是否执行。prompt附录、前置门、Runner、Evaluator、装配consumer使用一致的实际声明。
2. 系统派生历史案例的可回放性：direct_replay（决定性事实齐全有效）、historical_evidence_only（事实缺失，保留标签与缺口）、invalid_input（损坏/矛盾，显式失败）。结果只是既有验证报告的派生记录，不成为新Owner事实权威。
3. 仅对已经有明确运行时事实契约的种类，由系统生成合法的system_counterfactual场景，独立caseId、来源标识及契约依据。引用历史种子不等于声明历史中曾存在事实。只在内存/验证材料中构造，不写回历史和生产声明。
4. 历史覆盖与事实契约覆盖分别计数。required/executed/passed/failed/unavailable与来源均可查；skip不是pass。模型approved不能取消必需义务；不支持的契约不以空矩阵validated。
5. 事实契约反例失败进入既有bounded修订，输入来源/能力缺失进入既有可恢复停点，不循环消耗模型预算。生成/评审指令不能继续要求相互冲突的预期。

## 现有design_approval契约专属实例

复用DesignGateFact：受管动作approved/not_required放行，明确not_approved阻止；unknown/缺失遵守现有宿主隔离及本体语义，不代表批准。撤回、绑定失配、自报批准、同受管事实换命令与不同工具动作都需检查。以上来自该契约，不推广成其他原则默认语义。宿主scope投影正确性与代码本体回放分别验。

## 历史覆盖与待审资格决策

依据Owner本轮明确委托，采用：允许历史样例保留为不可直接回放的证据；只有完整、独立且明确标记的事实契约验证通过，才可将规则送入待审工件。历史缺口仍显示，不能声称历史回放成功，Owner审批/激活/shadow资格不变。

不采用要求所有旧记录必须补出真实历史审批的方案，因为无法重建的事实不能捏造。声明的契约本身不可验证、案例损坏或缺必要事实能力仍须明确停点，不能用反事实掩盖能力缺失。

## 跨家族及未见验收

- 设计审批：同动作批准/否决、非git同范围、unknown、历史缺字段。
- 先读后写：同目标priorRead yes/no、第二目标、历史不可用/截断，依据该夹具原则自己的契约。
- 明确路径禁令：受限路径read拒绝、普通路径read放行、工具别名；不让设计审批的只读豁免污染它。
- 不依赖外部事实的明确动作规则：requiredFacts=[]仍可生成/通过，不被强加designGate。
- 未知required fact/provider不支持：明确材料/能力停点，不伪造支持或validated。

有真实Owner原则用真实来源，无获批原则的家族明确标记验收夹具，仅证明引擎行为。冻结留出案例的输入、预期、契约依据、来源与适用范围；不进入生成/修订提示。反馈过模型即转回归，补新的留出集。

必须通过真实Runner/装配consumer验证：原坏代码、alwaysallow、alwaysblock、只匹配样例三个负控不能validated；合格正控可到达通过，避免只会停住。原始缺字段路径与全字段路径同测，删除模型字段不能关闭必需义务。最终真实模型生成再验，不能以schema成功、模拟LLM输出或单测代替。

## 输入输出、成本与回滚

输入：已验证的上游意图/执行条件、不可变Owner证据、现有host能力与生成工件。输出：来源分明的验证结果/缺口、既有修订或停点、合格工件资格。无新LLM调用步骤；最终按现有profile及预算试跑。

回滚源代码/官方安装，保留历史。新的能力判定不得自动唤醒或激活旧规则；不改24小时shadow/live门槛。Complexity Delta目标：新durable truth/schema/服务/flag/跨包依赖/外部能力均NO，扩充现有验证报告/契约consumer可能YES，须按实际diff解释，不能新造通用事实平台。
