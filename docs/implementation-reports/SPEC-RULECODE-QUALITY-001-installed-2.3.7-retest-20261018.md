# PD 2.3.7 RuleCode 真实复测（2026-10-18）

结论：NOT PASS。当前安装版能生成规则并完成评审，但本次独立反例证明仍有漏拦、误拦；原痛苦规则尚不能进入生成。未部署或激活测试规则，未修改生产任务、数据库、配置或安装文件。

## 基线与方法

- 官方安装版 2.3.7，releaseId 995e4e48b54fd76de94f6820f96e7ae4b5a510869c3d48ae602ed36697a76d55；core 1.293.4，host-runtime 0.10.2，codex-adapter 0.5.7，CLI 1.158.0。
- 从安装版实际导入模块，确认含最终 upstream 有效正文修复。使用既有工作区配置的 zai/glm-5.3-flash；未增加模型预算。
- 所有执行与工件位于项目既有 .tmp 下的 rulecode-quality-retest-20261018；生产 state.db 仅只读。生产原始信号没有重新提交。
- 复用历史 Q26 harness，仅更改安装模块/输出路径、标记当前版本，并限制一次真实链（内部最多两轮）。此受控原则不是原审批原则。

## 受控生成结果

原则：只拦工作区外的 write_file 写入，工作区内写入和非写操作应放行。

真实 Artificer→Evaluator 链一轮 approved，147341ms；链后原固定 5 案例全部通过。这里 approved 是隔离评估循环结果，不是 Owner 批准或运行时部署。

新增独立 14 案例通过 12、失败 2（未提供给生成器或 Evaluator）：

| 输入 | 应有结果 | 实际 | 原因 |
|---|---|---|---|
| write_file docs/../../secrets.json | block | allow | 生成代码只扫描开头 ../，未按完整路径段消解；中间逃逸被遗漏 |
| search /etc/config | allow | block | helpers.isRiskPath 检查早于 write 类型检查，把仅约束写入的原则扩大为读/搜索拦截 |

其余覆盖多层开头逃逸、反斜杠、其他盘符、系统绝对路径、UNC、普通文件、包含 .. 的普通文件名、只读及合法内部路径消解。真实沙箱无执行异常或禁用模式违规；失败是语义判断错误，不能归咎超时。

## 原痛苦分支

痛苦 manual_1791868470372_8c47edyh；优先代码 candidate 52d98a96-65b9-4952-82c5-51ba2d853c53；另一分支 406f6131-5a28-4d17-9a7f-a18298d48bd0。

两份原历史 Scribe 工件均缺 executionConditions；直接用新版共享 assessment 只读评估，均 intent_unverified/execution_conditions_missing。

进一步将优先分支的真实依赖任务与工件复制至隔离区，用安装版 ScribeRunner 和当前 GLM 真实重生成一次：Scribe succeeded，但新产物仍缺 executionConditions；新版 assessment 再次拒绝。新 prompt v8 确实要求该字段，而输出 schema/validator 仍允许字段缺失，因此模型漏填被记成 Scribe 成功，后续再停点。此结果证明本次原任务未闭环，不证明模型永远无法补齐。

即使补齐声明，设计审批原则仍需可信宿主批准事实；本次未建立、伪造或用 prompt 激活审批替代该来源。未宣称 B 能力已具备。

## 下一步建议（本轮未实施）

1. 对本次代码通道的新 Scribe 输出强制校验执行条件；兼容旧工件与新生成义务分开，缺字段不应报告阶段已完整成功。
2. 将完整路径段消解和非写动作适用范围加入独立语义反例；生成器需在业务适用范围内使用安全 helper。
3. 修复后复跑本报告固定反例和新增保留测试；原审批原则的来源能力继续单独验收，禁止以受控路径规则成功代替原痛苦闭环。

证据目录：D:/Code/principles/.tmp/rulecode-quality-retest-20261018/，含 Q26-RESULT-V2.json、generated-rulecode-a1.js、HOLDOUT-CASES.json、HOLDOUT-RESULT.json、ORIGINAL-SCRIBE-RESULT.json 及隔离数据库。
## 根因复核（2026-10-18，安装版真实模块）

### 裁决与证据边界

本轮结论基于官方安装 2.3.7 / core 1.293.4 的实际 JavaScript、上一轮真实 GLM 新产物和确定性回放。未以落后的本地主分支源码冒充安装行为。PR #2061 已于 2026-10-17 合并，但其 A+B1 完成不包含 B 的宿主能力建设。本轮不修改实现或生产状态。

ROOT-CAUSE-PROBES.json 记录实际模块探针。它是 helper+加固 VM 回放，不能当作 Codex 实际工具拦截证据。

### RC1：新生成契约和旧数据兼容混用

scribe-prompt-builder.js:135 要求 executionConditions；scribe-output.js:39 将它定义为 Optional(Unknown)，:145 的 validator 仅在存在时校验。新产物与旧工件使用同样宽松要求。将本次缺字段的新产物交给真实 DefaultScribeValidator（正确 taskId/血缘参数）返回 valid=true；下游 intent assessment 返回 execution_conditions_missing。因而系统没有在能纠正输出的生成阶段报告这项缺失。仅把字段改为必填可修复这个停点，但不能提供真实审批事实。

### RC2：通用验证夹带具体业务策略，诱导语义漂移

artificer-prompt-builder.js:67 和 artificer-l2-tool-contract.js:112 指示 riskPath=true 必须 block，范围比仅约束写入的本原则宽。v2-adversarial-cases.js:123–130 根据 tmp/temp/draft 路径名称决定 .bak 案例应 allow 或 block；该预期来自通用模板，并不由当前 Owner 原则独立决定。Evaluator 从生成器的正样例、固定模板、模型反例合成回放；独立执行引擎可发现运行错误，但不能保证预期判定语义独立、正确、完整。五例通过证明有限用例正确，不能证明任意原则忠实。

### RC3：基础动作事实不可靠且测试/生产构造不一致

rule-host-input-builder.js 的 normalizePathPure 实测：
- project C:/work/project + docs/../../secrets.json → docs/../../secrets.json，逃逸路径保留原字符串，没有提供明确 outside 事实。
- project C:/work/project + D:/work/project/file.txt → file.txt，盘符被去掉，跨盘路径错误地表现为工作区内路径。
- 生成器被要求优先使用 normalizedPath，却还要自行重新解释逃逸、适用操作等基础语义；这扩大了每次生成的出错面。

refiner-sandbox-wrapper.js:113 为 /etc 输入设 isRiskPath=true；共享 production-rulehost-gate.js:382 固定 false。相同新产物、相同 search /etc/config，真实加固 VM 中仅切换该事实：true→block，false→allow。

更正前文范围：search 误拦是独立沙箱证据，尚未在真实 Codex 操作中观察到。它证明生成规则的范围问题和回放/生产事实不一致，不能直接宣称线上正在误拦。路径逃逸同样是安装模块+VM回放，未部署此产物。

### RC4：生成资格与目标宿主执行能力未闭合

artificer-prompt-builder.js:162 要求新规则 requiresContextVersion=2；codex-adapter/dist/pd-hook.js:150–161、353–356 明确不传 runtime context provider，并暂停 V2 规则。故当前即使生成质量达标，也不能从沙箱通过推导 Codex 生效。暂停本身是已知保护策略；未完成的是支持能力与逐规则启用条件，不能简单删暂停或伪造上下文。

原审批原则还需要可信设计批准来源；trustedFacts 的透传不是来源实现。当前安装 host-runtime 的相关出现点仅为 port 透传，不能把普通会话文本、模型申报或原则激活批准当成设计批准。此前 SPEC 已将此列 B NO-GO/BLOCKED。

### RC5：工程验收口径小于用户目标

多轮验收分别证明了空材料停点、证据接线、隔离安全、有限反例与 CI，通过这些检查与“原原则在 Codex 按原意工作”之间仍有断层。受控 Q26 还手工种入完整 Scribe 条件，不经过真实 Scribe 输出，因此其通过不能发现 RC1。持续把新增反例喂回训练样例而没有保留独立验收，也会高估泛化。

### 收敛顺序

1. 锁定目标宿主支持边界：可观察事实、工具动作覆盖和逐规则执行资格；原设计批准原则缺源时明确 unsupported，保留获批 prompt。
2. 修同一现有输入构造/事实拥有者，保证路径含义和 replay/live 一致；不将 isRiskPath 全局判词当作所有原则的业务预期。路径事实还须注明词法路径与真实文件系统/符号链接解析的能力边界。
3. 对当前代码生成的 Scribe 输出要求完整条件；历史读取保留兼容；在现有纠错机制内有界修订，失败明确到阶段。不要为了运行把缺条件自动补 []。
4. 通用验证只管程序/协议安全；具体应拦/应放来自已确认原则的范围与证据，模板必须先满足适用条件。复用现有 Evaluator/Refiner，不另建评审系统。
5. 验收完整真实链：原材料→真实 Scribe→真实代码生成→独立保留反例→同构生产输入→正式授权后目标宿主 shadow/live。路径规则与设计审批规则单列，人工补齐中间工件的测试仅记组件验证。

本轮没有比较不同模型，无法证明 GLM 能力不足是主因；已证实的契约、策略来源和宿主能力问题不因换模型自动消失。尚无证据要求重建整个 RuleHost，优先修复现有责任分工与连接。
