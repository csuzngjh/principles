# Rule Association 005 首轮工程记录

日期：2026-10-30。基线：ac11a2a43ee19a7cc820811f4b58821e6d4a3df9（创建任务工作区时已fetch）。Owner本会话授权开始刚说明的首轮开发；不含自动启用、续接、安装或真实治理决定。

## Owner Review Card

1. 问题：关系字段与可信输入来源未接通，不能仅凭模型引用就建立正式规则身份。
2. Before：诊断输出V1，规则必须Owner绑定；router工件不保留输入来源摘要。
3. After：新增可选择的V2契约、引用校验与离线shadow提议；真实router提交持久系统创建的来源摘要回执。默认生产V1和Owner绑定不变。
4. 复用：现有JSON工件/候选、诊断runner、canonical原则候选resolver回调、SQLite事务与旧schema。
5. Complexity Delta：新schema/内部模块接口YES；新表、后台服务、模型调用、宿主行为和外部网络能力NO。无新生产启用开关。
6. 理由：先证明可验证来源与只读映射，不以自动绑定掩盖缺口。
7. 验证：见后文；测试仅合成数据，不运行真实模型。
8. 风险：canonical可信集合producer仍不存在，输入仅摘要并非完整快照；独立标注质量评估未运行。
9. 恢复：回退本任务源码与构建；新增artifact字段为additive，不删除既有工件或决定。不手改安装目录。
10. 后续：只读基础可审；完整自动关联和整体控制台体验改版均未完成。

## 已实现

- DiagnosticianOutputV2严格契约，rule association与局部recommendationRef；V1入口/默认schemaRef保持不变。
- unknown模型输出/上下文引用校验；canonical UUID复用现有guard；合法引用也明确semanticCorrectness=not_evaluated。
- 只读shadow composition：校验同artifact的rule/目标候选唯一映射及原始recommendation，委托既有原则候选身份解析；authorizesGeneration始终false。
- 实际router调用前捕获message/systemPrompt、前驱内容摘要；成功提交写入系统所有的trustedContextReceipt并双写既有工件。模型同名字段不能覆盖系统值。
- receipt验证task/run/contextHash、消息/系统指令摘要与前驱内容；canonicalPrinciples明确unavailable。
- 隔离SQLite测试验证V2 JSON无损保存、重开读取与幂等重放；未把生产生成切换到V2。

## 未完成或未验证

- 当次真实canonical原则允许集合的系统producer：NOT IMPLEMENTED。不能从模型输出或当前Ledger倒推；直接canonical shadow路径保持不可用。
- 完整输入快照/进程重启后自动重建原始prompt：NOT VERIFIED。当前仅来源摘要证据，runner复验使用序列化重建fixture，不能声称磁盘进程重启E2E。
- V2生产prompt/validator路由、全部生产消费者自动解析：未启用；未声称shadow函数已经替代现有身份权威。
- 独立100样本标注、精确率门槛、Owner真实体验、Console UI/E2E：NOT_RUN。当前没有界面改动。
- 自动关联/新suppress/restore动作/自动续接/生产审批激活：未实现、未启用。
- receipt校验前仍按旧顺序保存run输出；失败时可保留模型输出，但不会完成工件提交/任务成功，不声称全流程原子。

## 验证记录

最终本地验证（均退出码0）：

- 六个定向测试文件：119 tests PASS，包含V1 schema、V2引用/shadow、SQLite committer、router、split retry、golden path。
- `npm run typecheck --workspace @principles/core` PASS。
- `npm run build --workspace @principles/core` PASS，dist hygiene PASS。
- `npm run check:docs-structure` PASS；`git diff --check` PASS。
- error context在固定基线运行，命中EP-03/05/09及信任边界等；分别以typed错误、版本作用域、负例与真实runner/SQLite验证响应。无依赖升级/安装改动，相关要求N/A。
- Standards/Spec两轴独立只读评审：发现并修复rule持久行映射、callback候选身份一致性和unresolved原因吞并。均为未交付的本地实现缺口，沿用rc-6校验与负例，无生产逃逸，不另造长期ERR条目。

未跑全仓测试、远端CI、真实模型、浏览器或生产安装验收；不将定向通过扩大为全SPEC完成。

## 当前阻塞与下一设计点

v0.5 §18要求可信输入集合可恢复，但当前router只接收上游模型产物，没有系统原则集合producer。现有安全基础不假造该事实。若要完成canonical自动关联，需明确系统从何时何处读取哪些原则、快照存储/隐私/版本契约与实际模型可见性，再批准对应连接；不能以增加一个数组或现有contextHash代替。
