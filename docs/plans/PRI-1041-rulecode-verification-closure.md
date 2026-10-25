# PRI-1041 RuleCode 验证闭环实施计划

> 通过子代理实施，再分别进行规格与质量评审。以 SPEC-RULECODE-VERIFICATION-CLOSURE-002-v0.1 为验收依据。

Goal：让上游原则声明而非模型样例决定必需验证，历史与反事实分离，真实坏代码不能再被误标合格。

Architecture：复用 IntentContract/executionConditions、原Owner证据、已有Runner/Evaluator/修订/装配。可回放性与验证覆盖是派生报告，不是新事实权威。具体事实oracle只沿已存在的DesignGate契约，不给其他原则套其语义。

Tech stack：TypeScript、Vitest、现有SQLite store/真实runner测试。

## 1. 冻结失败证据与独立留出

- [ ] 将真实run4坏代码保存为明确来源的回归fixture，禁止手改代码以制造负控。
- [ ] 冻结跨家族holdout及契约依据，由独立验收代理持有，不进入模型生成/修订输入。
- [ ] 记录原Owner历史样例摘要和字段，后续确认没有改写历史。

## 2. 声明驱动与可回放性

涉及 intent-contract.ts、artificer-prompt-builder.ts、evaluator-prompt-builder.ts、evaluator-runner.ts 及对应测试；只在复杂度确实需要时加一个私有验证模块。

- [ ] 首先复现：Scribe声明design_approval、模型/Owner样例无字段，评审附录与确定性义务不得消失。
- [ ] 对已声明必需事实派生direct/evidence-only/invalid资格；缺失与损坏区分，原输入不变。
- [ ] 原样例既缺决定性事实又要求block的冲突不得继续驱动实现；保留Owner标签的证据地位。
- [ ] 不支持的必需kind明确停点，装配不能静默过滤为仅design_approval。

## 3. 独立系统验证与修订

- [ ] 明确来源的system_counterfactual不冒充Owner历史；合法事实状态成对变换，包含有用的allow与block正控。
- [ ] 当前坏代码、alwaysallow/block、样例文本匹配在模拟模型approved时仍无法validated。
- [ ] 合格正控能到达待审资格，不能以永远blocked声称修复。
- [ ] 事实契约失败进入既有bounded repair；来源/能力故障不不断消耗生成预算。
- [ ] 持久化/装配报告列出required/executed/pass/fail/unavailable与历史缺口；缺必需项不通过。

## 4. 泛化与真实链

- [ ] 通过真实Runner/装配边界验证设计审批、先读后写、明确路径read禁令、无外部事实和未知事实停点。
- [ ] 单独运行独立冻结holdout，不将当前原则的读写豁免升级为通用规则。
- [ ] 原真实材料一致副本，用现有profile预算真实生成/评审/修订；冻结集不送模型。
- [ ] 隔离正式安装/Hook验证，与生产审批、激活分开，原身份链不伪造，24小时观察门不绕过。

## 5. 交付

- [ ] error:context diff复核、相关ERR recurrence、类型/架构/consumer回归及merge gate。
- [ ] 独立规格评审与代码质量评审，修复有效阻断；commit/push/PR/Linear handoff，不自动合并或发布。
- [ ] 报告各层实际证据和未完成事项，不将源码、生成、实装、宿主、审批、效果混为完成。
